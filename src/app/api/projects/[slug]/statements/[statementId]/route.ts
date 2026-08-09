import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { isValidJaStatus } from "@/lib/localeContentStatus";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; statementId: string }> }
) {
  const { slug, statementId } = await params;
  const body = await request.json().catch(() => null);
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  const statement = await prisma.statement.findFirst({
    where: { id: statementId, projectId: check.project.id },
  });
  if (!statement) {
    return NextResponse.json(
      { error: "해당 프로젝트에 속한 진술문이 아닙니다." },
      { status: 404 }
    );
  }

  const hasTextJa = Object.prototype.hasOwnProperty.call(body, "textJa");
  const rawTextJa = hasTextJa ? body.textJa : undefined;
  if (hasTextJa && rawTextJa !== null && typeof rawTextJa !== "string") {
    return NextResponse.json({ error: "textJa 형식이 올바르지 않습니다." }, { status: 400 });
  }
  const nextTextJa = hasTextJa
    ? (typeof rawTextJa === "string" ? rawTextJa.trim() : "") || null
    : statement.textJa;

  const hasJaStatus = Object.prototype.hasOwnProperty.call(body, "jaStatus");
  let nextJaStatus = hasJaStatus ? body.jaStatus : statement.jaStatus;

  if (hasJaStatus && !isValidJaStatus(nextJaStatus)) {
    return NextResponse.json(
      { error: "jaStatus는 MISSING, DRAFT, REVIEWING, APPROVED 중 하나여야 합니다." },
      { status: 400 }
    );
  }

  const textChanged = hasTextJa && nextTextJa !== statement.textJa;

  if (!nextTextJa) {
    nextJaStatus = "MISSING";
  } else if (textChanged) {
    nextJaStatus = "DRAFT";
  }

  if (nextJaStatus === "APPROVED" && !nextTextJa) {
    return NextResponse.json(
      { error: "textJa가 비어 있는 상태에서는 APPROVED로 저장할 수 없습니다." },
      { status: 400 }
    );
  }

  const [updated] = await prisma.$transaction([
    prisma.statement.update({
      where: { id: statement.id },
      data: { textJa: nextTextJa, jaStatus: nextJaStatus },
    }),
    prisma.project.update({
      where: { id: check.project.id },
      data: { jaPreviewConfirmedAt: null, japaneseEnabled: false },
    }),
  ]);

  return NextResponse.json({
    id: updated.id,
    textJa: updated.textJa,
    jaStatus: updated.jaStatus,
  });
}
