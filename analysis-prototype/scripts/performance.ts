/**
 * Performance measurement on the 47-statement fixture (neutral synthetic
 * ids, no real research content). Measures actual wall-clock time and
 * approximate memory for 1D-6D SMACOF + Ward, at a couple of nInit/maxIter
 * settings. Reports real numbers only — no assumed operating thresholds.
 */
import {
  filterSessionsForScope,
  buildSimilarityCountMatrix,
  buildSimilarityProportionMatrix,
  buildDissimilarityMatrix,
  buildWeightMatrix,
  runSmacof,
  wardHierarchicalClustering,
} from "../../src/lib/conceptAnalysis";
import { buildFixtureH } from "../fixtures/fixtures";

console.log("Node version:", process.version);

const { project, sessions } = buildFixtureH(60); // 60 synthetic participants
const filtered = filterSessionsForScope(project, sessions, "ALL");
console.log(`Fixture H: ${project.statementIds.length} statements, ${filtered.nTotal} valid pooled sessions (KR=${filtered.nKr}, JP=${filtered.nJp})`);

const count = buildSimilarityCountMatrix(project.statementIds, filtered.validSessions);
const proportion = buildSimilarityProportionMatrix(count, filtered.nTotal);
const dissimilarity = buildDissimilarityMatrix(proportion);
const weight = buildWeightMatrix(project.statementIds.length);

function memMB() {
  return (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
}

const settings = [
  { nInit: 4, maxIter: 200, label: "light (nInit=4, maxIter=200)" },
  { nInit: 8, maxIter: 300, label: "default-candidate (nInit=8, maxIter=300)" },
];

for (const setting of settings) {
  console.log(`\n--- Setting: ${setting.label} ---`);
  let totalMs = 0;
  for (const dimension of [1, 2, 3, 4, 5, 6] as const) {
    const start = process.hrtime.bigint();
    const result = runSmacof(dissimilarity, weight, {
      algorithm: "SMACOF",
      metric: false,
      dimension,
      normalizedStress: true,
      randomSeed: 42,
      nInit: setting.nInit,
      maxIter: setting.maxIter,
      eps: 1e-9,
      tieHandling: "secondary",
    });
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    totalMs += ms;
    console.log(
      `  dim=${dimension}: ${ms.toFixed(1)}ms, stress=${result.normalizedStress1?.toFixed(5)}, converged=${result.converged}, heap=${memMB()}MB`
    );
  }
  console.log(`  TOTAL (1D-6D, ${setting.nInit} inits each): ${totalMs.toFixed(1)}ms`);
}

// Ward timing on the 2D result from the last (heavier) setting.
const mds2d = runSmacof(dissimilarity, weight, {
  algorithm: "SMACOF",
  metric: false,
  dimension: 2,
  normalizedStress: true,
  randomSeed: 42,
  nInit: 8,
  maxIter: 300,
  eps: 1e-9,
  tieHandling: "secondary",
});
const wardStart = process.hrtime.bigint();
const ward = wardHierarchicalClustering(mds2d.coordinates!);
const wardEnd = process.hrtime.bigint();
console.log(`\nWard HCA on 47 points (2D coords): ${(Number(wardEnd - wardStart) / 1e6).toFixed(1)}ms, ${ward.linkage.length} merge steps`);

console.log(`\nPeak-ish heap at end: ${memMB()}MB`);
