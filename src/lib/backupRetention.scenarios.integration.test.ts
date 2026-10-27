import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { runOnce, createBackup, verifyBackupDir } from "../../scripts/backup/auto-backup.mjs";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { removeStaleTemp, POLICY_FILE, canon, coverage, acquireLock } from "../../scripts/backup/retention.mjs";
import { planRetention, applyRetention } from "./backupRetention.testkit";

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
    for (const bad of [{ ...good, dir: L1 }, { ...good, sha256: "0".repeat(64) }, { ...good, fingerprint: "x" }]) {
      const p = plan(c, { latestRecord: bad });
      expect(p).toMatchObject({ enabled: false, reason: "LATEST_RECORD_MISMATCH" });
      expect(applyRetention({ root: c.backups, plan: p, dryRun: false }).deleted).toEqual([]);
    }
    // a missing record is not "no objection": it blocks too
    for (const none of [null, { dir: undefined, sha256: undefined, fingerprint: undefined }]) {
      expect(plan(c, { latestRecord: none })).toMatchObject({ enabled: false, reason: "LATEST_RECORD_MISSING" });
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


// ======================================================================================================== review round 2 regressions
const U1 = "\u0001"; // the real U+0001 character

function smallDb(name: string, ddl: string) {
  const f = path.join(root, `${name}${++n}.db`);
  const d = new DatabaseSync(f);
  d.exec(ddl);
  d.close();
  return f;
}
const putRow = (f: string, a: string, b: string) => {
  const d = new DatabaseSync(f);
  d.prepare("insert into T values ('1', ?, ?)").run(a, b);
  d.close();
};

describe("regression 2: row serialisation is unambiguous and counts duplicates", () => {
  it("canon(): values that contain the separator or a type prefix can never produce the same row text as a different row", () => {
    expect(canon(["a" + U1 + "string", "c"])).not.toBe(canon(["a", "b" + U1 + "string"]));
    // the old form joined "type:value" with U+0001: these two different rows gave the SAME text
    expect(canon(["x" + U1 + "string:y", "z"])).not.toBe(canon(["x", "y" + U1 + "string:z"]));
    expect(canon(["", "a"])).not.toBe(canon(["a", ""]));
    expect(canon([null])).not.toBe(canon(["null"]));
    expect(canon([1n])).not.toBe(canon([1])); // integer vs real
    expect(canon([0])).not.toBe(canon([-0]));
    expect(canon([new Uint8Array([1, 2])])).not.toBe(canon(["0102"]));
    expect(canon(["a"])).toBe(canon(["a"])); // equal rows stay equal
  });

  it("coverage(): the two rows of the review (same id, U+0001 inside a value) are different rows", () => {
    const ddl = "create table T (id text primary key, a text, b text)";
    const cand = smallDb("sepc", ddl);
    const kept = smallDb("sepk", ddl);
    putRow(cand, "a" + U1 + "string", "c");
    putRow(kept, "a", "b" + U1 + "string");
    expect(coverage(cand, [kept], ["T"]).tables.T.uncovered).toBe(1);
    // the pair that really collided under the old separator-joined form
    const cand2 = smallDb("sepc2", ddl);
    const kept2 = smallDb("sepk2", ddl);
    putRow(cand2, "x" + U1 + "string:y", "z");
    putRow(kept2, "x", "y" + U1 + "string:z");
    expect(coverage(cand2, [kept2], ["T"]).tables.T).toMatchObject({ rows: 1, uncovered: 1 });
    expect(coverage(cand2, [cand2], ["T"]).ok).toBe(true);
  });

  it("coverage(): integer 1, real 1.0 and text '1' are three different values", () => {
    const cand = smallDb("types", "create table M (v); insert into M values (1);");
    const real = smallDb("typesr", "create table M (v); insert into M values (1.0);");
    const text = smallDb("typest", "create table M (v); insert into M values ('1');");
    expect(coverage(cand, [real], ["M"]).tables.M.uncovered).toBe(1);
    expect(coverage(cand, [text], ["M"]).tables.M.uncovered).toBe(1);
    expect(coverage(cand, [cand], ["M"]).ok).toBe(true);
  });

  it("coverage(): a row that occurs n times needs n occurrences in ONE kept copy (duplicates in a table without id)", () => {
    const three = smallDb("dup3", "create table Dup (a text, b text); insert into Dup values ('x','y'),('x','y'),('x','y');");
    const one = smallDb("dup1", "create table Dup (a text, b text); insert into Dup values ('x','y');");
    const two = smallDb("dup2", "create table Dup (a text, b text); insert into Dup values ('x','y'),('x','y');");
    expect(coverage(three, [one], ["Dup"]).tables.Dup).toMatchObject({ rows: 3, uncovered: 2 });
    expect(coverage(three, [two], ["Dup"]).tables.Dup.uncovered).toBe(1);
    expect(coverage(three, [one, two], ["Dup"]).tables.Dup.uncovered).toBe(1); // counts are not added up across copies
    expect(coverage(three, [three], ["Dup"]).ok).toBe(true);
  });

  it("retention keeps a backup whose only difference is an extra duplicate row", () => {
    const c = makeLive("create table Dup (a text, b text);");
    const base = makeBaseline(c);
    sql(c.file, "insert into Dup values ('x','y'),('x','y')");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") }); // L1: two identical rows
    sql(c.file, "delete from Dup where rowid = (select max(rowid) from Dup); update SortSession set phoneNumber='n'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") }); // latest: one row
    writePolicy(c, { rawBaseline: base });
    const p = plan(c);
    expect(p.enabled).toBe(true);
    // the baseline has no Dup row and the latest one: the second copy exists nowhere else -> L1 must be kept
    expect(entry(p, L1)).toMatchObject({ decision: "keep", reason: "RAW_ROWS_ONLY_IN_THIS_BACKUP", tables: ["Dup"] });
  });
});

function runCli(c: Live, ...args: string[]) {
  return spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/backup/retention.mjs"), "--db", c.file, ...args], { encoding: "utf8" });
}
const readStatusFile = (c: Live) => JSON.parse(fs.readFileSync(path.join(c.backups, "status.json"), "utf8"));

describe("regression 3: the manual CLI follows the same rules as the daemon (record + lock)", () => {
  it("--apply with a verification record that does not match deletes nothing", () => {
    const { c } = setup();
    fs.writeFileSync(path.join(c.backups, "status.json"), JSON.stringify({ ...readStatusFile(c), lastBackupSha256: "f".repeat(64) }));
    const r = runCli(c, "--apply");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/LATEST_RECORD_MISMATCH/);
    expect(dirs(c)).toContain(L1);
  });

  it("--apply without any verification record (no status.json) deletes nothing", () => {
    const { c } = setup();
    fs.rmSync(path.join(c.backups, "status.json"));
    const r = runCli(c, "--apply");
    expect(r.status).not.toBe(0);
    expect(dirs(c)).toContain(L1);
  });

  it("--apply while another run holds the lock deletes nothing and leaves that lock alone", () => {
    const { c } = setup();
    const lock = path.join(c.backups, ".backup.lock");
    const mine = JSON.stringify({ pid: process.pid, token: "held-by-the-daemon", at: new Date().toISOString() });
    fs.writeFileSync(lock, mine);
    const r = runCli(c, "--apply");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/holds the lock/);
    expect(dirs(c)).toContain(L1);
    expect(fs.readFileSync(lock, "utf8")).toBe(mine);
  });

  it("--apply with a valid record and no lock deletes the covered backup and releases the lock; the default (no --apply) is only a report", () => {
    const { c } = setup();
    const dry = runCli(c);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout).result.dryRun).toBe(true);
    expect(dirs(c)).toContain(L1);
    const r = runCli(c, "--apply");
    expect(r.status, r.stderr).toBe(0);
    expect(dirs(c)).not.toContain(L1);
    expect(fs.existsSync(path.join(c.backups, ".backup.lock"))).toBe(false);
  });
});

describe("regression 3: lock ownership", () => {
  const lockOf = (c: Live) => path.join(c.backups, ".backup.lock");
  const holder = (token: string, pid = process.pid) => JSON.stringify({ pid, token, at: new Date().toISOString() });
  const age = (f: string, ms: number) => {
    const old = new Date(Date.now() - ms);
    fs.utimesSync(f, old, old);
  };

  it("release removes the lock only if it still carries this run's token", () => {
    const c = makeLive();
    fs.mkdirSync(c.backups, { recursive: true });
    const release = acquireLock(c.backups) as () => void;
    fs.writeFileSync(lockOf(c), holder("another-run")); // the lock now belongs to somebody else
    release();
    expect(JSON.parse(fs.readFileSync(lockOf(c), "utf8")).token).toBe("another-run");
    const release2 = acquireLock(c.backups, new Date(Date.now() + 7 * 3600 * 1000)) as () => void; // 7 h later: hard-stale, taken over
    expect(release2).toBeTypeOf("function");
    release2();
    expect(fs.existsSync(lockOf(c))).toBe(false);
  });

  it("a lock older than 30 minutes whose process is still alive is not taken over (until 6 hours)", () => {
    const c = makeLive();
    fs.mkdirSync(c.backups, { recursive: true });
    fs.writeFileSync(lockOf(c), holder("alive-owner"));
    age(lockOf(c), 2 * 3600 * 1000);
    expect(acquireLock(c.backups, new Date())).toBeNull();
    expect(JSON.parse(fs.readFileSync(lockOf(c), "utf8")).token).toBe("alive-owner");
    age(lockOf(c), 7 * 3600 * 1000);
    expect(acquireLock(c.backups, new Date())).toBeTypeOf("function");
  });

  it("a stale lock whose process is gone is taken over, and the leftover renamed file is cleaned up", () => {
    const c = makeLive();
    fs.mkdirSync(c.backups, { recursive: true });
    fs.writeFileSync(lockOf(c), holder("dead-owner", 2147483000));
    age(lockOf(c), 2 * 3600 * 1000);
    const release = acquireLock(c.backups, new Date()) as () => void;
    expect(release).toBeTypeOf("function");
    expect(fs.readdirSync(c.backups).filter((x) => x.includes(".stale-"))).toEqual([]);
    release();
  });
});

describe("regression 4: policy and verification are re-checked right before the deletion", () => {
  function attempt(mutate: (c: Live) => void, noReplan = false) {
    const { c } = setup();
    const p = plan(c);
    expect(entry(p, L1)).toMatchObject({ decision: "delete" });
    mutate(c);
    const res = noReplan ? applyRetention({ root: c.backups, plan: p, dryRun: false, replan: undefined }) : applyRetention({ root: c.backups, plan: p, dryRun: false });
    return { c, res };
  }
  const BASE = "survey-complete_20261016T120119Z";
  const policyPath = (c: Live) => path.join(c.backups, POLICY_FILE);
  const damage = (file: string) => {
    fs.chmodSync(file, 0o666);
    fs.appendFileSync(file, "x");
  };
  const dbOf = (c: Live, d: string) => path.join(c.backups, d, JSON.parse(fs.readFileSync(path.join(c.backups, d, "manifest.json"), "utf8")).file);

  it.each([
    ["the policy file is removed after the plan", (c: Live) => fs.rmSync(policyPath(c)), /REVALIDATION_BLOCKED: NO_POLICY_FILE/],
    ["the policy file becomes unreadable JSON", (c: Live) => fs.writeFileSync(policyPath(c), "{ not json"), /REVALIDATION_BLOCKED: POLICY_UNREADABLE/],
    ["the policy file becomes invalid", (c: Live) => fs.writeFileSync(policyPath(c), JSON.stringify({ version: 2 })), /REVALIDATION_BLOCKED: POLICY_INVALID/],
    ["the policy file changes (even to a harmless protect entry)", (c: Live) => writePolicy(c, { rawBaseline: BASE, protect: ["something-else"] }), /POLICY_CHANGED/],
    ["the policy now protects the candidate", (c: Live) => writePolicy(c, { rawBaseline: BASE, protect: [L1] }), /POLICY_CHANGED/],
    ["the RAW baseline stops verifying", (c: Live) => damage(dbOf(c, BASE)), /REVALIDATION_BLOCKED: BASELINE_NOT_VERIFIED/],
    ["the latest backup stops verifying", (c: Live) => damage(dbOf(c, L2)), /REVALIDATION_BLOCKED: LATEST_NOT_VERIFIED/],
    ["the verification record changes", (c: Live) => fs.writeFileSync(path.join(c.backups, "status.json"), JSON.stringify({ ...readStatusFile(c), lastBackupSha256: "0".repeat(64) })), /REVALIDATION_BLOCKED: LATEST_RECORD_MISMATCH/],
    ["the verification record disappears", (c: Live) => fs.rmSync(path.join(c.backups, "status.json")), /REVALIDATION_BLOCKED: LATEST_RECORD_MISSING/],
  ])("%s: nothing is deleted", (_name, mutate, message) => {
    const { c, res } = attempt(mutate as (c: Live) => void);
    expect(res.deleted).toEqual([]);
    expect(res.errors[0].error).toMatch(message as RegExp);
    expect(dirs(c)).toContain(L1);
  });

  it("the candidate itself changing after the plan keeps that backup", () => {
    const { c, res } = attempt((cc) => damage(dbOf(cc, L1)));
    expect(res.deleted).toEqual([]);
    expect(res.errors[0].error).toMatch(/not a deletion candidate after re-check \(CANDIDATE_NOT_VERIFIED\)/);
    expect(dirs(c)).toContain(L1);
  });

  it("without a way to re-check, nothing is deleted (a dry run still reports)", () => {
    const { c, res } = attempt(() => undefined, true);
    expect(res.deleted).toEqual([]);
    expect(res.errors[0].error).toMatch(/REVALIDATION_UNAVAILABLE/);
    expect(dirs(c)).toContain(L1);
    const { c: c2 } = setup();
    expect(applyRetention({ root: c2.backups, plan: plan(c2), dryRun: true, replan: undefined }).deleted).toEqual([{ dir: L1, dryRun: true }]);
  });

  it("when nothing changed the deletion still happens (the re-check does not block the normal path)", () => {
    const { c, res } = attempt(() => undefined);
    expect(res.errors).toEqual([]);
    expect(res.deleted.map((d: { dir: string }) => d.dir)).toEqual([L1]);
    expect(dirs(c)).not.toContain(L1);
  });
});

describe("regression 5: deleting never changes mode, bytes or hash of shared (hard-linked) files", () => {
  const modeOf = (f: string) => fs.statSync(f).mode & 0o777;
  const shaOf = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

  function withZips() {
    const c = makeLive();
    fs.mkdirSync(path.join(c.dir, "analysis-packages"));
    const zips = [
      { bytes: Buffer.from("zip-one-0444"), mode: 0o444 },
      { bytes: Buffer.from("zip-two-0640"), mode: 0o640 },
    ].map((z) => {
      const sha = crypto.createHash("sha256").update(z.bytes).digest("hex");
      const live = path.join(c.dir, "analysis-packages", sha + ".zip");
      fs.writeFileSync(live, z.bytes);
      fs.chmodSync(live, z.mode);
      return { ...z, sha, live };
    });
    return { c, zips };
  }

  it("a deleted backup that holds hard links of live ZIPs leaves the live ZIPs and the kept copies exactly as they were", () => {
    const { c, zips } = withZips();
    const base = makeBaseline(c);
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-17T00:00:00Z") });
    sql(c.file, "update SortSession set phoneNumber = 'n'");
    runOnce({ reason: "scheduled", databaseUrl: c.url, now: t("2026-10-18T00:00:00Z") });
    writePolicy(c, { rawBaseline: base });
    const sharedFiles = (d: string) => zips.map((z) => path.join(c.backups, d, "analysis-packages", z.sha + ".zip"));
    const watch = [...zips.map((z) => z.live), ...sharedFiles(L2), ...sharedFiles(base)];
    const before = watch.map((f) => ({ f, mode: modeOf(f), sha: shaOf(f), ino: fs.statSync(f).ino }));
    const links = zips.map((z) => fs.statSync(z.live).nlink);
    // the candidate really shares the inode with the live file (otherwise this test proves nothing)
    for (const z of zips) expect(fs.statSync(path.join(c.backups, L1, "analysis-packages", z.sha + ".zip")).ino).toBe(fs.statSync(z.live).ino);
    const res = applyRetention({ root: c.backups, plan: plan(c), dryRun: false });
    expect(res.deleted.map((d: { dir: string }) => d.dir)).toEqual([L1]);
    expect(res.errors).toEqual([]);
    for (const b of before) expect({ f: b.f, mode: modeOf(b.f), sha: shaOf(b.f), ino: fs.statSync(b.f).ino }).toEqual(b);
    zips.forEach((z, i) => expect(fs.statSync(z.live).nlink).toBe(links[i] - 1));
    expect(fs.readdirSync(c.backups).filter((x) => x.startsWith(".deleting-"))).toEqual([]);
  });

  it("cleaning a stale temporary directory that holds a hard link of a live ZIP does not change the live ZIP either", () => {
    const { c, zips } = withZips();
    fs.mkdirSync(path.join(c.backups, ".tmp-old", "analysis-packages"), { recursive: true });
    for (const z of zips) fs.linkSync(z.live, path.join(c.backups, ".tmp-old", "analysis-packages", z.sha + ".zip"));
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(path.join(c.backups, ".tmp-old"), old, old);
    const before = zips.map((z) => ({ mode: modeOf(z.live), sha: shaOf(z.live) }));
    expect(removeStaleTemp(c.backups, new Date())).toEqual([".tmp-old"]);
    zips.forEach((z, i) => expect({ mode: modeOf(z.live), sha: shaOf(z.live) }).toEqual(before[i]));
  });
});
