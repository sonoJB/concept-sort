import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";

async function loadOwnedInterpretation(interpretationId: string, projectId: string) {
  const interpretation = await prisma.analysisInterpretation.findUnique({
    where: { id: interpretationId },
    include: { analysisRun: true },
  });
  if (!interpretation || interpretation.analysisRun.projectId !== projectId) return null;
  return interpretation;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; interpretationId: string }> }) {
  const { slug, interpretationId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const interpretation = await loadOwnedInterpretation(interpretationId, check.project.id);
  if (!interpretation) {
    return NextResponse.json({ errorCode: "INTERPRETATION_NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({
    id: interpretation.id,
    status: interpretation.status,
    version: interpretation.version,
    selectedClusterCount: interpretation.selectedClusterCount,
    axisLabels: interpretation.axisLabels,
    quadrantLabels: interpretation.quadrantLabels,
    notes: interpretation.notes,
    createdAt: interpretation.createdAt.toISOString(),
    finalizedAt: interpretation.finalizedAt?.toISOString() ?? null,
  });
}

/**
 * DRAFT: axisLabels/quadrantLabels/notes editable in place; selectedClusterCount
 * is immutable at all times (a k change always requires a new interpretation
 * via POST .../interpretations). status: "FINALIZED" is a one-way transition.
 * FINALIZED: any further PATCH is rejected with 409.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ slug: string; interpretationId: string }> }) {
  const { slug, interpretationId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const interpretation = await loadOwnedInterpretation(interpretationId, check.project.id);
  if (!interpretation) {
    return NextResponse.json({ errorCode: "INTERPRETATION_NOT_FOUND" }, { status: 404 });
  }

  if (interpretation.status === "FINALIZED") {
    return NextResponse.json({ errorCode: "INTERPRETATION_FINALIZED" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);

  if (body?.selectedClusterCount !== undefined) {
    return NextResponse.json({ errorCode: "INVALID_CLUSTER_COUNT", error: "selectedClusterCount is immutable; create a new interpretation instead." }, { status: 422 });
  }

  const data: Record<string, unknown> = {};
  if (typeof body?.axisLabels === "string" || body?.axisLabels === null) data.axisLabels = body.axisLabels;
  if (typeof body?.quadrantLabels === "string" || body?.quadrantLabels === null) data.quadrantLabels = body.quadrantLabels;
  if (typeof body?.notes === "string" || body?.notes === null) data.notes = body.notes;

  if (body?.status === "FINALIZED") {
    data.status = "FINALIZED";
    data.finalizedAt = new Date();
  } else if (body?.status !== undefined) {
    return NextResponse.json({ errorCode: "INTERPRETATION_FINALIZED", error: "status may only transition DRAFT -> FINALIZED." }, { status: 422 });
  }

  const updated = await prisma.analysisInterpretation.update({ where: { id: interpretation.id }, data });

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    version: updated.version,
    selectedClusterCount: updated.selectedClusterCount,
    axisLabels: updated.axisLabels,
    quadrantLabels: updated.quadrantLabels,
    notes: updated.notes,
    createdAt: updated.createdAt.toISOString(),
    finalizedAt: updated.finalizedAt?.toISOString() ?? null,
  });
}
