import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";

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

  const raw = body?.mainStudyStartsAt;
  let mainStudyStartsAt: Date | null;
  if (raw === null || raw === "") {
    mainStudyStartsAt = null;
  } else if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "본조사 시작 일시 형식이 올바르지 않습니다." }, { status: 400 });
    }
    mainStudyStartsAt = parsed;
  } else {
    return NextResponse.json({ error: "본조사 시작 일시 형식이 올바르지 않습니다." }, { status: 400 });
  }

  // Once any MAIN response exists, moving the boundary would retroactively
  // contradict how already-stored rows were classified — lock it instead of
  // allowing a casual override. Disabling/removing the boundary is subject
  // to the exact same lock: it's still a change to the classification rule.
  const mainCount = await prisma.sortSession.count({
    where: { projectId: check.project.id, dataRole: "MAIN" },
  });
  if (mainCount > 0) {
    return NextResponse.json(
      { error: "본조사 응답이 이미 저장되어 있어 시작 일시를 변경할 수 없습니다." },
      { status: 409 }
    );
  }

  const project = await prisma.project.update({
    where: { id: check.project.id },
    data: { mainStudyStartsAt },
  });

  return NextResponse.json({ mainStudyStartsAt: project.mainStudyStartsAt?.toISOString() ?? null });
}
