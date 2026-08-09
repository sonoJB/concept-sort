import type { Matrix, WeightMatrix } from "./types";

/**
 * dissimilarity[i][j] = 1 - proportion[i][j]
 *
 * A proportion of 1 (every valid participant grouped i and j together)
 * yields a dissimilarity of exactly 0 — a fully valid, non-missing
 * observation representing perfect similarity, not an error.
 */
export function buildDissimilarityMatrix(proportionMatrix: Matrix): Matrix {
  const n = proportionMatrix.length;
  const dissimilarity: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const p = proportionMatrix[i][j];
      dissimilarity[i][j] = Number.isNaN(p) ? NaN : 1 - p;
    }
  }
  return dissimilarity;
}

/**
 * Explicit weight matrix for MDS fitting: diagonal is always 0 (self-pairs
 * are never part of the fit). Off-diagonal defaults to 1 (every statement
 * pair is a fully observed comparison in this domain — a dissimilarity of 0
 * from "always co-sorted" is a real value, not a missing one). `missingPairs`
 * lets a caller mark genuinely absent observations (e.g. a statement pair
 * that literally cannot be compared for some future data-quality reason);
 * this is never inferred automatically from a 0 dissimilarity.
 */
export function buildWeightMatrix(n: number, missingPairs?: Set<string>): WeightMatrix {
  const weight: WeightMatrix = Array.from({ length: n }, () => new Array(n).fill(1));
  for (let i = 0; i < n; i++) weight[i][i] = 0;
  if (missingPairs) {
    for (const key of missingPairs) {
      const [a, b] = key.split(",").map(Number);
      if (Number.isInteger(a) && Number.isInteger(b) && a !== b) {
        weight[a][b] = 0;
        weight[b][a] = 0;
      }
    }
  }
  return weight;
}

export function missingPairKey(i: number, j: number): string {
  return i < j ? `${i},${j}` : `${j},${i}`;
}
