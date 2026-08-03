import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }
  if (!text) {
    return NextResponse.json({ error: "진술문 내용을 입력해 주세요." }, { status: 400 });
  }

  const count = await prisma.statement.count({ where: { projectId: check.project.id } });
  const statement = await prisma.statement.create({
    data: { projectId: check.project.id, text, order: count },
  });

  return NextResponse.json({ id: statement.id, text: statement.text });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const statementId = typeof body?.statementId === "string" ? body.statementId : null;
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }
  if (!statementId) {
    return NextResponse.json({ error: "statementId가 필요합니다." }, { status: 400 });
  }

  await prisma.statement.deleteMany({
    where: { id: statementId, projectId: check.project.id },
  });

  return NextResponse.json({ ok: true });
}
