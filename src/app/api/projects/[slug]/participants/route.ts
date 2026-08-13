import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";

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
      orderBy: { createdAt: "asc" },
      include: { groups: { include: { items: true } } },
    }),
  ]);

  const numberByStatementId = new Map(statements.map((s, i) => [s.id, i + 1]));

  const participants = sessions.map((session) => ({
    id: session.id,
    countryCode: session.countryCode,
    dataRole: session.dataRole,
    participantName: session.participantName,
    consentAgreed: session.consentAgreed,
    gender: session.gender,
    age: session.age,
    schoolLevel: session.schoolLevel,
    grade: session.grade,
    phoneNumber: session.phoneNumber,
    submittedAt: session.createdAt.toISOString(),
    groups: session.groups.map((g) => ({
      label: g.label,
      statementNumbers: g.items
        .map((item) => numberByStatementId.get(item.statementId))
        .filter((n): n is number => n !== undefined)
        .sort((a, b) => a - b),
    })),
  }));

  return NextResponse.json({ participants });
}
