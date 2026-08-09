import type { PrismaClient } from "@/generated/prisma/client";
import { computeParameterHash, type ParametersSnapshot } from "./hashes";
import { computeRunFreshness } from "./freshnessService";
import type { FreshnessResult } from "./freshness";

type RunRow = {
  id: string;
  scope: string;
  executionStatus: string;
  errorCode: string | null;
  errorMessageSafe: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  numericDataHash: string;
  statementStructureHash: string;
  statementContentHashKo: string;
  statementContentHashJa: string;
  parameterHash: string;
  parametersSnapshot: string;
  projectId: string;
  primaryMapDimension: number;
  wardSourceDimension: number;
  linkageMethod: string;
  dimensionsEvaluated: string;
  include3dSupplement: boolean;
  statementCount: number;
  nKr: number;
  nJp: number;
  nTotal: number;
  includedParticipantCount: number;
  excludedNullCountry: number;
  excludedIncomplete: number;
  excludedInvalid: number;
  wardStatus: string;
  wardLinkageSnapshot: string | null;
  wardErrorCode: string | null;
  wardErrorMessageSafe: string | null;
};

/** Metadata-only view: always safe to return regardless of freshness/executionStatus. */
export async function serializeRunMetadata(prisma: PrismaClient, run: RunRow) {
  const parametersSnapshot = JSON.parse(run.parametersSnapshot) as ParametersSnapshot;
  const currentParameterHash = computeParameterHash(parametersSnapshot);
  const freshness = await computeRunFreshness(prisma, run, currentParameterHash);

  return {
    id: run.id,
    scope: run.scope,
    executionStatus: run.executionStatus,
    errorCode: run.errorCode,
    errorMessageSafe: run.errorMessageSafe,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    primaryMapDimension: run.primaryMapDimension,
    wardSourceDimension: run.wardSourceDimension,
    linkageMethod: run.linkageMethod,
    dimensionsEvaluated: JSON.parse(run.dimensionsEvaluated) as number[],
    include3dSupplement: run.include3dSupplement,
    statementCount: run.statementCount,
    nKr: run.nKr,
    nJp: run.nJp,
    nTotal: run.nTotal,
    includedParticipantCount: run.includedParticipantCount,
    excludedNullCountry: run.excludedNullCountry,
    excludedIncomplete: run.excludedIncomplete,
    excludedInvalid: run.excludedInvalid,
    wardStatus: run.wardStatus,
    freshness,
  };
}

/**
 * Whether result BODY (coordinates, Stress, Ward linkage) may be exposed
 * through this API right now. Only a COMPLETED run with fully CURRENT
 * numeric+content freshness and READY publication status qualifies — any
 * STALE/SUPERSEDED/BLOCKED axis, or a non-terminal/failed run, blocks it.
 * Metadata (serializeRunMetadata above) is always available regardless.
 */
export function isResultBodyExposable(executionStatus: string, freshness: FreshnessResult): boolean {
  if (executionStatus !== "COMPLETED") return false;
  if (freshness.numericFreshness !== "CURRENT") return false;
  if (freshness.contentFreshnessKo !== "CURRENT") return false;
  if (freshness.contentFreshnessJa !== "CURRENT") return false;
  if (freshness.parameterStatus !== "CURRENT") return false;
  if (freshness.publicationStatus !== "READY") return false;
  return true;
}
