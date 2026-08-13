import {
  isotonicRegressionByRank,
  normalizeDisparities,
  upperTrianglePairs,
  euclideanDistanceMatrix,
  type Matrix,
  type WeightMatrix,
  type Point,
} from "@/lib/conceptAnalysis";

/**
 * RSQ (squared correlation between fitted disparities and configuration
 * distances) is not part of the frozen conceptAnalysis engine's public
 * result type (SmacofRunResult never returns the final disparity matrix —
 * see smacof.ts's private fitDisparities()). This module does NOT change
 * that engine or its algorithm. It re-derives the same final disparity
 * matrix an already-completed SMACOF run implicitly used to decide
 * convergence, purely from that run's own OUTPUT (final coordinates) and
 * INPUT (dissimilarity/weight), by calling the engine's own exported
 * building blocks in the exact same sequence smacof.ts's private
 * fitDisparities() does: isotonicRegressionByRank (secondary tie handling,
 * unchanged) -> normalizeDisparities (target-norm-scaled, unchanged).
 *
 * This differs from the Shepard-diagram case (see view/uiState.ts's
 * SHEPARD_UNAVAILABLE_MESSAGE): a Shepard plot needs the full per-pair
 * disparity list surfaced as a new visualization feature, which that
 * decision declined to build. RSQ needs only a single aggregate statistic
 * (a Pearson correlation over the existing pairs), computed from data
 * already present in every COMPLETED run's stored inputSnapshot + that
 * dimension's stored coordinates — no new stored field, no new algorithm.
 */

function fitFinalDisparities(dissimilarity: Matrix, distance: Matrix, weight: WeightMatrix): Matrix {
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

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    dx2 = 0,
    dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx,
      dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : NaN;
}

export type RsqResult = {
  /** R² is defined as equal to RSQ (squared correlation) — never a second, independently-computed value. */
  rsq: number | null;
  pairCount: number;
  errorCode: string | null;
};

/**
 * Computes RSQ = cor(disparity, fittedDistance)^2 over the same active
 * (weight > 0) upper-triangle pairs the engine's own Stress computation
 * uses. Returns rsq=null with an errorCode when the underlying
 * normalization fails (mirrors normalizeDisparities' own error reporting;
 * never fabricates a fallback value).
 */
export function computeRSQForDimension(dissimilarity: Matrix, weight: WeightMatrix, coordinates: Point[]): RsqResult {
  const n = coordinates.length;
  if (n < 2) {
    return { rsq: null, pairCount: 0, errorCode: "INSUFFICIENT_ITEMS" };
  }
  const distance = euclideanDistanceMatrix(coordinates);
  const rawDisparity = fitFinalDisparities(dissimilarity, distance, weight);
  const normResult = normalizeDisparities(rawDisparity, weight, n);
  if (normResult.errorCode) {
    return { rsq: null, pairCount: 0, errorCode: normResult.errorCode };
  }
  const disparity = normResult.normalizedDisparities;
  const pairs = upperTrianglePairs(n).filter(({ i, j }) => weight[i][j] > 0);
  const disp = pairs.map(({ i, j }) => disparity[i][j]);
  const dist = pairs.map(({ i, j }) => distance[i][j]);
  const r = pearson(disp, dist);
  return {
    rsq: Number.isFinite(r) ? r * r : null,
    pairCount: pairs.length,
    errorCode: Number.isFinite(r) ? null : "DEGENERATE_CORRELATION",
  };
}

/**
 * Human-readable, non-hidden convergence reason for a COMPLETED dimension
 * result — derived ONLY from fields already stored on AnalysisRunDimension
 * (converged, iterations) plus the run's own maxIter parameter, never from
 * a new stored field. The engine's own bestInit.errorCode (e.g.
 * "STRESS_INCREASED") is not persisted today — engineAdapter.ts's
 * runDimension() intentionally hardcodes errorCode=null for every COMPLETED
 * result, matching the schema's documented contract ("COMPLETED requires
 * the result fields below to be populated; FAILED requires errorCode") —
 * changing that contract to smuggle a soft-failure reason through the
 * hard-failure errorCode column would be a real (if small) schema/engine
 * change, which this task must not make.
 *
 * Instead the reason is inferred purely from smacof.ts's own control flow
 * (runFromConfiguration): among results with a finite Stress (the only ones
 * ever selected as "best"), a non-converged result either (a) ran the full
 * maxIter budget without reaching `eps`, or (b) returned early because the
 * majorization-invariant STRESS_INCREASED check fired. iterations reaching
 * maxIter distinguishes case (a); anything short of maxIter with
 * converged=false can only be case (b) — DEGENERATE_CONFIGURATION and
 * NON_FINITE_STRESS both produce a non-finite stress and are therefore
 * never selected as the "best" init in the first place.
 */
export function deriveConvergenceReason(
  dimensionStatus: string,
  converged: boolean | null,
  iterations: number | null,
  maxIter: number
): string {
  if (dimensionStatus !== "COMPLETED") return "NOT_APPLICABLE";
  if (converged) return "CONVERGED";
  if (iterations !== null && iterations >= maxIter) return "MAX_ITER_REACHED";
  return "STRESS_INCREASED";
}
