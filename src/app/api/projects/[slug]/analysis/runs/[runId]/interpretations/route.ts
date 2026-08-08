import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { isValidSelectedClusterCount } from "@/lib/analysis/interpretation";

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== check.project.id) {
    return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const selectedClusterCount = body?.selectedClusterCount;
  if (!isValidSelectedClusterCount(selectedClusterCount)) {
    return NextResponse.json({ errorCode: "INVALID_CLUSTER_COUNT" }, { status: 422 });
  }

  const previousInterpretationId = typeof body?.previousInterpretationId === "string" ? body.previousInterpretationId : null;
  if (previousInterpretationId) {
    const previous = await prisma.analysisInterpretation.findUnique({ where: { id: previousInterpretationId } });
    if (!previous || previous.analysisRunId !== run.id) {
      return NextResponse.json({ errorCode: "INTERPRETATION_NOT_FOUND" }, { status: 404 });
    }
  }

  const axisLabels = typeof body?.axisLabels === "string" ? body.axisLabels : null;
  const quadrantLabels = typeof body?.quadrantLabels === "string" ? body.quadrantLabels : null;
  const notes = typeof body?.notes === "string" ? body.notes : null;

  const lastVersion = await prisma.analysisInterpretation.aggregate({
    where: { analysisRunId: run.id },
    _max: { version: true },
  });
  const nextVersion = (lastVersion._max.version ?? 0) + 1;

  const interpretation = await prisma.analysisInterpretation.create({
    data: {
      analysisRunId: run.id,
      status: "DRAFT",
      version: nextVersion,
      previousInterpretationId,
      selectedClusterCount,
      axisLabels,
      quadrantLabels,
      notes,
    },
  });

  return NextResponse.json(
    {
      id: interpretation.id,
      analysisRunId: interpretation.analysisRunId,
      status: interpretation.status,
      version: interpretation.version,
      previousInterpretationId: interpretation.previousInterpretationId,
      selectedClusterCount: interpretation.selectedClusterCount,
      axisLabels: interpretation.axisLabels,
      quadrantLabels: interpretation.quadrantLabels,
      notes: interpretation.notes,
      createdAt: interpretation.createdAt.toISOString(),
      finalizedAt: interpretation.finalizedAt?.toISOString() ?? null,
    },
    { status: 201 }
  );
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== check.project.id) {
    return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  }

  const interpretations = await prisma.analysisInterpretation.findMany({
    where: { analysisRunId: run.id },
    orderBy: { version: "asc" },
    include: { labels: true },
  });

  return NextResponse.json({
    interpretations: interpretations.map((i) => ({
      id: i.id,
      status: i.status,
      version: i.version,
      previousInterpretationId: i.previousInterpretationId,
      selectedClusterCount: i.selectedClusterCount,
      axisLabels: i.axisLabels,
      quadrantLabels: i.quadrantLabels,
      notes: i.notes,
      createdAt: i.createdAt.toISOString(),
      finalizedAt: i.finalizedAt?.toISOString() ?? null,
      labels: i.labels.map((l) => ({ clusterIndex: l.clusterIndex, language: l.language, label: l.label, memo: l.memo })),
    })),
  });
}
