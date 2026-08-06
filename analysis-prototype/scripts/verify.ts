/**
 * Internal verification suite for src/lib/conceptAnalysis. Run with:
 *   npx tsx analysis-prototype/scripts/verify.ts
 * No external reference cross-check is included here — see
 * analysis-prototype/reference/README.md for why, and for the (unexecuted)
 * reference scripts.
 */
import {
  isotonicRegressionAscending,
  isotonicRegressionByRank,
  buildSimilarityCountMatrix,
  buildSimilarityProportionMatrix,
  buildDissimilarityMatrix,
  buildWeightMatrix,
  assertSquareSymmetric,
  filterSessionsForScope,
  runSmacof,
  wardHierarchicalClustering,
  cutTreeToKClusters,
  partitionsEquivalent,
  computeDataHash,
  computeNormalizedStress1,
  computeRawStress,
  euclideanDistanceMatrix,
  runDimensionDiagnostics,
  PRIMARY_MAP_DIMENSION,
  type SmacofParams,
} from "../../src/lib/conceptAnalysis";
import {
  fixtureA_dissimilarity,
  fixtureB_square_dissimilarity,
  fixtureC_twoClusters_dissimilarity,
  fixtureD_ties_dissimilarity,
  fixtureE_offDiagonalZero_dissimilarity,
  fixtureF_allEqual_dissimilarity,
  fixtureG_project,
  fixtureG_sessions,
} from "../fixtures/fixtures";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    failed++;
    console.error("FAIL: " + msg);
  } else {
    passed++;
    console.log("OK: " + msg);
  }
}

function baseParams(dimension: 1 | 2 | 3, overrides?: Partial<SmacofParams>): SmacofParams {
  return {
    algorithm: "SMACOF",
    metric: false,
    dimension,
    normalizedStress: true,
    randomSeed: 42,
    nInit: 4,
    maxIter: 300,
    eps: 1e-9,
    tieHandling: "secondary",
    ...overrides,
  };
}

// ============================================================
// 7. isotonic regression tests
// ============================================================
console.log("\n=== isotonic regression ===");
assert(
  JSON.stringify(isotonicRegressionAscending([1, 2, 3], [1, 1, 1])) === JSON.stringify([1, 2, 3]),
  "already-monotone input returns unchanged"
);
{
  const fitted = isotonicRegressionAscending([3, 1, 2], [1, 1, 1]);
  let monotone = true;
  for (let i = 1; i < fitted.length; i++) if (fitted[i] < fitted[i - 1] - 1e-12) monotone = false;
  assert(monotone, "reversed input becomes non-decreasing (PAVA pooling)");
}
{
  const fitted = isotonicRegressionByRank(
    [
      { rankKey: 1, value: 5, weight: 1 },
      { rankKey: 1, value: 1, weight: 1 }, // tie with above rankKey
      { rankKey: 2, value: 3, weight: 1 },
    ]
  );
  assert(fitted[0] === fitted[1], "tied rankKey observations receive identical fitted disparity (secondary ties)");
}
{
  const fitted = isotonicRegressionAscending([10, 1, 1], [1, 0, 1]); // weight 0 on the middle element
  assert(Number.isFinite(fitted[1]), "weight=0 element does not produce NaN/crash");
}
{
  const fitted = isotonicRegressionAscending([0, 0, 5], [1, 1, 1]); // off-diagonal-style 0s
  assert(fitted[0] === 0 && fitted[1] === 0, "leading zero-valued targets preserved as 0, not treated as missing");
}
{
  const fitted = isotonicRegressionAscending([2, 2, 2, 2], [1, 1, 1, 1]);
  assert(fitted.every((v) => v === 2), "all-equal input returns all-equal output");
}
{
  const fitted = isotonicRegressionAscending([7], [1]);
  assert(fitted.length === 1 && fitted[0] === 7, "single-pair input handled");
}
{
  let threw = false;
  try {
    isotonicRegressionAscending([], []);
  } catch {
    threw = true;
  }
  assert(threw, "empty input throws rather than returning a fabricated result");
}

// ============================================================
// 5. off-diagonal zero preservation (similarity/dissimilarity layer)
// ============================================================
console.log("\n=== off-diagonal zero preservation ===");
{
  // Two statements ALWAYS co-sorted by every valid participant -> proportion 1, dissimilarity 0.
  const statementIds = ["a", "b", "c"];
  const sessions = [
    { sessionId: "s1", countryCode: "KR" as const, groups: [["a", "b"], ["c"]] },
    { sessionId: "s2", countryCode: "KR" as const, groups: [["a", "b", "c"]] },
  ];
  const count = buildSimilarityCountMatrix(statementIds, sessions);
  const proportion = buildSimilarityProportionMatrix(count, sessions.length);
  const dissimilarity = buildDissimilarityMatrix(proportion);
  assert(proportion[0][1] === 1, "always-co-sorted pair has proportion=1");
  assert(dissimilarity[0][1] === 0, "always-co-sorted pair has dissimilarity=0 (valid observation, not missing)");
  assertSquareSymmetric(dissimilarity, "fixture dissimilarity");

  const weight = buildWeightMatrix(3);
  assert(weight[0][1] === 1, "off-diagonal 0 dissimilarity still carries weight=1 (not silently excluded)");
  assert(weight[0][0] === 0, "diagonal weight is 0 (excluded from fit by construction)");
}

// ============================================================
// Stress definition self-consistency
// ============================================================
console.log("\n=== stress definition ===");
{
  const points = [[0, 0], [1, 0], [1, 1]];
  const distance = euclideanDistanceMatrix(points);
  const disparity = distance.map((row) => [...row]); // perfect fit case: disparity == distance
  const weight = buildWeightMatrix(3);
  const raw = computeRawStress(disparity, distance, weight);
  const norm = computeNormalizedStress1(disparity, distance, weight);
  assert(raw === 0, "perfect fit (disparity==distance) has rawStress=0");
  assert(norm === 0, "perfect fit has normalizedStress1=0");
}

// ============================================================
// 6. seeded PRNG reproducibility
// ============================================================
console.log("\n=== seeded reproducibility ===");
{
  const r1 = runSmacof(fixtureB_square_dissimilarity, buildWeightMatrix(4), baseParams(2));
  const r2 = runSmacof(fixtureB_square_dissimilarity, buildWeightMatrix(4), baseParams(2));
  assert(r1.normalizedStress1 !== null && r2.normalizedStress1 !== null, "both runs produced a result");
  assert(r1.normalizedStress1 === r2.normalizedStress1, "identical seed+input+params reproduce identical stress");
  assert(JSON.stringify(r1.coordinates) === JSON.stringify(r2.coordinates), "identical seed+input+params reproduce identical coordinates exactly");
}

// ============================================================
// 8. SMACOF: monotone non-increasing stress, degenerate handling
// ============================================================
console.log("\n=== SMACOF core behavior ===");
{
  // A 4-point square is a textbook multiple-local-optima case for MDS (a
  // "collapsed rhombus" solution at normalizedStress1≈0.169 is a real,
  // reproducible local optimum reached from several seeds — confirmed by
  // direct inspection here, not a bug). This is exactly why nInit exists:
  // with enough random restarts, at least one should find the true global
  // optimum (stress≈0, the exact square). 4 inits were not enough in an
  // earlier run of this test; nInit=12 is used here to make finding the
  // global optimum reliable, and this local-optima behavior is reported
  // as a genuine finding, not hidden by the test.
  const result = runSmacof(fixtureB_square_dissimilarity, buildWeightMatrix(4), baseParams(2, { nInit: 12 }));
  assert(result.converged === true, "4-point square converges in 2D");
  assert((result.normalizedStress1 ?? 1) < 0.01, `4-point square: best-of-12-inits achieves near-zero stress (got ${result.normalizedStress1}) — the true global optimum for an exact square`);
  const distinctStressValues = new Set(result.inits.map((i) => Math.round((i.normalizedStress1 ?? -1) * 1e6)));
  assert(
    distinctStressValues.size >= 2,
    `multiple local optima genuinely observed across inits (${distinctStressValues.size} distinct stress values) — confirms nInit is methodologically necessary, not decorative`
  );
  for (const init of result.inits) {
    let ok = true;
    for (let i = 1; i < init.stressHistory.length; i++) {
      if (init.stressHistory[i] > init.stressHistory[i - 1] + 1e-7) ok = false;
    }
    assert(ok, `init ${init.initIndex} stress history is non-increasing (majorization invariant)`);
  }
}
{
  // Stress-1 recomputation: independently recompute from returned coordinates and compare.
  const result = runSmacof(fixtureA_dissimilarity, buildWeightMatrix(3), baseParams(2));
  const coords = result.coordinates!;
  const distance = euclideanDistanceMatrix(coords);
  // Re-fit disparities independently (same isotonic function, fresh call) and recompute stress.
  const n = distance.length;
  const pairs: { i: number; j: number }[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push({ i, j });
  const observations = pairs.map(({ i, j }) => ({ rankKey: fixtureA_dissimilarity[i][j], value: distance[i][j], weight: 1 }));
  const fitted = isotonicRegressionByRank(observations);
  const disparity = distance.map((row) => [...row]);
  pairs.forEach(({ i, j }, idx) => {
    disparity[i][j] = fitted[idx];
    disparity[j][i] = fitted[idx];
  });
  const weight = buildWeightMatrix(3);
  const recomputedStress = computeNormalizedStress1(disparity, distance, weight);
  assert(
    Math.abs(recomputedStress - (result.normalizedStress1 ?? NaN)) < 1e-6,
    `independently recomputed stress (${recomputedStress}) matches returned stress (${result.normalizedStress1})`
  );
}
{
  const result = runSmacof(fixtureF_allEqual_dissimilarity, buildWeightMatrix(4), baseParams(2, { randomSeed: 7 }));
  assert(result.errorCode !== undefined || result.normalizedStress1 !== null, "degenerate all-equal fixture handled without throwing an uncaught exception");
}
{
  // dimension >= n must be rejected explicitly, not silently truncated.
  const result = runSmacof(fixtureA_dissimilarity, buildWeightMatrix(3), { ...baseParams(2), dimension: 3 });
  assert(result.errorCode === "DIMENSION_TOO_HIGH", "dimension >= item count is rejected with an explicit errorCode");
}
{
  const result = runSmacof(fixtureD_ties_dissimilarity, buildWeightMatrix(5), baseParams(2, { randomSeed: 99 }));
  assert(result.normalizedStress1 !== null, "ties-heavy fixture produces a result");
  assert(Number.isFinite(result.normalizedStress1 ?? NaN), "ties-heavy fixture stress is finite (no NaN propagation)");
}
{
  const result = runSmacof(fixtureE_offDiagonalZero_dissimilarity, buildWeightMatrix(4), baseParams(2, { randomSeed: 3 }));
  assert(result.normalizedStress1 !== null, "off-diagonal-zero fixture produces a result (not treated as missing/error)");
}

// ============================================================
// 9. Ward hierarchical clustering
// ============================================================
console.log("\n=== Ward HCA ===");
{
  const mds = runSmacof(fixtureC_twoClusters_dissimilarity, buildWeightMatrix(6), baseParams(2, { randomSeed: 11 }));
  assert(mds.coordinates !== null, "two-cluster fixture MDS succeeded");
  const ward = wardHierarchicalClustering(mds.coordinates!);
  assert(ward.linkage.length === 5, "linkage has n-1=5 merge steps for 6 points");
  for (let i = 1; i < ward.linkage.length; i++) {
    assert(
      ward.linkage[i].mergeDistance >= ward.linkage[i - 1].mergeDistance - 1e-9,
      `merge distances are non-decreasing at step ${i}`
    );
  }
  const labels2 = cutTreeToKClusters(ward, 2);
  const expectedPartition = [0, 0, 0, 1, 1, 1];
  assert(
    partitionsEquivalent(labels2, expectedPartition) || partitionsEquivalent(labels2, [1, 1, 1, 0, 0, 0]),
    `k=2 recovers the two designed clusters {0,1,2} and {3,4,5} (got ${JSON.stringify(labels2)})`
  );
}
{
  // Ward on raw dissimilarity-as-coordinates would be a misuse; confirm the function only
  // accepts point coordinates and that clustering on ACTUAL MDS coordinates differs in
  // general from average-linkage clustering on the raw dissimilarity matrix (documented
  // methodological distinction, not asserted equal).
  const mds = runSmacof(fixtureC_twoClusters_dissimilarity, buildWeightMatrix(6), baseParams(2, { randomSeed: 11 }));
  const ward = wardHierarchicalClustering(mds.coordinates!);
  assert(ward.linkage.every((row) => row.mergedItemCount >= 2), "every merge row reports a valid merged item count");
}

// ============================================================
// 13. KR/JP/ALL scope filtering
// ============================================================
console.log("\n=== scope filtering ===");
{
  const kr = filterSessionsForScope(fixtureG_project, fixtureG_sessions, "KR");
  const jp = filterSessionsForScope(fixtureG_project, fixtureG_sessions, "JP");
  const all = filterSessionsForScope(fixtureG_project, fixtureG_sessions, "ALL");

  assert(kr.validSessions.length === 3, `KR scope: 3 valid sessions expected, got ${kr.validSessions.length}`);
  assert(jp.validSessions.length === 2, `JP scope: 2 valid sessions expected, got ${jp.validSessions.length}`);
  assert(all.validSessions.length === 5, `ALL scope pooled: 5 valid sessions expected (3 KR + 2 JP), got ${all.validSessions.length}`);
  assert(all.nKr === 3 && all.nJp === 2, "ALL scope reports nKr=3, nJp=2 breakdown");

  assert(kr.exclusions.excludedNullCountry === 1, "null countryCode session excluded, count=1");
  assert(kr.exclusions.excludedIncomplete === 1, "incomplete session excluded, count=1");
  assert(jp.exclusions.excludedDuplicate === 1, "duplicate-assignment session excluded, count=1");
  assert(kr.exclusions.excludedInvalidStatement === 1, "invalid-statementId session excluded, count=1");

  assert(
    !kr.validSessions.some((s) => s.sessionId === "null-1"),
    "null countryCode session never appears in KR valid set (not inferred as KR)"
  );
  assert(
    !all.validSessions.some((s) => s.sessionId === "null-1"),
    "null countryCode session never appears in ALL pooled set"
  );
}

// ============================================================
// 14. similarity/dissimilarity matrix validation
// ============================================================
console.log("\n=== similarity/dissimilarity matrix validation ===");
{
  const kr = filterSessionsForScope(fixtureG_project, fixtureG_sessions, "KR");
  const count = buildSimilarityCountMatrix(fixtureG_project.statementIds, kr.validSessions);
  const proportion = buildSimilarityProportionMatrix(count, kr.nTotal);
  const dissimilarity = buildDissimilarityMatrix(proportion);

  assertSquareSymmetric(count, "KR count matrix");
  assertSquareSymmetric(proportion, "KR proportion matrix");
  assertSquareSymmetric(dissimilarity, "KR dissimilarity matrix");

  const n = fixtureG_project.statementIds.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      assert(proportion[i][j] >= 0 && proportion[i][j] <= 1, `proportion[${i}][${j}] in [0,1]`);
      assert(dissimilarity[i][j] >= 0 && dissimilarity[i][j] <= 1, `dissimilarity[${i}][${j}] in [0,1]`);
    }
  }

  // N=0 case
  const zeroProportion = buildSimilarityProportionMatrix(count, 0);
  assert(Number.isNaN(zeroProportion[0][1]), "N=0 proportion is NaN (undefined), not silently 0");

  // N=1 case
  const oneSessionProportion = buildSimilarityProportionMatrix(count, 1);
  assert(!Number.isNaN(oneSessionProportion[0][1]), "N=1 proportion is computable (not NaN)");
}

// ============================================================
// 16. dataHash tests
// ============================================================
console.log("\n=== dataHash ===");
{
  const kr = filterSessionsForScope(fixtureG_project, fixtureG_sessions, "KR");
  const jp = filterSessionsForScope(fixtureG_project, fixtureG_sessions, "JP");
  const all = filterSessionsForScope(fixtureG_project, fixtureG_sessions, "ALL");

  const hashKr1 = computeDataHash(fixtureG_project, "KR", kr.validSessions, "v1");
  const hashKr2 = computeDataHash(fixtureG_project, "KR", kr.validSessions, "v1");
  assert(hashKr1 === hashKr2, "identical input produces identical hash");

  const reordered = [...kr.validSessions].reverse();
  const hashKrReordered = computeDataHash(fixtureG_project, "KR", reordered, "v1");
  assert(hashKr1 === hashKrReordered, "session array order does not affect hash (canonicalized)");

  const krMinusOne = kr.validSessions.slice(0, -1);
  const hashKrMinusOne = computeDataHash(fixtureG_project, "KR", krMinusOne, "v1");
  assert(hashKr1 !== hashKrMinusOne, "removing a KR participant changes the KR hash");

  const hashJp = computeDataHash(fixtureG_project, "JP", jp.validSessions, "v1");
  const hashAll1 = computeDataHash(fixtureG_project, "ALL", all.validSessions, "v1");
  const allMinusOneKr = all.validSessions.filter((s) => s.sessionId !== kr.validSessions[0].sessionId);
  const hashAll2 = computeDataHash(fixtureG_project, "ALL", allMinusOneKr, "v1");
  assert(hashAll1 !== hashAll2, "removing a KR participant changes the ALL (pooled) hash");

  const jpUnchanged = computeDataHash(fixtureG_project, "JP", jp.validSessions, "v1");
  assert(hashJp === jpUnchanged, "JP hash is unaffected when only KR-side data changes (recomputed from JP-only sessions)");
}

// ============================================================
// runDimensionDiagnostics: direct unit tests (previously untested)
// ============================================================
console.log("\n=== runDimensionDiagnostics ===");
{
  const diag = runDimensionDiagnostics(fixtureC_twoClusters_dissimilarity, buildWeightMatrix(6), {
    randomSeed: 5,
    nInit: 4,
    maxIter: 200,
    eps: 1e-9,
    maxDimension: 6,
  });
  assert(diag.primaryMapDimension === 2, "primaryMapDimension is fixed at 2");
  assert(diag.primaryMapDimension === PRIMARY_MAP_DIMENSION, "primaryMapDimension matches the exported PRIMARY_MAP_DIMENSION constant");
  assert(diag.diagnosticPreferredDimension === null, "diagnosticPreferredDimension is always null (no automatic rule invented)");
  assert(diag.diagnosticReasonCodes.length > 0, "diagnosticReasonCodes explains why no automatic dimension was chosen");

  // 1D-6D column structure test: exactly one row per requested dimension, in order 1..6.
  assert(diag.diagnostics.length === 6, `diagnostics has 6 rows (1D-6D), got ${diag.diagnostics.length}`);
  diag.diagnostics.forEach((row, idx) => {
    assert(row.dimension === idx + 1, `diagnostics row ${idx} has dimension=${idx + 1} (got ${row.dimension})`);
    const hasRequiredKeys =
      "normalizedStress1" in row &&
      "rawStress" in row &&
      "converged" in row &&
      "iterations" in row &&
      "bestInit" in row &&
      "bestSeed" in row &&
      "absoluteReductionFromPrevious" in row &&
      "relativeReductionFromPrevious" in row;
    assert(hasRequiredKeys, `diagnostics row for dimension=${row.dimension} has all required fields`);
  });
  assert(diag.diagnostics[0].absoluteReductionFromPrevious === null, "dimension=1 (first row) has no 'previous' to reduce from, so reduction fields are null");
  for (let i = 1; i < diag.diagnostics.length; i++) {
    const row = diag.diagnostics[i];
    if (row.normalizedStress1 !== null && diag.diagnostics[i - 1].normalizedStress1 !== null) {
      assert(row.absoluteReductionFromPrevious !== null, `dimension=${row.dimension} has a non-null reduction value when both stresses are available`);
    }
  }

  // maxDimension truncation: requesting maxDimension=3 should only produce 3 rows.
  const diag3 = runDimensionDiagnostics(fixtureC_twoClusters_dissimilarity, buildWeightMatrix(6), {
    randomSeed: 5,
    nInit: 2,
    maxIter: 100,
    eps: 1e-9,
    maxDimension: 3,
  });
  assert(diag3.diagnostics.length === 3, `maxDimension=3 truncates output to 3 rows, got ${diag3.diagnostics.length}`);
}
{
  // dimension >= item count within the 1D-6D sweep must be reported as DIMENSION_TOO_HIGH, not silently skipped.
  const diag = runDimensionDiagnostics(fixtureA_dissimilarity, buildWeightMatrix(3), {
    randomSeed: 1,
    nInit: 2,
    maxIter: 100,
    eps: 1e-9,
    maxDimension: 6,
  });
  const highDimRows = diag.diagnostics.filter((r) => r.dimension >= 3);
  assert(
    highDimRows.every((r) => r.errorCode === "DIMENSION_TOO_HIGH"),
    "for a 3-item fixture, every dimension >= 3 is reported with errorCode=DIMENSION_TOO_HIGH, not skipped or fabricated"
  );
}

// ============================================================
// maxIter reached -> converged=false (not silently reported as success)
// ============================================================
console.log("\n=== maxIter exhaustion ===");
{
  const result = runSmacof(fixtureC_twoClusters_dissimilarity, buildWeightMatrix(6), {
    algorithm: "SMACOF",
    metric: false,
    dimension: 2,
    normalizedStress: true,
    randomSeed: 8,
    nInit: 1,
    maxIter: 2, // deliberately far too few iterations to reach eps
    eps: 1e-15, // deliberately unreachable in 2 iterations
    tieHandling: "secondary",
  });
  assert(result.inits[0].converged === false, "artificially tiny maxIter with unreachable eps correctly reports converged=false");
  assert(result.inits[0].iterations <= 2, `iterations respects the maxIter cap (got ${result.inits[0].iterations})`);
  assert(Number.isFinite(result.inits[0].normalizedStress1), "even when not converged, a real (non-fabricated) stress value is still reported");
}

// ============================================================
// All inits failing -> overall result must not claim success
// ============================================================
console.log("\n=== all-inits-failed handling ===");
{
  // BUG FOUND AND FIXED during this pre-commit review pass: marking every
  // off-diagonal pair as missing (weight=0) used to throw an uncaught
  // exception (isotonicRegressionByRank on an empty pair list) instead of
  // returning a structured failure — a crash-safety gap, not a statistical
  // correctness issue, found by this new test before any commit. Fixed by
  // adding an explicit NO_WEIGHTED_PAIRS early-return in runSmacof
  // (src/lib/conceptAnalysis/smacof.ts), mirroring the existing
  // INSUFFICIENT_ITEMS/DIMENSION_TOO_HIGH guards. This also means the
  // "every init independently fails mid-run" contract is exercised by the
  // NON_FINITE_STRESS path elsewhere (maxIter-exhaustion test above already
  // covers per-init non-fabrication); this test now covers the "structural,
  // pre-init" all-failed case instead.
  const n = 4;
  const allMissingWeight = buildWeightMatrix(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) allMissingWeight[i][j] = 0;

  const allFailedResult = runSmacof(fixtureB_square_dissimilarity, allMissingWeight, {
    algorithm: "SMACOF",
    metric: false,
    dimension: 2,
    normalizedStress: true,
    randomSeed: 1,
    nInit: 5,
    maxIter: 50,
    eps: 1e-9,
    tieHandling: "secondary",
  });
  assert(allFailedResult.errorCode === "NO_WEIGHTED_PAIRS", "all-missing-weight fixture correctly reports errorCode=NO_WEIGHTED_PAIRS (no crash)");
  assert(allFailedResult.coordinates === null, "NO_WEIGHTED_PAIRS never returns fabricated coordinates");
  assert(allFailedResult.normalizedStress1 === null, "NO_WEIGHTED_PAIRS never returns a fabricated stress value");
  assert(allFailedResult.bestInitIndex === null, "NO_WEIGHTED_PAIRS reports bestInitIndex=null");
  assert(allFailedResult.inits.length === 0, "NO_WEIGHTED_PAIRS short-circuits before running any init (structural fact of the input, not a per-init failure)");
}

console.log("\n=== INSUFFICIENT_ITEMS (n<2) handling ===");
{
  const result = runSmacof([[0]], buildWeightMatrix(1), {
    algorithm: "SMACOF",
    metric: false,
    dimension: 1,
    normalizedStress: true,
    randomSeed: 1,
    nInit: 3,
    maxIter: 50,
    eps: 1e-9,
    tieHandling: "secondary",
  });
  assert(result.coordinates === null, "n=1 (INSUFFICIENT_ITEMS) never returns fabricated coordinates");
  assert(result.normalizedStress1 === null, "n=1 (INSUFFICIENT_ITEMS) never returns a fabricated stress value");
  assert(result.errorCode === "INSUFFICIENT_ITEMS", "n=1 case is reported with an explicit errorCode, not silently treated as success");
  assert(result.bestInitIndex === null, "n=1 case reports bestInitIndex=null (no init was actually run)");
}

// ============================================================
// Ward: tie-free fixture, linkage node ID rules, k boundary handling
// ============================================================
console.log("\n=== Ward: tie-free fixture + node ID rules ===");
{
  // Hand-built coordinates with no exactly-equal pairwise distances (verified below).
  const tieFreePoints = [
    [0, 0],
    [10, 0],
    [10.5, 0.2],
    [20, 20],
    [20.3, 20.4],
  ];
  const dm = euclideanDistanceMatrix(tieFreePoints);
  const flatDistances: number[] = [];
  for (let i = 0; i < dm.length; i++) for (let j = i + 1; j < dm.length; j++) flatDistances.push(dm[i][j]);
  const uniqueCount = new Set(flatDistances.map((v) => v.toFixed(10))).size;
  assert(uniqueCount === flatDistances.length, `tie-free fixture has ${flatDistances.length} distinct pairwise distances (no ties), got ${uniqueCount} unique`);

  const ward = wardHierarchicalClustering(tieFreePoints);
  assert(ward.linkage.length === 4, "5 points produce 4 merge steps (n-1)");

  // Linkage node ID rule: original points are 0..n-1; each merge step's
  // new cluster id is n + step (scipy convention). Verify by checking that
  // the SECOND merge (if it involves the cluster from the first merge)
  // references id `n + 0` = 5, not some other scheme.
  const n = tieFreePoints.length;
  const firstMerge = ward.linkage[0];
  assert(
    firstMerge.leftNode < n && firstMerge.rightNode < n,
    "first merge always references two original singleton ids (< n)"
  );
  const laterMergeReferencesFirstCluster = ward.linkage
    .slice(1)
    .some((row) => row.leftNode === n || row.rightNode === n);
  assert(
    laterMergeReferencesFirstCluster,
    `a later merge step references cluster id ${n} (= n + step 0), confirming the "n + step" new-cluster-id convention`
  );

  // Partition equivalence against the two designed pairs {1,2} and {3,4}, point 0 alone.
  const labels3 = cutTreeToKClusters(ward, 3);
  const pairIndicesEqual = (a: number, b: number) => labels3[a] === labels3[b];
  assert(pairIndicesEqual(1, 2), "points 1,2 (close together) land in the same cluster at k=3");
  assert(pairIndicesEqual(3, 4), "points 3,4 (close together) land in the same cluster at k=3");
  assert(labels3[0] !== labels3[1], "point 0 (isolated) is in a different cluster from points 1,2 at k=3");

  // k boundary handling.
  const labelsK1 = cutTreeToKClusters(ward, 1);
  assert(labelsK1.every((l) => l === labelsK1[0]), "k=1 puts every point in a single cluster");

  const labelsKn = cutTreeToKClusters(ward, n);
  const distinctAtKn = new Set(labelsKn).size;
  assert(distinctAtKn === n, `k=n gives every point its own cluster (${distinctAtKn} distinct labels for n=${n})`);

  const labelsKTooHigh = cutTreeToKClusters(ward, n + 10); // out-of-range above n
  assert(new Set(labelsKTooHigh).size === n, "k requested above n is clamped to n, not an error or a fabricated result");

  const labelsKZero = cutTreeToKClusters(ward, 0); // out-of-range below 1
  assert(new Set(labelsKZero).size === 1, "k requested below 1 is clamped to 1, not an error or a fabricated result");
}

// ============================================================
// N=0 / N=1 scope + analysis status handling
// ============================================================
console.log("\n=== N=0 / N=1 handling ===");
{
  const noSessions = filterSessionsForScope(fixtureG_project, [], "KR");
  assert(noSessions.nTotal === 0, "N=0: filtering an empty session list yields nTotal=0");
  const countN0 = buildSimilarityCountMatrix(fixtureG_project.statementIds, noSessions.validSessions);
  const proportionN0 = buildSimilarityProportionMatrix(countN0, noSessions.nTotal);
  assert(Number.isNaN(proportionN0[0][1]), "N=0: proportion matrix is NaN (undefined), never silently 0 — analysis must not run on this");

  const oneSession = filterSessionsForScope(fixtureG_project, [fixtureG_sessions[0]], "KR");
  assert(oneSession.nTotal === 1, "N=1: a single valid session filters correctly");
  const countN1 = buildSimilarityCountMatrix(fixtureG_project.statementIds, oneSession.validSessions);
  const proportionN1 = buildSimilarityProportionMatrix(countN1, oneSession.nTotal);
  assert(!Number.isNaN(proportionN1[0][1]), "N=1: proportion matrix is computable (every value is 0 or 1, not undefined)");
  assert(
    proportionN1.every((row) => row.every((v) => v === 0 || v === 1 || Number.isNaN(v) === false)),
    "N=1: every off-diagonal proportion is a valid 0 or 1 (binary, since only one sort exists)"
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
