import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const dbFile = path.join(
  os.tmpdir(),
  `concept-sort-sorts-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
const MIGRATION_ORDER = [
  "20260803154453_init",
  "20260803180717_add_consent_and_demographics",
  "20260805233213_add_multilingual_project_support",
  "20260807144811_add_analysis_run_models",
  "20260807180000_scope_legacy_consent_fallback",
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
const sortsRoute = await import("./route");

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    // best-effort
  }
});

async function seedReadyProject(slug: string, opts?: { japaneseApproved?: boolean }) {
  const japaneseApproved = opts?.japaneseApproved ?? true;
  const project = await prisma.project.create({
    data: {
      slug,
      adminToken: `token-${slug}`,
      title: "제목",
      prompt: "안내",
      consentKo: "동의서 본문",
      titleJa: "タイトル",
      promptJa: "案内",
      consentJa: "同意書本文",
      koreanEnabled: true,
      japaneseEnabled: true,
      koPreviewConfirmedAt: new Date(),
      jaPreviewConfirmedAt: new Date(),
    },
  });
  const statements = [];
  for (let i = 0; i < 4; i++) {
    statements.push(
      await prisma.statement.create({
        data: {
          projectId: project.id,
          order: i,
          text: `${i + 1}. ko-${i}`,
          textJa: `${i + 1}. ja-${i}`,
          jaStatus: japaneseApproved ? "APPROVED" : "DRAFT",
        },
      })
    );
  }
  return { project, statements };
}

function baseBody(statementIds: string[], countryCode: unknown) {
  return {
    participantName: "tester",
    consentAgreed: true,
    countryCode,
    gender: "남자",
    age: 20,
    schoolLevel: "중학교",
    grade: "1학년",
    phoneNumber: "010-0000-0000",
    groups: [
      { label: "g1", statementIds: [statementIds[0], statementIds[1]] },
      { label: "g2", statementIds: [statementIds[2], statementIds[3]] },
    ],
  };
}

async function callSorts(slug: string, body: unknown) {
  const req = new NextRequest(`http://localhost/api/projects/${slug}/sorts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const res = await sortsRoute.POST(req, { params: Promise.resolve({ slug }) });
  const data = await res.json();
  return { status: res.status, data };
}

describe("POST /api/projects/[slug]/sorts — countryCode validation", () => {
  it("accepts a valid KR submission and stores countryCode=KR", async () => {
    const slug = "sorts-kr-valid";
    const { project, statements } = await seedReadyProject(slug);
    const { status, data } = await callSorts(
      slug,
      baseBody(statements.map((s) => s.id), "KR")
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    const session = await prisma.sortSession.findFirstOrThrow({
      where: { projectId: project.id },
    });
    expect(session.countryCode).toBe("KR");
  });

  it("accepts a valid JP submission and stores countryCode=JP", async () => {
    const slug = "sorts-jp-valid";
    const { project, statements } = await seedReadyProject(slug);
    const { status, data } = await callSorts(
      slug,
      baseBody(statements.map((s) => s.id), "JP")
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    const session = await prisma.sortSession.findFirstOrThrow({
      where: { projectId: project.id },
    });
    expect(session.countryCode).toBe("JP");
  });

  it("rejects a missing countryCode", async () => {
    const slug = "sorts-missing-country";
    const { statements } = await seedReadyProject(slug);
    const body = baseBody(statements.map((s) => s.id), undefined);
    delete (body as { countryCode?: unknown }).countryCode;
    const { status, data } = await callSorts(slug, body);
    expect(status).toBe(400);
    expect(data.errorCode).toBe("COUNTRY_REQUIRED");
  });

  it("rejects an invalid countryCode value", async () => {
    const slug = "sorts-invalid-country";
    const { statements } = await seedReadyProject(slug);
    const { status, data } = await callSorts(
      slug,
      baseBody(statements.map((s) => s.id), "US")
    );
    expect(status).toBe(400);
    expect(data.errorCode).toBe("COUNTRY_REQUIRED");
  });

  it("rejects lowercase 'kr'/'jp' — validation is case-sensitive, not loosened", async () => {
    const slug = "sorts-lowercase-country";
    const { statements } = await seedReadyProject(slug);
    const { status, data } = await callSorts(
      slug,
      baseBody(statements.map((s) => s.id), "kr")
    );
    expect(status).toBe(400);
    expect(data.errorCode).toBe("COUNTRY_REQUIRED");
  });

  it("rejects a JP submission when Japanese content isn't APPROVED (readiness still enforced independent of country-step fix)", async () => {
    const slug = "sorts-jp-not-approved";
    const { statements } = await seedReadyProject(slug, { japaneseApproved: false });
    const { status, data } = await callSorts(
      slug,
      baseBody(statements.map((s) => s.id), "JP")
    );
    expect(status).toBe(400);
    // Whole-project JA readiness (computeLocaleContentStatus) already requires
    // every statement APPROVED, so an unapproved statement fails the
    // project-level gate (COUNTRY_NOT_AVAILABLE) before the later
    // per-submission JAPANESE_CONTENT_NOT_READY check is ever reached —
    // both are valid rejections of the same underlying protection.
    expect(data.errorCode).toBe("COUNTRY_NOT_AVAILABLE");
  });

  it("no SortSession row is created for any rejected submission", async () => {
    const slug = "sorts-no-rows-on-reject";
    const { project, statements } = await seedReadyProject(slug);
    await callSorts(slug, baseBody(statements.map((s) => s.id), "INVALID"));
    const count = await prisma.sortSession.count({ where: { projectId: project.id } });
    expect(count).toBe(0);
  });
});
