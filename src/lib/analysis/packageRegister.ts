import type { PrismaClient } from "@/generated/prisma/client";
import { removePackageFileIfUnreferenced, writePackageFile } from "./packageStore";
import { scanPackageForPersonalData, sha256, verifyPackageBytes, type Manifest, type RunSnapshotForPackage } from "./packageVerify";
import { MAX_PACKAGE_VERSIONS_PER_RUN } from "./packageConfig";
import { INTERPRETATION_TEXT_VERSION } from "@/lib/conceptMap/metrics";

export type RegisterRun = { id: string; projectId: string; scope: string; inputSnapshot: string; resultBundle: string | null };

export type RegisterResult =
  | { ok: true; created: boolean; version: number; manifest: Manifest; sha256: string; byteSize: number }
  | { ok: false; status: number; errorCode: string; detail?: unknown };

/**
 * Verifies a ZIP against ONE run and attaches it as a NEW package version of that run (older versions are kept).
 * Used by both the automatic pipeline and the manual PUT route, so the same checks always apply:
 * manifest = this run and its fingerprints, every file hash, the pseudonymous responses equal the run's stored records,
 * and no real name / phone / session id / token anywhere. Registering the same bytes twice does not create a second version.
 */
export async function registerPackageBytes(
  prisma: PrismaClient,
  run: RegisterRun,
  bytes: Uint8Array,
  opts: { targetVersion?: number; requireCurrentText?: boolean; /** called after verification and before anything is written; returning false aborts (job no longer active) */ onVerified?: () => Promise<boolean> } = {}
): Promise<RegisterResult> {
  if (!run.resultBundle) return { ok: false, status: 409, errorCode: "RUN_NOT_COMPLETED" };
  const bundle = JSON.parse(run.resultBundle) as { meta: { fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string } } };
  const snapshot = JSON.parse(run.inputSnapshot) as RunSnapshotForPackage;
  const verdict = verifyPackageBytes(bytes, { id: run.id, scope: run.scope }, bundle.meta.fingerprints, snapshot);
  if (!verdict.ok) return { ok: false, status: 422, errorCode: verdict.errorCode, detail: verdict.detail };
  const manifest = verdict.manifest;
  if (opts.requireCurrentText && manifest.interpretationTextVersion !== INTERPRETATION_TEXT_VERSION) return { ok: false, status: 422, errorCode: "PACKAGE_TEXT_VERSION_MISMATCH", detail: manifest.interpretationTextVersion ?? null };
  const pii = await scanPackageForPersonalData(prisma, run.projectId, bytes);
  if (!pii.clean) return { ok: false, status: 422, errorCode: "PACKAGE_CONTAINS_PERSONAL_DATA", detail: pii.findings };

  if (opts.onVerified && !(await opts.onVerified())) return { ok: false, status: 409, errorCode: "ABORTED" };
  const digest = sha256(bytes);
  const existing = await prisma.analysisPackage.findMany({ where: { analysisRunId: run.id }, select: { packageVersion: true, sha256: true }, orderBy: { packageVersion: "desc" } });
  const same = existing.find((p) => p.sha256 === digest);
  if (same) return { ok: true, created: false, version: same.packageVersion, manifest, sha256: digest, byteSize: bytes.byteLength };
  const version = opts.targetVersion ?? (existing[0]?.packageVersion ?? 0) + 1;
  if (existing.some((p) => p.packageVersion === version)) return { ok: false, status: 409, errorCode: "PACKAGE_VERSION_EXISTS", detail: version };
  if (existing.length >= MAX_PACKAGE_VERSIONS_PER_RUN) return { ok: false, status: 409, errorCode: "TOO_MANY_VERSIONS" };
  if (manifest.packageVersion !== undefined && manifest.packageVersion !== version) return { ok: false, status: 422, errorCode: "PACKAGE_VERSION_MISMATCH", detail: { manifest: manifest.packageVersion, expected: version } };

  const stored = writePackageFile(bytes);
  try {
    await prisma.analysisPackage.create({
    data: {
      projectId: run.projectId,
      analysisRunId: run.id,
      scope: run.scope,
      filename: manifest.zipFilename,
      sha256: stored.sha256,
      byteSize: bytes.byteLength,
      manifest: JSON.stringify(manifest),
      storedFile: stored.storedFile,
      packageVersion: version,
      builderVersion: manifest.packageFormatVersion ?? null,
      textVersion: manifest.interpretationTextVersion ?? null,
    },
    });
  } catch (e) {
    // no row references the file now: do not leave an orphan behind
    removePackageFileIfUnreferenced(stored.storedFile, (await prisma.analysisPackage.count({ where: { storedFile: stored.storedFile } })) > 0);
    throw e;
  }
  return { ok: true, created: true, version, manifest, sha256: digest, byteSize: bytes.byteLength };
}
