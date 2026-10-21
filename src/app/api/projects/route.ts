import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateAdminToken, generateSlug } from "@/lib/slug";
import { projectCreationAllowed } from "@/lib/projectCreation";

export async function POST(request: NextRequest) {
  if (!projectCreationAllowed()) {
    return NextResponse.json({ errorCode: "PROJECT_CREATION_DISABLED", error: "이 서버에서는 새 프로젝트 만들기가 꺼져 있습니다. 서버 설정(ALLOW_PROJECT_CREATION=1)으로만 켤 수 있습니다." }, { status: 403 });
  }
  const body = await request.json().catch(() => null);

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const statements: string[] = Array.isArray(body?.statements)
    ? body.statements
        .filter((s: unknown) => typeof s === "string")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)
    : [];

  if (!title) {
    return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  }
  if (statements.length < 2) {
    return NextResponse.json(
      { error: "진술문을 2개 이상 입력해 주세요." },
      { status: 400 }
    );
  }

  let slug = generateSlug();
  // Extremely unlikely collision, but guard anyway.
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await prisma.project.findUnique({ where: { slug } });
    if (!existing) break;
    slug = generateSlug();
  }

  const project = await prisma.project.create({
    data: {
      slug,
      adminToken: generateAdminToken(),
      title,
      prompt,
      statements: {
        create: statements.map((text, order) => ({ text, order })),
      },
    },
  });

  return NextResponse.json({
    slug: project.slug,
    adminToken: project.adminToken,
  });
}
