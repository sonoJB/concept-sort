import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { serializeRunMetadata, isResultBodyExposable } from "@/lib/analysis/runSerializer";
import { readPackageFile, writePackageFile, removePackageFileIfUnreferenced } from "@/lib/analysis/packageStore";
import { scanPackageForPersonalData, sha256, verifyPackageBytes } from "@/lib/analysis/packageVerify";

const MAX_BYTES = 80 * 1024 * 1024;

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) return NextResponse.json({ errorCode: check.error }, { status: check.status });
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== check.project.id) return NextResponse.json({ errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  const meta = await serializeRunMetadata(prisma, run);
  if (!isResultBodyExposable(run.executionStatus, meta.freshness)) return NextResponse.json({ errorCode: "RESULT_NOT_CURRENT" }, { status: 409 });
  const pkg = await prisma.analysisPackage.findUnique({ where: { analysisRunId: runId } });
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
    },
  });
}

/**
 * Attaches a prebuilt package to a COMPLETED run. Nothing is trusted from the client: the ZIP is opened, its
 * manifest must name THIS run and scope and carry the run's own fingerprints, and every listed file's SHA-256
 * and size must match the actual entries (and no unlisted file may be present).
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
  const bundle = JSON.parse(run.resultBundle) as { meta: { fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string } } };
  const verdict = verifyPackageBytes(body, { id: run.id, scope: run.scope }, bundle.meta.fingerprints);
  if (!verdict.ok) return NextResponse.json({ errorCode: verdict.errorCode, detail: verdict.detail }, { status: 422 });
  const pii = await scanPackageForPersonalData(prisma, check.project.id, body);
  if (!pii.clean) return NextResponse.json({ errorCode: "PACKAGE_CONTAINS_PERSONAL_DATA", findings: pii.findings }, { status: 422 });
  const manifest = verdict.manifest;
  const stored = writePackageFile(body);
  const previous = await prisma.analysisPackage.findMany({ where: { analysisRunId: run.id }, select: { storedFile: true } });
  await prisma.$transaction(async (tx) => {
    await tx.analysisPackage.deleteMany({ where: { analysisRunId: run.id } });
    await tx.analysisPackage.create({
      data: {
        projectId: check.project.id,
        analysisRunId: run.id,
        scope: run.scope,
        filename: manifest.zipFilename,
        sha256: stored.sha256,
        byteSize: body.byteLength,
        manifest: JSON.stringify(manifest),
        storedFile: stored.storedFile,
      },
    });
  });
  for (const p of previous) removePackageFileIfUnreferenced(p.storedFile, p.storedFile === stored.storedFile || (await prisma.analysisPackage.count({ where: { storedFile: p.storedFile } })) > 0);
  return NextResponse.json({ ok: true, filename: manifest.zipFilename, sha256: actual, byteSize: body.byteLength, files: manifest.files.length });
}
