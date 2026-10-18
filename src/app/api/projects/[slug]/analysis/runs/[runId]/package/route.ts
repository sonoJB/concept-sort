import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { serializeRunMetadata, isResultBodyExposable } from "@/lib/analysis/runSerializer";
import { readPackageFile, writePackageFile, removePackageFileIfUnreferenced } from "@/lib/analysis/packageStore";

const MAX_BYTES = 80 * 1024 * 1024;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

type Manifest = {
  manifestVersion: number;
  runId: string;
  scope: string;
  zipFilename: string;
  fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string };
  files: { path: string; sha256: string; bytes: number }[];
};

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
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return NextResponse.json({ errorCode: "PACKAGE_SIZE_INVALID" }, { status: 413 });
  const declared = request.headers.get("x-package-sha256");
  const actual = sha256(body);
  if (!declared || declared.toLowerCase() !== actual) return NextResponse.json({ errorCode: "PACKAGE_HASH_MISMATCH" }, { status: 422 });
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(body);
  } catch {
    return NextResponse.json({ errorCode: "PACKAGE_NOT_A_ZIP" }, { status: 422 });
  }
  const manifestEntry = Object.entries(entries).find(([name]) => name.endsWith("/manifest.json") || name === "manifest.json");
  if (!manifestEntry) return NextResponse.json({ errorCode: "MANIFEST_MISSING" }, { status: 422 });
  const root = manifestEntry[0].slice(0, manifestEntry[0].length - "manifest.json".length);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry[1])) as Manifest;
  } catch {
    return NextResponse.json({ errorCode: "MANIFEST_INVALID" }, { status: 422 });
  }
  const bundle = JSON.parse(run.resultBundle) as { meta: { fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string } } };
  if (manifest.runId !== run.id || manifest.scope !== run.scope) return NextResponse.json({ errorCode: "MANIFEST_RUN_MISMATCH" }, { status: 422 });
  const f = bundle.meta.fingerprints;
  if (manifest.fingerprints?.participantsHash !== f.participantsHash || manifest.fingerprints?.numericDataHash !== f.numericDataHash || manifest.fingerprints?.parameterHash !== f.parameterHash) {
    return NextResponse.json({ errorCode: "MANIFEST_FINGERPRINT_MISMATCH" }, { status: 422 });
  }
  const listed = new Set<string>();
  for (const file of manifest.files) {
    const entry = entries[root + file.path];
    if (!entry) return NextResponse.json({ errorCode: "MANIFEST_FILE_MISSING", detail: file.path }, { status: 422 });
    if (entry.byteLength !== file.bytes || sha256(entry) !== file.sha256) return NextResponse.json({ errorCode: "MANIFEST_FILE_HASH_MISMATCH", detail: file.path }, { status: 422 });
    listed.add(root + file.path);
  }
  const extra = Object.keys(entries).filter((n) => !n.endsWith("/") && !listed.has(n) && n !== manifestEntry[0]);
  if (extra.length > 0) return NextResponse.json({ errorCode: "UNLISTED_FILES_PRESENT", detail: extra.slice(0, 5) }, { status: 422 });
  if (!manifest.zipFilename || /[\\/]/.test(manifest.zipFilename)) return NextResponse.json({ errorCode: "ZIP_FILENAME_INVALID" }, { status: 422 });

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
