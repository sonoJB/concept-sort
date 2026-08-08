import { assignQuadrant, type Quadrant } from "./quadrant";

/** Fixed figure constants — shared by every consumer (live preview, SVG/PNG/HTML export) so geometry never diverges between them. */
export const FIGURE_WIDTH = 720;
export const FIGURE_HEIGHT = 560;
export const FIGURE_PADDING = 56;
export const PNG_SCALE = 2;

export const CATEGORICAL_COLORS = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
];

/** Distinct outline/marker shapes per cluster rank, so clusters are never distinguished by color alone (accessibility). */
export const CLUSTER_MARKERS = ["circle", "square", "triangle", "diamond"] as const;
export type ClusterMarker = (typeof CLUSTER_MARKERS)[number];

export type MapPoint2D = {
  statementId: string;
  order: number;
  x: number;
  y: number;
  clusterIndex: number | null;
};

export type ScaledPoint2D = MapPoint2D & {
  sx: number;
  sy: number;
  quadrant: Quadrant;
  color: string;
  marker: ClusterMarker;
};

/**
 * Scales raw MDS coordinates into the fixed figure viewBox, preserving
 * aspect ratio and centering on the data's own bounding box (never assumes
 * a fixed data range — MDS coordinate scale is arbitrary). Cluster
 * color/marker assignment is by first-appearance rank in statement order,
 * so it's stable for a given assignment set.
 */
export function buildMapPoints2D(points: MapPoint2D[]): ScaledPoint2D[] {
  if (points.length === 0) return [];

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const range = Math.max(rangeX, rangeY);
  const innerW = FIGURE_WIDTH - FIGURE_PADDING * 2;
  const innerH = FIGURE_HEIGHT - FIGURE_PADDING * 2;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const clusterRank = new Map<number, number>();
  for (const p of points) {
    if (p.clusterIndex !== null && !clusterRank.has(p.clusterIndex)) {
      clusterRank.set(p.clusterIndex, clusterRank.size);
    }
  }

  return points.map((p) => {
    const sx = FIGURE_WIDTH / 2 + ((p.x - cx) / range) * innerW;
    // SVG y grows downward; data y grows upward — flip.
    const sy = FIGURE_HEIGHT / 2 - ((p.y - cy) / range) * innerH;
    const rank = p.clusterIndex !== null ? clusterRank.get(p.clusterIndex)! : 0;
    return {
      ...p,
      sx,
      sy,
      quadrant: assignQuadrant(p.x, p.y),
      color: CATEGORICAL_COLORS[rank % CATEGORICAL_COLORS.length],
      marker: CLUSTER_MARKERS[rank % CLUSTER_MARKERS.length],
    };
  });
}

/** Origin (0,0) in screen space, for drawing axis/quadrant lines — same scaling as buildMapPoints2D, kept in sync deliberately. */
export function originInScreenSpace(points: MapPoint2D[]): { sx: number; sy: number } | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const range = Math.max(rangeX, rangeY);
  const innerW = FIGURE_WIDTH - FIGURE_PADDING * 2;
  const innerH = FIGURE_HEIGHT - FIGURE_PADDING * 2;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    sx: FIGURE_WIDTH / 2 + ((0 - cx) / range) * innerW,
    sy: FIGURE_HEIGHT / 2 - ((0 - cy) / range) * innerH,
  };
}

/** Fixed default 3D supplementary view angles — a config constant, recorded in export metadata, not re-derived per export. */
export const DEFAULT_3D_VIEW = { azimuthDeg: 35, elevationDeg: 20 };

export type Point3D = { statementId: string; order: number; x: number; y: number; z: number };
export type ScaledPoint3D = Point3D & { sx: number; sy: number; depth: number };

/** Simple fixed-angle orthographic projection — no 3D library, pure trigonometry. */
export function projectPoints3D(
  points: Point3D[],
  view: { azimuthDeg: number; elevationDeg: number } = DEFAULT_3D_VIEW
): ScaledPoint3D[] {
  if (points.length === 0) return [];
  const az = (view.azimuthDeg * Math.PI) / 180;
  const el = (view.elevationDeg * Math.PI) / 180;

  const projected = points.map((p) => {
    // Rotate around Y (azimuth), then around X (elevation); orthographic project to (u, v), keep depth for z-order.
    const x1 = p.x * Math.cos(az) - p.z * Math.sin(az);
    const z1 = p.x * Math.sin(az) + p.z * Math.cos(az);
    const y1 = p.y * Math.cos(el) - z1 * Math.sin(el);
    const depth = p.y * Math.sin(el) + z1 * Math.cos(el);
    return { p, u: x1, v: y1, depth };
  });

  const us = projected.map((p) => p.u);
  const vs = projected.map((p) => p.v);
  const minU = Math.min(...us);
  const maxU = Math.max(...us);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  const rangeU = maxU - minU || 1;
  const rangeV = maxV - minV || 1;
  const range = Math.max(rangeU, rangeV);
  const innerW = FIGURE_WIDTH - FIGURE_PADDING * 2;
  const innerH = FIGURE_HEIGHT - FIGURE_PADDING * 2;
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;

  return projected.map(({ p, u, v, depth }) => ({
    ...p,
    sx: FIGURE_WIDTH / 2 + ((u - cu) / range) * innerW,
    sy: FIGURE_HEIGHT / 2 - ((v - cv) / range) * innerH,
    depth,
  }));
}
