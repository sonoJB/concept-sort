"use client";

import { zipSync, strToU8 } from "fflate";
import { FIGURE_WIDTH, FIGURE_HEIGHT, PNG_SCALE } from "./figureModel";

/** Browser-only: SVG string -> Blob -> Image -> Canvas -> PNG Blob. No server image package involved. */
export function svgStringToPngBlob(
  svg: string,
  width: number = FIGURE_WIDTH,
  height: number = FIGURE_HEIGHT,
  scale: number = PNG_SCALE
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas 2D context unavailable"));
          return;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error("PNG conversion failed"));
        }, "image/png");
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e instanceof Error ? e : new Error("PNG conversion failed"));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to rasterize SVG for PNG export"));
    };
    img.src = url;
  });
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** No PII in the filename — slug/scope/run id (already opaque, not sequential)/timestamp only. */
export function buildExportFilename(safeSlug: string, scope: string, runId: string, ext: string, timestampIso: string): string {
  const runShortId = runId.slice(0, 8);
  const ts = timestampIso.replace(/[:.]/g, "").replace("T", "_").replace("Z", "Z");
  return `concept-map_${safeSlug}_${scope}_${runShortId}_${ts}.${ext}`;
}

export function buildZipBlob(entries: { path: string; content: string | Uint8Array }[]): Blob {
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) {
    files[e.path] = typeof e.content === "string" ? strToU8(e.content) : e.content;
  }
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], { type: "application/zip" });
}

export class OfficialBundleNotFinalizedError extends Error {
  constructor() {
    super("Official final ZIP bundles require a FINALIZED interpretation.");
    this.name = "OfficialBundleNotFinalizedError";
  }
}

/**
 * The domain-level guard for the "공식 결과 ZIP" contract — not just a UI
 * button disable. export-data intentionally serves DRAFT payloads (for
 * individual CSV/SVG/PNG/HTML preview/export), so any code path that calls
 * the ZIP builder directly — bypassing the UI's isFinalZipAllowed() check —
 * would otherwise still be able to produce an "official" bundle from an
 * unfinalized interpretation. This function is the single place that
 * contract is enforced, regardless of caller.
 */
export function buildFinalZipBundle(
  entries: { path: string; content: string | Uint8Array }[],
  interpretationStatus: string | null
): Blob {
  if (interpretationStatus !== "FINALIZED") {
    throw new OfficialBundleNotFinalizedError();
  }
  return buildZipBlob(entries);
}
