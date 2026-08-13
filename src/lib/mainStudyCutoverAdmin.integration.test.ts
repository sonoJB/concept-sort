import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const dbFile = path.join(
  os.tmpdir(),
  `concept-sort-cutover-admin-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);
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
const scheduleRoute = await import("@/app/api/projects/[slug]/main-study-schedule/route");
const videoRoute = await import("@/app/api/projects/[slug]/guide-video/route");
const readinessRoute = await import("@/app/api/projects/[slug]/readiness/route");

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    // best-effort
  }
});

let slugCounter = 0;
async function seedProject(opts?: { mainStudyStartsAt?: Date | null }) {
  const slug = `cutover-admin-${++slugCounter}`;
  const project = await prisma.project.create({
    data: {
      slug,
      adminToken: `token-${slug}`,
      title: "t",
      koreanEnabled: true,
      mainStudyStartsAt: opts?.mainStudyStartsAt ?? null,
    },
  });
  return project;
}

async function patchSchedule(slug: string, adminToken: string, mainStudyStartsAt: string | null) {
  const req = new NextRequest(`http://localhost/api/projects/${slug}/main-study-schedule`, {
    method: "PATCH",
    body: JSON.stringify({ adminToken, mainStudyStartsAt }),
  });
  const res = await scheduleRoute.PATCH(req, { params: Promise.resolve({ slug }) });
  return { status: res.status, data: await res.json() };
}

async function patchVideo(slug: string, adminToken: string, locale: "ko" | "ja", url: string | null) {
  const req = new NextRequest(`http://localhost/api/projects/${slug}/guide-video`, {
    method: "PATCH",
    body: JSON.stringify({ adminToken, locale, url }),
  });
  const res = await videoRoute.PATCH(req, { params: Promise.resolve({ slug }) });
  return { status: res.status, data: await res.json() };
}

async function getReadiness(slug: string, adminToken: string) {
  const req = new NextRequest(`http://localhost/api/projects/${slug}/readiness?token=${adminToken}`);
  const res = await readinessRoute.GET(req, { params: Promise.resolve({ slug }) });
  return { status: res.status, data: await res.json() };
}

describe("PATCH /api/projects/[slug]/main-study-schedule", () => {
  it("(30) sets mainStudyStartsAt while MAIN count is 0", async () => {
    const project = await seedProject();
    const { status, data } = await patchSchedule(
      project.slug,
      project.adminToken,
      "2026-08-16T15:00:00.000Z"
    );
    expect(status).toBe(200);
    expect(data.mainStudyStartsAt).toBe("2026-08-16T15:00:00.000Z");

    const updated = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(updated.mainStudyStartsAt?.toISOString()).toBe("2026-08-16T15:00:00.000Z");
  });

  it("clears mainStudyStartsAt back to null while MAIN count is 0", async () => {
    const project = await seedProject({ mainStudyStartsAt: new Date("2026-08-16T15:00:00.000Z") });
    const { status, data } = await patchSchedule(project.slug, project.adminToken, null);
    expect(status).toBe(200);
    expect(data.mainStudyStartsAt).toBeNull();
  });

  it("(31) rejects any change once a MAIN SortSession exists, and does not modify the stored value", async () => {
    const project = await seedProject({ mainStudyStartsAt: new Date("2026-08-16T15:00:00.000Z") });
    const s1 = await prisma.statement.create({ data: { projectId: project.id, text: "s1", order: 0 } });
    const s2 = await prisma.statement.create({ data: { projectId: project.id, text: "s2", order: 1 } });
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: "p",
        gender: "unspecified",
        age: 20,
        schoolLevel: "unspecified",
        grade: "unspecified",
        phoneNumber: "000",
        countryCode: "KR",
        dataRole: "MAIN",
        groups: { create: [{ items: { create: [{ statementId: s1.id }, { statementId: s2.id }] } }] },
      },
    });

    const { status, data } = await patchSchedule(
      project.slug,
      project.adminToken,
      "2027-01-01T00:00:00.000Z"
    );
    expect(status).toBe(409);
    expect(data.error).toMatch(/변경할 수 없습니다/);

    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(unchanged.mainStudyStartsAt?.toISOString()).toBe("2026-08-16T15:00:00.000Z");
  });

  it("a PILOT-only SortSession does not lock the schedule", async () => {
    const project = await seedProject({ mainStudyStartsAt: new Date("2026-08-16T15:00:00.000Z") });
    const s1 = await prisma.statement.create({ data: { projectId: project.id, text: "s1", order: 0 } });
    const s2 = await prisma.statement.create({ data: { projectId: project.id, text: "s2", order: 1 } });
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: "p",
        gender: "unspecified",
        age: 20,
        schoolLevel: "unspecified",
        grade: "unspecified",
        phoneNumber: "000",
        countryCode: "KR",
        dataRole: "PILOT",
        groups: { create: [{ items: { create: [{ statementId: s1.id }, { statementId: s2.id }] } }] },
      },
    });

    const { status } = await patchSchedule(project.slug, project.adminToken, "2027-01-01T00:00:00.000Z");
    expect(status).toBe(200);
  });

  it("rejects an unparseable date string", async () => {
    const project = await seedProject();
    const { status } = await patchSchedule(project.slug, project.adminToken, "not-a-date");
    expect(status).toBe(400);
  });

  it("rejects an invalid admin token", async () => {
    const project = await seedProject();
    const { status } = await patchSchedule(project.slug, "wrong-token", "2026-08-16T15:00:00.000Z");
    expect(status).toBe(403);
  });
});

describe("PATCH /api/projects/[slug]/guide-video", () => {
  it("(23)/(24) saves a valid KO URL and a valid JA URL independently", async () => {
    const project = await seedProject();
    const koResult = await patchVideo(project.slug, project.adminToken, "ko", "https://youtu.be/aorQRatSvfQ");
    expect(koResult.status).toBe(200);
    expect(koResult.data.guideVideoUrlKo).toBe("https://youtu.be/aorQRatSvfQ");
    expect(koResult.data.guideVideoUrlJa).toBeNull();

    const jaResult = await patchVideo(project.slug, project.adminToken, "ja", "https://youtu.be/rWUWjA1-g4U");
    expect(jaResult.status).toBe(200);
    expect(jaResult.data.guideVideoUrlKo).toBe("https://youtu.be/aorQRatSvfQ");
    expect(jaResult.data.guideVideoUrlJa).toBe("https://youtu.be/rWUWjA1-g4U");
  });

  it("rejects an invalid URL and leaves the stored value unchanged", async () => {
    const project = await seedProject();
    await patchVideo(project.slug, project.adminToken, "ko", "https://youtu.be/aorQRatSvfQ");
    const { status } = await patchVideo(project.slug, project.adminToken, "ko", "http://youtu.be/aorQRatSvfQ");
    expect(status).toBe(400);

    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(unchanged.guideVideoUrlKo).toBe("https://youtu.be/aorQRatSvfQ");
  });

  it("(22) an empty URL clears the stored value to null", async () => {
    const project = await seedProject();
    await patchVideo(project.slug, project.adminToken, "ko", "https://youtu.be/aorQRatSvfQ");
    const { status, data } = await patchVideo(project.slug, project.adminToken, "ko", "");
    expect(status).toBe(200);
    expect(data.guideVideoUrlKo).toBeNull();
  });

  it("does not reset koreanEnabled — a video-link edit is not statistical study content", async () => {
    const project = await seedProject();
    await prisma.project.update({ where: { id: project.id }, data: { koreanEnabled: true } });
    await patchVideo(project.slug, project.adminToken, "ko", "https://youtu.be/aorQRatSvfQ");
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.koreanEnabled).toBe(true);
  });

  it("rejects an invalid locale", async () => {
    const project = await seedProject();
    const req = new NextRequest(`http://localhost/api/projects/${project.slug}/guide-video`, {
      method: "PATCH",
      body: JSON.stringify({ adminToken: project.adminToken, locale: "fr", url: "https://youtu.be/x" }),
    });
    const res = await videoRoute.PATCH(req, { params: Promise.resolve({ slug: project.slug }) });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects/[slug]/readiness — extended with cutover phase/counts/video URLs", () => {
  it("reports currentPhase=MAIN and mainCount/pilotCount when no cutover is configured", async () => {
    const project = await seedProject();
    const { status, data } = await getReadiness(project.slug, project.adminToken);
    expect(status).toBe(200);
    expect(data.currentPhase).toBe("MAIN");
    expect(data.mainStudyStartsAt).toBeNull();
    expect(data.counts).toEqual({
      total: 0,
      main: 0,
      pilot: 0,
      krMain: 0,
      krPilot: 0,
      jpMain: 0,
      jpPilot: 0,
    });
  });

  it("reports currentPhase=PILOT when the server clock is before the configured cutover", async () => {
    const project = await seedProject({ mainStudyStartsAt: new Date("2099-01-01T00:00:00.000Z") });
    const { data } = await getReadiness(project.slug, project.adminToken);
    expect(data.currentPhase).toBe("PILOT");
    expect(data.mainStudyStartsAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("(9)/(10) counts break down correctly by dataRole and country", async () => {
    const project = await seedProject();
    const s1 = await prisma.statement.create({ data: { projectId: project.id, text: "s1", order: 0 } });
    const s2 = await prisma.statement.create({ data: { projectId: project.id, text: "s2", order: 1 } });
    const rows: { countryCode: "KR" | "JP"; dataRole: "MAIN" | "PILOT" }[] = [
      { countryCode: "KR", dataRole: "PILOT" },
      { countryCode: "KR", dataRole: "PILOT" },
      { countryCode: "JP", dataRole: "PILOT" },
      { countryCode: "KR", dataRole: "MAIN" },
    ];
    for (const r of rows) {
      await prisma.sortSession.create({
        data: {
          projectId: project.id,
          participantName: "p",
          gender: "unspecified",
          age: 20,
          schoolLevel: "unspecified",
          grade: "unspecified",
          phoneNumber: "000",
          countryCode: r.countryCode,
          dataRole: r.dataRole,
          groups: { create: [{ items: { create: [{ statementId: s1.id }, { statementId: s2.id }] } }] },
        },
      });
    }

    const { data } = await getReadiness(project.slug, project.adminToken);
    expect(data.counts).toEqual({
      total: 4,
      main: 1,
      pilot: 3,
      krMain: 1,
      krPilot: 2,
      jpMain: 0,
      jpPilot: 1,
    });
  });

  it("returns the saved guideVideoUrlKo/Ja", async () => {
    const project = await seedProject();
    await patchVideo(project.slug, project.adminToken, "ko", "https://youtu.be/aorQRatSvfQ");
    const { data } = await getReadiness(project.slug, project.adminToken);
    expect(data.guideVideoUrlKo).toBe("https://youtu.be/aorQRatSvfQ");
    expect(data.guideVideoUrlJa).toBeNull();
  });
});
