/**
 * Stress computation, kept separate from the SMACOF iteration loop so it can
 * be called independently to *re-verify* a result after the fact (the
 * "recomputed stress must equal the returned stress" self-consistency check
 * requested for this prototype).
 *
 * Definitions used (Kruskal, 1964; confirmed against a secondary derivation
 * in "Yet Another Smacof" (arXiv:2512.00232), which restates Kruskal's
 * Stress Formula 1 explicitly — the primary source chapter (Kane & Trochim
 * 2009) does not itself restate the stress formula, so this is grounded in
 * Kruskal's original definition, not the concept-mapping chapter):
 *
 *   d_ij      = configuration (Euclidean) distance in the fitted MDS space
 *   dHat_ij   = disparity — the monotone (isotonic) transform of the
 *               dissimilarity δ_ij, fit against d_ij
 *   rawStress = Σ_{i<j} w_ij (dHat_ij - d_ij)^2
 *   normalizedStress1 = sqrt( rawStress / Σ_{i<j} w_ij d_ij^2 )
 *
 * The denominator is the sum of squared CONFIGURATION distances (d_ij), not
 * the disparities and not the raw dissimilarities. This is Kruskal's
 * "Stress Formula 1" / "Stress-1" and is the definition this codebase
 * commits to under the field name `normalizedStress1`. No other stress
 * definition is ever written into that field.
 */

export type Pair = { i: number; j: number };

export function upperTrianglePairs(n: number): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) pairs.push({ i, j });
  }
  return pairs;
}

export function euclideanDistanceMatrix(points: number[][]): number[][] {
  const n = points.length;
  const dist = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sumSq = 0;
      for (let d = 0; d < points[i].length; d++) {
        const diff = points[i][d] - points[j][d];
        sumSq += diff * diff;
      }
      const dij = Math.sqrt(sumSq);
      dist[i][j] = dij;
      dist[j][i] = dij;
    }
  }
  return dist;
}

/** rawStress = Σ_{i<j} w_ij (dHat_ij - d_ij)^2 */
export function computeRawStress(
  disparity: number[][],
  distance: number[][],
  weight: number[][]
): number {
  const n = distance.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const w = weight[i][j];
      if (w <= 0) continue;
      const diff = disparity[i][j] - distance[i][j];
      sum += w * diff * diff;
    }
  }
  return sum;
}

/** normalizedStress1 = sqrt( rawStress / Σ_{i<j} w_ij d_ij^2 ). Denominator uses configuration distances. */
export function computeNormalizedStress1(
  disparity: number[][],
  distance: number[][],
  weight: number[][]
): number {
  const n = distance.length;
  let denom = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const w = weight[i][j];
      if (w <= 0) continue;
      denom += w * distance[i][j] * distance[i][j];
    }
  }
  const raw = computeRawStress(disparity, distance, weight);
  if (denom <= 0) {
    // All configuration distances are 0 (degenerate/collapsed configuration) —
    // normalized stress is undefined, not zero. Callers must treat this as a failure.
    return NaN;
  }
  return Math.sqrt(raw / denom);
}
