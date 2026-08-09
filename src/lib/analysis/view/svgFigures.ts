import { FIGURE_WIDTH, FIGURE_HEIGHT, type ScaledPoint2D, type ScaledPoint3D, originInScreenSpace, type MapPoint2D } from "./figureModel";

/** XML/HTML text-node escaping — every piece of researcher- or statement-originated text passes through this before entering SVG/HTML markup. Never use dangerouslySetInnerHTML with unescaped text. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function markerShape(cx: number, cy: number, r: number, marker: ScaledPoint2D["marker"], color: string): string {
  switch (marker) {
    case "circle":
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="#1e293b" stroke-width="1" />`;
    case "square":
      return `<rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" fill="${color}" stroke="#1e293b" stroke-width="1" />`;
    case "triangle": {
      const h = r * 1.2;
      return `<polygon points="${cx},${cy - h} ${cx - h},${cy + h} ${cx + h},${cy + h}" fill="${color}" stroke="#1e293b" stroke-width="1" />`;
    }
    case "diamond":
      return `<polygon points="${cx},${cy - r * 1.3} ${cx + r * 1.3},${cy} ${cx},${cy + r * 1.3} ${cx - r * 1.3},${cy}" fill="${color}" stroke="#1e293b" stroke-width="1" />`;
  }
}

const METHOD_FOOTER =
  "2차원 MDS가 대표 개념도이며, 축의 방향·부호·회전·반사에는 본질적 의미가 없습니다. 사분면·군집 의미는 연구자 해석에 따릅니다.";

export type Map2DSvgOptions = {
  title?: string;
  showQuadrantLines?: boolean;
  axisLabels?: { positiveX?: string; negativeX?: string; positiveY?: string; negativeY?: string } | null;
  quadrantLabels?: { q1?: string; q2?: string; q3?: string; q4?: string } | null;
  /**
   * Single researcher-authored quadrant annotation (AnalysisInterpretation.quadrantLabels
   * is one free-text field, not four per-quadrant slots — no delimiter
   * convention exists anywhere in this codebase to split it into q1..q4, so
   * it is never forced into the structured quadrantLabels shape above;
   * rendered as one caption instead). Only meaningful when showQuadrantLines
   * is also set.
   */
  quadrantCaption?: string | null;
  draft?: boolean;
  footer?: string;
};

export function buildMap2DSvg(points: ScaledPoint2D[], rawPoints: MapPoint2D[], options: Map2DSvgOptions = {}): string {
  const origin = originInScreenSpace(rawPoints);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}" width="${FIGURE_WIDTH}" height="${FIGURE_HEIGHT}" role="img">`
  );
  parts.push(`<title>${escapeXml(options.title ?? "2D concept map")}</title>`);
  parts.push(`<rect x="0" y="0" width="${FIGURE_WIDTH}" height="${FIGURE_HEIGHT}" fill="#ffffff" />`);

  if (origin && options.showQuadrantLines) {
    parts.push(
      `<line x1="0" y1="${origin.sy}" x2="${FIGURE_WIDTH}" y2="${origin.sy}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,4" />`
    );
    parts.push(
      `<line x1="${origin.sx}" y1="0" x2="${origin.sx}" y2="${FIGURE_HEIGHT}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,4" />`
    );
  }

  for (const p of points) {
    parts.push(markerShape(p.sx, p.sy, 6, p.marker, p.color));
    parts.push(
      `<text x="${p.sx + 8}" y="${p.sy + 4}" font-size="10" font-family="sans-serif" fill="#1e293b">${p.order + 1}</text>`
    );
  }

  if (options.axisLabels) {
    const { positiveX, negativeX, positiveY, negativeY } = options.axisLabels;
    if (positiveX) parts.push(`<text x="${FIGURE_WIDTH - 10}" y="${FIGURE_HEIGHT / 2 - 6}" text-anchor="end" font-size="11" font-family="sans-serif" fill="#334155">${escapeXml(positiveX)}</text>`);
    if (negativeX) parts.push(`<text x="10" y="${FIGURE_HEIGHT / 2 - 6}" font-size="11" font-family="sans-serif" fill="#334155">${escapeXml(negativeX)}</text>`);
    if (positiveY) parts.push(`<text x="${FIGURE_WIDTH / 2 + 6}" y="14" font-size="11" font-family="sans-serif" fill="#334155">${escapeXml(positiveY)}</text>`);
    if (negativeY) parts.push(`<text x="${FIGURE_WIDTH / 2 + 6}" y="${FIGURE_HEIGHT - 6}" font-size="11" font-family="sans-serif" fill="#334155">${escapeXml(negativeY)}</text>`);
  }

  if (options.showQuadrantLines && options.quadrantCaption) {
    parts.push(
      `<text x="12" y="20" font-size="11" font-family="sans-serif" fill="#334155">${escapeXml(options.quadrantCaption)}</text>`
    );
  }

  if (options.draft) {
    parts.push(
      `<text x="${FIGURE_WIDTH - 12}" y="${FIGURE_HEIGHT - 12}" text-anchor="end" font-size="12" font-family="sans-serif" fill="#b45309" opacity="0.85">DRAFT — 연구자 해석 미확정</text>`
    );
  }

  parts.push(
    `<text x="12" y="${FIGURE_HEIGHT - 10}" font-size="9" font-family="sans-serif" fill="#64748b">${escapeXml(options.footer ?? METHOD_FOOTER)}</text>`
  );
  parts.push(`</svg>`);
  return parts.join("");
}

export function build3DSvg(points: ScaledPoint3D[], view: { azimuthDeg: number; elevationDeg: number }, draft = false): string {
  const sorted = [...points].sort((a, b) => a.depth - b.depth);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}" width="${FIGURE_WIDTH}" height="${FIGURE_HEIGHT}" role="img">`);
  parts.push(`<title>3D supplementary concept map</title>`);
  parts.push(`<rect x="0" y="0" width="${FIGURE_WIDTH}" height="${FIGURE_HEIGHT}" fill="#ffffff" />`);
  for (const p of sorted) {
    parts.push(`<circle cx="${p.sx}" cy="${p.sy}" r="5" fill="#2a78d6" stroke="#1e293b" stroke-width="1" />`);
    parts.push(`<text x="${p.sx + 7}" y="${p.sy + 3}" font-size="9" font-family="sans-serif" fill="#1e293b">${p.order + 1}</text>`);
  }
  parts.push(
    `<text x="12" y="20" font-size="11" font-family="sans-serif" fill="#b45309">보조자료 (azimuth=${view.azimuthDeg}°, elevation=${view.elevationDeg}°)</text>`
  );
  if (draft) {
    parts.push(`<text x="${FIGURE_WIDTH - 12}" y="${FIGURE_HEIGHT - 12}" text-anchor="end" font-size="12" font-family="sans-serif" fill="#b45309" opacity="0.85">DRAFT — 연구자 해석 미확정</text>`);
  }
  parts.push(`<text x="12" y="${FIGURE_HEIGHT - 10}" font-size="9" font-family="sans-serif" fill="#64748b">${escapeXml(METHOD_FOOTER)}</text>`);
  parts.push(`</svg>`);
  return parts.join("");
}

export type StressPoint = { dimension: number; normalizedStress1: number | null; failed: boolean };

export function buildStressChartSvg(points: StressPoint[]): string {
  const W = 480;
  const H = 260;
  const PAD = 40;
  const completed = points.filter((p) => !p.failed && p.normalizedStress1 !== null);
  const maxStress = Math.max(0.01, ...completed.map((p) => p.normalizedStress1 as number));
  const minDim = Math.min(...points.map((p) => p.dimension));
  const maxDim = Math.max(...points.map((p) => p.dimension));
  const dimRange = Math.max(1, maxDim - minDim);

  function sx(dim: number) {
    return PAD + ((dim - minDim) / dimRange) * (W - PAD * 2);
  }
  function sy(stress: number) {
    return H - PAD - (stress / maxStress) * (H - PAD * 2);
  }

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`);
  parts.push(`<title>Stress by dimension</title>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />`);
  parts.push(`<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#94a3b8" />`);
  parts.push(`<line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="#94a3b8" />`);

  const line = completed
    .sort((a, b) => a.dimension - b.dimension)
    .map((p) => `${sx(p.dimension)},${sy(p.normalizedStress1 as number)}`)
    .join(" ");
  if (completed.length > 1) {
    parts.push(`<polyline points="${line}" fill="none" stroke="#2a78d6" stroke-width="2" />`);
  }
  for (const p of points) {
    const x = sx(p.dimension);
    if (p.failed || p.normalizedStress1 === null) {
      parts.push(`<text x="${x - 4}" y="${H - PAD - 6}" font-size="12" fill="#e34948">×</text>`);
    } else {
      parts.push(`<circle cx="${x}" cy="${sy(p.normalizedStress1)}" r="4" fill="#2a78d6" />`);
    }
    parts.push(`<text x="${x}" y="${H - PAD + 16}" font-size="10" text-anchor="middle" font-family="sans-serif" fill="#334155">${p.dimension}D</text>`);
  }
  parts.push(
    `<text x="${PAD}" y="${H - 6}" font-size="9" font-family="sans-serif" fill="#64748b">Stress 값은 차원 수에 따른 적합도 변화를 검토하기 위한 진단값이며, 단일 보편적 절단점으로 자동 판정하지 않습니다.</text>`
  );
  parts.push(`</svg>`);
  return parts.join("");
}

export type DendrogramLinkageRow = { step: number; leftNode: number; rightNode: number; mergeDistance: number; mergedItemCount: number };

/**
 * Renders the stored Ward linkage as a dendrogram. Never recomputes
 * clustering — draws exactly the persisted linkage rows.
 */
export function buildDendrogramSvg(linkage: DendrogramLinkageRow[], originalCount: number, memberLabels: string[]): string {
  const W = 720;
  const H = 60 + originalCount * 22;
  const PAD_LEFT = 40;
  const PAD_RIGHT = 40;

  // x position per node id (0..originalCount-1 leaves, originalCount.. merged)
  const nodeX = new Map<number, number>();
  const nodeY = new Map<number, number>();
  for (let i = 0; i < originalCount; i++) {
    nodeY.set(i, 60 + i * 22);
  }
  const maxDist = Math.max(1e-9, ...linkage.map((r) => r.mergeDistance));
  function distToX(d: number) {
    return PAD_LEFT + (d / maxDist) * (W - PAD_LEFT - PAD_RIGHT);
  }
  for (let i = 0; i < originalCount; i++) nodeX.set(i, PAD_LEFT);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`);
  parts.push(`<title>Ward dendrogram (2D MDS coordinate basis)</title>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />`);

  for (let i = 0; i < originalCount; i++) {
    const y = nodeY.get(i)!;
    parts.push(`<text x="4" y="${y + 4}" font-size="10" font-family="sans-serif" fill="#1e293b">${escapeXml(memberLabels[i] ?? String(i + 1))}</text>`);
  }

  let nextId = originalCount;
  for (const row of linkage) {
    const leftX = nodeX.get(row.leftNode) ?? PAD_LEFT;
    const rightX = nodeX.get(row.rightNode) ?? PAD_LEFT;
    const leftY = nodeY.get(row.leftNode)!;
    const rightY = nodeY.get(row.rightNode)!;
    const mergeX = distToX(row.mergeDistance);
    const mergeY = (leftY + rightY) / 2;

    parts.push(`<line x1="${leftX}" y1="${leftY}" x2="${mergeX}" y2="${leftY}" stroke="#334155" stroke-width="1.5" />`);
    parts.push(`<line x1="${rightX}" y1="${rightY}" x2="${mergeX}" y2="${rightY}" stroke="#334155" stroke-width="1.5" />`);
    parts.push(`<line x1="${mergeX}" y1="${leftY}" x2="${mergeX}" y2="${rightY}" stroke="#334155" stroke-width="1.5" />`);

    const mergedId = nextId++;
    nodeX.set(mergedId, mergeX);
    nodeY.set(mergedId, mergeY);
  }

  parts.push(
    `<text x="${PAD_LEFT}" y="${H - 8}" font-size="9" font-family="sans-serif" fill="#64748b">Ward 군집분석은 2차원 MDS 좌표의 Euclidean geometry를 기반으로 수행됩니다.</text>`
  );
  parts.push(`</svg>`);
  return parts.join("");
}
