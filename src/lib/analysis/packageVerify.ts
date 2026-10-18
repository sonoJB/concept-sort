import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { PrismaClient } from "@/generated/prisma/client";

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export type Manifest = {
  manifestVersion: number;
  runId: string;
  scope: string;
  zipFilename: string;
  fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string };
  files: { path: string; sha256: string; bytes: number }[];
};

export type PackageCheck = { ok: true; manifest: Manifest; entryCount: number } | { ok: false; errorCode: string; detail?: unknown };

const TEXT_EXT = /\.(csv|md|txt|json|html|svg|py|ts|tsx)$/i;

/**
 * Opens the ZIP and checks it against ONE run: the manifest must name this run and scope and carry the run's own
 * fingerprints, every listed file must exist with the listed size and SHA-256, and no unlisted file may be present.
 */
export function verifyPackageBytes(bytes: Uint8Array, run: { id: string; scope: string }, fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string }): PackageCheck {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { ok: false, errorCode: "PACKAGE_NOT_A_ZIP" };
  }
  const manifestEntry = Object.entries(entries).find(([name]) => name.endsWith("/manifest.json") || name === "manifest.json");
  if (!manifestEntry) return { ok: false, errorCode: "MANIFEST_MISSING" };
  const root = manifestEntry[0].slice(0, manifestEntry[0].length - "manifest.json".length);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry[1])) as Manifest;
  } catch {
    return { ok: false, errorCode: "MANIFEST_INVALID" };
  }
  if (manifest.runId !== run.id || manifest.scope !== run.scope) return { ok: false, errorCode: "MANIFEST_RUN_MISMATCH" };
  if (manifest.fingerprints?.participantsHash !== fingerprints.participantsHash || manifest.fingerprints?.numericDataHash !== fingerprints.numericDataHash || manifest.fingerprints?.parameterHash !== fingerprints.parameterHash) {
    return { ok: false, errorCode: "MANIFEST_FINGERPRINT_MISMATCH" };
  }
  const listed = new Set<string>();
  for (const file of manifest.files) {
    const entry = entries[root + file.path];
    if (!entry) return { ok: false, errorCode: "MANIFEST_FILE_MISSING", detail: file.path };
    if (entry.byteLength !== file.bytes || sha256(entry) !== file.sha256) return { ok: false, errorCode: "MANIFEST_FILE_HASH_MISMATCH", detail: file.path };
    listed.add(root + file.path);
  }
  const extra = Object.keys(entries).filter((n) => !n.endsWith("/") && !listed.has(n) && n !== manifestEntry[0]);
  if (extra.length > 0) return { ok: false, errorCode: "UNLISTED_FILES_PRESENT", detail: extra.slice(0, 5) };
  if (!manifest.zipFilename || /[\\/]/.test(manifest.zipFilename)) return { ok: false, errorCode: "ZIP_FILENAME_INVALID" };
  return { ok: true, manifest, entryCount: Object.keys(entries).length };
}

/**
 * Personal-data guard run on every upload: no participant name, phone number, real session id or admin token
 * (taken from the live database) may occur in any text file of the package; digit-only names / phone endings may not
 * appear as a whole CSV cell. Only counts are reported, never the values.
 */
export async function scanPackageForPersonalData(prisma: PrismaClient, projectId: string, bytes: Uint8Array): Promise<{ clean: boolean; findings: Record<string, number> }> {
  const entries = unzipSync(bytes);
  const sessions = await prisma.sortSession.findMany({ where: { projectId }, select: { id: true, participantName: true, phoneNumber: true } });
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { adminToken: true } });
  const names = new Set<string>();
  const digitsLong = new Set<string>();
  const phones = new Set<string>();
  for (const s of sessions) {
    const n = (s.participantName ?? "").trim();
    if (/^\d+$/.test(n)) {
      if (n.length >= 4) digitsLong.add(n);
    } else if (n.length >= 2) names.add(n);
    const ph = (s.phoneNumber ?? "").trim();
    if (/^\d{4,}$/.test(ph)) digitsLong.add(ph);
    if (ph.length >= 7) phones.add(ph);
  }
  const ids = sessions.map((s) => s.id);
  const findings = { name: 0, phone: 0, sessionId: 0, adminToken: 0, digitOnlyIdentifierCell: 0, genericPhonePattern: 0 };
  const dec = new TextDecoder("utf-8", { fatal: false });
  for (const [path, data] of Object.entries(entries)) {
    if (!TEXT_EXT.test(path)) continue;
    const text = dec.decode(data);
    for (const n of names) if (text.includes(n)) findings.name++;
    for (const p of phones) if (text.includes(p)) findings.phone++;
    for (const id of ids) if (text.includes(id)) findings.sessionId++;
    if (project?.adminToken && text.includes(project.adminToken)) findings.adminToken++;
    if (/01[0-9]-\d{3,4}-\d{4}/.test(text)) findings.genericPhonePattern++;
    // Digit-only identifiers (e.g. a 4-digit code used as a name, or the last 4 digits of a phone) are only meaningful to look for
    // in the participant response files; elsewhere the same digits are ordinary numbers (iteration counts, coordinates ...).
    if (path.toLowerCase().endsWith(".csv") && path.includes("02_원자료_가명") && digitsLong.size > 0) {
      const cells = new Set<string>();
      for (const line of text.split(/\r?\n/)) for (const c of line.split(",")) cells.add(c.replace(/^"|"$/g, "").trim());
      for (const d of digitsLong) if (cells.has(d)) findings.digitOnlyIdentifierCell++;
    }
  }
  return { clean: Object.values(findings).every((v) => v === 0), findings };
}
