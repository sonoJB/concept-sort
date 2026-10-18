import { describe, expect, it } from "vitest";
import { analyzeScope, DEFAULT_CONCEPT_MAP_SETTINGS } from "@/lib/conceptMap/analyze";
import type { Participant } from "@/lib/conceptMap/matrices";
import { DEFAULT_ANALYSIS_PARAMETERS } from "./config";
import { toConceptMapSettings, toDimensionRow } from "./engineAdapter";

const N_ST = 8;
const people = (n: number, noise: number): Participant[] =>
  Array.from({ length: n }, (_, i) => {
    let s = 100 + i;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const raw = Array.from({ length: N_ST }, (_, st) => (rnd() < noise ? Math.floor(rnd() * 2) : Math.floor(st / 4)));
    const m = new Map<number, number>();
    return { pid: `KR-${String(i + 1).padStart(3, "0")}`, country: "KR" as const, assignment: raw.map((g) => (m.has(g) ? m.get(g)! : (m.set(g, m.size), m.size - 1))) };
  });

const FAST = { ...DEFAULT_CONCEPT_MAP_SETTINGS, mds: { ...DEFAULT_CONCEPT_MAP_SETTINGS.mds, dimensions: [1, 2, 3, 9], nInit: 4, maxIter: 2000 }, splitHalf: { repetitions: 5, seed: 1 } };

describe("toConceptMapSettings", () => {
  it("maps the stored parameters one to one and always includes the primary dimension", () => {
    const s = toConceptMapSettings({ ...DEFAULT_ANALYSIS_PARAMETERS, dimensionsEvaluated: [3, 1], primaryMapDimension: 2 });
    expect(s.mds.dimensions).toEqual([1, 2, 3]);
    expect(s.mds.primaryDimension).toBe(2);
    expect(s.mds).toMatchObject({ nInit: 64, maxIter: 10000, eps: 1e-9, strictEps: 1e-12, randomSeed: 42, tieHandling: "secondary" });
    expect(s.splitHalf).toEqual({ repetitions: 1000, seed: 20261018 });
    expect(s.ward).toEqual({ kMin: 2, kMax: 10 });
  });
});

describe("toDimensionRow", () => {
  const a = analyzeScope("KR", people(12, 0.1), N_ST, FAST);
  const by = (d: number) => a.dimensions.find((x) => x.dimension === d)!;

  it("a solved dimension is COMPLETED and keeps the termination reasons, start tally and recomputed metrics", () => {
    const row = toDimensionRow(by(2));
    expect(row.dimensionStatus).toBe("COMPLETED");
    expect(row.errorCode).toBeNull();
    expect(row.coordinates).toHaveLength(N_ST);
    expect(row.commonStressDistance).toBe(by(2).stress1);
    expect(row.commonStressQ).toBe(by(2).stressNormalizedSqrt);
    const meta = row.normalizationMeta as { mainRun: { reason: string }; strictRun: { reason: string }; terminationReasonTally: Record<string, number>; historyKind: string };
    expect(meta.mainRun.reason).toBe(by(2).selected!.main.reason);
    expect(meta.strictRun.reason).toBe(by(2).selected!.strict.reason);
    expect(Object.values(meta.terminationReasonTally).reduce((x, y) => x + y, 0)).toBe(4);
    expect(meta.historyKind).toBe("rawStress");
  });

  it("converged is the strict conjunction of both phases, and an unconverged-but-solved dimension is still COMPLETED (reported, not hidden)", () => {
    const hard = analyzeScope("KR", people(12, 0.1), N_ST, { ...FAST, mds: { ...FAST.mds, dimensions: [2], maxIter: 2, strictMaxIter: 2 } });
    const row = toDimensionRow(hard.dimensions[0]);
    expect(row.dimensionStatus).toBe("COMPLETED");
    expect(row.converged).toBe(false);
    expect((row.normalizationMeta as { mainRun: { reason: string } }).mainRun.reason).toBe("MAX_ITER");
  });

  it("a dimension the engine cannot solve (>= number of statements) is FAILED with the engine's error code and no coordinates", () => {
    const row = toDimensionRow(by(9));
    expect(row.dimensionStatus).toBe("FAILED");
    expect(row.errorCode).toBe("DIMENSION_TOO_HIGH");
    expect(row.coordinates).toBeNull();
    expect(row.converged).toBeNull();
  });
});

describe("official Ward result needs a converged primary solution", () => {
  it("no Ward result, pair diagnostics or cluster solutions exist when the primary 2D solution did not converge", () => {
    const hard = analyzeScope("KR", people(12, 0.1), N_ST, { ...FAST, mds: { ...FAST.mds, dimensions: [2], maxIter: 2, strictMaxIter: 2 } });
    expect(hard.primary.numericallyConverged).toBe(false);
    expect(hard.ward).toBeNull();
    expect(hard.pairDiagnostics).toBeNull();
    expect(hard.solutions).toEqual([]);
  });

  it("with a converged primary solution Ward uses exactly the stored 2D coordinates (n-1 merges)", () => {
    const ok = analyzeScope("KR", people(12, 0.1), N_ST, { ...FAST, mds: { ...FAST.mds, dimensions: [2] } });
    expect(ok.primary.numericallyConverged).toBe(true);
    expect(ok.ward!.linkage).toHaveLength(N_ST - 1);
    expect(ok.ward!.sourceDimension).toBe(2);
  });
});
