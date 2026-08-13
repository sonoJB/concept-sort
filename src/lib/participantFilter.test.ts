import { describe, it, expect } from "vitest";
import { filterByDataRole } from "./participantFilter";

const rows = [
  { id: "1", dataRole: "MAIN" },
  { id: "2", dataRole: "PILOT" },
  { id: "3", dataRole: "MAIN" },
  { id: "4", dataRole: "PILOT" },
  { id: "5", dataRole: "PILOT" },
];

describe("filterByDataRole — shared by 본조사/파일럿/전체 CSV export and the admin table filter", () => {
  it("(16) 'MAIN' returns only MAIN rows — this is what the 본조사 참가자 CSV button downloads by default", () => {
    const result = filterByDataRole(rows, "MAIN");
    expect(result.map((r) => r.id)).toEqual(["1", "3"]);
    expect(result.every((r) => r.dataRole === "MAIN")).toBe(true);
  });

  it("(17) 'PILOT' returns only PILOT rows — this is what the 파일럿 참가자 CSV button downloads", () => {
    const result = filterByDataRole(rows, "PILOT");
    expect(result.map((r) => r.id)).toEqual(["2", "4", "5"]);
    expect(result.every((r) => r.dataRole === "PILOT")).toBe(true);
  });

  it("'ALL' returns every row unfiltered", () => {
    expect(filterByDataRole(rows, "ALL")).toEqual(rows);
  });

  it("MAIN and PILOT results are always disjoint and together reconstruct ALL", () => {
    const main = filterByDataRole(rows, "MAIN");
    const pilot = filterByDataRole(rows, "PILOT");
    const combinedIds = [...main, ...pilot].map((r) => r.id).sort();
    expect(combinedIds).toEqual(rows.map((r) => r.id).sort());
  });
});
