"use client";

import { forwardRef } from "react";
import { clusterStyle, markerPath } from "@/lib/conceptMap/mapModel";

const FONT = "sans-serif";

type Box = { w: number; h: number; l: number; r: number; t: number; b: number };
const BOX: Box = { w: 520, h: 360, l: 56, r: 16, t: 28, b: 44 };

function scaleLinear(d0: number, d1: number, r0: number, r1: number) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(+v.toPrecision(12));
  return out;
}

function Frame({ box, title, xLabel, yLabel, xt, yt, xs, ys }: { box: Box; title: string; xLabel: string; yLabel: string; xt: number[]; yt: number[]; xs: (v: number) => number; ys: (v: number) => number }) {
  return (
    <g fontFamily={FONT}>
      <rect x={box.l} y={box.t} width={box.w - box.l - box.r} height={box.h - box.t - box.b} fill="#fff" stroke="#cbd5e1" />
      <text x={box.w / 2} y={16} textAnchor="middle" fontSize={13} fontWeight={600} fill="#0f172a">{title}</text>
      {xt.map((v) => (
        <g key={`x${v}`}>
          <line x1={xs(v)} y1={box.t} x2={xs(v)} y2={box.h - box.b} stroke="#eef2f7" />
          <text x={xs(v)} y={box.h - box.b + 14} textAnchor="middle" fontSize={10} fill="#475569">{fmt(v)}</text>
        </g>
      ))}
      {yt.map((v) => (
        <g key={`y${v}`}>
          <line x1={box.l} y1={ys(v)} x2={box.w - box.r} y2={ys(v)} stroke="#eef2f7" />
          <text x={box.l - 6} y={ys(v) + 3} textAnchor="end" fontSize={10} fill="#475569">{fmt(v)}</text>
        </g>
      ))}
      <text x={(box.l + box.w - box.r) / 2} y={box.h - 8} textAnchor="middle" fontSize={11} fill="#334155">{xLabel}</text>
      <text x={12} y={(box.t + box.h - box.b) / 2} textAnchor="middle" fontSize={11} fill="#334155" transform={`rotate(-90 12 ${(box.t + box.h - box.b) / 2})`}>{yLabel}</text>
    </g>
  );
}

const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(0) : String(+v.toPrecision(4)));

function Svg({ children, w, h, title, svgRef }: { children: React.ReactNode; w: number; h: number; title: string; svgRef: React.Ref<SVGSVGElement> }) {
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={title} style={{ background: "#fff", maxWidth: w }}>
      <title>{title}</title>
      {children}
    </svg>
  );
}

/** Shepard diagram: input δ vs configuration distance (dots) and the monotone disparity step line. */
export const ShepardChart = forwardRef<SVGSVGElement, { delta: number[]; distance: number[]; disparity: number[]; title: string }>(function ShepardChart({ delta, distance, disparity, title }, ref) {
  const box = BOX;
  const xmax = Math.max(...delta) * 1.02;
  const ymax = Math.max(...distance, ...disparity) * 1.05;
  const xs = scaleLinear(0, xmax, box.l, box.w - box.r);
  const ys = scaleLinear(0, ymax, box.h - box.b, box.t);
  const levels = new Map<number, number>();
  delta.forEach((d, i) => levels.set(+d.toFixed(12), disparity[i]));
  const step = [...levels.entries()].sort((a, b) => a[0] - b[0]);
  return (
    <Svg w={box.w} h={box.h} title={title} svgRef={ref}>
      <Frame box={box} title={title} xLabel="입력 비유사성 δ = 1 − S/N" yLabel="배치 거리 / 디스패리티" xt={niceTicks(0, xmax)} yt={niceTicks(0, ymax)} xs={xs} ys={ys} />
      {delta.map((d, i) => (
        <circle key={i} cx={xs(d)} cy={ys(distance[i])} r={1.7} fill="#0072B2" fillOpacity={0.35} />
      ))}
      <polyline fill="none" stroke="#D55E00" strokeWidth={2} points={step.map(([d, v]) => `${xs(d)},${ys(v)}`).join(" ")} />
      <g fontFamily={FONT} fontSize={10}>
        <circle cx={box.l + 12} cy={box.t + 12} r={3} fill="#0072B2" />
        <text x={box.l + 20} y={box.t + 15} fill="#334155">배치 거리 d (문항 쌍 {delta.length}개)</text>
        <line x1={box.l + 6} y1={box.t + 28} x2={box.l + 18} y2={box.t + 28} stroke="#D55E00" strokeWidth={2} />
        <text x={box.l + 20} y={box.t + 31} fill="#334155">디스패리티 d̂* (δ 수준별 단조 회귀값, Stress-1 정의)</text>
      </g>
    </Svg>
  );
});

/** Per-iteration objective (raw stress) of the selected solution; the vertical line marks the end of the main run. */
export const IterationChart = forwardRef<SVGSVGElement, { rawStress: number[]; mainRunIterations: number; thinned: boolean; title: string }>(function IterationChart({ rawStress, mainRunIterations, thinned, title }, ref) {
  const box = BOX;
  const n = rawStress.length;
  const xs = scaleLinear(1, Math.max(n, 2), box.l, box.w - box.r);
  const lo = Math.min(...rawStress);
  const hi = Math.max(...rawStress);
  const logY = hi / Math.max(lo, 1e-12) > 8;
  const tr = (v: number) => (logY ? Math.log10(v) : v);
  const ys = scaleLinear(tr(lo) - (tr(hi) - tr(lo)) * 0.04, tr(hi) + (tr(hi) - tr(lo)) * 0.04, box.h - box.b, box.t);
  const yt = logY ? niceTicks(tr(lo), tr(hi), 5).map((p) => p) : niceTicks(lo, hi, 5);
  return (
    <Svg w={box.w} h={box.h} title={title} svgRef={ref}>
      <Frame box={box} title={title} xLabel={`반복 횟수${thinned ? " (표시는 간격 축소)" : ""}`} yLabel={logY ? "raw stress (log10)" : "raw stress"} xt={niceTicks(1, Math.max(n, 2))} yt={yt} xs={xs} ys={(v) => ys(v)} />
      <polyline fill="none" stroke="#0072B2" strokeWidth={1.8} points={rawStress.map((v, i) => `${xs(i + 1)},${ys(tr(v))}`).join(" ")} />
      {mainRunIterations > 0 && mainRunIterations < n && (
        <g fontFamily={FONT} fontSize={10}>
          <line x1={xs(mainRunIterations)} y1={box.t} x2={xs(mainRunIterations)} y2={box.h - box.b} stroke="#D55E00" strokeDasharray="4 3" />
          <text x={xs(mainRunIterations) + 4} y={box.t + 12} fill="#D55E00">← ε=1e-9 수렴 / → ε=1e-12 계속</text>
        </g>
      )}
    </Svg>
  );
});

export type DimPoint = { dimension: number; stress1: number | null; converged: boolean };

export const DimensionChart = forwardRef<SVGSVGElement, { data: DimPoint[]; title: string }>(function DimensionChart({ data, title }, ref) {
  const box = BOX;
  const ok = data.filter((d) => d.stress1 !== null);
  const xs = scaleLinear(Math.min(...data.map((d) => d.dimension)) - 0.3, Math.max(...data.map((d) => d.dimension)) + 0.3, box.l, box.w - box.r);
  const ymax = Math.max(...ok.map((d) => d.stress1 as number)) * 1.1;
  const ys = scaleLinear(0, ymax, box.h - box.b, box.t);
  return (
    <Svg w={box.w} h={box.h} title={title} svgRef={ref}>
      <Frame box={box} title={title} xLabel="차원 수" yLabel="Stress-1 (Kruskal)" xt={data.map((d) => d.dimension)} yt={niceTicks(0, ymax)} xs={xs} ys={ys} />
      <polyline fill="none" stroke="#475569" strokeWidth={1.4} points={ok.map((d) => `${xs(d.dimension)},${ys(d.stress1 as number)}`).join(" ")} />
      {ok.map((d) => (
        <g key={d.dimension} fontFamily={FONT} fontSize={10}>
          <circle cx={xs(d.dimension)} cy={ys(d.stress1 as number)} r={5} fill={d.converged ? "#0072B2" : "#fff"} stroke="#0072B2" strokeWidth={2} />
          <text x={xs(d.dimension)} y={ys(d.stress1 as number) - 9} textAnchor="middle" fill="#0f172a">{(d.stress1 as number).toFixed(3)}</text>
        </g>
      ))}
      <text x={box.l + 8} y={box.t + 14} fontFamily={FONT} fontSize={10} fill="#334155">● 수렴  ○ 미수렴 (2차원 이외는 보조 비교)</text>
    </Svg>
  );
});

export const Histogram = forwardRef<SVGSVGElement, { values: number[]; title: string; xLabel: string; mark?: { label: string; value: number }[] }>(function Histogram({ values, title, xLabel, mark }, ref) {
  const box = BOX;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const bins = 24;
  const w = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  values.forEach((v) => counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++);
  const xs = scaleLinear(lo, lo + w * bins, box.l, box.w - box.r);
  const cmax = Math.max(...counts);
  const ys = scaleLinear(0, cmax * 1.1, box.h - box.b, box.t);
  return (
    <Svg w={box.w} h={box.h} title={title} svgRef={ref}>
      <Frame box={box} title={title} xLabel={xLabel} yLabel="분할 횟수" xt={niceTicks(lo, hi)} yt={niceTicks(0, cmax)} xs={xs} ys={ys} />
      {counts.map((c, i) => (
        <rect key={i} x={xs(lo + w * i) + 0.5} y={ys(c)} width={Math.max(1, xs(lo + w * (i + 1)) - xs(lo + w * i) - 1)} height={box.h - box.b - ys(c)} fill="#56B4E9" stroke="#0072B2" strokeWidth={0.6} />
      ))}
      {(mark ?? []).map((m) => (
        <g key={m.label} fontFamily={FONT} fontSize={10}>
          <line x1={xs(m.value)} y1={box.t} x2={xs(m.value)} y2={box.h - box.b} stroke="#D55E00" strokeDasharray="4 3" />
          <text x={xs(m.value) + 3} y={box.t + 12} fill="#D55E00">{m.label} {m.value.toFixed(3)}</text>
        </g>
      ))}
    </Svg>
  );
});

type LinkRow = { leftNode: number; rightNode: number; mergeDistance: number };

/** Dendrogram of the Ward merge tree; the dashed line is the cut for k clusters, leaves are coloured by that cut. */
export const Dendrogram = forwardRef<SVGSVGElement, { linkage: LinkRow[]; n: number; labels: number[]; k: number; title: string }>(function Dendrogram({ linkage, n, labels, k, title }, ref) {
  const children = new Map<number, [number, number]>();
  linkage.forEach((r, i) => children.set(n + i, [r.leftNode, r.rightNode]));
  const root = n + linkage.length - 1;
  const order: number[] = [];
  const walk = (id: number) => {
    const c = children.get(id);
    if (!c) order.push(id);
    else {
      walk(c[0]);
      walk(c[1]);
    }
  };
  walk(root);
  const hMax = linkage[linkage.length - 1].mergeDistance;
  const W = 760;
  const H = 380;
  const L = 44;
  const T = 24;
  const B = 36;
  const xs = (i: number) => L + 8 + (i * (W - L - 24)) / (n - 1);
  const ys = (h: number) => H - B - (h / hMax) * (H - B - T - 10);
  const pos = new Map<number, { x: number; y: number }>();
  order.forEach((id, i) => pos.set(id, { x: xs(i), y: ys(0) }));
  const segs: React.ReactElement[] = [];
  linkage.forEach((r, i) => {
    const a = pos.get(r.leftNode)!;
    const b = pos.get(r.rightNode)!;
    const y = ys(r.mergeDistance);
    pos.set(n + i, { x: (a.x + b.x) / 2, y });
    segs.push(<path key={i} d={`M${a.x},${a.y} V${y} H${b.x} V${b.y}`} fill="none" stroke="#475569" strokeWidth={1} />);
  });
  const cutH = k >= 2 && n - k - 1 >= 0 && n - k < linkage.length ? (linkage[n - k - 1].mergeDistance + linkage[n - k].mergeDistance) / 2 : null;
  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title} style={{ background: "#fff", maxWidth: W }}>
      <title>{title}</title>
      <g fontFamily={FONT}>
        <text x={W / 2} y={14} textAnchor="middle" fontSize={13} fontWeight={600} fill="#0f172a">{title}</text>
        <line x1={L} y1={ys(0)} x2={W - 16} y2={ys(0)} stroke="#cbd5e1" />
        {niceTicks(0, hMax, 5).map((v) => (
          <g key={v}>
            <line x1={L} y1={ys(v)} x2={W - 16} y2={ys(v)} stroke="#f1f5f9" />
            <text x={L - 6} y={ys(v) + 3} textAnchor="end" fontSize={10} fill="#475569">{fmt(v)}</text>
          </g>
        ))}
        <text x={10} y={(T + H - B) / 2} fontSize={11} fill="#334155" transform={`rotate(-90 10 ${(T + H - B) / 2})`} textAnchor="middle">Ward 병합 높이</text>
        {segs}
        {cutH !== null && <line x1={L} y1={ys(cutH)} x2={W - 16} y2={ys(cutH)} stroke="#D55E00" strokeDasharray="5 4" />}
        {order.map((id, i) => (
          <g key={id} transform={`translate(${xs(i)},${ys(0) + 4})`}>
            <path d={markerPath(clusterStyle(labels[id]).marker, 3.2)} transform="translate(0,4)" fill={clusterStyle(labels[id]).color} />
            <text y={21} textAnchor="middle" fontSize={8.5} fill="#0f172a" transform="rotate(0)">{id + 1}</text>
          </g>
        ))}
      </g>
    </svg>
  );
});

/** Heat map of a symmetric n×n matrix with a diverging scale that is the same for every call using the same `limit`. */
export const DiffHeatmap = forwardRef<SVGSVGElement, { matrix: number[][]; limit: number; title: string }>(function DiffHeatmap({ matrix, limit, title }, ref) {
  const n = matrix.length;
  const cell = 11;
  const L = 34;
  const T = 30;
  const W = L + n * cell + 100;
  const H = T + n * cell + 26;
  const color = (v: number) => {
    const t = Math.max(-1, Math.min(1, v / limit));
    // blue (negative) - white - orange (positive); colour-blind safe diverging pair
    const [r, g, b] = t >= 0 ? [255 - t * (255 - 213), 255 - t * (255 - 94), 255 - t * 255] : [255 + t * 255, 255 + t * (255 - 114), 255 + t * (255 - 178)];
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  };
  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title} style={{ background: "#fff", maxWidth: W }}>
      <title>{title}</title>
      <g fontFamily={FONT}>
        <text x={L} y={14} fontSize={12} fontWeight={600} fill="#0f172a">{title}</text>
        {matrix.map((row, i) =>
          row.map((v, j) => (
            <rect key={`${i}-${j}`} x={L + j * cell} y={T + i * cell} width={cell} height={cell} fill={i === j ? "#e2e8f0" : color(v)}>
              <title>{`S${String(i + 1).padStart(2, "0")}–S${String(j + 1).padStart(2, "0")}: ${i === j ? "대각선" : v.toFixed(3)}`}</title>
            </rect>
          ))
        )}
        {[0, 9, 19, 29, 39, n - 1].filter((i) => i < n).map((i) => (
          <g key={i}>
            <text x={L - 3} y={T + i * cell + 9} fontSize={8} textAnchor="end" fill="#475569">{i + 1}</text>
            <text x={L + i * cell + cell / 2} y={T + n * cell + 11} fontSize={8} textAnchor="middle" fill="#475569">{i + 1}</text>
          </g>
        ))}
        {[-1, -0.5, 0, 0.5, 1].map((t, k) => (
          <g key={k}>
            <rect x={L + n * cell + 16} y={T + k * 22} width={14} height={22} fill={color(t * limit)} stroke="#fff" />
            <text x={L + n * cell + 34} y={T + k * 22 + 15} fontSize={9} fill="#334155">{(t * limit).toFixed(2)}</text>
          </g>
        ))}
        <text x={L + n * cell + 16} y={T + 5 * 22 + 14} fontSize={9} fill="#334155">P_KR − P_JP</text>
      </g>
    </svg>
  );
});
