import { describe, it, expect, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { runOnce, createBackup, verifyBackupDir } from "../../scripts/backup/auto-backup.mjs";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { coverage, acquireLock, removeStaleTemp, retentionMode, POLICY_FILE } from "../../scripts/backup/retention.mjs";
import { planRetention, applyRetention } from "./backupRetention.testkit";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-retention-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.AUTO_BACKUP_RETENTION;
});

const t = (iso: string) => new Date(iso);
let n = 0;

/** A live database shaped like the real one (RAW tables, result tables, operational table), with a few rows. */
function makeLive() {
  const dir = path.join(root, `case${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "prod.db");
  const db = new DatabaseSync(file);
  db.exec(`
    create table _prisma_migrations (id text, checksum text, finished_at integer, migration_name text, logs text, rolled_back_at integer, started_at integer, applied_steps_count integer);
    insert into _prisma_migrations values ('0','x',1,'20260101_init',null,null,1,1);
    create table Project (id text primary key, slug text, koreanEnabled integer);
    create table Statement (id text primary key, textKo text);
    create table SortSession (id text primary key, participantName text, phoneNumber text, age integer);
    create table SortGroup (id text primary key, sortSessionId text, label text);
    create table SortGroupItem (id text primary key, groupId text, statementId text);
    create table AnalysisRun (id text primary key, scope text, resultBundle text);
    create table AnalysisPackageJob (id text primary key, status text);
    insert into Project values ('p','rrr',1);
    insert into Statement values ('s1','문항 1'),('s2','문항 2');
    insert into SortSession values ('a','홍길동','010-1111-2222',16),('b','김철수','1234',17);
    insert into SortGroup values ('g1','a','묶음'),('g2','b','다른');
    insert into SortGroupItem values ('i1','g1','s1'),('i2','g2','s2');
  `);
  db.close();
  return { dir, file, url: `file:${file}`, backups: path.join(dir, "backups") };
}
const sql = (file: string, q: string) => {
  const db = new DatabaseSync(file);
  db.exec(q);
  db.close();
};
const dirs = (c: { backups: string }) => fs.readdirSync(c.backups).filter((x) => fs.statSync(path.join(c.backups, x)).isDirectory()).sort();
const status = (c: { backups: string }) => JSON.parse(fs.readFileSync(path.join(c.backups, "status.json"), "utf8"));

/** Takes a backup, then renames the directory to a non-automatic name (the "RAW baseline" role). Manifest paths are relative, so it stays valid. */
function makeBaseline(c: ReturnType<typeof makeLive>, name = "survey-complete_20261016T120119Z") {
  const r = createBackup({ reason: "baseline", databaseUrl: c.url, now: t("2026-10-16T12:01:19Z") });
  expect(r.result).toBe("OK");
  fs.renameSync(path.join(c.backups, r.dir), path.join(c.backups, name));
  return name;
}
const writePolicy = (c: { backups: string }, policy: object) => fs.writeFileSync(path.join(c.backups, POLICY_FILE), JSON.stringify({ version: 1, ...policy }));
const verify = (d: string) => verifyBackupDir(d);

describe("coverage(): full-content comparison (never a row count)", () => {
  it("flags a changed value, a missing row and a missing column, and passes identical content", () => {
    const c = makeLive();
    const a = createBackup({ reason: "a", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    const pathA = path.join(c.backups, a.dir, a.manifest.file);
    expect(coverage(pathA, [pathA], ["SortSession", "SortGroupItem", "Project"]).ok).toBe(true);

    // one response value changed (same id, same row count)
    const changed = path.join(c.dir, "changed.db");
    fs.copyFileSync(pathA, changed);
    fs.chmodSync(changed, 0o666);
    sql(changed, "update SortSession set age = 99 where id = 'a'");
    const r1 = coverage(changed, [pathA], ["SortSession"]);
    expect(r1.ok).toBe(false);
    expect(r1.tables.SortSession).toMatchObject({ rows: 2, uncovered: 1 });

    // kept copy lacks one row
    const fewer = path.join(c.dir, "fewer.db");
    fs.copyFileSync(pathA, fewer);
    fs.chmodSync(fewer, 0o666);
    sql(fewer, "delete from SortGroupItem where id = 'i1'");
    const r2 = coverage(pathA, [fewer], ["SortGroupItem"]);
    expect(r2.tables.SortGroupItem).toMatchObject({ rows: 2, uncovered: 1 });

    // kept copy lacks a column the candidate has -> it cannot vouch for the rows
    const narrow = path.join(c.dir, "narrow.db");
    const nd = new DatabaseSync(narrow);
    nd.exec("create table SortSession (id text primary key, participantName text); insert into SortSession values ('a','홍길동'),('b','김철수');");
    nd.close();
    const r3 = coverage(pathA, [narrow], ["SortSession"]);
    expect(r3.tables.SortSession.uncovered).toBe(2);
    expect(r3.tables.SortSession.usableKept).toBe(0);
  });
});

describe("retention: normal replacement keeps the latest set and the RAW baseline, deletes only fully covered older backups", () => {
  it("deletes covered older backups, keeps latest + baseline + non-automatic dirs, and never touches the live DB or package files", () => {
    const c = makeLive();
    const baseline = makeBaseline(c);
    fs.mkdirSync(path.join(c.backups, "changelog"));
    fs.writeFileSync(path.join(c.backups, "changelog", "keep.txt"), "x");
    // a registered package ZIP (live file) that every backup hard-links
    const zipBytes = Buffer.from("zip-content");
    const sha = crypto.createHash("sha256").update(zipBytes).digest("hex");
    fs.mkdirSync(path.join(c.dir, "analysis-packages"));
    fs.writeFileSync(path.join(c.dir, "analysis-packages", sha + ".zip"), zipBytes);

    // normalisation-like change, then a new response: three automatic backups over time
    expect(runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") }).result).toBe("OK"); // identical content to the baseline
    sql(c.file, "update SortSession set phoneNumber = '01011112222' where id = 'a'");
    expect(runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") }).result).toBe("OK");
    sql(c.file, "insert into SortSession values ('c','이영희','5678',15); insert into SortGroup values ('g3','c','새'); insert into SortGroupItem values ('i3','g3','s1');");
    writePolicy(c, { rawBaseline: baseline });
    process.env.AUTO_BACKUP_RETENTION = "apply";
    const liveBefore = fs.readFileSync(c.file);
    const last = runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-19T00:00:00Z") });
    expect(last.result).toBe("OK");

    expect(dirs(c)).toEqual(["20261019T000000Z_scheduled", "changelog", baseline].sort());
    expect(status(c).lastRetention).toMatchObject({ applied: true, mode: "apply", latest: "20261019T000000Z_scheduled", rawBaseline: baseline });
    expect(status(c).lastRetention.deleted.sort()).toEqual(["20261017T000000Z_scheduled", "20261018T000000Z_scheduled"]);
    // latest set is complete and verifies; baseline verifies; live files untouched
    expect(verify(path.join(c.backups, "20261019T000000Z_scheduled")).ok).toBe(true);
    expect(verify(path.join(c.backups, baseline)).ok).toBe(true);
    expect(fs.existsSync(path.join(c.backups, "changelog", "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(c.dir, "analysis-packages", sha + ".zip"))).toBe(true);
    expect(fs.existsSync(path.join(c.backups, "20261019T000000Z_scheduled", "analysis-packages", sha + ".zip"))).toBe(true);
    expect(Buffer.compare(fs.readFileSync(c.file), liveBefore)).toBe(0); // the live database file is byte-identical after backup + retention
    const db = new DatabaseSync(c.file, { readOnly: true });
    expect(db.prepare("select count(*) as n from SortSession").get()).toEqual({ n: 3 });
    db.close();
    // a deleted backup's ZIP links were links: the live file and the latest link both remain (nlink dropped, content intact)
    expect(fs.readFileSync(path.join(c.dir, "analysis-packages", sha + ".zip"))).toEqual(zipBytes);
  });

  it("is also applied when the data did not change (the skip path), so enabling the policy later prunes on the next scheduled tick", () => {
    const c = makeLive();
    const baseline = makeBaseline(c);
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    sql(c.file, "update SortSession set phoneNumber = 'changed' where id = 'a'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") });
    expect(dirs(c)).toHaveLength(3);
    writePolicy(c, { rawBaseline: baseline });
    process.env.AUTO_BACKUP_RETENTION = "apply";
    const r = runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-19T00:00:00Z") });
    expect(r.result).toBe("SKIPPED_UNCHANGED");
    expect(dirs(c)).toEqual(["20261018T000000Z_scheduled", baseline].sort());
  });
});

describe("retention never deletes without both gates, and keeps everything on any doubt", () => {
  function setup() {
    const c = makeLive();
    const baseline = makeBaseline(c);
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    sql(c.file, "update SortSession set phoneNumber = 'n' where id = 'a'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") });
    return { c, baseline };
  }

  it("does nothing when the environment variable is not set, even with a policy file", () => {
    const { c, baseline } = setup();
    writePolicy(c, { rawBaseline: baseline });
    expect(retentionMode()).toBe("off");
    runOnce({ reason: "manual", databaseUrl: c.url, now: t("2026-10-19T00:00:00Z") });
    expect(dirs(c).length).toBe(4);
  });

  it("does nothing without the policy file, even with the environment variable set (policy absent = disabled)", () => {
    const { c } = setup();
    process.env.AUTO_BACKUP_RETENTION = "apply";
    runOnce({ reason: "manual", databaseUrl: c.url, now: t("2026-10-19T00:00:00Z") });
    expect(dirs(c).length).toBe(4);
    expect(status(c).lastRetention).toMatchObject({ applied: false, reason: "NO_POLICY_FILE" });
  });

  it("dry-run only reports what it would delete", () => {
    const { c, baseline } = setup();
    writePolicy(c, { rawBaseline: baseline });
    process.env.AUTO_BACKUP_RETENTION = "dry-run";
    runOnce({ reason: "manual", databaseUrl: c.url, now: t("2026-10-19T00:00:00Z") });
    expect(dirs(c).length).toBe(4);
    expect(status(c).lastRetention.deleted.length).toBeGreaterThan(0);
    expect(status(c).lastRetention.mode).toBe("dry-run");
  });

  it("an invalid or unreadable policy file disables retention", () => {
    const { c } = setup();
    fs.writeFileSync(path.join(c.backups, POLICY_FILE), "{not json");
    process.env.AUTO_BACKUP_RETENTION = "apply";
    runOnce({ reason: "manual", databaseUrl: c.url, now: t("2026-10-19T00:00:00Z") });
    expect(dirs(c).length).toBe(4);
    expect(status(c).lastRetention.reason).toBe("POLICY_UNREADABLE");
  });

  it("RAW mismatch: a backup holding a response value found nowhere else is kept (and the plan says why)", () => {
    const c = makeLive();
    const baseline = makeBaseline(c); // phone '010-1111-2222' for 'a'
    sql(c.file, "update SortSession set phoneNumber = 'only-here' where id = 'a'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") }); // holds 'only-here'
    sql(c.file, "update SortSession set phoneNumber = 'final' where id = 'a'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") }); // latest
    writePolicy(c, { rawBaseline: baseline });
    const plan = planRetention({ root: c.backups, latestDir: "20261018T000000Z_scheduled", liveDbPath: c.file, verify });
    expect(plan.enabled).toBe(true);
    const e = plan.candidates.find((x: { dir: string }) => x.dir === "20261017T000000Z_scheduled");
    expect(e).toMatchObject({ decision: "keep", reason: "RAW_ROWS_ONLY_IN_THIS_BACKUP", tables: ["SortSession"] });
    const res = applyRetention({ root: c.backups, plan, dryRun: false });
    expect(res.deleted).toEqual([]);
    expect(dirs(c)).toContain("20261017T000000Z_scheduled");
  });

  it("a result row (AnalysisRun) only in the candidate keeps it; an operational-only difference (AnalysisPackageJob) does not", () => {
    const c = makeLive();
    const baseline = makeBaseline(c);
    sql(c.file, "insert into AnalysisPackageJob values ('j1','BUILDING')");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") }); // differs from latest only by an operational row
    sql(c.file, "insert into AnalysisRun values ('r1','KR','bundle')");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") }); // has the run
    sql(c.file, "delete from AnalysisRun where id='r1'; update AnalysisPackageJob set status='READY'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-19T00:00:00Z") }); // latest: run gone, job READY
    writePolicy(c, { rawBaseline: baseline });
    const plan = planRetention({ root: c.backups, latestDir: "20261019T000000Z_scheduled", liveDbPath: c.file, verify });
    const by = Object.fromEntries(plan.candidates.map((x: { dir: string }) => [x.dir, x]));
    expect(by["20261017T000000Z_scheduled"]).toMatchObject({ decision: "delete" });
    expect(by["20261018T000000Z_scheduled"]).toMatchObject({ decision: "keep", reason: "RESULT_ROWS_ONLY_IN_THIS_BACKUP" });
  });

  it("an unverifiable latest backup (damaged file) keeps every older backup", () => {
    const { c, baseline } = setup();
    writePolicy(c, { rawBaseline: baseline });
    const latest = "20261018T000000Z_scheduled";
    const m = JSON.parse(fs.readFileSync(path.join(c.backups, latest, "manifest.json"), "utf8"));
    const f = path.join(c.backups, latest, m.file);
    fs.chmodSync(f, 0o666);
    fs.appendFileSync(f, "damage");
    const plan = planRetention({ root: c.backups, latestDir: latest, liveDbPath: c.file, verify });
    expect(plan).toMatchObject({ enabled: false, reason: "LATEST_NOT_VERIFIED" });
    expect(applyRetention({ root: c.backups, plan, dryRun: false }).deleted).toEqual([]);
    expect(dirs(c).length).toBe(3);
  });

  it("an unverifiable RAW baseline keeps every older backup", () => {
    const { c, baseline } = setup();
    writePolicy(c, { rawBaseline: baseline });
    fs.rmSync(path.join(c.backups, baseline, "manifest.json"), { force: true });
    const plan = planRetention({ root: c.backups, latestDir: "20261018T000000Z_scheduled", liveDbPath: c.file, verify });
    expect(plan).toMatchObject({ enabled: false, reason: "BASELINE_NOT_VERIFIED" });
    expect(dirs(c).length).toBe(3);
  });

  it("a candidate that does not verify is an exception, never deleted", () => {
    const { c, baseline } = setup();
    writePolicy(c, { rawBaseline: baseline });
    const cand = "20261017T000000Z_scheduled";
    const m = JSON.parse(fs.readFileSync(path.join(c.backups, cand, "manifest.json"), "utf8"));
    const f = path.join(c.backups, cand, m.file);
    fs.chmodSync(f, 0o666);
    fs.appendFileSync(f, "damage");
    const plan = planRetention({ root: c.backups, latestDir: "20261018T000000Z_scheduled", liveDbPath: c.file, verify });
    expect(plan.candidates.find((x: { dir: string }) => x.dir === cand)).toMatchObject({ decision: "keep", reason: "CANDIDATE_NOT_VERIFIED" });
    applyRetention({ root: c.backups, plan, dryRun: false });
    expect(dirs(c)).toContain(cand);
  });

  it("when the latest backup's RAW rows are no longer in the live database nothing is deleted", () => {
    const { c, baseline } = setup();
    writePolicy(c, { rawBaseline: baseline });
    sql(c.file, "update SortSession set age = 77 where id = 'b'"); // live changed after the latest backup
    const plan = planRetention({ root: c.backups, latestDir: "20261018T000000Z_scheduled", liveDbPath: c.file, verify });
    expect(plan).toMatchObject({ enabled: false, reason: "LATEST_RAW_NOT_IN_LIVE" });
    expect(dirs(c).length).toBe(3);
  });

  it("protected names and non-automatic directories are never candidates; the guard also refuses a forged plan", () => {
    const { c, baseline } = setup();
    writePolicy(c, { rawBaseline: baseline, protect: ["20261017T000000Z_scheduled"] });
    fs.mkdirSync(path.join(c.backups, "pre-mds-v2_20261018T101212Z"));
    const plan = planRetention({ root: c.backups, latestDir: "20261018T000000Z_scheduled", liveDbPath: c.file, verify });
    expect(plan.candidates.map((x: { dir: string }) => x.dir)).not.toContain("pre-mds-v2_20261018T101212Z");
    expect(plan.candidates.find((x: { dir: string }) => x.dir === "20261017T000000Z_scheduled")).toMatchObject({ decision: "keep", reason: "PROTECTED_BY_POLICY" });
    const forged = { ...plan, candidates: [{ dir: baseline, decision: "delete" }, { dir: "20261018T000000Z_scheduled", decision: "delete" }, { dir: "20261017T000000Z_scheduled", decision: "delete" }, { dir: "../escape", decision: "delete" }] };
    const res = applyRetention({ root: c.backups, plan: forged, dryRun: false });
    expect(res.deleted).toEqual([]);
    expect(res.errors.length).toBe(4);
    expect(dirs(c)).toEqual(["20261017T000000Z_scheduled", "20261018T000000Z_scheduled", "pre-mds-v2_20261018T101212Z", baseline].sort().filter(Boolean));
  });
});

describe("creation: publish only after verification; failures and concurrency keep the last good backup", () => {
  it("a same-second collision fails without touching the existing backup and leaves no temporary directory", () => {
    const c = makeLive();
    const ok = createBackup({ reason: "x", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    expect(ok.result).toBe("OK");
    const before = fs.readFileSync(path.join(c.backups, ok.dir, "manifest.json"));
    const again = createBackup({ reason: "x", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    expect(again.result).toBe("FAILED");
    expect(Buffer.compare(before, fs.readFileSync(path.join(c.backups, ok.dir, "manifest.json")))).toBe(0);
    expect(fs.readdirSync(c.backups).filter((x) => x.startsWith(".tmp-"))).toEqual([]);
    expect(verify(path.join(c.backups, ok.dir)).ok).toBe(true);
  });

  it("a failed creation leaves no half-published directory, no temporary directory, and the previous backup stays the latest verified one", () => {
    const c = makeLive();
    expect(runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") }).result).toBe("OK");
    sql(c.file, "update SortSession set age = 18 where id = 'a'"); // data changed, so a new backup is needed
    // a new backup whose directory name collides with an existing one must fail (never overwrite) via the scheduled path too
    const failed = runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    expect(failed.result).toBe("FAILED");
    expect(dirs(c)).toEqual(["20261017T000000Z_scheduled"]);
    expect(fs.readdirSync(c.backups).filter((x) => x.startsWith(".tmp-"))).toEqual([]);
    expect(verify(path.join(c.backups, "20261017T000000Z_scheduled")).ok).toBe(true);
    expect(status(c).lastResult).toBe("FAILED");
    expect(status(c).lastBackupDir).toBe("20261017T000000Z_scheduled"); // the last good backup is still the recorded latest
    expect(status(c).consecutiveFailures).toBe(1);
  });

  it("two simultaneous runs: the second is skipped while a fresh lock exists, and a stale lock is replaced", () => {
    const c = makeLive();
    fs.mkdirSync(c.backups, { recursive: true });
    const release = acquireLock(c.backups, new Date());
    expect(release).toBeTypeOf("function");
    expect(acquireLock(c.backups, new Date())).toBeNull(); // second holder refused
    const r = runOnce({ reason: "scheduled", databaseUrl: c.url, now: new Date() });
    expect(r.result).toBe("SKIPPED_LOCKED");
    expect(dirs(c)).toEqual([]);
    release();
    // a lock whose owner is provably gone (same host, process no longer exists) is taken over; age alone never decides
    const lock = path.join(c.backups, ".backup.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483000, host: os.hostname(), token: "dead-owner", at: new Date().toISOString() }));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    const again = runOnce({ reason: "scheduled", databaseUrl: c.url, now: new Date() });
    expect(again.result).toBe("OK");
    expect(fs.existsSync(lock)).toBe(false); // released at the end of the run
  });

  it("stale temporary directories are removed; fresh ones and everything else are left alone", () => {
    const c = makeLive();
    fs.mkdirSync(path.join(c.backups, ".tmp-old"), { recursive: true });
    fs.mkdirSync(path.join(c.backups, ".tmp-new"), { recursive: true });
    fs.mkdirSync(path.join(c.backups, "20261016T000000Z_keep"), { recursive: true });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(path.join(c.backups, ".tmp-old"), old, old);
    expect(removeStaleTemp(c.backups, new Date())).toEqual([".tmp-old"]);
    expect(fs.existsSync(path.join(c.backups, ".tmp-new"))).toBe(true);
    expect(fs.existsSync(path.join(c.backups, "20261016T000000Z_keep"))).toBe(true);
  });
});
