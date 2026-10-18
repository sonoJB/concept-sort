"use client";

import { forwardRef, useMemo } from "react";
import type { ClusterSolution } from "@/lib/conceptMap/clusters";
import type { ClusterProposal } from "@/lib/conceptMap/proposals/types";
import { clusterStyle, makeView, markerPath, placeLabels, polygonPath } from "@/lib/conceptMap/mapModel";

export type MapFigureProps = {
  coordinates: number[][];
  solution: ClusterSolution;
  names: ClusterProposal[] | null;
  showQuadrants: boolean;
  showNumbers: boolean;
  showBoundaries: boolean;
  highlightCluster: number | null;
  title: string;
  size?: number;
};

/**
 * Concept map: one point per statement at its MDS coordinate (centred; never moved), same unit length on both
 * axes, cluster = colour + marker shape + faint convex-hull outline. Hull outlines mark cluster membership only —
 * they are not causal paths. Quadrant lines are plain x=0 / y=0 reference lines; quadrants are visual divisions
 * and do not imply four clusters or any meaning of the axes.
 */
export const MapFigure = forwardRef<SVGSVGElement, MapFigureProps>(function MapFigure(props, ref) {
  const { coordinates, solution, names, showQuadrants, showNumbers, showBoundaries, highlightCluster, title } = props;
  const size = props.size ?? 640;
  const view = useMemo(() => makeView(coordinates, size, 52), [coordinates, size]);
  const px = useMemo(() => coordinates.map(([x, y]) => view.toPx(x, y)), [coordinates, view]);
  const labels = useMemo(
    () => placeLabels(px, coordinates.map((_, i) => String(i + 1)), { frame: { x: 4, y: 4, w: size - 8, h: size - 8 } }),
    [px, coordinates, size]
  );
  const dim = (c: number) => (highlightCluster !== null && highlightCluster !== c ? 0.2 : 1);
  const o = view.toPx(0, 0);
  const ticks = useMemo(() => {
    const step = niceStep(view.half / 2.5);
    const out: number[] = [];
    for (let v = step; v < view.half; v += step) out.push(v);
    return { step, values: out };
  }, [view.half]);

  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${size} ${size}`} width="100%" role="img" aria-label={title} style={{ background: "#fff", maxWidth: size }}>
      <title>{title}</title>
      <rect x={view.margin} y={view.margin} width={size - 2 * view.margin} height={size - 2 * view.margin} fill="#fff" stroke="#cbd5e1" strokeWidth={1} />
      {ticks.values.flatMap((v) => [v, -v]).map((v) => (
        <g key={v} stroke="#e2e8f0" strokeWidth={0.6}>
          <line x1={view.toPx(v, 0).x} y1={view.margin} x2={view.toPx(v, 0).x} y2={size - view.margin} />
          <line x1={view.margin} y1={view.toPx(0, v).y} x2={size - view.margin} y2={view.toPx(0, v).y} />
        </g>
      ))}
      {showQuadrants && (
        <g>
          <line x1={o.x} y1={view.margin} x2={o.x} y2={size - view.margin} stroke="#475569" strokeWidth={1.2} strokeDasharray="5 4" />
          <line x1={view.margin} y1={o.y} x2={size - view.margin} y2={o.y} stroke="#475569" strokeWidth={1.2} strokeDasharray="5 4" />
          {[
            { t: "Ⅰ", x: size - view.margin - 14, y: view.margin + 18 },
            { t: "Ⅱ", x: view.margin + 14, y: view.margin + 18 },
            { t: "Ⅲ", x: view.margin + 14, y: size - view.margin - 8 },
            { t: "Ⅳ", x: size - view.margin - 14, y: size - view.margin - 8 },
          ].map((q) => (
            <text key={q.t} x={q.x} y={q.y} textAnchor="middle" fontSize={14} fill="#94a3b8" fontFamily="sans-serif">
              {q.t}
            </text>
          ))}
        </g>
      )}
      {/* axis frame labels (equal unit length on both axes) */}
      <text x={size / 2} y={size - 12} textAnchor="middle" fontSize={13} fill="#334155" fontFamily="sans-serif">
        차원 1
      </text>
      <text x={14} y={size / 2} textAnchor="middle" fontSize={13} fill="#334155" fontFamily="sans-serif" transform={`rotate(-90 14 ${size / 2})`}>
        차원 2
      </text>
      <text x={size - view.margin} y={view.margin - 8} textAnchor="end" fontSize={10} fill="#64748b" fontFamily="sans-serif">
        눈금 간격 {ticks.step} (두 축 동일)
      </text>

      {showBoundaries &&
        solution.clusters.map((c) => {
          const st = clusterStyle(c.cluster);
          const g = c.geometry;
          const op = dim(c.cluster);
          if (g.kind === "polygon")
            return <path key={c.cluster} d={polygonPath(g.hull, view.toPx)} fill={st.color} fillOpacity={0.12 * op} stroke={st.color} strokeOpacity={0.85 * op} strokeWidth={1.6} strokeLinejoin="round" />;
          if (g.kind === "segment" || g.kind === "collinear") {
            const a = view.toPx(g.from[0], g.from[1]);
            const b = view.toPx(g.to[0], g.to[1]);
            return <line key={c.cluster} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={st.color} strokeOpacity={0.55 * op} strokeWidth={9} strokeLinecap="round" />;
          }
          const p = view.toPx(g.point[0], g.point[1]);
          return <circle key={c.cluster} cx={p.x} cy={p.y} r={13} fill={st.color} fillOpacity={0.12 * op} stroke={st.color} strokeOpacity={0.85 * op} strokeWidth={1.6} />;
        })}

      {showNumbers &&
        labels
          .filter((l) => l.leader)
          .map((l) => (
            <line key={`ld${l.index}`} x1={l.anchor.x} y1={l.anchor.y} x2={l.box.x + l.box.w / 2} y2={l.box.y + l.box.h / 2} stroke="#94a3b8" strokeWidth={0.7} opacity={dim(solution.labels[l.index])} />
          ))}

      {coordinates.map((_, i) => {
        const c = solution.labels[i];
        const st = clusterStyle(c);
        return (
          <path key={i} transform={`translate(${px[i].x},${px[i].y})`} d={markerPath(st.marker, 5.2)} fill={st.marker === "ring" || st.marker === "cross" ? (st.marker === "ring" ? "#fff" : st.color) : st.color} stroke={st.color} strokeWidth={st.marker === "ring" ? 2 : 1} opacity={dim(c)}>
            <title>{`S${String(i + 1).padStart(2, "0")} · 군집 ${c}`}</title>
          </path>
        );
      })}

      {showNumbers &&
        labels.map((l) => (
          <text key={`t${l.index}`} x={l.box.x + 2} y={l.box.y + l.box.h - 3} fontSize={11} fontFamily="sans-serif" fill="#0f172a" opacity={dim(solution.labels[l.index])} stroke="#fff" strokeWidth={2.4} paintOrder="stroke">
            {l.text}
          </text>
        ))}

      {showBoundaries &&
        solution.clusters.map((c) => {
          const nm = names?.find((n) => n.cluster === c.cluster)?.nameKo;
          const tag = `${c.cluster}${nm ? ` · ${nm}` : ""} (${c.size})`;
          const pos = view.toPx(c.centroid[0], c.centroid[1]);
          const w = tag.length * 7.2 + 8;
          const x = Math.min(Math.max(pos.x - w / 2, 6), size - w - 6);
          const st = clusterStyle(c.cluster);
          return (
            <g key={`tag${c.cluster}`} opacity={dim(c.cluster)}>
              <rect x={x} y={pos.y - 9} width={w} height={17} rx={3} fill="#fff" fillOpacity={0.82} stroke={st.color} strokeWidth={1} />
              <text x={x + 4} y={pos.y + 3.5} fontSize={11} fontWeight={600} fill={st.color} fontFamily="sans-serif">
                {tag}
              </text>
            </g>
          );
        })}
    </svg>
  );
});

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
