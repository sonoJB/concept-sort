import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;
  const mode = body?.mode;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  if (mode !== "selected" && mode !== "all") {
    return NextResponse.json({ error: "mode는 selected 또는 all만 허용됩니다." }, { status: 400 });
  }

  let targetSessionIds: string[];

  if (mode === "selected") {
    const rawIds = body?.sessionIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return NextResponse.json({ error: "삭제할 참여 기록을 선택해 주세요." }, { status: 400 });
    }
    const uniqueIds = [...new Set(rawIds.filter((id: unknown): id is string => typeof id === "string"))];
    if (uniqueIds.length !== rawIds.length && uniqueIds.length === 0) {
      return NextResponse.json({ error: "유효하지 않은 sessionId입니다." }, { status: 400 });
    }

    // Every id must belong to this project. Any id that's missing entirely
    // or belongs to another project rejects the whole request — no partial
    // deletion, and identity is checked by SortSession.id only (never by
    // participantName/phoneNumber).
    const owned = await prisma.sortSession.findMany({
      where: { id: { in: uniqueIds }, projectId: check.project.id },
      select: { id: true },
    });
    if (owned.length !== uniqueIds.length) {
      return NextResponse.json(
        { error: "선택한 참여 기록 중 이 프로젝트에 속하지 않거나 존재하지 않는 항목이 있습니다." },
        { status: 400 }
      );
    }
    targetSessionIds = uniqueIds;
  } else {
    const confirmation = typeof body?.confirmation === "string" ? body.confirmation : "";
    const expected = `${slug} 참여 기록 전체 삭제`;
    if (confirmation !== expected) {
      return NextResponse.json(
        { error: "확인 문구가 일치하지 않습니다." },
        { status: 400 }
      );
    }
    const all = await prisma.sortSession.findMany({
      where: { projectId: check.project.id },
      select: { id: true },
    });
    targetSessionIds = all.map((s) => s.id);
  }

  const result = await prisma.$transaction(async (tx) => {
    const expectedSessionCount = targetSessionIds.length;

    const groups = await tx.sortGroup.findMany({
      where: { sortSessionId: { in: targetSessionIds } },
      select: { id: true },
    });
    const groupIds = groups.map((g) => g.id);
    const expectedGroupCount = groupIds.length;

    const expectedItemCount = await tx.sortGroupItem.count({
      where: { groupId: { in: groupIds } },
    });

    const itemsDeleted = await tx.sortGroupItem.deleteMany({
      where: { groupId: { in: groupIds } },
    });
    if (itemsDeleted.count !== expectedItemCount) {
      throw new Error(
        `groupItem 삭제 개수 불일치: expected=${expectedItemCount} actual=${itemsDeleted.count}`
      );
    }

    const groupsDeleted = await tx.sortGroup.deleteMany({
      where: { id: { in: groupIds } },
    });
    if (groupsDeleted.count !== expectedGroupCount) {
      throw new Error(
        `group 삭제 개수 불일치: expected=${expectedGroupCount} actual=${groupsDeleted.count}`
      );
    }

    const sessionsDeleted = await tx.sortSession.deleteMany({
      where: { id: { in: targetSessionIds } },
    });
    if (sessionsDeleted.count !== expectedSessionCount) {
      throw new Error(
        `session 삭제 개수 불일치: expected=${expectedSessionCount} actual=${sessionsDeleted.count}`
      );
    }

    return {
      deletedSessions: sessionsDeleted.count,
      deletedGroups: groupsDeleted.count,
      deletedGroupItems: itemsDeleted.count,
    };
  });

  return NextResponse.json(result);
}
