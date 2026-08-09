"use client";

import {
  buildMapPoints2D,
  originInScreenSpace,
  FIGURE_WIDTH,
  FIGURE_HEIGHT,
  type MapPoint2D,
} from "@/lib/analysis/view/figureModel";

function MarkerShape({ cx, cy, r, marker, color }: { cx: number; cy: number; r: number; marker: string; color: string }) {
  const stroke = "#1e293b";
  if (marker === "square") return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={color} stroke={stroke} />;
  if (marker === "triangle") {
    const h = r * 1.2;
    return <polygon points={`${cx},${cy - h} ${cx - h},${cy + h} ${cx + h},${cy + h}`} fill={color} stroke={stroke} />;
  }
  if (marker === "diamond") {
    return (
      <polygon
        points={`${cx},${cy - r * 1.3} ${cx + r * 1.3},${cy} ${cx},${cy + r * 1.3} ${cx - r * 1.3},${cy}`}
        fill={color}
        stroke={stroke}
      />
    );
  }
  return <circle cx={cx} cy={cy} r={r} fill={color} stroke={stroke} />;
}

export function Map2D({
  points,
  showQuadrantLines = false,
  axisLabels,
  draft = false,
}: {
  points: MapPoint2D[];
  showQuadrantLines?: boolean;
  axisLabels?: { positiveX?: string; negativeX?: string; positiveY?: string; negativeY?: string } | null;
  draft?: boolean;
}) {
  const scaled = buildMapPoints2D(points);
  const origin = originInScreenSpace(points);

  return (
    <svg viewBox={`0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}`} width="100%" role="img" aria-label="2D concept map">
      <title>2차원 개념도</title>
      <rect x={0} y={0} width={FIGURE_WIDTH} height={FIGURE_HEIGHT} fill="#ffffff" />
      {origin && showQuadrantLines && (
        <>
          <line x1={0} y1={origin.sy} x2={FIGURE_WIDTH} y2={origin.sy} stroke="#cbd5e1" strokeDasharray="4,4" />
          <line x1={origin.sx} y1={0} x2={origin.sx} y2={FIGURE_HEIGHT} stroke="#cbd5e1" strokeDasharray="4,4" />
        </>
      )}
      {scaled.map((p) => (
        <g key={p.statementId}>
          <MarkerShape cx={p.sx} cy={p.sy} r={6} marker={p.marker} color={p.color} />
          <text x={p.sx + 8} y={p.sy + 4} fontSize={10} fill="#1e293b">
            {p.order + 1}
          </text>
        </g>
      ))}
      {axisLabels?.positiveX && (
        <text x={FIGURE_WIDTH - 10} y={FIGURE_HEIGHT / 2 - 6} textAnchor="end" fontSize={11} fill="#334155">
          {axisLabels.positiveX}
        </text>
      )}
      {axisLabels?.negativeX && (
        <text x={10} y={FIGURE_HEIGHT / 2 - 6} fontSize={11} fill="#334155">
          {axisLabels.negativeX}
        </text>
      )}
      {axisLabels?.positiveY && (
        <text x={FIGURE_WIDTH / 2 + 6} y={14} fontSize={11} fill="#334155">
          {axisLabels.positiveY}
        </text>
      )}
      {axisLabels?.negativeY && (
        <text x={FIGURE_WIDTH / 2 + 6} y={FIGURE_HEIGHT - 6} fontSize={11} fill="#334155">
          {axisLabels.negativeY}
        </text>
      )}
      {draft && (
        <text x={FIGURE_WIDTH - 12} y={FIGURE_HEIGHT - 12} textAnchor="end" fontSize={12} fill="#b45309" opacity={0.85}>
          DRAFT — 연구자 해석 미확정
        </text>
      )}
    </svg>
  );
}
