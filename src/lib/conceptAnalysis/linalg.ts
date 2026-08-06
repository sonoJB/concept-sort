/**
 * Minimal linear algebra needed for SMACOF's weighted Guttman transform.
 * Self-contained (not shared with src/lib/mds.ts) so the existing app code
 * stays untouched. Small n (statement counts, typically well under 100),
 * so a classic cyclic Jacobi eigensolver is fine — no external dependency.
 */

export function matMul(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = b[0]?.length ?? 0;
  const k = b.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const aip = a[i][p];
      if (aip === 0) continue;
      for (let j = 0; j < m; j++) out[i][j] += aip * b[p][j];
    }
  }
  return out;
}

/** Jacobi eigenvalue algorithm for a real symmetric matrix. */
export function jacobiEigen(matrix: number[][], maxSweeps = 200, epsilon = 1e-12) {
  const n = matrix.length;
  const a = matrix.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let offDiagonalSum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) offDiagonalSum += a[i][j] * a[i][j];
    }
    if (offDiagonalSum < epsilon) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < epsilon) continue;

        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        const app = a[p][p];
        const aqq = a[q][q];
        const apq = a[p][q];

        a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        a[p][q] = 0;
        a[q][p] = 0;

        for (let i = 0; i < n; i++) {
          if (i !== p && i !== q) {
            const aip = a[i][p];
            const aiq = a[i][q];
            a[i][p] = c * aip - s * aiq;
            a[p][i] = a[i][p];
            a[i][q] = s * aip + c * aiq;
            a[q][i] = a[i][q];
          }
        }
        for (let i = 0; i < n; i++) {
          const vip = v[i][p];
          const viq = v[i][q];
          v[i][p] = c * vip - s * viq;
          v[i][q] = s * vip + c * viq;
        }
      }
    }
  }

  const eigenvalues = a.map((row, i) => row[i]);
  const eigenvectors = v[0].map((_, col) => v.map((row) => row[col])); // eigenvectors[k] is the k-th eigenvector
  return { eigenvalues, eigenvectors };
}

/**
 * Moore-Penrose pseudoinverse of a real symmetric matrix, via eigendecomposition:
 * V = Q Λ Q^T  =>  V^+ = Q Λ^+ Q^T, where Λ^+ inverts eigenvalues above
 * `tolerance` and zeroes the (near-)null-space ones. This is exactly what
 * SMACOF's Guttman transform needs for V (which is singular by construction —
 * its row/column sums are zero).
 */
export function symmetricPseudoInverse(matrix: number[][], tolerance = 1e-9): number[][] {
  const n = matrix.length;
  const { eigenvalues, eigenvectors } = jacobiEigen(matrix);
  const maxAbs = Math.max(...eigenvalues.map((v) => Math.abs(v)), 1e-15);

  const result = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let k = 0; k < n; k++) {
    const lambda = eigenvalues[k];
    if (Math.abs(lambda) <= tolerance * maxAbs) continue; // treat as null space
    const inv = 1 / lambda;
    const vec = eigenvectors[k];
    for (let i = 0; i < n; i++) {
      const vi = vec[i];
      if (vi === 0) continue;
      for (let j = 0; j < n; j++) {
        result[i][j] += inv * vi * vec[j];
      }
    }
  }
  return result;
}
