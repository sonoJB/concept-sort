/**
 * Classical (metric) multidimensional scaling, implemented from scratch with
 * a Jacobi eigenvalue algorithm so no external linear-algebra dependency is
 * needed for a simple 2D projection.
 */

export type Point2D = { x: number; y: number };

/** Jacobi eigenvalue algorithm for a real symmetric matrix. */
function jacobiEigen(matrix: number[][], maxSweeps = 100, epsilon = 1e-10) {
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
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
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
  const eigenvectors = v[0].map((_, col) => v.map((row) => row[col]));

  return { eigenvalues, eigenvectors };
}

/**
 * Computes 2D coordinates for `n` items from an `n x n` distance matrix using
 * classical MDS (double-centering + top-2 eigenvectors).
 */
export function classicalMDS(distanceMatrix: number[][]): Point2D[] {
  const n = distanceMatrix.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: 0, y: 0 }];

  const squared = distanceMatrix.map((row) => row.map((d) => d * d));

  const rowMeans = squared.map(
    (row) => row.reduce((sum, v) => sum + v, 0) / n
  );
  const grandMean =
    rowMeans.reduce((sum, v) => sum + v, 0) / n;

  const b = squared.map((row, i) =>
    row.map((val, j) => -0.5 * (val - rowMeans[i] - rowMeans[j] + grandMean))
  );

  const { eigenvalues, eigenvectors } = jacobiEigen(b);

  const order = eigenvalues
    .map((value, i) => ({ value, i }))
    .sort((a, c) => c.value - a.value)
    .slice(0, 2);

  return Array.from({ length: n }, (_, i) => {
    const coords = order.map(({ value, i: axis }) => {
      const scale = value > 0 ? Math.sqrt(value) : 0;
      return eigenvectors[axis][i] * scale;
    });
    return { x: coords[0] ?? 0, y: coords[1] ?? 0 };
  });
}
