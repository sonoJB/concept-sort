/**
 * Hand-verification of Ward's criterion: the increase in total within-
 * cluster sum-of-squares (ESS) when merging two clusters equals
 * (n_i*n_j/(n_i+n_j)) * ||centroid_i - centroid_j||^2 for singleton-vs-
 * singleton merges, which reduces to simply the squared Euclidean distance
 * for two singletons (n_i=n_j=1: (1*1/2)*d^2 ... wait for TWO singletons
 * the classic identity is ESS increase = (n_i*n_j/(n_i+n_j)) * d^2 =
 * (1*1/2)*d^2 = d^2/2). This script directly computes ESS before/after for
 * a small merge and compares to the Lance-Williams-derived mergeDistance.
 */
import { wardHierarchicalClustering } from "../../src/lib/conceptAnalysis";

const points = [
  [0, 0],
  [1, 0],
  [5, 5],
];

function ess(cluster: number[][]): number {
  const dim = cluster[0].length;
  const centroid = new Array(dim).fill(0);
  for (const p of cluster) for (let d = 0; d < dim; d++) centroid[d] += p[d] / cluster.length;
  let sum = 0;
  for (const p of cluster) for (let d = 0; d < dim; d++) sum += (p[d] - centroid[d]) ** 2;
  return sum;
}

// Direct ESS-increase computation for merging points 0 and 1 (both singletons):
const essBefore = ess([points[0]]) + ess([points[1]]); // = 0 + 0 = 0
const essAfterMerge01 = ess([points[0], points[1]]);
const directIncrease = essAfterMerge01 - essBefore;
console.log("Direct ESS increase for merging points 0,1:", directIncrease);

const dx = points[0][0] - points[1][0];
const dy = points[0][1] - points[1][1];
const squaredDist = dx * dx + dy * dy;
console.log("squared Euclidean distance(0,1):", squaredDist, "  expected ESS increase = d^2/2 =", squaredDist / 2);

const ward = wardHierarchicalClustering(points);
console.log("Ward linkage:", JSON.stringify(ward.linkage, null, 2));
// mergeDistance reported is sqrt(Lance-Williams value). Lance-Williams value
// for two singletons equals the raw squared distance (n_i=n_j=1 case reduces
// trivially: the LW recursion starts from raw squared distances directly).
const firstMerge = ward.linkage[0];
console.log("First merge distance:", firstMerge.mergeDistance, " sqrt(squaredDist)=", Math.sqrt(squaredDist));

const ok =
  Math.abs(directIncrease - squaredDist / 2) < 1e-9 &&
  firstMerge.leftNode === 0 &&
  firstMerge.rightNode === 1 &&
  Math.abs(firstMerge.mergeDistance - Math.sqrt(squaredDist)) < 1e-9;
console.log(ok ? "OK: Ward merge distance matches direct squared-Euclidean-distance derivation for a singleton pair" : "FAIL: mismatch");
if (!ok) process.exitCode = 1;
