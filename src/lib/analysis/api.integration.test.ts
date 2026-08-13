import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

// The route modules import the `@/lib/db` singleton, which reads
// DATABASE_URL at PrismaClient construction time — so it must be set BEFORE
// those modules (or anything that transitively imports them) is imported.
// vitest.config.ts doesn't alias process.env, so this must happen here,
// synchronously, before any `await import(...)` below.
const dbFile = path.join(os.tmpdir(), `concept-sort-api-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
const MIGRATION_ORDER = [
  "20260803154453_init",
  "20260803180717_add_consent_and_demographics",
  "20260805233213_add_multilingual_project_support",
  "20260807144811_add_analysis_run_models",
  "20260807180000_scope_legacy_consent_fallback",
  "20260813011500_add_guide_template_fields",
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
process.env.ANALYSIS_ENGINE_SOURCE_COMMIT_SHA = "b".repeat(40);

const { prisma } = await import("@/lib/db");
const runsRoute = await import("@/app/api/projects/[slug]/analysis/runs/route");
const runDetailRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/route");
const eligibilityRoute = await import("@/app/api/projects/[slug]/analysis/eligibility/route");
const { fromStoredSeed } = await import("@/lib/analysis/executionService");

async function seedProjectWithSessions(slug: string) {
  const project = await prisma.project.create({
    data: {
      slug,
      adminToken: `token-${slug}`,
      title: "t",
      prompt: "test prompt",
      consentKo: "test consent",
      koPreviewConfirmedAt: new Date(),
    },
  });
  const statements = [];
  for (let i = 0; i < 6; i++) statements.push(await prisma.statement.create({ data: { projectId: project.id, text: `s${i}`, order: i } }));
  const half = 3;
  const statementIds = statements.map((s) => s.id);
  for (let i = 0; i < 3; i++) {
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: "synthetic",
        gender: "unspecified",
        age: 20,
        schoolLevel: "unspecified",
        grade: "unspecified",
        phoneNumber: "000-0000-0000",
        countryCode: "KR",
        groups: {
          create: [
            { items: { create: statementIds.slice(0, half).map((id) => ({ statementId: id })) } },
            { items: { create: statementIds.slice(half).map((id) => ({ statementId: id })) } },
          ],
        },
      },
    });
  }
  return { project, statementIds };
}

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    /* best effort */
  }
});

describe("auth mapping", () => {
  it("401 for missing Authorization header", async () => {
    const { project } = await seedProjectWithSessions("api-auth-1");
    const req = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/eligibility?scope=KR`);
    const res = await eligibilityRoute.GET(req, { params: Promise.resolve({ slug: project.slug }) });
    expect(res.status).toBe(401);
  });

  it("404 for a nonexistent project (never a different status than a real ownership mismatch would need)", async () => {
    const req = new NextRequest(`http://localhost/api/projects/does-not-exist/analysis/eligibility?scope=KR`, {
      headers: { authorization: "Bearer whatever" },
    });
    const res = await eligibilityRoute.GET(req, { params: Promise.resolve({ slug: "does-not-exist" }) });
    expect(res.status).toBe(404);
  });
});

describe("K — cross-project run access is 404, not 403 or a leak", () => {
  it("returns 404 when requesting a run that belongs to a different project", async () => {
    const { project: projectA } = await seedProjectWithSessions("api-cross-a");
    const { project: projectB } = await seedProjectWithSessions("api-cross-b");

    const createReq = new NextRequest(`http://localhost/api/projects/${projectA.slug}/analysis/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${projectA.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "KR" }),
    });
    const createRes = await runsRoute.POST(createReq, { params: Promise.resolve({ slug: projectA.slug }) });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    // Authenticate as projectB's admin, but ask for projectA's run.
    const getReq = new NextRequest(`http://localhost/api/projects/${projectB.slug}/analysis/runs/${created.id}`, {
      headers: { authorization: `Bearer ${projectB.adminToken}` },
    });
    const getRes = await runDetailRoute.GET(getReq, { params: Promise.resolve({ slug: projectB.slug, runId: created.id }) });
    expect(getRes.status).toBe(404);
    const body = await getRes.json();
    expect(body.errorCode).toBe("RUN_NOT_FOUND");
  });
});

describe("L / M — real end-to-end run via the API, and stale-result exposure", () => {
  it("POST .../runs executes synchronously to COMPLETED with a real Ward result, and GET exposes the body while current", async () => {
    const { project } = await seedProjectWithSessions("api-e2e");

    const createReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${project.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "KR" }),
    });
    const createRes = await runsRoute.POST(createReq, { params: Promise.resolve({ slug: project.slug }) });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.executionStatus).toBe("COMPLETED");
    expect(created.wardStatus).toBe("COMPLETED");

    const getReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs/${created.id}`, {
      headers: { authorization: `Bearer ${project.adminToken}` },
    });
    const getRes = await runDetailRoute.GET(getReq, { params: Promise.resolve({ slug: project.slug, runId: created.id }) });
    const body = await getRes.json();
    expect(body.resultBodyBlocked).toBe(false);
    expect(body.dimensions).toBeDefined();
    expect(body.dimensions[0].coordinates).not.toBeNull();
    expect(body.wardLinkageSnapshot).not.toBeNull();

    // bestSeed must be the decoded unsigned value, never the raw signed
    // storage encoding — compare directly against the raw DB row.
    const rawDim = await prisma.analysisRunDimension.findFirstOrThrow({ where: { analysisRunId: created.id } });
    expect(typeof body.dimensions[0].bestSeed).toBe("number");
    expect(body.dimensions[0].bestSeed).toBeGreaterThanOrEqual(0);
    expect(body.dimensions[0].bestSeed).toBe(fromStoredSeed(rawDim.bestSeed));
    if (rawDim.bestSeed !== null && rawDim.bestSeed < 0) {
      // The one case that actually proves decoding happened: the raw
      // stored value is negative, but the API must still report it as the
      // large positive unsigned seed, never the raw negative number.
      expect(body.dimensions[0].bestSeed).not.toBe(rawDim.bestSeed);
      expect(body.dimensions[0].bestSeed).toBeGreaterThan(2147483647);
    }
  });

  it("blocks the result body once the project's statement content changes after the run (content STALE)", async () => {
    const { project, statementIds } = await seedProjectWithSessions("api-stale");

    const createReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${project.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "KR" }),
    });
    const createRes = await runsRoute.POST(createReq, { params: Promise.resolve({ slug: project.slug }) });
    const created = await createRes.json();

    // Change a statement's Korean text after the run completed.
    await prisma.statement.update({ where: { id: statementIds[0] }, data: { text: "changed after the run" } });

    const getReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs/${created.id}`, {
      headers: { authorization: `Bearer ${project.adminToken}` },
    });
    const getRes = await runDetailRoute.GET(getReq, { params: Promise.resolve({ slug: project.slug, runId: created.id }) });
    const body = await getRes.json();
    expect(body.resultBodyBlocked).toBe(true);
    expect(body.dimensions).toBeUndefined();
    expect(body.freshness.contentFreshnessKo).toBe("STALE");
  });
});
