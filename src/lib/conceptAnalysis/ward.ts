/**
 * Ward's minimum-variance agglomerative hierarchical clustering, self-
 * implemented via the Lance–Williams recursive update formula (Lance &
 * Williams, 1967; the same recursion Murtagh & Legendre, 2014 "Ward's
 * hierarchical agglomerative clustering method: which algorithms implement
 * Ward's criterion?" identify as equivalent to R's `hclust(method="ward.D2")`
 * and to SciPy's `linkage(X, method="ward")` when the input is raw Euclidean
 * coordinates).
 *
 * `ml-hclust` (npm) was deliberately NOT adopted as a dependency this
 * step per instructions — its Ward implementation's exact formula and its
 * ward.D vs ward.D2 correspondence were not independently confirmed here
 * (no execution environment to compare outputs), so this prototype uses a
 * from-scratch implementation whose formula is fully documented and testable
 * in isolation, rather than trusting an unverified external package.
 *
 * Ward criterion: at each step, merge the two clusters whose combination
 * produces the smallest increase in total within-cluster sum of squared
 * Euclidean distances (ESS). Starting from squared Euclidean distances
 * between singleton points, the Lance–Williams update for merging clusters
 * i and j (sizes n_i, n_j) and updating distance to cluster k (size n_k) is:
 *
 *   d(i∪j, k) = [ (n_i+n_k)*d(i,k) + (n_j+n_k)*d(j,k) - n_k*d(i,j) ] / (n_i+n_j+n_k)
 *
 * where all d(.,.) here are SQUARED distances. The merge height reported in
 * `mergeDistance` is sqrt(d(i,j)) at the step of merging — matching what
 * SciPy reports for method="ward" (a distance, not a variance).
 *
 * Input MUST be Euclidean point coordinates (typically 2D or 3D MDS output),
 * never a pre-computed dissimilarity/distance matrix — Ward's criterion is
 * only meaningful relative to a real coordinate space where centroids and
 * sums-of-squares are well defined.
 */
import { euclideanDistanceMatrix } from "./stress";
import type { Point, WardLinkageRow, WardResult } from "./types";

export function wardHierarchicalClustering(points: Point[]): WardResult {
  const n = points.length;
  if (n < 2) {
    throw new Error("wardHierarchicalClustering: requires at least 2 points.");
  }

  const distances = euclideanDistanceMatrix(points);
  // Working squared-distance matrix between *current* clusters, indexed by
  // an ever-growing cluster-id map (scipy convention: original points are
  // ids 0..n-1; each merge creates a new id n, n+1, ...).
  const d: Map<number, Map<number, number>> = new Map();
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(i);
    d.set(i, new Map());
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sq = distances[i][j] * distances[i][j];
      d.get(i)!.set(j, sq);
      d.get(j)!.set(i, sq);
    }
  }

  const size = new Map<number, number>(ids.map((id) => [id, 1]));
  const active = new Set(ids);
  const linkage: WardLinkageRow[] = [];
  let nextId = n;

  for (let step = 0; step < n - 1; step++) {
    let bestA = -1;
    let bestB = -1;
    let bestDist = Infinity;
    const activeArr = [...active];
    for (let x = 0; x < activeArr.length; x++) {
      for (let y = x + 1; y < activeArr.length; y++) {
        const a = activeArr[x];
        const b = activeArr[y];
        const dist = d.get(a)!.get(b)!;
        if (dist < bestDist) {
          bestDist = dist;
          bestA = a;
          bestB = b;
        }
      }
    }

    const na = size.get(bestA)!;
    const nb = size.get(bestB)!;
    const merged = nextId++;
    const mergedSize = na + nb;

    // Ordering convention (matches scipy): leftNode/rightNode reported as
    // (min, max) of the two original ids being merged at this step — not
    // necessarily original singleton indices once earlier merges occurred.
    const leftNode = Math.min(bestA, bestB);
    const rightNode = Math.max(bestA, bestB);

    linkage.push({
      step,
      leftNode,
      rightNode,
      mergeDistance: Math.sqrt(Math.max(bestDist, 0)),
      mergedItemCount: mergedSize,
    });

    // Lance-Williams Ward update for every other active cluster k.
    const newRow = new Map<number, number>();
    for (const k of active) {
      if (k === bestA || k === bestB) continue;
      const nk = size.get(k)!;
      const dik = d.get(bestA)!.get(k)!;
      const djk = d.get(bestB)!.get(k)!;
      const dij = bestDist;
      const updated =
        ((na + nk) * dik + (nb + nk) * djk - nk * dij) / (na + nb + nk);
      newRow.set(k, updated);
      d.get(k)!.set(merged, updated);
    }

    active.delete(bestA);
    active.delete(bestB);
    active.add(merged);
    d.set(merged, newRow);
    size.set(merged, mergedSize);
  }

  return { linkage, originalCount: n };
}

/**
 * Cuts the linkage tree to produce k flat clusters, returning a 0-based
 * cluster label per original point index (0..n-1). Labels are arbitrary
 * (not stable across k) — compare partitions by co-membership, not by label
 * number, exactly as instructed.
 */
export function cutTreeToKClusters(result: WardResult, k: number): number[] {
  const { linkage, originalCount: n } = result;
  const targetK = Math.max(1, Math.min(k, n));
  const stepsToApply = n - targetK; // merges 0..stepsToApply-1 get applied

  // Union-find over original points + merged ids.
  const parent = new Map<number, number>();
  function find(x: number): number {
    let root = x;
    while (parent.has(root)) root = parent.get(root)!;
    let cur = x;
    while (parent.has(cur)) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  let nextId = n;
  for (let step = 0; step < stepsToApply; step++) {
    const row = linkage[step];
    const merged = nextId++;
    parent.set(find(row.leftNode), merged);
    parent.set(find(row.rightNode), merged);
  }

  const rootToLabel = new Map<number, number>();
  const labels = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!rootToLabel.has(root)) rootToLabel.set(root, rootToLabel.size);
    labels[i] = rootToLabel.get(root)!;
  }
  return labels;
}

/** Partition equivalence check: same grouping regardless of label numbering. */
export function partitionsEquivalent(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const mapAtoB = new Map<number, number>();
  const mapBtoA = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    const la = a[i];
    const lb = b[i];
    if (mapAtoB.has(la) && mapAtoB.get(la) !== lb) return false;
    if (mapBtoA.has(lb) && mapBtoA.get(lb) !== la) return false;
    mapAtoB.set(la, lb);
    mapBtoA.set(lb, la);
  }
  return true;
}
