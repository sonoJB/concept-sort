#!/usr/bin/env node
/**
 * Latest-set retention for the server-side database backups (plain Node, node:sqlite only).
 *
 * What it protects (never deleted, never modified by this code):
 *   - the live database and its journal/WAL/SHM files (never opened for writing here)
 *   - the registered analysis package ZIPs (a backup only holds hard links; removing a backup directory removes links, not the live files)
 *   - the RAW baseline backup named in retention-policy.json (e.g. the "survey complete" copy that still holds the pre-normalisation values)
 *   - every directory named in "protect" and every directory whose name is not an automatic `YYYYMMDDTHHMMSSZ_reason` backup
 *   - the newest verified backup ("latest set": database + manifest.json + analysis-packages/)
 *
 * What may be deleted: an OLDER automatic backup, and only if ALL of this holds
 *   1. the latest backup verifies (SHA-256, integrity_check, package files) and its RAW tables are still contained in the live database,
 *   2. the RAW baseline named in the policy verifies,
 *   3. the candidate itself verifies (a backup that cannot be verified is an exception, never a candidate),
 *   4. every row of EVERY table of the candidate database — the known RAW tables (Project, Statement, SortSession, SortGroup, SortGroupItem), the known
 *      result tables (AnalysisRun, AnalysisRunDimension, AnalysisInterpretation, AnalysisClusterLabel, AnalysisPackage) AND any table that is not on either
 *      list (a table added later is therefore compared by default) — is held, with an identical value in EVERY column, by the latest backup or the RAW
 *      baseline (a row count is never enough; a changed value, a column or a table the kept copies lack counts as "only in the candidate"),
 *   5. every package file the candidate lists is also listed by the latest backup,
 *   6. the latest backup matches the verification record (status.json on the server; the server's status for a PC copy): a missing record or one
 *      that disagrees blocks everything. EVERY execution path (daemon, CLI, PC --prune) must pass it — the record is a required input.
 * The ONLY tables left out of the comparison are operational bookkeeping (AnalysisPackageJob, AnalysisExecutionLock) and the migration history table
 * (_prisma_migrations): they are not research content and never block a deletion.
 *
 * Immediately before the first removal, inside the caller's lock, the whole plan is rebuilt from scratch (`replan`) and must come out the same
 * (same policy file bytes, same latest/baseline, the candidate still "delete"); otherwise nothing is deleted.
 * Files are never chmod-ed: backup files are hard links of live ZIPs, and a mode change would change the live file too.
 *
 * Nothing is deleted unless BOTH the environment variable AUTO_BACKUP_RETENTION=apply AND <backups>/retention-policy.json exist.
 * With AUTO_BACKUP_RETENTION=dry-run the plan is only logged. Any error, mismatch or doubt keeps every existing backup.
 *
 *   node scripts/backup/retention.mjs --db /data/prod.db --dry-run      (default: print the plan)
 *   node scripts/backup/retention.mjs --db /data/prod.db --apply        (requires the policy file)
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RAW_TABLES = ["Project", "Statement", "SortSession", "SortGroup", "SortGroupItem"];
export const RESULT_TABLES = ["AnalysisRun", "AnalysisRunDimension", "AnalysisInterpretation", "AnalysisClusterLabel", "AnalysisPackage"];
export const OPERATIONAL_TABLES = ["AnalysisPackageJob", "AnalysisExecutionLock"];
export const AUTO_BACKUP_DIR = /^\d{8}T\d{6}Z_[a-z0-9-]+$/;
export const POLICY_FILE = "retention-policy.json";
const STALE_TMP_MS = 60 * 60 * 1000;
const LOCK_FILE = ".backup.lock";

const quote = (n) => '"' + String(n).replace(/"/g, '""') + '"';

function columnsOf(db, table) {
  try {
    return db.prepare(`pragma table_info(${quote(table)})`).all().map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * One value -> one unambiguous token: a type tag, and for strings/blobs the LENGTH before the content, so no value can ever swallow the separator
 * ("a\u0001string" + "c" never equals "a" + "b\u0001string"). Integers and reals stay different (1 vs 1.0), -0 differs from 0.
 */
function enc(v) {
  if (v === null || v === undefined) return "N";
  if (typeof v === "bigint") return "I" + v.toString();
  if (typeof v === "number") return "R" + (Object.is(v, -0) ? "-0" : String(v));
  if (typeof v === "string") return "S" + v.length + ":" + v;
  if (v instanceof Uint8Array) {
    const h = Buffer.from(v).toString("hex");
    return "B" + h.length + ":" + h;
  }
  const t = String(v);
  return "?" + t.length + ":" + t;
}

/** Canonical form of one row (the values in the given column order). */
export function canon(values) {
  return values.map(enc).join("|");
}

function rowsOf(db, sql) {
  const st = db.prepare(sql);
  if (typeof st.setReadBigInts === "function") st.setReadBigInts(true); // integers stay exact and distinguishable from reals
  return st.all();
}

/** Multiset of rows: canonical row -> how many times it occurs. */
function countRows(rows, cols) {
  const m = new Map();
  for (const r of rows) {
    const k = canon(cols.map((c) => r[c]));
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function openRO(file) {
  return new DatabaseSync(file, { readOnly: true });
}

const IGNORED_TABLES = new Set([...OPERATIONAL_TABLES, "_prisma_migrations"]);

/** Every table of the database that must be compared (all except operational bookkeeping, migration history and SQLite internals). */
export function comparableTables(dbPath) {
  const db = openRO(dbPath);
  try {
    return db
      .prepare("select name from sqlite_master where type='table' and lower(substr(name, 1, 7)) <> 'sqlite_' order by name")
      .all()
      .map((r) => r.name)
      .filter((n) => !IGNORED_TABLES.has(n));
  } finally {
    db.close();
  }
}

/**
 * For each table: how many rows of `candidatePath` are NOT held, identical in every candidate column, by at least one of `keptPaths`.
 * A kept database that lacks the table or one of the candidate's columns cannot vouch for those rows (conservative).
 * Returns { ok, tables: { [name]: { rows, uncovered, usableKept } } } — counts only, never values.
 */
export function coverage(candidatePath, keptPaths, tables) {
  const cand = openRO(candidatePath);
  const kept = keptPaths.map((p) => openRO(p));
  const out = {};
  try {
    for (const t of tables) {
      const cols = columnsOf(cand, t);
      if (cols.length === 0) {
        out[t] = { rows: 0, uncovered: 0, usableKept: 0, absent: true };
        continue;
      }
      const sel = `select ${cols.map(quote).join(",")} from ${quote(t)}`;
      const keptSets = [];
      for (const k of kept) {
        const kc = columnsOf(k, t);
        if (kc.length === 0 || cols.some((c) => !kc.includes(c))) continue;
        keptSets.push(countRows(rowsOf(k, sel), cols));
      }
      let rows = 0;
      let uncovered = 0;
      // a row that occurs n times in the candidate must occur at least n times in ONE kept copy (duplicates are data too)
      for (const [key, n] of countRows(rowsOf(cand, sel), cols)) {
        rows += n;
        const best = keptSets.reduce((mx, m) => Math.max(mx, m.get(key) ?? 0), 0);
        if (best < n) uncovered += n - best;
      }
      out[t] = { rows, uncovered, usableKept: keptSets.length };
    }
  } finally {
    cand.close();
    kept.forEach((k) => k.close());
  }
  return { ok: Object.values(out).every((v) => v.uncovered === 0), tables: out };
}

/** Every RAW row of the backup must still exist, identical, in the live database (rows added after the snapshot are fine). */
export function rawContainedInLive(backupDbPath, liveDbPath) {
  return coverage(backupDbPath, [liveDbPath], RAW_TABLES);
}

export function readPolicy(root) {
  try {
    const bytes = fs.readFileSync(path.join(root, POLICY_FILE));
    const p = JSON.parse(bytes.toString("utf8"));
    if (p && p.version === 1 && typeof p.rawBaseline === "string" && p.rawBaseline && (p.protect === undefined || Array.isArray(p.protect))) {
      return { ok: true, policy: { rawBaseline: p.rawBaseline, protect: (p.protect ?? []).map(String) }, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    }
    return { ok: false, reason: "POLICY_INVALID" };
  } catch (e) {
    return { ok: false, reason: e && e.code === "ENOENT" ? "NO_POLICY_FILE" : "POLICY_UNREADABLE" };
  }
}

/** The server's verification record of its latest backup (status.json): name, SHA-256 and content fingerprint. null when unreadable. */
export function readLatestRecord(root) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
    return { dir: st.lastBackupDir, sha256: st.lastBackupSha256, fingerprint: st.lastBackupFingerprint };
  } catch {
    return null;
  }
}

function dbFileOf(dir, manifest) {
  return path.join(dir, manifest.file);
}

/**
 * Builds the retention plan (read-only). `verify` is verifyBackupDir from auto-backup.mjs (injected: avoids a circular import).
 * @returns {{ enabled: boolean, reason?: string, latest?: object, baseline?: object, candidates: object[] }}
 */
export function planRetention({ root, latestDir, liveDbPath, verify, latestRecord, candidateFilter = () => true }) {
  const plan = { enabled: false, candidates: [] };
  const pol = readPolicy(root);
  if (!pol.ok) return { ...plan, reason: pol.reason };
  const { rawBaseline, protect } = pol.policy;
  plan.policy = pol.policy;
  plan.policySha256 = pol.sha256;
  if (!latestDir) return { ...plan, reason: "NO_LATEST_BACKUP" };

  const latestPath = path.join(root, latestDir);
  const latestCheck = verify(latestPath);
  plan.latest = { dir: latestDir, ok: latestCheck.ok, problems: latestCheck.problems };
  if (!latestCheck.ok || !latestCheck.manifest) return { ...plan, reason: "LATEST_NOT_VERIFIED" };
  // the verification record (status.json) must name exactly this backup and agree with its manifest, or nothing is deleted
  if (!latestRecord || !latestRecord.dir || !latestRecord.sha256 || !latestRecord.fingerprint) return { ...plan, reason: "LATEST_RECORD_MISSING" };
  if (latestRecord.dir !== latestDir || latestRecord.sha256 !== latestCheck.manifest.sha256 || latestRecord.fingerprint !== latestCheck.manifest.contentFingerprint) {
    return { ...plan, reason: "LATEST_RECORD_MISMATCH" };
  }
  const baselinePath = path.join(root, rawBaseline);
  const baselineCheck = verify(baselinePath);
  plan.baseline = { dir: rawBaseline, ok: baselineCheck.ok, problems: baselineCheck.problems };
  if (!baselineCheck.ok || !baselineCheck.manifest) return { ...plan, reason: "BASELINE_NOT_VERIFIED" };
  if (rawBaseline === latestDir) return { ...plan, reason: "BASELINE_IS_LATEST" };

  const latestDb = dbFileOf(latestPath, latestCheck.manifest);
  const baselineDb = dbFileOf(baselinePath, baselineCheck.manifest);
  if (liveDbPath) {
    // the live database may legitimately change its derived results later; every other table of the latest backup must still be there unchanged
    const live = coverage(latestDb, [liveDbPath], comparableTables(latestDb).filter((t) => !RESULT_TABLES.includes(t)));
    plan.latestRawInLive = live;
    if (!live.ok) return { ...plan, reason: "LATEST_RAW_NOT_IN_LIVE" };
  }
  const latestHas = comparableTables(latestDb);
  const missingRaw = RAW_TABLES.filter((t) => !latestHas.includes(t));
  if (missingRaw.length) return { ...plan, reason: "LATEST_MISSING_RAW_TABLE", missingTables: missingRaw };
  const latestPkgs = new Set((latestCheck.manifest.analysisPackages ?? []).map((p) => p.sha256));

  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { ...plan, reason: "ROOT_UNREADABLE" };
  }
  for (const name of names) {
    if (!AUTO_BACKUP_DIR.test(name)) continue; // changelog, survey-complete_*, pre-mds-v2_*, .tmp-* … are never candidates
    if (!candidateFilter(name)) continue; // e.g. on the PC only copies this tool created itself
    if (name === latestDir || name === rawBaseline) continue;
    const entry = { dir: name, decision: "keep", reason: "" };
    plan.candidates.push(entry);
    if (protect.includes(name)) {
      entry.reason = "PROTECTED_BY_POLICY";
      continue;
    }
    if (name.slice(0, 16) >= latestDir.slice(0, 16)) {
      entry.reason = "NOT_OLDER_THAN_LATEST";
      continue;
    }
    const dir = path.join(root, name);
    const chk = verify(dir);
    if (!chk.ok || !chk.manifest) {
      entry.reason = "CANDIDATE_NOT_VERIFIED";
      entry.problems = chk.problems;
      continue;
    }
    const missingPkg = (chk.manifest.analysisPackages ?? []).filter((p) => !latestPkgs.has(p.sha256));
    if (missingPkg.length) {
      entry.reason = "HOLDS_PACKAGE_FILES_NOT_IN_LATEST";
      continue;
    }
    let cov;
    let compared;
    try {
      const candDb = dbFileOf(dir, chk.manifest);
      compared = [...new Set([...RAW_TABLES, ...RESULT_TABLES, ...comparableTables(candDb)])];
      cov = coverage(candDb, [latestDb, baselineDb], compared);
    } catch (e) {
      entry.reason = "COMPARISON_FAILED";
      entry.problems = [String(e && e.message ? e.message : e)];
      continue;
    }
    const rawBad = compared.filter((t) => !RESULT_TABLES.includes(t) && cov.tables[t]?.uncovered);
    const resBad = RESULT_TABLES.filter((t) => cov.tables[t]?.uncovered);
    entry.comparedTables = compared;
    entry.coverage = Object.fromEntries(Object.entries(cov.tables).map(([k, v]) => [k, { rows: v.rows, uncovered: v.uncovered }]));
    if (rawBad.length) {
      entry.reason = "RAW_ROWS_ONLY_IN_THIS_BACKUP";
      entry.tables = rawBad;
    } else if (resBad.length) {
      entry.reason = "RESULT_ROWS_ONLY_IN_THIS_BACKUP";
      entry.tables = resBad;
    } else {
      entry.decision = "delete";
      entry.reason = "FULLY_COVERED_BY_LATEST_AND_RAW_BASELINE";
    }
  }
  plan.enabled = true;
  return plan;
}

function within(root, p) {
  const r = fs.realpathSync(root);
  const x = fs.realpathSync(p);
  return x !== r && x.startsWith(r + path.sep) && path.dirname(x) === r;
}

/**
 * Directories only. Files are NEVER chmod-ed: a file inside a backup may be a hard link of a live package ZIP (same inode), so a mode change here
 * would change the live file and the other kept copies too. Unlinking a file needs write permission on its DIRECTORY, not on the file.
 */
function makeDirsWritable(dir) {
  const walk = (d) => {
    let entries = [];
    try {
      fs.chmodSync(d, 0o755);
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name));
  };
  walk(dir);
}

function removeTree(dir) {
  makeDirsWritable(dir);
  fs.rmSync(dir, { recursive: true, force: false });
}

/**
 * Executes the plan. Deletes only entries marked "delete".
 * Before the first removal (inside the caller's lock) `replan()` rebuilds the plan from the current files; the deletion proceeds only if the
 * policy file is byte-identical to the one the plan was made from, latest/baseline are unchanged and the candidate is STILL a deletion candidate.
 * Without `replan` nothing is deleted (dry runs only report).
 * `ownsLock()` must say true right before EVERY removal; a run that lost its lock (taken over, removed, replaced) deletes nothing more.
 */
export function applyRetention({ root, plan, dryRun, onDelete, replan, ownsLock }) {
  const result = { dryRun: !!dryRun, deleted: [], kept: [], errors: [] };
  if (!plan.enabled) return result;
  let protect = plan.policy?.protect ?? [];
  let fresh = null;
  if (!dryRun && plan.candidates.some((c) => c.decision === "delete")) {
    const abort = (error) => {
      result.errors.push({ dir: null, error });
      for (const c of plan.candidates) result.kept.push({ dir: c.dir, reason: c.decision === "delete" ? "REVALIDATION_FAILED_KEPT" : c.reason });
      return result;
    };
    if (typeof replan !== "function") return abort("REVALIDATION_UNAVAILABLE: no way to re-check the plan, nothing deleted");
    if (typeof ownsLock !== "function") return abort("LOCK_CHECK_UNAVAILABLE: cannot confirm that this run still holds the lock, nothing deleted");
    if (!ownsLock()) return abort("LOCK_LOST: this run no longer holds the lock, nothing deleted");
    try {
      fresh = replan();
    } catch (e) {
      return abort("REVALIDATION_FAILED: " + String(e && e.message ? e.message : e));
    }
    if (!fresh || !fresh.enabled) return abort("REVALIDATION_BLOCKED: " + (fresh?.reason ?? "unknown"));
    if (!plan.policySha256 || fresh.policySha256 !== plan.policySha256) return abort("POLICY_CHANGED: the policy file differs from the one the plan was made from");
    if (fresh.latest?.dir !== plan.latest?.dir || fresh.baseline?.dir !== plan.baseline?.dir) return abort("PLAN_CHANGED: latest or baseline differs after re-check");
    protect = fresh.policy.protect;
  } else if (!dryRun) {
    const pol = readPolicy(root);
    protect = pol.ok ? pol.policy.protect : protect;
  }
  for (const c of plan.candidates) {
    if (c.decision !== "delete") {
      result.kept.push({ dir: c.dir, reason: c.reason });
      continue;
    }
    const dir = path.join(root, c.dir);
    try {
      if (!dryRun && !ownsLock()) throw new Error("LOCK_LOST: this run no longer holds the lock, nothing more is deleted");
      if (!AUTO_BACKUP_DIR.test(c.dir) || c.dir === plan.latest.dir || c.dir === plan.baseline.dir || protect.includes(c.dir)) throw new Error("guard: protected name");
      if (fresh) {
        const f = fresh.candidates.find((x) => x.dir === c.dir);
        if (!f || f.decision !== "delete") throw new Error("guard: not a deletion candidate after re-check (" + (f ? f.reason : "unknown") + ")");
      }
      if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory() || !within(root, dir)) {
        throw new Error("guard: path is not a real directory directly inside the backup root");
      }
      if (dryRun) {
        result.deleted.push({ dir: c.dir, dryRun: true });
        continue;
      }
      // Step 1: take the backup out of the list with ONE rename. From here on it is no longer a backup, whatever happens next, so a failure
      // below can never leave a half-deleted directory that still looks like a backup. (A rename failure — e.g. no permission — keeps it intact.)
      const trash = path.join(root, `.deleting-${c.dir}`);
      fs.renameSync(dir, trash);
      result.deleted.push({ dir: c.dir });
      if (onDelete) onDelete(c);
      // Step 2: remove the renamed directory (never following links, never changing file modes).
      try {
        removeTree(trash);
      } catch (e) {
        result.errors.push({ dir: c.dir, error: "removed from the backup list, leftover will be retried: " + String(e && e.message ? e.message : e) });
      }
    } catch (e) {
      result.errors.push({ dir: c.dir, error: String(e && e.message ? e.message : e) });
      result.kept.push({ dir: c.dir, reason: "DELETE_FAILED_KEPT" });
    }
  }
  return result;
}

/** Removes `.tmp-*` working directories left behind by a crashed backup (older than one hour) and finishes interrupted `.deleting-*` removals. Never touches anything else. */
export function removeStaleTemp(root, now = new Date()) {
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const n of names) {
    const p = path.join(root, n);
    try {
      if (n.startsWith(".deleting-")) {
        // already decided and renamed out of the backup list by applyRetention; finish the removal
        if (fs.lstatSync(p).isSymbolicLink() || !fs.lstatSync(p).isDirectory()) continue;
        removeTree(p);
        removed.push(n);
      } else if (n.startsWith(".tmp-")) {
        if (fs.lstatSync(p).isSymbolicLink() || !fs.lstatSync(p).isDirectory()) continue;
        if (now.getTime() - fs.statSync(p).mtimeMs > STALE_TMP_MS) {
          makeDirsWritable(p);
          fs.rmSync(p, { recursive: true, force: true });
          removed.push(n);
        }
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

function readLockInfo(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const bootId = () => {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
};

/** Process start time in clock ticks since boot (Linux), which tells a reused pid from the original process. null when not available. */
const procStart = (pid) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};

const pidExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === "ESRCH"); // EPERM (exists, not ours) and anything unexpected count as "exists"
  }
};

/**
 * Is the lock owner PROVABLY gone? "dead" only when this machine can prove it; anything else is "alive" or "unknown" and the lock is NOT taken over.
 *   unknown: no usable owner record (missing/garbled), or the owner ran on another host/container (its liveness cannot be seen from here)
 *   dead:    same host and (the machine has rebooted since, or the pid does not exist, or the pid now belongs to a different process)
 *   alive:   same host, the pid exists and is the same process
 * Elapsed time never decides anything: a long-running job keeps its lock.
 */
export function lockOwnerState(info) {
  if (!info || !Number.isInteger(info.pid) || info.pid <= 0 || typeof info.host !== "string" || info.host !== os.hostname()) return "unknown";
  const boot = bootId();
  if (info.bootId && boot && info.bootId !== boot) return "dead";
  if (!pidExists(info.pid)) return "dead";
  const start = procStart(info.pid);
  if (info.startTicks && start && info.startTicks !== start) return "dead";
  return "alive";
}

/**
 * Exclusive lock so two runs (daemon tick, pre-deploy guard, manual CLI, PC pull) never create/prune at the same time. Returns a release function or null;
 * `release.owns()` tells whether this run STILL holds the lock (the file still carries its token).
 * The lock file is created complete (written to a private file, then hard-linked into place), carries a random token plus the owner's pid, host, boot id
 * and process start time. Release removes the file ONLY if it still carries OUR token. A lock is taken over ONLY when its owner is provably gone
 * (see lockOwnerState); if that cannot be established the takeover is deferred (the caller is told the lock is busy and the log names the holder).
 * The takeover renames exactly the file that was judged dead, checks what was moved and puts a different (fresher) lock back instead of stealing it.
 */
export function acquireLock(root, now = new Date()) {
  const file = path.join(root, LOCK_FILE);
  const token = crypto.randomUUID();
  const owns = () => readLockInfo(file)?.token === token;
  const release = () => {
    if (owns()) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
    }
  };
  release.owns = owns;
  const mine = JSON.stringify({ pid: process.pid, token, host: os.hostname(), bootId: bootId(), startTicks: procStart(process.pid), at: now.toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    const priv = path.join(root, `${LOCK_FILE}.new-${token}`);
    try {
      fs.writeFileSync(priv, mine, { flag: "wx" });
      try {
        fs.linkSync(priv, file); // atomic, fails with EEXIST if a lock exists: the lock file is never visible without its content
        return release;
      } finally {
        try {
          fs.rmSync(priv, { force: true });
        } catch {
          // ignore
        }
      }
    } catch (e) {
      if (!e || e.code !== "EEXIST") return null;
    }
    const info = readLockInfo(file);
    if (!fs.existsSync(file)) continue; // released between the attempts
    if (lockOwnerState(info) !== "dead") return null; // alive, or not provably gone: hold
    const moved = path.join(root, `${LOCK_FILE}.stale-${token}`);
    try {
      fs.renameSync(file, moved);
    } catch {
      continue; // somebody else took it over first
    }
    const movedInfo = readLockInfo(moved);
    const same = (movedInfo?.token ?? null) === (info?.token ?? null);
    if (!same) {
      // a different lock appeared between our check and the rename: it is not ours to remove — put it back
      try {
        fs.linkSync(moved, file);
      } catch {
        // another lock exists now; the owner of the moved one will see the token mismatch at release and remove nothing
      }
    }
    try {
      fs.rmSync(moved, { force: true });
    } catch {
      // ignore
    }
    if (!same) return null;
  }
  return null;
}

/** Who holds the lock right now (for logs; never includes the token). */
export function lockHolder(root) {
  const info = readLockInfo(path.join(root, LOCK_FILE));
  return info ? { pid: info.pid ?? null, host: info.host ?? null, at: info.at ?? null, owner: lockOwnerState(info) } : null;
}

export function retentionMode(env = process.env) {
  const v = String(env.AUTO_BACKUP_RETENTION ?? "").toLowerCase();
  return v === "apply" ? "apply" : v === "dry-run" ? "dry-run" : "off";
}

// ----------------------------------------------------------------------------- CLI
async function cli() {
  const { verifyBackupDir, resolveDbPath, backupRootFor } = await import("./auto-backup.mjs");
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : resolveDbPath(process.env.DATABASE_URL);
  if (!dbPath) {
    console.error("[retention] need --db <path> or DATABASE_URL=file:...");
    process.exit(2);
  }
  const root = backupRootFor(dbPath);
  const apply = args.includes("--apply");
  // the same lock the daemon uses: never plan or delete while a backup run (or another retention run) is active
  const release = acquireLock(root);
  if (!release) {
    console.error("[retention] another backup/retention run holds the lock; nothing done", JSON.stringify(lockHolder(root)));
    process.exit(1);
  }
  // status.json is read INSIDE the lock, and again by every re-plan, so the record is always current and mandatory
  const makePlan = () => {
    const latestRecord = readLatestRecord(root);
    return planRetention({ root, latestDir: latestRecord?.dir, liveDbPath: dbPath, verify: (d) => verifyBackupDir(d), latestRecord });
  };
  try {
    const plan = makePlan();
    if (apply && !plan.enabled) {
      console.error("[retention] not enabled:", plan.reason);
      process.exitCode = 1;
      return;
    }
    const res = applyRetention({ root, plan, dryRun: !apply, replan: makePlan, ownsLock: release.owns });
    console.log(JSON.stringify({ enabled: plan.enabled, reason: plan.reason, latest: plan.latest?.dir, baseline: plan.baseline?.dir, candidates: plan.candidates.map((c) => ({ dir: c.dir, decision: c.decision, reason: c.reason })), result: res }, null, 2));
    if (res.errors.length) process.exitCode = 1;
  } finally {
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error("[retention] failed:", e);
    process.exit(1);
  });
}
