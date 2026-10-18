#!/usr/bin/env node
/**
 * Non-destructive SQLite backups for the concept-sort production database.
 * Plain Node (node:sqlite only) — no npm dependencies, not part of the Next.js
 * bundle.
 *
 *   node scripts/backup/auto-backup.mjs --once --reason manual      (always creates a new backup)
 *   node scripts/backup/auto-backup.mjs --daemon                    (scheduled watcher, started by instrumentation)
 *
 * The strict "may we run database migrations?" decision lives in
 * pre-migrate-guard.mjs, which reuses the functions exported here.
 *
 * Guarantees:
 *   - The live DB is opened READ-ONLY. A consistent copy is made with
 *     `VACUUM INTO` (one read transaction), never by copying live files.
 *   - Each backup goes into its own new directory; an existing backup is NEVER
 *     overwritten, modified or deleted by this code. There is no retention or
 *     clean-up logic: removing backups is a deliberate human decision. Damaged
 *     copies are reported, not deleted.
 *   - Every backup is integrity-checked, row-counted, fingerprinted and
 *     SHA-256'd; the result is stored beside it and in status.json.
 *   - A scheduled/pre-deploy run may skip creating a backup because "data is
 *     unchanged" ONLY after re-verifying that the previous backup still exists
 *     and is intact (manifest present, SHA-256 matches, integrity_check ok,
 *     same migration history). Otherwise a new backup is created.
 *   - File permissions (0444 / read-only attribute) only discourage accidental
 *     edits. They are NOT immutable storage: the owner of the volume can still
 *     change or delete the files.
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_FREE_BYTES = 100 * 1024 * 1024; // below this a backup is refused
export const LOW_DISK_WARN_BYTES = 200 * 1024 * 1024; // below this the admin screen warns
const DAEMON_FIRST_RUN_MS = Number(process.env.AUTO_BACKUP_FIRST_RUN_MS) || 2 * 60 * 1000;
const DAEMON_INTERVAL_MS = Number(process.env.AUTO_BACKUP_INTERVAL_MS) || 6 * 60 * 60 * 1000;

const log = (level, msg, extra) =>
  console[level === "error" ? "error" : "log"](`[backup] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);

export function resolveDbPath(databaseUrl) {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) return null;
  let p = databaseUrl.slice("file:".length).split("?")[0];
  if (p.startsWith("//")) p = p.slice(2);
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), "prisma", p);
}

export function backupRootFor(dbPath) {
  return path.join(path.dirname(dbPath), "backups");
}

function sqlQuote(p) {
  return "'" + p.replace(/'/g, "''") + "'";
}

/** Order-independent fingerprint of the entire DB content (all tables except SQLite internals). */
export function contentFingerprint(db) {
  const tables = db
    .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
    .all()
    .map((r) => r.name);
  const h = crypto.createHash("sha256");
  const counts = {};
  for (const t of tables) {
    const rows = db.prepare(`select * from "${t}"`).all().map((r) => JSON.stringify(r)).sort();
    counts[t] = rows.length;
    h.update(t + "\n" + rows.join("\n") + "\n");
  }
  return { fingerprint: h.digest("hex"), counts };
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Directory next to the database that holds the content-addressed analysis package ZIPs (see src/lib/analysis/packageStore.ts). */
export function packagesDirFor(dbPath) {
  return path.join(path.dirname(dbPath), "analysis-packages");
}

const PACKAGE_FILE = /^[0-9a-f]{64}\.zip$/;

/**
 * Keeps every analysis package ZIP together with the database backup it belongs to. Package files are write-once and
 * named by their own SHA-256, so a hard link (same volume, no extra space) is safe; a later removal of the live file
 * (e.g. when a superseded result is replaced) leaves the backup's link intact. Falls back to a verified copy.
 * Returns the list recorded in the manifest.
 */
export function captureAnalysisPackages(dbPath, finalDir) {
  const src = packagesDirFor(dbPath);
  if (!fs.existsSync(src)) return [];
  const out = [];
  const dst = path.join(finalDir, "analysis-packages");
  for (const name of fs.readdirSync(src).sort()) {
    if (!PACKAGE_FILE.test(name)) continue;
    const from = path.join(src, name);
    const sha = sha256File(from);
    if (sha + ".zip" !== name) {
      throw new Error(`analysis package ${name} does not match its own SHA-256 — refusing to back it up silently`);
    }
    fs.mkdirSync(dst, { recursive: true });
    const to = path.join(dst, name);
    try {
      fs.linkSync(from, to);
    } catch {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
    if (sha256File(to) !== sha) throw new Error(`copy of analysis package ${name} failed verification`);
    out.push({ file: name, bytes: fs.statSync(to).size, sha256: sha });
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function stamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Names of migrations recorded as successfully applied in a DB (null if the table is unreadable/missing). */
export function appliedMigrationNames(db) {
  try {
    return db
      .prepare("select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by migration_name")
      .all()
      .map((r) => r.migration_name);
  } catch {
    return null;
  }
}

/**
 * Re-verifies an existing backup directory without modifying it.
 * @returns {{ ok: boolean, problems: string[], manifest: object|null }}
 */
export function verifyBackupDir(dir, { expectedMigrations } = {}) {
  const problems = [];
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(dir)) return { ok: false, problems: ["backup directory is missing"], manifest: null };
  const manifest = readJson(manifestPath);
  if (!manifest) return { ok: false, problems: ["manifest.json is missing or unreadable"], manifest: null };
  const dbFile = path.join(dir, manifest.file ?? "");
  if (!manifest.file || !fs.existsSync(dbFile)) return { ok: false, problems: ["backup database file is missing"], manifest };
  try {
    if (sha256File(dbFile) !== manifest.sha256) problems.push("SHA-256 does not match the recorded value");
  } catch (e) {
    problems.push("cannot read backup file: " + e.message);
  }
  for (const pk of manifest.analysisPackages ?? []) {
    const f = path.join(dir, "analysis-packages", pk.file);
    try {
      if (!fs.existsSync(f)) problems.push(`analysis package ${pk.file} is missing from the backup`);
      else if (sha256File(f) !== pk.sha256) problems.push(`analysis package ${pk.file} does not match its recorded SHA-256`);
    } catch (e) {
      problems.push(`cannot read analysis package ${pk.file}: ` + e.message);
    }
  }
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
      if (integrity !== "ok") problems.push("integrity_check: " + integrity);
      if (expectedMigrations) {
        const names = appliedMigrationNames(db);
        if (names === null) problems.push("migration history is unreadable in the backup");
        else if (JSON.stringify(names) !== JSON.stringify([...expectedMigrations].sort())) {
          problems.push("migration history differs from the live database");
        }
      }
    } finally {
      db.close();
    }
  } catch (e) {
    problems.push("cannot open backup as SQLite: " + e.message);
  }
  return { ok: problems.length === 0, problems, manifest };
}

function readStatus(statusFile) {
  return readJson(statusFile) ?? { consecutiveFailures: 0 };
}

function freeBytesOf(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Creates one new verified backup of the live database.
 * Never skips and never deletes. Returns { result: "OK"|"FAILED", ... }.
 */
export function createBackup({ reason, databaseUrl = process.env.DATABASE_URL, now = new Date() }) {
  const dbPath = resolveDbPath(databaseUrl);
  if (!dbPath || !fs.existsSync(dbPath)) return { result: "FAILED", error: "database file not found: " + (dbPath ?? "(no file: URL)") };
  const root = backupRootFor(dbPath);
  const tmpDir = path.join(root, `.tmp-${stamp(now)}-${process.pid}`);
  try {
    fs.mkdirSync(root, { recursive: true });
    const free = freeBytesOf(root);
    if (free !== null && free < MIN_FREE_BYTES) {
      throw new Error(`low disk space (${Math.round(free / 1048576)} MB free) — refusing to write; nothing was deleted`);
    }

    fs.mkdirSync(tmpDir);
    const tmpDb = path.join(tmpDir, "snapshot.db");
    const src = new DatabaseSync(dbPath, { readOnly: true });
    let liveMigrations;
    try {
      liveMigrations = appliedMigrationNames(src);
      src.exec(`VACUUM INTO ${sqlQuote(tmpDb)}`);
    } finally {
      src.close();
    }

    const snap = new DatabaseSync(tmpDb, { readOnly: true });
    let integrity, fp, lastMigration;
    try {
      integrity = snap.prepare("PRAGMA integrity_check").get().integrity_check;
      fp = contentFingerprint(snap);
      try {
        lastMigration = snap.prepare("select migration_name from _prisma_migrations order by started_at desc limit 1").get()?.migration_name ?? null;
      } catch {
        lastMigration = null; // a database without migration history can (and must) still be backed up
      }
    } finally {
      snap.close();
    }
    if (integrity !== "ok") throw new Error(`integrity_check failed on the new backup: ${integrity}`);

    const finalName = `${stamp(now)}_${reason}`;
    const finalDir = path.join(root, finalName);
    fs.mkdirSync(finalDir); // throws if it already exists: never overwrite
    const fileName = `concept-sort_${stamp(now)}.db`;
    const finalDb = path.join(finalDir, fileName);
    fs.renameSync(tmpDb, finalDb);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const analysisPackages = captureAnalysisPackages(dbPath, finalDir);
    const manifest = {
      createdAtUtc: now.toISOString(),
      reason,
      file: fileName,
      bytes: fs.statSync(finalDb).size,
      sha256: sha256File(finalDb),
      integrityCheck: integrity,
      tableCounts: fp.counts,
      contentFingerprint: fp.fingerprint,
      lastMigration,
      appliedMigrations: liveMigrations,
      sourceDb: path.basename(dbPath),
      analysisPackages,
    };
    fs.writeFileSync(path.join(finalDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.chmodSync(finalDb, 0o444);
    fs.chmodSync(path.join(finalDir, "manifest.json"), 0o444);

    // The backup must verify as a whole (file + manifest + migration history) before it counts as a success.
    const check = verifyBackupDir(finalDir, { expectedMigrations: liveMigrations ?? undefined });
    if (!check.ok) throw new Error("new backup failed verification: " + check.problems.join("; "));

    return { result: "OK", dir: finalName, dirPath: finalDir, manifest };
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return { result: "FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One scheduled / best-effort check. May skip creating a backup, but only
 * after re-verifying the previous backup. Never throws, never blocks start-up.
 * Always records the check itself (so "checks stopped" is distinguishable from
 * "data did not change").
 */
export function runOnce({ reason, databaseUrl = process.env.DATABASE_URL, now = new Date() }) {
  const dbPath = resolveDbPath(databaseUrl);
  if (!dbPath || !fs.existsSync(dbPath)) {
    log("log", "skipped: no file-based database found", { reason });
    return { result: "SKIPPED_NO_DB" };
  }
  const root = backupRootFor(dbPath);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    log("error", "BACKUP FAILED (cannot create backup directory)", { error: String(e) });
    return { result: "FAILED", error: String(e) };
  }
  const statusFile = path.join(root, "status.json");
  const logFile = path.join(root, "backup-log.jsonl");
  const prev = readStatus(statusFile);
  const free = freeBytesOf(root);
  const base = {
    lastCheckAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    freeBytes: free,
    lowDisk: free !== null && free < LOW_DISK_WARN_BYTES,
  };
  const record = (entry) => {
    try {
      fs.appendFileSync(logFile, JSON.stringify({ at: now.toISOString(), reason, ...entry }) + "\n");
    } catch {
      // logging must never break the check
    }
  };
  const save = (obj) => {
    try {
      writeJsonAtomic(statusFile, obj);
    } catch {
      // status file unwritable: the console line is all we have.
    }
  };

  let invalidPrev = null;
  try {
    // Decide whether the data changed since the last backup (read-only look at the live DB).
    const live = new DatabaseSync(dbPath, { readOnly: true });
    let liveFp, liveMigrations;
    try {
      liveFp = contentFingerprint(live);
      liveMigrations = appliedMigrationNames(live);
    } finally {
      live.close();
    }

    if (reason !== "manual" && prev.lastBackupFingerprint === liveFp.fingerprint && prev.lastBackupDir) {
      const prevDir = path.join(root, prev.lastBackupDir);
      const check = verifyBackupDir(prevDir, { expectedMigrations: liveMigrations ?? undefined });
      const sameRecord = check.manifest && check.manifest.sha256 === prev.lastBackupSha256 && check.manifest.contentFingerprint === liveFp.fingerprint;
      if (check.ok && sameRecord) {
        save({
          ...prev,
          ...base,
          lastResult: "SKIPPED_UNCHANGED",
          lastCheckResult: "UNCHANGED_PREVIOUS_BACKUP_VERIFIED",
          lastError: null,
          lastVerifiedAt: now.toISOString(),
          lastVerifiedBackup: prev.lastBackupDir,
          lastVerifiedOk: true,
          lastVerifiedProblems: [],
          consecutiveFailures: 0,
        });
        record({ result: "SKIPPED_UNCHANGED", verified: prev.lastBackupDir });
        log("log", "skipped: data unchanged and previous backup re-verified", { reason, dir: prev.lastBackupDir });
        return { result: "SKIPPED_UNCHANGED", lastBackup: prev.lastBackupDir };
      }
      // Previous backup is missing / damaged / does not match: do NOT skip, and do NOT touch the old copy.
      const problems = check.ok ? ["status record does not match the backup's manifest"] : check.problems;
      log("error", "previous backup could not be verified — creating a new backup", { dir: prev.lastBackupDir, problems });
      record({ result: "PREVIOUS_BACKUP_INVALID", dir: prev.lastBackupDir, problems });
      invalidPrev = { dir: prev.lastBackupDir, problems };
    }

    const created = createBackup({ reason, databaseUrl, now });
    if (created.result !== "OK") throw new Error(created.error);
    const m = created.manifest;
    save({
      ...base,
      lastResult: "OK",
      lastCheckResult: invalidPrev ? "NEW_BACKUP_CREATED_PREVIOUS_INVALID" : "NEW_BACKUP_CREATED",
      lastError: null,
      lastSuccessAt: now.toISOString(),
      lastBackupAt: now.toISOString(),
      lastBackupDir: created.dir,
      lastBackupFingerprint: m.contentFingerprint,
      lastBackupSha256: m.sha256,
      lastVerifiedAt: now.toISOString(),
      lastVerifiedBackup: created.dir,
      lastVerifiedOk: true,
      lastVerifiedProblems: [],
      previousBackupProblem: invalidPrev,
      consecutiveFailures: 0,
      daemonStartedAt: prev.daemonStartedAt,
      lastDaemonTickAt: prev.lastDaemonTickAt,
    });
    record({ result: "OK", dir: created.dir, bytes: m.bytes, sha256: m.sha256 });
    log("log", "backup created", { dir: created.dir, bytes: m.bytes });
    return { result: "OK", dir: created.dir, manifest: m };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    save({
      ...prev,
      ...base,
      lastResult: "FAILED",
      lastCheckResult: "FAILED",
      lastError: message,
      consecutiveFailures: (prev.consecutiveFailures ?? 0) + 1,
    });
    record({ result: "FAILED", error: message });
    log("error", "BACKUP FAILED", { reason, error: message });
    return { result: "FAILED", error: message };
  }
}

/** Marks that the scheduler is alive (separate from whether a backup was needed). */
function markDaemonTick(databaseUrl, started) {
  const dbPath = resolveDbPath(databaseUrl);
  if (!dbPath) return;
  const statusFile = path.join(backupRootFor(dbPath), "status.json");
  try {
    const prev = readStatus(statusFile);
    writeJsonAtomic(statusFile, {
      ...prev,
      daemonStartedAt: started ? new Date().toISOString() : prev.daemonStartedAt,
      lastDaemonTickAt: new Date().toISOString(),
    });
  } catch {
    // ignore
  }
}

function main() {
  const args = process.argv.slice(2);
  const reasonIdx = args.indexOf("--reason");
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : args.includes("--daemon") ? "scheduled" : "manual";
  if (!/^[a-z0-9-]+$/.test(reason)) {
    console.error("[backup] invalid --reason");
    process.exit(2);
  }
  if (args.includes("--daemon")) {
    log("log", "scheduler started", { firstRunInMs: DAEMON_FIRST_RUN_MS, everyMs: DAEMON_INTERVAL_MS });
    markDaemonTick(process.env.DATABASE_URL, true);
    setTimeout(function tick() {
      try {
        runOnce({ reason: "scheduled" });
      } catch (err) {
        log("error", "scheduler tick crashed", { error: String(err) });
      }
      markDaemonTick(process.env.DATABASE_URL, false);
      setTimeout(tick, DAEMON_INTERVAL_MS);
    }, DAEMON_FIRST_RUN_MS);
    return;
  }
  // reason "manual" always creates a backup; --strict turns a failure into a non-zero exit code.
  const out = runOnce({ reason });
  if (args.includes("--strict") && out.result === "FAILED") process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
