import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";

type RunLike = { id: string; scope: string; inputSnapshot: string; resultBundle: string | null };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const esc = (v: string | number) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export const RESPONSE_PATH = "02_원자료_가명/참여자별_분류응답표.csv";

/** The participant response table exactly as the package builder writes it, from the run's own stored snapshot. */
export function responseCsvFor(run: RunLike, mutateRows?: (rows: (string | number)[][]) => void): Uint8Array {
  const snap = JSON.parse(run.inputSnapshot) as { participants: { pid: string; country: string; assignment: number[] }[] };
  const rows: (string | number)[][] = [];
  for (const p of snap.participants) p.assignment.forEach((g, i) => rows.push([p.pid, p.country, "2026-01-01 00:00:00", `S${String(i + 1).padStart(2, "0")}`, i + 1, g + 1, ""]));
  mutateRows?.(rows);
  const header = ["가명ID", "국가", "제출시각(KST)", "진술문", "문항번호", "묶음번호(참여자 내)", "묶음 이름(참여자 입력)"];
  return strToU8("﻿" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n");
}

/**
 * A minimal but valid package for a run (manifest + README + the real response table).
 * `files` are the entries under the single root folder `pkg/`; `mutate` may change the manifest/files before zipping.
 */
export function buildPackageZip(run: RunLike, opts: { files?: Record<string, Uint8Array>; mutate?: (manifest: Record<string, unknown>, files: Record<string, Uint8Array>) => void; zipFilename?: string; extraRawEntries?: Record<string, Uint8Array>; omitResponses?: boolean } = {}): Uint8Array {
  const f = JSON.parse(run.resultBundle!).meta.fingerprints;
  const files: Record<string, Uint8Array> = { "pkg/README.txt": strToU8("hello"), [`pkg/${RESPONSE_PATH}`]: responseCsvFor(run), ...(opts.files ?? {}) };
  if (opts.omitResponses) delete files[`pkg/${RESPONSE_PATH}`];
  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    runId: run.id,
    scope: run.scope,
    zipFilename: opts.zipFilename ?? `${run.scope}_분석자료.zip`,
    fingerprints: { participantsHash: f.participantsHash, numericDataHash: f.numericDataHash, parameterHash: f.parameterHash },
    files: Object.entries(files).map(([p, b]) => ({ path: p.replace(/^pkg\//, ""), sha256: sha(b), bytes: b.byteLength })),
  };
  opts.mutate?.(manifest, files); // may tamper with the manifest or add unlisted files
  return zipSync({ ...files, ...(opts.extraRawEntries ?? {}), "pkg/manifest.json": strToU8(JSON.stringify(manifest)) });
}

export { sha };
