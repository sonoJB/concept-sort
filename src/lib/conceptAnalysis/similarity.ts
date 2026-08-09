import type { FixtureSession, Matrix } from "./types";

/**
 * Group similarity matrix construction, matching the Trochim procedure
 * verified in the design-review phase: each participant's sort is converted
 * to a binary symmetric matrix (1 = placed together, 0 = not), and these are
 * SUMMED across participants to form the group similarity (count) matrix.
 * The proportion matrix divides by the number of valid participants.
 *
 * Diagonal is excluded from analysis (self-pairs are not meaningful
 * observations) and is always set to 0 in the returned count/proportion
 * matrices — NOT 1, so it can never be mistaken for "every participant
 * grouped statement i with itself" and never enters MDS as data (the weight
 * matrix in dissimilarity.ts independently sets diagonal weight to 0, which
 * is the actual mechanism keeping the diagonal out of the fit).
 *
 * A genuine off-diagonal value of 0 (two statements NEVER co-sorted) or of
 * `validSessionCount` (ALWAYS co-sorted, proportion 1, dissimilarity 0) is a
 * fully valid, meaningful observation and must never be treated as missing.
 */
export function buildSimilarityCountMatrix(
  statementIds: string[],
  sessions: FixtureSession[]
): Matrix {
  const n = statementIds.length;
  const index = new Map(statementIds.map((id, i) => [id, i]));
  const count: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));

  for (const session of sessions) {
    for (const group of session.groups) {
      const memberIndices = group
        .map((id) => index.get(id))
        .filter((i): i is number => i !== undefined);

      for (let a = 0; a < memberIndices.length; a++) {
        for (let b = a + 1; b < memberIndices.length; b++) {
          const i = memberIndices[a];
          const j = memberIndices[b];
          count[i][j] += 1;
          count[j][i] += 1;
        }
      }
    }
  }

  return count;
}

export function buildSimilarityProportionMatrix(
  countMatrix: Matrix,
  validSessionCount: number
): Matrix {
  const n = countMatrix.length;
  const proportion: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  if (validSessionCount <= 0) {
    // N=0: proportions are undefined, not zero — caller must not treat this as "no similarity".
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) proportion[i][j] = NaN;
    return proportion;
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      proportion[i][j] = countMatrix[i][j] / validSessionCount;
    }
  }
  return proportion;
}

export function assertSquareSymmetric(matrix: Matrix, label: string, eps = 1e-9): void {
  const n = matrix.length;
  for (const row of matrix) {
    if (row.length !== n) throw new Error(`${label}: not square (row length ${row.length} != ${n})`);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = matrix[i][j];
      const b = matrix[j][i];
      const bothNaN = Number.isNaN(a) && Number.isNaN(b);
      if (!bothNaN && Math.abs(a - b) > eps) {
        throw new Error(`${label}: not symmetric at [${i}][${j}]=${a} vs [${j}][${i}]=${b}`);
      }
    }
  }
}
