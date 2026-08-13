import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { validateNonBlankLines } from "@/lib/statementLines";

/**
 * Bulk paste-in entry/update for Korean statements: one authenticated
 * request replaces the `text` of every statement in the project (mapping
 * input line N to the Nth statement by order), or — only when the project
 * currently has zero statements — creates N new statements in the entered
 * sequence. Existing statement IDs/order/textJa/jaStatus are always
 * preserved; only `text` changes, and only for rows whose text actually
 * differs from the incoming line.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;
  const lines = Array.isArray(body?.lines) ? body.lines : null;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  if (!lines || lines.some((l: unknown) => typeof l !== "string")) {
    return NextResponse.json({ error: "lines 배열이 필요합니다." }, { status: 400 });
  }

  const trimmed: string[] = lines.map((l: string) => l.trim());

  const lineCheck = validateNonBlankLines(trimmed);
  if (!lineCheck.ok) {
    return NextResponse.json({ error: lineCheck.error }, { status: 400 });
  }

  const statements = await prisma.statement.findMany({
    where: { projectId: check.project.id },
    orderBy: { order: "asc" },
  });

  if (statements.length === 0) {
    // Zero-statement project: create N statements in the entered sequence.
    if (trimmed.length === 0) {
      return NextResponse.json({ ok: true, createdCount: 0, updatedCount: 0, statements: [] });
    }

    const created = await prisma.$transaction([
      ...trimmed.map((text, i) =>
        prisma.statement.create({
          data: { projectId: check.project.id, text, order: i },
        })
      ),
      prisma.project.update({
        where: { id: check.project.id },
        data: { koPreviewConfirmedAt: null, koreanEnabled: false },
      }),
    ]);

    const createdStatements = created.slice(0, trimmed.length) as Awaited<
      ReturnType<typeof prisma.statement.create>
    >[];

    return NextResponse.json({
      ok: true,
      createdCount: createdStatements.length,
      updatedCount: 0,
      statements: createdStatements.map((s) => ({ id: s.id, order: s.order, text: s.text })),
    });
  }

  const orders = new Set(statements.map((s) => s.order));
  if (orders.size !== statements.length) {
    return NextResponse.json(
      { error: "진술문 순서(order)에 중복이 있어 안전하게 매핑할 수 없습니다." },
      { status: 409 }
    );
  }

  if (trimmed.length !== statements.length) {
    return NextResponse.json(
      {
        error: `입력된 줄 수(${trimmed.length})가 현재 진술문 수(${statements.length})와 일치하지 않습니다.`,
      },
      { status: 400 }
    );
  }

  const toUpdate = statements
    .map((statement, i) => ({ id: statement.id, order: statement.order, text: trimmed[i] }))
    .filter((u, i) => u.text !== statements[i].text);

  if (toUpdate.length === 0) {
    return NextResponse.json({
      ok: true,
      createdCount: 0,
      updatedCount: 0,
      statements: statements.map((s) => ({ id: s.id, order: s.order, text: s.text })),
    });
  }

  const [, ...updated] = await prisma.$transaction([
    prisma.project.update({
      where: { id: check.project.id },
      data: { koPreviewConfirmedAt: null, koreanEnabled: false },
    }),
    ...toUpdate.map((u) =>
      prisma.statement.update({
        where: { id: u.id },
        data: { text: u.text },
      })
    ),
  ]);

  return NextResponse.json({
    ok: true,
    createdCount: 0,
    updatedCount: updated.length,
    statements: (updated as Awaited<ReturnType<typeof prisma.statement.update>>[]).map((s) => ({
      id: s.id,
      order: s.order,
      text: s.text,
    })),
  });
}
