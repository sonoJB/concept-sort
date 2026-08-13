import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

// Route modules import the `@/lib/db` singleton, which reads DATABASE_URL at
// PrismaClient construction time — so it must be set BEFORE those modules
// are imported (same pattern as api.integration.test.ts). disposableDb.ts's
// per-instance `datasourceUrl` override does NOT apply here since the route
// handlers never receive a prisma instance as a parameter.
const dbFile = path.join(os.tmpdir(), `concept-sort-pilot-routes-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
const MIGRATION_ORDER = [
  "20260803154453_init",
  "20260803180717_add_consent_and_demographics",
  "20260805233213_add_multilingual_project_support",
  "20260807144811_add_analysis_run_models",
  "20260807180000_scope_legacy_consent_fallback",
  "20260813011500_add_guide_template_fields",
  "20260813062600_add_data_role_and_analysis_dataset",
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
const matrixRoute = await import("@/app/api/projects/[slug]/matrix/route");
const eligibilityRoute = await import("@/app/api/projects/[slug]/analysis/eligibility/route");
const participantsRoute = await import("@/app/api/projects/[slug]/participants/route");
const runsRoute = await import("@/app/api/projects/[slug]/analysis/runs/route");
const { DEFAULT_ANALYSIS_PARAMETERS } = await import("@/lib/analysis/config");

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    // best-effort
  }
});

let slugCounter = 0;
async function seedProjectWithSessions(roles: { countryCode: "KR" | "JP"; dataRole: "MAIN" | "PILOT" }[]) {
  const slug = `pilot-route-${++slugCounter}`;
  const project = await prisma.project.create({
    data: { slug, adminToken: `token-${slug}`, title: "t", prompt: "p" },
  });
  const s1 = await prisma.statement.create({ data: { projectId: project.id, text: "s1", order: 0 } });
  const s2 = await prisma.statement.create({ data: { projectId: project.id, text: "s2", order: 1 } });
  const s3 = await prisma.statement.create({ data: { projectId: project.id, text: "s3", order: 2 } });
  const s4 = await prisma.statement.create({ data: { projectId: project.id, text: "s4", order: 3 } });

  for (const r of roles) {
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: "synthetic",
        gender: "unspecified",
        age: 20,
        schoolLevel: "unspecified",
        grade: "unspecified",
        phoneNumber: "000-0000-0000",
        countryCode: r.countryCode,
        dataRole: r.dataRole,
        groups: {
          create: [
            { items: { create: [{ statementId: s1.id }, { statementId: s2.id }] } },
            { items: { create: [{ statementId: s3.id }, { statementId: s4.id }] } },
          ],
        },
      },
    });
  }
  return project;
}

describe("(13) matrix route defaults to MAIN and excludes pilots by default", () => {
  it("GET .../matrix with no dataset param returns only MAIN sessions", async () => {
    const project = await seedProjectWithSessions([
      { countryCode: "KR", dataRole: "MAIN" },
      { countryCode: "KR", dataRole: "PILOT" },
      { countryCode: "JP", dataRole: "PILOT" },
    ]);

    const req = new NextRequest(`http://localhost/api/projects/${project.slug}/matrix?token=${project.adminToken}`);
    const res = await matrixRoute.GET(req, { params: Promise.resolve({ slug: project.slug }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.dataset).toBe("MAIN");
    expect(data.submissionCount).toBe(1);
  });

  it("GET .../matrix?dataset=ALL_WITH_PILOT explicitly returns every session", async () => {
    const project = await seedProjectWithSessions([
      { countryCode: "KR", dataRole: "MAIN" },
      { countryCode: "KR", dataRole: "PILOT" },
    ]);

    const req = new NextRequest(
      `http://localhost/api/projects/${project.slug}/matrix?token=${project.adminToken}&dataset=ALL_WITH_PILOT`
    );
    const res = await matrixRoute.GET(req, { params: Promise.resolve({ slug: project.slug }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.submissionCount).toBe(2);
  });

  it("fails safely (422) on an unrecognized dataset value, never silently falling back to 'everything'", async () => {
    const project = await seedProjectWithSessions([{ countryCode: "KR", dataRole: "MAIN" }]);

    const req = new NextRequest(
      `http://localhost/api/projects/${project.slug}/matrix?token=${project.adminToken}&dataset=NOT_A_REAL_MODE`
    );
    const res = await matrixRoute.GET(req, { params: Promise.resolve({ slug: project.slug }) });
    expect(res.status).toBe(422);
  });
});

describe("(14) eligibility route N follows dataRole-filtered eligible data only", () => {
  it("eligibility participantCount changes correctly across MAIN/PILOT/ALL_WITH_PILOT for the same scope", async () => {
    const project = await seedProjectWithSessions([
      { countryCode: "KR", dataRole: "MAIN" },
      { countryCode: "KR", dataRole: "PILOT" },
      { countryCode: "KR", dataRole: "PILOT" },
    ]);

    async function callEligibility(dataset: string) {
      const req = new NextRequest(
        `http://localhost/api/projects/${project.slug}/analysis/eligibility?scope=KR&dataset=${dataset}`,
        { headers: { authorization: `Bearer ${project.adminToken}` } }
      );
      const res = await eligibilityRoute.GET(req, { params: Promise.resolve({ slug: project.slug }) });
      return res.json();
    }

    expect((await callEligibility("MAIN")).participantCount).toBe(1);
    expect((await callEligibility("PILOT")).participantCount).toBe(2);
    expect((await callEligibility("ALL_WITH_PILOT")).participantCount).toBe(3);
  });
});

describe("(18) participants API exposes dataRole", () => {
  it("GET .../participants includes dataRole for every session", async () => {
    const project = await seedProjectWithSessions([
      { countryCode: "KR", dataRole: "MAIN" },
      { countryCode: "JP", dataRole: "PILOT" },
    ]);

    const req = new NextRequest(`http://localhost/api/projects/${project.slug}/participants?token=${project.adminToken}`);
    const res = await participantsRoute.GET(req, { params: Promise.resolve({ slug: project.slug }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.participants).toHaveLength(2);
    const roles = data.participants.map((p: { dataRole: string }) => p.dataRole).sort();
    expect(roles).toEqual(["MAIN", "PILOT"]);
  });
});

async function seedRun(projectId: string, scope: string, dataset: string, includedParticipantCount: number) {
  return prisma.analysisRun.create({
    data: {
      projectId,
      scope,
      dataset,
      pilotCount: dataset === "MAIN" ? 0 : includedParticipantCount,
      mainCount: dataset === "MAIN" ? includedParticipantCount : 0,
      executionStatus: "COMPLETED",
      numericDataHash: "x",
      statementStructureHash: "x",
      statementContentHashKo: "x",
      statementContentHashJa: "x",
      parameterHash: "x",
      sourceSnapshotAt: new Date(0),
      inputSnapshot: "{}",
      parametersSnapshot: JSON.stringify({
        analysisParameters: DEFAULT_ANALYSIS_PARAMETERS,
        provenance: { validationBaselineSha: "x".repeat(40) },
      }),
      algorithmVersion: "1.0.0",
      engineSourceCommitSha: "a".repeat(40),
      primaryMapDimension: 2,
      wardSourceDimension: 2,
      linkageMethod: "ward",
      dimensionsEvaluated: "[2]",
      include3dSupplement: false,
      statementCount: 4,
      nKr: includedParticipantCount,
      nJp: 0,
      nTotal: includedParticipantCount,
      includedParticipantCount,
      excludedNullCountry: 0,
      excludedIncomplete: 0,
      excludedInvalid: 0,
      wardStatus: "COMPLETED",
    },
  });
}

describe("(13) legacy pre-segregation AnalysisRun visibility in the run-history listing", () => {
  it("a LEGACY_PRE_SEGREGATION run is surfaced under a PILOT dataset query, never a MAIN query", async () => {
    const project = await seedProjectWithSessions([{ countryCode: "KR", dataRole: "PILOT" }]);
    const legacyRun = await seedRun(project.id, "KR", "LEGACY_PRE_SEGREGATION", 3);

    async function listRuns(dataset: string) {
      const req = new NextRequest(
        `http://localhost/api/projects/${project.slug}/analysis/runs?scope=KR&dataset=${dataset}`,
        { headers: { authorization: `Bearer ${project.adminToken}` } }
      );
      const res = await runsRoute.GET(req, { params: Promise.resolve({ slug: project.slug }) });
      const data = await res.json();
      return data.runs.map((r: { id: string }) => r.id);
    }

    expect(await listRuns("PILOT")).toContain(legacyRun.id);
    expect(await listRuns("ALL_WITH_PILOT")).toContain(legacyRun.id);
    expect(await listRuns("MAIN")).not.toContain(legacyRun.id);
  });

  it("a fresh PILOT run and a legacy run both appear together under a PILOT dataset query, still distinguishable by their own dataset field", async () => {
    const project = await seedProjectWithSessions([{ countryCode: "JP", dataRole: "PILOT" }]);
    const legacyRun = await seedRun(project.id, "JP", "LEGACY_PRE_SEGREGATION", 5);
    const freshRun = await seedRun(project.id, "JP", "PILOT", 1);

    const req = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs?scope=JP&dataset=PILOT`, {
      headers: { authorization: `Bearer ${project.adminToken}` },
    });
    const res = await runsRoute.GET(req, { params: Promise.resolve({ slug: project.slug }) });
    const data = await res.json();
    const byId = new Map(data.runs.map((r: { id: string; dataset: string }) => [r.id, r.dataset]));

    expect(byId.get(legacyRun.id)).toBe("LEGACY_PRE_SEGREGATION");
    expect(byId.get(freshRun.id)).toBe("PILOT");
  });
});
