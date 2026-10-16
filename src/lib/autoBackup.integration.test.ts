import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node script (no type declarations)
import { runOnce, resolveDbPath, contentFingerprint } from "../../scripts/backup/auto-backup.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-autobackup-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function makeDb(dir: string, withRows = true) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "prod.db");
  const db = new DatabaseSync(file);
  db.exec(`create table _prisma_migrations (migration_name text, started_at integer);
           insert into _prisma_migrations values ('20260101_init', 1);
           create table SortSession (id text primary key, participantName text, phoneNumber text);`);
  if (withRows) db.exec(`insert into SortSession values ('a','0123','0123'),('b','１２３４','1234');`);
  db.close();
  return file;
}

describe("auto-backup.mjs", () => {
  it("resolves file: URLs and rejects non-file URLs", () => {
    expect(resolveDbPath("file:/data/prod.db")).toBe("/data/prod.db");
    expect(resolveDbPath("postgres://x")).toBeNull();
    expect(resolveDbPath(undefined)).toBeNull();
  });

  it("creates a verified, read-only, write-once backup and never touches the source", () => {
    const file = makeDb(path.join(root, "t1"));
    const before = fs.readFileSync(file);
    const r = runOnce({ reason: "pre-deploy", databaseUrl: `file:${file}`, now: new Date("2026-10-16T12:00:00Z") });
    expect(r.result).toBe("OK");
    const dir = path.join(path.dirname(file), "backups", "20261016T120000Z_pre-deploy");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.integrityCheck).toBe("ok");
    expect(manifest.tableCounts.SortSession).toBe(2);
    expect(Buffer.compare(before, fs.readFileSync(file))).toBe(0);

    // The copy has identical content, with strings (leading zero, full-width digits) intact.
    const copy = new DatabaseSync(path.join(dir, manifest.file), { readOnly: true });
    expect(copy.prepare("select participantName from SortSession order by id").all()).toEqual([
      { participantName: "0123" },
      { participantName: "１２３４" },
    ]);
    expect(contentFingerprint(copy).fingerprint).toBe(manifest.contentFingerprint);
    copy.close();

    // Backups are read-only files.
    expect(() => fs.writeFileSync(path.join(dir, manifest.file), "x")).toThrow();
  });

  it("skips when nothing changed, backs up again after a change, and never overwrites", () => {
    const file = makeDb(path.join(root, "t2"));
    const url = `file:${file}`;
    expect(runOnce({ reason: "scheduled", databaseUrl: url, now: new Date("2026-10-16T01:00:00Z") }).result).toBe("OK");
    expect(runOnce({ reason: "scheduled", databaseUrl: url, now: new Date("2026-10-16T07:00:00Z") }).result).toBe("SKIPPED_UNCHANGED");

    const db = new DatabaseSync(file);
    db.exec("insert into SortSession values ('c','9999','9999')");
    db.close();
    expect(runOnce({ reason: "scheduled", databaseUrl: url, now: new Date("2026-10-16T13:00:00Z") }).result).toBe("OK");

    // Same-second, same-reason collision is refused instead of overwriting.
    const clash = runOnce({ reason: "manual", databaseUrl: url, now: new Date("2026-10-16T13:00:00Z") });
    const clash2 = runOnce({ reason: "manual", databaseUrl: url, now: new Date("2026-10-16T13:00:00Z") });
    expect(clash.result).toBe("OK");
    expect(clash2.result).toBe("FAILED");
    const dirs = fs.readdirSync(path.join(path.dirname(file), "backups")).filter((n) => /^\d/.test(n));
    expect(dirs).toHaveLength(3);
  });

  it("records failures in status.json without throwing and without deleting anything", () => {
    const dir = path.join(root, "t3");
    fs.mkdirSync(dir, { recursive: true });
    const bad = path.join(dir, "prod.db");
    fs.writeFileSync(bad, "this is not a sqlite database");
    const r = runOnce({ reason: "pre-deploy", databaseUrl: `file:${bad}`, now: new Date("2026-10-16T12:00:00Z") });
    expect(r.result).toBe("FAILED");
    const status = JSON.parse(fs.readFileSync(path.join(dir, "backups", "status.json"), "utf8"));
    expect(status.lastResult).toBe("FAILED");
    expect(status.consecutiveFailures).toBe(1);
    expect(fs.readFileSync(bad, "utf8")).toBe("this is not a sqlite database");
  });

  it("is a no-op when there is no file database", () => {
    expect(runOnce({ reason: "pre-deploy", databaseUrl: "file:/definitely/not/here/prod.db" }).result).toBe("SKIPPED_NO_DB");
  });
});
