export type CurrentStale = "CURRENT" | "STALE";
export type CurrentSuperseded = "CURRENT" | "SUPERSEDED";
export type ReadyBlocked = "READY" | "BLOCKED";

export type FreshnessResult = {
  numericFreshness: CurrentStale;
  contentFreshnessKo: CurrentStale;
  contentFreshnessJa: CurrentStale;
  parameterStatus: CurrentSuperseded;
  publicationStatus: ReadyBlocked;
  freshnessReasons: string[];
};

export type FreshnessInput = {
  scope: "KR" | "JP" | "ALL";
  run: {
    numericDataHash: string;
    statementStructureHash: string;
    statementContentHashKo: string;
    statementContentHashJa: string;
    parameterHash: string;
  };
  current: {
    numericDataHash: string;
    statementStructureHash: string;
    statementContentHashKo: string;
    statementContentHashJa: string;
    parameterHash: string;
  };
  /** Whether the locale's publication-facing content is ready right now (computeLocaleContentStatus). */
  publicationReadyKo: boolean;
  publicationReadyJa: boolean;
};

/**
 * Freshness is ALWAYS derived at read time from stored run-time hashes vs.
 * current project hashes — never persisted as its own truth (Gate 1 FINAL
 * §13). executionStatus is completely separate and is never touched here.
 */
export function deriveFreshness(input: FreshnessInput): FreshnessResult {
  const reasons: string[] = [];

  const numericStale = input.run.numericDataHash !== input.current.numericDataHash;
  if (numericStale) reasons.push("NUMERIC_DATA_CHANGED");

  const structureChanged = input.run.statementStructureHash !== input.current.statementStructureHash;
  if (structureChanged) reasons.push("STATEMENT_STRUCTURE_CHANGED");

  const koChanged = input.run.statementContentHashKo !== input.current.statementContentHashKo;
  if (koChanged) reasons.push("STATEMENT_TEXT_KO_CHANGED");

  const jaChanged = input.run.statementContentHashJa !== input.current.statementContentHashJa;
  if (jaChanged) reasons.push("STATEMENT_TEXT_JA_CHANGED");

  const parameterChanged = input.run.parameterHash !== input.current.parameterHash;
  if (parameterChanged) reasons.push("PARAMETERS_SUPERSEDED");

  // Publication readiness only considers the locale(s) actually relevant to
  // this run's scope — a KR-scope run is never blocked by JA readiness, a
  // JP-scope run is never blocked by KO readiness. ALL pools both, so a
  // change in either locale's readiness affects ALL's publication status
  // (Gate 3 spec §22).
  const relevantKo = input.scope === "KR" || input.scope === "ALL";
  const relevantJa = input.scope === "JP" || input.scope === "ALL";
  if (relevantKo && !input.publicationReadyKo) reasons.push("KO_PUBLICATION_NOT_READY");
  if (relevantJa && !input.publicationReadyJa) reasons.push("JA_PUBLICATION_NOT_READY");

  // Structural changes (statement set/order) invalidate numeric results too,
  // even if the numeric hash itself happens to still match by coincidence.
  const numericFreshness: CurrentStale = numericStale || structureChanged ? "STALE" : "CURRENT";
  const contentFreshnessKo: CurrentStale = koChanged || structureChanged ? "STALE" : "CURRENT";
  const contentFreshnessJa: CurrentStale = jaChanged || structureChanged ? "STALE" : "CURRENT";
  const parameterStatus: CurrentSuperseded = parameterChanged ? "SUPERSEDED" : "CURRENT";
  const koOk = !relevantKo || input.publicationReadyKo;
  const jaOk = !relevantJa || input.publicationReadyJa;
  const publicationStatus: ReadyBlocked = koOk && jaOk ? "READY" : "BLOCKED";

  return { numericFreshness, contentFreshnessKo, contentFreshnessJa, parameterStatus, publicationStatus, freshnessReasons: reasons };
}
