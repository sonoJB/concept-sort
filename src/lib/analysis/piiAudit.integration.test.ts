import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createDisposableDb, seedProject, seedSession } from "./testSupport/disposableDb";
import { createAnalysisRun } from "./executionService";
import { DEFAULT_ANALYSIS_PARAMETERS, VALIDATION_BASELINE_SHA } from "./config";
import type { PrismaClient } from "@/generated/prisma/client";

let ctx: ReturnType<typeof createDisposableDb>;
let prisma: PrismaClient;

const FORBIDDEN_SUBSTRINGS = [
  "participantName",
  "phoneNumber",
  "adminToken",
  "consentAgreed",
  "SYNTHETIC_PARTICIPANT_MARKER",
];

beforeEach(() => {
  ctx = createDisposableDb();
  prisma = ctx.prisma;
});

afterEach(async () => {
  await prisma.$disconnect();
  ctx.cleanup();
});

describe("PII audit — inputSnapshot / parametersSnapshot never contain participant PII", () => {
  it("JSON.stringify(inputSnapshot) and parametersSnapshot contain none of the forbidden fields, and never the raw SortSession id", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "pii-audit", statementCount: 6 });
    const session = await seedSession(prisma, {
      projectId,
      countryCode: "KR",
      groups: [statementIds.slice(0, 3), statementIds.slice(3)],
    });

    const { runId } = await createAnalysisRun({
      prisma,
      projectId,
      scope: "KR",
      analysisParameters: DEFAULT_ANALYSIS_PARAMETERS,
      validationBaselineSha: VALIDATION_BASELINE_SHA,
      engineSourceCommitSha: "c".repeat(40),
    });

    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });

    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(run.inputSnapshot).not.toContain(forbidden);
      expect(run.parametersSnapshot).not.toContain(forbidden);
    }
    // The raw SortSession.id itself must never appear in the stored snapshot.
    expect(run.inputSnapshot).not.toContain(session.id);
  });
});
