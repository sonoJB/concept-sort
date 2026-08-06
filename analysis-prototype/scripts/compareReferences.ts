/**
 * Compares TypeScript SMACOF/Ward results against Python (scikit-learn/
 * SciPy) and R (smacof/hclust) reference results, produced by
 * runTsReference.ts / ci_python.py / ci_r.R from the SAME shared fixtures
 * JSON. Never treats a SKIPPED comparison as a PASS, and never auto-passes
 * TypeScript when an external tool failed to run.
 *
 * Tolerances are declared here, BEFORE any result has been inspected, and
 * are not to be loosened after seeing a failure:
 *
 *   STRESS_ABS_TOLERANCE = 1e-4
 *     Both sides converge their own objective to eps=1e-9; residual
 *     cross-implementation float64 noise (different isotonic-regression and
 *     eigendecomposition/pseudo-inverse implementations) accumulated over
 *     up to a few hundred majorization iterations on n<=5 items is expected
 *     to stay well under 1e-4 if the underlying math genuinely agrees.
 *
 *   PAIRWISE_DISTANCE_ABS_TOLERANCE = 1e-3
 *     Looser than the stress tolerance because stress aggregates over all
 *     pairs (errors partially cancel), while individual pairwise distances
 *     do not benefit from that averaging.
 *
 *   DISPARITY_ABS_TOLERANCE = 1e-3
 *     Same order as the pairwise-distance tolerance — disparities are a
 *     monotone transform of distances via the same isotonic regression.
 *
 *   WARD_HEIGHT_ABS_TOLERANCE = 1e-6
 *     Ward linkage on FIXED input coordinates is a deterministic, one-shot
 *     computation (no iterative optimization) — implementations using the
 *     same Lance-Williams formula should agree to near machine precision,
 *     not just "roughly".
 *
 * VERIFIED requires ALL SIX of the following to PASS (attempt 4 criteria):
 *   1. SMACOF/zeroFree vs python (current scikit-learn version)
 *   2. SMACOF/ties vs r (ordinal, ties="secondary")
 *   3. SMACOF/offDiagonalZero vs r
 *   4. Ward-Linkage/tieFree vs python (SciPy linkage heights)
 *   5. Ward-Partition/tieFree vs python (SciPy exact-k partitions, via cut_tree)
 *   6. Ward/tieFree vs r (R ward.D2, linkage + partition combined — R's
 *      cutree does not have SciPy's maxclust exact-k ambiguity, so this
 *      stays a single combined row for R)
 * Any SKIPPED among these six means NOT verified (falls to
 * PARTIALLY_VERIFIED, never silently promoted). A legacy-scikit-learn
 * comparison (if supplied) is always diagnostic-only ("INFO" status) and
 * never affects overallStatus.
 *
 * Usage:
 *   npx tsx analysis-prototype/scripts/compareReferences.ts <fixtures.json> <ts-dir> <python-current-dir> <r-dir> <output-dir> [python-legacy-dir]
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

type Status = "PASS" | "FAIL" | "SKIPPED" | "INFO";

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

// Partition equivalence: same grouping regardless of label numbering.
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

/** Builds a (i,j) -> disparity lookup from TS's pair-object array. */
function tsDisparityMap(disparities: { i: number; j: number; disparity: number }[] | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of disparities ?? []) m.set(`${d.i},${d.j}`, d.disparity);
  return m;
}

/** Same shape as tsDisparityMap, for Python's identically-shaped output. */
function pythonDisparityMap(disparities: { i: number; j: number; disparity: number }[] | null): Map<string, number> {
  return tsDisparityMap(disparities);
}

/** R's dhat is a full n x n matrix (matrix_to_json_rows); extract active upper-triangle pairs. */
function rDisparityMap(dhat: number[][] | null, weight: number[][] | null): Map<string, number> {
  const m = new Map<string, number>();
  if (!dhat || !weight) return m;
  const n = dhat.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (weight[i][j] > 0) m.set(`${i},${j}`, dhat[i][j]);
    }
  }
  return m;
}

function compareDisparityMaps(tsMap: Map<string, number>, refMap: Map<string, number>): { maxDiff: number; matchedPairs: number } | null {
  let maxDiff = 0;
  let matchedPairs = 0;
  for (const [key, tsVal] of tsMap) {
    const refVal = refMap.get(key);
    if (refVal === undefined) continue;
    matchedPairs++;
    maxDiff = Math.max(maxDiff, Math.abs(tsVal - refVal));
  }
  if (matchedPairs === 0) return null;
  return { maxDiff, matchedPairs };
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

  let pythonSmacof: any = null;
  let pythonAvailable = false;
  try {
    pythonSmacof = readJson(path.join(pythonDir, "python-smacof-results.json"));
    pythonAvailable = true;
  } catch {
    /* python job did not produce output */
  }
  const pythonWard = tryReadJson(path.join(pythonDir, "python-ward-results.json"));

  let rSmacof: any = null;
  let rAvailable = false;
  try {
    rSmacof = readJson(path.join(rDir, "r-smacof-results.json"));
    rAvailable = true;
  } catch {
    /* r job did not produce output */
  }
  const rWard = tryReadJson(path.join(rDir, "r-ward-results.json"));

  const pythonLegacySmacof = pythonLegacyDir ? tryReadJson(path.join(pythonLegacyDir, "python-smacof-results.json")) : null;

  // ---- SMACOF comparisons ----
  for (const fixtureKey of Object.keys(fixtures.mds)) {
    const ts = tsSmacof[fixtureKey];

    // vs Python (current — this is the gating reference)
    if (!pythonAvailable) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "SKIPPED", reason: "Python job did not produce output.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "zeroFree" });
    } else if (pythonSmacof.skipped?.[fixtureKey]) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "SKIPPED", reason: pythonSmacof.skipped[fixtureKey], numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "zeroFree" });
    } else if (!pythonSmacof.results?.[fixtureKey] || !ts || ts.errorCode) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "FAIL", reason: "Missing or errored result on one side.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "zeroFree" });
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
        reason: `stressDiff=${stressDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}), maxDistDiff=${distDiff.toExponential(3)} (tol ${PAIRWISE_DISTANCE_ABS_TOLERANCE}). scikit-learn version: ${pythonSmacof.versionLabel ?? "unknown"}. Note: comparison uses independently-recomputed Stress-1 on the Python side (see ci_python.py), not sklearn's own reported stress, to guarantee the same formula is being compared.`,
        numericDifference: Math.max(stressDiff, distDiff),
        tolerance: STRESS_ABS_TOLERANCE,
        required: fixtureKey === "zeroFree",
      });

      // Disparity comparison (diagnostic-informative, not itself part of the
      // 6 required VERIFIED checks, but reported per §7 of the request).
      const tsMap = tsDisparityMap(ts.disparities);
      const pyMap = pythonDisparityMap(py.disparities);
      const dCompare = compareDisparityMaps(tsMap, pyMap);
      if (dCompare) {
        rows.push({
          category: "Disparity",
          fixture: fixtureKey,
          reference: "python",
          status: dCompare.maxDiff <= DISPARITY_ABS_TOLERANCE ? "PASS" : "FAIL",
          reason: `maxAbsDisparityDiff=${dCompare.maxDiff.toExponential(3)} (tol ${DISPARITY_ABS_TOLERANCE}) over ${dCompare.matchedPairs} matched pairs.`,
          numericDifference: dCompare.maxDiff,
          tolerance: DISPARITY_ABS_TOLERANCE,
          required: false,
        });
      }
    }

    // vs Python legacy (diagnostic only, never gates VERIFIED)
    if (pythonLegacyDir) {
      if (!pythonLegacySmacof) {
        rows.push({ category: "SMACOF-legacy-diagnostic", fixture: fixtureKey, reference: "python-legacy", status: "INFO", reason: "Legacy scikit-learn job did not produce output (diagnostic only, does not affect VERIFIED status).", numericDifference: null, tolerance: null, required: false });
      } else if (pythonLegacySmacof.skipped?.[fixtureKey]) {
        rows.push({ category: "SMACOF-legacy-diagnostic", fixture: fixtureKey, reference: "python-legacy", status: "INFO", reason: pythonLegacySmacof.skipped[fixtureKey], numericDifference: null, tolerance: null, required: false });
      } else if (pythonLegacySmacof.results?.[fixtureKey] && ts && !ts.errorCode) {
        const legacy = pythonLegacySmacof.results[fixtureKey];
        const stressDiff = Math.abs((ts.normalizedStress1 ?? NaN) - (legacy.recomputedNormalizedStress1 ?? NaN));
        const distDiff = maxAbsMatrixDiff(ts.pairwiseDistance, legacy.pairwiseDistance);
        rows.push({
          category: "SMACOF-legacy-diagnostic",
          fixture: fixtureKey,
          reference: "python-legacy",
          status: "INFO",
          reason: `[diagnostic only, not part of VERIFIED gating] stressDiff=${stressDiff.toExponential(3)}, maxDistDiff=${distDiff.toExponential(3)} vs scikit-learn ${pythonLegacySmacof.versionLabel ?? "legacy"} (${legacy.nIter} iterations vs current's iteration count) — used only to explain whether a current-vs-legacy sklearn difference exists, never to gate VERIFIED.`,
          numericDifference: Math.max(stressDiff, distDiff),
          tolerance: null,
          required: false,
        });
      }
    }

    // vs R
    if (!rAvailable) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "SKIPPED", reason: "R job did not produce output.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero" });
    } else if (rSmacof.skipped?.[fixtureKey]) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "SKIPPED", reason: rSmacof.skipped[fixtureKey], numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero" });
    } else if (!rSmacof.results?.[fixtureKey] || !ts || ts.errorCode) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "FAIL", reason: "Missing or errored result on one side.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE, required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero" });
    } else {
      const r = rSmacof.results[fixtureKey];
      // r.rStress is the smacof package's own stress value; its exact
      // relationship to this project's normalizedStress1 (both claim to be
      // Stress-1-like, but the packages were not independently confirmed to
      // use byte-identical formulas) is compared numerically here — a large
      // gap must be investigated (per §17), not assumed equivalent or
      // assumed different.
      const stressDiff = Math.abs((ts.normalizedStress1 ?? NaN) - (r.rStress ?? NaN));
      const distDiff = maxAbsMatrixDiff(ts.pairwiseDistance, r.pairwiseDistance);
      const pass = stressDiff <= STRESS_ABS_TOLERANCE && distDiff <= PAIRWISE_DISTANCE_ABS_TOLERANCE;
      rows.push({
        category: "SMACOF",
        fixture: fixtureKey,
        reference: "r",
        status: pass ? "PASS" : "FAIL",
        reason: `stressDiff=${stressDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}), maxDistDiff=${distDiff.toExponential(3)} (tol ${PAIRWISE_DISTANCE_ABS_TOLERANCE}). ties="secondary" used on both sides for this fixture. activeWeightedPairCount=${r.activeWeightedPairCount}, zeroValuedActivePairCount=${r.zeroValuedActivePairCount}.`,
        numericDifference: Math.max(stressDiff, distDiff),
        tolerance: STRESS_ABS_TOLERANCE,
        required: fixtureKey === "ties" || fixtureKey === "offDiagonalZero",
      });

      const tsMap = tsDisparityMap(ts.disparities);
      const rMap = rDisparityMap(r.dhat, r.weightmat);
      const dCompare = compareDisparityMaps(tsMap, rMap);
      if (dCompare) {
        rows.push({
          category: "Disparity",
          fixture: fixtureKey,
          reference: "r",
          status: dCompare.maxDiff <= DISPARITY_ABS_TOLERANCE ? "PASS" : "FAIL",
          reason: `maxAbsDisparityDiff=${dCompare.maxDiff.toExponential(3)} (tol ${DISPARITY_ABS_TOLERANCE}) over ${dCompare.matchedPairs} matched pairs.`,
          numericDifference: dCompare.maxDiff,
          tolerance: DISPARITY_ABS_TOLERANCE,
          required: false,
        });
      }
    }
  }

  // ---- Ward comparisons ----
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

  // Python: split into Ward-Linkage and Ward-Partition (the attempt-3
  // failure was purely a partition/exact-k harness bug; linkage itself was
  // already byte-identical — keeping these separate makes that visible
  // rather than lumping a linkage PASS and a partition FAIL into one row).
  if (!pythonWard) {
    rows.push({ category: "Ward-Linkage", fixture: "tieFree", reference: "python", status: "SKIPPED", reason: "python Ward job did not produce output.", numericDifference: null, tolerance: WARD_HEIGHT_ABS_TOLERANCE, required: true });
    rows.push({ category: "Ward-Partition", fixture: "tieFree", reference: "python", status: "SKIPPED", reason: "python Ward job did not produce output.", numericDifference: null, tolerance: WARD_HEIGHT_ABS_TOLERANCE, required: true });
  } else {
    const refHeights = wardHeights("python", pythonWard);
    const hDiff = maxHeightDiff(tsHeights, refHeights);
    const heightPass = Number.isFinite(hDiff) && hDiff <= Math.max(WARD_HEIGHT_ABS_TOLERANCE, WARD_HEIGHT_ABS_TOLERANCE * Math.max(...tsHeights, 1));
    rows.push({
      category: "Ward-Linkage",
      fixture: "tieFree",
      reference: "python",
      status: heightPass ? "PASS" : "FAIL",
      reason: `max height diff=${Number.isFinite(hDiff) ? hDiff.toExponential(3) : "N/A (length mismatch)"} (tol ${WARD_HEIGHT_ABS_TOLERANCE}), comparing TS mergeDistance sorted ascending against SciPy linkage() height sorted ascending.`,
      numericDifference: Number.isFinite(hDiff) ? hDiff : null,
      tolerance: WARD_HEIGHT_ABS_TOLERANCE,
      required: true,
    });

    const mismatched = partitionMismatches(pythonWard);
    const partitionPass = mismatched.length === 0;
    rows.push({
      category: "Ward-Partition",
      fixture: "tieFree",
      reference: "python",
      status: partitionPass ? "PASS" : "FAIL",
      reason: partitionPass
        ? `All k=1..${n} exact-k partitions equivalent (via ${pythonWard.exactKMethod ?? "scipy.cluster.hierarchy.cut_tree"}).`
        : `Partition mismatch at k=${mismatched.join(",")} (method: ${pythonWard.exactKMethod ?? "unknown"}).`,
      numericDifference: null,
      tolerance: null,
      required: true,
    });
  }

  // R: single combined row (cutree has no maxclust-style exact-k ambiguity).
  if (!rWard) {
    rows.push({ category: "Ward", fixture: "tieFree", reference: "r", status: "SKIPPED", reason: "r Ward job did not produce output.", numericDifference: null, tolerance: WARD_HEIGHT_ABS_TOLERANCE, required: true });
  } else {
    const refHeights = wardHeights("r", rWard);
    const hDiff = maxHeightDiff(tsHeights, refHeights);
    const heightPass = Number.isFinite(hDiff) && hDiff <= Math.max(WARD_HEIGHT_ABS_TOLERANCE, WARD_HEIGHT_ABS_TOLERANCE * Math.max(...tsHeights, 1));
    const mismatched = partitionMismatches(rWard);
    const pass = heightPass && mismatched.length === 0;
    rows.push({
      category: "Ward",
      fixture: "tieFree",
      reference: "r",
      status: pass ? "PASS" : "FAIL",
      reason: pass
        ? `All k=1..${n} partitions equivalent; max height diff=${hDiff.toExponential(3)} (tol ${WARD_HEIGHT_ABS_TOLERANCE}) vs R ward.D2 height.`
        : `Partition mismatch at k=${mismatched.join(",") || "none"}; max height diff=${Number.isFinite(hDiff) ? hDiff.toExponential(3) : "N/A (length mismatch)"} (tol ${WARD_HEIGHT_ABS_TOLERANCE}).`,
      numericDifference: Number.isFinite(hDiff) ? hDiff : null,
      tolerance: WARD_HEIGHT_ABS_TOLERANCE,
      required: true,
    });
  }

  // ---- Aggregate status ----
  const gatingRows = rows.filter((r) => r.status !== "INFO");
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  for (const row of gatingRows) counts[row.status as "PASS" | "FAIL" | "SKIPPED"]++;

  // The six required checks per the attempt-4 VERIFIED definition.
  const required = {
    smacofZeroFreeVsPythonCurrent: rows.find((r) => r.category === "SMACOF" && r.fixture === "zeroFree" && r.reference === "python"),
    smacofTiesVsR: rows.find((r) => r.category === "SMACOF" && r.fixture === "ties" && r.reference === "r"),
    smacofOffDiagonalZeroVsR: rows.find((r) => r.category === "SMACOF" && r.fixture === "offDiagonalZero" && r.reference === "r"),
    wardLinkageVsPython: rows.find((r) => r.category === "Ward-Linkage" && r.reference === "python"),
    wardPartitionVsPython: rows.find((r) => r.category === "Ward-Partition" && r.reference === "python"),
    wardVsR: rows.find((r) => r.category === "Ward" && r.reference === "r"),
  };
  const requiredList = Object.values(required);
  const requiredStatuses = requiredList.map((r) => r?.status ?? "SKIPPED");
  const requiredFail = requiredStatuses.includes("FAIL");
  const requiredPassCount = requiredStatuses.filter((s) => s === "PASS").length;

  let overallStatus: "VERIFIED" | "PARTIALLY_VERIFIED" | "FAILED" | "NOT_RUN";
  if (gatingRows.length === 0 || (counts.PASS === 0 && counts.FAIL === 0)) {
    // Nothing was actually compared (every gating row SKIPPED, or no rows
    // at all) — this must never read as "partial success". Nothing ran.
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
    requiredChecks: Object.fromEntries(Object.entries(required).map(([k, r]) => [k, r?.status ?? "SKIPPED"])),
    tolerances: {
      stressAbsTolerance: STRESS_ABS_TOLERANCE,
      pairwiseDistanceAbsTolerance: PAIRWISE_DISTANCE_ABS_TOLERANCE,
      disparityAbsTolerance: DISPARITY_ABS_TOLERANCE,
      wardHeightAbsTolerance: WARD_HEIGHT_ABS_TOLERANCE,
    },
    rows,
  };

  fs.writeFileSync(path.join(outputDir, "comparison-summary.json"), JSON.stringify(summary, null, 2));

  const md = [
    "# Concept-map analysis cross-validation summary",
    "",
    `**Overall status: ${overallStatus}**`,
    "",
    `PASS=${counts.PASS} FAIL=${counts.FAIL} SKIPPED=${counts.SKIPPED} (INFO rows excluded from these counts)`,
    "",
    "## Required checks (all 6 must PASS for VERIFIED)",
    ...Object.entries(required).map(([k, r]) => `- ${k}: ${r?.status ?? "SKIPPED"}`),
    "",
    "| Category | Fixture | Reference | Status | Required | Numeric diff | Tolerance | Reason |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.category} | ${r.fixture} | ${r.reference} | ${r.status} | ${r.required ? "yes" : "no"} | ${r.numericDifference?.toExponential(3) ?? "-"} | ${r.tolerance ?? "-"} | ${r.reason.replace(/\|/g, "\\|")} |`
    ),
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
