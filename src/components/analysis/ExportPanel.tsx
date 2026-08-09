"use client";

import { useState } from "react";
import { buildCsvFiles } from "@/lib/analysis/view/csvBuilders";
import { buildMap2DSvg, build3DSvg, buildDendrogramSvg } from "@/lib/analysis/view/svgFigures";
import { buildStandaloneHtml, buildQuadrantStandaloneHtml, build3DStandaloneHtml } from "@/lib/analysis/view/htmlBuilder";
import { buildReadmeText } from "@/lib/analysis/view/readmeBuilder";
import { buildMapPoints2D, projectPoints3D, type MapPoint2D } from "@/lib/analysis/view/figureModel";
import { svgStringToPngBlob, downloadBlob, buildExportFilename, buildFinalZipBundle } from "@/lib/analysis/view/exportClient";
import { isFinalZipAllowed } from "@/lib/analysis/view/uiState";
import type { ExportPayload } from "@/lib/analysis/view/exportPayload";

function mapPointsFromPayload(payload: ExportPayload, dimension: number): MapPoint2D[] {
  const dim = payload.dimensions.find((d) => d.dimension === dimension);
  if (!dim?.coordinates) return [];
  return payload.statements.map((s, i) => ({
    statementId: s.id,
    order: s.order,
    x: dim.coordinates![i][0],
    y: dim.coordinates![i][1],
    clusterIndex: payload.clusters?.assignments.find((a) => a.statementId === s.id)?.clusterIndex ?? null,
  }));
}

export function ExportPanel({
  payload,
  safeSlug,
  showQuadrantLines,
}: {
  payload: ExportPayload;
  safeSlug: string;
  showQuadrantLines: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The payload passed in IS the export snapshot every builder below reads
  // from — deriving status here (instead of accepting it as a separate
  // prop) makes it structurally impossible for a caller to gate the
  // official ZIP on a different, possibly-stale status source (e.g. a
  // separately-refreshed interpretations list) than the one the ZIP's own
  // contents were built from.
  const interpretationStatus = payload.meta.interpretationStatus;
  const isDraft = interpretationStatus !== "FINALIZED";
  const finalZipAllowed = isFinalZipAllowed(interpretationStatus);

  // Single researcher-entered string, mirroring the same convention already
  // used for the live preview (AnalysisPanel.tsx maps it to positiveX only)
  // — never split or auto-assigned to other axis directions.
  const axisLabelsOption = payload.meta.axisLabels ? { positiveX: payload.meta.axisLabels } : null;

  function build2dSvg() {
    const points2d = mapPointsFromPayload(payload, payload.meta.primaryMapDimension);
    const scaled = buildMapPoints2D(points2d);
    return buildMap2DSvg(scaled, points2d, { showQuadrantLines, axisLabels: axisLabelsOption, draft: isDraft });
  }

  function buildQuadrantSvg() {
    const points2d = mapPointsFromPayload(payload, payload.meta.primaryMapDimension);
    const scaled = buildMapPoints2D(points2d);
    return buildMap2DSvg(scaled, points2d, {
      showQuadrantLines: true,
      axisLabels: axisLabelsOption,
      quadrantCaption: payload.meta.quadrantLabels,
      draft: isDraft,
    });
  }

  function build3dSvgAndView() {
    const dim3d = payload.dimensions.find((d) => d.dimension === 3 && d.coordinates);
    if (!dim3d?.coordinates || !payload.meta.view3d) return null;
    const points3d = payload.statements.map((s, i) => ({
      statementId: s.id,
      order: s.order,
      x: dim3d.coordinates![i][0],
      y: dim3d.coordinates![i][1],
      z: dim3d.coordinates![i][2],
    }));
    const scaled3d = projectPoints3D(points3d, payload.meta.view3d);
    return build3DSvg(scaled3d, payload.meta.view3d, isDraft);
  }

  function buildDendrogram(): string | null {
    if (!payload.ward) return null;
    const labels = payload.statements.map((s) => String(s.order + 1));
    return buildDendrogramSvg(payload.ward.linkage, payload.ward.originalCount, labels);
  }

  const has3d = payload.dimensions.some((d) => d.dimension === 3 && d.dimensionStatus === "COMPLETED" && d.coordinates) && payload.meta.view3d;

  async function withBusy(key: string, fn: () => Promise<void>) {
    setError(null);
    setBusy(key);
    try {
      await fn();
    } catch {
      setError("내보내기 중 오류가 발생했습니다.");
    } finally {
      setBusy(null);
    }
  }

  const filename = (ext: string) => buildExportFilename(safeSlug, payload.meta.scope, payload.meta.runId, ext, payload.meta.exportGeneratedAt);

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
      {isDraft && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          DRAFT 해석본입니다. 최종 확정 전에는 참고용으로만 사용하세요.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy !== null}
          onClick={() =>
            withBusy("csv", async () => {
              const files = buildCsvFiles(payload);
              for (const f of files) downloadBlob(f.filename, new Blob([f.content], { type: "text/csv;charset=utf-8;" }));
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          {busy === "csv" ? "생성 중..." : "CSV 다운로드"}
        </button>

        <button
          disabled={busy !== null}
          onClick={() =>
            withBusy("svg", async () => {
              const blob = new Blob([build2dSvg()], { type: "image/svg+xml;charset=utf-8" });
              downloadBlob(filename("svg"), blob);
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          {busy === "svg" ? "생성 중..." : "2D SVG 다운로드"}
        </button>

        <button
          disabled={busy !== null}
          onClick={() =>
            withBusy("png", async () => {
              const blob = await svgStringToPngBlob(build2dSvg());
              downloadBlob(filename("png"), blob);
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          {busy === "png" ? "생성 중..." : "2D PNG 다운로드"}
        </button>

        <button
          disabled={busy !== null}
          onClick={() =>
            withBusy("html", async () => {
              const html = buildStandaloneHtml(payload, build2dSvg(), isDraft, buildDendrogram());
              downloadBlob(filename("html"), new Blob([html], { type: "text/html;charset=utf-8" }));
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          {busy === "html" ? "생성 중..." : "standalone HTML 다운로드"}
        </button>

        <button
          disabled={busy !== null}
          onClick={() =>
            withBusy("qsvg", async () => {
              const blob = new Blob([buildQuadrantSvg()], { type: "image/svg+xml;charset=utf-8" });
              downloadBlob(filename("quadrant.svg"), blob);
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          {busy === "qsvg" ? "생성 중..." : "사분면 SVG 다운로드"}
        </button>

        <button
          disabled={busy !== null}
          onClick={() =>
            withBusy("qpng", async () => {
              const blob = await svgStringToPngBlob(buildQuadrantSvg());
              downloadBlob(filename("quadrant.png"), blob);
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          {busy === "qpng" ? "생성 중..." : "사분면 PNG 다운로드"}
        </button>

        <button
          disabled={busy !== null}
          onClick={() =>
            withBusy("qhtml", async () => {
              const html = buildQuadrantStandaloneHtml(payload, buildQuadrantSvg(), isDraft);
              downloadBlob(filename("quadrant.html"), new Blob([html], { type: "text/html;charset=utf-8" }));
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          {busy === "qhtml" ? "생성 중..." : "사분면 HTML 다운로드"}
        </button>

        {has3d && (
          <>
            <button
              disabled={busy !== null}
              onClick={() =>
                withBusy("3dsvg", async () => {
                  const svg3d = build3dSvgAndView();
                  if (!svg3d) return;
                  downloadBlob(filename("3d.svg"), new Blob([svg3d], { type: "image/svg+xml;charset=utf-8" }));
                })
              }
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              {busy === "3dsvg" ? "생성 중..." : "3D SVG 다운로드"}
            </button>
            <button
              disabled={busy !== null}
              onClick={() =>
                withBusy("3dpng", async () => {
                  const svg3d = build3dSvgAndView();
                  if (!svg3d) return;
                  const blob = await svgStringToPngBlob(svg3d);
                  downloadBlob(filename("3d.png"), blob);
                })
              }
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              {busy === "3dpng" ? "생성 중..." : "3D PNG 다운로드"}
            </button>
            <button
              disabled={busy !== null}
              onClick={() =>
                withBusy("3dhtml", async () => {
                  const svg3d = build3dSvgAndView();
                  if (!svg3d) return;
                  const html = build3DStandaloneHtml(payload, svg3d, isDraft);
                  downloadBlob(filename("3d.html"), new Blob([html], { type: "text/html;charset=utf-8" }));
                })
              }
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              {busy === "3dhtml" ? "생성 중..." : "3D HTML 다운로드"}
            </button>
          </>
        )}

        <button
          disabled={busy !== null || !finalZipAllowed}
          title={finalZipAllowed ? undefined : "최종 해석본 확정 후 이용 가능합니다."}
          onClick={() =>
            withBusy("zip", async () => {
              const csvFiles = buildCsvFiles(payload);
              const svg2d = build2dSvg();
              const png2d = await svgStringToPngBlob(svg2d);
              const html = buildStandaloneHtml(payload, svg2d, isDraft, buildDendrogram());
              const qsvg = buildQuadrantSvg();
              const qpng = await svgStringToPngBlob(qsvg);
              const qhtml = buildQuadrantStandaloneHtml(payload, qsvg, isDraft);
              const readme = buildReadmeText(payload);

              const entries: { path: string; content: string | Uint8Array }[] = [
                ...csvFiles.map((f) => ({ path: f.filename, content: f.content })),
                { path: "map_2d.svg", content: svg2d },
                { path: "map_2d.png", content: new Uint8Array(await png2d.arrayBuffer()) },
                { path: "map_2d.html", content: html },
                { path: "map_2d_quadrants.svg", content: qsvg },
                { path: "map_2d_quadrants.png", content: new Uint8Array(await qpng.arrayBuffer()) },
                { path: "map_2d_quadrants.html", content: qhtml },
                { path: "README.txt", content: readme },
              ];

              const svg3d = build3dSvgAndView();
              if (svg3d) {
                const png3d = await svgStringToPngBlob(svg3d);
                const html3d = build3DStandaloneHtml(payload, svg3d, isDraft);
                entries.push({ path: "map_3d.svg", content: svg3d });
                entries.push({ path: "map_3d.png", content: new Uint8Array(await png3d.arrayBuffer()) });
                entries.push({ path: "map_3d.html", content: html3d });
              }

              const zipBlob = buildFinalZipBundle(entries, interpretationStatus);
              downloadBlob(filename("zip"), zipBlob);
            })
          }
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy === "zip" ? "묶음 생성 중..." : "공식 결과 ZIP 다운로드 (FINALIZED 전용)"}
        </button>
      </div>
    </div>
  );
}
