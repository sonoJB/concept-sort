import type { AnalysisParameters } from "./hashes";

/**
 * Default analysis parameters, matching the values already exercised by the
 * externally-validated engine's own reference scripts
 * (analysis-prototype/scripts/runTsReference.ts: nInit=8, maxIter=300,
 * eps=1e-9, base seed=42) — not invented for this layer. Injectable, not
 * hardcoded into the execution service, so tests can override.
 */
export const DEFAULT_ANALYSIS_PARAMETERS: AnalysisParameters = {
  algorithmVersion: "1.0.0",
  dimensionsEvaluated: [2, 3],
  primaryMapDimension: 2,
  nInit: 8,
  maxIter: 300,
  eps: 1e-9,
  tieHandling: "secondary",
  metric: false,
  normalizedStress: true,
  disparityNormalizationConvention: "target-norm-scaled (attempt 6)",
  normalizationTargetConvention: "n*(n-1)/2",
  randomSeed: 42,
  wardSourceDimension: 2,
  linkageMethod: "ward",
  stressDefinition: "commonStressDistance = sqrt(rssPair / sumSquaredConfigurationDistances) (Kruskal Stress-1)",
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
  const value = process.env.ANALYSIS_ENGINE_SOURCE_COMMIT_SHA;
  return value && value.trim().length > 0 ? value.trim() : null;
}
