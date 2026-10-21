import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { enqueuePackageJob, serializePackageJob } from "@/lib/analysis/packageJobs";
import { packageFileState } from "@/lib/analysis/packageStore";

/**
 * Package state of ONE run, separate from the analysis state: the latest build job (QUEUED / BUILDING / VERIFYING /
 * REGISTERING / READY / FAILED) and every registered package version of the run.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== check.project.id) return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  const job = await prisma.analysisPackageJob.findFirst({ where: { analysisRunId: runId }, orderBy: { targetVersion: "desc" } });
  const packages = await prisma.analysisPackage.findMany({ where: { analysisRunId: runId }, orderBy: { packageVersion: "desc" }, select: { packageVersion: true, filename: true, sha256: true, byteSize: true, createdAt: true, builderVersion: true, textVersion: true, storedFile: true } });
  return NextResponse.json({
    runId,
    job: job ? serializePackageJob(job) : null,
    packages: packages.map(({ storedFile, ...p }) => ({ ...p, createdAt: p.createdAt.toISOString(), fileStatus: packageFileState(storedFile, p.byteSize) })),
  });
}

/**
 * { "action": "retry" }    re-queue the latest FAILED job (no MDS recomputation: the ZIP is rebuilt from the stored result)
 * { "action": "rebuild" }  build a NEW package version from the stored result (older versions are kept)
 * Both are idempotent against double clicks / refreshes: while a job of the run is active the same job is returned.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== check.project.id) return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  if (body?.action !== "retry" && body?.action !== "rebuild") return NextResponse.json({ errorCode: "ACTION_INVALID" }, { status: 400 });
  const r = await enqueuePackageJob(prisma, runId, body.action === "retry" ? "RETRY" : "REBUILD");
  if (!r.ok) return NextResponse.json({ errorCode: r.errorCode }, { status: r.status });
  return NextResponse.json({ ok: true, created: r.created, reason: r.reason, job: serializePackageJob(r.job) }, { status: r.created || r.reason === "RETRY_REQUEUED" ? 202 : 200 });
}
