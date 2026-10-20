import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { serializeRunMetadata, isResultBodyExposable } from "@/lib/analysis/runSerializer";
import { readPackageFile } from "@/lib/analysis/packageStore";
import { sha256 } from "@/lib/analysis/packageVerify";
import { registerPackageBytes } from "@/lib/analysis/packageRegister";
import { DEFAULT_ANALYSIS_PARAMETERS } from "@/lib/analysis/config";

const MAX_BYTES = 80 * 1024 * 1024;

/**
 * Downloads a package of ONE run. `?version=N` selects an older package version of the same run; without it the
 * current (highest) version is served. The run's own freshness gate and the file's SHA-256 are checked on every read, and
 * the package row belongs to the run in the URL, so a package of another run can never be returned for this run.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== check.project.id) return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  const meta = await serializeRunMetadata(prisma, run);
  if (!isResultBodyExposable(run.executionStatus, meta.freshness)) return NextResponse.json({ errorCode: "RESULT_NOT_CURRENT" }, { status: 409 });
  const v = request.nextUrl.searchParams.get("version");
  const wanted = v === null ? null : Number(v);
  if (wanted !== null && (!Number.isInteger(wanted) || wanted < 1)) return NextResponse.json({ errorCode: "VERSION_INVALID" }, { status: 400 });
  const pkg = await prisma.analysisPackage.findFirst({ where: { analysisRunId: runId, ...(wanted === null ? {} : { packageVersion: wanted }) }, orderBy: { packageVersion: "desc" } });
  if (!pkg) return NextResponse.json({ errorCode: "PACKAGE_NOT_AVAILABLE" }, { status: 404 });
  const bytes = readPackageFile(pkg.storedFile, pkg.sha256);
  if (!bytes) return NextResponse.json({ errorCode: "PACKAGE_INTEGRITY_FAILURE" }, { status: 500 });
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(pkg.filename),
      "Cache-Control": "no-store",
      "X-Package-Sha256": pkg.sha256,
      "X-Package-Version": String(pkg.packageVersion),
    },
  });
}

/**
 * Attaches a prebuilt package to a COMPLETED run as a new package VERSION (older versions are kept). Nothing is trusted
 * from the client: the ZIP is opened, its manifest must name THIS run and scope and carry the run's own fingerprints,
 * every listed file's SHA-256 and size must match the actual entries (and no unlisted file may be present), the
 * pseudonymous responses must equal the run's stored records and no personal data may be present. The same checks run
 * for packages the server builds itself.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== check.project.id) return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  if (run.executionStatus !== "COMPLETED" || !run.resultBundle) return NextResponse.json({ errorCode: "RUN_NOT_COMPLETED" }, { status: 409 });
  // Downloadable packages are official 본조사 results only: never attach one to a pilot / check-up / legacy run.
  if (run.dataset !== "MAIN") return NextResponse.json({ errorCode: "RUN_NOT_MAIN" }, { status: 409 });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return NextResponse.json({ errorCode: "PACKAGE_SIZE_INVALID" }, { status: 413 });
  const declared = request.headers.get("x-package-sha256");
  const actual = sha256(body);
  if (!declared || declared.toLowerCase() !== actual) return NextResponse.json({ errorCode: "PACKAGE_HASH_MISMATCH" }, { status: 422 });
  // Only a fresh, current-version result may take a package (a stale run could never be downloaded anyway).
  const meta = await serializeRunMetadata(prisma, run);
  if (!isResultBodyExposable(run.executionStatus, meta.freshness) || run.algorithmVersion !== DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion) return NextResponse.json({ errorCode: "RESULT_NOT_CURRENT" }, { status: 409 });
  const result = await registerPackageBytes(prisma, run, body);
  if (!result.ok) return NextResponse.json({ errorCode: result.errorCode, ...(result.errorCode === "PACKAGE_CONTAINS_PERSONAL_DATA" ? { findings: result.detail } : { detail: result.detail }) }, { status: result.status });
  return NextResponse.json({ ok: true, created: result.created, version: result.version, filename: result.manifest.zipFilename, sha256: actual, byteSize: body.byteLength, files: result.manifest.files.length });
}
