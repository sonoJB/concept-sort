import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { computeLocaleContentStatus, computeOperatingState } from "@/lib/localeContentStatus";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  const wantKorean =
    typeof body?.koreanEnabled === "boolean" ? body.koreanEnabled : check.project.koreanEnabled;
  const wantJapanese =
    typeof body?.japaneseEnabled === "boolean"
      ? body.japaneseEnabled
      : check.project.japaneseEnabled;

  const statements = await prisma.statement.findMany({
    where: { projectId: check.project.id },
    orderBy: { order: "asc" },
  });

  // Disabling a locale is always allowed; only *enabling* requires readiness.
  if (wantKorean && !check.project.koreanEnabled) {
    const status = computeLocaleContentStatus("ko", check.project, statements);
    if (!status.ready) {
      return NextResponse.json(
        { error: "한국어 콘텐츠가 아직 참여 활성화 조건을 충족하지 않았습니다.", reasons: status.reasons, status },
        { status: 400 }
      );
    }
  }
  if (wantJapanese && !check.project.japaneseEnabled) {
    const status = computeLocaleContentStatus("ja", check.project, statements);
    if (!status.ready) {
      return NextResponse.json(
        { error: "일본어 콘텐츠가 아직 참여 활성화 조건을 충족하지 않았습니다.", reasons: status.reasons, status },
        { status: 400 }
      );
    }
  }

  const project = await prisma.project.update({
    where: { id: check.project.id },
    data: { koreanEnabled: wantKorean, japaneseEnabled: wantJapanese },
  });

  return NextResponse.json({
    koreanEnabled: project.koreanEnabled,
    japaneseEnabled: project.japaneseEnabled,
    operatingState: computeOperatingState(project.koreanEnabled, project.japaneseEnabled),
  });
}
