import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";

type RunLike = { id: string; scope: string; inputSnapshot: string; resultBundle: string | null };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const esc = (v: string | number) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export const RESPONSE_PATH = "02_원자료_가명/참여자별_분류응답표.csv";
export const WIDE_PATH = "02_원자료_가명/참여자별_이진유사성행렬_상삼각.csv";
export const SUMMARY_PATH = "02_원자료_가명/참여자별_묶음요약.csv";
export const S_PATH = "04_행렬/S_집단유사성빈도_대각선N.csv";

const csv = (rows: (string | number)[][]) => strToU8("\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n");

type RowsMutator = (rows: (string | number)[][]) => void;
/** The other participant-level files exactly as the package builder writes them, from the run's stored snapshot. */
export function participantFilesFor(run: RunLike, mutate?: { wide?: RowsMutator; summary?: RowsMutator; s?: RowsMutator }): Record<string, Uint8Array> {
  const snap = JSON.parse(run.inputSnapshot) as { participants: { pid: string; country: string; assignment: number[] }[] };
  const n = snap.participants[0].assignment.length;
  const id = (i: number) => `S${String(i + 1).padStart(2, "0")}`;
  const pairs: string[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push(`${id(i)}-${id(j)}`);
  const wide: (string | number)[][] = [["가명ID", "국가", ...pairs]];
  for (const p of snap.participants) {
    const bits: number[] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) bits.push(p.assignment[i] === p.assignment[j] ? 1 : 0);
    wide.push([p.pid, p.country, ...bits]);
  }
  const summary: (string | number)[][] = [["가명 ID", "국가", "묶음 수"], ...snap.participants.map((p) => [p.pid, p.country, new Set(p.assignment).size])];
  const S: (string | number)[][] = [["문항", ...Array.from({ length: n }, (_, i) => id(i))]];
  for (let i = 0; i < n; i++) S.push([id(i), ...Array.from({ length: n }, (_, j) => snap.participants.filter((p) => p.assignment[i] === p.assignment[j]).length)]);
  mutate?.wide?.(wide);
  mutate?.summary?.(summary);
  mutate?.s?.(S);
  return { [`pkg/${WIDE_PATH}`]: csv(wide), [`pkg/${SUMMARY_PATH}`]: csv(summary), [`pkg/${S_PATH}`]: csv(S) };
}

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
export function buildPackageZip(run: RunLike, opts: { files?: Record<string, Uint8Array>; mutate?: (manifest: Record<string, unknown>, files: Record<string, Uint8Array>) => void; zipFilename?: string; extraRawEntries?: Record<string, Uint8Array>; omitResponses?: boolean; extraManifest?: Record<string, unknown> } = {}): Uint8Array {
  const f = JSON.parse(run.resultBundle!).meta.fingerprints;
  const files: Record<string, Uint8Array> = { "pkg/README.txt": strToU8("hello"), [`pkg/${RESPONSE_PATH}`]: responseCsvFor(run), ...participantFilesFor(run), ...(opts.files ?? {}) };
  if (opts.omitResponses) delete files[`pkg/${RESPONSE_PATH}`];
  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    runId: run.id,
    scope: run.scope,
    zipFilename: opts.zipFilename ?? `${run.scope}_분석자료.zip`,
    fingerprints: { participantsHash: f.participantsHash, numericDataHash: f.numericDataHash, parameterHash: f.parameterHash },
    files: Object.entries(files).map(([p, b]) => ({ path: p.replace(/^pkg\//, ""), sha256: sha(b), bytes: b.byteLength })),
  };
  Object.assign(manifest, opts.extraManifest ?? {});
  opts.mutate?.(manifest, files); // may tamper with the manifest or add unlisted files
  return zipSync({ ...files, ...(opts.extraRawEntries ?? {}), "pkg/manifest.json": strToU8(JSON.stringify(manifest)) });
}

export { sha };
