#!/usr/bin/env node
/**
 * Automatic, non-destructive SQLite backups for the concept-sort production
 * database. Plain Node (node:sqlite only) — no npm dependencies, not part of
 * the Next.js bundle.
 *
 *   node scripts/backup/auto-backup.mjs --once --reason pre-deploy
 *   node scripts/backup/auto-backup.mjs --daemon           (scheduled; used by instrumentation.ts)
 *   node scripts/backup/auto-backup.mjs --once --reason manual
 *
 * Guarantees:
 *   - The live DB is opened READ-ONLY. A consistent copy is made with
 *     `VACUUM INTO` (a single read transaction), never by copying live files.
 *   - Each backup goes into its own new directory; an existing backup is NEVER
 *     overwritten, modified or deleted. There is no retention/cleanup logic:
 *     removing old backups is a deliberate human decision.
 *   - Every backup is integrity-checked, row-counted, fingerprinted and
 *     SHA-256'd; the result is stored beside it and in status.json.
 *   - Failures never block application start (exit code stays 0 for --once
 *     unless --strict), but they are logged loudly and recorded in
 *     status.json (lastResult=FAILED, consecutiveFailures) so the admin
 *     screen can show them.
 *   - Scheduled runs only create a new backup when the data actually changed
 *     since the last successful backup (content fingerprint), so a finished
 *     study does not accumulate identical copies.
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MIN_FREE_BYTES = 100 * 1024 * 1024;
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

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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

export function runOnce({ reason, databaseUrl = process.env.DATABASE_URL, now = new Date() }) {
  const dbPath = resolveDbPath(databaseUrl);
  if (!dbPath || !fs.existsSync(dbPath)) {
    log("log", "skipped: no file-based database found", { reason });
    return { result: "SKIPPED_NO_DB" };
  }
  const root = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(root, { recursive: true });
  const statusFile = path.join(root, "status.json");
  const logFile = path.join(root, "backup-log.jsonl");
  const prev = readJson(statusFile) ?? { consecutiveFailures: 0 };

  const record = (entry) => {
    fs.appendFileSync(logFile, JSON.stringify({ at: now.toISOString(), reason, ...entry }) + "\n");
  };

  const tmpDir = path.join(root, `.tmp-${stamp(now)}-${process.pid}`);
  try {
    const free = fs.statfsSync(root);
    if (free.bavail * free.bsize < MIN_FREE_BYTES) {
      throw new Error(`low disk space (${Math.round((free.bavail * free.bsize) / 1048576)} MB free) — refusing to write; nothing was deleted`);
    }

    fs.mkdirSync(tmpDir);
    const tmpDb = path.join(tmpDir, "snapshot.db");
    const src = new DatabaseSync(dbPath, { readOnly: true });
    try {
      src.exec(`VACUUM INTO ${sqlQuote(tmpDb)}`);
    } finally {
      src.close();
    }

    const snap = new DatabaseSync(tmpDb, { readOnly: true });
    let integrity, fp, lastMigration;
    try {
      integrity = snap.prepare("PRAGMA integrity_check").get().integrity_check;
      fp = contentFingerprint(snap);
      lastMigration = snap
        .prepare("select migration_name from _prisma_migrations order by started_at desc limit 1")
        .get()?.migration_name ?? null;
    } finally {
      snap.close();
    }
    if (integrity !== "ok") throw new Error(`integrity_check failed on the new backup: ${integrity}`);

    if (reason !== "manual" && prev.lastBackupFingerprint === fp.fingerprint) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const result = { result: "SKIPPED_UNCHANGED", lastBackup: prev.lastBackupDir ?? null };
      writeJsonAtomic(statusFile, {
        ...prev,
        lastAttemptAt: now.toISOString(),
        lastResult: "SKIPPED_UNCHANGED",
        lastError: null,
        consecutiveFailures: 0,
      });
      record(result);
      log("log", "skipped: data unchanged since last backup", { reason });
      return result;
    }

    const finalName = `${stamp(now)}_${reason}`;
    const finalDir = path.join(root, finalName);
    fs.mkdirSync(finalDir); // throws if it already exists: never overwrite
    const fileName = `concept-sort_${stamp(now)}.db`;
    const finalDb = path.join(finalDir, fileName);
    fs.renameSync(tmpDb, finalDb);
    fs.rmSync(tmpDir, { recursive: true, force: true });

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
      sourceDb: path.basename(dbPath),
    };
    fs.writeFileSync(path.join(finalDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.chmodSync(finalDb, 0o444);
    fs.chmodSync(path.join(finalDir, "manifest.json"), 0o444);

    writeJsonAtomic(statusFile, {
      lastAttemptAt: now.toISOString(),
      lastResult: "OK",
      lastError: null,
      lastSuccessAt: now.toISOString(),
      lastBackupDir: finalName,
      lastBackupFingerprint: fp.fingerprint,
      lastBackupSha256: manifest.sha256,
      consecutiveFailures: 0,
    });
    record({ result: "OK", dir: finalName, bytes: manifest.bytes, sha256: manifest.sha256 });
    log("log", "backup created", { dir: finalName, bytes: manifest.bytes });
    return { result: "OK", dir: finalName, manifest };
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      writeJsonAtomic(statusFile, {
        ...prev,
        lastAttemptAt: now.toISOString(),
        lastResult: "FAILED",
        lastError: message,
        consecutiveFailures: (prev.consecutiveFailures ?? 0) + 1,
      });
      record({ result: "FAILED", error: message });
    } catch {
      // status file itself unwritable: the console line below is all we have.
    }
    log("error", "BACKUP FAILED", { reason, error: message });
    return { result: "FAILED", error: message };
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
    setTimeout(function tick() {
      try {
        runOnce({ reason: "scheduled" });
      } catch (err) {
        log("error", "scheduler tick crashed", { error: String(err) });
      }
      setTimeout(tick, DAEMON_INTERVAL_MS);
    }, DAEMON_FIRST_RUN_MS);
    return;
  }
  const out = runOnce({ reason });
  if (args.includes("--strict") && out.result === "FAILED") process.exit(1);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
