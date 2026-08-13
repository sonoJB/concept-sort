import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const dbFile = path.join(
  os.tmpdir(),
  `concept-sort-content-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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
const contentRoute = await import("./route");

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    // best-effort
  }
});

async function seedProject(slug: string) {
  return prisma.project.create({
    data: {
      slug,
      adminToken: `token-${slug}`,
      title: "t",
      koPreviewConfirmedAt: new Date(),
      koreanEnabled: true,
      jaPreviewConfirmedAt: new Date(),
      japaneseEnabled: true,
    },
  });
}

function req(slug: string, body: unknown) {
  return new NextRequest(`http://localhost/api/projects/${slug}/content`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function callPatch(slug: string, body: unknown) {
  const res = await contentRoute.PATCH(req(slug, body), { params: Promise.resolve({ slug }) });
  const data = await res.json();
  return { status: res.status, data };
}

describe("PATCH /api/projects/[slug]/content — consent body", () => {
  it("saves consentKo", async () => {
    const slug = "content-consent-ko";
    await seedProject(slug);
    const { status, data } = await callPatch(slug, {
      adminToken: `token-${slug}`,
      locale: "ko",
      consent: "한국어 동의서 본문",
    });
    expect(status).toBe(200);
    expect(data.consentKo).toBe("한국어 동의서 본문");
  });

  it("saves consentJa", async () => {
    const slug = "content-consent-ja";
    await seedProject(slug);
    const { status, data } = await callPatch(slug, {
      adminToken: `token-${slug}`,
      locale: "ja",
      consent: "日本語同意書本文",
    });
    expect(status).toBe(200);
    expect(data.consentJa).toBe("日本語同意書本文");
  });

  it("preserves Unicode and newlines exactly", async () => {
    const slug = "content-consent-unicode";
    await seedProject(slug);
    const body = "1행\n2행\n\n한글·日本語·①②③";
    const { data } = await callPatch(slug, { adminToken: `token-${slug}`, locale: "ko", consent: body });
    expect(data.consentKo).toBe(body);
    const refreshed = await prisma.project.findFirst({ where: { slug } });
    expect(refreshed?.consentKo).toBe(body);
  });

  it("saving Korean consent never touches Japanese consent", async () => {
    const slug = "content-no-cross-overwrite-ko";
    const project = await seedProject(slug);
    await prisma.project.update({ where: { id: project.id }, data: { consentJa: "existing-ja" } });
    await callPatch(slug, { adminToken: `token-${slug}`, locale: "ko", consent: "new-ko" });
    const refreshed = await prisma.project.findFirst({ where: { slug } });
    expect(refreshed?.consentKo).toBe("new-ko");
    expect(refreshed?.consentJa).toBe("existing-ja");
  });

  it("saving Japanese consent never touches Korean consent", async () => {
    const slug = "content-no-cross-overwrite-ja";
    const project = await seedProject(slug);
    await prisma.project.update({ where: { id: project.id }, data: { consentKo: "existing-ko" } });
    await callPatch(slug, { adminToken: `token-${slug}`, locale: "ja", consent: "new-ja" });
    const refreshed = await prisma.project.findFirst({ where: { slug } });
    expect(refreshed?.consentJa).toBe("new-ja");
    expect(refreshed?.consentKo).toBe("existing-ko");
  });
});

describe("PATCH /api/projects/[slug]/content — guide template", () => {
  it("saves guideTemplateKo", async () => {
    const slug = "content-guide-ko";
    await seedProject(slug);
    const { status, data } = await callPatch(slug, {
      adminToken: `token-${slug}`,
      locale: "ko",
      guideTemplate: "총 {{CARD_COUNT}}장",
    });
    expect(status).toBe(200);
    expect(data.guideTemplateKo).toBe("총 {{CARD_COUNT}}장");
  });

  it("saves guideTemplateJa", async () => {
    const slug = "content-guide-ja";
    await seedProject(slug);
    const { status, data } = await callPatch(slug, {
      adminToken: `token-${slug}`,
      locale: "ja",
      guideTemplate: "全{{CARD_COUNT}}枚",
    });
    expect(status).toBe(200);
    expect(data.guideTemplateJa).toBe("全{{CARD_COUNT}}枚");
  });

  it("preserves Unicode and newlines in the guide template", async () => {
    const slug = "content-guide-unicode";
    await seedProject(slug);
    const template = "※ 안내\n① 규칙\n最少：{{MIN_GROUPS}}グループ";
    const { data } = await callPatch(slug, { adminToken: `token-${slug}`, locale: "ko", guideTemplate: template });
    expect(data.guideTemplateKo).toBe(template);
  });

  it("saving the Korean guide template never touches the Japanese one", async () => {
    const slug = "content-guide-no-cross";
    const project = await seedProject(slug);
    await prisma.project.update({ where: { id: project.id }, data: { guideTemplateJa: "existing-ja-template" } });
    await callPatch(slug, { adminToken: `token-${slug}`, locale: "ko", guideTemplate: "new-ko-template" });
    const refreshed = await prisma.project.findFirst({ where: { slug } });
    expect(refreshed?.guideTemplateKo).toBe("new-ko-template");
    expect(refreshed?.guideTemplateJa).toBe("existing-ja-template");
  });

  it("rejects a template containing an unknown variable", async () => {
    const slug = "content-guide-unknown-var";
    await seedProject(slug);
    const { status, data } = await callPatch(slug, {
      adminToken: `token-${slug}`,
      locale: "ko",
      guideTemplate: "{{TOTALLY_MADE_UP}}",
    });
    expect(status).toBe(400);
    expect(data.error).toMatch(/TOTALLY_MADE_UP/);
  });

  it("accepts every documented template variable", async () => {
    const slug = "content-guide-all-vars";
    await seedProject(slug);
    const template =
      "{{CARD_COUNT}} {{MAX_CARDS_PER_GROUP}} {{FIRST_FORBIDDEN_GROUP_SIZE}} {{MIN_GROUPS}} {{MAX_GROUPS}} {{MIN_GROUP_BREAKDOWN}} {{MAX_GROUP_BREAKDOWN}}";
    const { status } = await callPatch(slug, { adminToken: `token-${slug}`, locale: "ko", guideTemplate: template });
    expect(status).toBe(200);
  });

  it("clearing the template (empty string) resets it to null (use built-in default)", async () => {
    const slug = "content-guide-clear";
    const project = await seedProject(slug);
    await prisma.project.update({ where: { id: project.id }, data: { guideTemplateKo: "old-template" } });
    const { data } = await callPatch(slug, { adminToken: `token-${slug}`, locale: "ko", guideTemplate: "" });
    expect(data.guideTemplateKo).toBeNull();
  });
});

describe("PATCH /api/projects/[slug]/content — preview invalidation / participation safety", () => {
  it("saving Korean content (consent or guide template) resets koPreviewConfirmedAt/koreanEnabled, leaves Japanese untouched", async () => {
    const slug = "content-invalidate-ko";
    await seedProject(slug);
    await callPatch(slug, { adminToken: `token-${slug}`, locale: "ko", consent: "x" });
    const refreshed = await prisma.project.findFirst({ where: { slug } });
    expect(refreshed?.koPreviewConfirmedAt).toBeNull();
    expect(refreshed?.koreanEnabled).toBe(false);
    expect(refreshed?.jaPreviewConfirmedAt).not.toBeNull();
    expect(refreshed?.japaneseEnabled).toBe(true);
  });

  it("saving Japanese content resets jaPreviewConfirmedAt/japaneseEnabled, leaves Korean untouched", async () => {
    const slug = "content-invalidate-ja";
    await seedProject(slug);
    await callPatch(slug, { adminToken: `token-${slug}`, locale: "ja", consent: "x" });
    const refreshed = await prisma.project.findFirst({ where: { slug } });
    expect(refreshed?.jaPreviewConfirmedAt).toBeNull();
    expect(refreshed?.japaneseEnabled).toBe(false);
    expect(refreshed?.koPreviewConfirmedAt).not.toBeNull();
    expect(refreshed?.koreanEnabled).toBe(true);
  });

  it("saving a guide template change also invalidates that locale's preview/enabled state", async () => {
    const slug = "content-invalidate-guide";
    await seedProject(slug);
    await callPatch(slug, { adminToken: `token-${slug}`, locale: "ko", guideTemplate: "changed" });
    const refreshed = await prisma.project.findFirst({ where: { slug } });
    expect(refreshed?.koPreviewConfirmedAt).toBeNull();
    expect(refreshed?.koreanEnabled).toBe(false);
  });
});
