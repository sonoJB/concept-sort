import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateAdminToken, generateSlug } from "@/lib/slug";

export async function POST(request: NextRequest) {
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
