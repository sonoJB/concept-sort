import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "AdminDashboard.tsx"), "utf8");

describe("AdminDashboard — obsolete mandatory-numbering wording is gone", () => {
  it("no longer instructs admins to type numbering into statement bodies", () => {
    expect(source).not.toMatch(/번호\(1\.,\s*2\.,\s*\.\.\.\)도/);
    expect(source).not.toContain("진술문\n본문에 직접 포함해 주세요");
  });

  it("no longer imports the removed statementNumbering module", () => {
    expect(source).not.toContain("statementNumbering");
    expect(source).not.toContain("validateNumberedLines");
  });

  it("uses the current unnumbered bulk-entry wording", () => {
    expect(source).toContain("한국어 진술문을 순서대로 한 줄에 하나씩 입력해 주세요.");
  });
});
