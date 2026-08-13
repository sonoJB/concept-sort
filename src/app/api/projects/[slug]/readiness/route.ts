import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { computeLocaleContentStatus } from "@/lib/localeContentStatus";
import { classifySubmissionDataRole } from "@/lib/classifySubmissionDataRole";

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

  const statements = await prisma.statement.findMany({
    where: { projectId: check.project.id },
    orderBy: { order: "asc" },
  });

  const ko = computeLocaleContentStatus("ko", check.project, statements);
  const ja = computeLocaleContentStatus("ja", check.project, statements);

  const sessions = await prisma.sortSession.findMany({
    where: { projectId: check.project.id },
    select: { dataRole: true, countryCode: true },
  });
  const counts = {
    total: sessions.length,
    main: sessions.filter((s) => s.dataRole === "MAIN").length,
    pilot: sessions.filter((s) => s.dataRole === "PILOT").length,
    krMain: sessions.filter((s) => s.dataRole === "MAIN" && s.countryCode === "KR").length,
    krPilot: sessions.filter((s) => s.dataRole === "PILOT" && s.countryCode === "KR").length,
    jpMain: sessions.filter((s) => s.dataRole === "MAIN" && s.countryCode === "JP").length,
    jpPilot: sessions.filter((s) => s.dataRole === "PILOT" && s.countryCode === "JP").length,
  };

  const serverNow = new Date();
  const currentPhase = classifySubmissionDataRole({
    receivedAt: serverNow,
    mainStudyStartsAt: check.project.mainStudyStartsAt,
  });

  return NextResponse.json({
    ko,
    ja,
    counts,
    currentPhase,
    serverNow: serverNow.toISOString(),
    mainStudyStartsAt: check.project.mainStudyStartsAt?.toISOString() ?? null,
    guideVideoUrlKo: check.project.guideVideoUrlKo,
    guideVideoUrlJa: check.project.guideVideoUrlJa,
  });
}
