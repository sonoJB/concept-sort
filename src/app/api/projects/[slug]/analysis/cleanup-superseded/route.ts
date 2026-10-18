import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { removePackageFileIfUnreferenced } from "@/lib/analysis/packageStore";
import { CLEANUP_DATASET, CLEANUP_SCOPES, ERRONEOUS_ALGORITHM_VERSIONS, listCleanupTargets, verifyCurrentResults } from "@/lib/analysis/cleanupGuard";

/**
 * Replacement of analysis results found to be erroneous — deliberately narrow.
 *
 * Eligible: AnalysisRun rows with dataset = MAIN, scope in KR/JP/ALL and an algorithm version that is explicitly listed
 * as erroneous (ERRONEOUS_ALGORITHM_VERSIONS), plus what hangs off them through ON DELETE CASCADE (dimensions,
 * interpretations + labels, lock, packages). Pilot, check-up (ALL_WITH_PILOT), legacy and any other run is never
 * eligible, and "not the current version" is not a criterion. Raw participant tables have no foreign key to
 * AnalysisRun and are verified unchanged (counts) inside the same transaction.
 *
 * GET  = dry run: lists the exact targets, their counts and whether the preconditions hold. Nothing is deleted.
 * POST = needs {confirm, algorithmVersions, runIds}; runIds must equal the listed target set exactly, and the
 *        preconditions (converged current results for all three scopes, package file present + SHA-256 + full
 *        manifest check, consistent data across scopes) must hold at that moment.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const targets = await listCleanupTargets(prisma, check.project.id);
  const preconditions = await verifyCurrentResults(prisma, check.project.id);
  return NextResponse.json({ dryRun: true, eligible: { dataset: CLEANUP_DATASET, scopes: CLEANUP_SCOPES, algorithmVersions: ERRONEOUS_ALGORITHM_VERSIONS }, targets, targetCount: targets.length, preconditions });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const body = await request.json().catch(() => null);
  if (body?.confirm !== "DELETE_SUPERSEDED_DERIVED_RESULTS") return NextResponse.json({ errorCode: "CONFIRMATION_REQUIRED" }, { status: 422 });
  const versions: unknown = body?.algorithmVersions;
  if (!Array.isArray(versions) || [...versions].sort().join() !== [...ERRONEOUS_ALGORITHM_VERSIONS].sort().join()) {
    return NextResponse.json({ errorCode: "ALGORITHM_VERSIONS_MUST_BE_EXPLICIT", expected: ERRONEOUS_ALGORITHM_VERSIONS }, { status: 422 });
  }
  const targets = await listCleanupTargets(prisma, check.project.id);
  const wanted: unknown = body?.runIds;
  const ids = targets.map((t) => t.id).sort();
  if (!Array.isArray(wanted) || [...wanted].map(String).sort().join() !== ids.join()) {
    return NextResponse.json({ errorCode: "RUN_IDS_DO_NOT_MATCH_ELIGIBLE_TARGETS", eligibleRunIds: ids }, { status: 409 });
  }
  if (targets.length === 0) return NextResponse.json({ deletedRuns: 0, deleted: [], note: "nothing eligible" });
  const preconditions = await verifyCurrentResults(prisma, check.project.id);
  if (!preconditions.ok) return NextResponse.json({ errorCode: "PRECONDITIONS_NOT_MET", preconditions }, { status: 409 });

  const projectId = check.project.id;
  const counts = async (tx: typeof prisma) => ({
    sessions: await tx.sortSession.count(),
    groups: await tx.sortGroup.count(),
    items: await tx.sortGroupItem.count(),
    statements: await tx.statement.count(),
    projects: await tx.project.count(),
    runsTotal: await tx.analysisRun.count(),
    runsOutsideTargets: await tx.analysisRun.count({ where: { id: { notIn: ids } } }),
    packagesOutsideTargets: await tx.analysisPackage.count({ where: { analysisRunId: { notIn: ids } } }),
  });
  const files = await prisma.analysisPackage.findMany({ where: { analysisRunId: { in: ids } }, select: { storedFile: true } });
  const result = await prisma.$transaction(async (tx) => {
    const before = await counts(tx as unknown as typeof prisma);
    const del = await tx.analysisRun.deleteMany({ where: { id: { in: ids }, projectId, dataset: CLEANUP_DATASET, scope: { in: [...CLEANUP_SCOPES] }, algorithmVersion: { in: [...ERRONEOUS_ALGORITHM_VERSIONS] } } });
    const after = await counts(tx as unknown as typeof prisma);
    const unchanged = (["sessions", "groups", "items", "statements", "projects", "runsOutsideTargets", "packagesOutsideTargets"] as const).every((k) => before[k] === after[k]);
    if (del.count !== ids.length || !unchanged || after.runsTotal !== before.runsTotal - ids.length) {
      throw new Error("CLEANUP_INVARIANT_VIOLATED");
    }
    return { deletedRuns: del.count, before, after };
  });
  for (const f of files) removePackageFileIfUnreferenced(f.storedFile, (await prisma.analysisPackage.count({ where: { storedFile: f.storedFile } })) > 0);
  return NextResponse.json({ ...result, deleted: targets, preconditions: { ok: true } });
}
