import { describe, expect, it } from "vitest";
import { csvCell, toCsvText } from "./csv";
import { buildSolution, cutTree } from "./clusters";
import { attachNaming } from "./bundle";
import { SCOPE_PROPOSALS } from "./proposals";
import { wardHierarchicalClustering } from "../conceptAnalysis";
import type { ScopeAnalysis } from "./analyze";

/** minimal RFC-4180 reader for the round trip */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") continue;
    else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  return rows;
}

describe("CSV downloads (replaces the old CSV escaping test)", () => {
  it("round-trips commas, quotes, newlines, Korean, Japanese and an XSS marker as inert text", () => {
    const rows = [
      ["문항", "한국어", "日本語", "메모"],
      ["S01", 'SNS는 "집단적" 폭력, 쉽게', "SNSでは、複数の加害者が", "줄\n바꿈"],
      ["S02", "<script>alert(1)</script>", "=HYPERLINK(\"x\")", ""],
    ];
    const text = toCsvText(rows);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("\r\n");
    expect(parseCsv(text)).toEqual(rows.map((r) => r.map(String)));
  });
  it("null and undefined become empty cells, numbers keep their text form", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0.30251613698)).toBe("0.30251613698");
  });
});

describe("cluster cut limits and centroids (replaces clusterCut tests)", () => {
  const pts = [[0, 0], [0.1, 0], [5, 5], [5.1, 5], [10, 0], [10.1, 0.1]];
  const w = wardHierarchicalClustering(pts);
  const D = pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
  it("rejects k < 1 and k > number of statements, accepts k = n", () => {
    expect(() => cutTree(w.linkage, 6, 0)).toThrow();
    expect(() => cutTree(w.linkage, 6, 7)).toThrow();
    expect(new Set(cutTree(w.linkage, 6, 6)).size).toBe(6);
    expect(new Set(cutTree(w.linkage, 6, 1)).size).toBe(1);
  });
  it("every statement gets exactly one cluster and the result is deterministic", () => {
    const a = buildSolution(pts, D, w.linkage, 3);
    const b = buildSolution(pts, D, w.linkage, 3);
    expect(a).toEqual(b);
    expect(a.labels.every((l) => l >= 1 && l <= 3)).toBe(true);
    expect(a.clusters.reduce((s, c) => s + c.size, 0)).toBe(6);
  });
  it("cluster centroids are the arithmetic mean of the member coordinates", () => {
    const s = buildSolution(pts, D, w.linkage, 3);
    for (const c of s.clusters) {
      const mean = [0, 1].map((d) => c.members.reduce((acc, i) => acc + pts[i][d], 0) / c.size);
      expect(c.centroid[0]).toBeCloseTo(mean[0], 12);
      expect(c.centroid[1]).toBeCloseTo(mean[1], 12);
    }
  });
});

describe("naming proposals attach only to the solution they were written for and stay automated proposals", () => {
  const prop = SCOPE_PROPOSALS.JP!;
  const fake = (signature: string): ScopeAnalysis => ({ solutions: [{ k: prop.solution.k, signature }] } as unknown as ScopeAnalysis);
  it("a matching membership signature attaches the proposal with its AUTO_PROPOSED status", () => {
    const r = attachNaming("JP", fake(prop.solution.signature));
    expect(r.status).toBe("ATTACHED");
    if (r.status === "ATTACHED") expect(r.proposal.reviewStatus).toBe("AUTO_PROPOSED");
  });
  it("a different membership (changed analysis) never inherits the names", () => {
    expect(attachNaming("JP", fake("1,1,1")).status).toBe("SIGNATURE_MISMATCH");
    expect(attachNaming("JP", { solutions: [] } as unknown as ScopeAnalysis).status).toBe("SIGNATURE_MISMATCH");
  });
  it("every registered proposal is an automated proposal (none is marked researcher-reviewed or finalized)", () => {
    for (const p of Object.values(SCOPE_PROPOSALS)) expect(p!.reviewStatus).toBe("AUTO_PROPOSED");
  });
});
