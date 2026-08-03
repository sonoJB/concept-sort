import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { buildCooccurrenceMatrix } from "@/lib/similarity";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const adminToken = request.nextUrl.searchParams.get("token");

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  const [statements, sessions] = await Promise.all([
    prisma.statement.findMany({
      where: { projectId: check.project.id },
      orderBy: { order: "asc" },
    }),
    prisma.sortSession.findMany({
      where: { projectId: check.project.id },
      include: { groups: { include: { items: true } } },
    }),
  ]);

  const statementIds = statements.map((s) => s.id);
  const sortedSessions = sessions.map((session) => ({
    groups: session.groups.map((group) => ({
      statementIds: group.items.map((item) => item.statementId),
    })),
  }));

  const matrix = buildCooccurrenceMatrix(statementIds, sortedSessions);

  return NextResponse.json({
    submissionCount: sessions.length,
    statements: statements.map((s, i) => ({ number: i + 1, text: s.text })),
    matrix,
  });
}
