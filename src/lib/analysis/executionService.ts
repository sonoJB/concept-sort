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
import { buildInputSnapshot, buildParametersSnapshot, serializeSnapshot, type InputSnapshot } from "./snapshot";
import { checkEligibility } from "./readiness";
import { toConceptMapSettings, toDimensionRow } from "./engineAdapter";
import { buildParticipants } from "./participants";
import { analyzeScope } from "@/lib/conceptMap/analyze";
import { buildCountMatrix, matricesEqual } from "@/lib/conceptMap/matrices";
import { buildResultBundle } from "@/lib/conceptMap/bundle";
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
      const participants = buildParticipants(
        fixtureProject.statementIds,
        scopeResult.validSessions,
        new Map(sessions.map((s) => [s.id, s.createdAt.getTime()]))
      );
      // The pseudonymous participant records must reproduce the application's own count matrix exactly.
      const recount = buildCountMatrix(participants, fixtureProject.statementIds.length);
      const offDiagonalOnly = (m: number[][]) => m.map((row, i) => row.map((v, j) => (i === j ? 0 : v)));
      if (!matricesEqual(offDiagonalOnly(recount), offDiagonalOnly(aggregate.similarityCountMatrix))) {
        throw new Error("PARTICIPANT_RECOUNT_MISMATCH: participant-level records do not reproduce the aggregate count matrix");
      }

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
        mainCount,
        participants
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
 * Phase 2 (outside any DB transaction): analyses the run's already-persisted inputSnapshot only — never
 * re-reads Project/Statement/SortSession. Persists one row per dimension, the complete result bundle and the
 * official Ward result, then transitions the run to its terminal state and releases the lock.
 *
 * Official success = the primary (2D) solution NUMERICALLY CONVERGED and Ward ran on it. A primary solution
 * that did not converge fails the run with MDS_NOT_CONVERGED; it is never clustered or presented as a result.
 * Other dimensions are auxiliary comparison analyses: they are stored with their own converged flag and never
 * stand in for the 2D result.
 */
export async function executeAnalysisRun(prisma: PrismaClient, runId: string): Promise<void> {
  const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
  const inputSnapshot = JSON.parse(run.inputSnapshot) as InputSnapshot;
  const parametersSnapshot = JSON.parse(run.parametersSnapshot) as { analysisParameters: AnalysisParameters };
  const params = parametersSnapshot.analysisParameters;
  const startedCompute = Date.now();

  const analysis = analyzeScope(run.scope as "KR" | "JP" | "ALL", inputSnapshot.participants, inputSnapshot.statements.length, toConceptMapSettings(params));
  const rows = analysis.dimensions.map(toDimensionRow);

  for (const result of rows) {
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

  const primary = analysis.primary;
  const now = new Date();
  const bundle = buildResultBundle({
    run: { id: run.id, scope: run.scope, algorithmVersion: run.algorithmVersion, engineSourceCommitSha: run.engineSourceCommitSha, sourceSnapshotAt: run.sourceSnapshotAt, numericDataHash: run.numericDataHash, parameterHash: run.parameterHash, statementStructureHash: run.statementStructureHash, statementContentHashKo: run.statementContentHashKo, statementContentHashJa: run.statementContentHashJa },
    inputSnapshot,
    analysis,
    computeMs: Date.now() - startedCompute,
    finishedAt: now,
  });

  if (!primary.coordinates || !primary.numericallyConverged || !analysis.ward) {
    const reasons = Object.entries(primary.terminationReasonTally).map(([k, v]) => `${k}=${v}`).join(", ");
    await prisma.$transaction(async (tx) => {
      await tx.analysisRun.update({
        where: { id: run.id },
        data: {
          executionStatus: "FAILED",
          errorCode: primary.coordinates ? "MDS_NOT_CONVERGED" : primary.errorCode ?? "MDS_NO_RESULT",
          errorMessageSafe: `Primary ${params.primaryMapDimension}D solution did not numerically converge (start outcomes: ${reasons || "none"}). No clustering was performed.`,
          finishedAt: now,
          wardStatus: "NOT_RUN",
          resultBundle: JSON.stringify(bundle),
        },
      });
      await tx.analysisExecutionLock.delete({ where: { analysisRunId: run.id } }).catch(() => {});
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.analysisRun.update({
      where: { id: run.id },
      data: {
        executionStatus: "COMPLETED",
        errorCode: null,
        errorMessageSafe: null,
        finishedAt: now,
        wardStatus: "COMPLETED",
        wardLinkageSnapshot: JSON.stringify({ linkage: analysis.ward!.linkage, originalCount: inputSnapshot.statements.length }),
        wardErrorCode: null,
        wardErrorMessageSafe: null,
        resultBundle: JSON.stringify(bundle),
      },
    });
    await tx.analysisExecutionLock.delete({ where: { analysisRunId: run.id } }).catch(() => {});
  });
}
