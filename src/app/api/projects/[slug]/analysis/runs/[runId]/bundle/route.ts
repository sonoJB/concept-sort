import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { serializeRunMetadata, isResultBodyExposable } from "@/lib/analysis/runSerializer";

/**
 * The complete stored result bundle of one run (matrices, MDS per dimension with every start, Ward history,
 * cluster solutions, reliability, naming proposal). A COMPLETED run is only exposed while fully current; a FAILED
 * run's bundle (e.g. MDS_NOT_CONVERGED) is returned too, flagged as not an official result, so the failure is
 * visible rather than silently hidden.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== check.project.id) return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  const metadata = await serializeRunMetadata(prisma, run);
  const official = isResultBodyExposable(run.executionStatus, metadata.freshness);
  if (run.executionStatus === "COMPLETED" && !official) return NextResponse.json({ ...metadata, resultBodyBlocked: true });
  if (run.executionStatus !== "COMPLETED" && run.executionStatus !== "FAILED") return NextResponse.json({ ...metadata, resultBodyBlocked: true });
  if (!run.resultBundle) return NextResponse.json({ ...metadata, resultBodyBlocked: true, errorCode: "BUNDLE_MISSING" });
  return NextResponse.json({ ...metadata, officialResult: official, resultBodyBlocked: false, bundle: JSON.parse(run.resultBundle) });
}
