import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDisposableDb, seedProject, seedSession } from "./testSupport/disposableDb";
import { createAnalysisRun, executeAnalysisRun, ParticipantCountZeroError } from "./executionService";
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

const deps = (projectId: string, scope: "KR" | "JP" | "ALL", dataset: "MAIN" | "PILOT" | "ALL_WITH_PILOT") => ({
  prisma,
  projectId,
  scope,
  dataset,
  analysisParameters: { ...DEFAULT_ANALYSIS_PARAMETERS, dimensionsEvaluated: [2] },
  validationBaselineSha: VALIDATION_BASELINE_SHA,
  engineSourceCommitSha: "a".repeat(40),
});

/** 6 statements (large enough for a valid 3-group split), 2 MAIN + 3 PILOT sessions mixing KR/JP, matching this task's real-world shape (3 KR pilot + 3 JP pilot is exercised by the KR/JP-specific tests below). */
async function seedMixedProject(slug: string) {
  const { projectId, statementIds } = await seedProject(prisma, { slug, statementCount: 6 });
  const half = 3;
  const g = () => [statementIds.slice(0, half), statementIds.slice(half)];

  const mainKr1 = await seedSession(prisma, { projectId, countryCode: "KR", groups: g(), dataRole: "MAIN" });
  const mainJp1 = await seedSession(prisma, { projectId, countryCode: "JP", groups: g(), dataRole: "MAIN" });
  const pilotKr1 = await seedSession(prisma, { projectId, countryCode: "KR", groups: g(), dataRole: "PILOT" });
  const pilotKr2 = await seedSession(prisma, { projectId, countryCode: "KR", groups: g(), dataRole: "PILOT" });
  const pilotJp1 = await seedSession(prisma, { projectId, countryCode: "JP", groups: g(), dataRole: "PILOT" });

  return { projectId, statementIds, mainKr1, mainJp1, pilotKr1, pilotKr2, pilotJp1 };
}

describe("dataset-mode filtering — executionService (items 4-9, 19)", () => {
  it("(4) MAIN excludes PILOT: scope=ALL, dataset=MAIN sees only the 2 MAIN sessions", async () => {
    const { projectId } = await seedMixedProject("seg-main-excludes-pilot");
    const { runId } = await createAnalysisRun(deps(projectId, "ALL", "MAIN"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(2);
    expect(run.mainCount).toBe(2);
    expect(run.pilotCount).toBe(0);
  });

  it("(5) PILOT excludes MAIN: scope=ALL, dataset=PILOT sees only the 3 PILOT sessions", async () => {
    const { projectId } = await seedMixedProject("seg-pilot-excludes-main");
    const { runId } = await createAnalysisRun(deps(projectId, "ALL", "PILOT"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(3);
    expect(run.pilotCount).toBe(3);
    expect(run.mainCount).toBe(0);
  });

  it("(6) ALL_WITH_PILOT contains both: scope=ALL sees all 5 sessions", async () => {
    const { projectId } = await seedMixedProject("seg-all-with-pilot");
    const { runId } = await createAnalysisRun(deps(projectId, "ALL", "ALL_WITH_PILOT"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(5);
    expect(run.mainCount).toBe(2);
    expect(run.pilotCount).toBe(3);
  });

  it("(7) KR + MAIN filters correctly (1 MAIN KR session)", async () => {
    const { projectId } = await seedMixedProject("seg-kr-main");
    const { runId } = await createAnalysisRun(deps(projectId, "KR", "MAIN"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(1);
    expect(run.mainCount).toBe(1);
    expect(run.pilotCount).toBe(0);
  });

  it("(8) JP + MAIN filters correctly (1 MAIN JP session)", async () => {
    const { projectId } = await seedMixedProject("seg-jp-main");
    const { runId } = await createAnalysisRun(deps(projectId, "JP", "MAIN"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(1);
    expect(run.mainCount).toBe(1);
    expect(run.pilotCount).toBe(0);
  });

  it("(9) ALL + MAIN filters correctly (2 MAIN sessions total)", async () => {
    const { projectId } = await seedMixedProject("seg-all-main");
    const { runId } = await createAnalysisRun(deps(projectId, "ALL", "MAIN"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(2);
  });

  it("(19) AnalysisRun stores dataset metadata (dataset/pilotCount/mainCount persisted)", async () => {
    const { projectId } = await seedMixedProject("seg-dataset-metadata");
    const { runId } = await createAnalysisRun(deps(projectId, "ALL", "ALL_WITH_PILOT"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.dataset).toBe("ALL_WITH_PILOT");
    expect(run.pilotCount).toBe(3);
    expect(run.mainCount).toBe(2);
  });
});

describe("KR=3 / JP=3 pilot counting matches the real production shape (items 10-12)", () => {
  async function seedThreeAndThree(slug: string) {
    const { projectId, statementIds } = await seedProject(prisma, { slug, statementCount: 6 });
    const g = () => [statementIds.slice(0, 3), statementIds.slice(3)];
    for (let i = 0; i < 3; i++) await seedSession(prisma, { projectId, countryCode: "KR", groups: g(), dataRole: "PILOT" });
    for (let i = 0; i < 3; i++) await seedSession(prisma, { projectId, countryCode: "JP", groups: g(), dataRole: "PILOT" });
    return { projectId };
  }

  it("(10) KR + PILOT = 3", async () => {
    const { projectId } = await seedThreeAndThree("seg-kr-pilot-3");
    const { runId } = await createAnalysisRun(deps(projectId, "KR", "PILOT"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(3);
  });

  it("(11) JP + PILOT = 3", async () => {
    const { projectId } = await seedThreeAndThree("seg-jp-pilot-3");
    const { runId } = await createAnalysisRun(deps(projectId, "JP", "PILOT"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(3);
  });

  it("(12) ALL + PILOT = 6", async () => {
    const { projectId } = await seedThreeAndThree("seg-all-pilot-6");
    const { runId } = await createAnalysisRun(deps(projectId, "ALL", "PILOT"));
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.includedParticipantCount).toBe(6);
  });
});

describe("(15) Ward uses the same eligible set as MDS — no separate/inconsistent filtering path", () => {
  it("Ward completes against the same dataset-filtered N the primary MDS dimension used", async () => {
    const { projectId } = await seedMixedProject("seg-ward-same-set");
    const { runId } = await createAnalysisRun(deps(projectId, "ALL", "PILOT"));
    await executeAnalysisRun(prisma, runId);
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId }, include: { dimensions: true } });
    expect(run.executionStatus).toBe("COMPLETED");
    expect(run.wardStatus).toBe("COMPLETED");
    expect(run.includedParticipantCount).toBe(3);
    // Ward never re-reads SortSession itself — it consumes the primary
    // dimension's coordinates, which were fit against this same
    // already-dataset-filtered inputSnapshot. A single dimension row
    // (dimensionsEvaluated=[2] in `deps`) confirms only one filtered set
    // ever existed for this run.
    expect(run.dimensions).toHaveLength(1);
    expect(run.dimensions[0].dimensionStatus).toBe("COMPLETED");
  });
});

describe("(24) no-main-data analysis fails safely", () => {
  it("dataset=MAIN with zero MAIN sessions (all PILOT) rejects with ParticipantCountZeroError, no run row created", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "seg-no-main-data", statementCount: 6 });
    const g = () => [statementIds.slice(0, 3), statementIds.slice(3)];
    await seedSession(prisma, { projectId, countryCode: "KR", groups: g(), dataRole: "PILOT" });
    await seedSession(prisma, { projectId, countryCode: "JP", groups: g(), dataRole: "PILOT" });

    await expect(createAnalysisRun(deps(projectId, "ALL", "MAIN"))).rejects.toBeInstanceOf(ParticipantCountZeroError);
    const runs = await prisma.analysisRun.findMany({ where: { projectId } });
    expect(runs).toHaveLength(0);
  });
});

