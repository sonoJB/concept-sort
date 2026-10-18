/**
 * Reproduces and quantifies the defects in the ORIGINAL (v1) MDS loop on the real 본조사 inputs.
 * Runs the original engine as shipped (runSmacof) with the deployed budget (8 inits / 300 iterations) and with a
 * larger budget, and replays the original loop with BOTH raw stress and Stress-1 logged per iteration.
 */
import {
  runSmacof,
  euclideanDistanceMatrix,
  isotonicRegressionByRank,
  normalizeDisparities,
  upperTrianglePairs,
  computeRawStress,
  computeNormalizedStress1,
  matMul,
  symmetricPseudoInverse,
  mulberry32,
  uniform,
  deriveSeed,
  type Matrix,
  type Point,
} from "../../src/lib/conceptAnalysis";
import { loadScopeInputs, type ScopeInputs } from "./inputs";

const db = process.argv[2];
const out: Record<string, unknown> = {};

function center(p: Point[]): Point[] {
  const n = p.length;
  const d = p[0].length;
  const m = new Array(d).fill(0);
  for (const r of p) for (let k = 0; k < d; k++) m[k] += r[k] / n;
  return p.map((r) => r.map((v, k) => v - m[k]));
}

/** Faithful replay of the v1 per-iteration quantities (same functions, same order) for one random start. */
function replay(inp: ScopeInputs, dim: number, seed: number, maxIter: number) {
  const n = inp.dissimilarity.length;
  const rng = mulberry32(seed);
  let pts = center(Array.from({ length: n }, () => Array.from({ length: dim }, () => uniform(rng, -1, 1))));
  const V: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        V[i][j] = -inp.weight[i][j];
        s += inp.weight[i][j];
      }
    }
    V[i][i] = s;
  }
  const Vp = symmetricPseudoInverse(V);
  const rows: { it: number; raw: number; s1: number; sumD2: number }[] = [];
  for (let it = 1; it <= maxIter; it++) {
    const D = euclideanDistanceMatrix(pts);
    const pairs = upperTrianglePairs(n);
    const fit = isotonicRegressionByRank(pairs.map(({ i, j }) => ({ rankKey: inp.dissimilarity[i][j], value: D[i][j], weight: 1 })));
    const raw: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    pairs.forEach(({ i, j }, k) => {
      raw[i][j] = fit[k];
      raw[j][i] = fit[k];
    });
    const dh = normalizeDisparities(raw, inp.weight, n).normalizedDisparities;
    const rs = computeRawStress(dh, D, inp.weight);
    const s1 = computeNormalizedStress1(dh, D, inp.weight);
    let sumD2 = 0;
    for (const { i, j } of pairs) sumD2 += D[i][j] ** 2;
    rows.push({ it, raw: rs, s1, sumD2 });
    const B: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const v = D[i][j] > 0 ? -dh[i][j] / D[i][j] : 0;
        B[i][j] = v;
        r += v;
      }
      B[i][i] = -r;
    }
    pts = center(matMul(Vp, matMul(B, pts)) as Point[]);
  }
  return rows;
}

for (const scope of ["KR", "JP", "ALL"] as const) {
  const inp = loadScopeInputs(db, scope);
  const res: Record<string, unknown> = { N: inp.n, nKr: inp.nKr, nJp: inp.nJp, statements: inp.statementCount };
  const budgets: [string, number, number][] = [
    ["v1 as deployed (8 inits, 300 it)", 8, 300],
    ["v1 engine, 64 inits, 3000 it", 64, 3000],
  ];
  for (const [label, nInit, maxIter] of budgets) {
    const r = runSmacof(inp.dissimilarity, inp.weight, {
      algorithm: "SMACOF",
      metric: false,
      dimension: 2,
      normalizedStress: true,
      randomSeed: 42,
      nInit,
      maxIter,
      eps: 1e-9,
      tieHandling: "secondary",
    });
    const tally: Record<string, number> = {};
    for (const i of r.inits) {
      const k = i.errorCode ?? (i.converged ? "CONVERGED" : "MAX_ITER_NOT_CONVERGED");
      tally[k] = (tally[k] ?? 0) + 1;
    }
    const best = r.inits[r.bestInitIndex ?? 0];
    res[label] = {
      initOutcomes: tally,
      selected: {
        initIndex: r.bestInitIndex,
        converged: r.converged,
        errorCodeOfSelectedInit: best?.errorCode ?? null,
        iterations: best?.iterations,
        rawStress: r.rawStress,
        stress1: r.normalizedStress1,
      },
      runLevelErrorCodeVisible: r.errorCode ?? null,
      selectedIsNonConverged: r.converged === false,
      lowestFive: r.inits
        .filter((x) => Number.isFinite(x.normalizedStress1))
        .map((x) => ({ i: x.initIndex, s1: +x.normalizedStress1.toFixed(5), it: x.iterations, conv: x.converged, err: x.errorCode ?? null }))
        .sort((a, b) => a.s1 - b.s1)
        .slice(0, 5),
    };
  }
  let example: unknown = null;
  for (let k = 0; k < 64 && !example; k++) {
    const seed = deriveSeed(42, k);
    const rows = replay(inp, 2, seed, 60);
    for (let t = 1; t < rows.length; t++) {
      if (rows[t].s1 > rows[t - 1].s1 + 1e-7) {
        example = {
          seed,
          initIndex: k,
          v1FlagsStressIncreasedAtIteration: rows[t].it,
          window: rows.slice(Math.max(0, t - 2), t + 2).map((r) => ({ it: r.it, rawStress: +r.raw.toFixed(6), stress1: +r.s1.toFixed(6), sumD2: +r.sumD2.toFixed(4) })),
          rawStressDecreasedAtThatStep: rows[t].raw < rows[t - 1].raw,
        };
        break;
      }
    }
  }
  res["replay_stress1_up_while_raw_down"] = example;
  out[scope] = res;
}
console.log(JSON.stringify(out, null, 1));
