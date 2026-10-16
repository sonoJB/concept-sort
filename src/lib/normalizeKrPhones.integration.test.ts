import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node scripts (no type declarations)
import { applyNormalization, planChanges, tableFingerprints } from "../../scripts/backup/normalize-kr-phones.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-krphone-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

type S = { id: string; name: string; phone: string; country: string | null; role?: string };
const SEED: S[] = [
  { id: "kr1", name: "홍길동", phone: "01012345678", country: "KR", role: "MAIN" },
  { id: "kr2", name: "이순신", phone: "010-2222-3333", country: "KR", role: "MAIN" },
  { id: "kr3", name: "김유신", phone: "010 4444 5555", country: "KR", role: "PILOT" },
  { id: "kr4", name: "강감찬", phone: "1066667777", country: "KR", role: "MAIN" },
  { id: "kr5", name: "을지문덕", phone: "+82 10-8888-9999", country: "KR", role: "MAIN" },
  { id: "kr6", name: "연개소문", phone: "010-1234-567", country: "KR", role: "MAIN" }, // unclear: left alone
  { id: "kr7", name: "장보고", phone: "   ", country: "KR", role: "MAIN" }, // empty: counted
  { id: "jp1", name: "０１２３", phone: "0123", country: "JP", role: "MAIN" },
  { id: "jp2", name: "01012345678", phone: "5678", country: "JP", role: "MAIN" }, // JP name that looks like a KR number
  { id: "nc1", name: "01012345678", phone: "01012345678", country: null, role: "MAIN" }, // no country: never touched
];

function makeDb(name: string, extra?: (db: DatabaseSync) => void) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "prod.db");
  const db = new DatabaseSync(file);
  db.exec(`create table _prisma_migrations (id text, checksum text, finished_at integer, migration_name text, logs text, rolled_back_at integer, started_at integer, applied_steps_count integer);
           insert into _prisma_migrations values ('1','x',1,'20260101_init',null,null,1,1);
           create table Project (id text primary key, slug text);
           insert into Project values ('p','slug');
           create table SortSession (id text primary key, participantName text, createdAt integer, phoneNumber text, countryCode text, dataRole text, age integer);`);
  const ins = db.prepare("insert into SortSession values (?,?,?,?,?,?,?)");
  SEED.forEach((s, i) => ins.run(s.id, s.name, 1000 + i, s.phone, s.country, s.role ?? "MAIN", 14));
  extra?.(db);
  db.close();
  return { dir, file, url: `file:${file}` };
}
const rows = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const r = db.prepare("select * from SortSession order by id").all() as Record<string, unknown>[];
  db.close();
  return r;
};

describe("normalize-kr-phones", () => {
  it("dry run reports counts and masked patterns only, and writes nothing", () => {
    const v = makeDb("dry");
    const before = hash(v.file);
    const out = applyNormalization({ databaseUrl: v.url });
    expect(out.mode).toBe("DRY_RUN");
    expect(out.summary).toMatchObject({ krRows: 7, alreadyStandard: 1, toChange: 4, emptyValues: 1, needsReview: 1 });
    expect(JSON.stringify(out)).not.toMatch(/\d{3}[- ]?\d{4}/); // no phone numbers in the printable summary
    expect(out.summary.needsReviewPatterns[0].pattern).toBe("ddd-dddd-ddd");
    expect(hash(v.file)).toBe(before);
    expect(fs.existsSync(path.join(v.dir, "backups"))).toBe(false);
  });

  it("applies only the planned KR phone changes; JP rows, names, no-country rows and every other column stay identical", () => {
    const v = makeDb("apply");
    const beforeRows = rows(v.file);
    const out = applyNormalization({ databaseUrl: v.url, apply: true, now: new Date("2026-10-16T13:00:00Z") });
    expect(out.mode).toBe("APPLIED");
    expect(out.integrity).toBe("ok");
    const afterRows = rows(v.file);
    const phones = Object.fromEntries(afterRows.map((r) => [r.id as string, r.phoneNumber]));
    expect(phones).toMatchObject({
      kr1: "010-1234-5678",
      kr2: "010-2222-3333",
      kr3: "010-4444-5555",
      kr4: "010-6666-7777",
      kr5: "010-8888-9999",
      kr6: "010-1234-567", // unclear: untouched
      kr7: "   ", // empty: untouched
      jp1: "0123",
      jp2: "5678",
      nc1: "01012345678", // no country: untouched
    });
    // every column other than the planned phone numbers is identical
    const changedIds = new Set(["kr1", "kr3", "kr4", "kr5"]);
    for (const b of beforeRows) {
      const a = afterRows.find((r) => r.id === b.id)!;
      for (const k of Object.keys(b)) {
        if (k === "phoneNumber" && changedIds.has(b.id as string)) continue;
        expect(a[k], `${b.id}.${k}`).toEqual(b[k]);
      }
    }
    expect(afterRows).toHaveLength(beforeRows.length);
  });

  it("creates a verified pre-change backup holding the ORIGINAL values, and an access-restricted before/after change log", () => {
    const v = makeDb("log");
    const out = applyNormalization({ databaseUrl: v.url, apply: true, now: new Date("2026-10-16T13:00:00Z") });
    const bdir = path.join(v.dir, "backups", out.backupDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(bdir, "manifest.json"), "utf8"));
    expect(manifest.reason).toBe("pre-phone-normalization");
    const bk = new DatabaseSync(path.join(bdir, manifest.file), { readOnly: true });
    expect((bk.prepare("select phoneNumber p from SortSession where id='kr1'").get() as { p: string }).p).toBe("01012345678");
    bk.close();

    const logPath = path.join(v.dir, "backups", "changelog", out.changeLog);
    const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    expect(log.containsPersonalData).toBe(true);
    expect(log.changes).toHaveLength(4);
    expect(log.changes.find((c: { sessionId: string }) => c.sessionId === "kr4")).toMatchObject({ before: "1066667777", after: "010-6666-7777", rule: "restore-leading-zero" });
    expect(log.leftUntouched.needsReview).toHaveLength(1);
    expect(log.leftUntouched.empty).toHaveLength(1);
    expect(fs.existsSync(logPath + ".pending")).toBe(false);
    if (process.platform !== "win32") {
      expect((fs.statSync(logPath).mode & 0o777).toString(8)).toBe("400");
      expect((fs.statSync(path.dirname(logPath)).mode & 0o777).toString(8)).toBe("700");
    }
    expect(() => fs.writeFileSync(logPath, "x")).toThrow();
  });

  it("is idempotent: a second run finds nothing, creates no backup and no log", () => {
    const v = makeDb("idem");
    applyNormalization({ databaseUrl: v.url, apply: true, now: new Date("2026-10-16T13:00:00Z") });
    const dbHash = hash(v.file);
    const backupsBefore = fs.readdirSync(path.join(v.dir, "backups")).sort();
    const logsBefore = fs.readdirSync(path.join(v.dir, "backups", "changelog"));
    const again = applyNormalization({ databaseUrl: v.url, apply: true, now: new Date("2026-10-16T14:00:00Z") });
    expect(again.mode).toBe("APPLY_NOTHING_TO_DO");
    expect(again.summary.toChange).toBe(0);
    expect(hash(v.file)).toBe(dbHash);
    expect(fs.readdirSync(path.join(v.dir, "backups")).sort()).toEqual(backupsBefore);
    expect(fs.readdirSync(path.join(v.dir, "backups", "changelog"))).toEqual(logsBefore);
  });

  it("no partial application: a failure on any row rolls the whole change back", () => {
    const v = makeDb("partial", (db) => {
      db.exec(`create trigger boom before update of phoneNumber on SortSession when new.id = 'kr5'
               begin select raise(abort, 'simulated failure'); end;`);
    });
    const before = rows(v.file);
    expect(() => applyNormalization({ databaseUrl: v.url, apply: true, now: new Date("2026-10-16T13:00:00Z") })).toThrow(/simulated failure/);
    expect(rows(v.file)).toEqual(before); // kr1..kr4 were NOT changed either
    expect(fs.existsSync(path.join(v.dir, "backups", "changelog"))).toBe(false);
    // the verified pre-change backup exists (it was taken before the attempt)
    expect(fs.readdirSync(path.join(v.dir, "backups")).some((n) => /pre-phone-normalization$/.test(n))).toBe(true);
  });

  it("aborts, writing nothing, if the data changed between the backup and the write", () => {
    const v = makeDb("race");
    const before = rows(v.file);
    expect(() =>
      applyNormalization({
        databaseUrl: v.url,
        apply: true,
        now: new Date("2026-10-16T13:00:00Z"),
        _afterBackup: (dbPath: string) => {
          const w = new DatabaseSync(dbPath);
          w.exec("insert into SortSession values ('late','새참가자',9999,'01099998888','KR','MAIN',15)");
          w.close();
        },
      })
    ).toThrow(/changed after the backup/);
    expect(rows(v.file).filter((r) => r.id !== "late")).toEqual(before);
    expect(rows(v.file).find((r) => r.id === "kr1")!.phoneNumber).toBe("01012345678");
  });

  it("refuses to run without a database and never touches Japanese-only data", () => {
    expect(() => applyNormalization({ databaseUrl: "file:/not/here.db", apply: true })).toThrow(/not found/);
    const dir = path.join(root, "jp-only");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "prod.db");
    const db = new DatabaseSync(file);
    db.exec(`create table _prisma_migrations (id text, checksum text, finished_at integer, migration_name text, logs text, rolled_back_at integer, started_at integer, applied_steps_count integer);
             insert into _prisma_migrations values ('1','x',1,'m',null,null,1,1);
             create table Project (id text primary key); insert into Project values ('p');
             create table SortSession (id text primary key, participantName text, createdAt integer, phoneNumber text, countryCode text, dataRole text);
             insert into SortSession values ('j','０１２３',1,'0123','JP','MAIN');`);
    db.close();
    const h = hash(file);
    expect(applyNormalization({ databaseUrl: `file:${file}`, apply: true }).mode).toBe("APPLY_NOTHING_TO_DO");
    expect(hash(file)).toBe(h);
  });

  it("planChanges / tableFingerprints are read-only helpers", () => {
    const v = makeDb("helpers");
    const db = new DatabaseSync(v.file, { readOnly: true });
    expect(planChanges(db).toChange).toBe(4);
    expect(Object.keys(tableFingerprints(db))).toContain("SortSession");
    db.close();
  });
});
