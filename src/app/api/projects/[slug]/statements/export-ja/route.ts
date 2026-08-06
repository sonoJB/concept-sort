import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { toCsvWithBom } from "@/lib/csv";

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

  const header = ["statementId", "order", "textKo", "textJa", "jaStatus"];
  const rows = statements.map((s) => [
    s.id,
    String(s.order),
    s.text,
    s.textJa ?? "",
    s.jaStatus,
  ]);

  const csv = toCsvWithBom([header, ...rows]);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}_statements_ja.csv"`,
    },
  });
}
