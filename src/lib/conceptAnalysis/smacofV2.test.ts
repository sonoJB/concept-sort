import { describe, expect, it } from "vitest";
import { evaluateConfiguration, runSmacofV2, shepardData, randomStart, configurationToFlat, type SmacofV2Settings } from "./smacofV2";
import { mulberry32, uniform } from "./prng";
import type { Matrix } from "./types";

/** A noisy-but-ordinal 2D structure: distances of random planar points, monotonically distorted, plus rank noise. */
function synthetic(n: number, seed: number) {
  const rng = mulberry32(seed);
  const pts = Array.from({ length: n }, () => [uniform(rng, -1, 1), uniform(rng, -1, 1)]);
  const d: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  const w: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const e = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      // quantised to few levels like a co-occurrence frequency (ties) with noise
      const q = Math.round((e / 2.9 + uniform(rng, -0.08, 0.08)) * 12) / 12;
      d[i][j] = d[j][i] = Math.min(1, Math.max(0, q));
      w[i][j] = w[j][i] = 1;
    }
  return { d, w, pts };
}

const SET: SmacofV2Settings = { dimension: 2, nInit: 8, maxIter: 5000, eps: 1e-9, strictEps: 1e-12, strictMaxIter: 20000, randomSeed: 7, tieHandling: "secondary" };

describe("smacofV2", () => {
  const { d, w } = synthetic(24, 3);

  it("returns coordinates whose recomputed metrics equal the returned evaluation (no cross-iteration mixing)", () => {
    const r = runSmacofV2(d, w, SET);
    expect(r.coordinates).not.toBeNull();
    const ev = evaluateConfiguration(r.coordinates!, d, w);
    expect(ev.rawStress).toBeCloseTo(r.evaluation!.rawStress, 12);
    expect(ev.stress1).toBeCloseTo(r.evaluation!.stress1, 12);
    expect(ev.rsq).toBeCloseTo(r.evaluation!.rsq, 12);
    // the last traced raw stress is the stress of the returned configuration
    expect(r.trace!.rawStress[r.trace!.rawStress.length - 1]).toBeCloseTo(ev.rawStress, 10);
  });

  it("raw stress never increases during majorization (beyond rounding) for every start", () => {
    const r = runSmacofV2(d, w, { ...SET, nInit: 4 });
    expect(r.starts.every((s) => s.maxRelativeIncrease < 1e-9)).toBe(true);
    const t = r.trace!.rawStress;
    for (let k = 1; k < t.length; k++) expect(t[k]).toBeLessThanOrEqual(t[k - 1] * (1 + 1e-9));
  });

  it("does not fail a start only because Stress-1 temporarily rises while raw stress falls (v1 defect)", () => {
    const r = runSmacofV2(d, w, SET);
    expect(r.starts.some((s) => s.reason === "CONVERGED")).toBe(true);
    expect(r.starts.every((s) => s.reason !== "OBJECTIVE_INCREASED")).toBe(true);
  });

  it("at a converged solution Kruskal Stress-1 equals sqrt(raw/q) (JSS eq. 4) and the v1 definition differs", () => {
    const r = runSmacofV2(d, w, SET);
    const ev = r.evaluation!;
    expect(Math.abs(ev.stress1 - ev.stressNormalizedSqrt)).toBeLessThan(1e-6);
    expect(ev.stress1V1Definition).toBeGreaterThan(ev.stress1);
  });

  it("MAX_ITER is reported as such and is never eligible as converged", () => {
    const r = runSmacofV2(d, w, { ...SET, maxIter: 3, nInit: 3, strictMaxIter: 3 });
    expect(r.starts.every((s) => s.reason === "MAX_ITER")).toBe(true);
    expect(r.convergedCount).toBe(0);
    expect(r.selectionStatus).toBe("NO_CONVERGED_CANDIDATE");
    expect(r.selected!.strict.reason).toBe("MAX_ITER");
  });

  it("selects the lowest raw stress among converged starts only", () => {
    const r = runSmacofV2(d, w, { ...SET, nInit: 12 });
    const conv = r.starts.filter((s) => s.reason === "CONVERGED");
    const min = Math.min(...conv.map((s) => s.rawStress));
    expect(r.selected!.main.rawStress).toBe(min);
  });

  it("is deterministic for a fixed seed and differs across seeds", () => {
    const a = runSmacofV2(d, w, SET);
    const b = runSmacofV2(d, w, SET);
    expect(a.evaluation!.rawStress).toBe(b.evaluation!.rawStress);
    expect(a.selected!.seed).toBe(b.selected!.seed);
    expect(randomStart(5, 2, 1)).not.toEqual(randomStart(5, 2, 2));
  });

  it("strict continuation never makes the objective worse and reports its own iteration count", () => {
    const r = runSmacofV2(d, w, SET);
    expect(r.selected!.strict.rawStress).toBeLessThanOrEqual(r.selected!.main.rawStress * (1 + 1e-12));
    expect(r.selected!.strict.iterations).toBeGreaterThanOrEqual(0);
    expect(r.selected!.strict.reason).toBe("CONVERGED");
    expect(r.selected!.strict.finalRelativeChange!).toBeLessThanOrEqual(1e-12);
  });

  it("Stress-1 and RSQ are invariant to rotation/reflection/translation/uniform scaling; raw stress to rotation/reflection/translation only", () => {
    const r = runSmacofV2(d, w, SET);
    const th = 0.7;
    const rigid = r.coordinates!.map(([x, y]) => [Math.cos(th) * x - Math.sin(th) * -y + 5, Math.sin(th) * x + Math.cos(th) * -y - 2]);
    const scaled = r.coordinates!.map(([x, y]) => [3 * x, 3 * y]);
    const a = evaluateConfiguration(r.coordinates!, d, w);
    const b = evaluateConfiguration(rigid, d, w);
    const c = evaluateConfiguration(scaled, d, w);
    expect(b.stress1).toBeCloseTo(a.stress1, 10);
    expect(b.rsq).toBeCloseTo(a.rsq, 10);
    expect(b.rawStress).toBeCloseTo(a.rawStress, 8);
    expect(c.stress1).toBeCloseTo(a.stress1, 10);
    expect(c.rsq).toBeCloseTo(a.rsq, 10);
    // disparities are normalised to a fixed norm, so raw stress is NOT scale-invariant (by design)
    expect(Math.abs(c.rawStress - a.rawStress)).toBeGreaterThan(1);
  });

  it("shepard data has one row per pair and distances/disparities consistent with the evaluation", () => {
    const r = runSmacofV2(d, w, SET);
    const s = shepardData(r.coordinates!, d, w);
    expect(s.pairs).toBe((24 * 23) / 2);
    let raw = 0;
    for (let k = 0; k < s.pairs; k++) raw += (s.disparity[k] - s.distance[k]) ** 2;
    expect(raw).toBeCloseTo(r.evaluation!.rawStress, 8);
  });

  it("rejects impossible inputs without a result", () => {
    expect(runSmacofV2([[0]], [[0]], SET).errorCode).toBe("INSUFFICIENT_ITEMS");
    const z: Matrix = [[0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
    const zero: Matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    expect(runSmacofV2(z, zero, SET).errorCode).toBe("NO_WEIGHTED_PAIRS");
    expect(runSmacofV2(z, z.map((r) => r.map((v) => (v ? 1 : 0))), { ...SET, dimension: 3 }).errorCode).toBe("DIMENSION_TOO_HIGH");
  });

  it("configurationToFlat round-trips", () => {
    const f = configurationToFlat([[1, 2], [3, 4]]);
    expect(Array.from(f.flat)).toEqual([1, 2, 3, 4]);
  });
});
