import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { runOnce, createBackup, verifyBackupDir } from "../../scripts/backup/auto-backup.mjs";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { planRetention, applyRetention, removeStaleTemp, POLICY_FILE } from "../../scripts/backup/retention.mjs";

/**
 * Failure scenarios for the retention code: unlisted tables, verification-record mismatch, path escape, links, rename/remove failures,
 * a process killed mid-run and simultaneous runs. Everything runs on copies in a temp folder; nothing here touches real data.
 * (Host: whatever OS runs the suite. The same file is meant to be run inside a Linux container as well; see docs/backup-retention.md.)
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-retention-sc-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AUTO_BACKUP_RETENTION;
});

const t = (iso: string) => new Date(iso);
let n = 0;
type Live = { dir: string; file: string; url: string; backups: string };

function makeLive(extra = ""): Live {
  const dir = path.join(root, `sc${++n}`);
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
    insert into Project values ('p','rrr',1);
    insert into Statement values ('s1','문항 1');
    insert into SortSession values ('a','홍길동','010',16);
    insert into SortGroup values ('g1','a','묶음');
    insert into SortGroupItem values ('i1','g1','s1');
    ${extra}
  `);
  db.close();
  return { dir, file, url: `file:${file}`, backups: path.join(dir, "backups") };
}
const sql = (file: string, q: string) => {
  const db = new DatabaseSync(file);
  db.exec(q);
  db.close();
};
const dirs = (c: Live) => fs.readdirSync(c.backups).filter((x) => fs.statSync(path.join(c.backups, x)).isDirectory()).sort();
const verify = (d: string) => verifyBackupDir(d);
const writePolicy = (c: Live, policy: object) => fs.writeFileSync(path.join(c.backups, POLICY_FILE), JSON.stringify({ version: 1, ...policy }));
function makeBaseline(c: Live, name = "survey-complete_20261016T120119Z") {
  const r = createBackup({ reason: "baseline", databaseUrl: c.url, now: t("2026-10-16T12:01:19Z") });
  expect(r.result).toBe("OK");
  fs.renameSync(path.join(c.backups, r.dir), path.join(c.backups, name));
  return name;
}
const L1 = "20261017T000000Z_scheduled";
const L2 = "20261018T000000Z_scheduled";
/** baseline, an older automatic backup equal to it (L1), and the latest (L2, one phone value changed). */
function setup(extra = "") {
  const c = makeLive(extra);
  const baseline = makeBaseline(c);
  expect(runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") }).result).toBe("OK");
  sql(c.file, "update SortSession set phoneNumber = 'n' where id = 'a'");
  expect(runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") }).result).toBe("OK");
  writePolicy(c, { rawBaseline: baseline });
  return { c, baseline };
}
const plan = (c: Live, o: object = {}) => planRetention({ root: c.backups, latestDir: L2, liveDbPath: c.file, verify, ...o });
const entry = (p: { candidates: { dir: string }[] }, d: string) => p.candidates.find((x) => x.dir === d);
const rewriteManifest = (dir: string, f: (m: Record<string, unknown>) => void) => {
  const p = path.join(dir, "manifest.json");
  fs.chmodSync(p, 0o666);
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  f(m);
  fs.writeFileSync(p, JSON.stringify(m));
};
function linkDir(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false; // no permission to create links on this host: the test is reported as skipped, never as passed
  }
}

describe("comparison scope: every table except operational bookkeeping, not only the known RAW list", () => {
  it("a row in a table that is on no list (added later) found nowhere else keeps the backup", () => {
    const { c } = setup("create table ConsentLog (id text primary key, note text);");
    // L1 held a ConsentLog row; the latest and the baseline do not
    const c2 = makeLive("create table ConsentLog (id text primary key, note text);");
    const base = makeBaseline(c2);
    sql(c2.file, "insert into ConsentLog values ('c1','agreed')");
    runOnce({ reason: "scheduled", databaseUrl: c2.url, now: t("2026-10-17T00:00:00Z") });
    sql(c2.file, "delete from ConsentLog; update SortSession set phoneNumber='n'");
    runOnce({ reason: "scheduled", databaseUrl: c2.url, now: t("2026-10-18T00:00:00Z") });
    writePolicy(c2, { rawBaseline: base });
    const p = plan(c2);
    expect(p.enabled).toBe(true);
    expect(entry(p, L1)).toMatchObject({ decision: "keep", reason: "RAW_ROWS_ONLY_IN_THIS_BACKUP", tables: ["ConsentLog"] });
    expect(p.candidates.find((x: { dir: string }) => x.dir === L1).comparedTables).toContain("ConsentLog");
    expect(applyRetention({ root: c2.backups, plan: p, dryRun: false }).deleted).toEqual([]);
    expect(dirs(c2)).toContain(L1);
    // control: without the extra row the same layout deletes
    expect(entry(plan(c), L1)).toMatchObject({ decision: "delete" });
  });

  it("a table the kept copies do not have at all cannot vouch for the candidate's rows", () => {
    const c = makeLive();
    const base = makeBaseline(c); // baseline made before the table existed
    sql(c.file, "create table ConsentLog (id text primary key, note text); insert into ConsentLog values ('c1','agreed')");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") }); // holds ConsentLog
    sql(c.file, "drop table ConsentLog; update SortSession set phoneNumber='n'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") }); // latest: table gone
    writePolicy(c, { rawBaseline: base });
    const p = plan(c);
    expect(entry(p, L1)).toMatchObject({ decision: "keep", reason: "RAW_ROWS_ONLY_IN_THIS_BACKUP", tables: ["ConsentLog"] });
    expect(applyRetention({ root: c.backups, plan: p, dryRun: false }).deleted).toEqual([]);
  });

  it("the latest backup lacking a known RAW table blocks every deletion", () => {
    const c = makeLive();
    const base = makeBaseline(c);
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    sql(c.file, "drop table SortGroupItem");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") });
    writePolicy(c, { rawBaseline: base });
    const p = plan(c);
    expect(p).toMatchObject({ enabled: false, reason: "LATEST_MISSING_RAW_TABLE", missingTables: ["SortGroupItem"] });
    expect(applyRetention({ root: c.backups, plan: p, dryRun: false }).deleted).toEqual([]);
    expect(dirs(c)).toContain(L1);
  });
});

describe("verification record: bound to the exact backup and its hashes", () => {
  it("a status record naming another backup, another SHA-256 or another content fingerprint blocks the plan", () => {
    const { c } = setup();
    const m = JSON.parse(fs.readFileSync(path.join(c.backups, L2, "manifest.json"), "utf8"));
    const good = { dir: L2, sha256: m.sha256, fingerprint: m.contentFingerprint };
    expect(plan(c, { latestRecord: good }).enabled).toBe(true);
    for (const bad of [{ ...good, dir: L1 }, { ...good, sha256: "0".repeat(64) }, { ...good, fingerprint: "x" }, { dir: undefined, sha256: undefined, fingerprint: undefined }]) {
      const p = plan(c, { latestRecord: bad });
      expect(p).toMatchObject({ enabled: false, reason: "LATEST_RECORD_MISMATCH" });
      expect(applyRetention({ root: c.backups, plan: p, dryRun: false }).deleted).toEqual([]);
    }
    expect(dirs(c)).toContain(L1);
  });

  it("the daemon passes the record from status.json, so a status that no longer matches the latest backup deletes nothing", () => {
    const { c } = setup();
    process.env.AUTO_BACKUP_RETENTION = "apply";
    const sp = path.join(c.backups, "status.json");
    const st = JSON.parse(fs.readFileSync(sp, "utf8"));
    fs.writeFileSync(sp, JSON.stringify({ ...st, lastBackupSha256: "f".repeat(64) }));
    // unchanged data -> skip path: the previous backup is re-verified against the status record first, so a mismatching record forces a NEW backup
    // (never a deletion based on the stale record); the new backup is then the latest and has a consistent record
    const r = runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-19T00:00:00Z") });
    expect(r.result).not.toBe("FAILED");
    const after = JSON.parse(fs.readFileSync(sp, "utf8"));
    expect(after.lastBackupSha256).not.toBe("f".repeat(64));
    for (const d of dirs(c)) expect(verify(path.join(c.backups, d)).ok).toBe(true);
  });
});

describe("path escape: names inside manifests and plans are never followed outside the backup", () => {
  it("a manifest whose database or package file is a path (..) does not verify; nothing outside is read or deleted", () => {
    const { c } = setup();
    const outside = path.join(c.dir, "outside.db");
    fs.copyFileSync(c.file, outside);
    rewriteManifest(path.join(c.backups, L1), (m) => {
      m.file = "../../outside.db";
    });
    const chk = verify(path.join(c.backups, L1));
    expect(chk.ok).toBe(false);
    expect(chk.problems.join(" ")).toMatch(/outside the backup/);
    const p = plan(c);
    expect(entry(p, L1)).toMatchObject({ decision: "keep", reason: "CANDIDATE_NOT_VERIFIED" });
    expect(applyRetention({ root: c.backups, plan: p, dryRun: false }).deleted).toEqual([]);
    expect(fs.existsSync(outside)).toBe(true);

    // a package name that is a path
    rewriteManifest(path.join(c.backups, L2), (m) => {
      m.analysisPackages = [{ file: "../../outside.db", sha256: "0", bytes: 1 }];
    });
    expect(verify(path.join(c.backups, L2)).ok).toBe(false);
    expect(plan(c)).toMatchObject({ enabled: false, reason: "LATEST_NOT_VERIFIED" });
  });

  it("a forged plan naming a path outside the backup root or a nested path is refused", () => {
    const { c } = setup();
    const victim = path.join(c.dir, "victim");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "keep.txt"), "x");
    const p = plan(c);
    const forged = { ...p, candidates: ["../victim", "..\\victim", "20261001T000000Z_x/../../victim", "/etc", "20261017T000000Z_scheduled/analysis-packages"].map((d) => ({ dir: d, decision: "delete" })) };
    const res = applyRetention({ root: c.backups, plan: forged, dryRun: false });
    expect(res.deleted).toEqual([]);
    expect(res.errors).toHaveLength(5);
    expect(fs.existsSync(path.join(victim, "keep.txt"))).toBe(true);
    expect(dirs(c)).toEqual(expect.arrayContaining([L1, L2]));
  });
});

describe("links", () => {
  it("a candidate directory that is itself a link is refused and its target is untouched", (ctx) => {
    const { c } = setup();
    const target = path.join(c.dir, "linked-target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "precious.txt"), "x");
    const name = "20261015T000000Z_scheduled";
    if (!linkDir(target, path.join(c.backups, name))) return ctx.skip();
    const p = plan(c);
    const forged = { ...p, candidates: [...p.candidates, { dir: name, decision: "delete" }] };
    const res = applyRetention({ root: c.backups, plan: forged, dryRun: false });
    expect(res.errors.some((e: { dir: string }) => e.dir === name)).toBe(true);
    expect(res.deleted.map((d: { dir: string }) => d.dir)).not.toContain(name);
    expect(fs.readFileSync(path.join(target, "precious.txt"), "utf8")).toBe("x");
  });

  it("a link INSIDE a deleted backup is removed as a link; what it points to survives", (ctx) => {
    const { c } = setup();
    const target = path.join(c.dir, "linked-inside-target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "precious.txt"), "x");
    fs.mkdirSync(path.join(c.backups, L1, "analysis-packages"), { recursive: true });
    if (!linkDir(target, path.join(c.backups, L1, "analysis-packages", "escape"))) return ctx.skip();
    const p = plan(c);
    expect(entry(p, L1)).toMatchObject({ decision: "delete" });
    const res = applyRetention({ root: c.backups, plan: p, dryRun: false });
    expect(res.deleted.map((d: { dir: string }) => d.dir)).toEqual([L1]);
    expect(res.errors).toEqual([]);
    expect(fs.existsSync(path.join(c.backups, L1))).toBe(false);
    expect(fs.readFileSync(path.join(target, "precious.txt"), "utf8")).toBe("x");
  });

  it("hard links: deleting a backup never changes the live package file or the files of the kept backups", () => {
    const c = makeLive();
    const zip = Buffer.from("zip-content");
    const sha = crypto.createHash("sha256").update(zip).digest("hex");
    fs.mkdirSync(path.join(c.dir, "analysis-packages"));
    const live = path.join(c.dir, "analysis-packages", sha + ".zip");
    fs.writeFileSync(live, zip);
    const baseline = makeBaseline(c);
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    sql(c.file, "update SortSession set phoneNumber = 'n'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") });
    writePolicy(c, { rawBaseline: baseline });
    const before = fs.statSync(live).nlink;
    expect(before).toBeGreaterThanOrEqual(4); // live + baseline + L1 + L2
    process.env.AUTO_BACKUP_RETENTION = "apply";
    const p = plan(c);
    expect(applyRetention({ root: c.backups, plan: p, dryRun: false }).deleted.map((d: { dir: string }) => d.dir)).toEqual([L1]);
    expect(fs.readFileSync(live).equals(zip)).toBe(true);
    expect(fs.statSync(live).nlink).toBe(before - 1);
    for (const d of [L2, baseline]) {
      expect(verify(path.join(c.backups, d)).ok).toBe(true);
      expect(fs.readFileSync(path.join(c.backups, d, "analysis-packages", sha + ".zip")).equals(zip)).toBe(true);
    }
  });
});

describe("rename and removal failures (simulated errors: EACCES / non-empty target)", () => {
  it("when the rename cannot be done the backup stays complete and listed, and the error is reported", () => {
    const { c } = setup();
    const trash = path.join(c.backups, `.deleting-${L1}`);
    fs.mkdirSync(trash);
    fs.writeFileSync(path.join(trash, "occupied"), "x"); // a non-empty target makes the rename fail on every OS
    const res = applyRetention({ root: c.backups, plan: plan(c), dryRun: false });
    expect(res.deleted).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(verify(path.join(c.backups, L1)).ok).toBe(true);
    expect(dirs(c)).toContain(L1);
  });

  it("a simulated permission error on rename keeps the backup intact", () => {
    const { c } = setup();
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
    });
    const res = applyRetention({ root: c.backups, plan: plan(c), dryRun: false });
    vi.restoreAllMocks();
    expect(res.deleted).toEqual([]);
    expect(res.errors[0].error).toMatch(/EACCES/);
    expect(verify(path.join(c.backups, L1)).ok).toBe(true);
  });

  it("a simulated permission error while removing: the backup has already left the list (no half-deleted backup), and the next run finishes the removal", () => {
    const { c } = setup();
    const realRm = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p).includes(".deleting-")) throw Object.assign(new Error("EACCES: permission denied, rmdir"), { code: "EACCES" });
      return realRm(p, o);
    }) as typeof fs.rmSync);
    const res = applyRetention({ root: c.backups, plan: plan(c), dryRun: false });
    vi.restoreAllMocks();
    expect(res.deleted.map((d: { dir: string }) => d.dir)).toEqual([L1]);
    expect(res.errors[0].error).toMatch(/leftover will be retried/);
    expect(dirs(c)).not.toContain(L1); // it is no longer a backup under its own name
    expect(dirs(c)).toContain(`.deleting-${L1}`);
    // the next scheduled run removes the leftover
    expect(removeStaleTemp(c.backups, new Date())).toContain(`.deleting-${L1}`);
    expect(dirs(c)).not.toContain(`.deleting-${L1}`);
  });
});

function runChild(code: string, env: Record<string, string>, opts: { killAfterFirstLineMs?: number } = {}) {
  return new Promise<{ out: string; killed: boolean }>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let killed = false;
    child.stdout.on("data", (b) => {
      out += b.toString();
      if (opts.killAfterFirstLineMs !== undefined && !killed && out.includes("\n")) {
        killed = true;
        setTimeout(() => child.kill("SIGKILL"), opts.killAfterFirstLineMs);
      }
    });
    child.on("exit", () => resolve({ out, killed }));
  });
}
const modUrl = pathToFileURL(path.resolve(__dirname, "../../scripts/backup/auto-backup.mjs")).href;

describe("mid-run termination and simultaneous runs (separate processes)", () => {
  it("a process killed while creating backups leaves only complete verified backups plus .tmp-* leftovers that the next run cleans up", async () => {
    const c = makeLive();
    const code = `import { createBackup } from ${JSON.stringify(modUrl)};
      const base = Date.parse("2026-11-01T00:00:00Z");
      console.log("start");
      for (let i = 0; i < 400; i++) createBackup({ reason: "loop", databaseUrl: process.env.DB_URL, now: new Date(base + i * 1000) });`;
    const r = await runChild(code, { DB_URL: c.url }, { killAfterFirstLineMs: 120 });
    expect(r.killed).toBe(true);
    const names = fs.existsSync(c.backups) ? fs.readdirSync(c.backups) : [];
    for (const nme of names) {
      if (/^\d{8}T\d{6}Z_loop$/.test(nme)) expect(verify(path.join(c.backups, nme)).ok, nme).toBe(true); // published = complete + verified
      else expect(nme.startsWith(".tmp-") || nme === ".backup.lock", nme).toBe(true); // nothing else, in particular no half-published directory
    }
    removeStaleTemp(c.backups, new Date(Date.now() + 3 * 60 * 60 * 1000));
    expect(fs.readdirSync(c.backups).filter((x) => x.startsWith(".tmp-"))).toEqual([]);
    expect(runOnce({ reason: "scheduled", databaseUrl: c.url, now: new Date(Date.now() + 4 * 60 * 60 * 1000) }).result).not.toBe("FAILED");
  }, 60000);

  it("several processes running at once: every published backup verifies, no temporary directory remains, status.json stays valid JSON", async () => {
    const c = makeLive();
    const code = `import { runOnce } from ${JSON.stringify(modUrl)};
      const r = runOnce({ reason: "scheduled", databaseUrl: process.env.DB_URL, now: new Date() }); // real clock: the lock and temp-directory age checks compare against real file times
      console.log(JSON.stringify({ result: r.result, detail: r }));`;
    const results = await Promise.all([0, 1, 2, 3].map((k) => runChild(code, { DB_URL: c.url, K: String(k) })));
    const parsed = results.map((x) => JSON.parse(x.out.trim().split("\n").pop() as string).result as string);
    expect(parsed.every((x) => ["OK", "SKIPPED_LOCKED", "SKIPPED_UNCHANGED"].includes(x)), results.map((x) => x.out).join(" | ")).toBe(true);
    expect(parsed).toContain("OK");
    const names = fs.readdirSync(c.backups);
    expect(names.filter((x) => x.startsWith(".tmp-"))).toEqual([]);
    for (const d of dirs(c)) expect(verify(path.join(c.backups, d)).ok, d).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(path.join(c.backups, "status.json"), "utf8"))).not.toThrow();
  }, 60000);
});
