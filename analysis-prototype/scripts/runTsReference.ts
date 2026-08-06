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
  upperTrianglePairs,
  isotonicRegressionByRank,
} from "../../src/lib/conceptAnalysis";

const fixturesPath = process.argv[2];
const outputDir = process.argv[3];
if (!fixturesPath || !outputDir) {
  console.error("Usage: runTsReference.ts <fixtures.json> <output-dir>");
  process.exit(1);
}
fs.mkdirSync(outputDir, { recursive: true });

const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf-8"));

/**
 * Independently recomputes every stress-related quantity by name, using the
 * SAME public functions the engine itself uses (isotonicRegressionByRank,
 * upperTrianglePairs) but called directly from this diagnostic script, not
 * from inside src/lib/conceptAnalysis. This mirrors ci_python.py's
 * stress_breakdown() and ci_r.R's diagnostics so all three implementations
 * report distinctly-named values for direct comparison (see
 * compareReferences.ts §6/§7 in the attempt-4 request).
 */
function stressBreakdown(dissimilarity: number[][], distance: number[][], weight: number[][]) {
  const n = distance.length;
  const pairs = upperTrianglePairs(n).filter(({ i, j }) => weight[i][j] > 0);
  const observations = pairs.map(({ i, j }) => ({
    rankKey: dissimilarity[i][j],
    value: distance[i][j],
    weight: weight[i][j],
  }));
  const fitted = isotonicRegressionByRank(observations);

  let rss = 0;
  let sumSquaredDistances = 0;
  let sumSquaredDisparities = 0;
  const disparities: { i: number; j: number; dissimilarity: number; disparity: number }[] = [];
  pairs.forEach(({ i, j }, idx) => {
    const dHat = fitted[idx];
    const dij = distance[i][j];
    rss += (dHat - dij) ** 2;
    sumSquaredDistances += dij * dij;
    sumSquaredDisparities += dHat * dHat;
    disparities.push({ i, j, dissimilarity: dissimilarity[i][j], disparity: dHat });
  });

  const stress1DistanceDenominator = sumSquaredDistances > 0 ? Math.sqrt(rss / sumSquaredDistances) : null;
  const stress1DisparityDenominator = sumSquaredDisparities > 0 ? Math.sqrt(rss / sumSquaredDisparities) : null;

  return {
    rss,
    sumSquaredDistances,
    sumSquaredDisparities,
    stress1DistanceDenominator,
    stress1DisparityDenominator,
    disparities,
    activePairCount: pairs.length,
  };
}

const SNAPSHOT_ITERS = [1, 2, 5, 10, 19];

// ---- SMACOF (single shared-init run, matching the Python/R comparison) ----
const smacofResults: Record<string, unknown> = {};
const smacofSnapshots: Record<string, unknown> = {};
for (const [key, fx] of Object.entries<any>(fixtures.mds)) {
  const result = runSmacofFromInitialConfiguration(fx.dissimilarity, fx.weight, fx.initialCoordinates, {
    maxIter: fx.maxIter,
    eps: fx.eps,
  });
  const pairwiseDistance = result.coordinates ? euclideanDistanceMatrix(result.coordinates) : null;
  const breakdown = pairwiseDistance ? stressBreakdown(fx.dissimilarity, pairwiseDistance, fx.weight) : null;
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
    rss: breakdown?.rss ?? null,
    sumSquaredDistances: breakdown?.sumSquaredDistances ?? null,
    sumSquaredDisparities: breakdown?.sumSquaredDisparities ?? null,
    stress1DistanceDenominator: breakdown?.stress1DistanceDenominator ?? null,
    stress1DisparityDenominator: breakdown?.stress1DisparityDenominator ?? null,
    disparities: breakdown?.disparities ?? null,
    activePairCount: breakdown?.activePairCount ?? null,
  };

  // ---- Fixed-iteration diagnostics (zeroFree only, to bound runtime) ----
  // eps=0 is the public, documented parameter used to prevent the
  // convergence check from short-circuiting before the requested iteration
  // count is reached (see smacof.ts: `Math.abs(prev - normalized) < eps`
  // can never be true when eps=0 and the difference is >= 0, which
  // majorization guarantees). No engine code is modified — this calls the
  // existing runSmacofFromInitialConfiguration entry point repeatedly with
  // different maxIter values, exactly as the diagnostic request specifies.
  if (key === "zeroFree") {
    const iteration0Distance = euclideanDistanceMatrix(fx.initialCoordinates);
    const iteration0Breakdown = stressBreakdown(fx.dissimilarity, iteration0Distance, fx.weight);
    const snapshots: Record<string, unknown> = {};
    for (const iterCount of SNAPSHOT_ITERS) {
      const snapResult = runSmacofFromInitialConfiguration(fx.dissimilarity, fx.weight, fx.initialCoordinates, {
        maxIter: iterCount,
        eps: 0,
      });
      const snapDistance = snapResult.coordinates ? euclideanDistanceMatrix(snapResult.coordinates) : null;
      const snapBreakdown = snapDistance ? stressBreakdown(fx.dissimilarity, snapDistance, fx.weight) : null;
      snapshots[String(iterCount)] = {
        requestedIterations: iterCount,
        iterationsRun: snapResult.iterations,
        errorCode: snapResult.errorCode ?? null,
        coordinates: snapResult.coordinates,
        pairwiseDistance: snapDistance,
        rss: snapBreakdown?.rss ?? null,
        stress1DistanceDenominator: snapBreakdown?.stress1DistanceDenominator ?? null,
        stress1DisparityDenominator: snapBreakdown?.stress1DisparityDenominator ?? null,
        engineReportedNormalizedStress1: snapResult.normalizedStress1,
      };
    }
    smacofSnapshots[key] = {
      iteration0: {
        note: "Raw (uncentered) init, computed directly — not a runSmacofFromInitialConfiguration() call. The engine centers the init internally before iterating; this snapshot intentionally reflects the shared pre-centering input state, comparable across TS/Python/R.",
        coordinates: fx.initialCoordinates,
        pairwiseDistance: iteration0Distance,
        rss: iteration0Breakdown.rss,
        stress1DistanceDenominator: iteration0Breakdown.stress1DistanceDenominator,
      },
      snapshots,
    };
  }
}
fs.writeFileSync(path.join(outputDir, "ts-smacof-results.json"), JSON.stringify(smacofResults, null, 2));
fs.writeFileSync(path.join(outputDir, "ts-smacof-snapshots.json"), JSON.stringify(smacofSnapshots, null, 2));

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
