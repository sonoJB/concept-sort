import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { serializeRunMetadata, isResultBodyExposable } from "@/lib/analysis/runSerializer";
import { fromStoredSeed } from "@/lib/analysis/executionService";

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const run = await prisma.analysisRun.findUnique({ where: { id: runId }, include: { dimensions: true } });
  // Cross-project resource: reported identically to "doesn't exist" — never
  // leaks that a run with this ID exists under a different project.
  if (!run || run.projectId !== check.project.id) {
    return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  }

  const metadata = await serializeRunMetadata(prisma, run);
  const exposable = isResultBodyExposable(run.executionStatus, metadata.freshness);

  if (!exposable) {
    return NextResponse.json({ ...metadata, resultBodyBlocked: true });
  }

  const dimensions = run.dimensions.map((d) => ({
    dimension: d.dimension,
    dimensionStatus: d.dimensionStatus,
    coordinates: d.coordinates ? JSON.parse(d.coordinates) : null,
    rawStress: d.rawStress,
    commonStressDistance: d.commonStressDistance,
    commonStressQ: d.commonStressQ,
    converged: d.converged,
    iterations: d.iterations,
    bestInitIndex: d.bestInitIndex,
    // bestSeed is stored as a signed-Int32 reinterpretation of the engine's
    // unsigned 32-bit PRNG seed (see executionService.ts) — always decoded
    // back to the original unsigned value before leaving this API.
    bestSeed: fromStoredSeed(d.bestSeed),
    errorCode: d.errorCode,
    errorMessageSafe: d.errorMessageSafe,
  }));

  return NextResponse.json({
    ...metadata,
    resultBodyBlocked: false,
    dimensions,
    wardLinkageSnapshot: run.wardLinkageSnapshot ? JSON.parse(run.wardLinkageSnapshot) : null,
  });
}
