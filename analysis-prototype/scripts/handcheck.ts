/**
 * Hand-verifiable check for fixture A (3 points). With only 3 points,
 * ANY 3 mutually-consistent distances (satisfying the triangle inequality)
 * can be embedded in 2D with ZERO stress by construction (3 points always
 * fit exactly in a plane). This lets us hand-derive the expected result
 * and confirm the implementation reaches it, rather than trusting the
 * optimizer blindly.
 */
import { runSmacof, buildWeightMatrix, euclideanDistanceMatrix } from "../../src/lib/conceptAnalysis";
import { fixtureA_dissimilarity } from "../fixtures/fixtures";

// Hand-derivation: triangle with sides d(0,1)=0.2, d(0,2)=0.8, d(1,2)=0.6.
// Place point 0 at origin, point 1 at (0.2, 0).
// Point 2: distance 0.8 from point0, 0.6 from point1.
// x^2 + y^2 = 0.64
// (x-0.2)^2 + y^2 = 0.36  =>  x^2 -0.4x +0.04 + y^2 = 0.36 => 0.64 -0.4x+0.04=0.36 => x = (0.64+0.04-0.36)/0.4 = 0.32/0.4 = 0.8
// y^2 = 0.64 - 0.64 = 0 => y = 0
const handDerivedPoint2X = (0.8 ** 2 + 0.2 ** 2 - 0.6 ** 2) / (2 * 0.2);
console.log("Hand-derived point 2 x-coordinate (collinear degenerate triangle):", handDerivedPoint2X);
// Note: 0.2 + 0.6 = 0.8 exactly, so this triangle is DEGENERATE (collinear) —
// points 0,1,2 lie exactly on a line. This is a deliberately chosen edge case:
// the "2D" embedding is actually exactly 1D-representable with zero stress.

const result = runSmacof(fixtureA_dissimilarity, buildWeightMatrix(3), {
  algorithm: "SMACOF", metric: false, dimension: 2, normalizedStress: true,
  randomSeed: 1, nInit: 6, maxIter: 300, eps: 1e-12, tieHandling: "secondary",
});
console.log("SMACOF result stress:", result.normalizedStress1, "converged:", result.converged);
console.log("coordinates:", JSON.stringify(result.coordinates));
const dist = euclideanDistanceMatrix(result.coordinates!);
console.log("recovered distances:", JSON.stringify(dist));
console.log("original dissimilarities:", JSON.stringify(fixtureA_dissimilarity));

const ok = (result.normalizedStress1 ?? 1) < 1e-4;
console.log(ok ? "OK: fixture A (degenerate collinear triangle) reaches ~zero stress as hand-derived" : "FAIL: fixture A did not reach expected near-zero stress");
if (!ok) process.exitCode = 1;
