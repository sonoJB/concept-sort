/**
 * Agglomerative hierarchical clustering (average linkage) over a distance
 * matrix, cut to a target number of clusters.
 */
export function hierarchicalClusters(
  distanceMatrix: number[][],
  k: number
): number[] {
  const n = distanceMatrix.length;
  if (n === 0) return [];
  const targetK = Math.max(1, Math.min(k, n));

  // Each cluster starts as its own group of original item indices.
  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);
  // Working distance matrix between current clusters (average linkage).
  let dist = distanceMatrix.map((row) => [...row]);

  const averageLinkageDistance = (
    a: number[],
    b: number[],
    original: number[][]
  ) => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += original[i][j];
    return sum / (a.length * b.length);
  };

  while (clusters.length > targetK) {
    let bestI = 0;
    let bestJ = 1;
    let bestDist = Infinity;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (dist[i][j] < bestDist) {
          bestDist = dist[i][j];
          bestI = i;
          bestJ = j;
        }
      }
    }

    const merged = [...clusters[bestI], ...clusters[bestJ]];
    const remaining = clusters.filter(
      (_, idx) => idx !== bestI && idx !== bestJ
    );
    remaining.push(merged);
    clusters = remaining;

    dist = clusters.map((a) =>
      clusters.map((b) =>
        a === b ? 0 : averageLinkageDistance(a, b, distanceMatrix)
      )
    );
  }

  const labels = new Array(n).fill(0);
  clusters.forEach((cluster, clusterId) => {
    for (const itemIndex of cluster) labels[itemIndex] = clusterId;
  });
  return labels;
}

export function defaultClusterCount(itemCount: number): number {
  if (itemCount <= 1) return 1;
  return Math.max(2, Math.min(itemCount - 1, Math.round(Math.sqrt(itemCount / 2))));
}
