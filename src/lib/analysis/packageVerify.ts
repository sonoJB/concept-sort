import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { PrismaClient } from "@/generated/prisma/client";
import { parseCsv } from "@/lib/conceptMap/csv";
import { canonicalHash } from "./canonicalJson";

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export type Manifest = {
  manifestVersion: number;
  runId: string;
  scope: string;
  zipFilename: string;
  fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string };
  files: { path: string; sha256: string; bytes: number }[];
};

export type RunSnapshotForPackage = { participants: { pid: string; country: string; assignment: number[] }[]; participantsHash: string };
export type PackageCheck = { ok: true; manifest: Manifest; entryCount: number } | { ok: false; errorCode: string; detail?: unknown };

const TEXT_EXT = /\.(csv|md|txt|json|html|svg|py|ts|tsx)$/i;
const OFFICE_EXT = /\.(xlsx|docx)$/i;
export const MAX_UNCOMPRESSED_BYTES = 600 * 1024 * 1024;
const RESPONSE_FILE = "02_원자료_가명/참여자별_분류응답표.csv";

function unsafeName(n: string): boolean {
  return n.includes("\\") || n.includes("\0") || n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split("/").some((seg) => seg === "..");
}

/** Reads the entry table (names + declared sizes) WITHOUT inflating anything, then unzips only if everything is acceptable. */
function openZip(bytes: Uint8Array): { ok: true; entries: Record<string, Uint8Array>; root: string } | { ok: false; errorCode: string; detail?: unknown } {
  const seen: { name: string; size: number }[] = [];
  try {
    unzipSync(bytes, { filter: (f) => (seen.push({ name: f.name, size: f.originalSize }), false) });
  } catch {
    return { ok: false, errorCode: "PACKAGE_NOT_A_ZIP" };
  }
  const files = seen.filter((s) => !s.name.endsWith("/"));
  const bad = files.filter((s) => unsafeName(s.name)).map((s) => s.name);
  if (bad.length > 0) return { ok: false, errorCode: "UNSAFE_ENTRY_NAME", detail: bad.slice(0, 3) };
  const roots = new Set(files.map((s) => s.name.split("/")[0]));
  if (roots.size !== 1 || files.some((s) => !s.name.includes("/"))) return { ok: false, errorCode: "EXACTLY_ONE_ROOT_FOLDER_REQUIRED" };
  if (files.reduce((a, s) => a + s.size, 0) > MAX_UNCOMPRESSED_BYTES) return { ok: false, errorCode: "PACKAGE_TOO_LARGE_UNCOMPRESSED" };
  try {
    return { ok: true, entries: unzipSync(bytes), root: `${[...roots][0]}/` };
  } catch {
    return { ok: false, errorCode: "PACKAGE_NOT_A_ZIP" };
  }
}

/**
 * Opens the ZIP and checks it against ONE run: safe entry names and one root folder; the manifest must name this run
 * and scope and carry the run's own fingerprints; every listed file must exist with the listed size and SHA-256 and no
 * unlisted file may be present; and — when the run's stored snapshot is supplied — the participant response table inside
 * the package must equal the run's own stored participant records (same pseudonymous ids, the same single country or
 * the two countries of an ALL run, the same pile assignment of every statement), and the stored records must reproduce
 * the participants fingerprint. So a package can only contain the data the run was computed from.
 */
export function verifyPackageBytes(bytes: Uint8Array, run: { id: string; scope: string }, fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string }, snapshot?: RunSnapshotForPackage): PackageCheck {
  const opened = openZip(bytes);
  if (!opened.ok) return opened;
  const { entries, root } = opened;
  const manifestEntry = entries[`${root}manifest.json`];
  if (!manifestEntry) return { ok: false, errorCode: "MANIFEST_MISSING" };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry)) as Manifest;
  } catch {
    return { ok: false, errorCode: "MANIFEST_INVALID" };
  }
  if (manifest.runId !== run.id || manifest.scope !== run.scope) return { ok: false, errorCode: "MANIFEST_RUN_MISMATCH" };
  if (manifest.fingerprints?.participantsHash !== fingerprints.participantsHash || manifest.fingerprints?.numericDataHash !== fingerprints.numericDataHash || manifest.fingerprints?.parameterHash !== fingerprints.parameterHash) {
    return { ok: false, errorCode: "MANIFEST_FINGERPRINT_MISMATCH" };
  }
  const listed = new Set<string>();
  for (const file of manifest.files) {
    if (unsafeName(file.path)) return { ok: false, errorCode: "UNSAFE_ENTRY_NAME", detail: file.path };
    const entry = entries[root + file.path];
    if (!entry) return { ok: false, errorCode: "MANIFEST_FILE_MISSING", detail: file.path };
    if (entry.byteLength !== file.bytes || sha256(entry) !== file.sha256) return { ok: false, errorCode: "MANIFEST_FILE_HASH_MISMATCH", detail: file.path };
    listed.add(root + file.path);
  }
  const extra = Object.keys(entries).filter((n) => !n.endsWith("/") && !listed.has(n) && n !== `${root}manifest.json`);
  if (extra.length > 0) return { ok: false, errorCode: "UNLISTED_FILES_PRESENT", detail: extra.slice(0, 5) };
  if (!manifest.zipFilename || /[\\/]/.test(manifest.zipFilename)) return { ok: false, errorCode: "ZIP_FILENAME_INVALID" };
  if (snapshot) {
    const bad = checkResponses(entries, root, run.scope, snapshot, fingerprints.participantsHash);
    if (bad) return { ok: false, errorCode: "PACKAGE_RESPONSES_MISMATCH", detail: bad };
  }
  return { ok: true, manifest, entryCount: Object.keys(entries).length };
}

const WIDE_FILE = "02_원자료_가명/참여자별_이진유사성행렬_상삼각.csv";
const SUMMARY_FILE = "02_원자료_가명/참여자별_묶음요약.csv";
const S_FILE = "04_행렬/S_집단유사성빈도_대각선N.csv";

function allowedCountries(scope: string): Set<string> {
  return scope === "ALL" ? new Set(["KR", "JP"]) : new Set([scope]);
}

/**
 * Every participant-level file of the package must describe exactly the participants stored with the run:
 *  - response table: same pseudonymous ids, countries and the full pile assignment (exactly one row per participant and
 *    statement, no duplicates, no missing rows — compared by index over dense arrays);
 *  - wide binary-similarity table and participant summary: the same id/country set; the wide table's bits must equal the
 *    similarity implied by the stored assignments;
 *  - the S matrix file must equal S recomputed from the stored participants.
 * (The .xlsx copy of the responses is only pinned by the manifest hash.)
 */
function checkResponses(entries: Record<string, Uint8Array>, root: string, scope: string, snap: RunSnapshotForPackage, expectedHash: string): string | null {
  if (canonicalHash(snap.participants) !== snap.participantsHash || snap.participantsHash !== expectedHash) return "stored participant records do not reproduce the participants fingerprint";
  const dec = new TextDecoder();
  const need = (rel: string) => entries[root + rel];
  // parseCsv drops a bare CR outside quotes, which other CSV readers treat as a row break: reject it so every reader sees the same rows
  for (const rel of [RESPONSE_FILE, WIDE_FILE, SUMMARY_FILE, S_FILE]) if (entries[root + rel] && /\r(?!\n)/.test(dec.decode(entries[root + rel]))) return "a participant-level table contains a bare carriage return";
  const expected = new Map(snap.participants.map((p) => [p.pid, p]));
  const allowed = allowedCountries(scope);
  const nStatements = snap.participants[0]?.assignment.length ?? 0;

  // ---- response table
  const resp = need(RESPONSE_FILE);
  if (!resp) return "response table missing";
  const rows = parseCsv(dec.decode(resp));
  const h = rows[0] ?? [];
  const ix = { pid: h.indexOf("가명ID"), country: h.indexOf("국가"), st: h.indexOf("문항번호"), pile: h.indexOf("묶음번호(참여자 내)") };
  if (Object.values(ix).some((i) => i < 0)) return "response table header unexpected";
  const got = new Map<string, { country: string; a: (number | undefined)[]; count: number }>();
  for (const r of rows.slice(1)) {
    if (r.length === 0 || (r.length === 1 && r[0] === "")) continue;
    if (r.length !== h.length) return "response table has a row with an unexpected number of cells";
    const e = got.get(r[ix.pid]) ?? { country: r[ix.country], a: new Array<number | undefined>(nStatements).fill(undefined), count: 0 };
    if (e.country !== r[ix.country]) return "a participant appears with two countries";
    const st = Number(r[ix.st]) - 1;
    if (!Number.isInteger(st) || st < 0 || st >= nStatements) return "response table has an invalid statement number";
    if (e.a[st] !== undefined) return "response table has a duplicate row for a participant and statement";
    e.a[st] = Number(r[ix.pile]) - 1;
    e.count++;
    got.set(r[ix.pid], e);
  }
  if (got.size !== expected.size) return `participant count differs (package ${got.size}, run ${expected.size})`;
  for (const [pid, e] of got) {
    const p = expected.get(pid);
    if (!p) return "package contains a participant that is not part of this run";
    if (!allowed.has(e.country) || e.country !== p.country) return "package contains a country that does not belong to this scope";
    if (e.count !== nStatements) return "a participant does not have exactly one row per statement";
    for (let i = 0; i < nStatements; i++) if (e.a[i] !== p.assignment[i]) return "pile assignments differ from the run's stored records";
  }

  // ---- wide binary-similarity table
  const wide = need(WIDE_FILE);
  if (!wide) return "binary similarity table missing";
  const wr = parseCsv(dec.decode(wide));
  const wh = wr[0] ?? [];
  if (wh[0] !== "가명ID" || wh[1] !== "국가") return "binary similarity table header unexpected";
  if (wh.length !== 2 + (nStatements * (nStatements - 1)) / 2) return "binary similarity table has an unexpected number of columns";
  const seenWide = new Set<string>();
  for (const r of wr.slice(1)) {
    if (r.length === 1 && r[0] === "") continue;
    const p = expected.get(r[0]);
    if (!p || seenWide.has(r[0])) return "binary similarity table has an unknown or duplicate participant";
    seenWide.add(r[0]);
    if (r[1] !== p.country || !allowed.has(r[1])) return "binary similarity table has a wrong country";
    if (r.length !== wh.length) return "binary similarity table has an incomplete row";
    let k = 2;
    for (let i = 0; i < nStatements; i++) for (let j = i + 1; j < nStatements; j++) if (Number(r[k++]) !== (p.assignment[i] === p.assignment[j] ? 1 : 0)) return "binary similarity bits differ from the run's stored assignments";
  }
  if (seenWide.size !== expected.size) return "binary similarity table does not list every participant";

  // ---- participant summary
  const summ = need(SUMMARY_FILE);
  if (!summ) return "participant summary missing";
  const sr = parseCsv(dec.decode(summ));
  const si = { pid: (sr[0] ?? []).indexOf("가명 ID"), country: (sr[0] ?? []).indexOf("국가") };
  if (si.pid < 0 || si.country < 0) return "participant summary header unexpected";
  const seenSum = new Set<string>();
  for (const r of sr.slice(1)) {
    if (r.length === 1 && r[0] === "") continue;
    const p = expected.get(r[si.pid]);
    if (!p || seenSum.has(r[si.pid]) || r[si.country] !== p.country) return "participant summary has an unknown, duplicate or wrongly attributed participant";
    seenSum.add(r[si.pid]);
  }
  if (seenSum.size !== expected.size) return "participant summary does not list every participant";

  // ---- S matrix
  const sm = need(S_FILE);
  if (!sm) return "S matrix missing";
  const smr = parseCsv(dec.decode(sm)).filter((r) => !(r.length === 1 && r[0] === ""));
  if (smr.length !== nStatements + 1) return "S matrix has an unexpected size";
  for (let i = 0; i < nStatements; i++)
    for (let j = 0; j < nStatements; j++) {
      let c = 0;
      for (const p of snap.participants) if (p.assignment[i] === p.assignment[j]) c++;
      if (Number(smr[i + 1][j + 1]) !== c) return "S matrix differs from the matrix implied by the stored participants";
    }
  return null;
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE_LIKE = /(?<![\d.])0\d{1,4}-\d{1,4}-\d{4}(?!\d)/; // 010-1234-5678, 090-1234-5678, 03-1234-5678 ...

/**
 * Personal-data guard run on every upload: no participant name, phone number, real session id or admin token
 * (taken from the live database) may occur in any text file of the package — including the text parts inside .xlsx/.docx
 * files; e-mail addresses and phone-number patterns (Korean and Japanese forms) are rejected too, because pile names are
 * free text typed by participants; digit-only names / phone endings may not appear as a whole CSV cell in the participant
 * response folder. Only counts are reported, never the values.
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
  const findings = { name: 0, phone: 0, sessionId: 0, adminToken: 0, digitOnlyIdentifierCell: 0, phonePattern: 0, email: 0, unreadableOfficeFile: 0 };
  const dec = new TextDecoder("utf-8", { fatal: false });
  const scanText = (path: string, text: string) => {
    for (const n of names) if (text.includes(n)) findings.name++;
    for (const p of phones) if (text.includes(p)) findings.phone++;
    for (const id of ids) if (text.includes(id)) findings.sessionId++;
    if (project?.adminToken && text.includes(project.adminToken)) findings.adminToken++;
    if (PHONE_LIKE.test(text)) findings.phonePattern++;
    if (EMAIL.test(text)) findings.email++;
    // Digit-only identifiers (a 4-digit code used as a name, or the last 4 digits of a phone) are only meaningful to look for
    // in the participant response files; elsewhere the same digits are ordinary numbers (iteration counts, coordinates ...).
    if (path.toLowerCase().endsWith(".csv") && path.includes("02_원자료_가명") && digitsLong.size > 0) {
      const cells = new Set<string>();
      for (const line of text.split(/\r?\n/)) for (const c of line.split(",")) cells.add(c.replace(/^"|"$/g, "").trim());
      for (const d of digitsLong) if (cells.has(d)) findings.digitOnlyIdentifierCell++;
    }
  };
  for (const [path, data] of Object.entries(entries)) {
    if (TEXT_EXT.test(path)) scanText(path, dec.decode(data));
    else if (OFFICE_EXT.test(path)) {
      // an .xlsx/.docx is itself a ZIP of XML parts: scan their text so names/labels cannot hide inside them
      try {
        const inner = unzipSync(data, { filter: (f) => f.originalSize < 50 * 1024 * 1024 });
        for (const [ip, idata] of Object.entries(inner)) if (/\.(xml|rels)$/i.test(ip)) scanText(`${path}!${ip}`, dec.decode(idata));
      } catch {
        findings.unreadableOfficeFile++; // an office file this scanner cannot open cannot be shown to be clean: reject
      }
    }
  }
  return { clean: Object.values(findings).every((v) => v === 0), findings };
}
