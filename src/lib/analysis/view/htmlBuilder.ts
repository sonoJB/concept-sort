import { escapeXml } from "./svgFigures";
import type { ExportPayload } from "./exportPayload";

const METHOD_NOTICE_ITEMS = [
  "2차원 MDS가 대표 개념도이며, 3차원 결과는 보조자료입니다.",
  "Stress가 더 낮다는 이유만으로 3차원을 자동으로 최종 선택하지 않습니다.",
  "MDS 축의 방향·부호·회전·반사에는 본질적 의미가 없습니다.",
  "축의 의미는 연구자가 해석을 통해 부여합니다.",
  "Stress에 보편적인 절대 합격/불합격 절단점을 임의로 적용하지 않습니다.",
  "Ward 군집분석은 2차원 MDS 좌표의 Euclidean geometry를 기반으로 수행됩니다.",
  "계층적 군집분석(HCA)이 MDS 좌표를 생성하는 것은 아닙니다.",
];

type FigureSection = { heading: string; svg: string; note?: string };

/**
 * Shared self-contained .html shell: no external CSS/JS/CDN, no <script>
 * tag (no interactivity needed), every researcher/statement string passed
 * through escapeXml before entering markup. One or more figure sections are
 * embedded (2D base map, quadrant overlay, or 3D supplementary map), each
 * always followed by the same reproducibility metadata table.
 */
function buildStandaloneHtmlShell(
  payload: ExportPayload,
  figures: FigureSection[],
  draft: boolean,
  dendrogramSvg: string | null
): string {
  const m = payload.meta;
  const title = `개념도 분석 결과 — ${escapeXml(m.projectSlug)} (${escapeXml(m.scope)})`;

  const clusterLabelsHtml =
    payload.interpretationLabels.length > 0
      ? `<h2>군집 라벨</h2><table><thead><tr><th>군집</th><th>언어</th><th>라벨</th><th>메모</th></tr></thead><tbody>${payload.interpretationLabels
          .map(
            (l) =>
              `<tr><td>${l.clusterIndex}</td><td>${escapeXml(l.language)}</td><td>${escapeXml(l.label)}</td><td>${escapeXml(l.memo ?? "")}</td></tr>`
          )
          .join("")}</tbody></table>`
      : "";

  const figuresHtml = figures
    .map((f) => `<h2>${escapeXml(f.heading)}</h2>${f.note ? `<p class="meta">${escapeXml(f.note)}</p>` : ""}${f.svg}`)
    .join("\n");

  return `<!doctype html>
<html lang="${m.exportLanguage}">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
body { font-family: sans-serif; max-width: 840px; margin: 32px auto; padding: 0 16px; color: #1e293b; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; }
.notice { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; font-size: 12px; color: #475569; }
.draft { color: #b45309; font-weight: bold; }
.meta { font-size: 12px; color: #64748b; }
</style>
</head>
<body>
<h1>${title}</h1>
${draft ? '<p class="draft">DRAFT — 연구자 해석 미확정</p>' : ""}
<p class="meta">Run ID: ${escapeXml(m.runId)} · 실행: ${escapeXml(m.startedAt)} ~ ${escapeXml(m.finishedAt ?? "")} · N=${m.includedParticipantCount} (KR ${m.nKr} / JP ${m.nJp})</p>

<div class="notice">
<strong>연구방법론 안내</strong>
<ul>${METHOD_NOTICE_ITEMS.map((t) => `<li>${escapeXml(t)}</li>`).join("")}</ul>
</div>

${figuresHtml}

${dendrogramSvg ? `<h2>Ward 군집 dendrogram (2차원 MDS 좌표 기반)</h2>${dendrogramSvg}` : ""}

${clusterLabelsHtml}

<h2>재현성 metadata</h2>
<table>
<tbody>
<tr><td>algorithmVersion</td><td>${escapeXml(m.algorithmVersion)}</td></tr>
<tr><td>engineSourceCommitSha</td><td>${escapeXml(m.engineSourceCommitSha)}</td></tr>
<tr><td>validationBaselineSha</td><td>${escapeXml(m.validationBaselineSha)}</td></tr>
<tr><td>parameterHash</td><td>${escapeXml(m.parameterHash)}</td></tr>
<tr><td>numericDataHash</td><td>${escapeXml(m.numericDataHash)}</td></tr>
<tr><td>primaryMapDimension</td><td>${m.primaryMapDimension}</td></tr>
<tr><td>wardSourceDimension</td><td>${m.wardSourceDimension} (Ward는 좌표를 생성하지 않으며 이 차원의 MDS 좌표를 입력으로 사용)</td></tr>
<tr><td>selected k</td><td>${m.selectedClusterCount ?? "-"}</td></tr>
<tr><td>interpretation</td><td>${m.interpretationStatus ?? "-"} (v${m.interpretationVersion ?? "-"})</td></tr>
${m.view3d ? `<tr><td>3D view (azimuth/elevation)</td><td>${m.view3d.azimuthDeg}° / ${m.view3d.elevationDeg}°</td></tr>` : ""}
<tr><td>exportGeneratedAt</td><td>${escapeXml(m.exportGeneratedAt)}</td></tr>
</tbody>
</table>
</body>
</html>`;
}

/** Base 2D representative concept map — standalone HTML. */
export function buildStandaloneHtml(
  payload: ExportPayload,
  mapSvg: string,
  draft: boolean,
  dendrogramSvg: string | null
): string {
  return buildStandaloneHtmlShell(payload, [{ heading: "2차원 대표 개념도", svg: mapSvg }], draft, dendrogramSvg);
}

/** Quadrant supplementary overlay — same coordinates/clusters/axis labels as the base 2D map, zero always joining the positive side. */
export function buildQuadrantStandaloneHtml(payload: ExportPayload, quadrantSvg: string, draft: boolean): string {
  return buildStandaloneHtmlShell(
    payload,
    [
      {
        heading: "사분면 보조 개념도",
        svg: quadrantSvg,
        note: "이 사분면 구분은 연구자가 부여한 심리적 의미를 자동으로 나타내지 않는 보조자료입니다.",
      },
    ],
    draft,
    null
  );
}

/** 3D supplementary map — only ever generated when the 3D dimension COMPLETED; never replaces the 2D map as the representative figure. */
export function build3DStandaloneHtml(payload: ExportPayload, svg3d: string, draft: boolean): string {
  const m = payload.meta;
  return buildStandaloneHtmlShell(
    payload,
    [
      {
        heading: "3차원 보조 개념도",
        svg: svg3d,
        note: m.view3d
          ? `보조자료입니다 (azimuth=${m.view3d.azimuthDeg}°, elevation=${m.view3d.elevationDeg}°). 2차원 대표 개념도를 대체하지 않습니다.`
          : "보조자료입니다. 2차원 대표 개념도를 대체하지 않습니다.",
      },
    ],
    draft,
    null
  );
}
