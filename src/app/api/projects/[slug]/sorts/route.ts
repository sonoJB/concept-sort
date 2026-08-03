import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const project = await prisma.project.findUnique({ where: { slug } });
  if (!project) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  const submissionCount = await prisma.sortSession.count({
    where: { projectId: project.id },
  });

  return NextResponse.json({ submissionCount });
}

type IncomingGroup = { label?: string; statementIds: string[] };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);

  const participantName =
    typeof body?.participantName === "string" && body.participantName.trim()
      ? body.participantName.trim()
      : "익명 참가자";

  const groups: IncomingGroup[] = Array.isArray(body?.groups) ? body.groups : [];
  const nonEmptyGroups = groups.filter(
    (g) => Array.isArray(g.statementIds) && g.statementIds.length > 0
  );

  if (nonEmptyGroups.length === 0) {
    return NextResponse.json(
      { error: "최소 1개 이상의 그룹에 카드를 배치해 주세요." },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { statements: true },
  });
  if (!project) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  const validStatementIds = new Set(project.statements.map((s) => s.id));
  for (const group of nonEmptyGroups) {
    for (const id of group.statementIds) {
      if (!validStatementIds.has(id)) {
        return NextResponse.json(
          { error: "유효하지 않은 진술문이 포함되어 있습니다." },
          { status: 400 }
        );
      }
    }
  }

  await prisma.sortSession.create({
    data: {
      projectId: project.id,
      participantName,
      groups: {
        create: nonEmptyGroups.map((g) => ({
          label: g.label?.trim() ?? "",
          items: {
            create: g.statementIds.map((statementId) => ({ statementId })),
          },
        })),
      },
    },
  });

  return NextResponse.json({ ok: true });
}
