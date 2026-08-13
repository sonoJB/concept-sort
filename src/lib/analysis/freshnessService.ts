import type { PrismaClient } from "@/generated/prisma/client";
import { filterSessionsForScope } from "@/lib/conceptAnalysis";
import { computeLocaleContentStatus } from "@/lib/localeContentStatus";
import { toFixtureProject, toFixtureSessions, type RawSessionRow, type RawStatementRow } from "./dbAdapter";
import { buildNumericAggregate } from "./aggregates";
import { dataRolesForDataset, isValidDatasetMode, type DataRole, type DatasetMode } from "./dataset";
import {
  computeNumericDataHash,
  computeStatementStructureHash,
  computeStatementContentHashKo,
  computeStatementContentHashJa,
} from "./hashes";
import { deriveFreshness, type FreshnessResult } from "./freshness";

/** Recomputes the current project/scope/dataset hashes fresh from the live DB — never cached, never persisted. */
export async function computeCurrentHashes(
  prisma: PrismaClient,
  projectId: string,
  scope: "KR" | "JP" | "ALL",
  dataset: DatasetMode
) {
  const allowedRoles = dataRolesForDataset(dataset);
  const [statements, sessions] = await Promise.all([
    prisma.statement.findMany({ where: { projectId } }),
    prisma.sortSession.findMany({
      where: { projectId, ...(allowedRoles ? { dataRole: { in: allowedRoles } } : {}) },
      include: { groups: { include: { items: true } } },
    }),
  ]);

  const rawStatements: RawStatementRow[] = statements.map((s) => ({ id: s.id, order: s.order, text: s.text, textJa: s.textJa, jaStatus: s.jaStatus }));
  const rawSessions: RawSessionRow[] = sessions.map((s) => ({
    id: s.id,
    countryCode: s.countryCode,
    dataRole: s.dataRole as DataRole,
    groups: s.groups.map((g) => ({ items: g.items.map((i) => ({ statementId: i.statementId })) })),
  }));

  const fixtureProject = toFixtureProject(projectId, rawStatements);
  const fixtureSessions = toFixtureSessions(rawSessions);
  const scopeResult = filterSessionsForScope(fixtureProject, fixtureSessions, scope);
  const aggregate = buildNumericAggregate(fixtureProject, scopeResult.validSessions);

  return {
    numericDataHash: computeNumericDataHash(scope, dataset, aggregate),
    statementStructureHash: computeStatementStructureHash(rawStatements),
    statementContentHashKo: computeStatementContentHashKo(rawStatements),
    statementContentHashJa: computeStatementContentHashJa(rawStatements),
  };
}

export async function computeRunFreshness(
  prisma: PrismaClient,
  run: {
    scope: string;
    dataset: string;
    numericDataHash: string;
    statementStructureHash: string;
    statementContentHashKo: string;
    statementContentHashJa: string;
    parameterHash: string;
    projectId: string;
  },
  currentParameterHash: string
): Promise<FreshnessResult> {
  const scope = run.scope as "KR" | "JP" | "ALL";
  // Runs from before this feature existed (dataset="LEGACY_PRE_SEGREGATION")
  // included every session with no dataRole filter at all — the honest
  // current-day equivalent of "no filter existed" is ALL_WITH_PILOT, not a
  // guess at MAIN or PILOT.
  const effectiveDataset: DatasetMode = isValidDatasetMode(run.dataset) ? run.dataset : "ALL_WITH_PILOT";
  const current = await computeCurrentHashes(prisma, run.projectId, scope, effectiveDataset);

  const project = await prisma.project.findUniqueOrThrow({ where: { id: run.projectId } });
  const statements = await prisma.statement.findMany({ where: { projectId: run.projectId } });
  const koStatus = computeLocaleContentStatus("ko", project, statements);
  const jaStatus = computeLocaleContentStatus("ja", project, statements);

  return deriveFreshness({
    scope,
    run: {
      numericDataHash: run.numericDataHash,
      statementStructureHash: run.statementStructureHash,
      statementContentHashKo: run.statementContentHashKo,
      statementContentHashJa: run.statementContentHashJa,
      parameterHash: run.parameterHash,
    },
    current: { ...current, parameterHash: currentParameterHash },
    publicationReadyKo: koStatus.ready,
    publicationReadyJa: jaStatus.ready,
  });
}
