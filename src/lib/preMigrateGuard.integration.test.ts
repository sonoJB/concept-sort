import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { runGuard } from "../../scripts/backup/pre-migrate-guard.mjs";
// @ts-expect-error plain-JS Node script
import { runOnce } from "../../scripts/backup/auto-backup.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-guard-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma", "migrations");
const REAL_MIGRATIONS = fs.readdirSync(MIGRATIONS_DIR).filter((n) => fs.existsSync(path.join(MIGRATIONS_DIR, n, "migration.sql"))).sort();

function makeVolume(name: string, opts: { db?: "ok" | "none" | "corrupt" | "empty-file"; migrations?: string[]; projects?: number; skipMigrationTable?: boolean; unfinished?: string } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "prod.db");
  const kind = opts.db ?? "ok";
  if (kind === "corrupt") fs.writeFileSync(file, "garbage, not sqlite");
  else if (kind === "empty-file") fs.writeFileSync(file, "");
  else if (kind === "ok") {
    const db = new DatabaseSync(file);
    db.exec("create table Project (id text primary key, slug text); create table SortSession (id text primary key, phoneNumber text);");
    if (!opts.skipMigrationTable) {
      db.exec("create table _prisma_migrations (id text, checksum text, finished_at integer, migration_name text, logs text, rolled_back_at integer, started_at integer, applied_steps_count integer);");
      (opts.migrations ?? REAL_MIGRATIONS).forEach((m, i) => db.exec(`insert into _prisma_migrations values ('${i}','x',1,'${m}',null,null,${i + 1},1)`));
      if (opts.unfinished) db.exec(`insert into _prisma_migrations values ('u','x',null,'${opts.unfinished}',null,null,99,0)`);
    }
    for (let i = 0; i < (opts.projects ?? 1); i++) db.exec(`insert into Project values ('p${i}','slug${i}')`);
    db.exec("insert into SortSession values ('s1','0123')");
    db.close();
  }
  return { dir, file, url: `file:${file}` };
}
const guard = (v: { url: string }, env: Record<string, string> = {}) =>
  runGuard({ databaseUrl: v.url, env, migrationsDir: MIGRATIONS_DIR, now: new Date("2026-10-16T12:00:00Z") });
const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
/** Makes backups impossible: a plain file where the backups directory should be. */
const breakBackups = (v: { dir: string }) => fs.writeFileSync(path.join(v.dir, "backups"), "not a directory");

describe("pre-migration guard — policy split", () => {
  it("pending migration + working backup -> proceeds only after a verified pre-migration backup exists", () => {
    const v = makeVolume("pending-ok", { migrations: REAL_MIGRATIONS.slice(0, -1) });
    const before = hash(v.file);
    const d = guard(v);
    expect(d.proceed).toBe(true);
    expect(d.mode).toBe("STRICT_BACKUP_VERIFIED");
    expect(d.reasons.join(" ")).toContain(REAL_MIGRATIONS.at(-1)!);
    const dirs = fs.readdirSync(path.join(v.dir, "backups")).filter((n) => /pre-migration$/.test(n));
    expect(dirs).toHaveLength(1);
    expect(hash(v.file)).toBe(before); // the guard never modifies the live database
  });

  it("pending migration + backup impossible -> BLOCKED (migrations must not run)", () => {
    const v = makeVolume("pending-fail", { migrations: REAL_MIGRATIONS.slice(0, -1) });
    breakBackups(v);
    const d = guard(v);
    expect(d.proceed).toBe(false);
    expect(d.mode).toBe("STRICT_BACKUP_FAILED");
    expect(d.reasons.join(" ")).toMatch(/NOT run/);
  });

  it("no pending migration + backup impossible -> the healthy service still starts (routine failure only logged)", () => {
    const v = makeVolume("uptodate-fail");
    breakBackups(v);
    const d = guard(v);
    expect(d.proceed).toBe(true);
    expect(d.mode).toBe("BEST_EFFORT_BACKUP_FAILED");
  });

  it("no pending migration + working backup -> best-effort backup is made", () => {
    const v = makeVolume("uptodate-ok");
    const d = guard(v);
    expect(d).toMatchObject({ proceed: true, mode: "BEST_EFFORT_OK" });
    expect(fs.readdirSync(path.join(v.dir, "backups")).some((n) => /pre-deploy$/.test(n))).toBe(true);
  });

  it("an identical, still-verified previous backup satisfies the strict requirement", () => {
    const v = makeVolume("pending-reuse", { migrations: REAL_MIGRATIONS.slice(0, -1) });
    expect(runOnce({ reason: "scheduled", databaseUrl: v.url, now: new Date("2026-10-16T01:00:00Z") }).result).toBe("OK");
    const d = guard(v);
    expect(d.mode).toBe("STRICT_BACKUP_VERIFIED");
    expect(d.reasons.join(" ")).toMatch(/verified backup:/);
  });

  it("a damaged previous backup is not trusted for the strict path (a new one is made)", () => {
    const v = makeVolume("pending-damaged-prev", { migrations: REAL_MIGRATIONS.slice(0, -1) });
    const first = runOnce({ reason: "scheduled", databaseUrl: v.url, now: new Date("2026-10-16T01:00:00Z") });
    const f = path.join(v.dir, "backups", first.dir, first.manifest.file);
    fs.chmodSync(f, 0o666);
    fs.appendFileSync(f, "x");
    const d = guard(v);
    expect(d.proceed).toBe(true);
    expect(fs.readdirSync(path.join(v.dir, "backups")).filter((n) => /^\d/.test(n))).toHaveLength(2);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("failed/unfinished migration record or missing migration table on a database with data -> strict", () => {
    expect(guard(makeVolume("unfinished", { unfinished: "20990101_broken" })).mode).toBe("STRICT_BACKUP_VERIFIED");
    expect(guard(makeVolume("no-migration-table", { skipMigrationTable: true })).mode).toBe("STRICT_BACKUP_VERIFIED");
    const v = makeVolume("unfinished-fail", { unfinished: "20990101_broken" });
    breakBackups(v);
    expect(guard(v).proceed).toBe(false);
  });
});

describe("pre-migration guard — missing / abnormal database vs. fresh install", () => {
  it("fresh installation (no DB, no backup history) is allowed", () => {
    const v = makeVolume("fresh", { db: "none" });
    expect(guard(v)).toMatchObject({ proceed: true, mode: "FIRST_INSTALL" });
  });

  it("DB missing while backups exist is NOT treated as a fresh install", () => {
    const v = makeVolume("missing-with-history");
    runOnce({ reason: "manual", databaseUrl: v.url });
    fs.rmSync(v.file);
    const d = guard(v);
    expect(d.proceed).toBe(false);
    expect(d.mode).toBe("DB_MISSING_BUT_BACKUPS_EXIST");
    expect(fs.existsSync(v.file)).toBe(false); // nothing was created
    expect(guard(v, { ALLOW_NEW_DATABASE: "1" }).proceed).toBe(true); // deliberate override only
  });

  it("empty DB file while backups exist is blocked; without history it is a fresh install", () => {
    const withHistory = makeVolume("empty-history");
    runOnce({ reason: "manual", databaseUrl: withHistory.url });
    fs.writeFileSync(withHistory.file, "");
    expect(guard(withHistory).mode).toBe("DB_EMPTY_BUT_BACKUPS_EXIST");
    expect(guard(makeVolume("empty-nohistory", { db: "empty-file" })).mode).toBe("EMPTY_DATABASE_FILE");
  });

  it("a replaced database that lost all projects is blocked when the latest backup had them", () => {
    const v = makeVolume("lost-data");
    runOnce({ reason: "manual", databaseUrl: v.url });
    const db = new DatabaseSync(v.file);
    db.exec("delete from Project");
    db.close();
    expect(guard(v).mode).toBe("DB_LOST_ITS_DATA");
  });

  it("unreadable/corrupt DB file is blocked", () => {
    expect(guard(makeVolume("corrupt", { db: "corrupt" })).mode).toBe("DB_UNREADABLE");
  });

  it("DB path outside the persistent volume is blocked (data would be lost on redeploy)", () => {
    const v = makeVolume("outside");
    expect(guard(v, { RAILWAY_VOLUME_MOUNT_PATH: path.join(root, "some-other-mount") }).mode).toBe("DB_OUTSIDE_VOLUME");
    expect(guard(v, { RAILWAY_VOLUME_MOUNT_PATH: v.dir }).proceed).toBe(true);
  });

  it("non-file DATABASE_URL is outside this guard's scope", () => {
    expect(runGuard({ databaseUrl: "postgres://x", env: {} })).toMatchObject({ proceed: true, mode: "NOT_A_FILE_DATABASE" });
  });
});

describe("pre-migration guard — process exit code (what `&& prisma migrate deploy` sees)", () => {
  const script = path.resolve(process.cwd(), "scripts/backup/pre-migrate-guard.mjs");
  const run = (v: { url: string }) =>
    spawnSync(process.execPath, ["--no-warnings", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: v.url, RAILWAY_VOLUME_MOUNT_PATH: "" },
      encoding: "utf8",
    });

  it("exits 1 when migrations are pending and no verified backup can be made; exits 0 otherwise", () => {
    const blocked = makeVolume("exit-blocked", { migrations: REAL_MIGRATIONS.slice(0, -1) });
    breakBackups(blocked);
    const r1 = run(blocked);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("BLOCKED");

    const ok = makeVolume("exit-ok", { migrations: REAL_MIGRATIONS.slice(0, -1) });
    expect(run(ok).status).toBe(0);

    const routine = makeVolume("exit-routine");
    breakBackups(routine);
    expect(run(routine).status).toBe(0);
  });
});
