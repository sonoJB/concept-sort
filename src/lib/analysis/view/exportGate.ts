import type { FreshnessResult } from "@/lib/analysis/freshness";

export type ExportLanguage = "ko" | "ja";
export type ExportBlockReason =
  | "RUN_NOT_COMPLETED"
  | "NUMERIC_STALE"
  | "CONTENT_STALE"
  | "PARAMETERS_SUPERSEDED"
  | "PUBLICATION_BLOCKED";

export type ExportEligibility = { allowed: true } | { allowed: false; reason: ExportBlockReason };

/**
 * Gate 4-only composition of Gate 3's freshness result for one export
 * language — a NEW function, not a modification of Gate 3's
 * isResultBodyExposable (runSerializer.ts, untouched). That function
 * requires both KO and JA content CURRENT for the run-detail API's combined
 * view; export is per-language ("관련 CONTENT stale" per language, per Gate
 * 4 §25), so a KR-scope export must not be blocked by an unrelated JA text
 * edit and vice versa.
 *
 * `publicationReadyForLanguage` MUST be computed independently for the
 * requested export language (computeLocaleContentStatus(language, ...)),
 * NOT read from freshness.publicationStatus — that field is scope-gated to
 * the RUN's scope (e.g. a KR-scope run's publicationStatus never considers
 * JA readiness at all), while export language is a separate choice from run
 * scope: a KR-scope run's results can still be requested with JA labels,
 * and that must independently require JA content to be publication-ready.
 */
export function checkExportEligibility(
  executionStatus: string,
  freshness: FreshnessResult,
  language: ExportLanguage,
  publicationReadyForLanguage: boolean
): ExportEligibility {
  if (executionStatus !== "COMPLETED") return { allowed: false, reason: "RUN_NOT_COMPLETED" };
  if (freshness.numericFreshness !== "CURRENT") return { allowed: false, reason: "NUMERIC_STALE" };
  const relevantContent = language === "ko" ? freshness.contentFreshnessKo : freshness.contentFreshnessJa;
  if (relevantContent !== "CURRENT") return { allowed: false, reason: "CONTENT_STALE" };
  if (freshness.parameterStatus !== "CURRENT") return { allowed: false, reason: "PARAMETERS_SUPERSEDED" };
  if (!publicationReadyForLanguage) return { allowed: false, reason: "PUBLICATION_BLOCKED" };
  return { allowed: true };
}
