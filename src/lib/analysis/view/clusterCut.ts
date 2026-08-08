import { cutTreeToKClusters, type WardResult } from "@/lib/conceptAnalysis";

export type ClusterAssignment = {
  statementId: string;
  /** 1..k, deterministic — never the raw 0-based conceptAnalysis label. */
  clusterIndex: number;
};

export type ClusterCentroid = {
  clusterIndex: number;
  x: number;
  y: number;
  memberCount: number;
};

/**
 * Wraps the verified engine's own cutTreeToKClusters (reused unmodified,
 * not reimplemented) and remaps its arbitrary 0-based labels to a
 * deterministic 1..k numbering ordered by each cluster's first appearance
 * in statement order — so the same (linkage, k) always produces the same
 * numbering, tied stably to statement order as required.
 */
export function cutClusters(
  ward: WardResult,
  orderedStatementIds: string[],
  k: number
): ClusterAssignment[] {
  if (!Number.isInteger(k) || k < 2 || k > orderedStatementIds.length) {
    throw new RangeError(
      `cutClusters: k must be an integer in [2, ${orderedStatementIds.length}], got ${k}`
    );
  }
  const rawLabels = cutTreeToKClusters(ward, k);

  const labelToIndex = new Map<number, number>();
  let nextIndex = 1;
  for (const label of rawLabels) {
    if (!labelToIndex.has(label)) {
      labelToIndex.set(label, nextIndex);
      nextIndex++;
    }
  }

  return orderedStatementIds.map((statementId, i) => ({
    statementId,
    clusterIndex: labelToIndex.get(rawLabels[i])!,
  }));
}

/**
 * Cluster centroids: the arithmetic mean of the 2D MDS coordinates of a
 * cluster's members. This is a descriptive presentation/export value, not a
 * change to the Ward algorithm itself — Ward never produces coordinates or
 * centroids on its own.
 */
export function computeCentroids(
  assignments: ClusterAssignment[],
  coordinatesByStatementId: Map<string, [number, number]>
): ClusterCentroid[] {
  const sums = new Map<number, { x: number; y: number; count: number }>();
  for (const a of assignments) {
    const point = coordinatesByStatementId.get(a.statementId);
    if (!point) continue;
    const acc = sums.get(a.clusterIndex) ?? { x: 0, y: 0, count: 0 };
    acc.x += point[0];
    acc.y += point[1];
    acc.count += 1;
    sums.set(a.clusterIndex, acc);
  }
  return Array.from(sums.entries())
    .map(([clusterIndex, { x, y, count }]) => ({
      clusterIndex,
      x: x / count,
      y: y / count,
      memberCount: count,
    }))
    .sort((a, b) => a.clusterIndex - b.clusterIndex);
}
