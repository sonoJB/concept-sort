import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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
          text: `${i + 1}. korean-${i}`,
          order: i,
          textJa: opts?.textJaSeed ? opts.textJaSeed(i) : null,
          jaStatus: opts?.jaStatusSeed ? opts.jaStatusSeed(i) : "MISSING",
        },
      })
    );
  }
  return { project, statements };
}

function numberedKoLines(n: number, prefix = "korean-updated"): string[] {
  return Array.from({ length: n }, (_, i) => `${i + 1}. ${prefix}-${i}`);
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
  it("saves exactly N valid numbered lines (case 1)", async () => {
    const slug = "ko-exact-n";
    const { project } = await seedProject(slug, 5);
    const lines = numberedKoLines(5);

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.updatedCount).toBe(5);

    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    refreshed.forEach((s, i) => expect(s.text).toBe(`${i + 1}. korean-updated-${i}`));
  });

  it("rejects N-1 lines (case 2)", async () => {
    const slug = "ko-n-minus-1";
    await seedProject(slug, 5);
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines: numberedKoLines(4) });
    expect(status).toBe(400);
    expect(data.error).toMatch(/일치하지 않습니다/);
  });

  it("rejects N+1 lines (case 3)", async () => {
    const slug = "ko-n-plus-1";
    await seedProject(slug, 5);
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines: numberedKoLines(6) });
    expect(status).toBe(400);
    expect(data.error).toMatch(/일치하지 않습니다/);
  });

  it("rejects a blank line (case 4)", async () => {
    const slug = "ko-blank-line";
    await seedProject(slug, 3);
    const lines = numberedKoLines(3);
    lines[1] = "";
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    expect(data.error).toMatch(/비어 있습니다/);
  });

  it("rejects a missing '1.' prefix (case 5)", async () => {
    const slug = "ko-missing-one";
    await seedProject(slug, 3);
    const lines = numberedKoLines(3);
    lines[0] = "no prefix";
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    expect(data.error).toMatch(/1번째 줄은 '1\. '로 시작해야 합니다/);
  });

  it("rejects a wrong line number (case 6)", async () => {
    const slug = "ko-wrong-number";
    await seedProject(slug, 3);
    const lines = numberedKoLines(3);
    lines[1] = "5. wrong";
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    expect(data.error).toMatch(/2번째 줄은 '2\. '로 시작해야 합니다/);
  });

  it("rejects duplicate numbering (case 7)", async () => {
    const slug = "ko-dup-number";
    await seedProject(slug, 3);
    const lines = ["1. a", "1. b", "3. c"];
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    expect(data.error).toMatch(/2번째 줄은 '2\. '로 시작해야 합니다/);
  });

  it("rejects skipped numbering (case 8)", async () => {
    const slug = "ko-skip-number";
    await seedProject(slug, 3);
    const lines = ["1. a", "3. b", "4. c"];
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    expect(data.error).toMatch(/2번째 줄은 '2\. '로 시작해야 합니다/);
  });

  it("rejects a number-only line with no content (case 9)", async () => {
    const slug = "ko-number-only";
    await seedProject(slug, 2);
    const lines = numberedKoLines(2);
    lines[1] = "2.";
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(400);
    expect(data.error).toMatch(/번호만 있고 내용이 없습니다/);
  });

  it("preserves Statement IDs after bulk edit (case 10)", async () => {
    const slug = "ko-ids-preserved";
    const { project, statements } = await seedProject(slug, 4);
    await callBulk(slug, { adminToken: `token-${slug}`, lines: numberedKoLines(4) });
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.id)).toEqual(statements.map((s) => s.id));
  });

  it("preserves Statement.order after bulk edit (case 11)", async () => {
    const slug = "ko-order-preserved";
    const { project, statements } = await seedProject(slug, 4);
    await callBulk(slug, { adminToken: `token-${slug}`, lines: numberedKoLines(4) });
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.order)).toEqual(statements.map((s) => s.order));
  });

  it("never touches textJa/jaStatus during Korean bulk save (case 12)", async () => {
    const slug = "ko-ja-untouched";
    const { project } = await seedProject(slug, 3, {
      textJaSeed: (i) => `${i + 1}. existing-ja-${i}`,
      jaStatusSeed: () => "APPROVED",
    });
    await callBulk(slug, { adminToken: `token-${slug}`, lines: numberedKoLines(3) });
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    refreshed.forEach((s, i) => {
      expect(s.textJa).toBe(`${i + 1}. existing-ja-${i}`);
      expect(s.jaStatus).toBe("APPROVED");
    });
  });

  it("rolls back entirely on validation failure — no partial writes (case 13)", async () => {
    const slug = "ko-atomic-fail";
    const { project, statements } = await seedProject(slug, 3);
    const lines = [statements[0].text, "", "3. x"]; // blank -> reject
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
    const lines = numberedKoLines(3, "new");
    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines });
    expect(status).toBe(200);
    expect(data.createdCount).toBe(3);

    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.length).toBe(3);
    refreshed.forEach((s, i) => {
      expect(s.text).toBe(`${i + 1}. new-${i}`);
      expect(s.order).toBe(i);
    });
  });

  it("does NOT delete/recreate Statements for an existing (non-zero) project — mapping is by position only (case 16)", async () => {
    const slug = "ko-existing-not-recreated";
    const { project, statements } = await seedProject(slug, 3);
    const idsBefore = statements.map((s) => s.id);
    await callBulk(slug, { adminToken: `token-${slug}`, lines: numberedKoLines(3) });
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
    await callBulk(slug, { adminToken: `token-${slug}`, lines: numberedKoLines(2) });
    const refreshed = await prisma.project.findUnique({ where: { id: project.id } });
    expect(refreshed?.koPreviewConfirmedAt).toBeNull();
    expect(refreshed?.koreanEnabled).toBe(false);
    expect(refreshed?.jaPreviewConfirmedAt).not.toBeNull();
    expect(refreshed?.japaneseEnabled).toBe(true);
  });

  it("rejects without a valid adminToken", async () => {
    const slug = "ko-auth";
    await seedProject(slug, 2);
    const { status } = await callBulk(slug, { adminToken: "wrong-token", lines: numberedKoLines(2) });
    expect(status).toBe(403);
  });

  it("rejects a non-array lines payload", async () => {
    const slug = "ko-bad-payload";
    await seedProject(slug, 2);
    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines: "not-an-array" });
    expect(status).toBe(400);
  });

  it("stores the numbering prefix verbatim in Korean text", async () => {
    const slug = "ko-numbering-retained";
    const { project } = await seedProject(slug, 2);
    const lines = ["1. 한글A", "2. 한글B"];
    await callBulk(slug, { adminToken: `token-${slug}`, lines });
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.text)).toEqual(["1. 한글A", "2. 한글B"]);
  });
});
