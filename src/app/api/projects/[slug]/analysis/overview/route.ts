import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { serializeRunMetadata, isResultBodyExposable } from "@/lib/analysis/runSerializer";
import { DEFAULT_ANALYSIS_PARAMETERS } from "@/lib/analysis/config";
import { serializePackageJob } from "@/lib/analysis/packageJobs";
import { INTERPRETATION_TEXT_VERSION } from "@/lib/conceptMap/metrics";
import { PACKAGE_FORMAT_VERSION } from "@/lib/analysis/packageConfig";
import { packageFileState } from "@/lib/analysis/packageStore";

const SCOPES = ["KR", "JP", "ALL"] as const;

type PackageRow = { packageVersion: number; filename: string; sha256: string; byteSize: number; createdAt: Date; builderVersion: string | null; textVersion: string | null; storedFile: string };
// fileStatus: a registered package whose file is missing or has the wrong size is NOT presented as ready to download
const pkgView = (p: PackageRow) => ({ version: p.packageVersion, filename: p.filename, sha256: p.sha256, byteSize: p.byteSize, createdAt: p.createdAt.toISOString(), packageFormatVersion: p.builderVersion, interpretationTextVersion: p.textVersion, fileStatus: packageFileState(p.storedFile, p.byteSize) });

/**
 * Per scope: the newest MAIN run that is COMPLETED, fully current and of the current algorithm version (the
 * "official" result), the package state OF THAT RUN (its current package, all its versions, its latest build job) and the
 * other runs that have a package ("previous verified results"), each with its own run id, time and freshness so an older
 * result's ZIP is never presented as the ZIP of the displayed result.
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
      include: { packages: { orderBy: { packageVersion: "desc" }, select: { packageVersion: true, filename: true, sha256: true, byteSize: true, createdAt: true, builderVersion: true, textVersion: true, storedFile: true } } },
    });
    let official: Awaited<ReturnType<typeof serializeRunMetadata>> | null = null;
    let officialRunId: string | null = null;
    let pkg: ReturnType<typeof pkgView> | null = null;
    let versions: ReturnType<typeof pkgView>[] = [];
    const history = [];
    const previous = [];
    for (const run of runs) {
      const meta = await serializeRunMetadata(prisma, run);
      const exposable = isResultBodyExposable(run.executionStatus, meta.freshness);
      if (!official && exposable && run.algorithmVersion === DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion) {
        official = meta;
        officialRunId = run.id;
        versions = run.packages.map(pkgView);
        pkg = versions[0] ?? null;
      } else if (run.packages.length > 0) {
        previous.push({
          runId: run.id,
          startedAt: meta.startedAt,
          algorithmVersion: run.algorithmVersion,
          current: exposable,
          freshness: meta.freshness,
          packages: run.packages.map(pkgView),
        });
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
    const job = officialRunId ? await prisma.analysisPackageJob.findFirst({ where: { analysisRunId: officialRunId }, orderBy: { targetVersion: "desc" } }) : null;
    out[scope] = { official, package: pkg, packageVersions: versions, packageJob: job ? serializePackageJob(job) : null, previousResults: previous, history, noOfficialResult: official === null };
  }
  return NextResponse.json({ currentAlgorithmVersion: DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion, interpretationTextVersion: INTERPRETATION_TEXT_VERSION, packageFormatVersion: PACKAGE_FORMAT_VERSION, scopes: out });
}
