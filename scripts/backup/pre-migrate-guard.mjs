#!/usr/bin/env node
/**
 * Start-up guard that runs BEFORE `prisma migrate deploy` (see package.json
 * "start"). Exit code 0 lets the migration and the server start; a non-zero
 * exit code stops the start-up (the previous healthy deployment keeps serving).
 *
 * Two different policies, on purpose:
 *
 *   STRICT (the database will be changed by migrations, or its migration
 *   state is abnormal): a restorable, verified backup of the current database
 *   must exist (a fresh one is created, or an identical previous one is
 *   re-verified). If that cannot be established the start-up is BLOCKED.
 *
 *   BEST-EFFORT (nothing to migrate): a backup is attempted, but a failure is
 *   only logged and recorded; a healthy service is never stopped just because
 *   a routine backup failed. The same applies to the scheduled 6-hourly check.
 *
 * It also refuses to treat an abnormal "no database" situation as a fresh
 * install: if backups exist but the database file is missing/empty/outside the
 * persistent volume, `prisma migrate deploy` would silently create a new EMPTY
 * database, so the start-up is blocked until a person decides what to do.
 * (Intentional fresh installs: no backups exist yet, or ALLOW_NEW_DATABASE=1.)
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appliedMigrationNames, backupRootFor, resolveDbPath, runOnce } from "./auto-backup.mjs";

const say = (msg) => console.log(`[guard] ${msg}`);

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** True when this volume already has a backup history, i.e. a database must have existed here. */
function hasBackupHistory(root) {
  if (!fs.existsSync(root)) return false;
  try {
    const status = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
    if (status.lastSuccessAt) return true;
  } catch {
    // no/unreadable status file: look at the directories
  }
  try {
    return fs
      .readdirSync(root)
      .some((n) => !n.startsWith(".") && fs.existsSync(path.join(root, n, "manifest.json")));
  } catch {
    return false;
  }
}

function latestManifestCounts(root) {
  try {
    const names = fs.readdirSync(root).filter((n) => !n.startsWith(".") && fs.existsSync(path.join(root, n, "manifest.json"))).sort();
    for (const n of names.reverse()) {
      const m = JSON.parse(fs.readFileSync(path.join(root, n, "manifest.json"), "utf8"));
      if (m.tableCounts) return m.tableCounts;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * @returns {{ proceed: boolean, mode: string, reasons: string[] }}
 */
export function runGuard({
  databaseUrl = process.env.DATABASE_URL,
  env = process.env,
  migrationsDir = path.resolve(process.cwd(), "prisma", "migrations"),
  now = new Date(),
} = {}) {
  const proceed = (mode, reasons = []) => ({ proceed: true, mode, reasons });
  const block = (mode, reasons) => ({ proceed: false, mode, reasons });

  const dbPath = resolveDbPath(databaseUrl);
  if (!dbPath) return proceed("NOT_A_FILE_DATABASE", ["DATABASE_URL is not a file: URL — nothing for this guard to protect"]);

  const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (mount && !isInside(dbPath, mount) && env.ALLOW_DB_OUTSIDE_VOLUME !== "1") {
    return block("DB_OUTSIDE_VOLUME", [
      `DATABASE_URL points to ${dbPath}, which is not inside the persistent volume (${mount}). Data written there would be lost on the next deploy. Fix DATABASE_URL (set ALLOW_DB_OUTSIDE_VOLUME=1 only for a deliberate exception).`,
    ]);
  }

  const root = backupRootFor(dbPath);
  const history = hasBackupHistory(root);
  const allowNew = env.ALLOW_NEW_DATABASE === "1";

  if (!fs.existsSync(dbPath)) {
    if (history && !allowNew) {
      return block("DB_MISSING_BUT_BACKUPS_EXIST", [
        `The database file ${dbPath} is missing, but this volume contains backups. Starting now would create a new EMPTY database. Restore from a backup (see README_복구절차서.md) or, if a fresh database is really intended, set ALLOW_NEW_DATABASE=1 for one start.`,
      ]);
    }
    return proceed("FIRST_INSTALL", ["no database and no backup history: treated as a fresh installation"]);
  }

  // The file exists: it must be a readable SQLite database.
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return block("DB_UNREADABLE", [`Cannot open ${dbPath} as SQLite: ${e.message}`]);
  }
  let applied, unfinished, userTableCount, projectCount;
  try {
    const tables = db.prepare("select name from sqlite_master where type='table' and lower(substr(name, 1, 7)) <> 'sqlite_'").all().map((r) => r.name);
    userTableCount = tables.filter((t) => t !== "_prisma_migrations").length;
    applied = appliedMigrationNames(db);
    unfinished = [];
    if (applied !== null) {
      unfinished = db
        .prepare("select migration_name from _prisma_migrations where finished_at is null and rolled_back_at is null")
        .all()
        .map((r) => r.migration_name);
    }
    projectCount = tables.includes("Project") ? db.prepare("select count(*) c from Project").get().c : 0;
  } catch (e) {
    db.close();
    return block("DB_UNREADABLE", [`The database file is not a healthy SQLite database: ${e.message}`]);
  }
  db.close();

  const size = fs.statSync(dbPath).size;
  if (size === 0 || (userTableCount === 0 && applied === null)) {
    if (history && !allowNew) {
      return block("DB_EMPTY_BUT_BACKUPS_EXIST", [
        `${dbPath} exists but is empty while backups exist on this volume. Refusing to migrate into an empty database; restore from a backup or set ALLOW_NEW_DATABASE=1 deliberately.`,
      ]);
    }
    return proceed("EMPTY_DATABASE_FILE", ["empty database file and no backup history: treated as a fresh installation"]);
  }

  const counts = latestManifestCounts(root);
  if (history && !allowNew && projectCount === 0 && counts && counts.Project > 0) {
    return block("DB_LOST_ITS_DATA", [
      `The database has no Project rows but the latest backup had ${counts.Project}. This looks like a replaced/empty database; refusing to continue. Restore from a backup or set ALLOW_NEW_DATABASE=1 deliberately.`,
    ]);
  }

  // Which migrations would run?
  let repoMigrations = [];
  try {
    repoMigrations = fs
      .readdirSync(migrationsDir)
      .filter((n) => fs.existsSync(path.join(migrationsDir, n, "migration.sql")))
      .sort();
  } catch (e) {
    return block("MIGRATIONS_DIR_UNREADABLE", [`Cannot read ${migrationsDir}: ${e.message}`]);
  }
  const appliedSet = new Set(applied ?? []);
  const pending = repoMigrations.filter((n) => !appliedSet.has(n));
  const strictReasons = [];
  if (applied === null) strictReasons.push("the database has data but no readable migration history");
  if (pending.length) strictReasons.push(`${pending.length} pending migration(s): ${pending.join(", ")}`);
  if (unfinished.length) strictReasons.push(`unfinished/failed migration record(s): ${unfinished.join(", ")}`);

  if (strictReasons.length > 0) {
    say(`STRICT mode — ${strictReasons.join("; ")}`);
    const r = runOnce({ reason: "pre-migration", databaseUrl, now });
    if (r.result === "OK" || r.result === "SKIPPED_UNCHANGED") {
      return proceed("STRICT_BACKUP_VERIFIED", [...strictReasons, `verified backup: ${r.dir ?? r.lastBackup}`]);
    }
    return block("STRICT_BACKUP_FAILED", [
      ...strictReasons,
      `A restorable, verified backup of the current database could not be made (${r.error ?? r.result}). Migrations were NOT run; the previous deployment keeps serving. Fix the cause (disk space? permissions?) and redeploy.`,
    ]);
  }

  // Nothing to migrate: best effort only.
  const r = runOnce({ reason: "pre-deploy", databaseUrl, now });
  if (r.result === "FAILED") {
    say(`WARNING — routine pre-deploy backup failed (${r.error}); continuing because no migration is pending. See the admin screen's backup status.`);
    return proceed("BEST_EFFORT_BACKUP_FAILED", [r.error]);
  }
  return proceed("BEST_EFFORT_" + r.result, []);
}

function main() {
  const d = runGuard();
  (d.proceed ? console.log : console.error)(`[guard] ${d.proceed ? "PROCEED" : "BLOCKED"} (${d.mode})`);
  for (const r of d.reasons) console[d.proceed ? "log" : "error"](`[guard]   ${r}`);
  process.exit(d.proceed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
