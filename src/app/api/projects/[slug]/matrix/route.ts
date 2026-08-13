import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { buildCooccurrenceMatrix } from "@/lib/similarity";
import { dataRolesForDataset, isValidDatasetMode, type DatasetMode } from "@/lib/analysis/dataset";

/**
 * Admin-only (gated by requireAdminProject above) matrix export. `dataset`
 * defaults to MAIN — this endpoint must never silently mean "every
 * SortSession including pilots" the way it used to before pilot/main
 * segregation existed. Explicit ALL_WITH_PILOT is required to get pilots
 * back in; an unrecognized value fails closed (422), never silently
 * falls back to "everything".
 */
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

  const datasetParam = request.nextUrl.searchParams.get("dataset") ?? "MAIN";
  if (!isValidDatasetMode(datasetParam)) {
    return NextResponse.json({ error: "dataset는 MAIN, PILOT, ALL_WITH_PILOT 중 하나여야 합니다." }, { status: 422 });
  }
  const dataset: DatasetMode = datasetParam;
  const allowedRoles = dataRolesForDataset(dataset);

  const [statements, sessions] = await Promise.all([
    prisma.statement.findMany({
      where: { projectId: check.project.id },
      orderBy: { order: "asc" },
    }),
    prisma.sortSession.findMany({
      where: { projectId: check.project.id, ...(allowedRoles ? { dataRole: { in: allowedRoles } } : {}) },
      include: { groups: { include: { items: true } } },
    }),
  ]);

  const statementIds = statements.map((s) => s.id);
  const sortedSessions = sessions.map((session) => ({
    groups: session.groups.map((group) => ({
      statementIds: group.items.map((item) => item.statementId),
    })),
  }));

  const matrix = buildCooccurrenceMatrix(statementIds, sortedSessions);

  return NextResponse.json({
    dataset,
    submissionCount: sessions.length,
    statements: statements.map((s, i) => ({ number: i + 1, text: s.text })),
    matrix,
  });
}
