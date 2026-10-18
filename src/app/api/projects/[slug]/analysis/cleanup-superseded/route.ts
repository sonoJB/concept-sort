import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { DEFAULT_ANALYSIS_PARAMETERS } from "@/lib/analysis/config";
import { removePackageFileIfUnreferenced } from "@/lib/analysis/packageStore";

/**
 * Deletes DERIVED analysis results produced by an earlier (superseded) algorithm version: AnalysisRun rows and
 * only what hangs off them (dimensions, interpretations + labels, locks, packages — all ON DELETE CASCADE from
 * AnalysisRun). Raw participant data (Project, Statement, SortSession, SortGroup, SortGroupItem) has no foreign
 * key pointing at AnalysisRun and is never touched. Refuses unless every scope already has a COMPLETED,
 * current-version MAIN run with an attached package, so the screen can never be left without a verified result.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const body = await request.json().catch(() => null);
  if (body?.confirm !== "DELETE_SUPERSEDED_DERIVED_RESULTS") return NextResponse.json({ errorCode: "CONFIRMATION_REQUIRED" }, { status: 422 });
  const current = DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion;
  for (const scope of ["KR", "JP", "ALL"]) {
    const ok = await prisma.analysisRun.findFirst({
      where: { projectId: check.project.id, scope, dataset: "MAIN", algorithmVersion: current, executionStatus: "COMPLETED", packages: { some: {} } },
    });
    if (!ok) return NextResponse.json({ errorCode: "CURRENT_RESULT_MISSING", scope }, { status: 409 });
  }
  const targets = await prisma.analysisRun.findMany({
    where: { projectId: check.project.id, algorithmVersion: { not: current } },
    select: { id: true, scope: true, algorithmVersion: true, dataset: true, startedAt: true, executionStatus: true },
  });
  const count = async () => ({
    runs: await prisma.analysisRun.count(),
    dimensions: await prisma.analysisRunDimension.count(),
    interpretations: await prisma.analysisInterpretation.count(),
    clusterLabels: await prisma.analysisClusterLabel.count(),
    packages: await prisma.analysisPackage.count(),
  });
  const before = await count();
  const files = await prisma.analysisPackage.findMany({ where: { analysisRunId: { in: targets.map((t) => t.id) } }, select: { storedFile: true } });
  const result = await prisma.analysisRun.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } });
  for (const f of files) removePackageFileIfUnreferenced(f.storedFile, (await prisma.analysisPackage.count({ where: { storedFile: f.storedFile } })) > 0);
  const after = await count();
  return NextResponse.json({
    deletedRuns: result.count,
    deleted: targets.map((t) => ({ id: t.id, scope: t.scope, algorithmVersion: t.algorithmVersion, dataset: t.dataset, startedAt: t.startedAt.toISOString(), executionStatus: t.executionStatus })),
    before,
    after,
  });
}
