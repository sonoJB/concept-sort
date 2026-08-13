import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const dbFile = path.join(os.tmpdir(), `concept-sort-pilot-delete-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
const MIGRATION_ORDER = [
  "20260803154453_init",
  "20260803180717_add_consent_and_demographics",
  "20260805233213_add_multilingual_project_support",
  "20260807144811_add_analysis_run_models",
  "20260807180000_scope_legacy_consent_fallback",
  "20260813011500_add_guide_template_fields",
  "20260813062600_add_data_role_and_analysis_dataset",
  "20260813082418_add_main_study_schedule_and_guide_video",
];
{
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const name of MIGRATION_ORDER) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8"));
  }
  db.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;

const { prisma } = await import("@/lib/db");
const deleteRoute = await import("./route");

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    // best-effort
  }
});

let slugCounter = 0;
async function seedProjectWithSessions(roles: ("MAIN" | "PILOT")[]) {
  const slug = `pilot-delete-${++slugCounter}`;
  const project = await prisma.project.create({
    data: { slug, adminToken: `token-${slug}`, title: "t", prompt: "p" },
  });
  const s1 = await prisma.statement.create({ data: { projectId: project.id, text: "s1", order: 0 } });
  const s2 = await prisma.statement.create({ data: { projectId: project.id, text: "s2", order: 1 } });

  const sessions = [];
  for (const dataRole of roles) {
    const session = await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: "synthetic",
        gender: "unspecified",
        age: 20,
        schoolLevel: "unspecified",
        grade: "unspecified",
        phoneNumber: "000-0000-0000",
        countryCode: "KR",
        dataRole,
        groups: { create: [{ items: { create: [{ statementId: s1.id }, { statementId: s2.id }] } }] },
      },
    });
    sessions.push(session);
  }
  return { project, sessions, statementIds: [s1.id, s2.id] };
}

async function callDelete(slug: string, adminToken: string, sessionIds: string[]) {
  const req = new NextRequest(`http://localhost/api/projects/${slug}/participants/delete`, {
    method: "POST",
    body: JSON.stringify({ adminToken, mode: "selected", sessionIds }),
  });
  const res = await deleteRoute.POST(req, { params: Promise.resolve({ slug }) });
  return { status: res.status, data: await res.json() };
}

describe("(22) manual pilot-filtered deletion never deletes MAIN sessions", () => {
  it("deleting only the PILOT-filtered session IDs leaves every MAIN session intact", async () => {
    const { project, sessions } = await seedProjectWithSessions(["MAIN", "MAIN", "PILOT", "PILOT", "PILOT"]);
    const mainSessions = sessions.filter((s) => s.dataRole === "MAIN");
    const pilotSessions = sessions.filter((s) => s.dataRole === "PILOT");

    // Simulates the admin UI's 파일럿 filter -> select all -> 선택 삭제 flow:
    // only PILOT-filtered IDs are ever passed to the delete API.
    const { status, data } = await callDelete(
      project.slug,
      project.adminToken,
      pilotSessions.map((s) => s.id)
    );
    expect(status).toBe(200);
    expect(data.deletedSessions).toBe(3);

    const remaining = await prisma.sortSession.findMany({ where: { projectId: project.id } });
    expect(remaining).toHaveLength(2);
    expect(remaining.every((r) => r.dataRole === "MAIN")).toBe(true);
    expect(remaining.map((r) => r.id).sort()).toEqual(mainSessions.map((s) => s.id).sort());
  });
});

describe("(23) deleting a PILOT session cascades only its own SortGroup/SortGroupItem", () => {
  it("does not alter Project, Statement, other PILOT sessions, or MAIN sessions", async () => {
    const { project, sessions, statementIds } = await seedProjectWithSessions(["PILOT", "PILOT", "MAIN"]);
    const [targetPilot, otherPilot, mainSession] = sessions;

    const otherPilotGroupsBefore = await prisma.sortGroup.findMany({ where: { sortSessionId: otherPilot.id } });
    const mainGroupsBefore = await prisma.sortGroup.findMany({ where: { sortSessionId: mainSession.id } });
    const statementsBefore = await prisma.statement.findMany({ where: { projectId: project.id } });
    const projectBefore = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });

    const { status, data } = await callDelete(project.slug, project.adminToken, [targetPilot.id]);
    expect(status).toBe(200);
    expect(data.deletedSessions).toBe(1);
    expect(data.deletedGroups).toBe(1); // this fixture seeds exactly 1 group per session
    expect(data.deletedGroupItems).toBe(2); // 2 statements per group

    // The deleted session and ONLY its own group/items are gone.
    expect(await prisma.sortSession.findUnique({ where: { id: targetPilot.id } })).toBeNull();
    expect(await prisma.sortGroup.findMany({ where: { sortSessionId: targetPilot.id } })).toHaveLength(0);

    // Everything else survives byte-for-byte.
    const otherPilotGroupsAfter = await prisma.sortGroup.findMany({ where: { sortSessionId: otherPilot.id } });
    const mainGroupsAfter = await prisma.sortGroup.findMany({ where: { sortSessionId: mainSession.id } });
    expect(otherPilotGroupsAfter).toEqual(otherPilotGroupsBefore);
    expect(mainGroupsAfter).toEqual(mainGroupsBefore);

    const remainingSessions = await prisma.sortSession.findMany({ where: { projectId: project.id } });
    expect(remainingSessions.map((s) => s.id).sort()).toEqual([otherPilot.id, mainSession.id].sort());

    const statementsAfter = await prisma.statement.findMany({ where: { projectId: project.id } });
    expect(statementsAfter.map((s) => s.id).sort()).toEqual(statementIds.sort());
    expect(statementsAfter).toEqual(statementsBefore);

    const projectAfter = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(projectAfter).toEqual(projectBefore);
  });

  it("does not touch AnalysisRun rows", async () => {
    const { project, sessions } = await seedProjectWithSessions(["PILOT"]);
    const run = await prisma.analysisRun.create({
      data: {
        projectId: project.id,
        scope: "ALL",
        dataset: "PILOT",
        pilotCount: 1,
        mainCount: 0,
        executionStatus: "COMPLETED",
        numericDataHash: "x",
        statementStructureHash: "x",
        statementContentHashKo: "x",
        statementContentHashJa: "x",
        parameterHash: "x",
        sourceSnapshotAt: new Date(),
        inputSnapshot: "{}",
        parametersSnapshot: "{}",
        algorithmVersion: "1.0.0",
        engineSourceCommitSha: "a".repeat(40),
        primaryMapDimension: 2,
        wardSourceDimension: 2,
        linkageMethod: "ward",
        dimensionsEvaluated: "[2]",
        include3dSupplement: false,
        statementCount: 2,
        nKr: 1,
        nJp: 0,
        nTotal: 1,
        includedParticipantCount: 1,
        excludedNullCountry: 0,
        excludedIncomplete: 0,
        excludedInvalid: 0,
        wardStatus: "COMPLETED",
      },
    });

    await callDelete(project.slug, project.adminToken, [sessions[0].id]);

    const runAfter = await prisma.analysisRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfter).toEqual(run);
  });
});
