/**
 * Reads the shared fixtures JSON (exportFixtures.ts output) and an optional
 * diagnostic fixtures JSON (exportDiagnosticFixtures.ts output), runs the
 * TypeScript SMACOF/Ward implementation against both, and writes result
 * JSON files for compareReferences.ts to consume alongside the Python/R
 * outputs.
 *
 * The fixtures JSON's shape is defined by exportFixtures.ts /
 * exportDiagnosticFixtures.ts in this same directory (not by
 * src/lib/conceptAnalysis, which knows nothing about JSON I/O) — `any` is
 * used for the parsed document here deliberately, matching that this is a
 * standalone CI script, not app code.
 *
 * Usage: runTsReference.ts <fixtures.json> <output-dir> [diagnostic-fixtures.json]
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
const diagnosticFixturesPath = process.argv[4];
if (!fixturesPath || !outputDir) {
  console.error("Usage: runTsReference.ts <fixtures.json> <output-dir> [diagnostic-fixtures.json]");
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
 * report distinctly-named values for direct comparison.
 *
 * Also reports disparity-normalization metadata (attempt 5): targetNormQ =
 * the number of active pairs (the classical "Σ w dHat^2 = n(n-1)/2" target
 * some SMACOF formulations rescale disparities to every iteration) next to
 * postNormalizationDisparitySumSquares (= sumSquaredDisparities, since this
 * engine's fitDisparities() in smacof.ts performs NO such rescaling — see
 * the read-only audit in the attempt-5 report). preNormalization and
 * postNormalization are therefore always equal here; the field pair exists
 * so Python/R (which may differ) are directly comparable by name.
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
  const disparities: { pairKey: string; i: number; j: number; dissimilarity: number; disparity: number; configurationDistance: number }[] = [];
  pairs.forEach(({ i, j }, idx) => {
    const dHat = fitted[idx];
    const dij = distance[i][j];
    rss += (dHat - dij) ** 2;
    sumSquaredDistances += dij * dij;
    sumSquaredDisparities += dHat * dHat;
    disparities.push({ pairKey: `${i}-${j}`, i, j, dissimilarity: dissimilarity[i][j], disparity: dHat, configurationDistance: dij });
  });

  const stress1DistanceDenominator = sumSquaredDistances > 0 ? Math.sqrt(rss / sumSquaredDistances) : null;
  const stress1DisparityDenominator = sumSquaredDisparities > 0 ? Math.sqrt(rss / sumSquaredDisparities) : null;
  const targetNormQ = pairs.length; // n(n-1)/2 when every active pair has weight 1

  return {
    rss,
    sumSquaredDistances,
    sumSquaredDisparities,
    stress1DistanceDenominator,
    stress1DisparityDenominator,
    disparities,
    activePairCount: pairs.length,
    targetNormQ,
    preNormalizationDisparitySumSquares: sumSquaredDisparities,
    postNormalizationDisparitySumSquares: sumSquaredDisparities,
    disparityNormalizationApplied: false,
  };
}

/** Groups active pairs by (near-)equal dissimilarity value — for direct tie-block comparison across TS/Python/R. */
function computeTieBlocks(disparities: ReturnType<typeof stressBreakdown>["disparities"], tieEps = 1e-9) {
  const sorted = [...disparities].sort((a, b) => a.dissimilarity - b.dissimilarity);
  type Block = { dissimilarity: number; pairKeys: string[]; disparities: number[]; configurationDistances: number[] };
  const blocks: Block[] = [];
  for (const d of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && Math.abs(last.dissimilarity - d.dissimilarity) <= tieEps) {
      last.pairKeys.push(d.pairKey);
      last.disparities.push(d.disparity);
      last.configurationDistances.push(d.configurationDistance);
    } else {
      blocks.push({ dissimilarity: d.dissimilarity, pairKeys: [d.pairKey], disparities: [d.disparity], configurationDistances: [d.configurationDistance] });
    }
  }
  return blocks.map((b, idx) => ({
    tieBlockId: idx,
    dissimilarity: b.dissimilarity,
    pairKeys: b.pairKeys,
    blockSize: b.pairKeys.length,
    meanConfigurationDistance: b.configurationDistances.reduce((s, v) => s + v, 0) / b.configurationDistances.length,
    disparityValues: b.disparities,
    disparityIsUniformWithinBlock: Math.max(...b.disparities) - Math.min(...b.disparities) <= 1e-9,
    fittedDisparity: b.disparities[0],
  }));
}

const SNAPSHOT_ITERS = [1, 2, 5, 10, 19];

function processMdsFixtures(mdsFixtures: Record<string, any>, snapshotKeys: string[]) {
  const results: Record<string, unknown> = {};
  const snapshots: Record<string, unknown> = {};
  const tieBlocksByFixture: Record<string, unknown> = {};

  for (const [key, fx] of Object.entries<any>(mdsFixtures)) {
    const result = runSmacofFromInitialConfiguration(fx.dissimilarity, fx.weight, fx.initialCoordinates, {
      maxIter: fx.maxIter,
      eps: fx.eps,
    });
    const pairwiseDistance = result.coordinates ? euclideanDistanceMatrix(result.coordinates) : null;
    const breakdown = pairwiseDistance ? stressBreakdown(fx.dissimilarity, pairwiseDistance, fx.weight) : null;
    results[key] = {
      errorCode: result.errorCode ?? null,
      coordinates: result.coordinates,
      pairwiseDistance,
      rawStress: result.rawStress,
      normalizedStress1: result.normalizedStress1,
      converged: result.converged,
      iterations: result.iterations,
      stressHistory: result.stressHistory,
      stressMonotoneNonIncreasing: result.stressHistory.every((v: number, i: number) => i === 0 || v <= result.stressHistory[i - 1] + 1e-7),
      ...breakdown,
    };
    if (breakdown) tieBlocksByFixture[key] = computeTieBlocks(breakdown.disparities);

    if (snapshotKeys.includes(key)) {
      const iteration0Distance = euclideanDistanceMatrix(fx.initialCoordinates);
      const iteration0Breakdown = stressBreakdown(fx.dissimilarity, iteration0Distance, fx.weight);
      const snapshotsByIter: Record<string, unknown> = {};
      for (const iterCount of SNAPSHOT_ITERS) {
        const snapResult = runSmacofFromInitialConfiguration(fx.dissimilarity, fx.weight, fx.initialCoordinates, {
          maxIter: iterCount,
          eps: 0,
        });
        const snapDistance = snapResult.coordinates ? euclideanDistanceMatrix(snapResult.coordinates) : null;
        const snapBreakdown = snapDistance ? stressBreakdown(fx.dissimilarity, snapDistance, fx.weight) : null;
        snapshotsByIter[String(iterCount)] = {
          requestedIterations: iterCount,
          iterationsRun: snapResult.iterations,
          errorCode: snapResult.errorCode ?? null,
          coordinates: snapResult.coordinates,
          pairwiseDistance: snapDistance,
          engineReportedNormalizedStress1: snapResult.normalizedStress1,
          ...snapBreakdown,
        };
      }
      snapshots[key] = {
        iteration0: {
          note: "S0_INITIAL_CONFIGURATION: raw (uncentered) shared init, before any disparity fit or Guttman update. The engine centers internally before iterating; this snapshot intentionally reflects the shared pre-centering input state, comparable across TS/Python/R.",
          coordinates: fx.initialCoordinates,
          pairwiseDistance: iteration0Distance,
          ...iteration0Breakdown,
        },
        s1InitialDisparity: {
          note: "S1_INITIAL_DISPARITY: isotonic fit of S0's distances against the original dissimilarity ranking — this is the disparity used in the FIRST Guttman update. Computed via the same public isotonicRegressionByRank the engine itself calls.",
          ...iteration0Breakdown,
        },
        snapshots: snapshotsByIter,
      };
    }
  }
  return { results, snapshots, tieBlocksByFixture };
}

// ---- SMACOF: main shared fixtures ----
const main = processMdsFixtures(fixtures.mds, ["zeroFree"]);
fs.writeFileSync(path.join(outputDir, "ts-smacof-results.json"), JSON.stringify(main.results, null, 2));
fs.writeFileSync(path.join(outputDir, "ts-smacof-snapshots.json"), JSON.stringify(main.snapshots, null, 2));
fs.writeFileSync(path.join(outputDir, "ts-tie-blocks.json"), JSON.stringify(main.tieBlocksByFixture, null, 2));

// ---- SMACOF: diagnostic fixtures (strictNoTies), if provided ----
if (diagnosticFixturesPath) {
  const diagnosticFixtures = JSON.parse(fs.readFileSync(diagnosticFixturesPath, "utf-8"));
  const diag = processMdsFixtures(diagnosticFixtures.mds, Object.keys(diagnosticFixtures.mds));
  fs.writeFileSync(path.join(outputDir, "ts-diagnostic-smacof-results.json"), JSON.stringify(diag.results, null, 2));
  fs.writeFileSync(path.join(outputDir, "ts-diagnostic-smacof-snapshots.json"), JSON.stringify(diag.snapshots, null, 2));
  fs.writeFileSync(path.join(outputDir, "ts-diagnostic-tie-blocks.json"), JSON.stringify(diag.tieBlocksByFixture, null, 2));
}

// ---- Dimension diagnostics (multi-init, on the zero-free fixture only) ----
const zeroFree = fixtures.mds.zeroFree;
const dimDiag = runDimensionDiagnostics(zeroFree.dissimilarity, zeroFree.weight, {
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
      primaryMapDimension: dimDiag.primaryMapDimension,
      diagnosticPreferredDimension: dimDiag.diagnosticPreferredDimension,
      diagnosticReasonCodes: dimDiag.diagnosticReasonCodes,
      diagnostics: dimDiag.diagnostics,
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
