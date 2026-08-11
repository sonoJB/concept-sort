import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Same DATABASE_URL-before-import pattern as the analysis integration tests:
// the route imports `@/lib/db`, which reads DATABASE_URL at PrismaClient
// construction time, so it must be set before that (or anything importing
// it) is imported.
const dbFile = path.join(
  os.tmpdir(),
  `concept-sort-bulk-ja-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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
const individualRoute = await import("../[statementId]/route");

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    // best-effort
  }
});

async function seedProject(slug: string, statementCount: number, textJaSeed?: (i: number) => string | null) {
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
          textJa: textJaSeed ? textJaSeed(i) : null,
        },
      })
    );
  }
  return { project, statements };
}

/** Builds N properly-numbered Japanese lines: "1. ja-0", "2. ja-1", ... */
function numberedJaLines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${i + 1}. ja-${i}`);
}

function bulkRequest(slug: string, body: unknown) {
  return new NextRequest(`http://localhost/api/projects/${slug}/statements/bulk-import-ja`, {
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

function koreanCanonicalHash(statements: { order: number; text: string }[]) {
  const canonical = [...statements]
    .sort((a, b) => a.order - b.order)
    .map((s) => `${s.order}|${s.text}`)
    .join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

describe("POST /api/projects/[slug]/statements/bulk-import-ja", () => {
  it("saves exactly N numbered lines with DRAFT status by default (case 1, 10)", async () => {
    const slug = "bulk-exact-n";
    const { project } = await seedProject(slug, 5);
    const lines = numberedJaLines(5);

    const { status, data } = await callBulk(slug, {
      adminToken: `token-${slug}`,
      lines,
      jaStatus: "DRAFT",
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.updatedCount).toBe(5);

    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    refreshed.forEach((s, i) => {
      expect(s.textJa).toBe(`${i + 1}. ja-${i}`);
      expect(s.jaStatus).toBe("DRAFT");
    });
  });

  it("rejects N-1 lines (case 2)", async () => {
    const slug = "bulk-n-minus-1";
    await seedProject(slug, 5);
    const lines = numberedJaLines(4);

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/일치하지 않습니다/);
  });

  it("rejects N+1 lines (case 3)", async () => {
    const slug = "bulk-n-plus-1";
    await seedProject(slug, 5);
    const lines = numberedJaLines(6);

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/일치하지 않습니다/);
  });

  it("rejects a blank line (case 4)", async () => {
    const slug = "bulk-blank-line";
    await seedProject(slug, 3);
    const lines = numberedJaLines(3);
    lines[1] = "";

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/비어 있습니다/);
  });

  it("rejects a whitespace-only line (case 5)", async () => {
    const slug = "bulk-whitespace-line";
    await seedProject(slug, 3);
    const lines = numberedJaLines(3);
    lines[2] = "   ";

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/비어 있습니다/);
  });

  it("rejects when statement order has duplicates, refusing to guess a mapping (case 6/7 adapted to actual FK/order design)", async () => {
    const slug = "bulk-dup-order";
    const { project } = await seedProject(slug, 0);
    // Deliberately create two statements sharing the same order value —
    // something the normal app flow never does, but the route must still
    // refuse to silently pick a mapping rather than guess.
    await prisma.statement.create({ data: { projectId: project.id, text: "1. a", order: 0 } });
    await prisma.statement.create({ data: { projectId: project.id, text: "2. b", order: 0 } });

    const { status, data } = await callBulk(slug, {
      adminToken: `token-${slug}`,
      lines: numberedJaLines(2),
      jaStatus: "DRAFT",
    });
    expect(status).toBe(409);
    expect(data.error).toMatch(/중복/);
  });

  it("does not require or trust client-supplied identifiers — mapping is derived server-side from order", async () => {
    // The API never accepts statementId/order from the client at all (unlike
    // the CSV import-ja route) — this test documents/locks that contract by
    // confirming a plain lines[] array with no id/order fields still maps
    // correctly by position.
    const slug = "bulk-no-client-ids";
    const { project, statements } = await seedProject(slug, 3);
    const lines = ["1. first", "2. second", "3. third"];
    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(200);
    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.textJa)).toEqual(["1. first", "2. second", "3. third"]);
    expect(refreshed.map((s) => s.id)).toEqual(statements.map((s) => s.id));
  });

  it("rejects an invalid jaStatus (case 8)", async () => {
    const slug = "bulk-invalid-status";
    await seedProject(slug, 2);
    const lines = numberedJaLines(2);

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "BOGUS" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/DRAFT, REVIEWING, APPROVED/);
  });

  it("rejects MISSING as an explicit bulk status", async () => {
    const slug = "bulk-missing-status";
    await seedProject(slug, 2);
    const lines = numberedJaLines(2);

    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "MISSING" });
    expect(status).toBe(400);
  });

  it("makes no DB changes when validation fails (atomicity, case 9)", async () => {
    const slug = "bulk-atomic-fail";
    const { project, statements } = await seedProject(slug, 3, (i) => (i === 0 ? "existing-ja" : null));
    const lines = [statements[0].text, "", "3. ja-2"]; // blank line -> reject

    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(400);

    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed[0].textJa).toBe("existing-ja");
    expect(refreshed[1].textJa).toBeNull();
    expect(refreshed[2].textJa).toBeNull();
  });

  it("saves REVIEWING status (case 11)", async () => {
    const slug = "bulk-reviewing";
    const { project } = await seedProject(slug, 2);
    const lines = numberedJaLines(2);

    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "REVIEWING" });
    expect(status).toBe(200);

    const refreshed = await prisma.statement.findMany({ where: { projectId: project.id } });
    refreshed.forEach((s) => expect(s.jaStatus).toBe("REVIEWING"));
  });

  it("rejects APPROVED without confirmApproved (case 12, part 1)", async () => {
    const slug = "bulk-approved-no-confirm";
    await seedProject(slug, 2);
    const lines = numberedJaLines(2);

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "APPROVED" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/confirmApproved/);
  });

  it("saves APPROVED when confirmApproved=true is explicitly sent (case 12, part 2)", async () => {
    const slug = "bulk-approved-confirmed";
    const { project } = await seedProject(slug, 2);
    const lines = numberedJaLines(2);

    const { status } = await callBulk(slug, {
      adminToken: `token-${slug}`,
      lines,
      jaStatus: "APPROVED",
      confirmApproved: true,
    });
    expect(status).toBe(200);

    const refreshed = await prisma.statement.findMany({ where: { projectId: project.id } });
    refreshed.forEach((s) => expect(s.jaStatus).toBe("APPROVED"));
  });

  it("never modifies Korean text/order — count and canonical hash unchanged (case 13)", async () => {
    const slug = "bulk-korean-protected";
    const { project, statements } = await seedProject(slug, 4);
    const hashBefore = koreanCanonicalHash(statements);

    const lines = numberedJaLines(4);
    await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });

    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.length).toBe(4);
    const hashAfter = koreanCanonicalHash(refreshed);
    expect(hashAfter).toBe(hashBefore);
    refreshed.forEach((s, i) => {
      expect(s.text).toBe(statements[i].text);
      expect(s.order).toBe(statements[i].order);
    });
  });

  it("individual editor PATCH still works after a bulk save (case 15)", async () => {
    const slug = "bulk-then-individual";
    const { project, statements } = await seedProject(slug, 2);
    await callBulk(slug, {
      adminToken: `token-${slug}`,
      lines: numberedJaLines(2),
      jaStatus: "DRAFT",
    });

    const target = statements[0];
    const req = new NextRequest(`http://localhost/api/projects/${slug}/statements/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({ adminToken: `token-${slug}`, textJa: "edited-individually", jaStatus: "DRAFT" }),
    });
    const res = await individualRoute.PATCH(req, {
      params: Promise.resolve({ slug, statementId: target.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.textJa).toBe("edited-individually");

    const check = await prisma.project.findUnique({ where: { id: project.id } });
    expect(check?.japaneseEnabled).toBe(false);
  });

  it("never auto-enables japaneseEnabled or sets jaPreviewConfirmedAt, even for APPROVED (case 16, 17)", async () => {
    const slug = "bulk-readiness-safety";
    const { project } = await seedProject(slug, 2);
    // Pre-set to a truthy state to prove the route actively resets it to
    // safe defaults rather than merely "not setting" an already-false value.
    await prisma.project.update({
      where: { id: project.id },
      data: { japaneseEnabled: true, jaPreviewConfirmedAt: new Date() },
    });

    const { status } = await callBulk(slug, {
      adminToken: `token-${slug}`,
      lines: numberedJaLines(2),
      jaStatus: "APPROVED",
      confirmApproved: true,
    });
    expect(status).toBe(200);

    const refreshedProject = await prisma.project.findUnique({ where: { id: project.id } });
    expect(refreshedProject?.japaneseEnabled).toBe(false);
    expect(refreshedProject?.jaPreviewConfirmedAt).toBeNull();
  });

  it("rejects without a valid adminToken", async () => {
    const slug = "bulk-auth";
    await seedProject(slug, 2);
    const { status } = await callBulk(slug, {
      adminToken: "wrong-token",
      lines: numberedJaLines(2),
      jaStatus: "DRAFT",
    });
    expect(status).toBe(403);
  });

  it("rejects a non-array lines payload", async () => {
    const slug = "bulk-bad-payload";
    await seedProject(slug, 2);
    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines: "not-an-array", jaStatus: "DRAFT" });
    expect(status).toBe(400);
  });

  // --- Numbering-is-content contract (new) ---

  it("stores the numbering prefix verbatim — never strips it (case 17)", async () => {
    const slug = "bulk-numbering-retained";
    const { project } = await seedProject(slug, 2);
    const lines = ["1. 文A", "2. 文B"];

    const { status } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(200);

    const refreshed = await prisma.statement.findMany({
      where: { projectId: project.id },
      orderBy: { order: "asc" },
    });
    expect(refreshed.map((s) => s.textJa)).toEqual(["1. 文A", "2. 文B"]);
  });

  it("rejects a line missing its number prefix (case 5 numbering)", async () => {
    const slug = "bulk-missing-number";
    await seedProject(slug, 3);
    const lines = numberedJaLines(3);
    lines[1] = "no number here";

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/2번째 줄은 '2\. '로 시작해야 합니다/);
  });

  it("rejects mismatched numbering (case 19)", async () => {
    const slug = "bulk-wrong-number";
    await seedProject(slug, 3);
    const lines = numberedJaLines(3);
    lines[2] = "5. ja-2"; // should be "3. "

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/3번째 줄은 '3\. '로 시작해야 합니다/);
  });

  it("rejects a number-only line with no content", async () => {
    const slug = "bulk-number-only";
    await seedProject(slug, 2);
    const lines = numberedJaLines(2);
    lines[0] = "1.";

    const { status, data } = await callBulk(slug, { adminToken: `token-${slug}`, lines, jaStatus: "DRAFT" });
    expect(status).toBe(400);
    expect(data.error).toMatch(/번호만 있고 내용이 없습니다/);
  });

  it("no longer supports automatic number stripping — the API has no such option (case 18)", async () => {
    // The route accepts only `lines`/`jaStatus`/`confirmApproved`/`adminToken`;
    // an extra client flag has no effect and numbering is always required.
    const slug = "bulk-no-strip-option";
    const { project } = await seedProject(slug, 2);
    const lines = numberedJaLines(2);

    const { status } = await callBulk(slug, {
      adminToken: `token-${slug}`,
      lines,
      jaStatus: "DRAFT",
      stripNumbering: true,
    });
    expect(status).toBe(200);

    const refreshed = await prisma.statement.findMany({ where: { projectId: project.id }, orderBy: { order: "asc" } });
    expect(refreshed.map((s) => s.textJa)).toEqual(["1. ja-0", "2. ja-1"]);
  });
});
