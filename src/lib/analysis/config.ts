import type { AnalysisParameters } from "./hashes";

/**
 * Default analysis parameters, matching the values already exercised by the
 * externally-validated engine's own reference scripts
 * (analysis-prototype/scripts/runTsReference.ts: nInit=8, maxIter=300,
 * eps=1e-9, base seed=42) — not invented for this layer. Injectable, not
 * hardcoded into the execution service, so tests can override.
 *
 * dimensionsEvaluated covers the full admin-exposed 1D-5D diagnostic range
 * (was [2, 3]). This is not a new analysis method — runDimension()/
 * runSmacof() already supported dimensions 1-6 unmodified; this only
 * requests more of that same already-verified computation so the admin UI
 * can show the complete Stress/R²/RSQ trend the researcher can already see
 * computed locally. Existing runs created under the old [2, 3] default keep
 * their own stored parametersSnapshot (never rewritten) and simply read as
 * SUPERSEDED against the new parameterHash — the existing stale-detection
 * behavior, not a special case.
 */
export const DEFAULT_ANALYSIS_PARAMETERS: AnalysisParameters = {
  algorithmVersion: "2.0.0",
  dimensionsEvaluated: [1, 2, 3, 4, 5],
  primaryMapDimension: 2,
  nInit: 64,
  maxIter: 10000,
  eps: 1e-9,
  strictEps: 1e-12,
  strictMaxIter: 20000,
  tieHandling: "secondary",
  metric: false,
  normalizedStress: true,
  disparityNormalizationConvention: "sum over pairs of disparity^2 = n(n-1)/2 (smacof explicit normalisation)",
  normalizationTargetConvention: "n*(n-1)/2",
  randomSeed: 42,
  wardSourceDimension: 2,
  linkageMethod: "ward",
  wardKMin: 2,
  wardKMax: 10,
  splitHalfRepetitions: 1000,
  splitHalfSeed: 20261018,
  stressDefinition:
    "raw stress = sum_{i<j} (disparity - distance)^2 with normalised disparities; Stress-1 = sqrt(sum (isotonic fit of distances - distance)^2 / sum distance^2) (Kruskal); both recomputed from the final coordinates",
  convergenceDefinition:
    "converged when (rawStress[k-1] - rawStress[k]) / rawStress[k-1] <= eps; a raw-stress increase beyond 1e-9 relative is OBJECTIVE_INCREASED; reaching maxIter is MAX_ITER (not converged)",
  selectionRule:
    "among starts that CONVERGED at eps, the smallest raw stress; the selected solution is then continued until the relative decrease is <= strictEps",
};

/**
 * Statistical validation baseline this engine version was cross-verified
 * against (Gate 0, run 31118243440 attempt 3, comparison=VERIFIED). This is
 * provenance metadata, never a parameterHash input (see hashes.ts).
 */
export const VALIDATION_BASELINE_SHA = "d2e41f5cd9d7ebd2799e4dfed938a12a96a7ca7a";

/**
 * How long a RUNNING AnalysisRun may go without reaching a terminal state
 * before it's treated as orphaned (server crash mid-execution). Default is
 * deliberately conservative relative to the one measured reference
 * benchmark (default-candidate ~17-18s in the prototype environment, itself
 * not a production guarantee) — this is an operational value to revisit at
 * Gate 7 with real production timing, not a statistically derived cutoff.
 * Injectable via config so tests can use a short value.
 */
export const DEFAULT_ANALYSIS_ORPHAN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The build/deploy commit SHA of the application instance actually
 * executing an AnalysisRun. Must be supplied via environment config — this
 * function never fabricates, guesses, or falls back to an unrelated SHA
 * (like a schema checkpoint or the statistical validation baseline; those
 * are different concepts, see hashes.ts). Returns null if unavailable; the
 * caller (API layer) must refuse to execute rather than substitute a fake
 * value. Which Railway env var actually carries the real build SHA in
 * production is a Gate 7 concern — this function only reads whatever the
 * environment provides.
 */
export function getEngineSourceCommitSha(): string | null {
  // The deployed build's own commit comes first (same source as the official-matrix workbook metadata);
  // ANALYSIS_ENGINE_SOURCE_COMMIT_SHA is only a manual override/fallback and can go stale, so it is last.
  for (const key of ["APP_BUILD_COMMIT", "RAILWAY_GIT_COMMIT_SHA", "ANALYSIS_ENGINE_SOURCE_COMMIT_SHA"]) {
    const value = process.env[key];
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}
