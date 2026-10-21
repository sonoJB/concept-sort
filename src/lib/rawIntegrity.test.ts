import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_DIR_PATTERN, compareFingerprints, fingerprintTable, fingerprintTables } from "./rawIntegrity";

function db(rows: [string, string, number][]) {
  const d = new DatabaseSync(":memory:");
  d.exec('create table "SortSession" (id text primary key, name text, age integer)');
  d.exec('create table "Statement" (id text primary key, text text)');
  const ins = d.prepare('insert into "SortSession" values (?,?,?)');
  for (const r of rows) ins.run(...r);
  return d;
}

describe("raw integrity fingerprints", () => {
  const base: [string, string, number][] = [["a", "n1", 20], ["b", "n2", 21]];
  it("is identical for the same content regardless of insertion order", () => {
    const x = fingerprintTable(db(base), "SortSession");
    const y = fingerprintTable(db([...base].reverse()), "SortSession");
    expect(compareFingerprints("SortSession", x, y)).toMatchObject({ identical: true, sameColumns: true, differingColumns: [] });
  });
  it("detects a single changed value and names only the column", () => {
    const changed = fingerprintTable(db([["a", "n1", 20], ["b", "n2", 22]]), "SortSession");
    const c = compareFingerprints("SortSession", fingerprintTable(db(base), "SortSession"), changed);
    expect(c.identical).toBe(false);
    expect(c.differingColumns).toEqual(["age"]);
    expect(c.rowsA).toBe(2);
  });
  it("detects a removed row and reports a missing table", () => {
    const c = compareFingerprints("SortSession", fingerprintTable(db(base), "SortSession"), fingerprintTable(db(base.slice(0, 1)), "SortSession"));
    expect(c.identical).toBe(false);
    expect(fingerprintTables(db(base), ["SortSession", "Nope"]).Nope).toBeNull();
  });
  it("contains no row values in the fingerprint", () => {
    expect(JSON.stringify(fingerprintTable(db(base), "SortSession"))).not.toContain("n1");
  });
  it("accepts only plain backup folder names", () => {
    expect(BACKUP_DIR_PATTERN.test("20261020T153710Z_pre-package-pipeline")).toBe(true);
    for (const bad of ["../x", "a/b", "a\b", "", ".hidden", "a b"]) expect(BACKUP_DIR_PATTERN.test(bad)).toBe(false);
  });
});
