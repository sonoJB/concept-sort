import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node script (no type declarations)
import { inspectCandidate, replaceDatabase, rollbackDatabase } from "../../scripts/backup/restore-tool.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-restore-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma", "migrations");
const REAL = fs.readdirSync(MIGRATIONS_DIR).filter((n) => fs.existsSync(path.join(MIGRATIONS_DIR, n, "migration.sql"))).sort();
const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function makeDb(file: string, tag: string, migrations = REAL) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`create table _prisma_migrations (id text, checksum text, finished_at integer, migration_name text, logs text, rolled_back_at integer, started_at integer, applied_steps_count integer);
           create table Project (id text primary key, slug text); create table SortSession (id text primary key, participantName text);`);
  migrations.forEach((m, i) => db.exec(`insert into _prisma_migrations values ('${i}','x',1,'${m}',null,null,${i + 1},1)`));
  db.exec(`insert into Project values ('p','${tag}'); insert into SortSession values ('s1','NAME-${tag}'),('s2','NAME2-${tag}')`);
  db.close();
}
const slugOf = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true });
  const r = (d.prepare("select slug from Project").get() as { slug: string }).slug;
  d.close();
  return r;
};
function volume(name: string) {
  const dir = path.join(root, name);
  const live = path.join(dir, "prod.db");
  makeDb(live, "LIVE");
  const cand = path.join(dir, "restore-candidate.db");
  makeDb(cand, "CAND");
  fs.writeFileSync(path.join(dir, "MAINTENANCE"), "");
  return { dir, live, cand };
}
const args = (v: { live: string }) => ({ dbPath: v.live, migrationsDir: MIGRATIONS_DIR, now: new Date("2026-10-16T15:00:00Z") });

describe("restore-tool", () => {
  it("refuses to replace unless the write-freeze flag exists", () => {
    const v = volume("noflag");
    fs.rmSync(path.join(v.dir, "MAINTENANCE"));
    const before = hash(v.live);
    expect(() => replaceDatabase({ ...args(v), candidate: v.cand })).toThrow(/write-freeze flag missing/);
    expect(hash(v.live)).toBe(before);
  });

  it("rejects an unreadable candidate, one with unknown migrations, and the live file itself", () => {
    const v = volume("reject");
    const garbage = path.join(v.dir, "garbage.db");
    fs.writeFileSync(garbage, "not sqlite");
    expect(inspectCandidate({ ...args(v), candidate: garbage }).ok).toBe(false);
    const future = path.join(v.dir, "future.db");
    makeDb(future, "F", [...REAL, "29990101_from_the_future"]);
    expect(inspectCandidate({ ...args(v), candidate: future }).problems.join(" ")).toMatch(/does not know/);
    expect(inspectCandidate({ ...args(v), candidate: v.live }).ok).toBe(false);
    expect(() => replaceDatabase({ ...args(v), candidate: garbage })).toThrow(/rejected/);
    expect(slugOf(v.live)).toBe("LIVE");
  });

  it("inspect prints counts only, never participant data, and notes an older candidate", () => {
    const v = volume("inspect");
    const older = path.join(v.dir, "older.db");
    makeDb(older, "OLD", REAL.slice(0, -1));
    const r = inspectCandidate({ ...args(v), candidate: older });
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toMatch(/older than the code/);
    expect(JSON.stringify(r)).not.toContain("NAME-");
    expect(r.info.live.counts.SortSession).toBe(2);
    expect(r.info.maintenanceFlag).toBe(true);
  });

  it("replaces the database and keeps a verified, consistent backup of the old content", () => {
    const v = volume("replace");
    const liveHash = hash(v.live);
    const out = replaceDatabase({ ...args(v), candidate: v.cand });
    expect(out.restartRequired).toBe(true);

    expect(slugOf(v.live)).toBe("CAND");
    expect(fs.existsSync(v.live + ".incoming")).toBe(false);
    const replaced = path.join(v.dir, out.replacedDir);
    expect(hash(path.join(replaced, "prod.db"))).toBe(liveHash); // the old file, byte for byte
    const pre = path.join(v.dir, "backups", out.preservedBackup);
    const mf = JSON.parse(fs.readFileSync(path.join(pre, "manifest.json"), "utf8"));
    expect(mf.reason).toBe("pre-restore");
    expect(slugOf(path.join(pre, mf.file))).toBe("LIVE");
    expect(hash(v.cand)).toBe(out.candidateSha256); // candidate untouched
    expect(fs.readFileSync(path.join(v.dir, "backups", "restore-log.jsonl"), "utf8")).toContain("replace");
    const nd = new DatabaseSync(v.live, { readOnly: true });
    expect((nd.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    nd.close();
  });

  it("a stale/hot journal (or WAL/SHM) of the old DB is moved aside too, so it can never be applied to the new file", () => {
    const v = volume("sidecars");
    fs.writeFileSync(v.live + "-journal", "stale hot journal bytes");
    fs.writeFileSync(v.live + "-wal", "wal");
    fs.writeFileSync(v.live + "-shm", "shm");
    const liveHash = hash(v.live);
    const out = replaceDatabase({ ...args(v), candidate: v.cand });
    for (const s of ["-journal", "-wal", "-shm"]) expect(fs.existsSync(v.live + s)).toBe(false);
    const replaced = path.join(v.dir, out.replacedDir);
    expect(hash(path.join(replaced, "prod.db"))).toBe(liveHash);
    expect(fs.readFileSync(path.join(replaced, "prod.db-journal"), "utf8")).toBe("stale hot journal bytes");
    expect(fs.existsSync(path.join(replaced, "prod.db-wal"))).toBe(true);
    // a hot journal prevents a consistent read-only backup of the old DB: the files are kept in replaced_*/ instead
    expect(out.preservedBackup).toBeNull();
    expect(slugOf(v.live)).toBe("CAND"); // the new file opens cleanly: nothing stale was applied to it
    const nd = new DatabaseSync(v.live, { readOnly: true });
    expect((nd.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    nd.close();
  });

  it("any failure after the old DB was moved puts the original back automatically", () => {
    const v = volume("autoback");
    fs.writeFileSync(v.live + "-journal", "J");
    const liveHash = hash(v.live);
    expect(() =>
      replaceDatabase({ ...args(v), candidate: v.cand, _failAfterMove: () => { throw new Error("simulated disk error"); } })
    ).toThrow(/original database was put back/);
    expect(hash(v.live)).toBe(liveHash);
    expect(fs.readFileSync(v.live + "-journal", "utf8")).toBe("J");
  });

  it("a failure before anything was moved leaves the live database exactly where it was (no bogus 'return')", () => {
    const v = volume("nomove");
    fs.writeFileSync(v.live + "-journal", "J");
    const liveHash = hash(v.live);
    expect(() =>
      replaceDatabase({ ...args(v), candidate: v.cand, _failBeforeMove: () => { throw new Error("simulated EBUSY"); } })
    ).toThrow(/before anything was moved/);
    expect(hash(v.live)).toBe(liveHash);
    expect(fs.readFileSync(v.live + "-journal", "utf8")).toBe("J");
    expect(fs.existsSync(v.live + ".incoming")).toBe(false);
    expect(fs.readdirSync(v.dir).filter((n) => n.startsWith("replaced_"))).toEqual([]); // no empty leftover directory
  });

  it("rollback brings the original back (with its sidecar files) and keeps the replacement set aside", () => {
    const v = volume("rollback");
    fs.writeFileSync(v.live + "-journal", "J");
    const liveHash = hash(v.live);
    const out = replaceDatabase({ ...args(v), candidate: v.cand });
    const rb = rollbackDatabase({ dbPath: v.live, replacedDir: path.join(v.dir, out.replacedDir), now: new Date("2026-10-16T16:00:00Z") });
    expect(rb.restartRequired).toBe(true);
    expect(hash(v.live)).toBe(liveHash);
    expect(fs.readFileSync(v.live + "-journal", "utf8")).toBe("J");
    expect(slugOf(path.join(v.dir, rb.setAsideTo, "prod.db"))).toBe("CAND");
  });

  it("CLI: inspect exits 0/1 and replace needs the flag", () => {
    const v = volume("cli");
    const script = path.resolve(process.cwd(), "scripts/backup/restore-tool.mjs");
    const run = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", script, ...a, "--db", v.live], { encoding: "utf8", cwd: process.cwd() });
    expect(run("inspect", "--candidate", v.cand).status).toBe(0);
    expect(run("inspect", "--candidate", path.join(v.dir, "nope.db")).status).toBe(1);
    fs.rmSync(path.join(v.dir, "MAINTENANCE"));
    const r = run("replace", "--candidate", v.cand);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/write-freeze/);
  });
});
