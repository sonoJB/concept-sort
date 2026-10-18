/**
 * Cluster solutions cut from a Ward hierarchy over 2D MDS coordinates (Ward, 1963), silhouette support
 * (Rousseeuw, 1987), and the geometry used to draw cluster boundaries (convex hull / circle / segment).
 *
 * Ward details: `wardHierarchicalClustering` (conceptAnalysis/ward.ts) runs the Lance–Williams recursion on
 * SQUARED Euclidean distances between the map points; the reported merge height is sqrt of that updated
 * squared quantity, i.e. height = sqrt(2 n_a n_b / (n_a + n_b)) * ||centroid_a - centroid_b||  (SciPy "ward" /
 * R "ward.D2"). The increase in total within-cluster sum of squares for a merge is height^2 / 2.
 * Ward is applied to the MAP coordinates, so it clusters the 2D representation, not the original δ.
 */
import { euclideanDistanceMatrix, type WardLinkageRow } from "../conceptAnalysis";
import type { Matrix } from "./matrices";

export type Point = number[];

/** Membership labels (0..k-1, arbitrary) after cutting the linkage so that k clusters remain. */
export function cutTree(linkage: WardLinkageRow[], n: number, k: number): number[] {
  if (k < 1 || k > n) throw new Error(`cutTree: k=${k} out of range 1..${n}`);
  const parent = new Map<number, number>();
  const mergesToApply = n - k;
  const find = (x: number): number => {
    let r = x;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  linkage.slice(0, mergesToApply).forEach((row, idx) => {
    const id = n + idx;
    parent.set(row.leftNode, id);
    parent.set(row.rightNode, id);
  });
  const roots = new Map<number, number>();
  const labels: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!roots.has(r)) roots.set(r, roots.size);
    labels.push(roots.get(r)!);
  }
  return labels;
}

/**
 * Canonical cluster numbering: clusters are numbered 1..k by their smallest member statement index.
 * This depends only on membership, never on the (arbitrary) orientation of the map.
 */
export function canonicalLabels(labels: number[]): number[] {
  const order: number[] = [];
  for (const l of labels) if (!order.includes(l)) order.push(l);
  return labels.map((l) => order.indexOf(l) + 1);
}

export function membershipSignature(canonical: number[]): string {
  return canonical.join(",");
}

/**
 * Silhouette (Rousseeuw, 1987): a(i) mean distance to the other members of its cluster; b(i) the smallest mean
 * distance to the members of any other cluster; s(i) = (b - a) / max(a, b); a singleton cluster gets s(i) = 0 by
 * convention. Undefined for k = 1 (returns NaN, never 0).
 */
export function silhouette(dist: Matrix, canonical: number[]): { perPoint: number[]; mean: number; perCluster: Record<number, number> } {
  const n = canonical.length;
  const k = Math.max(...canonical);
  if (k < 2) return { perPoint: new Array(n).fill(NaN), mean: NaN, perCluster: {} };
  const members: number[][] = Array.from({ length: k + 1 }, () => []);
  canonical.forEach((c, i) => members[c].push(i));
  const per: number[] = [];
  for (let i = 0; i < n; i++) {
    const own = members[canonical[i]];
    if (own.length === 1) {
      per.push(0);
      continue;
    }
    const a = own.filter((j) => j !== i).reduce((s, j) => s + dist[i][j], 0) / (own.length - 1);
    let b = Infinity;
    for (let c = 1; c <= k; c++) {
      if (c === canonical[i] || members[c].length === 0) continue;
      b = Math.min(b, members[c].reduce((s, j) => s + dist[i][j], 0) / members[c].length);
    }
    const den = Math.max(a, b);
    per.push(den > 0 ? (b - a) / den : 0);
  }
  const perCluster: Record<number, number> = {};
  for (let c = 1; c <= k; c++) perCluster[c] = members[c].reduce((s, i) => s + per[i], 0) / members[c].length;
  return { perPoint: per, mean: per.reduce((a, b) => a + b, 0) / n, perCluster };
}

export type ClusterGeometry =
  | { kind: "point"; point: Point }
  | { kind: "segment"; from: Point; to: Point }
  | { kind: "collinear"; from: Point; to: Point }
  | { kind: "polygon"; hull: Point[] };

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * Convex hull by Andrew's monotone chain (counter-clockwise, no repeated first point). Points whose cross
 * product is within `1e-12 * scale^2` of zero are treated as collinear.
 */
export function convexHull(points: Point[]): Point[] {
  const pts = points.map((p, i) => ({ p, i })).sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1]);
  if (pts.length <= 2) return pts.map((x) => x.p);
  const spanX = pts[pts.length - 1].p[0] - pts[0].p[0];
  const ys = pts.map((x) => x.p[1]);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const tol = 1e-12 * Math.max(spanX, spanY, 1e-300) ** 2;
  const lower: Point[] = [];
  for (const { p } of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= tol) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (const { p } of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= tol) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Boundary rule: 1 point -> circle marker; 2 points -> segment; collinear -> end-point segment; otherwise convex hull. */
export function clusterGeometry(points: Point[]): ClusterGeometry {
  if (points.length === 1) return { kind: "point", point: points[0] };
  if (points.length === 2) return { kind: "segment", from: points[0], to: points[1] };
  const hull = convexHull(points);
  if (hull.length < 3) return { kind: "collinear", from: hull[0], to: hull[hull.length - 1] };
  return { kind: "polygon", hull };
}

export function pointInConvexPolygon(pt: Point, hull: Point[]): boolean {
  if (hull.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const c = cross(hull[i], hull[(i + 1) % hull.length], pt);
    if (Math.abs(c) < 1e-12) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export type ClusterInfo = {
  cluster: number;
  members: number[]; // statement indices (0-based), ascending
  size: number;
  centroid: Point;
  withinSS: number;
  meanSilhouette: number;
  geometry: ClusterGeometry;
  /** statements of OTHER clusters lying inside this cluster's convex hull (visual overlap evidence) */
  foreignPointsInside: number[];
};

export type ClusterSolution = {
  k: number;
  labels: number[]; // canonical 1..k per statement
  signature: string;
  clusters: ClusterInfo[];
  totalSS: number;
  withinSS: number;
  betweenShare: number;
  silhouetteMap: { mean: number; perPoint: number[] };
  silhouetteDelta: { mean: number; perPoint: number[] };
  minSize: number;
  smallClusters: number; // clusters with <= 2 members
};

export function buildSolution(points: Point[], delta: Matrix, linkage: WardLinkageRow[], k: number): ClusterSolution {
  const n = points.length;
  const labels = canonicalLabels(cutTree(linkage, n, k));
  const mapDist = euclideanDistanceMatrix(points);
  const dim = points[0].length;
  const grand = new Array(dim).fill(0);
  for (const p of points) p.forEach((v, d) => (grand[d] += v / n));
  const totalSS = points.reduce((s, p) => s + p.reduce((q, v, d) => q + (v - grand[d]) ** 2, 0), 0);
  const smap = silhouette(mapDist, labels);
  const sdel = silhouette(delta, labels);
  let within = 0;
  const clusters: ClusterInfo[] = [];
  for (let c = 1; c <= k; c++) {
    const members = labels.map((l, i) => (l === c ? i : -1)).filter((i) => i >= 0);
    const centroid = new Array(dim).fill(0);
    for (const i of members) points[i].forEach((v, d) => (centroid[d] += v / members.length));
    const ss = members.reduce((s, i) => s + points[i].reduce((q, v, d) => q + (v - centroid[d]) ** 2, 0), 0);
    within += ss;
    const geometry = clusterGeometry(members.map((i) => points[i]));
    const foreign =
      geometry.kind === "polygon" ? points.map((_, i) => i).filter((i) => labels[i] !== c && pointInConvexPolygon(points[i], geometry.hull)) : [];
    clusters.push({ cluster: c, members, size: members.length, centroid, withinSS: ss, meanSilhouette: smap.perCluster[c] ?? NaN, geometry, foreignPointsInside: foreign });
  }
  return {
    k,
    labels,
    signature: membershipSignature(labels),
    clusters,
    totalSS,
    withinSS: within,
    betweenShare: totalSS > 0 ? 1 - within / totalSS : NaN,
    silhouetteMap: { mean: smap.mean, perPoint: smap.perPoint },
    silhouetteDelta: { mean: sdel.mean, perPoint: sdel.perPoint },
    minSize: Math.min(...clusters.map((c) => c.size)),
    smallClusters: clusters.filter((c) => c.size <= 2).length,
  };
}

export type MergeRow = { step: number; left: number; right: number; height: number; wssIncrease: number; sizeAfter: number; clustersAfter: number };

/** Full merge history with the Ward cost (increase in within-cluster SS = height^2 / 2). */
export function mergeHistory(linkage: WardLinkageRow[], n: number): MergeRow[] {
  return linkage.map((r, idx) => ({ step: idx + 1, left: r.leftNode, right: r.rightNode, height: r.mergeDistance, wssIncrease: (r.mergeDistance * r.mergeDistance) / 2, sizeAfter: r.mergedItemCount, clustersAfter: n - idx - 1 }));
}

/** How the partition into k clusters relates to k-1 (which two k-clusters were merged) — hierarchical nesting. */
export function mergedPair(a: ClusterSolution, b: ClusterSolution): { fromK: number; toK: number; merged: [number, number] } | null {
  // a has k clusters, b has k-1: find the two clusters of `a` whose members share one cluster in `b`
  if (a.k !== b.k + 1) return null;
  const seen = new Map<number, number[]>();
  a.clusters.forEach((c) => {
    const target = b.labels[c.members[0]];
    seen.set(target, [...(seen.get(target) ?? []), c.cluster]);
  });
  for (const [, cs] of seen) if (cs.length === 2) return { fromK: a.k, toK: b.k, merged: [cs[0], cs[1]] };
  return null;
}
