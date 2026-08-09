/**
 * Disparity normalization for nonmetric SMACOF, applied AFTER weighted PAVA
 * (isotonic.ts) fits disparities and BEFORE those disparities are used in
 * Stress computation or the Guttman transform.
 *
 * This is the classical nonmetric MDS "optimal scaling" normalization step
 * (Kruskal 1964; de Leeuw 1977; Borg & Groenen, "Modern Multidimensional
 * Scaling", ch. 8-9): after fitting monotone disparities, rescale them by a
 * single positive constant so their weighted sum of squares equals a fixed
 * target norm. Confirmed present in both external reference
 * implementations this project cross-validates against: scikit-learn's
 * installed source (sklearn/manifold/_mds.py) contains the literal line
 * `disparities *= np.sqrt(...)`, and R's smacof package namespace exposes
 * normDiss/normDissN-named internals consistent with the same step. Prior
 * to this module, this codebase's fitDisparities() (smacof.ts) returned the
 * raw PAVA output unnormalized — cross-validation established (see
 * analysis-prototype's attempt 4/5 reports) that this produced a
 * genuinely different but SHAPE-EQUIVALENT (same configuration, different
 * scale — confirmed via similarity Procrustes) result versus scikit-learn
 * and R.
 *
 * Target norm: q = n * (n - 1) / 2 — the pair count of a COMPLETE
 * symmetric n-object matrix, used regardless of how many pairs are
 * actually active (weight > 0). For every valid concept-map analysis every
 * statement pair is observed (no missing pairs), so q and the active pair
 * count coincide; for a fixture with genuinely missing pairs they can
 * differ — both are reported separately here, never conflated.
 *
 * This module does NOT touch isotonic.ts's weighted PAVA implementation.
 * It operates purely on the already-fitted disparity matrix: a uniform
 * positive scalar multiply preserves tie-block equality (every pair in a
 * tie block still receives an identical value) and monotone ordering by
 * construction.
 */
import { upperTrianglePairs } from "./stress";
import type { Matrix, WeightMatrix } from "./types";

export type DisparityNormalizationResult = {
  normalizedDisparities: Matrix;
  normalizationFactor: number;
  normalizationTarget: number;
  preNormalizationSumSquares: number;
  postNormalizationSumSquares: number;
  activePairCount: number;
  zeroValuedActivePairCount: number;
  errorCode?: string;
  errorMessage?: string;
};

function errorResult(errorCode: string, errorMessage: string): DisparityNormalizationResult {
  return {
    normalizedDisparities: [],
    normalizationFactor: NaN,
    normalizationTarget: NaN,
    preNormalizationSumSquares: NaN,
    postNormalizationSumSquares: NaN,
    activePairCount: 0,
    zeroValuedActivePairCount: 0,
    errorCode,
    errorMessage,
  };
}

/**
 * Rescales `disparity` (an n x n symmetric matrix, diagonal 0, as produced
 * by fitDisparities) so that Σ_{i<j, weight>0} weight_ij * disparity_ij^2
 * equals n(n-1)/2, and returns the rescaled matrix plus normalization
 * metadata. Never returns an arbitrary factor=1 fallback on a degenerate
 * input — a zero/negative weighted sum of squares or no active pairs is
 * reported as a structured error instead.
 */
export function normalizeDisparities(disparity: Matrix, weight: WeightMatrix, objectCount: number): DisparityNormalizationResult {
  const n = objectCount;
  if (n < 2) {
    return errorResult("INVALID_DISPARITY_NORM", `objectCount must be >= 2, got ${n}`);
  }
  if (disparity.length !== n || disparity.some((row) => row.length !== n)) {
    return errorResult("INVALID_DISPARITY_NORM", "disparity matrix must be n x n");
  }
  if (weight.length !== n || weight.some((row) => row.length !== n)) {
    return errorResult("INVALID_DISPARITY_NORM", "weight matrix must be n x n, matching disparity");
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(disparity[i][j] - disparity[j][i]) > 1e-9) {
        return errorResult("INVALID_DISPARITY_NORM", `disparity matrix is not symmetric at (${i},${j})`);
      }
    }
  }

  const pairs = upperTrianglePairs(n);
  let activePairCount = 0;
  let zeroValuedActivePairCount = 0;
  let sumSquares = 0;
  for (const { i, j } of pairs) {
    const w = weight[i][j];
    if (!Number.isFinite(w) || w < 0) {
      return errorResult("INVALID_DISPARITY_NORM", `weight[${i}][${j}] must be finite and >= 0, got ${w}`);
    }
    if (w <= 0) continue;
    const d = disparity[i][j];
    if (!Number.isFinite(d)) {
      return errorResult("INVALID_DISPARITY_NORM", `disparity[${i}][${j}] must be finite, got ${d}`);
    }
    activePairCount++;
    if (d === 0) zeroValuedActivePairCount++;
    sumSquares += w * d * d;
  }

  if (activePairCount === 0) {
    return errorResult("NO_WEIGHTED_PAIRS", "No active (weight > 0) pairs to normalize.");
  }

  const normalizationTarget = (n * (n - 1)) / 2;
  if (!(normalizationTarget > 0)) {
    return errorResult("INVALID_DISPARITY_NORM", `normalizationTarget must be > 0, got ${normalizationTarget}`);
  }
  if (!(sumSquares > 0)) {
    return errorResult("ZERO_DISPARITY_NORM", "Weighted disparity sum of squares is zero or negative -- cannot normalize.");
  }

  const normalizationFactor = Math.sqrt(normalizationTarget / sumSquares);
  if (!Number.isFinite(normalizationFactor) || normalizationFactor <= 0) {
    return errorResult("DISPARITY_NORMALIZATION_FAILED", `Computed normalizationFactor is not finite/positive: ${normalizationFactor}`);
  }

  const normalizedDisparities: Matrix = disparity.map((row) => row.map((v) => v * normalizationFactor));

  let postNormalizationSumSquares = 0;
  for (const { i, j } of pairs) {
    if (weight[i][j] > 0) {
      postNormalizationSumSquares += weight[i][j] * normalizedDisparities[i][j] * normalizedDisparities[i][j];
    }
  }

  return {
    normalizedDisparities,
    normalizationFactor,
    normalizationTarget,
    preNormalizationSumSquares: sumSquares,
    postNormalizationSumSquares,
    activePairCount,
    zeroValuedActivePairCount,
  };
}
