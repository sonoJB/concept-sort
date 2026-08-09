import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";

/** Trims a possibly-absent string field; returns undefined when the key was not sent at all. */
function trimIfString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;
  const locale = body?.locale;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  if (locale !== "ko" && locale !== "ja") {
    return NextResponse.json(
      { error: "locale은 ko 또는 ja만 허용됩니다." },
      { status: 400 }
    );
  }

  const title = trimIfString(body?.title);
  const prompt = trimIfString(body?.prompt);
  const consent = trimIfString(body?.consent);

  if (locale === "ko") {
    if (title !== undefined && title.length === 0) {
      return NextResponse.json(
        { error: "한국어 제목은 비워둘 수 없습니다." },
        { status: 400 }
      );
    }

    const project = await prisma.project.update({
      where: { id: check.project.id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(consent !== undefined ? { consentKo: consent.length > 0 ? consent : null } : {}),
        koPreviewConfirmedAt: null,
        // Editing content the moment it's live is exactly the case that must
        // pull participation back offline until the admin re-confirms it.
        koreanEnabled: false,
      },
    });

    return NextResponse.json({
      title: project.title,
      prompt: project.prompt,
      consentKo: project.consentKo,
      koPreviewConfirmedAt: project.koPreviewConfirmedAt,
      koreanEnabled: project.koreanEnabled,
    });
  }

  // ja — titleJa may be null (research content still in progress)
  const project = await prisma.project.update({
    where: { id: check.project.id },
    data: {
      ...(title !== undefined ? { titleJa: title.length > 0 ? title : null } : {}),
      ...(prompt !== undefined ? { promptJa: prompt.length > 0 ? prompt : null } : {}),
      ...(consent !== undefined ? { consentJa: consent.length > 0 ? consent : null } : {}),
      jaPreviewConfirmedAt: null,
      japaneseEnabled: false,
    },
  });

  return NextResponse.json({
    titleJa: project.titleJa,
    promptJa: project.promptJa,
    consentJa: project.consentJa,
    jaPreviewConfirmedAt: project.jaPreviewConfirmedAt,
    japaneseEnabled: project.japaneseEnabled,
  });
}
