import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { computeParameterHash } from "@/lib/analysis/hashes";
import { buildParametersSnapshot } from "@/lib/analysis/snapshot";
import { DEFAULT_ANALYSIS_PARAMETERS, VALIDATION_BASELINE_SHA } from "@/lib/analysis/config";
import { computeRunFreshness } from "@/lib/analysis/freshnessService";
import { checkExportEligibility, type ExportLanguage } from "@/lib/analysis/view/exportGate";
import { buildExportPayload } from "@/lib/analysis/view/exportPayload";
import { computeLocaleContentStatus } from "@/lib/localeContentStatus";

function isValidLanguage(v: unknown): v is ExportLanguage {
  return v === "ko" || v === "ja";
}

/**
 * Server-authoritative export data. The client never assembles this from
 * raw DB rows and never gets to decide eligibility — every check here
 * re-runs regardless of what any client-side UI state claims.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const lang = request.nextUrl.searchParams.get("lang") ?? "ko";
  if (!isValidLanguage(lang)) {
    return NextResponse.json({ errorCode: "INVALID_LANGUAGE" }, { status: 422 });
  }

  const run = await prisma.analysisRun.findUnique({ where: { id: runId }, include: { dimensions: true } });
  if (!run || run.projectId !== check.project.id) {
    return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  }

  // The run's parameterStatus (CURRENT vs SUPERSEDED) must reflect whether
  // the LIVE app configuration still matches what the run was executed
  // with — hashing the run's own stored parametersSnapshot would always
  // trivially equal run.parameterHash (they're the same computation done
  // twice) and could never detect a superseded run. So the "current" side
  // of the comparison is built from DEFAULT_ANALYSIS_PARAMETERS (today's
  // config), the same way executionService.ts builds it at run-creation
  // time, and only that gets hashed for the freshness comparison.
  const currentParametersSnapshot = buildParametersSnapshot(DEFAULT_ANALYSIS_PARAMETERS, {
    validationBaselineSha: VALIDATION_BASELINE_SHA,
  });
  const currentParameterHash = computeParameterHash(currentParametersSnapshot);
  const freshness = await computeRunFreshness(prisma, run, currentParameterHash);

  // Publication readiness for the REQUESTED export language, computed
  // independently of the run's own scope — see exportGate.ts's doc comment
  // for why freshness.publicationStatus (scope-gated to the run) cannot be
  // reused here.
  const [project, statements] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: check.project.id } }),
    prisma.statement.findMany({ where: { projectId: check.project.id } }),
  ]);
  const localeStatus = computeLocaleContentStatus(lang, project, statements);

  const eligibility = checkExportEligibility(run.executionStatus, freshness, lang, localeStatus.ready);
  if (!eligibility.allowed) {
    return NextResponse.json({ errorCode: "EXPORT_BLOCKED", reason: eligibility.reason }, { status: 409 });
  }

  const interpretationId = request.nextUrl.searchParams.get("interpretationId");
  let interpretation: {
    version: number;
    status: string;
    selectedClusterCount: number;
    axisLabels: string | null;
    quadrantLabels: string | null;
    notes: string | null;
  } | null = null;
  let interpretationLabels: { clusterIndex: number; language: string; label: string; memo: string | null }[] = [];

  if (interpretationId) {
    const found = await prisma.analysisInterpretation.findUnique({
      where: { id: interpretationId },
      include: { labels: true },
    });
    if (!found || found.analysisRunId !== run.id) {
      return NextResponse.json({ errorCode: "INTERPRETATION_NOT_FOUND" }, { status: 404 });
    }
    interpretation = {
      version: found.version,
      status: found.status,
      selectedClusterCount: found.selectedClusterCount,
      axisLabels: found.axisLabels,
      quadrantLabels: found.quadrantLabels,
      notes: found.notes,
    };
    interpretationLabels = found.labels.map((l) => ({ clusterIndex: l.clusterIndex, language: l.language, label: l.label, memo: l.memo }));
  }

  const payload = buildExportPayload({
    projectSlug: slug,
    run,
    dimensions: run.dimensions,
    exportLanguage: lang,
    interpretation,
    interpretationLabels,
  });

  return NextResponse.json(payload);
}
