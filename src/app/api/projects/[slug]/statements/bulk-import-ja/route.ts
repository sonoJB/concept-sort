import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { isValidJaStatus } from "@/lib/localeContentStatus";
import { validateNumberedLines } from "@/lib/statementNumbering";

/**
 * Bulk paste-in entry for Japanese translations: replaces textJa/jaStatus
 * for every statement in the project in one request, mapping input line N
 * to the Nth statement by order (not by client-supplied statementId — the
 * server re-derives the mapping from its own order-sorted read). This is
 * distinct from the CSV import-ja route, which requires per-row statementId
 * and always forces DRAFT on content change; this route lets an admin
 * explicitly choose APPROVED for a first-pass bulk entry, gated by
 * confirmApproved.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;
  const lines = Array.isArray(body?.lines) ? body.lines : null;
  const jaStatus = body?.jaStatus;
  const confirmApproved = body?.confirmApproved === true;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  if (!lines || lines.some((l: unknown) => typeof l !== "string")) {
    return NextResponse.json({ error: "lines 배열이 필요합니다." }, { status: 400 });
  }
  if (!isValidJaStatus(jaStatus) || jaStatus === "MISSING") {
    return NextResponse.json(
      { error: "jaStatus는 DRAFT, REVIEWING, APPROVED 중 하나여야 합니다." },
      { status: 400 }
    );
  }
  if (jaStatus === "APPROVED" && !confirmApproved) {
    return NextResponse.json(
      { error: "APPROVED로 저장하려면 confirmApproved 확인이 필요합니다." },
      { status: 400 }
    );
  }

  const trimmed: string[] = lines.map((l: string) => l.trim());

  const numberingCheck = validateNumberedLines(trimmed);
  if (!numberingCheck.ok) {
    return NextResponse.json({ error: numberingCheck.error }, { status: 400 });
  }

  const statements = await prisma.statement.findMany({
    where: { projectId: check.project.id },
    orderBy: { order: "asc" },
  });

  if (trimmed.length !== statements.length) {
    return NextResponse.json(
      {
        error: `입력된 줄 수(${trimmed.length})가 현재 진술문 수(${statements.length})와 일치하지 않습니다.`,
      },
      { status: 400 }
    );
  }

  const orders = new Set(statements.map((s) => s.order));
  if (orders.size !== statements.length) {
    return NextResponse.json(
      { error: "진술문 순서(order)에 중복이 있어 안전하게 매핑할 수 없습니다." },
      { status: 409 }
    );
  }

  const updates = statements.map((statement, i) => ({
    id: statement.id,
    order: statement.order,
    textJa: trimmed[i],
  }));

  const [, ...updated] = await prisma.$transaction([
    prisma.project.update({
      where: { id: check.project.id },
      data: { jaPreviewConfirmedAt: null, japaneseEnabled: false },
    }),
    ...updates.map((u) =>
      prisma.statement.update({
        where: { id: u.id },
        data: { textJa: u.textJa, jaStatus },
      })
    ),
  ]);

  return NextResponse.json({
    ok: true,
    updatedCount: updated.length,
    statements: updated.map((s) => ({ id: s.id, order: s.order, textJa: s.textJa, jaStatus: s.jaStatus })),
  });
}
