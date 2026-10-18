/**
 * Nonmetric SMACOF (v2). Replaces the v1 loop's convergence/selection logic; the model itself
 * (ordinal MDS, tie handling "secondary", explicit disparity normalisation sum w*dhat^2 = n(n-1)/2,
 * Guttman transform) is unchanged. What changed and why (see docs/mds-reanalysis for evidence):
 *
 *  1. The objective that majorization decreases monotonically is the RAW stress
 *       sigma(X) = sum_{i<j} w_ij (dhat_ij(X) - d_ij(X))^2,   dhat normalised to sum w dhat^2 = n(n-1)/2.
 *     v1 monitored Stress-1 (= sqrt(sigma / sum w d^2)) whose denominator changes with the configuration's
 *     scale, so it can rise while sigma falls; v1 treated that as an error (STRESS_INCREASED) and stopped.
 *  2. Convergence = relative decrease of the raw stress, (sigma_{k-1} - sigma_k) / sigma_{k-1} <= eps.
 *     Reaching maxIter is MAX_ITER, a raw-stress INCREASE beyond rounding (> 1e-9 relative) is
 *     OBJECTIVE_INCREASED; these are distinct, explicit termination reasons.
 *  3. Every returned number (raw stress, Stress-1, RSQ, ...) is recomputed from the RETURNED coordinates by
 *     evaluateConfiguration(); nothing is carried over from a different iteration.
 *  4. Only starts that CONVERGED are eligible; the one with the lowest raw stress is selected, then continued
 *     with a stricter tolerance. If none converged this is reported as such, never as a converged result.
 *
 * "Best of nInit starts" is not a proof of a global minimum.
 */
import { deriveSeed, mulberry32, uniform } from "./prng";
import { symmetricPseudoInverse } from "./linalg";
import type { Matrix, Point, WeightMatrix } from "./types";

export type TieHandling = "secondary" | "primary";

export type TerminationReason =
  | "CONVERGED"
  | "MAX_ITER"
  | "OBJECTIVE_INCREASED"
  | "NON_FINITE"
  | "DEGENERATE_CONFIGURATION"
  | "ZERO_DISPARITY_NORM";

export type SmacofV2Settings = {
  dimension: number;
  nInit: number;
  maxIter: number;
  /** Relative raw-stress decrease at/below which a start counts as converged. */
  eps: number;
  /** Tolerance for the follow-up run from the selected solution. */
  strictEps: number;
  strictMaxIter: number;
  randomSeed: number;
  tieHandling: TieHandling;
};

export type Evaluation = {
  rawStress: number;
  /** Kruskal (1964) Stress-1: sqrt( sum w (dhatStar - d)^2 / sum w d^2 ), dhatStar = isotonic regression of d on delta (not rescaled). Scale-free. */
  stress1: number;
  /** sqrt( rawStress / (n(n-1)/2) ): smacof's normalised stress (sigma_n)^(1/2); equals stress1 at a stationary point (Mair et al. 2022, eq. 4). */
  stressNormalizedSqrt: number;
  /** sqrt( rawStress / sum w d^2 ) with the NORMALISED disparities: the previous implementation's value and scikit-learn's normalized_stress. A valid but different definition, always >= the Kruskal value at the same coordinates; reported alongside. */
  stress1V1Definition: number;
  /** Squared Pearson correlation between disparities and configuration distances (same active pairs). */
  rsq: number;
  pairCount: number;
  sumDistSq: number;
  sumDispSq: number;
  /** numerator of Kruskal Stress-1: sum w (dhatStar - d)^2 with the UNNORMALISED monotone-regression disparities */
  kruskalNumerator: number;
  /** smallest inter-point distance in the configuration (0 means two items coincide). */
  minPairDistance: number;
};

type PairSet = {
  n: number;
  m: number;
  i: Int32Array;
  j: Int32Array;
  w: Float64Array;
  delta: Float64Array;
  /** pair indices ascending by delta (stable). */
  order: Int32Array;
  /** tie-group boundaries in `order`: group g covers order[start[g] .. start[g+1]) */
  groupStart: Int32Array;
  q: number;
};

const TIE_EPS = 1e-9;

function buildPairSet(dissimilarity: Matrix, weight: WeightMatrix): PairSet {
  const n = dissimilarity.length;
  const I: number[] = [];
  const J: number[] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (weight[a][b] > 0) {
        I.push(a);
        J.push(b);
      }
  const m = I.length;
  const i = Int32Array.from(I);
  const j = Int32Array.from(J);
  const w = new Float64Array(m);
  const delta = new Float64Array(m);
  for (let p = 0; p < m; p++) {
    w[p] = weight[i[p]][j[p]];
    delta[p] = dissimilarity[i[p]][j[p]];
  }
  const idx = Array.from({ length: m }, (_, p) => p).sort((a, b) => delta[a] - delta[b] || a - b);
  const order = Int32Array.from(idx);
  const starts: number[] = [0];
  for (let k = 1; k < m; k++) if (Math.abs(delta[order[k]] - delta[order[k - 1]]) > TIE_EPS) starts.push(k);
  starts.push(m);
  return { n, m, i, j, w, delta, order, groupStart: Int32Array.from(starts), q: (n * (n - 1)) / 2 };
}

function pairDistances(points: Float64Array, dim: number, ps: PairSet, out: Float64Array): void {
  for (let p = 0; p < ps.m; p++) {
    let s = 0;
    const a = ps.i[p] * dim;
    const b = ps.j[p] * dim;
    for (let k = 0; k < dim; k++) {
      const df = points[a + k] - points[b + k];
      s += df * df;
    }
    out[p] = Math.sqrt(s);
  }
}

/** Weighted PAVA over blocks (ascending). Returns fitted block values. */
function pava(values: Float64Array, weights: Float64Array, count: number, outFit: Float64Array): void {
  const bv = new Float64Array(count);
  const bw = new Float64Array(count);
  const bs = new Int32Array(count);
  let top = 0;
  for (let g = 0; g < count; g++) {
    bv[top] = values[g];
    bw[top] = weights[g];
    bs[top] = 1;
    top++;
    while (top > 1 && bv[top - 2] > bv[top - 1]) {
      const w = bw[top - 2] + bw[top - 1];
      bv[top - 2] = w > 0 ? (bv[top - 2] * bw[top - 2] + bv[top - 1] * bw[top - 1]) / w : bv[top - 2];
      bw[top - 2] = w;
      bs[top - 2] += bs[top - 1];
      top--;
    }
  }
  let pos = 0;
  for (let b = 0; b < top; b++) for (let c = 0; c < bs[b]; c++) outFit[pos++] = bv[b];
}

/** Monotone (isotonic) regression of the distances on delta with the requested tie handling. Output per pair, unnormalised. */
function fitDisparities(ps: PairSet, dist: Float64Array, tie: TieHandling, out: Float64Array): void {
  const { order, groupStart, w } = ps;
  if (tie === "secondary") {
    const gCount = groupStart.length - 1;
    const gv = new Float64Array(gCount);
    const gw = new Float64Array(gCount);
    for (let g = 0; g < gCount; g++) {
      let sw = 0;
      let sv = 0;
      for (let k = groupStart[g]; k < groupStart[g + 1]; k++) {
        const p = order[k];
        sw += w[p];
        sv += w[p] * dist[p];
      }
      gw[g] = sw;
      gv[g] = sw > 0 ? sv / sw : 0;
    }
    const fit = new Float64Array(gCount);
    // PAVA on groups, then expand: a group's block mean is its fitted value
    const expanded = new Float64Array(gCount);
    pava(gv, gw, gCount, expanded);
    void fit;
    for (let g = 0; g < gCount; g++) for (let k = groupStart[g]; k < groupStart[g + 1]; k++) out[order[k]] = expanded[g];
    return;
  }
  // primary ("break ties"): within a tie block order by the current distance, then plain PAVA over pairs
  const m = ps.m;
  const idx = Array.from(order);
  const gCount = groupStart.length - 1;
  for (let g = 0; g < gCount; g++) {
    const slice = idx.slice(groupStart[g], groupStart[g + 1]).sort((a, b) => dist[a] - dist[b]);
    for (let k = 0; k < slice.length; k++) idx[groupStart[g] + k] = slice[k];
  }
  const v = new Float64Array(m);
  const ww = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    v[k] = dist[idx[k]];
    ww[k] = w[idx[k]];
  }
  const fitted = new Float64Array(m);
  pava(v, ww, m, fitted);
  for (let k = 0; k < m; k++) out[idx[k]] = fitted[k];
}

export function configurationToFlat(points: Point[]): { flat: Float64Array; n: number; dim: number } {
  const n = points.length;
  const dim = points[0].length;
  const flat = new Float64Array(n * dim);
  for (let a = 0; a < n; a++) for (let k = 0; k < dim; k++) flat[a * dim + k] = points[a][k];
  return { flat, n, dim };
}

function flatToPoints(flat: Float64Array, n: number, dim: number): Point[] {
  return Array.from({ length: n }, (_, a) => Array.from({ length: dim }, (_, k) => flat[a * dim + k]));
}

function center(flat: Float64Array, n: number, dim: number): void {
  for (let k = 0; k < dim; k++) {
    let mean = 0;
    for (let a = 0; a < n; a++) mean += flat[a * dim + k];
    mean /= n;
    for (let a = 0; a < n; a++) flat[a * dim + k] -= mean;
  }
}

type IterState = {
  dist: Float64Array;
  /** normalised disparities */
  disp: Float64Array;
  rawStress: number;
  error?: TerminationReason;
};

function evaluateState(ps: PairSet, flat: Float64Array, dim: number, tie: TieHandling): IterState {
  const dist = new Float64Array(ps.m);
  pairDistances(flat, dim, ps, dist);
  // Coincident points (d_ij = 0) are admissible: the majorizing matrix uses b_ij = 0 there (de Leeuw & Mair 2009).
  for (let p = 0; p < ps.m; p++) if (!Number.isFinite(dist[p])) return { dist, disp: new Float64Array(ps.m), rawStress: NaN, error: "NON_FINITE" };
  const fit = new Float64Array(ps.m);
  fitDisparities(ps, dist, tie, fit);
  let ss = 0;
  for (let p = 0; p < ps.m; p++) ss += ps.w[p] * fit[p] * fit[p];
  if (!(ss > 0)) return { dist, disp: fit, rawStress: NaN, error: "ZERO_DISPARITY_NORM" };
  const factor = Math.sqrt(ps.q / ss);
  const disp = new Float64Array(ps.m);
  let raw = 0;
  for (let p = 0; p < ps.m; p++) {
    disp[p] = fit[p] * factor;
    const df = disp[p] - dist[p];
    raw += ps.w[p] * df * df;
  }
  if (!Number.isFinite(raw)) return { dist, disp, rawStress: NaN, error: "NON_FINITE" };
  return { dist, disp, rawStress: raw };
}

/** Recomputes every fit measure from the given coordinates only. */
export function evaluateConfiguration(points: Point[], dissimilarity: Matrix, weight: WeightMatrix, tie: TieHandling = "secondary"): Evaluation {
  const ps = buildPairSet(dissimilarity, weight);
  const { flat, dim } = configurationToFlat(points);
  const st = evaluateState(ps, flat, dim, tie);
  if (st.error) throw new Error(`evaluateConfiguration: ${st.error}`);
  const dist = st.dist;
  let sumD2 = 0;
  let sumH2 = 0;
  for (let p = 0; p < ps.m; p++) {
    sumD2 += ps.w[p] * dist[p] * dist[p];
    sumH2 += ps.w[p] * st.disp[p] * st.disp[p];
  }
  // Kruskal's disparities: isotonic regression of the distances themselves, NOT rescaled.
  const star = new Float64Array(ps.m);
  fitDisparities(ps, dist, tie, star);
  let numK = 0;
  for (let p = 0; p < ps.m; p++) numK += ps.w[p] * (star[p] - dist[p]) ** 2;
  // squared Pearson correlation (unweighted over the active pairs, as in v1's RSQ)
  const mx = st.disp.reduce((a, b) => a + b, 0) / ps.m;
  const my = dist.reduce((a, b) => a + b, 0) / ps.m;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let p = 0; p < ps.m; p++) {
    const dx = st.disp[p] - mx;
    const dy = dist[p] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  return {
    rawStress: st.rawStress,
    stress1: Math.sqrt(numK / sumD2),
    stressNormalizedSqrt: Math.sqrt(st.rawStress / ps.q),
    stress1V1Definition: Math.sqrt(st.rawStress / sumD2),
    rsq: r * r,
    pairCount: ps.m,
    sumDistSq: sumD2,
    sumDispSq: sumH2,
    kruskalNumerator: numK,
    minPairDistance: dist.reduce((a, b) => Math.min(a, b), Infinity),
  };
}

/** Per-pair data for the Shepard diagram (delta, distance, disparity), recomputed from coordinates. */
export function shepardData(points: Point[], dissimilarity: Matrix, weight: WeightMatrix, tie: TieHandling = "secondary") {
  const ps = buildPairSet(dissimilarity, weight);
  const { flat, dim } = configurationToFlat(points);
  const st = evaluateState(ps, flat, dim, tie);
  if (st.error) throw new Error(`shepardData: ${st.error}`);
  const star = new Float64Array(ps.m);
  fitDisparities(ps, st.dist, tie, star);
  return {
    pairs: ps.m,
    delta: Array.from(ps.delta),
    distance: Array.from(st.dist),
    /** disparities normalised to sum d_hat^2 = n(n-1)/2 (the ones raw stress uses) */
    disparity: Array.from(st.disp),
    /** monotone-regression disparities of the distances, NOT rescaled (the ones Kruskal Stress-1 uses) */
    disparityKruskal: Array.from(star),
    i: Array.from(ps.i),
    j: Array.from(ps.j),
  };
}

export type RunTrace = {
  /** raw stress after each evaluated iteration (1-based position + 1 = iteration number) */
  rawStress: number[];
  /** relative decrease at each iteration >= 2 (index 0 corresponds to iteration 2) */
  relativeChange: number[];
};

export type StartResult = {
  initIndex: number;
  seed: number;
  reason: TerminationReason;
  iterations: number;
  rawStress: number;
  stress1: number;
  finalRelativeChange: number | null;
  /** largest relative INCREASE seen (0 if the objective never rose) */
  maxRelativeIncrease: number;
  coordinates: Point[];
  trace: RunTrace;
};

function guttman(
  flat: Float64Array,
  n: number,
  dim: number,
  ps: PairSet,
  dist: Float64Array,
  disp: Float64Array,
  vPlus: Float64Array,
  b: Float64Array,
  bx: Float64Array,
  out: Float64Array
): void {
  b.fill(0);
  for (let p = 0; p < ps.m; p++) {
    const v = dist[p] > 0 ? -(ps.w[p] * disp[p]) / dist[p] : 0;
    const a = ps.i[p];
    const c = ps.j[p];
    b[a * n + c] = v;
    b[c * n + a] = v;
  }
  for (let a = 0; a < n; a++) {
    let r = 0;
    for (let c = 0; c < n; c++) if (c !== a) r += b[a * n + c];
    b[a * n + a] = -r;
  }
  bx.fill(0);
  for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) {
    const bv = b[a * n + c];
    if (bv === 0) continue;
    for (let k = 0; k < dim; k++) bx[a * dim + k] += bv * flat[c * dim + k];
  }
  out.fill(0);
  for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) {
    const vv = vPlus[a * n + c];
    if (vv === 0) continue;
    for (let k = 0; k < dim; k++) out[a * dim + k] += vv * bx[c * dim + k];
  }
  center(out, n, dim);
}

function buildVPlus(ps: PairSet): Float64Array {
  const n = ps.n;
  const v: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let p = 0; p < ps.m; p++) {
    v[ps.i[p]][ps.j[p]] -= ps.w[p];
    v[ps.j[p]][ps.i[p]] -= ps.w[p];
  }
  for (let a = 0; a < n; a++) {
    let r = 0;
    for (let c = 0; c < n; c++) if (c !== a) r += -v[a][c];
    v[a][a] = r;
  }
  const inv = symmetricPseudoInverse(v);
  const flat = new Float64Array(n * n);
  for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) flat[a * n + c] = inv[a][c];
  return flat;
}

/**
 * Majorization loop from a given start. Terminates with an EVALUATED configuration: the returned
 * coordinates are exactly those at which rawStress was computed.
 */
function iterate(
  ps: PairSet,
  vPlus: Float64Array,
  start: Float64Array,
  dim: number,
  maxIter: number,
  eps: number,
  tie: TieHandling,
  priorTrace?: RunTrace
): { flat: Float64Array; reason: TerminationReason; iterations: number; rawStress: number; finalRelativeChange: number | null; maxRelativeIncrease: number; trace: RunTrace } {
  const n = ps.n;
  let flat = Float64Array.from(start);
  center(flat, n, dim);
  const next = new Float64Array(n * dim);
  const b = new Float64Array(n * n);
  const bx = new Float64Array(n * dim);
  const trace: RunTrace = { rawStress: priorTrace ? [...priorTrace.rawStress] : [], relativeChange: priorTrace ? [...priorTrace.relativeChange] : [] };
  let prev = priorTrace && priorTrace.rawStress.length ? priorTrace.rawStress[priorTrace.rawStress.length - 1] : NaN;
  let finalRel: number | null = null;
  let maxInc = 0;
  let last = NaN;
  // When continuing from a previous run, the first evaluation re-visits the previous run's final
  // configuration: it is not a new iteration (no trace entry, no convergence test, not counted).
  const continuing = Boolean(priorTrace && priorTrace.rawStress.length);
  for (let it = 1; it <= maxIter + (continuing ? 1 : 0); it++) {
    const st = evaluateState(ps, flat, dim, tie);
    const counted = continuing ? it - 1 : it;
    if (st.error) {
      return { flat, reason: st.error, iterations: counted, rawStress: NaN, finalRelativeChange: finalRel, maxRelativeIncrease: maxInc, trace };
    }
    if (continuing && it === 1) {
      prev = st.rawStress;
      last = st.rawStress;
      guttman(flat, n, dim, ps, st.dist, st.disp, vPlus, b, bx, next);
      flat = Float64Array.from(next);
      continue;
    }
    trace.rawStress.push(st.rawStress);
    last = st.rawStress;
    if (Number.isFinite(prev)) {
      const rel = prev > 0 ? (prev - st.rawStress) / prev : 0;
      trace.relativeChange.push(rel);
      finalRel = rel;
      if (rel < 0) maxInc = Math.max(maxInc, -rel);
      if (rel < -1e-9) {
        return { flat, reason: "OBJECTIVE_INCREASED", iterations: counted, rawStress: st.rawStress, finalRelativeChange: rel, maxRelativeIncrease: maxInc, trace };
      }
      if (rel <= eps || st.rawStress === 0) {
        return { flat, reason: "CONVERGED", iterations: counted, rawStress: st.rawStress, finalRelativeChange: rel, maxRelativeIncrease: maxInc, trace };
      }
    }
    prev = st.rawStress;
    if (counted === maxIter) break;
    guttman(flat, n, dim, ps, st.dist, st.disp, vPlus, b, bx, next);
    flat = Float64Array.from(next);
  }
  return { flat, reason: "MAX_ITER", iterations: maxIter, rawStress: last, finalRelativeChange: finalRel, maxRelativeIncrease: maxInc, trace };
}

export type SmacofV2Result = {
  settings: SmacofV2Settings;
  starts: Omit<StartResult, "coordinates" | "trace">[];
  convergedCount: number;
  /** "CONVERGED_CANDIDATE" when at least one start converged at `eps`; otherwise the best non-converged start is returned and flagged. */
  selectionStatus: "CONVERGED_CANDIDATE" | "NO_CONVERGED_CANDIDATE" | "ALL_FAILED";
  selected: {
    initIndex: number;
    seed: number;
    /** result of the main run (tolerance eps) */
    main: { reason: TerminationReason; iterations: number; rawStress: number; finalRelativeChange: number | null };
    /** continuation from the selected solution at strictEps */
    strict: { reason: TerminationReason; iterations: number; rawStress: number; finalRelativeChange: number | null; maxRelativeIncrease: number };
  } | null;
  coordinates: Point[] | null;
  evaluation: Evaluation | null;
  /** raw stress per iteration of the selected start: main run followed by the strict continuation */
  trace: RunTrace | null;
  mainRunIterations: number;
  rawStressSpreadAmongConverged: { min: number; median: number; max: number } | null;
  errorCode?: string;
  errorMessage?: string;
};

export function randomStart(n: number, dim: number, seed: number): Float64Array {
  const rng = mulberry32(seed);
  const flat = new Float64Array(n * dim);
  for (let a = 0; a < n; a++) for (let k = 0; k < dim; k++) flat[a * dim + k] = uniform(rng, -1, 1);
  center(flat, n, dim);
  return flat;
}

export function runSmacofV2(dissimilarity: Matrix, weight: WeightMatrix, settings: SmacofV2Settings, onProgress?: (done: number, total: number) => void): SmacofV2Result {
  const n = dissimilarity.length;
  const base: SmacofV2Result = {
    settings,
    starts: [],
    convergedCount: 0,
    selectionStatus: "ALL_FAILED",
    selected: null,
    coordinates: null,
    evaluation: null,
    trace: null,
    mainRunIterations: 0,
    rawStressSpreadAmongConverged: null,
  };
  if (n < 2) return { ...base, errorCode: "INSUFFICIENT_ITEMS", errorMessage: "SMACOF requires at least 2 items." };
  if (settings.dimension >= n) return { ...base, errorCode: "DIMENSION_TOO_HIGH", errorMessage: `dimension (${settings.dimension}) must be < number of items (${n}).` };
  const ps = buildPairSet(dissimilarity, weight);
  if (ps.m === 0) return { ...base, errorCode: "NO_WEIGHTED_PAIRS", errorMessage: "Every off-diagonal pair has weight=0 — there is nothing to fit." };
  const vPlus = buildVPlus(ps);

  const results: StartResult[] = [];
  for (let k = 0; k < settings.nInit; k++) {
    const seed = deriveSeed(settings.randomSeed, k);
    const r = iterate(ps, vPlus, randomStart(n, settings.dimension, seed), settings.dimension, settings.maxIter, settings.eps, settings.tieHandling);
    let s1 = NaN;
    if (Number.isFinite(r.rawStress)) {
      try {
        s1 = evaluateConfiguration(flatToPoints(r.flat, n, settings.dimension), dissimilarity, weight, settings.tieHandling).stress1;
      } catch {
        s1 = NaN;
      }
    }
    results.push({
      initIndex: k,
      seed,
      reason: r.reason,
      iterations: r.iterations,
      rawStress: r.rawStress,
      stress1: s1,
      finalRelativeChange: r.finalRelativeChange,
      maxRelativeIncrease: r.maxRelativeIncrease,
      coordinates: flatToPoints(r.flat, n, settings.dimension),
      trace: r.trace,
    });
    onProgress?.(k + 1, settings.nInit);
  }

  const summaries = results.map(({ coordinates: _c, trace: _t, ...rest }) => {
    void _c;
    void _t;
    return rest;
  });
  const converged = results.filter((r) => r.reason === "CONVERGED" && Number.isFinite(r.rawStress));
  const finite = results.filter((r) => Number.isFinite(r.rawStress) && r.reason !== "NON_FINITE" && r.reason !== "DEGENERATE_CONFIGURATION" && r.reason !== "ZERO_DISPARITY_NORM");
  const pool = converged.length > 0 ? converged : finite;
  if (pool.length === 0) {
    return { ...base, starts: summaries, errorCode: "ALL_INITS_FAILED", errorMessage: "Every start failed (degenerate or non-finite); no result is available." };
  }
  pool.sort((a, b) => a.rawStress - b.rawStress || a.initIndex - b.initIndex);
  const best = pool[0];
  const sortedRaw = converged.map((r) => r.rawStress).sort((a, b) => a - b);
  const spread = sortedRaw.length
    ? { min: sortedRaw[0], median: sortedRaw[Math.floor(sortedRaw.length / 2)], max: sortedRaw[sortedRaw.length - 1] }
    : null;

  // Continue from the selected solution with the strict tolerance (monotone: cannot make it worse).
  const bestFlat = configurationToFlat(best.coordinates).flat;
  const strict = iterate(ps, vPlus, bestFlat, settings.dimension, settings.strictMaxIter, settings.strictEps, settings.tieHandling, best.trace);
  const finalPoints = flatToPoints(strict.flat, n, settings.dimension);
  const evaluation = evaluateConfiguration(finalPoints, dissimilarity, weight, settings.tieHandling);

  return {
    settings,
    starts: summaries,
    convergedCount: converged.length,
    selectionStatus: converged.length > 0 ? "CONVERGED_CANDIDATE" : "NO_CONVERGED_CANDIDATE",
    selected: {
      initIndex: best.initIndex,
      seed: best.seed,
      main: { reason: best.reason, iterations: best.iterations, rawStress: best.rawStress, finalRelativeChange: best.finalRelativeChange },
      strict: { reason: strict.reason, iterations: strict.iterations, rawStress: strict.rawStress, finalRelativeChange: strict.finalRelativeChange, maxRelativeIncrease: strict.maxRelativeIncrease },
    },
    coordinates: finalPoints,
    evaluation,
    trace: strict.trace,
    mainRunIterations: best.iterations,
    rawStressSpreadAmongConverged: spread,
  };
}
