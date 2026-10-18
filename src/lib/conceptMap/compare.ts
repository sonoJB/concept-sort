/**
 * Korea–Japan comparison (exploratory, descriptive). Frequencies of different N are never compared directly:
 * P_KR = S_KR / N_KR and P_JP = S_JP / N_JP are used. The 1,081 item pairs are NOT independent observations,
 * so no p-values are produced here.
 */
import { pearson } from "./reliability";
import type { Matrix } from "./matrices";
import { upperTriangle } from "./matrices";

export function rankAverage(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(v.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) ranks[idx[t][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

export function spearman(x: number[], y: number[]): number {
  return pearson(rankAverage(x), rankAverage(y));
}

export type PairDifference = { i: number; j: number; pKr: number; pJp: number; diff: number };

export type CountryComparison = {
  nKr: number;
  nJp: number;
  pairs: number;
  pearson: number;
  spearman: number;
  meanAbsDiff: number;
  maxAbsDiff: number;
  /** signed diff range used for the common colour scale of the heat map: symmetric about 0 */
  diffColorLimit: number;
  topDifferences: PairDifference[];
};

export function compareCountries(Skr: Matrix, nKr: number, Sjp: Matrix, nJp: number, top = 30): CountryComparison {
  const n = Skr.length;
  const pk = upperTriangle(Skr).map((v) => v / nKr);
  const pj = upperTriangle(Sjp).map((v) => v / nJp);
  const diffs: PairDifference[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++, k++) diffs.push({ i, j, pKr: pk[k], pJp: pj[k], diff: pk[k] - pj[k] });
  const abs = diffs.map((d) => Math.abs(d.diff));
  const maxAbs = Math.max(...abs);
  return {
    nKr,
    nJp,
    pairs: diffs.length,
    pearson: pearson(pk, pj),
    spearman: spearman(pk, pj),
    meanAbsDiff: abs.reduce((a, b) => a + b, 0) / abs.length,
    maxAbsDiff: maxAbs,
    diffColorLimit: maxAbs,
    topDifferences: [...diffs].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.i - b.i || a.j - b.j).slice(0, top),
  };
}

export type ProcrustesResult = {
  /** whether the aligned map was reflected */
  reflection: boolean;
  /** rotation angle (radians) applied after the optional reflection */
  rotationRadians: number;
  /** scale applied to the second map (1 when scaling is off) */
  scale: number;
  /** sum of squared residuals after alignment, both maps first centred and normalised to unit Frobenius norm */
  disparity: number;
  /** same for orthogonal alignment of the un-normalised maps, divided by sum of squares of the reference */
  relativeResidualUnscaled: number;
  aligned: number[][];
};

/** Orthogonal Procrustes in 2D (rotation or rotation+reflection, translation; optional scale). Reference = a, moved = b. */
export function procrustes2D(a: number[][], b: number[][], allowScale: boolean): ProcrustesResult {
  const n = a.length;
  const center = (m: number[][]) => {
    const mx = m.reduce((s, p) => s + p[0], 0) / n;
    const my = m.reduce((s, p) => s + p[1], 0) / n;
    return m.map((p) => [p[0] - mx, p[1] - my]);
  };
  const A = center(a);
  const B = center(b);
  const norm = (m: number[][]) => Math.sqrt(m.reduce((s, p) => s + p[0] * p[0] + p[1] * p[1], 0));
  const na = norm(A);
  const nb = norm(B);
  const fit = (Bm: number[][]) => {
    // maximise trace(Aᵀ Bm R) over rotations R: theta = atan2(sum(a x b), sum(a . b))
    let dot = 0;
    let crs = 0;
    for (let i = 0; i < n; i++) {
      dot += A[i][0] * Bm[i][0] + A[i][1] * Bm[i][1];
      crs += Bm[i][0] * A[i][1] - Bm[i][1] * A[i][0];
    }
    // rotating Bm by theta: x' = x cos - y sin, y' = x sin + y cos ; objective = dot*cos + crs'*sin
    const theta = Math.atan2(crs, dot);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const rot = Bm.map((p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]);
    const scale = allowScale ? (rot.reduce((q, p, i) => q + p[0] * A[i][0] + p[1] * A[i][1], 0) / rot.reduce((q, p) => q + p[0] * p[0] + p[1] * p[1], 0)) : 1;
    const out = rot.map((p) => [p[0] * scale, p[1] * scale]);
    const resid = out.reduce((q, p, i) => q + (p[0] - A[i][0]) ** 2 + (p[1] - A[i][1]) ** 2, 0);
    return { theta, out, resid, scale };
  };
  const plain = fit(B);
  const refl = fit(B.map((p) => [p[0], -p[1]]));
  const use = refl.resid < plain.resid ? { ...refl, reflection: true } : { ...plain, reflection: false };
  // normalised "disparity" (scipy convention): both unit norm, orthogonal alignment, no extra scale
  const An = A.map((p) => [p[0] / na, p[1] / na]);
  const Bn = B.map((p) => [p[0] / nb, p[1] / nb]);
  const alt = (Bm: number[][]) => {
    let dot = 0;
    let crs = 0;
    for (let i = 0; i < n; i++) {
      dot += An[i][0] * Bm[i][0] + An[i][1] * Bm[i][1];
      crs += Bm[i][0] * An[i][1] - Bm[i][1] * An[i][0];
    }
    const th = Math.atan2(crs, dot);
    const c = Math.cos(th);
    const s = Math.sin(th);
    const sc = Bm.reduce((q, p) => q + (p[0] * c - p[1] * s) * 0, 0);
    void sc;
    const rot = Bm.map((p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]);
    const k = rot.reduce((q, p, i) => q + p[0] * An[i][0] + p[1] * An[i][1], 0);
    return 1 - k * k; // sum sq residual with optimal scale for unit-norm configs
  };
  const disparity = Math.min(alt(Bn), alt(Bn.map((p) => [p[0], -p[1]])));
  return { reflection: use.reflection, rotationRadians: use.theta, scale: use.scale, disparity, relativeResidualUnscaled: use.resid / (na * na), aligned: use.out };
}
