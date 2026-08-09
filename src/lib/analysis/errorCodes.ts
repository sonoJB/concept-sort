/** Error codes for the /api/projects/[slug]/analysis/** namespace only — separate from src/lib/errorCodes.ts (participant flow). */
export const ANALYSIS_ERROR_CODES = [
  "UNAUTHORIZED",
  "PROJECT_NOT_FOUND",
  "RUN_NOT_FOUND",
  "INTERPRETATION_NOT_FOUND",
  "SCOPE_INVALID",
  "PARTICIPANT_COUNT_ZERO",
  "RUN_ALREADY_RUNNING",
  "INTERPRETATION_FINALIZED",
  "INVALID_CLUSTER_COUNT",
  "INVALID_LANGUAGE",
  "MEMO_TOO_LONG",
  "LABEL_TOO_LONG",
  "ANALYSIS_LIMIT_EXCEEDED",
  "ENGINE_SOURCE_SHA_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];
