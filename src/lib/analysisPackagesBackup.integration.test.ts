import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain-JS Node script (no type declarations)
import { createBackup, verifyBackupDir } from "../../scripts/backup/auto-backup.mjs";
// @ts-expect-error plain-JS Node script (no type declarations)
import { restorePackages, checkPackages } from "../../scripts/backup/restore-tool.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-pkgbackup-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** A volume with a database that has an AnalysisPackage table and N package files named by their SHA-256. */
function volume(name: string, packages: Buffer[]) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "analysis-packages"), { recursive: true });
  const file = path.join(dir, "prod.db");
  const db = new DatabaseSync(file);
  db.exec(`create table _prisma_migrations (id text, checksum text, finished_at integer, migration_name text, logs text, rolled_back_at integer, started_at integer, applied_steps_count integer);
           insert into _prisma_migrations values ('0','x',1,'20260101_init',null,null,1,1);
           create table Project (id text primary key, slug text); insert into Project values ('p','s');
           create table AnalysisPackage (id text primary key, scope text, filename text, sha256 text, byteSize integer, storedFile text, analysisRunId text);`);
  packages.forEach((b, i) => {
    const h = sha(b);
    fs.writeFileSync(path.join(dir, "analysis-packages", `${h}.zip`), b);
    db.prepare("insert into AnalysisPackage values (?,?,?,?,?,?,?)").run(`pk${i}`, ["KR", "JP", "ALL"][i], `${i}.zip`, h, b.length, `${h}.zip`, `run${i}`);
  });
  db.close();
  return { dir, file, pkgDir: path.join(dir, "analysis-packages") };
}
const zips = [Buffer.from("PK-KR-content"), Buffer.from("PK-JP-content"), Buffer.from("PK-ALL-content")];

describe("analysis packages travel with the database backup", () => {
  it("a backup keeps every package (manifest lists name, size, SHA-256) and verifies as a whole", () => {
    const v = volume("t1", zips);
    const r = createBackup({ reason: "pre-deploy", databaseUrl: `file:${v.file}`, now: new Date("2026-10-18T10:00:00Z") });
    expect(r.result).toBe("OK");
    expect(r.manifest.analysisPackages.map((p: { sha256: string }) => p.sha256).sort()).toEqual(zips.map(sha).sort());
    for (const z of zips) expect(sha(fs.readFileSync(path.join(r.dirPath, "analysis-packages", `${sha(z)}.zip`)))).toBe(sha(z));
    expect(verifyBackupDir(r.dirPath).ok).toBe(true);
  });

  it("removing a live package file later (e.g. replacing a result) does not remove it from earlier backups", () => {
    const v = volume("t2", zips);
    const r = createBackup({ reason: "pre-deploy", databaseUrl: `file:${v.file}`, now: new Date("2026-10-18T10:00:00Z") });
    fs.rmSync(path.join(v.pkgDir, `${sha(zips[0])}.zip`));
    expect(fs.existsSync(path.join(r.dirPath, "analysis-packages", `${sha(zips[0])}.zip`))).toBe(true);
    expect(verifyBackupDir(r.dirPath).ok).toBe(true);
  });

  it("a damaged or missing package inside a backup is reported by verification", () => {
    const v = volume("t3", zips);
    const r = createBackup({ reason: "pre-deploy", databaseUrl: `file:${v.file}`, now: new Date("2026-10-18T10:00:00Z") });
    const f = path.join(r.dirPath, "analysis-packages", `${sha(zips[1])}.zip`);
    fs.chmodSync(f, 0o666);
    fs.rmSync(f); // removing the backup's link must not corrupt the live file
    expect(fs.existsSync(path.join(v.pkgDir, `${sha(zips[1])}.zip`))).toBe(true);
    let check = verifyBackupDir(r.dirPath);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toContain("is missing from the backup");
    fs.writeFileSync(f, "tampered");
    check = verifyBackupDir(r.dirPath);
    expect(check.problems.join(" ")).toContain("does not match its recorded SHA-256");
  });

  it("refuses to back up a package file whose name does not match its content hash", () => {
    const v = volume("t4", zips);
    fs.writeFileSync(path.join(v.pkgDir, `${"a".repeat(64)}.zip`), "not what the name says");
    const r = createBackup({ reason: "pre-deploy", databaseUrl: `file:${v.file}`, now: new Date("2026-10-18T10:00:00Z") });
    expect(r.result).toBe("FAILED");
    expect(r.error).toContain("does not match its own SHA-256");
  });
});

describe("restoring packages after a database replacement", () => {
  it("copies packages back from a backup (write-once), leaves identical files alone and verifies every row", () => {
    const v = volume("r1", zips);
    const b = createBackup({ reason: "pre-deploy", databaseUrl: `file:${v.file}`, now: new Date("2026-10-18T10:00:00Z") });
    // simulate a fresh volume holding only the restored database: packages directory is gone
    fs.rmSync(v.pkgDir, { recursive: true, force: true });
    expect(checkPackages({ dbPath: v.file }).ok).toBe(false);
    expect(checkPackages({ dbPath: v.file }).problems).toHaveLength(3);
    const dry = restorePackages({ dbPath: v.file, from: b.dirPath, dryRun: true });
    expect(dry.restored).toHaveLength(3);
    expect(fs.existsSync(v.pkgDir)).toBe(false); // dry run changes nothing
    const done = restorePackages({ dbPath: v.file, from: b.dirPath });
    expect(done.restored).toHaveLength(3);
    expect(done.check.ok).toBe(true);
    const again = restorePackages({ dbPath: v.file, from: b.dirPath });
    expect(again.restored).toHaveLength(0);
    expect(again.identical).toHaveLength(3);
  });

  it("refuses to overwrite a same-named file with different content and reports rows whose file is missing", () => {
    const v = volume("r2", zips);
    const b = createBackup({ reason: "pre-deploy", databaseUrl: `file:${v.file}`, now: new Date("2026-10-18T10:00:00Z") });
    const name = `${sha(zips[2])}.zip`;
    fs.rmSync(path.join(v.pkgDir, name));
    fs.writeFileSync(path.join(v.pkgDir, name), "different"); // a new file under the same name (never an in-place edit)
    expect(() => restorePackages({ dbPath: v.file, from: b.dirPath })).toThrow(/refusing to overwrite/);
    expect(checkPackages({ dbPath: v.file }).problems[0].problem).toContain("SHA-256");
    fs.rmSync(path.join(v.pkgDir, name));
    fs.rmSync(path.join(b.dirPath, "analysis-packages", name), { force: true });
    const r = restorePackages({ dbPath: v.file, from: b.dirPath });
    expect(r.check.ok).toBe(false);
    expect(r.check.problems.map((p: { problem: string }) => p.problem).join(" ")).toContain("regenerate");
  });
});
