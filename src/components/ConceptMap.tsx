"use client";

import { useMemo, useState } from "react";
import { convexHull, expandPolygon } from "@/lib/convexHull";

export type ConceptPoint = {
  statementId: string;
  text: string;
  x: number;
  y: number;
  clusterId: number;
};

type ScaledPoint = ConceptPoint & { sx: number; sy: number };

const CATEGORICAL = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
];

const WIDTH = 720;
const HEIGHT = 520;
const PADDING = 48;

function colorForCluster(clusterId: number, order: number[]) {
  const rank = order.indexOf(clusterId);
  return CATEGORICAL[rank % CATEGORICAL.length];
}

export function ConceptMap({ points }: { points: ConceptPoint[] }) {
  const [hovered, setHovered] = useState<ScaledPoint | null>(null);
  const [showTable, setShowTable] = useState(false);

  const clusterOrder = useMemo(() => {
    const ids = Array.from(new Set(points.map((p) => p.clusterId)));
    return ids.sort((a, b) => a - b);
  }, [points]);

  const scaled = useMemo(() => {
    if (points.length === 0) return [];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;

    return points.map((p) => ({
      ...p,
      sx: PADDING + ((p.x - minX) / spanX) * (WIDTH - PADDING * 2),
      sy: PADDING + (1 - (p.y - minY) / spanY) * (HEIGHT - PADDING * 2),
    }));
  }, [points]);

  const hulls = useMemo(() => {
    return clusterOrder.map((clusterId) => {
      const members = scaled.filter((p) => p.clusterId === clusterId);
      const hull = convexHull(members.map((p) => ({ x: p.sx, y: p.sy })));
      const expanded = expandPolygon(hull, 18);
      const centroid = members.length
        ? {
            x: members.reduce((s, p) => s + p.sx, 0) / members.length,
            y: members.reduce((s, p) => s + p.sy, 0) / members.length,
          }
        : { x: 0, y: 0 };
      return { clusterId, expanded, centroid, count: members.length };
    });
  }, [clusterOrder, scaled]);

  if (points.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        아직 제출된 카드 소팅 결과가 없습니다.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-3">
          {clusterOrder.map((clusterId, i) => (
            <div key={clusterId} className="flex items-center gap-1.5 text-xs">
              <span
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
                style={{ backgroundColor: CATEGORICAL[i % CATEGORICAL.length] }}
              >
                {i + 1}
              </span>
              <span className="text-slate-600">군집 {i + 1}</span>
            </div>
          ))}
        </div>
        <button
          onClick={() => setShowTable((v) => !v)}
          className="text-xs rounded-md border border-slate-300 px-2.5 py-1 hover:bg-slate-100"
        >
          {showTable ? "지도로 보기" : "표로 보기"}
        </button>
      </div>

      {showTable ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2 font-medium">진술문</th>
                <th className="text-left px-3 py-2 font-medium">군집</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.statementId} className="border-t border-slate-100">
                  <td className="px-3 py-2">{p.text}</td>
                  <td className="px-3 py-2">
                    군집 {clusterOrder.indexOf(p.clusterId) + 1}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative rounded-xl border border-slate-200 bg-white">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="w-full h-auto"
            role="img"
            aria-label="개념도 산점도"
          >
            {hulls.map(({ clusterId, expanded, centroid }, i) => {
              const color = colorForCluster(clusterId, clusterOrder);
              if (expanded.length < 3) return null;
              const d =
                "M " +
                expanded.map((p) => `${p.x},${p.y}`).join(" L ") +
                " Z";
              return (
                <g key={clusterId}>
                  <path d={d} fill={color} fillOpacity={0.1} stroke={color} strokeWidth={2} />
                  <circle cx={centroid.x} cy={centroid.y} r={11} fill={color} />
                  <text
                    x={centroid.x}
                    y={centroid.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={11}
                    fontWeight={700}
                    fill="#ffffff"
                  >
                    {i + 1}
                  </text>
                </g>
              );
            })}

            {scaled.map((p) => {
              const color = colorForCluster(p.clusterId, clusterOrder);
              return (
                <circle
                  key={p.statementId}
                  cx={p.sx}
                  cy={p.sy}
                  r={7}
                  fill={color}
                  stroke="#fcfcfb"
                  strokeWidth={2}
                  onMouseEnter={() => setHovered(p)}
                  onMouseLeave={() => setHovered(null)}
                  style={{ cursor: "pointer" }}
                />
              );
            })}
          </svg>

          {hovered && (
            <div
              className="pointer-events-none absolute max-w-[220px] rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
              style={{
                left: `${(hovered.sx / WIDTH) * 100}%`,
                top: `${(hovered.sy / HEIGHT) * 100}%`,
                transform: "translate(-50%, -130%)",
              }}
            >
              {hovered.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
