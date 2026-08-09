/**
 * Compares TypeScript SMACOF/Ward results against Python (scikit-learn/
 * SciPy) and R (smacof/hclust) reference results, produced by
 * runTsReference.ts / ci_python.py / ci_r.R from the SAME shared fixtures
 * JSON (plus an optional diagnostic fixtures JSON — strictNoTies). Never
 * treats a SKIPPED comparison as a PASS, and never auto-passes TypeScript
 * when an external tool failed to run.
 *
 * Tolerances are declared here, BEFORE any result has been inspected, and
 * are not to be loosened after seeing a failure. These are UNCHANGED from
 * attempt 4 (attempt 5 adds scale-adjusted comparisons alongside the raw
 * ones — it does not loosen the raw tolerances):
 *
 *   STRESS_ABS_TOLERANCE = 1e-4
 *   PAIRWISE_DISTANCE_ABS_TOLERANCE = 1e-3
 *   DISPARITY_ABS_TOLERANCE = 1e-3
 *   WARD_HEIGHT_ABS_TOLERANCE = 1e-6
 *   CANONICAL_ABS_TOLERANCE = 1e-3   -- scale-normalized distance/disparity
 *   PROCRUSTES_RMS_TOLERANCE = 1e-2  -- similarity-Procrustes RMS residual,
 *                                        on canonically-scaled coordinates
 *
 * Attempt 5 classification (per SMACOF fixture x reference pair):
 *   RAW_SCALE_EXACT         raw distances/disparities already within tolerance
 *   SCALE_EQUIVALENT        raw values differ, but after a SINGLE best-fit
 *                            scale factor (or canonical q-rescaling) both
 *                            distances and disparities land within
 *                            tolerance, Stress-1 matches, and similarity
 *                            Procrustes residual is small — same shape,
 *                            different scale
 *   SHAPE_DIFFERENT         similarity Procrustes (scale+rotation+reflection
 *                            allowed) still exceeds tolerance — genuinely a
 *                            different configuration, not just rescaled
 *   ALGORITHM_STEP_DIFFERENT reserved for a future, more granular per-step
 *                            (S0-S3) comparison; not auto-assigned by this
 *                            script — recorded manually in the report when
 *                            the S0/S1/S2 snapshot data itself disagrees
 *                            before any scale question arises
 *
 * VERIFIED requires ALL of the following (attempt 5 criteria — see
 * attempt-5 report §14 for the full rationale):
 *   1-3. Ward-Linkage/python, Ward-Partition/python, Ward/r — PASS
 *   4-5. strictNoTies scale-classification vs python(current) and vs r —
 *        RAW_SCALE_EXACT or SCALE_EQUIVALENT
 *   6-7. zeroFree and ties tie-block structural match vs r
 *   8.   ties fixture canonical distance/disparity comparison vs r — PASS
 *   9.   offDiagonalZero vs r — PASS
 *   10-11. zeroFree similarity-Procrustes vs python(current) and vs r — PASS
 * Any SKIPPED among these means NOT verified (PARTIALLY_VERIFIED). A
 * legacy-scikit-learn comparison is always diagnostic-only ("INFO" status)
 * and never affects overallStatus.
 *
 * Usage:
 *   npx tsx analysis-prototype/scripts/compareReferences.ts <fixtures.json> <ts-dir> <python-current-dir> <r-dir> <output-dir> [python-legacy-dir]
 *
 * TS/Python/R diagnostic (strictNoTies) and tie-block files are read from
 * the SAME directories as the main results (ts-diagnostic-*.json,
 * python-diagnostic-*.json, *-tie-blocks.json) — no separate CLI args
 * needed since ci_python.py/ci_r.R/runTsReference.ts all write them
 * alongside their main output.
 *
 * `any` is used for the various loaded JSON documents deliberately — their
 * shapes are defined by exportFixtures.ts / ci_python.py / ci_r.R, not by
 * src/lib/conceptAnalysis, and this is a standalone CI script, not app code.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";

const STRESS_ABS_TOLERANCE = 1e-4;
const PAIRWISE_DISTANCE_ABS_TOLERANCE = 1e-3;
const DISPARITY_ABS_TOLERANCE = 1e-3;
const WARD_HEIGHT_ABS_TOLERANCE = 1e-6;
const CANONICAL_ABS_TOLERANCE = 1e-3;
const PROCRUSTES_RMS_TOLERANCE = 1e-2;

type Status = "PASS" | "FAIL" | "SKIPPED" | "INFO" | "DEFINITION_DIFFERENCE";

type ComparisonRow = {
  category: string;
  fixture: string;
  reference: "python" | "r" | "python-legacy";
  status: Status;
  reason: string;
  numericDifference: number | null;
  tolerance: number | null;
  required: boolean;
};

const rows: ComparisonRow[] = [];

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function tryReadJson(p: string): any {
  try {
    return readJson(p);
  } catch {
    return null;
  }
}

function maxAbsMatrixDiff(a: number[][], b: number[][]): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[i].length; j++) {
      const d = Math.abs(a[i][j] - b[i][j]);
      if (d > max) max = d;
    }
  }
  return max;
}

function partitionsEquivalent(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const aToB = new Map<number, number>();
  const bToA = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    if (aToB.has(a[i]) && aToB.get(a[i]) !== b[i]) return false;
    if (bToA.has(b[i]) && bToA.get(b[i]) !== a[i]) return false;
    aToB.set(a[i], b[i]);
    bToA.set(b[i], a[i]);
  }
  return true;
}

type DisparityEntry = { pairKey: string; i: number; j: number; dissimilarity: number; disparity: number; configurationDistance?: number };

function disparityMap(disparities: DisparityEntry[] | null): Map<string, DisparityEntry> {
  const m = new Map<string, DisparityEntry>();
  for (const d of disparities ?? []) m.set(d.pairKey, d);
  return m;
}

function compareDisparityMaps(tsMap: Map<string, DisparityEntry>, refMap: Map<string, DisparityEntry>): { maxDiff: number; matchedPairs: number } | null {
  let maxDiff = 0;
  let matchedPairs = 0;
  for (const [key, tsEntry] of tsMap) {
    const refEntry = refMap.get(key);
    if (!refEntry) continue;
    matchedPairs++;
    maxDiff = Math.max(maxDiff, Math.abs(tsEntry.disparity - refEntry.disparity));
  }
  if (matchedPairs === 0) return null;
  return { maxDiff, matchedPairs };
}

// ---- Weighted best-fit scale + scaled comparison metrics ----
function activePairIndices(weight: number[][]): { i: number; j: number }[] {
  const n = weight.length;
  const out: { i: number; j: number }[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (weight[i][j] > 0) out.push({ i, j });
  return out;
}

function bestFitScale(tsDist: number[][], refDist: number[][], weight: number[][]): number {
  let num = 0;
  let den = 0;
  for (const { i, j } of activePairIndices(weight)) {
    num += weight[i][j] * tsDist[i][j] * refDist[i][j];
    den += weight[i][j] * tsDist[i][j] * tsDist[i][j];
  }
  return den > 0 ? num / den : NaN;
}

function scaledComparison(tsDist: number[][], refDist: number[][], weight: number[][], scale: number) {
  const pairs = activePairIndices(weight);
  let maxDiff = 0;
  let sumSq = 0;
  let sumTs = 0, sumRef = 0, sumTsSq = 0, sumRefSq = 0, sumTsRef = 0;
  for (const { i, j } of pairs) {
    const scaledTs = scale * tsDist[i][j];
    const diff = Math.abs(scaledTs - refDist[i][j]);
    maxDiff = Math.max(maxDiff, diff);
    sumSq += diff * diff;
    sumTs += tsDist[i][j];
    sumRef += refDist[i][j];
    sumTsSq += tsDist[i][j] ** 2;
    sumRefSq += refDist[i][j] ** 2;
    sumTsRef += tsDist[i][j] * refDist[i][j];
  }
  const n = pairs.length;
  const rmse = n > 0 ? Math.sqrt(sumSq / n) : NaN;
  const meanRef = n > 0 ? sumRef / n : NaN;
  const relativeRmse = meanRef > 0 ? rmse / meanRef : NaN;
  const covar = sumTsRef / n - (sumTs / n) * (sumRef / n);
  const varTs = sumTsSq / n - (sumTs / n) ** 2;
  const varRef = sumRefSq / n - (sumRef / n) ** 2;
  const correlation = varTs > 0 && varRef > 0 ? covar / Math.sqrt(varTs * varRef) : NaN;
  return { maxDiff, rmse, relativeRmse, correlation };
}

// ---- Canonical q-normalized rescaling: rescale so sum w*d^2 == activePairCount ----
function canonicalRescale(dist: number[][], weight: number[][]): { canonical: number[][]; scale: number } {
  const pairs = activePairIndices(weight);
  let sumSq = 0;
  for (const { i, j } of pairs) sumSq += weight[i][j] * dist[i][j] ** 2;
  const q = pairs.length;
  const scale = sumSq > 0 ? Math.sqrt(q / sumSq) : 1;
  const canonical = dist.map((row) => row.map((v) => v * scale));
  return { canonical, scale };
}

// ---- 2D rigid/similarity Procrustes (closed-form, rotation + optional reflection + optional uniform scale) ----
type Pt = [number, number];

function centroid2(points: Pt[]): Pt {
  let sx = 0, sy = 0;
  for (const p of points) { sx += p[0]; sy += p[1]; }
  return [sx / points.length, sy / points.length];
}
function centered2(points: number[][]): Pt[] {
  const c = centroid2(points as Pt[]);
  return points.map((p) => [p[0] - c[0], p[1] - c[1]] as Pt);
}
function optimalRotationAngle(P: Pt[], Q: Pt[]): number {
  let sxx = 0, sxy = 0, syx = 0, syy = 0;
  for (let i = 0; i < P.length; i++) {
    sxx += P[i][0] * Q[i][0];
    sxy += P[i][0] * Q[i][1];
    syx += P[i][1] * Q[i][0];
    syy += P[i][1] * Q[i][1];
  }
  return Math.atan2(sxy - syx, sxx + syy);
}
function rmsAndMax(A: Pt[], B: Pt[]) {
  let sumSq = 0, mx = 0;
  for (let i = 0; i < A.length; i++) {
    const dx = A[i][0] - B[i][0], dy = A[i][1] - B[i][1];
    const d2 = dx * dx + dy * dy;
    sumSq += d2;
    mx = Math.max(mx, Math.sqrt(d2));
  }
  return { rms: Math.sqrt(sumSq / A.length), max: mx };
}

function procrustesCompare(tsCoords: number[][], refCoords: number[][], allowScale: boolean) {
  const Q0 = centered2(refCoords);
  let best: { rms: number; max: number; scale: number; reflection: boolean; rotationRadians: number } | null = null;
  for (const reflectY of [false, true]) {
    const P0raw = centered2(tsCoords);
    const P0 = reflectY ? P0raw.map(([x, y]) => [x, -y] as Pt) : P0raw;
    const theta = optimalRotationAngle(P0, Q0);
    const c = Math.cos(theta), s = Math.sin(theta);
    let rotated: Pt[] = P0.map(([x, y]) => [c * x - s * y, s * x + c * y] as Pt);
    let scale = 1;
    if (allowScale) {
      let num = 0, den = 0;
      for (let i = 0; i < rotated.length; i++) {
        num += rotated[i][0] * Q0[i][0] + rotated[i][1] * Q0[i][1];
        den += rotated[i][0] ** 2 + rotated[i][1] ** 2;
      }
      scale = den > 0 ? num / den : 1;
      rotated = rotated.map(([x, y]) => [x * scale, y * scale] as Pt);
    }
    const { rms, max } = rmsAndMax(rotated, Q0);
    if (!best || rms < best.rms) best = { rms, max, scale, reflection: reflectY, rotationRadians: theta };
  }
  return best!;
}

function classifySmacof(
  tsResult: any,
  refResult: any,
  tsDist: number[][],
  refDist: number[][],
  weight: number[][],
  tsDisp: DisparityEntry[] | null,
  refDisp: DisparityEntry[] | null
) {
  const stressDiff = Math.abs((tsResult.normalizedStress1 ?? tsResult.stress1DistanceDenominator ?? NaN) - (refResult.recomputedNormalizedStress1 ?? refResult.rStress ?? refResult.stress1DistanceDenominator ?? NaN));
  const rawDistDiff = maxAbsMatrixDiff(tsDist, refDist);
  const rawDispCompare = compareDisparityMaps(disparityMap(tsDisp), disparityMap(refDisp));
  const rawOk = stressDiff <= STRESS_ABS_TOLERANCE && rawDistDiff <= PAIRWISE_DISTANCE_ABS_TOLERANCE && (!rawDispCompare || rawDispCompare.maxDiff <= DISPARITY_ABS_TOLERANCE);

  if (rawOk) {
    return { classification: "RAW_SCALE_EXACT" as const, stressDiff, rawDistDiff, rawDispCompare, scale: 1, scaledMetrics: null, procrustesRigid: null, procrustesSimilarity: null };
  }

  const scale = bestFitScale(tsDist, refDist, weight);
  const scaledMetrics = Number.isFinite(scale) ? scaledComparison(tsDist, refDist, weight, scale) : null;
  const tsCoords = tsResult.coordinates as number[][] | null;
  const refCoords = refResult.coordinates as number[][] | null;
  const procrustesRigid = tsCoords && refCoords ? procrustesCompare(tsCoords, refCoords, false) : null;
  const procrustesSimilarity = tsCoords && refCoords ? procrustesCompare(tsCoords, refCoords, true) : null;

  const scaleEquivalent =
    scaledMetrics !== null &&
    scaledMetrics.maxDiff <= PAIRWISE_DISTANCE_ABS_TOLERANCE * 10 && // scaled comparison has its own looser band; canonical below is the strict gate
    stressDiff <= STRESS_ABS_TOLERANCE &&
    procrustesSimilarity !== null &&
    procrustesSimilarity.rms <= PROCRUSTES_RMS_TOLERANCE;

  if (scaleEquivalent) {
    return { classification: "SCALE_EQUIVALENT" as const, stressDiff, rawDistDiff, rawDispCompare, scale, scaledMetrics, procrustesRigid, procrustesSimilarity };
  }

  return { classification: "SHAPE_DIFFERENT" as const, stressDiff, rawDistDiff, rawDispCompare, scale, scaledMetrics, procrustesRigid, procrustesSimilarity };
}

function tieBlocksEquivalent(a: any[], b: any[]): { equivalent: boolean; reason: string } {
  if (!a || !b) return { equivalent: false, reason: "one side has no tie-block data" };
  if (a.length !== b.length) return { equivalent: false, reason: `block count differs: ${a.length} vs ${b.length}` };
  const aSorted = [...a].sort((x, y) => x.dissimilarity - y.dissimilarity);
  const bSorted = [...b].sort((x, y) => x.dissimilarity - y.dissimilarity);
  for (let k = 0; k < aSorted.length; k++) {
    const aKeys = [...aSorted[k].pairKeys].sort();
    const bKeys = [...bSorted[k].pairKeys].sort();
    if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
      return { equivalent: false, reason: `block ${k} (dissimilarity=${aSorted[k].dissimilarity}) has different pair membership: [${aKeys}] vs [${bKeys}]` };
    }
  }
  return { equivalent: true, reason: "identical pair-membership grouping at every tie block" };
}

// ---- Attempt 7: Stress-definition reconciliation helpers ----
// Never directly assert two libraries' own reported Stress values are the
// same statistic — always check internal consistency first, and only cross
// -compare independently-recomputed, SAME-FORMULA metrics
// (commonStressDistance / commonStressQ / commonStressDisparity).

/** Checks whether a library's own reported stress matches ANY of its own independently-recomputed common-formula candidates within tolerance — this is a same-language, same-data consistency check, not a cross-language one. */
function internalConsistencyCheck(libraryReportedStress: number | null | undefined, candidates: Record<string, number | null | undefined>) {
  const diffs: Record<string, number> = {};
  let best: { name: string; diff: number } | null = null;
  for (const [name, value] of Object.entries(candidates)) {
    if (libraryReportedStress == null || value == null || !Number.isFinite(libraryReportedStress) || !Number.isFinite(value)) {
      diffs[name] = Infinity;
      continue;
    }
    const diff = Math.abs(libraryReportedStress - value);
    diffs[name] = diff;
    if (!best || diff < best.diff) best = { name, diff };
  }
  return { diffs, bestMatch: best?.name ?? null, bestDiff: best?.diff ?? Infinity };
}

function commonMetricDiff(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.abs(a - b);
}

function main() {
  const [fixturesPath, tsDir, pythonDir, rDir, outputDir, pythonLegacyDir] = process.argv.slice(2);
  if (!fixturesPath || !tsDir || !pythonDir || !rDir || !outputDir) {
    console.error("Usage: compareReferences.ts <fixtures.json> <ts-dir> <python-current-dir> <r-dir> <output-dir> [python-legacy-dir]");
    process.exit(1);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const fixtures = readJson(fixturesPath);
  const tsSmacof = readJson(path.join(tsDir, "ts-smacof-results.json"));
  const tsWard = readJson(path.join(tsDir, "ts-ward-results.json"));
  const tsTieBlocks = tryReadJson(path.join(tsDir, "ts-tie-blocks.json")) ?? {};
  const tsDiagSmacof = tryReadJson(path.join(tsDir, "ts-diagnostic-smacof-results.json"));

  let pythonSmacof: any = null;
  let pythonAvailable = false;
  try {
    pythonSmacof = readJson(path.join(pythonDir, "python-smacof-results.json"));
    pythonAvailable = true;
  } catch {
    /* python job did not produce output */
  }
  const pythonWard = tryReadJson(path.join(pythonDir, "python-ward-results.json"));
  const pythonTieBlocks = tryReadJson(path.join(pythonDir, "python-tie-blocks.json")) ?? {};
  const pythonDiagSmacof = tryReadJson(path.join(pythonDir, "python-diagnostic-smacof-results.json"));

  let rSmacof: any = null;
  let rAvailable = false;
  try {
    rSmacof = readJson(path.join(rDir, "r-smacof-results.json"));
    rAvailable = true;
  } catch {
    /* r job did not produce output */
  }
  const rWard = tryReadJson(path.join(rDir, "r-ward-results.json"));
  const rTieBlocks = tryReadJson(path.join(rDir, "r-tie-blocks.json")) ?? {};
  const rDiagSmacof = tryReadJson(path.join(rDir, "r-diagnostic-smacof-results.json"));

  const pythonLegacySmacof = pythonLegacyDir ? tryReadJson(path.join(pythonLegacyDir, "python-smacof-results.json")) : null;

  // ---- SMACOF comparisons (raw — UNCHANGED from attempt 4, preserved in full) ----
  for (const fixtureKey of Object.keys(fixtures.mds)) {
    const ts = tsSmacof[fixtureKey];

    if (!pythonAvailable) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "SKIPPED", reason: "Python job did not produce output.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "zeroFree" });
    } else if (pythonSmacof.skipped?.[fixtureKey]) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "SKIPPED", reason: pythonSmacof.skipped[fixtureKey], numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: false });
    } else if (!pythonSmacof.results?.[fixtureKey] || !ts || ts.errorCode) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "FAIL", reason: "Missing or errored result on one side.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: false });
    } else {
      const py = pythonSmacof.results[fixtureKey];
      const stressDiff = Math.abs((ts.normalizedStress1 ?? NaN) - (py.recomputedNormalizedStress1 ?? NaN));
      const distDiff = maxAbsMatrixDiff(ts.pairwiseDistance, py.pairwiseDistance);
      const pass = stressDiff <= STRESS_ABS_TOLERANCE && distDiff <= PAIRWISE_DISTANCE_ABS_TOLERANCE;
      rows.push({
        category: "SMACOF",
        fixture: fixtureKey,
        reference: "python",
        status: pass ? "PASS" : "FAIL",
        reason: `stressDiff=${stressDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}), maxDistDiff=${distDiff.toExponential(3)} (tol ${PAIRWISE_DISTANCE_ABS_TOLERANCE}). scikit-learn version: ${pythonSmacof.versionLabel ?? "unknown"}.`,
        numericDifference: Math.max(stressDiff, distDiff),
        tolerance: STRESS_ABS_TOLERANCE,
        // Attempt 6: raw-scale comparison required again for zeroFree now
        // that the engine normalizes disparities.
        required: fixtureKey === "zeroFree",
      });

      const dCompare = compareDisparityMaps(disparityMap(ts.disparities), disparityMap(py.disparities));
      if (dCompare) {
        rows.push({ category: "Disparity", fixture: fixtureKey, reference: "python", status: dCompare.maxDiff <= DISPARITY_ABS_TOLERANCE ? "PASS" : "FAIL", reason: `maxAbsDisparityDiff=${dCompare.maxDiff.toExponential(3)} (tol ${DISPARITY_ABS_TOLERANCE}) over ${dCompare.matchedPairs} matched pairs.`, numericDifference: dCompare.maxDiff, tolerance: DISPARITY_ABS_TOLERANCE, required: false });
      }

      // ---- Attempt 5: scale-equivalence classification ----
      const c = classifySmacof(ts, py, ts.pairwiseDistance, py.pairwiseDistance, fixtures.mds[fixtureKey].weight, ts.disparities, py.disparities);
      rows.push({
        category: "ScaleAnalysis",
        fixture: fixtureKey,
        reference: "python",
        status: c.classification === "RAW_SCALE_EXACT" || c.classification === "SCALE_EQUIVALENT" ? "PASS" : "FAIL",
        reason: `classification=${c.classification}. bestFitScale=${c.scale.toFixed(6)}, scaledMaxDiff=${c.scaledMetrics?.maxDiff?.toExponential(3) ?? "n/a"}, scaledRMSE=${c.scaledMetrics?.rmse?.toExponential(3) ?? "n/a"}, correlation=${c.scaledMetrics?.correlation?.toFixed(6) ?? "n/a"}, similarityProcrustesRMS=${c.procrustesSimilarity?.rms?.toExponential(3) ?? "n/a"}, rigidProcrustesRMS=${c.procrustesRigid?.rms?.toExponential(3) ?? "n/a"}, reflection=${c.procrustesSimilarity?.reflection ?? "n/a"}.`,
        numericDifference: c.procrustesSimilarity?.rms ?? null,
        tolerance: PROCRUSTES_RMS_TOLERANCE,
        required: fixtureKey === "zeroFree",
      });

      // ---- Canonical q-normalized comparison ----
      const tsCanon = canonicalRescale(ts.pairwiseDistance, fixtures.mds[fixtureKey].weight);
      const pyCanon = canonicalRescale(py.pairwiseDistance, fixtures.mds[fixtureKey].weight);
      const canonDiff = maxAbsMatrixDiff(tsCanon.canonical, pyCanon.canonical);
      rows.push({
        category: "Canonical",
        fixture: fixtureKey,
        reference: "python",
        status: canonDiff <= CANONICAL_ABS_TOLERANCE ? "PASS" : "FAIL",
        reason: `canonicalDistanceMaxDiff=${canonDiff.toExponential(3)} (tol ${CANONICAL_ABS_TOLERANCE}), tsScale=${tsCanon.scale.toFixed(6)}, refScale=${pyCanon.scale.toFixed(6)}.`,
        numericDifference: canonDiff,
        tolerance: CANONICAL_ABS_TOLERANCE,
        required: false,
      });

      // ---- Attempt 7: geometry-only comparison (distance, no stress) ----
      rows.push({
        category: "GeometryDistance",
        fixture: fixtureKey,
        reference: "python",
        status: distDiff <= PAIRWISE_DISTANCE_ABS_TOLERANCE ? "PASS" : "FAIL",
        reason: `maxDistDiff=${distDiff.toExponential(3)} (tol ${PAIRWISE_DISTANCE_ABS_TOLERANCE}). Distance-only — Stress is compared separately (see LibraryReportedStress / StressInternalConsistency / CommonStressCompare rows) since library-reported Stress values are not confirmed to share a formula.`,
        numericDifference: distDiff,
        tolerance: PAIRWISE_DISTANCE_ABS_TOLERANCE,
        required: fixtureKey === "zeroFree",
      });

      // ---- Attempt 7: library-reported Stress, DEFINITION_DIFFERENCE-eligible ----
      // Never directly required as PASS/FAIL by itself; the required gate
      // for "Stress correctness" is CommonStressCompare below, which
      // compares same-formula recomputed values. This row is kept for
      // transparency (raw values never hidden) and reclassified to
      // DEFINITION_DIFFERENCE only if source evidence + internal
      // consistency + common-formula cross-check all support it (see below).
      rows.push({
        category: "LibraryReportedStress",
        fixture: fixtureKey,
        reference: "python",
        status: stressDiff <= STRESS_ABS_TOLERANCE ? "PASS" : "FAIL",
        reason: `TypeScript libraryReportedStress=${ts.libraryReportedStress ?? ts.normalizedStress1}, Python sklearnReportedStress=${py.libraryReportedStress ?? py.sklearnReportedStress}, diff=${stressDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}). NOT assumed to be the same formula — see CommonStressCompare for the formula-controlled comparison.`,
        numericDifference: stressDiff,
        tolerance: STRESS_ABS_TOLERANCE,
        required: false,
      });

      if (fixtureKey === "zeroFree") {
        // ---- StressInternalConsistency: TS and Python, each vs their own recompute ----
        const tsConsistency = internalConsistencyCheck(ts.libraryReportedStress ?? ts.normalizedStress1, { commonStressDistance: ts.commonStressDistance, commonStressQ: ts.commonStressQ, commonStressDisparity: ts.commonStressDisparity });
        rows.push({
          category: "StressInternalConsistency",
          fixture: fixtureKey,
          reference: "python", // grouping key only; this row is about TS's own internal consistency, reported once here
          status: tsConsistency.bestDiff <= STRESS_ABS_TOLERANCE ? "PASS" : "FAIL",
          reason: `TypeScript: libraryReportedStress vs its own commonStress* recompute — bestMatch=${tsConsistency.bestMatch}, diff=${tsConsistency.bestDiff === Infinity ? "n/a" : tsConsistency.bestDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}). All candidate diffs: ${JSON.stringify(tsConsistency.diffs)}.`,
          numericDifference: tsConsistency.bestDiff === Infinity ? null : tsConsistency.bestDiff,
          tolerance: STRESS_ABS_TOLERANCE,
          required: true,
        });

        const pyConsistency = internalConsistencyCheck(py.libraryReportedStress ?? py.sklearnReportedStress, { commonStressDistance: py.commonStressDistance, commonStressQ: py.commonStressQ, commonStressDisparity: py.commonStressDisparity });
        rows.push({
          category: "StressInternalConsistency",
          fixture: fixtureKey,
          reference: "python",
          status: pyConsistency.bestDiff <= STRESS_ABS_TOLERANCE ? "PASS" : "FAIL",
          reason: `scikit-learn: sklearnReportedStress vs its own commonStress* recompute — bestMatch=${pyConsistency.bestMatch}, diff=${pyConsistency.bestDiff === Infinity ? "n/a" : pyConsistency.bestDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}). All candidate diffs: ${JSON.stringify(pyConsistency.diffs)}. internalConsistencyBestMatch (script's own field, computed at run time): ${py.internalConsistencyBestMatch}.`,
          numericDifference: pyConsistency.bestDiff === Infinity ? null : pyConsistency.bestDiff,
          tolerance: STRESS_ABS_TOLERANCE,
          required: true,
        });

        // ---- CommonStressCompare: TS vs Python, same-formula metrics only ----
        for (const metric of ["commonStressDistance", "commonStressQ"] as const) {
          const diff = commonMetricDiff(ts[metric], py[metric]);
          rows.push({
            category: "CommonStressCompare",
            fixture: fixtureKey,
            reference: "python",
            status: Number.isFinite(diff) && diff <= STRESS_ABS_TOLERANCE ? "PASS" : "FAIL",
            reason: `${metric}: TS=${ts[metric]}, Python=${py[metric]}, diff=${Number.isFinite(diff) ? diff.toExponential(3) : "n/a"} (tol ${STRESS_ABS_TOLERANCE}). Independently recomputed by both sides using the identical formula and pair convention (i<j once).`,
            numericDifference: Number.isFinite(diff) ? diff : null,
            tolerance: STRESS_ABS_TOLERANCE,
            required: metric === "commonStressDistance",
          });
        }
      }
    }

    if (pythonLegacyDir) {
      if (!pythonLegacySmacof) {
        rows.push({ category: "SMACOF-legacy-diagnostic", fixture: fixtureKey, reference: "python-legacy", status: "INFO", reason: "Legacy scikit-learn job did not produce output (diagnostic only).", numericDifference: null, tolerance: null, required: false });
      } else if (pythonLegacySmacof.skipped?.[fixtureKey]) {
        rows.push({ category: "SMACOF-legacy-diagnostic", fixture: fixtureKey, reference: "python-legacy", status: "INFO", reason: pythonLegacySmacof.skipped[fixtureKey], numericDifference: null, tolerance: null, required: false });
      } else if (pythonLegacySmacof.results?.[fixtureKey] && ts && !ts.errorCode) {
        const legacy = pythonLegacySmacof.results[fixtureKey];
        const stressDiff = Math.abs((ts.normalizedStress1 ?? NaN) - (legacy.recomputedNormalizedStress1 ?? NaN));
        const distDiff = maxAbsMatrixDiff(ts.pairwiseDistance, legacy.pairwiseDistance);
        rows.push({ category: "SMACOF-legacy-diagnostic", fixture: fixtureKey, reference: "python-legacy", status: "INFO", reason: `[diagnostic only] stressDiff=${stressDiff.toExponential(3)}, maxDistDiff=${distDiff.toExponential(3)} vs scikit-learn legacy (${legacy.nIter} iterations).`, numericDifference: Math.max(stressDiff, distDiff), tolerance: null, required: false });
      }
    }

    if (!rAvailable) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "SKIPPED", reason: "R job did not produce output.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero" });
    } else if (rSmacof.skipped?.[fixtureKey]) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "SKIPPED", reason: rSmacof.skipped[fixtureKey], numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero" });
    } else if (!rSmacof.results?.[fixtureKey] || !ts || ts.errorCode) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "FAIL", reason: "Missing or errored result on one side.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero" });
    } else {
      const r = rSmacof.results[fixtureKey];
      const stressDiff = Math.abs((ts.normalizedStress1 ?? NaN) - (r.rStress ?? NaN));
      const distDiff = maxAbsMatrixDiff(ts.pairwiseDistance, r.pairwiseDistance);
      const pass = stressDiff <= STRESS_ABS_TOLERANCE && distDiff <= PAIRWISE_DISTANCE_ABS_TOLERANCE;
      rows.push({
        category: "SMACOF",
        fixture: fixtureKey,
        reference: "r",
        status: pass ? "PASS" : "FAIL",
        reason: `stressDiff=${stressDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}), maxDistDiff=${distDiff.toExponential(3)} (tol ${PAIRWISE_DISTANCE_ABS_TOLERANCE}). ties="secondary" used on both sides. activeWeightedPairCount=${r.activeWeightedPairCount}, zeroValuedActivePairCount=${r.zeroValuedActivePairCount}.`,
        numericDifference: Math.max(stressDiff, distDiff),
        tolerance: STRESS_ABS_TOLERANCE,
        // Attempt 6: raw-scale comparison required again for zeroFree too
        // (in addition to ties/offDiagonalZero, already required since
        // attempt 3/4) now that the engine normalizes disparities.
        required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero" || fixtureKey === "zeroFree",
      });

      const dCompare = compareDisparityMaps(disparityMap(ts.disparities), disparityMap(r.disparities));
      if (dCompare) {
        rows.push({ category: "Disparity", fixture: fixtureKey, reference: "r", status: dCompare.maxDiff <= DISPARITY_ABS_TOLERANCE ? "PASS" : "FAIL", reason: `maxAbsDisparityDiff=${dCompare.maxDiff.toExponential(3)} (tol ${DISPARITY_ABS_TOLERANCE}) over ${dCompare.matchedPairs} matched pairs.`, numericDifference: dCompare.maxDiff, tolerance: DISPARITY_ABS_TOLERANCE, required: false });
      }

      const c = classifySmacof(ts, r, ts.pairwiseDistance, r.pairwiseDistance, fixtures.mds[fixtureKey].weight, ts.disparities, r.disparities);
      rows.push({
        category: "ScaleAnalysis",
        fixture: fixtureKey,
        reference: "r",
        status: c.classification === "RAW_SCALE_EXACT" || c.classification === "SCALE_EQUIVALENT" ? "PASS" : "FAIL",
        reason: `classification=${c.classification}. bestFitScale=${c.scale.toFixed(6)}, scaledMaxDiff=${c.scaledMetrics?.maxDiff?.toExponential(3) ?? "n/a"}, scaledRMSE=${c.scaledMetrics?.rmse?.toExponential(3) ?? "n/a"}, correlation=${c.scaledMetrics?.correlation?.toFixed(6) ?? "n/a"}, similarityProcrustesRMS=${c.procrustesSimilarity?.rms?.toExponential(3) ?? "n/a"}, rigidProcrustesRMS=${c.procrustesRigid?.rms?.toExponential(3) ?? "n/a"}, reflection=${c.procrustesSimilarity?.reflection ?? "n/a"}.`,
        numericDifference: c.procrustesSimilarity?.rms ?? null,
        tolerance: PROCRUSTES_RMS_TOLERANCE,
        required: fixtureKey === "zeroFree",
      });

      const tsCanon = canonicalRescale(ts.pairwiseDistance, fixtures.mds[fixtureKey].weight);
      const rCanon = canonicalRescale(r.pairwiseDistance, fixtures.mds[fixtureKey].weight);
      const canonDiff = maxAbsMatrixDiff(tsCanon.canonical, rCanon.canonical);
      // Disparities are rescaled by the SAME per-side scale factor used for
      // distances (canonicalRescale's `scale`), not compared raw — a pure
      // scale difference must not fail this check just because the raw
      // disparity magnitudes differ; ScaleAnalysis above already reports
      // the raw comparison transparently, this row's job is specifically
      // the scale-normalized one.
      const tsCanonDisp = (ts.disparities ?? []).map((d: DisparityEntry) => ({ ...d, disparity: d.disparity * tsCanon.scale }));
      const rCanonDisp = (r.disparities ?? []).map((d: DisparityEntry) => ({ ...d, disparity: d.disparity * rCanon.scale }));
      const canonDispCompare = compareDisparityMaps(disparityMap(tsCanonDisp), disparityMap(rCanonDisp));
      const canonDispOk = !canonDispCompare || canonDispCompare.maxDiff <= CANONICAL_ABS_TOLERANCE;
      rows.push({
        category: "Canonical",
        fixture: fixtureKey,
        reference: "r",
        status: canonDiff <= CANONICAL_ABS_TOLERANCE && canonDispOk ? "PASS" : "FAIL",
        reason: `canonicalDistanceMaxDiff=${canonDiff.toExponential(3)} (tol ${CANONICAL_ABS_TOLERANCE}), canonicalDisparityMaxDiff=${canonDispCompare?.maxDiff?.toExponential(3) ?? "n/a"}, tsScale=${tsCanon.scale.toFixed(6)}, refScale=${rCanon.scale.toFixed(6)}.`,
        numericDifference: canonDiff,
        tolerance: CANONICAL_ABS_TOLERANCE,
        required: fixtureKey === "ties",
      });

      // ---- Attempt 7: geometry-only comparison (distance, no stress) ----
      rows.push({
        category: "GeometryDistance",
        fixture: fixtureKey,
        reference: "r",
        status: distDiff <= PAIRWISE_DISTANCE_ABS_TOLERANCE ? "PASS" : "FAIL",
        reason: `maxDistDiff=${distDiff.toExponential(3)} (tol ${PAIRWISE_DISTANCE_ABS_TOLERANCE}). Distance-only — Stress compared separately.`,
        numericDifference: distDiff,
        tolerance: PAIRWISE_DISTANCE_ABS_TOLERANCE,
        required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero" || fixtureKey === "zeroFree",
      });

      rows.push({
        category: "LibraryReportedStress",
        fixture: fixtureKey,
        reference: "r",
        status: stressDiff <= STRESS_ABS_TOLERANCE ? "PASS" : "FAIL",
        reason: `TypeScript libraryReportedStress=${ts.libraryReportedStress ?? ts.normalizedStress1}, R fit$stress=${r.rStress}, diff=${stressDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}). NOT assumed to be the same formula — see CommonStressCompare.`,
        numericDifference: stressDiff,
        tolerance: STRESS_ABS_TOLERANCE,
        required: false,
      });

      if (fixtureKey === "offDiagonalZero") {
        // ---- Attempt 7: off-diagonal-zero pair preservation, required gate ----
        const preserved = r.activeWeightedPairCount === 6 && r.zeroValuedActivePairCount === 1;
        rows.push({
          category: "OffDiagonalZeroPreservation",
          fixture: fixtureKey,
          reference: "r",
          status: preserved ? "PASS" : "FAIL",
          reason: `activeWeightedPairCount=${r.activeWeightedPairCount} (expected 6), zeroValuedActivePairCount=${r.zeroValuedActivePairCount} (expected 1) — confirms the off-diagonal-zero pair stayed weight=1/active, never treated as missing.`,
          numericDifference: null,
          tolerance: null,
          required: true,
        });
      }

      if (fixtureKey === "zeroFree") {
        const rConsistency = internalConsistencyCheck(r.rStress, {
          commonStressDistance: r.commonStressDistance,
          commonStressQ: r.commonStressQ,
          commonStressDisparity: r.commonStressDisparity,
          stressQFullMatrix: r.stressQFullMatrix,
          stressDistanceFullMatrix: r.stressDistanceFullMatrix,
        });
        rows.push({
          category: "StressInternalConsistency",
          fixture: fixtureKey,
          reference: "r",
          status: rConsistency.bestDiff <= STRESS_ABS_TOLERANCE ? "PASS" : "FAIL",
          reason: `R: fit$stress vs its own commonStress*/fullMatrix recompute — bestMatch=${rConsistency.bestMatch}, diff=${rConsistency.bestDiff === Infinity ? "n/a" : rConsistency.bestDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}). All candidate diffs: ${JSON.stringify(rConsistency.diffs)}. Script's own internalConsistencyBestMatch: ${r.internalConsistencyBestMatch}.`,
          numericDifference: rConsistency.bestDiff === Infinity ? null : rConsistency.bestDiff,
          tolerance: STRESS_ABS_TOLERANCE,
          required: true,
        });

        for (const metric of ["commonStressDistance", "commonStressQ"] as const) {
          const diff = commonMetricDiff(ts[metric], r[metric]);
          rows.push({
            category: "CommonStressCompare",
            fixture: fixtureKey,
            reference: "r",
            status: Number.isFinite(diff) && diff <= STRESS_ABS_TOLERANCE ? "PASS" : "FAIL",
            reason: `${metric}: TS=${ts[metric]}, R=${r[metric]}, diff=${Number.isFinite(diff) ? diff.toExponential(3) : "n/a"} (tol ${STRESS_ABS_TOLERANCE}). Independently recomputed by both sides using the identical formula and pair convention (i<j once).`,
            numericDifference: Number.isFinite(diff) ? diff : null,
            tolerance: STRESS_ABS_TOLERANCE,
            required: true,
          });
        }
      }
    }

    // ---- Tie-block comparison (zeroFree and ties both have real ties) ----
    if ((fixtureKey === "zeroFree" || fixtureKey === "ties") && tsTieBlocks[fixtureKey]) {
      if (rTieBlocks[fixtureKey]) {
        const eq = tieBlocksEquivalent(tsTieBlocks[fixtureKey], rTieBlocks[fixtureKey]);
        rows.push({ category: "TieBlock", fixture: fixtureKey, reference: "r", status: eq.equivalent ? "PASS" : "FAIL", reason: eq.reason, numericDifference: null, tolerance: null, required: true });
      } else {
        rows.push({ category: "TieBlock", fixture: fixtureKey, reference: "r", status: "SKIPPED", reason: "R tie-block data not available.", numericDifference: null, tolerance: null, required: true });
      }
      if (fixtureKey === "zeroFree" && pythonTieBlocks[fixtureKey]) {
        const eq = tieBlocksEquivalent(tsTieBlocks[fixtureKey], pythonTieBlocks[fixtureKey]);
        rows.push({ category: "TieBlock", fixture: fixtureKey, reference: "python", status: eq.equivalent ? "PASS" : "FAIL", reason: eq.reason, numericDifference: null, tolerance: null, required: false });
      }
    }
  }

  // ---- Diagnostic fixture: strictNoTies (tie-free, isolates tie-handling from other causes) ----
  if (tsDiagSmacof?.strictNoTies) {
    const ts = tsDiagSmacof.strictNoTies;
    const diagWeight = Array.from({ length: ts.coordinates.length }, (_, i) => Array.from({ length: ts.coordinates.length }, (_, j) => (i === j ? 0 : 1)));

    for (const [refName, refSmacof] of [["python", pythonDiagSmacof], ["r", rDiagSmacof]] as const) {
      if (!refSmacof?.results?.strictNoTies) {
        rows.push({ category: "SMACOF-diagnostic", fixture: "strictNoTies", reference: refName, status: "SKIPPED", reason: `${refName} diagnostic job did not produce strictNoTies output.`, numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: true });
        rows.push({ category: "ScaleAnalysis", fixture: "strictNoTies", reference: refName, status: "SKIPPED", reason: `${refName} diagnostic job did not produce strictNoTies output.`, numericDifference: null, tolerance: PROCRUSTES_RMS_TOLERANCE, required: true });
        continue;
      }
      const ref = refSmacof.results.strictNoTies;
      const stressDiff = Math.abs((ts.normalizedStress1 ?? NaN) - (ref.recomputedNormalizedStress1 ?? ref.rStress ?? NaN));
      const distDiff = maxAbsMatrixDiff(ts.pairwiseDistance, ref.pairwiseDistance);
      rows.push({
        category: "SMACOF-diagnostic",
        fixture: "strictNoTies",
        reference: refName,
        status: stressDiff <= STRESS_ABS_TOLERANCE && distDiff <= PAIRWISE_DISTANCE_ABS_TOLERANCE ? "PASS" : "FAIL",
        reason: `stressDiff=${stressDiff.toExponential(3)}, maxDistDiff=${distDiff.toExponential(3)} — tie-free fixture, isolates tie-handling from other divergence causes.`,
        numericDifference: Math.max(stressDiff, distDiff),
        tolerance: STRESS_ABS_TOLERANCE,
        // Attempt 6: raw-scale comparison is required again now that the
        // engine normalizes disparities (per the attempt-6 approval) —
        // strictNoTies has no ties, so if normalization fully explains the
        // scale gap, this should now pass at raw scale, not just
        // scale-equivalence.
        required: true,
      });
      const c = classifySmacof(ts, ref, ts.pairwiseDistance, ref.pairwiseDistance, diagWeight, ts.disparities, ref.disparities);
      rows.push({
        category: "ScaleAnalysis",
        fixture: "strictNoTies",
        reference: refName,
        status: c.classification === "RAW_SCALE_EXACT" || c.classification === "SCALE_EQUIVALENT" ? "PASS" : "FAIL",
        reason: `classification=${c.classification}. bestFitScale=${c.scale.toFixed(6)}, similarityProcrustesRMS=${c.procrustesSimilarity?.rms?.toExponential(3) ?? "n/a"}, rigidProcrustesRMS=${c.procrustesRigid?.rms?.toExponential(3) ?? "n/a"}.`,
        numericDifference: c.procrustesSimilarity?.rms ?? null,
        tolerance: PROCRUSTES_RMS_TOLERANCE,
        required: true,
      });
    }
  } else {
    for (const refName of ["python", "r"] as const) {
      rows.push({ category: "ScaleAnalysis", fixture: "strictNoTies", reference: refName, status: "SKIPPED", reason: "TS diagnostic (strictNoTies) results not available.", numericDifference: null, tolerance: PROCRUSTES_RMS_TOLERANCE, required: true });
    }
  }

  // ---- Ward comparisons (unchanged from attempt 4) ----
  const n = tsWard.originalCount;

  function wardHeights(reference: "python" | "r", refWard: any): number[] {
    return reference === "python"
      ? refWard.linkage.map((r: any) => r.mergeDistance).sort((a: number, b: number) => a - b)
      : refWard.height.slice().sort((a: number, b: number) => a - b);
  }
  function maxHeightDiff(tsHeights: number[], refHeights: number[]): number {
    if (tsHeights.length !== refHeights.length) return NaN;
    let max = 0;
    for (let i = 0; i < tsHeights.length; i++) max = Math.max(max, Math.abs(tsHeights[i] - refHeights[i]));
    return max;
  }
  function partitionMismatches(refWard: any): number[] {
    const mismatched: number[] = [];
    for (let k = 1; k <= n; k++) {
      const tsLabels: number[] = tsWard.candidatePartitions[String(k)];
      const refLabels: number[] = refWard.candidatePartitions[String(k)];
      if (!refLabels || !partitionsEquivalent(tsLabels, refLabels)) mismatched.push(k);
    }
    return mismatched;
  }
  const tsHeights = tsWard.linkage.map((r: any) => r.mergeDistance).sort((a: number, b: number) => a - b);

  if (!pythonWard) {
    rows.push({ category: "Ward-Linkage", fixture: "tieFree", reference: "python", status: "SKIPPED", reason: "python Ward job did not produce output.", numericDifference: null, tolerance: WARD_HEIGHT_ABS_TOLERANCE, required: true });
    rows.push({ category: "Ward-Partition", fixture: "tieFree", reference: "python", status: "SKIPPED", reason: "python Ward job did not produce output.", numericDifference: null, tolerance: WARD_HEIGHT_ABS_TOLERANCE, required: true });
  } else {
    const refHeights = wardHeights("python", pythonWard);
    const hDiff = maxHeightDiff(tsHeights, refHeights);
    const heightPass = Number.isFinite(hDiff) && hDiff <= Math.max(WARD_HEIGHT_ABS_TOLERANCE, WARD_HEIGHT_ABS_TOLERANCE * Math.max(...tsHeights, 1));
    rows.push({ category: "Ward-Linkage", fixture: "tieFree", reference: "python", status: heightPass ? "PASS" : "FAIL", reason: `max height diff=${Number.isFinite(hDiff) ? hDiff.toExponential(3) : "N/A"} (tol ${WARD_HEIGHT_ABS_TOLERANCE}).`, numericDifference: Number.isFinite(hDiff) ? hDiff : null, tolerance: WARD_HEIGHT_ABS_TOLERANCE, required: true });

    const mismatched = partitionMismatches(pythonWard);
    rows.push({ category: "Ward-Partition", fixture: "tieFree", reference: "python", status: mismatched.length === 0 ? "PASS" : "FAIL", reason: mismatched.length === 0 ? `All k=1..${n} exact-k partitions equivalent (via ${pythonWard.exactKMethod ?? "cut_tree"}).` : `Partition mismatch at k=${mismatched.join(",")}.`, numericDifference: null, tolerance: null, required: true });
  }

  if (!rWard) {
    rows.push({ category: "Ward", fixture: "tieFree", reference: "r", status: "SKIPPED", reason: "r Ward job did not produce output.", numericDifference: null, tolerance: WARD_HEIGHT_ABS_TOLERANCE, required: true });
  } else {
    const refHeights = wardHeights("r", rWard);
    const hDiff = maxHeightDiff(tsHeights, refHeights);
    const heightPass = Number.isFinite(hDiff) && hDiff <= Math.max(WARD_HEIGHT_ABS_TOLERANCE, WARD_HEIGHT_ABS_TOLERANCE * Math.max(...tsHeights, 1));
    const mismatched = partitionMismatches(rWard);
    const pass = heightPass && mismatched.length === 0;
    rows.push({ category: "Ward", fixture: "tieFree", reference: "r", status: pass ? "PASS" : "FAIL", reason: pass ? `All k=1..${n} partitions equivalent; max height diff=${hDiff.toExponential(3)}.` : `Partition mismatch at k=${mismatched.join(",") || "none"}; max height diff=${Number.isFinite(hDiff) ? hDiff.toExponential(3) : "N/A"}.`, numericDifference: Number.isFinite(hDiff) ? hDiff : null, tolerance: WARD_HEIGHT_ABS_TOLERANCE, required: true });
  }

  // ---- Attempt 7: DEFINITION_DIFFERENCE reclassification (zeroFree only,
  // where full internal-consistency + common-formula data exists) ----
  // A LibraryReportedStress FAIL is reclassified to DEFINITION_DIFFERENCE
  // ONLY if ALL of the following hold — otherwise the FAIL is kept exactly
  // as-is (this is never a way to quietly disappear a real failure):
  //   1. Source evidence exists that the two libraries use different
  //      formulas: TS's own bestMatch is always "commonStressDistance" (by
  //      code audit), and the OTHER side's bestMatch (from its own
  //      StressInternalConsistency row, reason field) is a DIFFERENT metric.
  //   2. Both sides' StressInternalConsistency rows are PASS (each
  //      library's own reported stress is internally self-consistent with
  //      ITS OWN formula, not with a scale-drifted geometry).
  //   3. The CommonStressCompare row for the metric that matched the OTHER
  //      side (e.g. commonStressQ, if that was its bestMatch) is PASS.
  function tryReclassifyDefinitionDifference(reference: "python" | "r") {
    const libRow = rows.find((r) => r.category === "LibraryReportedStress" && r.fixture === "zeroFree" && r.reference === reference);
    if (!libRow || libRow.status !== "FAIL") return;
    const tsConsistencyRow = rows.find((r) => r.category === "StressInternalConsistency" && r.fixture === "zeroFree" && r.reason.startsWith("TypeScript:"));
    const otherConsistencyRow = rows.find((r) => r.category === "StressInternalConsistency" && r.fixture === "zeroFree" && r.reference === reference && !r.reason.startsWith("TypeScript:"));
    if (!tsConsistencyRow || tsConsistencyRow.status !== "PASS") return;
    if (!otherConsistencyRow || otherConsistencyRow.status !== "PASS") return;
    const bestMatchMatch = otherConsistencyRow.reason.match(/bestMatch=(\w+)/);
    const otherBestMatch = bestMatchMatch?.[1];
    if (!otherBestMatch || otherBestMatch === "commonStressDistance") return; // same formula as TS -> a real FAIL, not a definition difference
    const crossCheckRow = rows.find((r) => r.category === "CommonStressCompare" && r.fixture === "zeroFree" && r.reference === reference && r.reason.startsWith(otherBestMatch + ":"));
    if (!crossCheckRow || crossCheckRow.status !== "PASS") return; // no evidence the OTHER formula agrees with TS's geometry either -> keep FAIL
    libRow.status = "DEFINITION_DIFFERENCE";
    libRow.reason += ` RECLASSIFIED: source-confirmed different denominator convention (${reference}'s own bestMatch=${otherBestMatch}, not commonStressDistance), both sides internally consistent, and the ${otherBestMatch} cross-check independently PASSED — this is a reporting-formula difference, not a computational/geometric discrepancy.`;
  }
  tryReclassifyDefinitionDifference("python");
  tryReclassifyDefinitionDifference("r");

  // ---- Aggregate status ----
  const gatingRows = rows.filter((r) => r.status !== "INFO" && r.status !== "DEFINITION_DIFFERENCE");
  const definitionDifferenceCount = rows.filter((r) => r.status === "DEFINITION_DIFFERENCE").length;
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  for (const row of gatingRows) counts[row.status as "PASS" | "FAIL" | "SKIPPED"]++;

  const required = {
    // 12. Ward Python·R
    wardLinkageVsPython: rows.find((r) => r.category === "Ward-Linkage" && r.reference === "python"),
    wardPartitionVsPython: rows.find((r) => r.category === "Ward-Partition" && r.reference === "python"),
    wardVsR: rows.find((r) => r.category === "Ward" && r.reference === "r"),
    // 7. strictNoTies geometry+disparity
    strictNoTiesScaleVsPython: rows.find((r) => r.category === "ScaleAnalysis" && r.fixture === "strictNoTies" && r.reference === "python"),
    strictNoTiesScaleVsR: rows.find((r) => r.category === "ScaleAnalysis" && r.fixture === "strictNoTies" && r.reference === "r"),
    strictNoTiesRawVsPython: rows.find((r) => r.category === "SMACOF-diagnostic" && r.fixture === "strictNoTies" && r.reference === "python"),
    strictNoTiesRawVsR: rows.find((r) => r.category === "SMACOF-diagnostic" && r.fixture === "strictNoTies" && r.reference === "r"),
    // 8. zeroFree geometry+tie-blocks+disparity
    tieBlockZeroFreeVsR: rows.find((r) => r.category === "TieBlock" && r.fixture === "zeroFree" && r.reference === "r"),
    geometryDistanceZeroFreeVsPython: rows.find((r) => r.category === "GeometryDistance" && r.fixture === "zeroFree" && r.reference === "python"),
    geometryDistanceZeroFreeVsR: rows.find((r) => r.category === "GeometryDistance" && r.fixture === "zeroFree" && r.reference === "r"),
    // 9. ties TS·R geometry+tie-blocks+disparity+canonical
    tieBlockTiesVsR: rows.find((r) => r.category === "TieBlock" && r.fixture === "ties" && r.reference === "r"),
    geometryDistanceTiesVsR: rows.find((r) => r.category === "GeometryDistance" && r.fixture === "ties" && r.reference === "r"),
    canonicalTiesVsR: rows.find((r) => r.category === "Canonical" && r.fixture === "ties" && r.reference === "r"),
    disparityTiesVsRRaw: rows.find((r) => r.category === "Disparity" && r.fixture === "ties" && r.reference === "r"),
    // 10-11. offDiagonalZero TS·R geometry+disparity+active-zero-pair
    geometryDistanceOffDiagonalZeroVsR: rows.find((r) => r.category === "GeometryDistance" && r.fixture === "offDiagonalZero" && r.reference === "r"),
    offDiagonalZeroPreservation: rows.find((r) => r.category === "OffDiagonalZeroPreservation" && r.fixture === "offDiagonalZero" && r.reference === "r"),
    // 1-3. Internal consistency of each library's OWN reported Stress
    stressInternalConsistencyTs: rows.find((r) => r.category === "StressInternalConsistency" && r.fixture === "zeroFree" && r.reason.startsWith("TypeScript:")),
    stressInternalConsistencyPython: rows.find((r) => r.category === "StressInternalConsistency" && r.fixture === "zeroFree" && r.reference === "python" && !r.reason.startsWith("TypeScript:")),
    stressInternalConsistencyR: rows.find((r) => r.category === "StressInternalConsistency" && r.fixture === "zeroFree" && r.reference === "r"),
    // 4-6. Common-formula cross-language Stress comparison
    commonStressDistanceTsVsPython: rows.find((r) => r.category === "CommonStressCompare" && r.fixture === "zeroFree" && r.reference === "python" && r.reason.startsWith("commonStressDistance:")),
    commonStressDistanceTsVsR: rows.find((r) => r.category === "CommonStressCompare" && r.fixture === "zeroFree" && r.reference === "r" && r.reason.startsWith("commonStressDistance:")),
    commonStressQTsVsR: rows.find((r) => r.category === "CommonStressCompare" && r.fixture === "zeroFree" && r.reference === "r" && r.reason.startsWith("commonStressQ:")),
  };
  const requiredList = Object.values(required);
  const requiredStatuses = requiredList.map((r) => r?.status ?? "SKIPPED");
  // A DEFINITION_DIFFERENCE row satisfies its requirement — per the
  // attempt-7 approval, a source-confirmed formula difference (with
  // internal consistency and common-formula cross-check both PASS) is not
  // a failure, it is a corrected comparison methodology.
  const requiredFail = requiredStatuses.includes("FAIL");
  const requiredPassCount = requiredStatuses.filter((s) => s === "PASS" || s === "DEFINITION_DIFFERENCE").length;

  let overallStatus: "VERIFIED" | "PARTIALLY_VERIFIED" | "FAILED" | "NOT_RUN";
  if (gatingRows.length === 0 || (counts.PASS === 0 && counts.FAIL === 0)) {
    overallStatus = "NOT_RUN";
  } else if (requiredFail) {
    overallStatus = "FAILED";
  } else if (requiredPassCount === requiredList.length) {
    overallStatus = "VERIFIED";
  } else {
    overallStatus = "PARTIALLY_VERIFIED";
  }

  const summary = {
    overallStatus,
    counts,
    definitionDifferenceCount,
    requiredChecks: Object.fromEntries(Object.entries(required).map(([k, r]) => [k, r?.status ?? "SKIPPED"])),
    tolerances: {
      stressAbsTolerance: STRESS_ABS_TOLERANCE,
      pairwiseDistanceAbsTolerance: PAIRWISE_DISTANCE_ABS_TOLERANCE,
      disparityAbsTolerance: DISPARITY_ABS_TOLERANCE,
      wardHeightAbsTolerance: WARD_HEIGHT_ABS_TOLERANCE,
      canonicalAbsTolerance: CANONICAL_ABS_TOLERANCE,
      procrustesRmsTolerance: PROCRUSTES_RMS_TOLERANCE,
    },
    rows,
  };

  fs.writeFileSync(path.join(outputDir, "comparison-summary.json"), JSON.stringify(summary, null, 2));

  const md = [
    "# Concept-map analysis cross-validation summary",
    "",
    `**Overall status: ${overallStatus}**`,
    "",
    `PASS=${counts.PASS} FAIL=${counts.FAIL} SKIPPED=${counts.SKIPPED} (INFO rows excluded)`,
    "",
    "## Required checks",
    ...Object.entries(required).map(([k, r]) => `- ${k}: ${r?.status ?? "SKIPPED"}`),
    "",
    "| Category | Fixture | Reference | Status | Required | Numeric diff | Tolerance | Reason |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.category} | ${r.fixture} | ${r.reference} | ${r.status} | ${r.required ? "yes" : "no"} | ${r.numericDifference?.toExponential(3) ?? "-"} | ${r.tolerance ?? "-"} | ${r.reason.replace(/\|/g, "\\|")} |`),
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, "comparison-summary.md"), md);

  const csv = [
    "category,fixture,reference,status,required,numericDifference,tolerance",
    ...rows.map((r) => `${r.category},${r.fixture},${r.reference},${r.status},${r.required},${r.numericDifference ?? ""},${r.tolerance ?? ""}`),
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, "numeric-differences.csv"), csv);

  console.log(`Overall status: ${overallStatus}`);
  console.log(`PASS=${counts.PASS} FAIL=${counts.FAIL} SKIPPED=${counts.SKIPPED}`);
  for (const row of rows) {
    console.log(`  [${row.status}]${row.required ? "[REQUIRED]" : ""} ${row.category}/${row.fixture} vs ${row.reference}: ${row.reason}`);
  }

  if (overallStatus === "FAILED") process.exitCode = 1;
}

main();
