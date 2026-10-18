import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { serializeRunMetadata, isResultBodyExposable } from "@/lib/analysis/runSerializer";
import { DEFAULT_ANALYSIS_PARAMETERS } from "@/lib/analysis/config";

const SCOPES = ["KR", "JP", "ALL"] as const;

/**
 * Per scope: the newest MAIN run that is COMPLETED, fully current and of the current algorithm version (the
 * "official" result), whether a downloadable package is attached to it, and the version history of the other
 * runs (date / version / status only).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const out: Record<string, unknown> = {};
  for (const scope of SCOPES) {
    const runs = await prisma.analysisRun.findMany({
      where: { projectId: check.project.id, scope, dataset: "MAIN" },
      orderBy: { startedAt: "desc" },
      include: { packages: { select: { id: true, filename: true, sha256: true, byteSize: true, createdAt: true } } },
    });
    let official: Awaited<ReturnType<typeof serializeRunMetadata>> | null = null;
    let pkg: { filename: string; sha256: string; byteSize: number; createdAt: string } | null = null;
    const history = [];
    for (const run of runs) {
      const meta = await serializeRunMetadata(prisma, run);
      const exposable = isResultBodyExposable(run.executionStatus, meta.freshness);
      if (!official && exposable && run.algorithmVersion === DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion) {
        official = meta;
        const p = run.packages[0];
        pkg = p ? { filename: p.filename, sha256: p.sha256, byteSize: p.byteSize, createdAt: p.createdAt.toISOString() } : null;
      }
      history.push({
        id: run.id,
        startedAt: meta.startedAt,
        executionStatus: run.executionStatus,
        algorithmVersion: run.algorithmVersion,
        errorCode: run.errorCode,
        current: exposable,
        hasPackage: run.packages.length > 0,
      });
    }
    out[scope] = { official, package: pkg, history, noOfficialResult: official === null };
  }
  return NextResponse.json({ currentAlgorithmVersion: DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion, scopes: out });
}
