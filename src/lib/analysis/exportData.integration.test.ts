import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const dbFile = path.join(os.tmpdir(), `concept-sort-export-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
  for (const name of MIGRATION_ORDER) db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8"));
  db.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.ANALYSIS_ENGINE_SOURCE_COMMIT_SHA = "e".repeat(40);

const { prisma } = await import("@/lib/db");
const runsRoute = await import("@/app/api/projects/[slug]/analysis/runs/route");
const exportDataRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/export-data/route");

const FORBIDDEN = ["participantName", "phoneNumber", "adminToken", "DATABASE_URL"];

async function seedReadyProject(slug: string, statementCount = 6) {
  const project = await prisma.project.create({
    data: {
      slug,
      adminToken: `token-${slug}`,
      title: "t",
      prompt: "p",
      consentKo: "c",
      koPreviewConfirmedAt: new Date(),
    },
  });
  const statements = [];
  for (let i = 0; i < statementCount; i++) statements.push(await prisma.statement.create({ data: { projectId: project.id, text: `stmt-${i}`, order: i } }));
  const ids = statements.map((s) => s.id);
  const half = Math.ceil(ids.length / 2);
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
            { items: { create: ids.slice(0, half).map((id) => ({ statementId: id })) } },
            { items: { create: ids.slice(half).map((id) => ({ statementId: id })) } },
          ],
        },
      },
    });
  }
  return { project, statementIds: ids };
}

async function createRun(project: { slug: string; adminToken: string }, scope: "KR" | "JP" | "ALL" = "KR") {
  const req = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${project.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ scope }),
  });
  const res = await runsRoute.POST(req, { params: Promise.resolve({ slug: project.slug }) });
  expect(res.status).toBe(201);
  return res.json();
}

function exportReq(slug: string, runId: string, token: string, lang = "ko") {
  return new NextRequest(`http://localhost/api/projects/${slug}/analysis/runs/${runId}/export-data?lang=${lang}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    /* best effort */
  }
});

describe("export-data — A: CURRENT run succeeds", () => {
  it("returns a full export payload for a fresh COMPLETED run", async () => {
    const { project } = await seedReadyProject("export-a");
    const created = await createRun(project);
    const res = await exportDataRoute.GET(exportReq(project.slug, created.id, project.adminToken), {
      params: Promise.resolve({ slug: project.slug, runId: created.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.runId).toBe(created.id);
    expect(body.dimensions.length).toBeGreaterThan(0);
    expect(body.ward).not.toBeNull();
  });
});

describe("export-data — B: numeric stale is blocked", () => {
  it("blocks export once a new response changes the numeric input", async () => {
    const { project, statementIds } = await seedReadyProject("export-b");
    const created = await createRun(project);
    const half = Math.ceil(statementIds.length / 2);
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: "synthetic2",
        gender: "unspecified",
        age: 21,
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
    const res = await exportDataRoute.GET(exportReq(project.slug, created.id, project.adminToken), {
      params: Promise.resolve({ slug: project.slug, runId: created.id }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("NUMERIC_STALE");
  });
});

describe("export-data — C/D: language-specific content staleness", () => {
  it("blocks ko export on KO text change, but ja export for the same run is unaffected", async () => {
    const { project, statementIds } = await seedReadyProject("export-c");
    const created = await createRun(project);
    await prisma.statement.update({ where: { id: statementIds[0] }, data: { text: "changed" } });

    const koRes = await exportDataRoute.GET(exportReq(project.slug, created.id, project.adminToken, "ko"), {
      params: Promise.resolve({ slug: project.slug, runId: created.id }),
    });
    expect(koRes.status).toBe(409);
    expect((await koRes.json()).reason).toBe("CONTENT_STALE");

    const jaRes = await exportDataRoute.GET(exportReq(project.slug, created.id, project.adminToken, "ja"), {
      params: Promise.resolve({ slug: project.slug, runId: created.id }),
    });
    // JA content unaffected by the KO-only edit — still blocked only by
    // publication readiness (JA content is not APPROVED in this fixture),
    // never by the KO change itself.
    const jaBody = await jaRes.json();
    expect(jaRes.status).toBe(409);
    expect(jaBody.reason).not.toBe("CONTENT_STALE");
  });
});

describe("export-data — E: publication blocked", () => {
  it("blocks export when the export language is not publication-ready", async () => {
    const { project } = await seedReadyProject("export-e");
    const created = await createRun(project);
    // JA was never set up (no titleJa/promptJa/consentJa/approved statements) -> publicationReadyJa=false.
    const res = await exportDataRoute.GET(exportReq(project.slug, created.id, project.adminToken, "ja"), {
      params: Promise.resolve({ slug: project.slug, runId: created.id }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("PUBLICATION_BLOCKED");
  });
});

describe("export-data — F: parameter superseded is blocked", () => {
  it("blocks a COMPLETED run whose stored parameterHash no longer matches the live app config", async () => {
    const { project } = await seedReadyProject("export-f");
    const created = await createRun(project);
    // Simulate the app's DEFAULT_ANALYSIS_PARAMETERS having changed since
    // this run executed — the route must compare against the LIVE config,
    // not re-derive "current" from the run's own stored snapshot (which
    // would trivially always match itself and could never detect this).
    await prisma.analysisRun.update({
      where: { id: created.id },
      data: { parameterHash: "outdated-parameter-hash-from-a-prior-app-config" },
    });
    const res = await exportDataRoute.GET(exportReq(project.slug, created.id, project.adminToken), {
      params: Promise.resolve({ slug: project.slug, runId: created.id }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("PARAMETERS_SUPERSEDED");
  });
});

describe("export-data — G: FAILED run is blocked", () => {
  it("blocks export for a run that failed (dimension >= n)", async () => {
    const project = await prisma.project.create({
      data: { slug: "export-g", adminToken: "token-export-g", title: "t", prompt: "p", consentKo: "c", koPreviewConfirmedAt: new Date() },
    });
    const s1 = await prisma.statement.create({ data: { projectId: project.id, text: "a", order: 0 } });
    const s2 = await prisma.statement.create({ data: { projectId: project.id, text: "b", order: 1 } });
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: "synthetic",
        gender: "u",
        age: 20,
        schoolLevel: "u",
        grade: "u",
        phoneNumber: "000-0000-0000",
        countryCode: "KR",
        groups: { create: [{ items: { create: [{ statementId: s1.id }] } }, { items: { create: [{ statementId: s2.id }] } }] },
      },
    });
    const created = await createRun(project);
    expect(created.executionStatus).toBe("FAILED");
    const res = await exportDataRoute.GET(exportReq(project.slug, created.id, project.adminToken), {
      params: Promise.resolve({ slug: project.slug, runId: created.id }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("RUN_NOT_COMPLETED");
  });
});

describe("export-data — H/I: cross-project 404 and auth 401", () => {
  it("H. returns 404 for a run belonging to a different project", async () => {
    const { project: projectA } = await seedReadyProject("export-h-a");
    const { project: projectB } = await seedReadyProject("export-h-b");
    const created = await createRun(projectA);
    const res = await exportDataRoute.GET(exportReq(projectB.slug, created.id, projectB.adminToken), {
      params: Promise.resolve({ slug: projectB.slug, runId: created.id }),
    });
    expect(res.status).toBe(404);
  });

  it("I. returns 401 for a missing/invalid Authorization header", async () => {
    const { project } = await seedReadyProject("export-i");
    const created = await createRun(project);
    const req = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs/${created.id}/export-data`);
    const res = await exportDataRoute.GET(req, { params: Promise.resolve({ slug: project.slug, runId: created.id }) });
    expect(res.status).toBe(401);
  });
});

describe("export-data — PII and bestSeed audit", () => {
  it("the export payload JSON never contains forbidden PII fields, and bestSeed is the unsigned value", async () => {
    const { project } = await seedReadyProject("export-pii");
    const created = await createRun(project);
    const res = await exportDataRoute.GET(exportReq(project.slug, created.id, project.adminToken), {
      params: Promise.resolve({ slug: project.slug, runId: created.id }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden);
    }
    const body = JSON.parse(text);
    for (const dim of body.dimensions) {
      if (dim.bestSeed !== null) expect(dim.bestSeed).toBeGreaterThanOrEqual(0);
    }
  });
});
