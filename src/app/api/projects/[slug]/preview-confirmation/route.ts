import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { computeLocaleContentStatus } from "@/lib/localeContentStatus";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;
  const locale = body?.locale;
  const confirmed = body?.confirmed;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  if (locale !== "ko" && locale !== "ja") {
    return NextResponse.json({ error: "locale은 ko 또는 ja만 허용됩니다." }, { status: 400 });
  }
  if (typeof confirmed !== "boolean") {
    return NextResponse.json({ error: "confirmed는 boolean이어야 합니다." }, { status: 400 });
  }

  if (!confirmed) {
    const project =
      locale === "ko"
        ? await prisma.project.update({
            where: { id: check.project.id },
            data: { koPreviewConfirmedAt: null },
          })
        : await prisma.project.update({
            where: { id: check.project.id },
            data: { jaPreviewConfirmedAt: null },
          });
    return NextResponse.json({
      koPreviewConfirmedAt: project.koPreviewConfirmedAt,
      jaPreviewConfirmedAt: project.jaPreviewConfirmedAt,
    });
  }

  const statements = await prisma.statement.findMany({
    where: { projectId: check.project.id },
    orderBy: { order: "asc" },
  });

  // previewConfirmedAt itself isn't a precondition for confirming it —
  // everything else about the content still has to be complete.
  const status = computeLocaleContentStatus(locale, check.project, statements, {
    ignorePreviewConfirmation: true,
  });
  if (!status.ready) {
    return NextResponse.json(
      {
        error: "콘텐츠가 아직 완성되지 않아 미리보기를 확인 처리할 수 없습니다.",
        reasons: status.reasons,
        status,
      },
      { status: 400 }
    );
  }

  const now = new Date();
  const project =
    locale === "ko"
      ? await prisma.project.update({
          where: { id: check.project.id },
          data: { koPreviewConfirmedAt: now },
        })
      : await prisma.project.update({
          where: { id: check.project.id },
          data: { jaPreviewConfirmedAt: now },
        });

  return NextResponse.json({
    koPreviewConfirmedAt: project.koPreviewConfirmedAt,
    jaPreviewConfirmedAt: project.jaPreviewConfirmedAt,
  });
}
