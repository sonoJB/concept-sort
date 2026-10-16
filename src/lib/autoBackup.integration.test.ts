import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node script (no type declarations)
import { runOnce, createBackup, resolveDbPath, contentFingerprint, verifyBackupDir, appliedMigrationNames } from "../../scripts/backup/auto-backup.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-autobackup-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

export function makeDb(dir: string, rows = true, migrations = ["20260101_init"]) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "prod.db");
  const db = new DatabaseSync(file);
  db.exec(`create table _prisma_migrations (id text, checksum text, finished_at integer, migration_name text, logs text, rolled_back_at integer, started_at integer, applied_steps_count integer);
           create table Project (id text primary key, slug text);
           create table SortSession (id text primary key, participantName text, phoneNumber text);`);
  migrations.forEach((m, i) => db.exec(`insert into _prisma_migrations values ('${i}','x',1,'${m}',null,null,${i + 1},1)`));
  if (rows) db.exec(`insert into Project values ('p','slug'); insert into SortSession values ('a','0123','0123'),('b','１２３４','1234');`);
  db.close();
  return file;
}
const statusOf = (file: string) => JSON.parse(fs.readFileSync(path.join(path.dirname(file), "backups", "status.json"), "utf8"));
const dirsOf = (file: string) => fs.readdirSync(path.join(path.dirname(file), "backups")).filter((n) => /^\d/.test(n)).sort();
const t = (iso: string) => new Date(iso);

describe("auto-backup.mjs", () => {
  it("resolves file: URLs and rejects non-file URLs", () => {
    expect(resolveDbPath("file:/data/prod.db")).toBe("/data/prod.db");
    expect(resolveDbPath("postgres://x")).toBeNull();
    expect(resolveDbPath(undefined)).toBeNull();
  });

  it("creates a verified, read-only backup and never touches the source", () => {
    const file = makeDb(path.join(root, "t1"));
    const before = fs.readFileSync(file);
    const r = runOnce({ reason: "pre-deploy", databaseUrl: `file:${file}`, now: t("2026-10-16T12:00:00Z") });
    expect(r.result).toBe("OK");
    const dir = path.join(path.dirname(file), "backups", "20261016T120000Z_pre-deploy");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.integrityCheck).toBe("ok");
    expect(manifest.tableCounts.SortSession).toBe(2);
    expect(manifest.appliedMigrations).toEqual(["20260101_init"]);
    expect(Buffer.compare(before, fs.readFileSync(file))).toBe(0);

    const copy = new DatabaseSync(path.join(dir, manifest.file), { readOnly: true });
    expect(copy.prepare("select participantName from SortSession order by id").all()).toEqual([{ participantName: "0123" }, { participantName: "１２３４" }]);
    expect(contentFingerprint(copy).fingerprint).toBe(manifest.contentFingerprint);
    copy.close();
    expect(() => fs.writeFileSync(path.join(dir, manifest.file), "x")).toThrow(); // read-only attribute (NOT immutable storage)
  });

  it("every check is recorded (lastCheckAt) even when no new backup is needed", () => {
    const file = makeDb(path.join(root, "t-check"));
    const url = `file:${file}`;
    runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T01:00:00Z") });
    const second = runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T07:00:00Z") });
    expect(second.result).toBe("SKIPPED_UNCHANGED");
    const s = statusOf(file);
    expect(s.lastCheckAt).toBe("2026-10-16T07:00:00.000Z");
    expect(s.lastBackupAt).toBe("2026-10-16T01:00:00.000Z"); // creation time stays old: data did not change
    expect(s.lastVerifiedOk).toBe(true);
    expect(s.lastVerifiedBackup).toBe(dirsOf(file)[0]);
    expect(typeof s.freeBytes).toBe("number");
    expect(s.lowDisk).toBe(false);
    expect(dirsOf(file)).toHaveLength(1);
  });

  it("creates a new backup after the data changed, and refuses to overwrite a same-second collision", () => {
    const file = makeDb(path.join(root, "t2"));
    const url = `file:${file}`;
    expect(runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T01:00:00Z") }).result).toBe("OK");
    const db = new DatabaseSync(file);
    db.exec("insert into SortSession values ('c','9999','9999')");
    db.close();
    expect(runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T13:00:00Z") }).result).toBe("OK");
    expect(runOnce({ reason: "manual", databaseUrl: url, now: t("2026-10-16T13:00:00Z") }).result).toBe("OK");
    expect(runOnce({ reason: "manual", databaseUrl: url, now: t("2026-10-16T13:00:00Z") }).result).toBe("FAILED");
    expect(dirsOf(file)).toHaveLength(3);
  });

  describe("re-verification before skipping as 'unchanged'", () => {
    function setup(name: string) {
      const file = makeDb(path.join(root, name));
      const url = `file:${file}`;
      const first = runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T01:00:00Z") });
      expect(first.result).toBe("OK");
      return { file, url, dir: path.join(path.dirname(file), "backups", first.dir), first };
    }

    it("previous backup file deleted -> new backup is created (status file alone is not trusted)", () => {
      const { file, url, dir } = setup("rv-deleted");
      fs.rmSync(dir, { recursive: true, force: true });
      const r = runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T07:00:00Z") });
      expect(r.result).toBe("OK");
      expect(statusOf(file).lastCheckResult).toBe("NEW_BACKUP_CREATED_PREVIOUS_INVALID");
      expect(statusOf(file).previousBackupProblem.problems.join(" ")).toMatch(/missing/);
      expect(dirsOf(file)).toHaveLength(1); // only the new one exists now
    });

    it("previous backup corrupted -> new backup is created and the damaged copy is NOT deleted", () => {
      const { file, url, dir, first } = setup("rv-corrupt");
      const db = path.join(dir, first.manifest.file);
      fs.chmodSync(db, 0o666);
      const bytes = fs.readFileSync(db);
      bytes[bytes.length - 10] ^= 0xff;
      fs.writeFileSync(db, bytes);
      const r = runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T07:00:00Z") });
      expect(r.result).toBe("OK");
      const s = statusOf(file);
      expect(s.previousBackupProblem.problems.join(" ")).toMatch(/SHA-256/);
      expect(dirsOf(file)).toHaveLength(2);
      expect(fs.existsSync(db)).toBe(true); // damaged copy kept for a human to inspect
    });

    it("previous manifest missing -> new backup", () => {
      const { file, url, dir } = setup("rv-manifest");
      fs.chmodSync(path.join(dir, "manifest.json"), 0o666);
      fs.rmSync(path.join(dir, "manifest.json"));
      expect(runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T07:00:00Z") }).result).toBe("OK");
      expect(statusOf(file).previousBackupProblem.problems.join(" ")).toMatch(/manifest/);
    });

    it("status record that disagrees with the manifest -> new backup", () => {
      const { file, url } = setup("rv-status");
      const sf = path.join(path.dirname(file), "backups", "status.json");
      const s = JSON.parse(fs.readFileSync(sf, "utf8"));
      s.lastBackupSha256 = "0".repeat(64);
      fs.writeFileSync(sf, JSON.stringify(s));
      expect(runOnce({ reason: "scheduled", databaseUrl: url, now: t("2026-10-16T07:00:00Z") }).result).toBe("OK");
    });

    it("migration history mismatch is detected by verifyBackupDir", () => {
      const { dir } = setup("rv-migrations");
      expect(verifyBackupDir(dir, { expectedMigrations: ["20260101_init"] }).ok).toBe(true);
      const bad = verifyBackupDir(dir, { expectedMigrations: ["20260101_init", "20260202_new"] });
      expect(bad.ok).toBe(false);
      expect(bad.problems.join(" ")).toMatch(/migration history differs/);
    });
  });

  it("records failures in status.json without throwing and without deleting anything", () => {
    const dir = path.join(root, "t3");
    fs.mkdirSync(dir, { recursive: true });
    const bad = path.join(dir, "prod.db");
    fs.writeFileSync(bad, "this is not a sqlite database");
    const r = runOnce({ reason: "pre-deploy", databaseUrl: `file:${bad}`, now: t("2026-10-16T12:00:00Z") });
    expect(r.result).toBe("FAILED");
    const status = statusOf(bad);
    expect(status.lastResult).toBe("FAILED");
    expect(status.consecutiveFailures).toBe(1);
    expect(runOnce({ reason: "pre-deploy", databaseUrl: `file:${bad}`, now: t("2026-10-16T13:00:00Z") }).result).toBe("FAILED");
    expect(statusOf(bad).consecutiveFailures).toBe(2);
    expect(fs.readFileSync(bad, "utf8")).toBe("this is not a sqlite database");
  });

  it("createBackup reports a missing database as a failure (not as 'no database, fine')", () => {
    expect(createBackup({ reason: "x", databaseUrl: "file:/definitely/not/here/prod.db" }).result).toBe("FAILED");
  });

  it("runOnce is a no-op when there is no file database URL", () => {
    expect(runOnce({ reason: "pre-deploy", databaseUrl: "file:/definitely/not/here/prod.db" }).result).toBe("SKIPPED_NO_DB");
  });

  it("appliedMigrationNames ignores unfinished and rolled-back rows", () => {
    const file = makeDb(path.join(root, "t-mig"), false, ["a", "b"]);
    const w = new DatabaseSync(file);
    w.exec("update _prisma_migrations set finished_at = null where migration_name='b'");
    w.close();
    const r = new DatabaseSync(file, { readOnly: true });
    expect(appliedMigrationNames(r)).toEqual(["a"]);
    r.close();
  });
});
