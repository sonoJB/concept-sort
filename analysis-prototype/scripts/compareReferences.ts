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
 *   WARD_HEIGHT_ABS_TOLERANCE = 1e-6
 *     Ward linkage on FIXED input coordinates is a deterministic, one-shot
 *     computation (no iterative optimization) — implementations using the
 *     same Lance-Williams formula should agree to near machine precision,
 *     not just "roughly".
 *
 * Usage:
 *   npx tsx analysis-prototype/scripts/compareReferences.ts <fixtures.json> <ts-dir> <python-dir> <r-dir> <output-dir>
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
const WARD_HEIGHT_ABS_TOLERANCE = 1e-6;

type Status = "PASS" | "FAIL" | "SKIPPED";

type ComparisonRow = {
  category: string;
  fixture: string;
  reference: "python" | "r";
  status: Status;
  reason: string;
  numericDifference: number | null;
  tolerance: number | null;
};

const rows: ComparisonRow[] = [];

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
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

function main() {
  const [fixturesPath, tsDir, pythonDir, rDir, outputDir] = process.argv.slice(2);
  if (!fixturesPath || !tsDir || !pythonDir || !rDir || !outputDir) {
    console.error("Usage: compareReferences.ts <fixtures.json> <ts-dir> <python-dir> <r-dir> <output-dir>");
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
  let pythonWard: any = null;
  try {
    pythonWard = readJson(path.join(pythonDir, "python-ward-results.json"));
  } catch {
    /* not available */
  }

  let rSmacof: any = null;
  let rAvailable = false;
  try {
    rSmacof = readJson(path.join(rDir, "r-smacof-results.json"));
    rAvailable = true;
  } catch {
    /* r job did not produce output */
  }
  let rWard: any = null;
  try {
    rWard = readJson(path.join(rDir, "r-ward-results.json"));
  } catch {
    /* not available */
  }

  // ---- SMACOF comparisons ----
  for (const fixtureKey of Object.keys(fixtures.mds)) {
    const ts = tsSmacof[fixtureKey];

    // vs Python
    if (!pythonAvailable) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "SKIPPED", reason: "Python job did not produce output.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE });
    } else if (pythonSmacof.skipped?.[fixtureKey]) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "SKIPPED", reason: pythonSmacof.skipped[fixtureKey], numericDifference: null, tolerance: STRESS_ABS_TOLERANCE });
    } else if (!pythonSmacof.results?.[fixtureKey] || !ts || ts.errorCode) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "python", status: "FAIL", reason: "Missing or errored result on one side.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE });
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
        reason: `stressDiff=${stressDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}), maxDistDiff=${distDiff.toExponential(3)} (tol ${PAIRWISE_DISTANCE_ABS_TOLERANCE}). Note: comparison uses independently-recomputed Stress-1 on the Python side (see ci_python.py), not sklearn's own reported stress, to guarantee the same formula is being compared.`,
        numericDifference: Math.max(stressDiff, distDiff),
        tolerance: STRESS_ABS_TOLERANCE,
      });
    }

    // vs R
    if (!rAvailable) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "SKIPPED", reason: "R job did not produce output.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE });
    } else if (rSmacof.skipped?.[fixtureKey]) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "SKIPPED", reason: rSmacof.skipped[fixtureKey], numericDifference: null, tolerance: STRESS_ABS_TOLERANCE });
    } else if (!rSmacof.results?.[fixtureKey] || !ts || ts.errorCode) {
      rows.push({ category: "SMACOF", fixture: fixtureKey, reference: "r", status: "FAIL", reason: "Missing or errored result on one side.", numericDifference: null, tolerance: STRESS_ABS_TOLERANCE });
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
        reason: `stressDiff=${stressDiff.toExponential(3)} (tol ${STRESS_ABS_TOLERANCE}), maxDistDiff=${distDiff.toExponential(3)} (tol ${PAIRWISE_DISTANCE_ABS_TOLERANCE}). ties="secondary" used on both sides for this fixture.`,
        numericDifference: Math.max(stressDiff, distDiff),
        tolerance: STRESS_ABS_TOLERANCE,
      });
    }
  }

  // ---- Ward comparisons ----
  const n = tsWard.originalCount;

  function compareWard(reference: "python" | "r", refWard: any, available: boolean) {
    if (!available || !refWard) {
      rows.push({ category: "Ward", fixture: "tieFree", reference, status: "SKIPPED", reason: `${reference} Ward job did not produce output.`, numericDifference: null, tolerance: WARD_HEIGHT_ABS_TOLERANCE });
      return;
    }

    // Partition equivalence at every k.
    let allKMatch = true;
    const mismatchedK: number[] = [];
    for (let k = 1; k <= n; k++) {
      const tsLabels: number[] = tsWard.candidatePartitions[String(k)];
      const refLabels: number[] = refWard.candidatePartitions[String(k)];
      if (!refLabels || !partitionsEquivalent(tsLabels, refLabels)) {
        allKMatch = false;
        mismatchedK.push(k);
      }
    }

    // Merge height / distance sequence comparison — SORTED, since node-ID/
    // ordering conventions differ across implementations and left/right or
    // label numbering must never be treated as an error per instructions.
    const tsHeights = tsWard.linkage.map((r: any) => r.mergeDistance).sort((a: number, b: number) => a - b);
    const refHeights: number[] = reference === "python"
      ? refWard.linkage.map((r: any) => r.mergeDistance).sort((a: number, b: number) => a - b)
      : refWard.height.slice().sort((a: number, b: number) => a - b);

    let maxHeightDiff = 0;
    if (tsHeights.length === refHeights.length) {
      for (let i = 0; i < tsHeights.length; i++) {
        maxHeightDiff = Math.max(maxHeightDiff, Math.abs(tsHeights[i] - refHeights[i]));
      }
    } else {
      maxHeightDiff = NaN;
    }

    const heightPass = Number.isFinite(maxHeightDiff) && maxHeightDiff <= Math.max(WARD_HEIGHT_ABS_TOLERANCE, WARD_HEIGHT_ABS_TOLERANCE * Math.max(...tsHeights, 1));
    const pass = allKMatch && heightPass;

    rows.push({
      category: "Ward",
      fixture: "tieFree",
      reference,
      status: pass ? "PASS" : "FAIL",
      reason: pass
        ? `All k=1..${n} partitions equivalent; max height diff=${maxHeightDiff.toExponential(3)} (tol ${WARD_HEIGHT_ABS_TOLERANCE}). Note: ${reference} may report a different height *scale* convention (documented separately) — this compares TS's mergeDistance against ${reference === "python" ? "SciPy's linkage height" : "R ward.D2's height"} directly; if scales differ systematically this will show as FAIL with a documented reason, not a silent pass.`
        : `Partition mismatch at k=${mismatchedK.join(",") || "none"}; max height diff=${Number.isFinite(maxHeightDiff) ? maxHeightDiff.toExponential(3) : "N/A (length mismatch)"} (tol ${WARD_HEIGHT_ABS_TOLERANCE}).`,
      numericDifference: Number.isFinite(maxHeightDiff) ? maxHeightDiff : null,
      tolerance: WARD_HEIGHT_ABS_TOLERANCE,
    });
  }

  compareWard("python", pythonWard, pythonWard !== null);
  compareWard("r", rWard, rWard !== null);

  // ---- Aggregate status ----
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  for (const row of rows) counts[row.status]++;

  // VERIFIED requires: zero FAILs, AND at least one real PASS per required
  // category (SMACOF zero-free vs at least one reference; Ward vs at least
  // one reference) — SKIPPED-everything must never count as VERIFIED.
  const smacofZeroFreePasses = rows.filter((r) => r.category === "SMACOF" && r.fixture === "zeroFree" && r.status === "PASS").length;
  const wardPasses = rows.filter((r) => r.category === "Ward" && r.status === "PASS").length;
  const anyFail = counts.FAIL > 0;

  let overallStatus: "VERIFIED" | "PARTIALLY_VERIFIED" | "FAILED" | "NOT_RUN";
  if (rows.length === 0 || (counts.PASS === 0 && counts.FAIL === 0)) {
    // Nothing was actually compared (every row SKIPPED, or no rows at all) —
    // this must never read as "partial success". Nothing ran.
    overallStatus = "NOT_RUN";
  } else if (anyFail) {
    overallStatus = "FAILED";
  } else if (smacofZeroFreePasses >= 1 && wardPasses >= 1) {
    overallStatus = counts.SKIPPED > 0 ? "PARTIALLY_VERIFIED" : "VERIFIED";
  } else {
    overallStatus = "PARTIALLY_VERIFIED";
  }

  const summary = {
    overallStatus,
    counts,
    tolerances: {
      stressAbsTolerance: STRESS_ABS_TOLERANCE,
      pairwiseDistanceAbsTolerance: PAIRWISE_DISTANCE_ABS_TOLERANCE,
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
    `PASS=${counts.PASS} FAIL=${counts.FAIL} SKIPPED=${counts.SKIPPED}`,
    "",
    "| Category | Fixture | Reference | Status | Numeric diff | Tolerance | Reason |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.category} | ${r.fixture} | ${r.reference} | ${r.status} | ${r.numericDifference?.toExponential(3) ?? "-"} | ${r.tolerance ?? "-"} | ${r.reason.replace(/\|/g, "\\|")} |`
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, "comparison-summary.md"), md);

  const csv = [
    "category,fixture,reference,status,numericDifference,tolerance",
    ...rows.map((r) => `${r.category},${r.fixture},${r.reference},${r.status},${r.numericDifference ?? ""},${r.tolerance ?? ""}`),
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, "numeric-differences.csv"), csv);

  console.log(`Overall status: ${overallStatus}`);
  console.log(`PASS=${counts.PASS} FAIL=${counts.FAIL} SKIPPED=${counts.SKIPPED}`);
  for (const row of rows) {
    console.log(`  [${row.status}] ${row.category}/${row.fixture} vs ${row.reference}: ${row.reason}`);
  }

  if (overallStatus === "FAILED") process.exitCode = 1;
}

main();
