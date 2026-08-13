import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { validateGuideVideoUrl } from "@/lib/guideVideoUrl";

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
    return NextResponse.json({ error: "locale은 ko 또는 ja만 허용됩니다." }, { status: 400 });
  }

  const validation = validateGuideVideoUrl(body?.url);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // A video-guide link is not statistical study content — unlike
  // guideTemplateKo/Ja and title/prompt/consent edits, updating it does not
  // reset koreanEnabled/japaneseEnabled or the preview-confirmation state.
  const project = await prisma.project.update({
    where: { id: check.project.id },
    data:
      locale === "ko"
        ? { guideVideoUrlKo: validation.normalized }
        : { guideVideoUrlJa: validation.normalized },
  });

  return NextResponse.json({
    guideVideoUrlKo: project.guideVideoUrlKo,
    guideVideoUrlJa: project.guideVideoUrlJa,
  });
}
