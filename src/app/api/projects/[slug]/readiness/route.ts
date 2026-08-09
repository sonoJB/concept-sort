import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { computeLocaleContentStatus } from "@/lib/localeContentStatus";

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

  return NextResponse.json({ ko, ja });
}
