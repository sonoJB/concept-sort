/**
 * Geometry shared by the on-screen map and its tests: equal-unit axes around the centred origin, per-cluster
 * colour + marker shape (distinguishable in grey scale by shape), and label placement.
 *
 * Point coordinates are NEVER changed (no jitter, no nudging). When labels would collide only the LABEL is moved
 * and a leader line connects it to its point.
 */
export type XY = { x: number; y: number };

/** Okabe–Ito colour-blind-safe palette (+ extra neutral/dark tones for k > 8). */
export const CLUSTER_COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#7A7A00", "#222222", "#8C564B", "#7F7F7F"];
export const CLUSTER_MARKERS = ["circle", "square", "triangle", "diamond", "triangleDown", "cross", "pentagon", "star", "hexagon", "ring"] as const;
export type MarkerShape = (typeof CLUSTER_MARKERS)[number];

export function clusterStyle(cluster: number): { color: string; marker: MarkerShape } {
  const i = (cluster - 1) % CLUSTER_COLORS.length;
  return { color: CLUSTER_COLORS[i], marker: CLUSTER_MARKERS[i] };
}

/** SVG path / element description of a marker centred at (0,0) with nominal radius r. */
export function markerPath(shape: MarkerShape, r: number): string {
  const p = (pts: [number, number][]) => pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ") + " Z";
  switch (shape) {
    case "circle":
    case "ring":
      return `M${-r},0 a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 Z`;
    case "square":
      return p([[-r, -r], [r, -r], [r, r], [-r, r]]);
    case "triangle":
      return p([[0, -1.15 * r], [1.05 * r, 0.8 * r], [-1.05 * r, 0.8 * r]]);
    case "triangleDown":
      return p([[0, 1.15 * r], [1.05 * r, -0.8 * r], [-1.05 * r, -0.8 * r]]);
    case "diamond":
      return p([[0, -1.3 * r], [1.1 * r, 0], [0, 1.3 * r], [-1.1 * r, 0]]);
    case "cross": {
      const a = 0.38 * r;
      return p([[-a, -r], [a, -r], [a, -a], [r, -a], [r, a], [a, a], [a, r], [-a, r], [-a, a], [-r, a], [-r, -a], [-a, -a]]);
    }
    case "pentagon":
      return p(Array.from({ length: 5 }, (_, k) => [1.1 * r * Math.sin((2 * Math.PI * k) / 5), -1.1 * r * Math.cos((2 * Math.PI * k) / 5)] as [number, number]));
    case "hexagon":
      return p(Array.from({ length: 6 }, (_, k) => [1.1 * r * Math.sin((2 * Math.PI * k) / 6), -1.1 * r * Math.cos((2 * Math.PI * k) / 6)] as [number, number]));
    case "star":
      return p(Array.from({ length: 10 }, (_, k) => [(k % 2 === 0 ? 1.35 * r : 0.55 * r) * Math.sin((Math.PI * k) / 5), -(k % 2 === 0 ? 1.35 * r : 0.55 * r) * Math.cos((Math.PI * k) / 5)] as [number, number]));
  }
}

export type View = {
  /** half-width of the square data window (same for x and y => equal unit length) */
  half: number;
  width: number;
  height: number;
  margin: number;
  /** pixels per data unit (identical for both axes) */
  scale: number;
  toPx: (x: number, y: number) => XY;
};

/** Square window centred on the origin, identical scale on both axes. */
export function makeView(points: number[][], size = 640, margin = 48, padding = 0.12): View {
  const maxAbs = Math.max(...points.flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]), 1e-9);
  const half = maxAbs * (1 + padding);
  const inner = size - 2 * margin;
  const scale = inner / (2 * half);
  const cx = size / 2;
  const cy = size / 2;
  return { half, width: size, height: size, margin, scale, toPx: (x, y) => ({ x: cx + x * scale, y: cy - y * scale }) };
}

export type LabelBox = { x: number; y: number; w: number; h: number };
export type PlacedLabel = { index: number; text: string; box: LabelBox; anchor: XY; leader: boolean; overlapsCount: number };

const intersects = (a: LabelBox, b: LabelBox, pad = 1) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
const circleHitsBox = (cx: number, cy: number, r: number, b: LabelBox) => {
  const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
  const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
  return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
};

/**
 * Deterministic greedy label placement. Each label tries 8 directions at growing radii; the first box that
 * overlaps neither an already-placed label nor any point marker (and stays inside the frame) wins. A label that
 * had to leave the marker's immediate neighbourhood gets a leader line. If nothing is free the least-overlapping
 * candidate is used and `overlapsCount` reports the residue honestly.
 */
export function placeLabels(points: XY[], texts: string[], opts: { markerRadius?: number; charWidth?: number; height?: number; frame?: LabelBox; obstacles?: LabelBox[] } = {}): PlacedLabel[] {
  const mr = opts.markerRadius ?? 6;
  const cw = opts.charWidth ?? 6.4;
  const h = opts.height ?? 13;
  const frame = opts.frame ?? { x: 0, y: 0, w: 640, h: 640 };
  const placed: PlacedLabel[] = [];
  const order = points
    .map((p, i) => ({ i, crowd: points.reduce((s, q, j) => s + (j !== i && Math.hypot(p.x - q.x, p.y - q.y) < 28 ? 1 : 0), 0) }))
    .sort((a, b) => b.crowd - a.crowd || a.i - b.i)
    .map((o) => o.i);
  const radii = [mr + 3, mr + 12, mr + 24, mr + 38, mr + 54, mr + 74];
  const dirs = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4 + Math.PI / 8 - Math.PI / 4);
  const byIndex = new Map<number, PlacedLabel>();
  for (const i of order) {
    const p = points[i];
    const w = texts[i].length * cw + 4;
    let best: { box: LabelBox; ov: number; r: number } | null = null;
    outer: for (const r of radii) {
      for (const a of dirs) {
        const cx = p.x + Math.cos(a) * r;
        const cy = p.y + Math.sin(a) * r;
        const box: LabelBox = { x: Math.cos(a) >= 0 ? cx : cx - w, y: cy - h / 2, w, h };
        let ov = 0;
        if (box.x < frame.x || box.y < frame.y || box.x + box.w > frame.x + frame.w || box.y + box.h > frame.y + frame.h) ov += 5;
        for (const l of byIndex.values()) if (intersects(box, l.box)) ov += 1;
        for (const ob of opts.obstacles ?? []) if (intersects(box, ob)) ov += 1;
        points.forEach((q, j) => {
          if (circleHitsBox(q.x, q.y, mr + 1, box)) ov += j === i ? 1 : 1;
        });
        if (ov === 0) {
          best = { box, ov, r };
          break outer;
        }
        if (!best || ov < best.ov) best = { box, ov, r };
      }
    }
    const b = best!;
    const lab: PlacedLabel = { index: i, text: texts[i], box: b.box, anchor: p, leader: b.r > radii[0], overlapsCount: b.ov };
    byIndex.set(i, lab);
    placed.push(lab);
  }
  return placed.sort((a, b) => a.index - b.index);
}

/** Path for a rounded-outline polygon is intentionally NOT used: boundaries are plain straight-edge convex hulls. */
export function polygonPath(hull: number[][], toPx: View["toPx"]): string {
  return hull.map(([x, y], k) => `${k === 0 ? "M" : "L"}${toPx(x, y).x.toFixed(2)},${toPx(x, y).y.toFixed(2)}`).join(" ") + " Z";
}

export type Badge = { cluster: number; box: LabelBox; text: string };

/**
 * Small numbered cluster badges placed OUTSIDE the cluster outline (above its top-most point, else below / left /
 * right) so they never sit on top of statement numbers. Candidate positions that would cover a point marker or
 * another badge, or leave the frame, are skipped; if none is free the least-bad candidate is used.
 */
export function placeBadges(clusters: { cluster: number; pts: XY[] }[], allPoints: XY[], frame: LabelBox, markerRadius = 6): Badge[] {
  const W = 20;
  const H = 17;
  const out: Badge[] = [];
  for (const c of clusters) {
    const top = c.pts.reduce((a, b) => (b.y < a.y ? b : a));
    const bottom = c.pts.reduce((a, b) => (b.y > a.y ? b : a));
    const left = c.pts.reduce((a, b) => (b.x < a.x ? b : a));
    const right = c.pts.reduce((a, b) => (b.x > a.x ? b : a));
    const cands: LabelBox[] = [
      { x: top.x - W / 2, y: top.y - H - 12, w: W, h: H },
      { x: bottom.x - W / 2, y: bottom.y + 12, w: W, h: H },
      { x: left.x - W - 14, y: left.y - H / 2, w: W, h: H },
      { x: right.x + 14, y: right.y - H / 2, w: W, h: H },
      { x: top.x + 10, y: top.y - H - 8, w: W, h: H },
      { x: top.x - W - 10, y: top.y - H - 8, w: W, h: H },
    ];
    let best: { box: LabelBox; ov: number } | null = null;
    for (const box of cands) {
      let ov = 0;
      if (box.x < frame.x || box.y < frame.y || box.x + box.w > frame.x + frame.w || box.y + box.h > frame.y + frame.h) ov += 5;
      for (const q of allPoints) if (circleHitsBox(q.x, q.y, markerRadius + 3, box)) ov += 1;
      for (const b of out) if (intersects(box, b.box, 2)) ov += 1;
      if (ov === 0) {
        best = { box, ov };
        break;
      }
      if (!best || ov < best.ov) best = { box, ov };
    }
    out.push({ cluster: c.cluster, box: best!.box, text: String(c.cluster) });
  }
  return out;
}
