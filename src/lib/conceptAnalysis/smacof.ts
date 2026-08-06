/**
 * Nonmetric MDS via SMACOF (Scaling by MAjorizing a COmplicated Function),
 * de Leeuw 1977. This is a from-scratch TypeScript implementation — no
 * external MDS dependency exists for nonmetric/SMACOF MDS in the npm
 * ecosystem (checked; only R's `smacof` package and Python's
 * `sklearn.manifold.smacof` are mature implementations) — so correctness
 * here rests on: (a) the documented formulas below, (b) the internal
 * self-consistency checks in this file and in stress.ts, and (c) external
 * numeric cross-checks, which are reported separately as NOT YET RUN in
 * this environment (no Docker/Podman/WSL/Python/R available — see the
 * verification report). This module must not be described as "verified"
 * until that cross-check actually runs.
 *
 * Algorithm outline per iteration, given a current configuration X:
 *   1. d_ij(X)      = Euclidean distances in the current configuration
 *   2. dHat_ij      = disparities: an isotonic (monotone) fit of d_ij(X)
 *                     against the dissimilarity ranking (secondary tie
 *                     handling — see isotonic.ts)
 *   3. stress       = rawStress / normalizedStress1 (stress.ts, Kruskal
 *                     Stress-1: denominator is Σ w_ij d_ij(X)^2)
 *   4. Guttman transform (weighted, general form):
 *        V[i][j]    = -w_ij           (i != j)
 *        V[i][i]    = Σ_{j!=i} w_ij
 *        B(X)[i][j] = -w_ij * dHat_ij / d_ij(X)   if d_ij(X) > 0, else 0  (i != j)
 *        B(X)[i][i] = -Σ_{j!=i} B(X)[i][j]
 *        X_new      = V^+ (B(X) X)               (V^+ = pseudoinverse, linalg.ts)
 *      For the common case here (all off-diagonal weights equal to 1, which
 *      is the case whenever no pair is marked genuinely missing), this is
 *      mathematically equivalent to the well-known simplified formula
 *      X_new = (1/n) B(X) X (de Leeuw 1977; Borg & Groenen, "Modern
 *      Multidimensional Scaling", ch. 8) — the general pseudoinverse form is
 *      used unconditionally so the implementation stays correct if a future
 *      caller supplies non-uniform weights.
 */
import { deriveSeed, mulberry32, uniform, type Prng } from "./prng";
import { isotonicRegressionByRank } from "./isotonic";
import { matMul, symmetricPseudoInverse } from "./linalg";
import { computeNormalizedStress1, computeRawStress, euclideanDistanceMatrix, upperTrianglePairs } from "./stress";
import { normalizeDisparities } from "./disparityNormalization";
import type { Matrix, Point, SmacofInitResult, SmacofParams, SmacofRunResult, WeightMatrix } from "./types";

function centerConfiguration(points: Point[]): Point[] {
  const n = points.length;
  const dim = points[0]?.length ?? 0;
  const mean = new Array(dim).fill(0);
  for (const p of points) for (let d = 0; d < dim; d++) mean[d] += p[d] / n;
  return points.map((p) => p.map((v, d) => v - mean[d]));
}

function randomInitialConfiguration(n: number, dimension: number, rng: Prng): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < n; i++) {
    points.push(Array.from({ length: dimension }, () => uniform(rng, -1, 1)));
  }
  return centerConfiguration(points);
}

function fitDisparities(dissimilarity: Matrix, distance: Matrix, weight: WeightMatrix): Matrix {
  const n = distance.length;
  const pairs = upperTrianglePairs(n).filter(({ i, j }) => weight[i][j] > 0);
  const observations = pairs.map(({ i, j }) => ({
    rankKey: dissimilarity[i][j],
    value: distance[i][j],
    weight: weight[i][j],
  }));
  const fitted = isotonicRegressionByRank(observations);

  const disparity: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  pairs.forEach(({ i, j }, idx) => {
    disparity[i][j] = fitted[idx];
    disparity[j][i] = fitted[idx];
  });
  return disparity;
}

function guttmanTransform(
  points: Point[],
  disparity: Matrix,
  distance: Matrix,
  weight: WeightMatrix,
  vPseudoInverse: Matrix
): Point[] {
  const n = points.length;
  const b: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    let rowSum = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = distance[i][j];
      const value = d > 0 ? (-weight[i][j] * disparity[i][j]) / d : 0;
      b[i][j] = value;
      rowSum += value;
    }
    b[i][i] = -rowSum;
  }
  const bx = matMul(b, points);
  return matMul(vPseudoInverse, bx) as Point[];
}

function buildV(weight: WeightMatrix): Matrix {
  const n = weight.length;
  const v: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    let rowSum = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      v[i][j] = -weight[i][j];
      rowSum += weight[i][j];
    }
    v[i][i] = rowSum;
  }
  return v;
}

function hasDegenerateCoincidentPoints(distance: Matrix, weight: WeightMatrix): boolean {
  const n = distance.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (weight[i][j] > 0 && distance[i][j] === 0) return true;
    }
  }
  return false;
}

/**
 * Core majorization loop, parameterized on the STARTING configuration
 * rather than generating one — used both by the normal random-multi-start
 * path (runSingleInit below) and by runSmacofFromInitialConfiguration,
 * which exists specifically so an external reference implementation
 * (Python/R) can be handed the exact same starting coordinates for a fair,
 * apples-to-apples cross-validation run instead of relying on two
 * different languages' PRNGs to somehow agree (they can't).
 */
function runFromConfiguration(
  dissimilarity: Matrix,
  weight: WeightMatrix,
  initialPoints: Point[],
  initIndex: number,
  seed: number,
  maxIter: number,
  eps: number,
  vPseudoInverse: Matrix
): SmacofInitResult {
  const n = initialPoints.length;
  let points = centerConfiguration(initialPoints);

  const stressHistory: number[] = [];
  let converged = false;
  let iterations = 0;
  let lastNormalized = NaN;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    const distance = euclideanDistanceMatrix(points);

    if (hasDegenerateCoincidentPoints(distance, weight)) {
      return {
        initIndex,
        seed,
        coordinates: points,
        rawStress: NaN,
        normalizedStress1: NaN,
        converged: false,
        iterations,
        stressHistory,
        errorCode: "DEGENERATE_CONFIGURATION",
        errorMessage: "Two or more points coincided during optimization (distance=0 for a weighted pair); this run is invalid.",
      };
    }

    // Fit disparities via weighted PAVA (isotonic.ts, unchanged), then
    // rescale them to the classical optimal-scaling target norm
    // q = n(n-1)/2 before they are used for Stress or the Guttman
    // transform — see disparityNormalization.ts for the rationale
    // (matches scikit-learn's/R smacof's confirmed behavior).
    const rawDisparity = fitDisparities(dissimilarity, distance, weight);
    const normResult = normalizeDisparities(rawDisparity, weight, n);
    if (normResult.errorCode) {
      return {
        initIndex,
        seed,
        coordinates: points,
        rawStress: NaN,
        normalizedStress1: NaN,
        converged: false,
        iterations,
        stressHistory,
        errorCode: normResult.errorCode,
        errorMessage: normResult.errorMessage,
      };
    }
    const disparity = normResult.normalizedDisparities;

    const normalized = computeNormalizedStress1(disparity, distance, weight);
    if (!Number.isFinite(normalized)) {
      return {
        initIndex,
        seed,
        coordinates: points,
        rawStress: NaN,
        normalizedStress1: NaN,
        converged: false,
        iterations,
        stressHistory,
        errorCode: "NON_FINITE_STRESS",
        errorMessage: "Stress computation produced a non-finite value (NaN/Infinity).",
      };
    }
    stressHistory.push(normalized);

    if (iter > 0) {
      const prev = stressHistory[stressHistory.length - 2];
      // Majorization guarantees non-increase up to floating-point noise.
      if (normalized > prev + 1e-7) {
        return {
          initIndex,
          seed,
          coordinates: points,
          rawStress: computeRawStress(disparity, distance, weight),
          normalizedStress1: normalized,
          converged: false,
          iterations,
          stressHistory,
          errorCode: "STRESS_INCREASED",
          errorMessage: `Stress increased from ${prev} to ${normalized} at iteration ${iter}; majorization invariant violated.`,
          disparityNormalizationFactor: normResult.normalizationFactor,
          disparityNormBefore: normResult.preNormalizationSumSquares,
          disparityNormAfter: normResult.postNormalizationSumSquares,
          normalizationTarget: normResult.normalizationTarget,
        };
      }
      if (Math.abs(prev - normalized) < eps) {
        converged = true;
        lastNormalized = normalized;
        const rawStress = computeRawStress(disparity, distance, weight);
        return {
          initIndex,
          seed,
          coordinates: points,
          rawStress,
          normalizedStress1: normalized,
          converged,
          iterations,
          stressHistory,
          disparityNormalizationFactor: normResult.normalizationFactor,
          disparityNormBefore: normResult.preNormalizationSumSquares,
          disparityNormAfter: normResult.postNormalizationSumSquares,
          normalizationTarget: normResult.normalizationTarget,
        };
      }
    }

    lastNormalized = normalized;
    points = centerConfiguration(guttmanTransform(points, disparity, distance, weight, vPseudoInverse));
  }

  // Hit maxIter without meeting eps — report honestly as not converged.
  const distance = euclideanDistanceMatrix(points);
  const rawDisparity = fitDisparities(dissimilarity, distance, weight);
  const normResult = normalizeDisparities(rawDisparity, weight, n);
  if (normResult.errorCode) {
    return {
      initIndex,
      seed,
      coordinates: points,
      rawStress: NaN,
      normalizedStress1: lastNormalized,
      converged: false,
      iterations,
      stressHistory,
      errorCode: normResult.errorCode,
      errorMessage: normResult.errorMessage,
    };
  }
  const disparity = normResult.normalizedDisparities;
  const rawStress = computeRawStress(disparity, distance, weight);
  return {
    initIndex,
    seed,
    coordinates: points,
    rawStress,
    normalizedStress1: lastNormalized,
    converged: false,
    iterations,
    stressHistory,
    disparityNormalizationFactor: normResult.normalizationFactor,
    disparityNormBefore: normResult.preNormalizationSumSquares,
    disparityNormAfter: normResult.postNormalizationSumSquares,
    normalizationTarget: normResult.normalizationTarget,
  };
}

function runSingleInit(
  dissimilarity: Matrix,
  weight: WeightMatrix,
  dimension: number,
  initIndex: number,
  seed: number,
  maxIter: number,
  eps: number,
  vPseudoInverse: Matrix
): SmacofInitResult {
  const n = dissimilarity.length;
  const rng = mulberry32(seed);
  const initialPoints = randomInitialConfiguration(n, dimension, rng);
  return runFromConfiguration(dissimilarity, weight, initialPoints, initIndex, seed, maxIter, eps, vPseudoInverse);
}

/**
 * Cross-validation entry point: runs the exact same majorization loop as
 * runSmacof, but from a caller-supplied starting configuration instead of a
 * PRNG-generated one. This is what analysis-prototype's fixture-export /
 * comparison scripts use so Python (sklearn's `init=` parameter) and R can
 * be started from IDENTICAL coordinates — matching seeds alone would not
 * produce identical starts across three different PRNG implementations.
 */
export function runSmacofFromInitialConfiguration(
  dissimilarity: Matrix,
  weight: WeightMatrix,
  initialPoints: Point[],
  options: { maxIter: number; eps: number }
): SmacofInitResult & { errorCode?: string } {
  const n = dissimilarity.length;
  if (n < 2) {
    return {
      initIndex: 0,
      seed: 0,
      coordinates: initialPoints,
      rawStress: NaN,
      normalizedStress1: NaN,
      converged: false,
      iterations: 0,
      stressHistory: [],
      errorCode: "INSUFFICIENT_ITEMS",
      errorMessage: "SMACOF requires at least 2 items.",
    };
  }
  const dimension = initialPoints[0]?.length ?? 0;
  if (dimension >= n) {
    return {
      initIndex: 0,
      seed: 0,
      coordinates: initialPoints,
      rawStress: NaN,
      normalizedStress1: NaN,
      converged: false,
      iterations: 0,
      stressHistory: [],
      errorCode: "DIMENSION_TOO_HIGH",
      errorMessage: `dimension (${dimension}) must be < number of items (${n}).`,
    };
  }
  const hasAnyWeightedPair = upperTrianglePairs(n).some(({ i, j }) => weight[i][j] > 0);
  if (!hasAnyWeightedPair) {
    return {
      initIndex: 0,
      seed: 0,
      coordinates: initialPoints,
      rawStress: NaN,
      normalizedStress1: NaN,
      converged: false,
      iterations: 0,
      stressHistory: [],
      errorCode: "NO_WEIGHTED_PAIRS",
      errorMessage: "Every off-diagonal pair has weight=0 (all marked missing) — there is nothing to fit.",
    };
  }
  const vPseudoInverse = symmetricPseudoInverse(buildV(weight));
  return runFromConfiguration(dissimilarity, weight, initialPoints, 0, 0, options.maxIter, options.eps, vPseudoInverse);
}

export function runSmacof(dissimilarity: Matrix, weight: WeightMatrix, params: SmacofParams): SmacofRunResult {
  const n = dissimilarity.length;
  if (n < 2) {
    return {
      dimension: params.dimension,
      params,
      inits: [],
      bestInitIndex: null,
      bestSeed: null,
      coordinates: null,
      rawStress: null,
      normalizedStress1: null,
      converged: false,
      errorCode: "INSUFFICIENT_ITEMS",
      errorMessage: "SMACOF requires at least 2 items.",
    };
  }
  if (params.dimension >= n) {
    return {
      dimension: params.dimension,
      params,
      inits: [],
      bestInitIndex: null,
      bestSeed: null,
      coordinates: null,
      rawStress: null,
      normalizedStress1: null,
      converged: false,
      errorCode: "DIMENSION_TOO_HIGH",
      errorMessage: `dimension (${params.dimension}) must be < number of items (${n}).`,
    };
  }

  const hasAnyWeightedPair = upperTrianglePairs(n).some(({ i, j }) => weight[i][j] > 0);
  if (!hasAnyWeightedPair) {
    return {
      dimension: params.dimension,
      params,
      inits: [],
      bestInitIndex: null,
      bestSeed: null,
      coordinates: null,
      rawStress: null,
      normalizedStress1: null,
      converged: false,
      errorCode: "NO_WEIGHTED_PAIRS",
      errorMessage: "Every off-diagonal pair has weight=0 (all marked missing) — there is nothing to fit.",
    };
  }

  const vPseudoInverse = symmetricPseudoInverse(buildV(weight));

  const inits: SmacofInitResult[] = [];
  for (let k = 0; k < params.nInit; k++) {
    const seed = deriveSeed(params.randomSeed, k);
    inits.push(runSingleInit(dissimilarity, weight, params.dimension, k, seed, params.maxIter, params.eps, vPseudoInverse));
  }

  const successful = inits.filter((r) => Number.isFinite(r.normalizedStress1));
  if (successful.length === 0) {
    return {
      dimension: params.dimension,
      params,
      inits,
      bestInitIndex: null,
      bestSeed: null,
      coordinates: null,
      rawStress: null,
      normalizedStress1: null,
      converged: false,
      errorCode: "ALL_INITS_FAILED",
      errorMessage: "Every nInit run failed or produced a non-finite stress; no result is available.",
    };
  }

  successful.sort((a, b) => a.normalizedStress1 - b.normalizedStress1);
  const best = successful[0];

  return {
    dimension: params.dimension,
    params,
    inits,
    bestInitIndex: best.initIndex,
    bestSeed: best.seed,
    coordinates: best.coordinates,
    rawStress: best.rawStress,
    normalizedStress1: best.normalizedStress1,
    converged: best.converged,
  };
}
