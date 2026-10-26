import { describe, it, expect, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { runOnce } from "../../scripts/backup/auto-backup.mjs";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { pullLatest, pcStatus } from "../../scripts/backup/pull-latest-to-pc.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-pull-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const t = (iso: string) => new Date(iso);

function server() {
  const dir = path.join(root, `srv${++n}`);
  fs.mkdirSync(path.join(dir, "analysis-packages"), { recursive: true });
  const file = path.join(dir, "prod.db");
  const db = new DatabaseSync(file);
  db.exec(`create table _prisma_migrations (id text, checksum text, finished_at integer, migration_name text, logs text, rolled_back_at integer, started_at integer, applied_steps_count integer);
           insert into _prisma_migrations values ('0','x',1,'20260101_init',null,null,1,1);
           create table SortSession (id text primary key, phoneNumber text); insert into SortSession values ('a','1'),('b','2');`);
  db.close();
  const zip = Buffer.from("zip");
  fs.writeFileSync(path.join(dir, "analysis-packages", crypto.createHash("sha256").update(zip).digest("hex") + ".zip"), zip);
  const url = `file:${file}`;
  const backups = path.join(dir, "backups");
  return { dir, file, url, backups, bk: (iso: string) => runOnce({ reason: "scheduled", databaseUrl: url, now: t(iso) }) };
}
const fsTransport = (backups: string, tamper?: (rel: string, b: Buffer) => Buffer) => ({
  readBytes: (rel: string) => {
    const b = fs.readFileSync(path.join(backups, rel));
    return tamper ? tamper(rel, b) : b;
  },
});
const pc = () => path.join(root, `pc${++n}`);
const latestOf = (dest: string) => JSON.parse(fs.readFileSync(path.join(dest, "PC_LATEST.json"), "utf8"));

describe("pull-latest-to-pc.mjs", () => {
  it("pulls the verified latest set, verifies it locally, and only then marks it as the PC latest", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    const r = pullLatest({ transport: fsTransport(s.backups), dest, now: t("2026-10-17T01:00:00Z") });
    expect(r).toMatchObject({ result: "OK", dir: "20261017T000000Z_scheduled" });
    const set = path.join(dest, "20261017T000000Z_scheduled");
    expect(fs.existsSync(path.join(set, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(set, "PC_VERIFIED.json"))).toBe(true);
    expect(fs.readdirSync(path.join(set, "analysis-packages"))).toHaveLength(1);
    expect(latestOf(dest)).toMatchObject({ dir: "20261017T000000Z_scheduled" });
    expect(fs.readdirSync(dest).filter((x) => x.startsWith(".pull-"))).toEqual([]);
    const copy = new DatabaseSync(path.join(set, JSON.parse(fs.readFileSync(path.join(set, "manifest.json"), "utf8")).file), { readOnly: true });
    expect(copy.prepare("select count(*) as n from SortSession").get()).toEqual({ n: 2 });
    copy.close();
  });

  it("a second pull of the same backup is a no-op", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest });
    expect(pullLatest({ transport: fsTransport(s.backups), dest })).toMatchObject({ result: "UP_TO_DATE" });
  });

  it("a transfer whose bytes were altered is rejected: nothing is published, PC_LATEST is unchanged, no temporary folder remains", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    expect(pullLatest({ transport: fsTransport(s.backups), dest, now: t("2026-10-17T01:00:00Z") }).result).toBe("OK");
    const before = fs.readFileSync(path.join(dest, "PC_LATEST.json"));
    sqlChange(s.file);
    s.bk("2026-10-18T00:00:00Z");
    const bad = pullLatest({
      transport: fsTransport(s.backups, (rel, b) => (rel.endsWith(".db") ? Buffer.concat([b, Buffer.from("x")]) : b)),
      dest,
      now: t("2026-10-18T01:00:00Z"),
    });
    expect(bad.result).toBe("FAILED");
    expect(fs.readFileSync(path.join(dest, "PC_LATEST.json")).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(dest, "20261018T000000Z_scheduled"))).toBe(false);
    expect(fs.readdirSync(dest).filter((x) => x.startsWith(".pull-"))).toEqual([]);
  });

  it("when the server cannot be reached the previous PC latest stays exactly as it was", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest });
    const before = fs.readFileSync(path.join(dest, "PC_LATEST.json"));
    const offline = { readBytes: () => { throw new Error("cannot read status.json from the server (exit 255)"); } };
    const r = pullLatest({ transport: offline, dest });
    expect(r.result).toBe("FAILED");
    expect(fs.readFileSync(path.join(dest, "PC_LATEST.json")).equals(before)).toBe(true);
    expect(fs.readdirSync(dest).filter((x) => x.startsWith(".pull-"))).toEqual([]);
  });

  it("refuses to pull when the server does not record its latest backup as verified", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const st = JSON.parse(fs.readFileSync(path.join(s.backups, "status.json"), "utf8"));
    fs.writeFileSync(path.join(s.backups, "status.json"), JSON.stringify({ ...st, lastVerifiedOk: false }));
    const dest = pc();
    const r = pullLatest({ transport: fsTransport(s.backups), dest });
    expect(r.result).toBe("NOT_PULLED");
    expect(fs.existsSync(path.join(dest, "PC_LATEST.json"))).toBe(false);
  });

  it("--prune keeps only the newest verified PC copy, after the new one verified, and never touches unmarked folders", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest, now: t("2026-10-17T01:00:00Z"), prune: true });
    fs.mkdirSync(path.join(dest, "20250101T000000Z_manual-keep")); // looks like a backup name but was not created by this script
    fs.mkdirSync(path.join(dest, "other-folder"));
    sqlChange(s.file);
    s.bk("2026-10-18T00:00:00Z");
    const r = pullLatest({ transport: fsTransport(s.backups), dest, now: t("2026-10-18T01:00:00Z"), prune: true });
    expect(r).toMatchObject({ result: "OK", dir: "20261018T000000Z_scheduled", removed: ["20261017T000000Z_scheduled"] });
    expect(fs.readdirSync(dest).filter((x) => /^\d{8}T/.test(x)).sort()).toEqual(["20250101T000000Z_manual-keep", "20261018T000000Z_scheduled"]);
    expect(fs.existsSync(path.join(dest, "other-folder"))).toBe(true);
    expect(latestOf(dest).dir).toBe("20261018T000000Z_scheduled");
  });

  it("a failed pull never prunes the previous verified copy", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest, prune: true });
    sqlChange(s.file);
    s.bk("2026-10-18T00:00:00Z");
    const r = pullLatest({ transport: fsTransport(s.backups, (rel, b) => (rel.endsWith(".db") ? b.subarray(0, b.length - 1) : b)), dest, prune: true });
    expect(r.result).toBe("FAILED");
    expect(fs.existsSync(path.join(dest, "20261017T000000Z_scheduled"))).toBe(true);
  });
});

function sqlChange(file: string) {
  const db = new DatabaseSync(file);
  db.exec("update SortSession set phoneNumber = phoneNumber || 'x'");
  db.close();
}

const syncOf = (dest: string) => JSON.parse(fs.readFileSync(path.join(dest, "PC_SYNC.json"), "utf8"));
const rewriteJson = (file: string, f: (o: Record<string, unknown>) => void) => {
  fs.chmodSync(file, 0o666);
  const o = JSON.parse(fs.readFileSync(file, "utf8"));
  f(o);
  fs.writeFileSync(file, JSON.stringify(o));
};

describe("PC sync state: what the PC shows is the current state, never an inference from a past success", () => {
  it("a success records the exact backup ID, the manifest hash and the hash of every file, and the state is 동기화됨 as of the check time", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest, now: t("2026-10-17T01:00:00Z") });
    const manifestBytes = fs.readFileSync(path.join(s.backups, "20261017T000000Z_scheduled", "manifest.json"));
    const rec = latestOf(dest);
    expect(rec).toMatchObject({ backupId: "20261017T000000Z_scheduled", manifestSha256: crypto.createHash("sha256").update(manifestBytes).digest("hex") });
    expect(rec.files.length).toBe(2);
    expect(rec.files.every((f: { sha256: string; bytes: number }) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0)).toBe(true);
    expect(syncOf(dest)).toMatchObject({ state: "동기화됨", checkedAt: "2026-10-17T01:00:00.000Z" });
    expect(pcStatus({ dest })).toMatchObject({ state: "동기화됨", lastSuccess: { backupId: "20261017T000000Z_scheduled" } });
  });

  it("server unreachable: state 확인 불가, the last-success record is preserved untouched and is explicitly not presented as the current state", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest, now: t("2026-10-17T01:00:00Z") });
    const before = fs.readFileSync(path.join(dest, "PC_LATEST.json"));
    const offline = { readBytes: () => { throw new Error("cannot read status.json from the server (exit 255)"); } };
    const r = pullLatest({ transport: offline, dest, now: t("2026-10-20T00:00:00Z") });
    expect(r).toMatchObject({ result: "FAILED", state: "확인 불가" });
    expect(fs.readFileSync(path.join(dest, "PC_LATEST.json")).equals(before)).toBe(true);
    const st = pcStatus({ dest });
    expect(st.state).toBe("확인 불가");
    expect(st.checkedAt).toBe("2026-10-20T00:00:00.000Z");
    expect(st.lastSuccess).toMatchObject({ backupId: "20261017T000000Z_scheduled" });
    expect(st.meaning).toMatch(/does not say/);
  });

  it("a new backup exists on the server but the transfer fails: 동기화 대기, and the old success is not read as having the new backup", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest, now: t("2026-10-17T01:00:00Z") });
    sqlChange(s.file);
    s.bk("2026-10-18T00:00:00Z");
    const r = pullLatest({ transport: fsTransport(s.backups, (rel, b) => (rel.endsWith(".db") ? b.subarray(0, b.length - 1) : b)), dest, now: t("2026-10-18T01:00:00Z") });
    expect(r).toMatchObject({ result: "FAILED", state: "동기화 대기" });
    expect(syncOf(dest).serverLatest.backupId).toBe("20261018T000000Z_scheduled");
    const st = pcStatus({ dest });
    expect(st.state).toBe("동기화 대기");
    expect(st.lastSuccess?.backupId).toBe("20261017T000000Z_scheduled"); // older than the server's latest
    expect(st.lastSuccess?.backupId).not.toBe(syncOf(dest).serverLatest.backupId);
  });

  it("with no check ever recorded the state is 확인 불가 (not 동기화됨), even if an old success record exists", () => {
    const dest = pc();
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "PC_LATEST.json"), JSON.stringify({ dir: "20261017T000000Z_scheduled", dbSha256: "x", verifiedAt: "2026-10-17T01:00:00Z" }));
    expect(pcStatus({ dest })).toMatchObject({ state: "확인 불가", checkedAt: null, lastSuccess: { backupId: "20261017T000000Z_scheduled" } });
  });

  it("a PC copy with the same folder name but different recorded hashes is not 'up to date' (같은 이름만으로는 동기화됨이 아님)", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest });
    rewriteJson(path.join(dest, "20261017T000000Z_scheduled", "PC_VERIFIED.json"), (o) => {
      o.manifestSha256 = "0".repeat(64);
    });
    const r = pullLatest({ transport: fsTransport(s.backups), dest });
    expect(r).toMatchObject({ result: "NOT_PULLED", state: "동기화 대기" });
  });

  it("a PC copy that no longer verifies (file damaged after the pull) is not 'up to date'", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    pullLatest({ transport: fsTransport(s.backups), dest });
    const set = path.join(dest, "20261017T000000Z_scheduled");
    const dbFile = path.join(set, JSON.parse(fs.readFileSync(path.join(set, "manifest.json"), "utf8")).file);
    fs.chmodSync(dbFile, 0o666);
    fs.appendFileSync(dbFile, "x");
    const r = pullLatest({ transport: fsTransport(s.backups), dest });
    expect(r).toMatchObject({ result: "NOT_PULLED", state: "동기화 대기" });
    expect(r.reason).toMatch(/no longer verifies/);
  });

  it("a server verification record that disagrees with the manifest's SHA-256 refuses the pull", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    rewriteJson(path.join(s.backups, "status.json"), (o) => {
      o.lastBackupSha256 = "f".repeat(64);
    });
    const dest = pc();
    const r = pullLatest({ transport: fsTransport(s.backups), dest });
    expect(r).toMatchObject({ result: "NOT_PULLED", state: "동기화 대기" });
    expect(fs.existsSync(path.join(dest, "PC_LATEST.json"))).toBe(false);
  });

  it("a manifest that names a file as a path (..) is refused and nothing is written outside the destination", () => {
    const s = server();
    s.bk("2026-10-17T00:00:00Z");
    const dest = pc();
    const evil = (rel: string, b: Buffer) => {
      if (!rel.endsWith("manifest.json")) return b;
      const m = JSON.parse(b.toString("utf8"));
      m.file = "../escaped.db";
      return Buffer.from(JSON.stringify(m));
    };
    const r = pullLatest({ transport: fsTransport(s.backups, evil), dest });
    expect(r).toMatchObject({ result: "NOT_PULLED", state: "동기화 대기" });
    expect(fs.existsSync(path.join(path.dirname(dest), "escaped.db"))).toBe(false);
  });
});
