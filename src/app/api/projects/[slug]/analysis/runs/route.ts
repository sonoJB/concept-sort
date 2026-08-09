import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import type { AnalysisScope } from "@/lib/conceptAnalysis";
import { DEFAULT_ANALYSIS_PARAMETERS, VALIDATION_BASELINE_SHA, getEngineSourceCommitSha } from "@/lib/analysis/config";
import { createAnalysisRun, executeAnalysisRun, ParticipantCountZeroError } from "@/lib/analysis/executionService";
import { RunAlreadyRunningError } from "@/lib/analysis/lock";
import { serializeRunMetadata } from "@/lib/analysis/runSerializer";

function isValidScope(value: unknown): value is AnalysisScope {
  return value === "KR" || value === "JP" || value === "ALL";
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const body = await request.json().catch(() => null);
  const scope = body?.scope;
  if (!isValidScope(scope)) {
    return NextResponse.json({ errorCode: "SCOPE_INVALID" }, { status: 422 });
  }

  const engineSourceCommitSha = getEngineSourceCommitSha();
  if (!engineSourceCommitSha) {
    return NextResponse.json({ errorCode: "ENGINE_SOURCE_SHA_UNAVAILABLE" }, { status: 500 });
  }

  try {
    const { runId } = await createAnalysisRun({
      prisma,
      projectId: check.project.id,
      scope,
      analysisParameters: DEFAULT_ANALYSIS_PARAMETERS,
      validationBaselineSha: VALIDATION_BASELINE_SHA,
      engineSourceCommitSha,
    });

    // Synchronous execution model (Gate 1 FINAL §10): the request stays open
    // until the run reaches a terminal state.
    await executeAnalysisRun(prisma, runId);

    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    const metadata = await serializeRunMetadata(prisma, run);
    return NextResponse.json(metadata, { status: 201 });
  } catch (e) {
    if (e instanceof ParticipantCountZeroError) {
      return NextResponse.json({ errorCode: "PARTICIPANT_COUNT_ZERO" }, { status: 422 });
    }
    if (e instanceof RunAlreadyRunningError) {
      return NextResponse.json({ errorCode: "RUN_ALREADY_RUNNING" }, { status: 409 });
    }
    return NextResponse.json({ errorCode: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const scopeParam = request.nextUrl.searchParams.get("scope");
  const runs = await prisma.analysisRun.findMany({
    where: { projectId: check.project.id, ...(scopeParam ? { scope: scopeParam } : {}) },
    orderBy: { startedAt: "desc" },
  });

  const serialized = await Promise.all(runs.map((run) => serializeRunMetadata(prisma, run)));
  return NextResponse.json({ runs: serialized });
}
