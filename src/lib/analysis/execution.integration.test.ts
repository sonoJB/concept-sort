import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDisposableDb, seedProject, seedSession } from "./testSupport/disposableDb";
import { createAnalysisRun, executeAnalysisRun, ParticipantCountZeroError } from "./executionService";
import { RunAlreadyRunningError } from "./lock";
import { recoverOrphanLocks } from "./lock";
import { DEFAULT_ANALYSIS_PARAMETERS, VALIDATION_BASELINE_SHA } from "./config";
import type { PrismaClient } from "@/generated/prisma/client";

let ctx: ReturnType<typeof createDisposableDb>;
let prisma: PrismaClient;

beforeEach(() => {
  ctx = createDisposableDb();
  prisma = ctx.prisma;
});

afterEach(async () => {
  await prisma.$disconnect();
  ctx.cleanup();
});

const deps = (projectId: string, scope: "KR" | "JP" | "ALL" = "KR") => ({
  prisma,
  projectId,
  scope,
  analysisParameters: { ...DEFAULT_ANALYSIS_PARAMETERS, dimensionsEvaluated: [2] },
  validationBaselineSha: VALIDATION_BASELINE_SHA,
  engineSourceCommitSha: "a".repeat(40),
});

async function seedSixStatementProjectWithSessions(slug: string) {
  const { projectId, statementIds } = await seedProject(prisma, { slug, statementCount: 6 });
  const half = Math.ceil(statementIds.length / 2);
  for (let i = 0; i < 3; i++) {
    await seedSession(prisma, {
      projectId,
      countryCode: "KR",
      groups: [statementIds.slice(0, half), statementIds.slice(half)],
    });
  }
  return { projectId, statementIds };
}

describe("A/D/M — snapshot transaction + full success flow", () => {
  it("creates AnalysisRun+Lock atomically, then runs to COMPLETED with Ward, releasing the lock", async () => {
    const { projectId } = await seedSixStatementProjectWithSessions("proj-a");

    const { runId } = await createAnalysisRun(deps(projectId));
    const midRun = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(midRun.executionStatus).toBe("RUNNING");
    const lockDuringRun = await prisma.analysisExecutionLock.findUnique({ where: { analysisRunId: runId } });
    expect(lockDuringRun).not.toBeNull();

    await executeAnalysisRun(prisma, runId);

    const finalRun = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(finalRun.executionStatus).toBe("COMPLETED");
    expect(finalRun.wardStatus).toBe("COMPLETED");
    expect(finalRun.finishedAt).not.toBeNull();

    const lockAfter = await prisma.analysisExecutionLock.findUnique({ where: { analysisRunId: runId } });
    expect(lockAfter).toBeNull(); // D: normal release

    const dims = await prisma.analysisRunDimension.findMany({ where: { analysisRunId: runId } });
    expect(dims).toHaveLength(1);
    expect(dims[0].dimensionStatus).toBe("COMPLETED");
    expect(dims[0].coordinates).not.toBeNull();
  });
});

describe("B/C — lock uniqueness and concurrent create", () => {
  it("rejects a second create for the same project+scope while one is conceptually held, rolling back the losing run row", async () => {
    const { projectId } = await seedSixStatementProjectWithSessions("proj-b");

    // Simulate "already RUNNING" by creating the first run+lock directly, then
    // attempting a second createAnalysisRun for the same project+scope.
    const first = await createAnalysisRun(deps(projectId));
    await expect(createAnalysisRun(deps(projectId))).rejects.toBeInstanceOf(RunAlreadyRunningError);

    // The losing attempt must not have left an orphan RUNNING row behind.
    const runs = await prisma.analysisRun.findMany({ where: { projectId } });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(first.runId);
  });

  it("under concurrent create attempts, exactly one commits", async () => {
    const { projectId } = await seedSixStatementProjectWithSessions("proj-c");
    const attempts = await Promise.allSettled([
      createAnalysisRun(deps(projectId)),
      createAnalysisRun(deps(projectId)),
      createAnalysisRun(deps(projectId)),
    ]);
    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RunAlreadyRunningError);
    }
    const runs = await prisma.analysisRun.findMany({ where: { projectId } });
    expect(runs).toHaveLength(1);
  });

  it("allows a new create for the same project+scope once the prior run's lock is released", async () => {
    const { projectId } = await seedSixStatementProjectWithSessions("proj-c2");
    const first = await createAnalysisRun(deps(projectId));
    await executeAnalysisRun(prisma, first.runId);
    // lock released by executeAnalysisRun -> a second run may now be created
    const second = await createAnalysisRun(deps(projectId));
    expect(second.runId).not.toBe(first.runId);
  });
});

describe("E — FAILED run releases its lock too", () => {
  it("releases the lock on a hard 2D failure (dimension >= n)", async () => {
    // n=2 statements, primaryMapDimension=2 -> DIMENSION_TOO_HIGH hard failure.
    const { projectId, statementIds } = await seedProject(prisma, { slug: "proj-e", statementCount: 2 });
    await seedSession(prisma, { projectId, countryCode: "KR", groups: [[statementIds[0]], [statementIds[1]]] });

    const smallDeps = {
      ...deps(projectId),
      analysisParameters: { ...DEFAULT_ANALYSIS_PARAMETERS, dimensionsEvaluated: [2], primaryMapDimension: 2 },
    };
    const { runId } = await createAnalysisRun(smallDeps);
    await executeAnalysisRun(prisma, runId);

    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.executionStatus).toBe("FAILED");
    expect(run.wardStatus).toBe("NOT_RUN");
    expect(run.errorCode).toBe("DIMENSION_TOO_HIGH");

    const lock = await prisma.analysisExecutionLock.findUnique({ where: { analysisRunId: runId } });
    expect(lock).toBeNull();
  });
});

describe("F — orphan recovery", () => {
  it("transitions a stale RUNNING run to FAILED(SERVER_INTERRUPTED) and drops its lock", async () => {
    const { projectId } = await seedSixStatementProjectWithSessions("proj-f");
    const { runId } = await createAnalysisRun(deps(projectId));
    // Never call executeAnalysisRun — simulate a crash mid-execution by
    // back-dating the lock's acquiredAt beyond the timeout window.
    await prisma.analysisExecutionLock.update({
      where: { analysisRunId: runId },
      data: { acquiredAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const recovered = await recoverOrphanLocks(prisma, 5 * 60 * 1000);
    expect(recovered).toBe(1);

    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.executionStatus).toBe("FAILED");
    expect(run.errorCode).toBe("SERVER_INTERRUPTED");
    expect(run.finishedAt).not.toBeNull();

    const lock = await prisma.analysisExecutionLock.findUnique({ where: { analysisRunId: runId } });
    expect(lock).toBeNull();
  });

  it("does not touch a RUNNING run whose lock is still within the timeout window", async () => {
    const { projectId } = await seedSixStatementProjectWithSessions("proj-f2");
    const { runId } = await createAnalysisRun(deps(projectId));
    const recovered = await recoverOrphanLocks(prisma, 5 * 60 * 1000);
    expect(recovered).toBe(0);
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.executionStatus).toBe("RUNNING");
  });

  it("allows a new run to be created for the same project+scope after orphan recovery frees the lock", async () => {
    const { projectId } = await seedSixStatementProjectWithSessions("proj-f3");
    const { runId: orphanRunId } = await createAnalysisRun(deps(projectId));
    await prisma.analysisExecutionLock.update({
      where: { analysisRunId: orphanRunId },
      data: { acquiredAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    await recoverOrphanLocks(prisma, 5 * 60 * 1000);
    const { runId: newRunId } = await createAnalysisRun(deps(projectId));
    expect(newRunId).not.toBe(orphanRunId);
  });
});

describe("G/H — N=0 and N=1 policy", () => {
  it("N=0 rejects with ParticipantCountZeroError, no run row created", async () => {
    const { projectId } = await seedProject(prisma, { slug: "proj-g", statementCount: 6 });
    await expect(createAnalysisRun(deps(projectId))).rejects.toBeInstanceOf(ParticipantCountZeroError);
    const runs = await prisma.analysisRun.findMany({ where: { projectId } });
    expect(runs).toHaveLength(0);
  });

  it("N=1 is permitted and executes to a real result", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "proj-h", statementCount: 6 });
    await seedSession(prisma, {
      projectId,
      countryCode: "KR",
      groups: [statementIds.slice(0, 3), statementIds.slice(3)],
    });
    const { runId } = await createAnalysisRun(deps(projectId));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(1);
    await executeAnalysisRun(prisma, runId);
    const finalRun = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(finalRun.executionStatus).toBe("COMPLETED");
  });
});

describe("I/J — scope isolation and null-country exclusion, end to end", () => {
  it("KR/JP/ALL runs on the same project see correctly isolated participant counts", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "proj-i", statementCount: 6 });
    const half = 3;
    for (let i = 0; i < 2; i++) {
      await seedSession(prisma, { projectId, countryCode: "KR", groups: [statementIds.slice(0, half), statementIds.slice(half)] });
    }
    await seedSession(prisma, { projectId, countryCode: "JP", groups: [statementIds.slice(0, half), statementIds.slice(half)] });
    await seedSession(prisma, { projectId, countryCode: null, groups: [statementIds.slice(0, half), statementIds.slice(half)] });

    const krRun = await createAnalysisRun(deps(projectId, "KR"));
    const krRunRow = await prisma.analysisRun.findUniqueOrThrow({ where: { id: krRun.runId } });
    expect(krRunRow.includedParticipantCount).toBe(2);
    expect(krRunRow.nKr).toBe(2);
    expect(krRunRow.nJp).toBe(0);
    expect(krRunRow.excludedNullCountry).toBe(1);

    const jpRun = await createAnalysisRun(deps(projectId, "JP"));
    const jpRunRow = await prisma.analysisRun.findUniqueOrThrow({ where: { id: jpRun.runId } });
    expect(jpRunRow.includedParticipantCount).toBe(1);

    const allRun = await createAnalysisRun(deps(projectId, "ALL"));
    const allRunRow = await prisma.analysisRun.findUniqueOrThrow({ where: { id: allRun.runId } });
    expect(allRunRow.includedParticipantCount).toBe(3);
    expect(allRunRow.excludedNullCountry).toBe(1);
  });
});
