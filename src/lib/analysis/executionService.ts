import type { PrismaClient } from "@/generated/prisma/client";
import type { AnalysisScope } from "@/lib/conceptAnalysis";
import { filterSessionsForScope } from "@/lib/conceptAnalysis";
import { toFixtureProject, toFixtureSessions, type RawSessionRow, type RawStatementRow } from "./dbAdapter";
import { dataRolesForDataset, type DataRole, type DatasetMode } from "./dataset";
import { buildNumericAggregate } from "./aggregates";
import {
  computeNumericDataHash,
  computeStatementStructureHash,
  computeStatementContentHashKo,
  computeStatementContentHashJa,
  computeParameterHash,
  type AnalysisParameters,
} from "./hashes";
import { buildInputSnapshot, buildParametersSnapshot, serializeSnapshot } from "./snapshot";
import { checkEligibility } from "./readiness";
import { runDimension, runOfficialWard } from "./engineAdapter";
import { isUniqueConstraintError, RunAlreadyRunningError } from "./lock";

/**
 * The verified engine's PRNG (mulberry32/deriveSeed) uses the full unsigned
 * 32-bit space for derived seeds, which can exceed Prisma's signed Int32
 * column range (-2147483648..2147483647) — this is a storage-layer
 * constraint of AnalysisRunDimension.bestSeed, not a defect in the frozen
 * engine, so the fix lives here rather than in src/lib/conceptAnalysis or
 * the schema. `| 0` reinterprets the same 32 bits as signed (lossless);
 * `>>> 0` recovers the original unsigned value for reproducing a run.
 *
 * DOMAIN CONTRACT: AnalysisRunDimension.bestSeed, as read straight from
 * Prisma, is a STORAGE encoding only — it must never be surfaced to an API
 * response, export, or any reproduction/provenance metadata as-is. Every
 * consumer (this Gate's run-detail API, and any future Gate 4 export) MUST
 * pass it through fromStoredSeed() first to recover the actual unsigned
 * algorithm seed. This is unrelated to parametersSnapshot.analysisParameters
 * .randomSeed, which is a small, always-signed-safe INPUT seed the engine is
 * invoked with — never derived, never subject to this encoding, and already
 * the only seed-shaped value parameterHash ever hashes (see hashes.ts).
 */
export function toStoredSeed(seed: number | null): number | null {
  return seed === null ? null : seed | 0;
}

/** Inverse of toStoredSeed — recovers the original unsigned 32-bit seed value from a stored AnalysisRunDimension.bestSeed. */
export function fromStoredSeed(stored: number | null): number | null {
  return stored === null ? null : stored >>> 0;
}

export class ParticipantCountZeroError extends Error {
  constructor() {
    super("PARTICIPANT_COUNT_ZERO");
    this.name = "ParticipantCountZeroError";
  }
}

export class EngineSourceShaUnavailableError extends Error {
  constructor() {
    super("engineSourceCommitSha was not supplied and no safe default exists — refusing to fabricate one.");
    this.name = "EngineSourceShaUnavailableError";
  }
}

export type CreateAnalysisRunDeps = {
  prisma: PrismaClient;
  projectId: string;
  scope: AnalysisScope;
  dataset: DatasetMode;
  analysisParameters: AnalysisParameters;
  validationBaselineSha: string;
  /**
   * The build/deploy commit SHA that will execute this run. Required,
   * explicit — the execution service never fabricates a value if the
   * caller (API layer / config) can't supply one; see EngineSourceShaUnavailableError.
   */
  engineSourceCommitSha: string;
  now?: Date;
};

export type CreateAnalysisRunResult = { runId: string };

/**
 * Phase 1 (interactive transaction): reads Project/Statement/SortSession
 * data, builds the canonical PII-free snapshot, computes hashes, and
 * creates the AnalysisRun(RUNNING) + AnalysisExecutionLock rows atomically.
 * If a lock for (projectId, scope) already exists, the unique constraint on
 * AnalysisExecutionLock rejects the second insert and the WHOLE transaction
 * rolls back — the just-created AnalysisRun row is rolled back with it, so
 * no orphaned RUNNING row is ever left behind by a losing concurrent
 * request (Gate 1 FINAL §10 / Gate 3 spec §13).
 *
 * No statistical computation happens inside this transaction.
 */
export async function createAnalysisRun(deps: CreateAnalysisRunDeps): Promise<CreateAnalysisRunResult> {
  if (!deps.engineSourceCommitSha) {
    throw new EngineSourceShaUnavailableError();
  }
  const now = deps.now ?? new Date();

  try {
    const runId = await deps.prisma.$transaction(async (tx) => {
      const statements = await tx.statement.findMany({ where: { projectId: deps.projectId } });
      const allowedRoles = dataRolesForDataset(deps.dataset);
      const sessions = await tx.sortSession.findMany({
        where: { projectId: deps.projectId, ...(allowedRoles ? { dataRole: { in: allowedRoles } } : {}) },
        include: { groups: { include: { items: true } } },
      });

      const rawStatements: RawStatementRow[] = statements.map((s) => ({
        id: s.id,
        order: s.order,
        text: s.text,
        textJa: s.textJa,
        jaStatus: s.jaStatus,
      }));
      const rawSessions: RawSessionRow[] = sessions.map((s) => ({
        id: s.id,
        countryCode: s.countryCode,
        dataRole: s.dataRole as DataRole,
        groups: s.groups.map((g) => ({ items: g.items.map((i) => ({ statementId: i.statementId })) })),
      }));
      const dataRoleBySessionId = new Map(rawSessions.map((s) => [s.id, s.dataRole]));

      const fixtureProject = toFixtureProject(deps.projectId, rawStatements);
      const fixtureSessions = toFixtureSessions(rawSessions);
      const scopeResult = filterSessionsForScope(fixtureProject, fixtureSessions, deps.scope);

      const eligibility = checkEligibility(scopeResult.validSessions.length);
      if (!eligibility.eligible) {
        throw new ParticipantCountZeroError();
      }

      const pilotCount = scopeResult.validSessions.filter((s) => dataRoleBySessionId.get(s.sessionId) === "PILOT").length;
      const mainCount = scopeResult.validSessions.filter((s) => dataRoleBySessionId.get(s.sessionId) === "MAIN").length;

      const aggregate = buildNumericAggregate(fixtureProject, scopeResult.validSessions);

      const numericDataHash = computeNumericDataHash(deps.scope, deps.dataset, aggregate);
      const statementStructureHash = computeStatementStructureHash(rawStatements);
      const statementContentHashKo = computeStatementContentHashKo(rawStatements);
      const statementContentHashJa = computeStatementContentHashJa(rawStatements);

      const parametersSnapshot = buildParametersSnapshot(deps.analysisParameters, {
        validationBaselineSha: deps.validationBaselineSha,
      });
      const parameterHash = computeParameterHash(parametersSnapshot);

      const inputSnapshot = buildInputSnapshot(
        deps.scope,
        deps.dataset,
        rawStatements,
        aggregate,
        scopeResult.exclusions,
        scopeResult.nKr,
        scopeResult.nJp,
        pilotCount,
        mainCount
      );

      const dimensionsEvaluated = deps.analysisParameters.dimensionsEvaluated;

      const run = await tx.analysisRun.create({
        data: {
          projectId: deps.projectId,
          scope: deps.scope,
          dataset: deps.dataset,
          pilotCount,
          mainCount,
          executionStatus: "RUNNING",
          startedAt: now,
          numericDataHash,
          statementStructureHash,
          statementContentHashKo,
          statementContentHashJa,
          parameterHash,
          sourceSnapshotAt: now,
          inputSnapshot: serializeSnapshot(inputSnapshot),
          parametersSnapshot: serializeSnapshot(parametersSnapshot),
          algorithmVersion: deps.analysisParameters.algorithmVersion,
          engineSourceCommitSha: deps.engineSourceCommitSha,
          primaryMapDimension: deps.analysisParameters.primaryMapDimension,
          wardSourceDimension: deps.analysisParameters.wardSourceDimension,
          linkageMethod: deps.analysisParameters.linkageMethod,
          dimensionsEvaluated: JSON.stringify(dimensionsEvaluated),
          include3dSupplement: dimensionsEvaluated.includes(3),
          statementCount: rawStatements.length,
          nKr: scopeResult.nKr,
          nJp: scopeResult.nJp,
          nTotal: scopeResult.nKr + scopeResult.nJp,
          includedParticipantCount: scopeResult.validSessions.length,
          excludedNullCountry: scopeResult.exclusions.excludedNullCountry,
          excludedIncomplete: scopeResult.exclusions.excludedIncomplete,
          excludedInvalid: scopeResult.exclusions.excludedDuplicate + scopeResult.exclusions.excludedInvalidStatement,
          wardStatus: "NOT_RUN",
        },
      });

      await tx.analysisExecutionLock.create({
        data: { projectId: deps.projectId, scope: deps.scope, analysisRunId: run.id, acquiredAt: now },
      });

      return run.id;
    });

    return { runId };
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      throw new RunAlreadyRunningError();
    }
    throw e;
  }
}

/**
 * Phase 2 (outside any DB transaction): runs the verified SMACOF/Ward
 * engine against the run's already-persisted inputSnapshot only — never
 * re-reads Project/Statement/SortSession. Saves per-dimension results,
 * official Ward result, and transitions the run to its terminal state, then
 * releases the lock. Official success = primary (2D) dimension COMPLETED
 * AND Ward COMPLETED; other requested dimensions failing never fails the run.
 */
export async function executeAnalysisRun(prisma: PrismaClient, runId: string): Promise<void> {
  const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
  const inputSnapshot = JSON.parse(run.inputSnapshot) as {
    numeric: { dissimilarityMatrix: number[][]; weightMatrix: number[][] };
  };
  const parametersSnapshot = JSON.parse(run.parametersSnapshot) as { analysisParameters: AnalysisParameters };
  const params = parametersSnapshot.analysisParameters;
  const dissimilarity = inputSnapshot.numeric.dissimilarityMatrix;
  const weight = inputSnapshot.numeric.weightMatrix;

  const dimensionsToRun = Array.from(new Set([run.primaryMapDimension, ...params.dimensionsEvaluated]));

  const results = dimensionsToRun.map((dim) => runDimension(dim, dissimilarity, weight, params));

  for (const result of results) {
    await prisma.analysisRunDimension.create({
      data: {
        analysisRunId: run.id,
        dimension: result.dimension,
        dimensionStatus: result.dimensionStatus,
        coordinates: result.coordinates ? JSON.stringify(result.coordinates) : null,
        rawStress: result.rawStress,
        commonStressDistance: result.commonStressDistance,
        commonStressQ: result.commonStressQ,
        converged: result.converged,
        iterations: result.iterations,
        bestInitIndex: result.bestInitIndex,
        bestSeed: toStoredSeed(result.bestSeed),
        stressHistory: result.stressHistory ? JSON.stringify(result.stressHistory) : null,
        normalizationMeta: result.normalizationMeta ? JSON.stringify(result.normalizationMeta) : null,
        errorCode: result.errorCode,
        errorMessageSafe: result.errorMessageSafe,
      },
    });
  }

  const primaryResult = results.find((r) => r.dimension === run.primaryMapDimension)!;
  const now = new Date();

  if (primaryResult.dimensionStatus !== "COMPLETED") {
    await prisma.$transaction(async (tx) => {
      await tx.analysisRun.update({
        where: { id: run.id },
        data: { executionStatus: "FAILED", errorCode: primaryResult.errorCode, errorMessageSafe: primaryResult.errorMessageSafe, finishedAt: now, wardStatus: "NOT_RUN" },
      });
      await tx.analysisExecutionLock.delete({ where: { analysisRunId: run.id } }).catch(() => {});
    });
    return;
  }

  const ward = runOfficialWard(primaryResult);

  const finalStatus = ward.wardStatus === "COMPLETED" ? "COMPLETED" : "FAILED";
  await prisma.$transaction(async (tx) => {
    await tx.analysisRun.update({
      where: { id: run.id },
      data: {
        executionStatus: finalStatus,
        errorCode: finalStatus === "FAILED" ? ward.wardErrorCode : null,
        errorMessageSafe: finalStatus === "FAILED" ? ward.wardErrorMessageSafe : null,
        finishedAt: now,
        wardStatus: ward.wardStatus,
        wardLinkageSnapshot: ward.wardLinkageSnapshot ? JSON.stringify(ward.wardLinkageSnapshot) : null,
        wardErrorCode: ward.wardErrorCode,
        wardErrorMessageSafe: ward.wardErrorMessageSafe,
      },
    });
    await tx.analysisExecutionLock.delete({ where: { analysisRunId: run.id } }).catch(() => {});
  });
}
