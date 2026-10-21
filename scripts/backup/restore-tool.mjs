#!/usr/bin/env node
/**
 * Guarded database replacement for recovery work (runs inside the service
 * container, or on any machine). Never deletes anything: every file it moves
 * is kept in a timestamped directory next to the database.
 *
 *   node scripts/backup/restore-tool.mjs inspect  --candidate <file.db>
 *   node scripts/backup/restore-tool.mjs replace  --candidate <file.db>
 *   node scripts/backup/restore-tool.mjs rollback --replaced <dir>
 *   node scripts/backup/restore-tool.mjs restore-packages --from <backup dir> [--dry-run]
 *   node scripts/backup/restore-tool.mjs check-packages
 *
 * The database path comes from DATABASE_URL (file:...) or --db.
 *
 * `replace` refuses to run unless the write-freeze flag file MAINTENANCE exists
 * next to the database (participant submissions are then rejected with 503).
 * It then (1) takes a verified, consistent backup of the CURRENT database,
 * (2) moves the current database AND its journal/WAL/SHM files into
 * replaced_<time>/ (a stale hot journal applied to a different database file
 * would corrupt it), (3) installs the candidate via copy + checksum + atomic
 * rename, (4) verifies the result. Any failure in (2)-(4) puts everything back.
 *
 * IMPORTANT: a running server keeps the OLD file open. After `replace` the
 * service MUST be restarted so it opens the new file; until then it still reads
 * (and could write) the old, replaced one. That is why the write-freeze comes first.
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appliedMigrationNames, backupRootFor, checkLivePackageFiles, contentFingerprint, createBackup, packagesDirFor, resolveDbPath, sha256File } from "./auto-backup.mjs";

const SIDECARS = ["-journal", "-wal", "-shm"];
const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function maintenanceFlag(dbPath) {
  return path.join(path.dirname(dbPath), "MAINTENANCE");
}

/** Read-only checks of a candidate database. Prints/returns counts only — never personal data. */
export function inspectCandidate({ dbPath, candidate, migrationsDir = path.resolve(process.cwd(), "prisma", "migrations") }) {
  const problems = [];
  const notes = [];
  const info = { candidate: { path: candidate } };
  if (!fs.existsSync(candidate)) return { ok: false, problems: ["candidate file not found"], notes, info };
  if (path.resolve(candidate) === path.resolve(dbPath)) return { ok: false, problems: ["the candidate must be a different file than the live database"], notes, info };

  let cdb;
  try {
    cdb = new DatabaseSync(candidate, { readOnly: true });
  } catch (e) {
    return { ok: false, problems: ["candidate is not a SQLite database: " + e.message], notes, info };
  }
  try {
    const integrity = cdb.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrity !== "ok") problems.push("candidate integrity_check: " + integrity);
    const fk = cdb.prepare("PRAGMA foreign_key_check").all();
    if (fk.length) problems.push(`candidate has ${fk.length} foreign key violation(s)`);
    const fp = contentFingerprint(cdb);
    info.candidate.counts = fp.counts;
    info.candidate.fingerprint = fp.fingerprint;
    info.candidate.sha256 = sha256File(candidate);
    const applied = appliedMigrationNames(cdb);
    info.candidate.migrations = applied;
    if (applied === null) problems.push("candidate has no readable migration history");
    else {
      let repo = [];
      try {
        repo = fs.readdirSync(migrationsDir).filter((n) => fs.existsSync(path.join(migrationsDir, n, "migration.sql"))).sort();
      } catch {
        notes.push("could not read the application's migrations directory; schema compatibility not checked");
      }
      const unknown = applied.filter((n) => repo.length && !repo.includes(n));
      if (unknown.length) problems.push("candidate has migrations this application version does not know: " + unknown.join(", "));
      const pending = repo.filter((n) => !applied.includes(n));
      if (pending.length) notes.push(`candidate is older than the code: ${pending.length} migration(s) will be applied at the next start (a verified backup is made first)`);
    }
  } catch (e) {
    problems.push("candidate could not be checked: " + e.message);
  } finally {
    cdb.close();
  }

  if (fs.existsSync(dbPath)) {
    let live;
    try {
      live = new DatabaseSync(dbPath, { readOnly: true });
      info.live = { counts: contentFingerprint(live).counts, journalMode: live.prepare("PRAGMA journal_mode").get().journal_mode };
    } catch (e) {
      notes.push("live database could not be read (" + e.message + ") — a damaged live database is exactly when a replacement is needed");
    } finally {
      live?.close(); // always release the handle, also after a failed read (e.g. a hot journal)
    }
    info.live = { ...(info.live ?? {}), sidecarFiles: SIDECARS.filter((s) => fs.existsSync(dbPath + s)) };
  } else {
    notes.push("no live database file exists");
  }
  info.maintenanceFlag = fs.existsSync(maintenanceFlag(dbPath));
  return { ok: problems.length === 0, problems, notes, info };
}

function moveIfExists(from, to) {
  if (fs.existsSync(from)) fs.renameSync(from, to);
}

/** Puts the files moved to `replacedDir` back where they came from (used for rollback and for automatic recovery). */
function restoreFrom(replacedDir, dbPath) {
  const base = path.basename(dbPath);
  if (fs.existsSync(dbPath)) {
    throw new Error("a database file is present at the live path; move it away before restoring " + replacedDir);
  }
  for (const suffix of ["", ...SIDECARS]) moveIfExists(path.join(replacedDir, base + suffix), dbPath + suffix);
}

export function replaceDatabase({ dbPath, candidate, now = new Date(), migrationsDir, _failBeforeMove, _failAfterMove }) {
  if (!fs.existsSync(maintenanceFlag(dbPath))) {
    throw new Error(`write-freeze flag missing: create an empty file ${maintenanceFlag(dbPath)} first (participant submissions are then refused), then re-run`);
  }
  const check = inspectCandidate({ dbPath, candidate, migrationsDir });
  if (!check.ok) throw new Error("candidate rejected: " + check.problems.join("; "));

  // (1) consistent, verified copy of what is there now (if it can be read at all)
  let preserved = null;
  if (fs.existsSync(dbPath)) {
    const b = createBackup({ reason: "pre-restore", databaseUrl: "file:" + dbPath, now });
    if (b.result === "OK") preserved = b.dir;
    else console.error("[restore] warning: could not make a consistent backup of the current database (" + b.error + "); the file itself will still be kept in replaced_*/");
  }

  // (2) move the current DB and its sidecar files aside — remembering exactly what was moved
  const replacedDir = path.join(path.dirname(dbPath), `replaced_${stamp(now)}`);
  fs.mkdirSync(replacedDir); // never reuse
  const base = path.basename(dbPath);
  const incoming = dbPath + ".incoming";
  const moved = [];
  let installed = false;
  try {
    if (_failBeforeMove) _failBeforeMove();
    for (const suffix of ["", ...SIDECARS]) {
      if (fs.existsSync(dbPath + suffix)) {
        fs.renameSync(dbPath + suffix, path.join(replacedDir, base + suffix));
        moved.push(suffix);
      }
    }
    if (_failAfterMove) _failAfterMove();

    // (3) install the candidate: copy -> verify checksum -> atomic rename
    fs.copyFileSync(candidate, incoming, fs.constants.COPYFILE_EXCL);
    if (sha256File(incoming) !== check.info.candidate.sha256) throw new Error("copied candidate does not match its checksum");
    fs.renameSync(incoming, dbPath);
    installed = true;

    // (4) verify what is now at the live path
    const nd = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if (nd.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("integrity_check failed after installing the candidate");
      if (contentFingerprint(nd).fingerprint !== check.info.candidate.fingerprint) throw new Error("content fingerprint differs after installing the candidate");
    } finally {
      nd.close();
    }
  } catch (err) {
    // automatic return to the previous state: undo only what this run actually did
    try {
      if (fs.existsSync(incoming)) fs.rmSync(incoming);
      if (installed && fs.existsSync(dbPath)) fs.renameSync(dbPath, path.join(replacedDir, base + ".failed-install"));
      for (const suffix of moved) fs.renameSync(path.join(replacedDir, base + suffix), dbPath + suffix);
    } catch (e2) {
      throw new Error(`replacement failed (${err.message}) AND automatic return failed (${e2.message}); the original files are in ${replacedDir}`);
    }
    if (moved.length === 0) {
      try {
        fs.rmdirSync(replacedDir); // only succeeds if empty: nothing was moved, so no empty leftover directory
      } catch {
        // keep it if anything is inside
      }
    }
    throw new Error(
      moved.length === 0
        ? `replacement failed before anything was moved — the live database was not touched (${err.message}). If the service is running on Windows the open file cannot be renamed; stop the service first.`
        : `replacement failed and the original database was put back: ${err.message}`
    );
  }
  const rec = { at: now.toISOString(), action: "replace", candidateSha256: check.info.candidate.sha256, preservedBackup: preserved, replacedDir: path.basename(replacedDir) };
  try {
    fs.mkdirSync(backupRootFor(dbPath), { recursive: true });
    fs.appendFileSync(path.join(backupRootFor(dbPath), "restore-log.jsonl"), JSON.stringify(rec) + "\n");
  } catch {
    // logging only
  }
  return { ...rec, notes: check.notes, restartRequired: true };
}

export function rollbackDatabase({ dbPath, replacedDir, now = new Date() }) {
  if (!fs.existsSync(maintenanceFlag(dbPath))) throw new Error("write-freeze flag missing: create the MAINTENANCE file first");
  if (!fs.existsSync(path.join(replacedDir, path.basename(dbPath)))) throw new Error("no database file in " + replacedDir);
  const awayDir = path.join(path.dirname(dbPath), `rolled-back_${stamp(now)}`);
  fs.mkdirSync(awayDir);
  const base = path.basename(dbPath);
  for (const suffix of ["", ...SIDECARS]) moveIfExists(dbPath + suffix, path.join(awayDir, base + suffix));
  restoreFrom(replacedDir, dbPath);
  const notes = [];
  if (SIDECARS.some((x) => fs.existsSync(dbPath + x))) {
    // The original had a hot journal/WAL. A read-only open cannot check it; SQLite recovers it itself on the next normal (read-write) open at service start.
    notes.push("restored original has journal/WAL files; integrity could not be checked read-only — SQLite will recover them when the service starts");
  } else {
    const nd = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if (nd.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("integrity_check failed on the restored original — files are in " + awayDir + " and " + replacedDir);
    } finally {
      nd.close();
    }
  }
  return { action: "rollback", restoredFrom: path.basename(replacedDir), setAsideTo: path.basename(awayDir), notes, restartRequired: true };
}

/**
 * Analysis package ZIPs live next to the database (analysis-packages/<sha256>.zip) and are copied into every backup
 * directory that was made after they existed. After a database replacement, copy them back with
 * `restore-packages --from <backup dir>` (write-once: an identical existing file is left alone, a file with the same
 * name but different content aborts), then `check-packages` verifies EVERY AnalysisPackage row against the files on
 * disk and lists rows whose file is missing — those packages must be regenerated from the stored analysis snapshot
 * (see docs/mds-reanalysis/README.md, "복구").
 */
export function restorePackages({ dbPath, from, dryRun = false }) {
  const srcDir = path.join(from, "analysis-packages");
  const dstDir = packagesDirFor(dbPath);
  const restored = [];
  const identical = [];
  if (fs.existsSync(srcDir)) {
    for (const name of fs.readdirSync(srcDir).sort()) {
      if (!/^[0-9a-f]{64}\.zip$/.test(name)) continue;
      const src = path.join(srcDir, name);
      if (sha256File(src) + ".zip" !== name) throw new Error(`backup file ${name} does not match its own SHA-256`);
      const dst = path.join(dstDir, name);
      if (fs.existsSync(dst)) {
        if (sha256File(dst) !== sha256File(src)) throw new Error(`${name} already exists with different content — refusing to overwrite`);
        identical.push(name);
        continue;
      }
      if (!dryRun) {
        fs.mkdirSync(dstDir, { recursive: true });
        // temp file + rename: an interrupted copy can never leave a partial file under the final (hash) name
        const tmp = path.join(dstDir, `.tmp-${process.pid}-${Date.now()}-${name}`);
        try {
          fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
          if (sha256File(tmp) !== sha256File(src)) throw new Error(`copy of ${name} failed verification`);
          fs.renameSync(tmp, dst);
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          throw e;
        }
      }
      restored.push(name);
    }
  }
  return { from: path.basename(from), dryRun, restored, identical, check: checkPackages({ dbPath }) };
}

/** Verifies every AnalysisPackage row against the file on disk (existence, size, SHA-256). Read-only; same check the scheduled backup runs. */
export function checkPackages({ dbPath }) {
  return checkLivePackageFiles(dbPath);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) o[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  const dbPath = o.db ? path.resolve(o.db) : resolveDbPath(process.env.DATABASE_URL);
  if (!dbPath) {
    console.error("no database path: set DATABASE_URL or pass --db");
    process.exit(2);
  }
  try {
    if (cmd === "inspect") {
      const r = inspectCandidate({ dbPath, candidate: path.resolve(String(o.candidate)) });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === "replace") {
      console.log(JSON.stringify(replaceDatabase({ dbPath, candidate: path.resolve(String(o.candidate)) }), null, 2));
    } else if (cmd === "restore-packages") {
      const r = restorePackages({ dbPath, from: path.resolve(String(o.from)), dryRun: Boolean(o["dry-run"]) });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.check.ok ? 0 : 1);
    } else if (cmd === "check-packages") {
      const r = checkPackages({ dbPath });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === "rollback") {
      console.log(JSON.stringify(rollbackDatabase({ dbPath, replacedDir: path.resolve(String(o.replaced)) }), null, 2));
    } else {
      console.error("usage: restore-tool.mjs inspect|replace|rollback|restore-packages|check-packages ...");
      process.exit(2);
    }
  } catch (e) {
    console.error("[restore] FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
void crypto;
