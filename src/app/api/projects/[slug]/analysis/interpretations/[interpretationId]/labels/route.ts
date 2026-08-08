import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import {
  isValidLanguage,
  isValidClusterIndex,
  CLUSTER_LABEL_MAX_LENGTH,
  CLUSTER_MEMO_MAX_LENGTH,
} from "@/lib/analysis/interpretation";

/**
 * Creates or updates (upsert on the unique (interpretation, clusterIndex,
 * language) key) one cluster label. Only allowed while the parent
 * interpretation is DRAFT — label/memo are stored and returned as plain
 * text, never rendered as HTML by this API.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string; interpretationId: string }> }) {
  const { slug, interpretationId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const interpretation = await prisma.analysisInterpretation.findUnique({
    where: { id: interpretationId },
    include: { analysisRun: true },
  });
  if (!interpretation || interpretation.analysisRun.projectId !== check.project.id) {
    return NextResponse.json({ errorCode: "INTERPRETATION_NOT_FOUND" }, { status: 404 });
  }
  if (interpretation.status === "FINALIZED") {
    return NextResponse.json({ errorCode: "INTERPRETATION_FINALIZED" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  const { clusterIndex, language, label, memo } = body ?? {};

  if (!isValidClusterIndex(clusterIndex, interpretation.selectedClusterCount)) {
    return NextResponse.json({ errorCode: "INVALID_CLUSTER_COUNT" }, { status: 422 });
  }
  if (!isValidLanguage(language)) {
    return NextResponse.json({ errorCode: "INVALID_LANGUAGE" }, { status: 422 });
  }
  if (typeof label !== "string" || label.length === 0) {
    return NextResponse.json({ errorCode: "INVALID_CLUSTER_COUNT", error: "label is required." }, { status: 422 });
  }
  if (label.length > CLUSTER_LABEL_MAX_LENGTH) {
    return NextResponse.json({ errorCode: "LABEL_TOO_LONG" }, { status: 422 });
  }
  if (memo !== undefined && memo !== null && (typeof memo !== "string" || memo.length > CLUSTER_MEMO_MAX_LENGTH)) {
    return NextResponse.json({ errorCode: "MEMO_TOO_LONG" }, { status: 422 });
  }

  const saved = await prisma.analysisClusterLabel.upsert({
    where: { analysisInterpretationId_clusterIndex_language: { analysisInterpretationId: interpretation.id, clusterIndex, language } },
    create: { analysisInterpretationId: interpretation.id, clusterIndex, language, label, memo: memo ?? null },
    update: { label, memo: memo ?? null },
  });

  return NextResponse.json(
    { id: saved.id, clusterIndex: saved.clusterIndex, language: saved.language, label: saved.label, memo: saved.memo },
    { status: 201 }
  );
}
