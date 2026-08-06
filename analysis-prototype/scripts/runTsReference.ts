/**
 * Reads the shared fixtures JSON (exportFixtures.ts output) and runs the
 * TypeScript SMACOF/Ward implementation against it, writing result JSON
 * files for compareReferences.ts to consume alongside the Python/R outputs.
 *
 * The fixtures JSON's shape is defined by exportFixtures.ts in this same
 * directory (not by src/lib/conceptAnalysis, which knows nothing about
 * JSON I/O) — `any` is used for the parsed document here deliberately,
 * matching that this is a standalone CI script, not app code.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import {
  runSmacofFromInitialConfiguration,
  runDimensionDiagnostics,
  wardHierarchicalClustering,
  cutTreeToKClusters,
  euclideanDistanceMatrix,
} from "../../src/lib/conceptAnalysis";

const fixturesPath = process.argv[2];
const outputDir = process.argv[3];
if (!fixturesPath || !outputDir) {
  console.error("Usage: runTsReference.ts <fixtures.json> <output-dir>");
  process.exit(1);
}
fs.mkdirSync(outputDir, { recursive: true });

const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf-8"));

// ---- SMACOF (single shared-init run, matching the Python/R comparison) ----
const smacofResults: Record<string, unknown> = {};
for (const [key, fx] of Object.entries<any>(fixtures.mds)) {
  const result = runSmacofFromInitialConfiguration(fx.dissimilarity, fx.weight, fx.initialCoordinates, {
    maxIter: fx.maxIter,
    eps: fx.eps,
  });
  const pairwiseDistance = result.coordinates ? euclideanDistanceMatrix(result.coordinates) : null;
  smacofResults[key] = {
    errorCode: result.errorCode ?? null,
    coordinates: result.coordinates,
    pairwiseDistance,
    rawStress: result.rawStress,
    normalizedStress1: result.normalizedStress1,
    converged: result.converged,
    iterations: result.iterations,
    stressHistory: result.stressHistory,
    stressMonotoneNonIncreasing: result.stressHistory.every((v, i) => i === 0 || v <= result.stressHistory[i - 1] + 1e-7),
  };
}
fs.writeFileSync(path.join(outputDir, "ts-smacof-results.json"), JSON.stringify(smacofResults, null, 2));

// ---- Dimension diagnostics (multi-init, on the zero-free fixture only) ----
const zeroFree = fixtures.mds.zeroFree;
const diag = runDimensionDiagnostics(zeroFree.dissimilarity, zeroFree.weight, {
  randomSeed: 42,
  nInit: 8,
  maxIter: zeroFree.maxIter,
  eps: zeroFree.eps,
  maxDimension: 6,
});
fs.writeFileSync(
  path.join(outputDir, "ts-diagnostics-results.json"),
  JSON.stringify(
    {
      primaryMapDimension: diag.primaryMapDimension,
      diagnosticPreferredDimension: diag.diagnosticPreferredDimension,
      diagnosticReasonCodes: diag.diagnosticReasonCodes,
      diagnostics: diag.diagnostics,
    },
    null,
    2
  )
);

// ---- Ward ----
const wardPoints = fixtures.ward.tieFree.points;
const ward = wardHierarchicalClustering(wardPoints);
const candidates: Record<string, number[]> = {};
for (let k = 1; k <= wardPoints.length; k++) {
  candidates[String(k)] = cutTreeToKClusters(ward, k);
}
fs.writeFileSync(
  path.join(outputDir, "ts-ward-results.json"),
  JSON.stringify(
    {
      linkage: ward.linkage,
      originalCount: ward.originalCount,
      candidatePartitions: candidates,
    },
    null,
    2
  )
);

// ---- Version metadata ----
fs.writeFileSync(
  path.join(outputDir, "ts-version-metadata.json"),
  JSON.stringify(
    {
      nodeVersion: process.version,
      algorithmVersion: fixtures.meta.algorithmVersion,
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2
  )
);

console.log("TS reference results written to:", outputDir);
