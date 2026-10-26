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
 *   6. the latest backup matches what status.json recorded for it (SHA-256 and content fingerprint): a record that disagrees blocks everything.
 * The ONLY tables left out of the comparison are operational bookkeeping (AnalysisPackageJob, AnalysisExecutionLock) and the migration history table
 * (_prisma_migrations): they are not research content and never block a deletion.
 *
 * Nothing is deleted unless BOTH the environment variable AUTO_BACKUP_RETENTION=apply AND <backups>/retention-policy.json exist.
 * With AUTO_BACKUP_RETENTION=dry-run the plan is only logged. Any error, mismatch or doubt keeps every existing backup.
 *
 *   node scripts/backup/retention.mjs --db /data/prod.db --dry-run      (default: print the plan)
 *   node scripts/backup/retention.mjs --db /data/prod.db --apply        (requires the policy file)
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RAW_TABLES = ["Project", "Statement", "SortSession", "SortGroup", "SortGroupItem"];
export const RESULT_TABLES = ["AnalysisRun", "AnalysisRunDimension", "AnalysisInterpretation", "AnalysisClusterLabel", "AnalysisPackage"];
export const OPERATIONAL_TABLES = ["AnalysisPackageJob", "AnalysisExecutionLock"];
export const AUTO_BACKUP_DIR = /^\d{8}T\d{6}Z_[a-z0-9-]+$/;
export const POLICY_FILE = "retention-policy.json";
const STALE_TMP_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;

const quote = (n) => '"' + String(n).replace(/"/g, '""') + '"';

function columnsOf(db, table) {
  try {
    return db.prepare(`pragma table_info(${quote(table)})`).all().map((r) => r.name);
  } catch {
    return [];
  }
}

function canon(values) {
  return values
    .map((v) => (v instanceof Uint8Array ? "b:" + Buffer.from(v).toString("hex") : typeof v === "bigint" ? "n:" + v : v === null ? "null" : typeof v + ":" + String(v)))
    .join("\u0001");
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
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
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
      const idIdx = cols.indexOf("id");
      const keptSets = [];
      for (const k of kept) {
        const kc = columnsOf(k, t);
        if (kc.length === 0 || cols.some((c) => !kc.includes(c))) continue;
        const rows = k.prepare(sel).all();
        const m = new Map();
        for (const r of rows) {
          const vals = cols.map((c) => r[c]);
          const key = idIdx >= 0 ? String(vals[idIdx]) : canon(vals);
          const val = canon(vals);
          if (idIdx >= 0) {
            const arr = m.get(key);
            if (arr) arr.push(val);
            else m.set(key, [val]);
          } else {
            m.set(key, [val]);
          }
        }
        keptSets.push(m);
      }
      let rows = 0;
      let uncovered = 0;
      for (const r of cand.prepare(sel).all()) {
        rows++;
        const vals = cols.map((c) => r[c]);
        const key = idIdx >= 0 ? String(vals[idIdx]) : canon(vals);
        const val = canon(vals);
        if (!keptSets.some((m) => (m.get(key) ?? []).includes(val))) uncovered++;
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
    const p = JSON.parse(fs.readFileSync(path.join(root, POLICY_FILE), "utf8"));
    if (p && p.version === 1 && typeof p.rawBaseline === "string" && p.rawBaseline && (p.protect === undefined || Array.isArray(p.protect))) {
      return { ok: true, policy: { rawBaseline: p.rawBaseline, protect: (p.protect ?? []).map(String) } };
    }
    return { ok: false, reason: "POLICY_INVALID" };
  } catch (e) {
    return { ok: false, reason: e && e.code === "ENOENT" ? "NO_POLICY_FILE" : "POLICY_UNREADABLE" };
  }
}

function dbFileOf(dir, manifest) {
  return path.join(dir, manifest.file);
}

/**
 * Builds the retention plan (read-only). `verify` is verifyBackupDir from auto-backup.mjs (injected: avoids a circular import).
 * @returns {{ enabled: boolean, reason?: string, latest?: object, baseline?: object, candidates: object[] }}
 */
export function planRetention({ root, latestDir, liveDbPath, verify, latestRecord }) {
  const plan = { enabled: false, candidates: [] };
  const pol = readPolicy(root);
  if (!pol.ok) return { ...plan, reason: pol.reason };
  const { rawBaseline, protect } = pol.policy;
  if (!latestDir) return { ...plan, reason: "NO_LATEST_BACKUP" };

  const latestPath = path.join(root, latestDir);
  const latestCheck = verify(latestPath);
  plan.latest = { dir: latestDir, ok: latestCheck.ok, problems: latestCheck.problems };
  if (!latestCheck.ok || !latestCheck.manifest) return { ...plan, reason: "LATEST_NOT_VERIFIED" };
  // the verification record (status.json) must name exactly this backup and agree with its manifest, or nothing is deleted
  if (latestRecord && (latestRecord.dir !== latestDir || latestRecord.sha256 !== latestCheck.manifest.sha256 || latestRecord.fingerprint !== latestCheck.manifest.contentFingerprint)) {
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

function makeWritable(dir) {
  for (const f of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(f.parentPath ?? f.path, f.name);
    try {
      if (f.isSymbolicLink()) continue; // never follow links
      fs.chmodSync(full, f.isDirectory() ? 0o755 : 0o666);
    } catch {
      // ignore: removal will report the failure
    }
  }
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    // ignore
  }
}

/** Executes the plan. Deletes only entries marked "delete", re-checking every guard immediately before each removal. */
export function applyRetention({ root, plan, dryRun, onDelete }) {
  const result = { dryRun: !!dryRun, deleted: [], kept: [], errors: [] };
  if (!plan.enabled) return result;
  const pol = readPolicy(root);
  const protect = pol.ok ? pol.policy.protect : [];
  for (const c of plan.candidates) {
    if (c.decision !== "delete") {
      result.kept.push({ dir: c.dir, reason: c.reason });
      continue;
    }
    const dir = path.join(root, c.dir);
    try {
      if (!AUTO_BACKUP_DIR.test(c.dir) || c.dir === plan.latest.dir || c.dir === plan.baseline.dir || protect.includes(c.dir)) throw new Error("guard: protected name");
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
      // Step 2: remove the renamed directory (files are read-only by design; lift that on THIS tree only, never following links).
      try {
        makeWritable(trash);
        fs.rmSync(trash, { recursive: true, force: false });
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
        makeWritable(p);
        fs.rmSync(p, { recursive: true, force: false });
        removed.push(n);
      } else if (n.startsWith(".tmp-")) {
        if (fs.lstatSync(p).isSymbolicLink() || !fs.lstatSync(p).isDirectory()) continue;
        if (now.getTime() - fs.statSync(p).mtimeMs > STALE_TMP_MS) {
          makeWritable(p);
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

/** Exclusive lock so two runs (daemon tick, pre-deploy guard, manual) never create/prune at the same time. Returns a release function or null. */
export function acquireLock(root, now = new Date()) {
  const file = path.join(root, ".backup.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now.toISOString() }));
      fs.closeSync(fd);
      return () => {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // ignore
        }
      };
    } catch (e) {
      if (!e || e.code !== "EEXIST") return null;
      try {
        const age = now.getTime() - fs.statSync(file).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
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
  const status = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
  const plan = planRetention({ root, latestDir: status.lastBackupDir, liveDbPath: dbPath, verify: (d) => verifyBackupDir(d) });
  const apply = args.includes("--apply");
  if (apply && !plan.enabled) {
    console.error("[retention] not enabled:", plan.reason);
    process.exit(1);
  }
  const res = applyRetention({ root, plan, dryRun: !apply });
  console.log(JSON.stringify({ enabled: plan.enabled, reason: plan.reason, latest: plan.latest?.dir, baseline: plan.baseline?.dir, candidates: plan.candidates.map((c) => ({ dir: c.dir, decision: c.decision, reason: c.reason })), result: res }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error("[retention] failed:", e);
    process.exit(1);
  });
}
