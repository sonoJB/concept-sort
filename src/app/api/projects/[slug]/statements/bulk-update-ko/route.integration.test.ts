import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const dbFile = path.join(
  os.tmpdir(),
  `concept-sort-bulk-ko-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);
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

const { prisma } = await import("@/lib/db");
const bulkRoute = await import("./route");

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    // best-effort
  }
});

async function seedProject(
  slug: string,
  statementCount: number,
  opts?: { textJaSeed?: (i: number) => string | null; jaStatusSeed?: (i: number) => string }
) {
  const project = await prisma.project.create({
    data: { slug, adminToken: `token-${slug}`, title: "t" },
  });
  const statements = [];
  for (let i = 0; i < statementCount; i++) {
    statements.push(
      await prisma.statement.create({
        data: {
          projectId: project.id,
          text: `korean-${i}`,
          order: i,
          textJa: opts?.textJaSeed ? opts.textJaSeed(i) : null,
          jaStatus: opts?.jaStatusSeed ? opts.jaStatusSeed(i) : "MISSING",
        },
      })
    );
  }
  return { project, statements };
}

function koLines(n: number, prefix = "korean-updated"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

function bulkRequest(slug: string, body: unknown) {
  return new NextRequest(`http://localhost/api/projects/${slug}/statements/bulk-update-ko`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function callBulk(slug: string, body: unknown) {
  const req = bulkRequest(slug, body);
  const res = await bulkRoute.POST(req, { params: Promise.resolve({ slug }) });
  const data = await res.json();
  return { status: res.status, data };
}

describe("POST /api/projects/[slug]/statements/bulk-update-ko", () => {
  it("accepts exactly N unnumbered lines (case 1)", async () => {
    const slug = "ko-exact-n";
    const { project } = await seedProject(slug, 5);
    const lines = koLines(5);

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.updatedCount).toBe(5);

    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    refreshed.forEach((s, i) => expect(s.text).toBe(`korean-updated-${i}`));
  });

  it("rejects N-1 lines (case 2)", async () => {
    const slug = "ko-n-minus-1";
    await seedProject(slug, 5);
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines: koLines(4) });
    expect(status).toBe(400);
    expect(data.error).toMatch(/일치하지 않습니다/);
  });

  it("rejects N+1 lines (case 3)", async () => {
    const slug = "ko-n-plus-1";
    await seedProject(slug, 5);
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines: koLines(6) });
    expect(status).toBe(400);
    expect(data.error).toMatch(/일치하지 않습니다/);
  });

  it("rejects a blank line (case 4)", async () => {
    const slug = "ko-blank-line";
    await seedProject(slug, 3);
    const lines = koLines(3);
    lines[1] = "";
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    expect(data.error).toMatch(/비어 있습니다/);
  });

  it("rejects a whitespace-only line", async () => {
    const slug = "ko-whitespace-line";
    await seedProject(slug, 3);
    const lines = koLines(3);
    lines[2] = "   ";
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    expect(data.error).toMatch(/비어 있습니다/);
  });

  it("does not require, validate, or strip any numeric prefix", async () => {
    const slug = "ko-no-numbering-required";
    const { project } = await seedProject(slug, 3);
    const lines = ["첫 번째 진술문", "두 번째 진술문", "세 번째 진술문"];
    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(200);
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.text)).toEqual(lines);
  });

  it("does not strip or reject legitimate content that begins with a number", async () => {
    const slug = "ko-content-starts-with-number";
    const { project } = await seedProject(slug, 3);
    const lines = ["3명이 모였다", "24시간 내내", "1인 가구 증가"];
    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(200);
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.text)).toEqual(lines);
  });

  it("preserves Statement IDs after bulk edit (case 10)", async () => {
    const slug = "ko-ids-preserved";
    const { project, statements } = await seedProject(slug, 4);
    await callBulk(slug, { adminToken: `token-${slug}`, lines: koLines(4) });
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.id)).toEqual(statements.map((s) => s.id));
  });

  it("preserves Statement.order after bulk edit (case 11)", async () => {
    const slug = "ko-order-preserved";
    const { project, statements } = await seedProject(slug, 4);
    await callBulk(slug, { adminToken: `token-${slug}`, lines: koLines(4) });
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.order)).toEqual(statements.map((s) => s.order));
  });

  it("never touches textJa/jaStatus during Korean bulk save (case 12)", async () => {
    const slug = "ko-ja-untouched";
    const { project } = await seedProject(slug, 3, {
      textJaSeed: (i) => `existing-ja-${i}`,
      jaStatusSeed: () => "APPROVED",
    });
    await callBulk(slug, { adminToken: `token-${slug}`, lines: koLines(3) });
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    refreshed.forEach((s, i) => {
      expect(s.textJa).toBe(`existing-ja-${i}`);
      expect(s.jaStatus).toBe("APPROVED");
    });
  });

  it("rolls back entirely on validation failure — no partial writes (case 13)", async () => {
    const slug = "ko-atomic-fail";
    const { project, statements } = await seedProject(slug, 3);
    const lines = [statements[0].text, "", "x"]; // blank -> reject
    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    refreshed.forEach((s, i) => expect(s.text).toBe(statements[i].text));
  });

  it("creates N statements in sequence for a zero-statement project (case 14/15)", async () => {
    const slug = "ko-zero-create";
    const { project } = await seedProject(slug, 0);
    const lines = koLines(3, "new");
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(200);
    expect(data.createdCount).toBe(3);

    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.length).toBe(3);
    refreshed.forEach((s, i) => {
      expect(s.text).toBe(`new-${i}`);
      expect(s.order).toBe(i);
    });
  });

  it("does NOT delete/recreate Statements for an existing (non-zero) project — mapping is by position only (case 16)", async () => {
    const slug = "ko-existing-not-recreated";
    const { project, statements } = await seedProject(slug, 3);
    const idsBefore = statements.map((s) => s.id);
    await callBulk(slug, { adminToken: `token-${slug}`, lines: koLines(3) });
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.id)).toEqual(idsBefore);
  });

  it("issues zero writes when nothing changed", async () => {
    const slug = "ko-no-op";
    const { project, statements } = await seedProject(slug, 2);
    const lines = statements.map((s) => s.text); // identical to current text
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(200);
    expect(data.updatedCount).toBe(0);
  });

  it("invalidates koPreviewConfirmedAt/koreanEnabled only, not Japanese fields, when text changes", async () => {
    const slug = "ko-invalidate-scope";
    const { project } = await seedProject(slug, 2, { textJaSeed: () => "existing" });
    await prisma.project.update({
      where: { id: project.id },
      data: {
        koPreviewConfirmedAt: new Date(),
        koreanEnabled: true,
        jaPreviewConfirmedAt: new Date(),
        japaneseEnabled: true,
      },
    });
    await callBulk(slug, { adminToken: `token-${slug}`, lines: koLines(2) });
    const refreshed = await prisma.project.findUnique({ where: { id: project.id } });
    expect(refreshed?.koPreviewConfirmedAt).toBeNull();
    expect(refreshed?.koreanEnabled).toBe(false);
    expect(refreshed?.jaPreviewConfirmedAt).not.toBeNull();
    expect(refreshed?.japaneseEnabled).toBe(true);
  });

  it("rejects without a valid adminToken", async () => {
    const slug = "ko-auth";
    await seedProject(slug, 2);
    const { status } = await callBulk(slug, { adminToken: "wrong-token", lines: koLines(2) });
    expect(status).toBe(403);
  });

  it("rejects a non-array lines payload", async () => {
    const slug = "ko-bad-payload";
    await seedProject(slug, 2);
    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines: "not-an-array" });
    expect(status).toBe(400);
  });
});
