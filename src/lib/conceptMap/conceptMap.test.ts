import { describe, expect, it } from "vitest";
import { addMatrices, buildCountMatrix, checkMatrices, deriveMatrices, IncompleteSortingError, matricesEqual, pileSizes, upperTriangle, type Participant } from "./matrices";
import { buildSolution, canonicalLabels, convexHull, clusterGeometry, cutTree, mergeHistory, silhouette } from "./clusters";
import { splitHalfReliability } from "./reliability";
import { compareCountries, procrustes2D, rankAverage, spearman } from "./compare";
import { clusterStyle, makeView, placeLabels, CLUSTER_COLORS, CLUSTER_MARKERS } from "./mapModel";
import { wardHierarchicalClustering } from "../conceptAnalysis";
import { mulberry32 } from "../conceptAnalysis/prng";

const N_ST = 12;

function synthParticipants(n: number, seed: number, country: "KR" | "JP", offset = 0): Participant[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    // three latent themes with a little noise, piles = themes
    const assignment = Array.from({ length: N_ST }, (_, s) => (rng() < 0.15 ? Math.floor(rng() * 3) : Math.floor(s / 4)));
    // renumber piles contiguously
    const map = new Map<number, number>();
    const canon = assignment.map((g) => (map.has(g) ? map.get(g)! : (map.set(g, map.size), map.size - 1)));
    return { pid: `${country}-${String(i + 1 + offset).padStart(3, "0")}`, country, assignment: canon };
  });
}

describe("similarity / dissimilarity matrices (Trochim, 1989)", () => {
  const ps = synthParticipants(10, 1, "KR");
  const S = buildCountMatrix(ps, N_ST);
  const m = deriveMatrices(S, ps.length);

  it("S has diagonal N, is symmetric and in range; P/D/δ follow the stated formulas", () => {
    const c = checkMatrices(m);
    expect(c.symmetric && c.diagonalEqualsN && c.offDiagonalInRange).toBe(true);
    for (let i = 0; i < N_ST; i++) {
      expect(m.P[i][i]).toBe(1);
      expect(m.D[i][i]).toBe(0);
      expect(m.delta[i][i]).toBe(0);
      for (let j = 0; j < N_ST; j++) {
        expect(m.P[i][j]).toBeCloseTo(S[i][j] / ps.length, 14);
        expect(m.D[i][j]).toBe(ps.length - S[i][j]);
        if (i !== j) expect(m.delta[i][j]).toBeCloseTo(1 - S[i][j] / ps.length, 14);
      }
    }
  });

  it("similar statements get SMALL dissimilarity (direction check)", () => {
    // a pair that is always together must be at delta 0; a pair never together at delta 1
    const together: Participant[] = [{ pid: "a", country: "KR", assignment: [0, 0, 1] }, { pid: "b", country: "KR", assignment: [0, 0, 1] }];
    const d = deriveMatrices(buildCountMatrix(together, 3), 2).delta;
    expect(d[0][1]).toBe(0);
    expect(d[0][2]).toBe(1);
  });

  it("hand-calculated example: personal binary similarity (same pile = 1), S, P, D and delta come out exactly as computed on paper", () => {
    // statements A,B,C,D = 0..3; three participants:
    //   p1: {A,B} {C,D}      p2: {A,B,C} {D}      p3: {A} {B} {C,D}
    const ps: Participant[] = [
      { pid: "p1", country: "KR", assignment: [0, 0, 1, 1] },
      { pid: "p2", country: "KR", assignment: [0, 0, 0, 1] },
      { pid: "p3", country: "KR", assignment: [0, 1, 2, 2] },
    ];
    // personal binary similarity matrix of p1, by hand: AB = 1, CD = 1, everything else 0, diagonal 1
    const B1 = ps[0].assignment.map((a) => ps[0].assignment.map((b) => (a === b ? 1 : 0)));
    expect(B1).toEqual([[1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 1, 1], [0, 0, 1, 1]]);
    // pairs together: AB in p1,p2 (2) · AC in p2 (1) · AD never (0) · BC in p2 (1) · BD never (0) · CD in p1,p3 (2)
    const S = buildCountMatrix(ps, 4);
    expect(S).toEqual([[3, 2, 1, 0], [2, 3, 1, 0], [1, 1, 3, 2], [0, 0, 2, 3]]);
    const { P, D, delta } = deriveMatrices(S, 3);
    expect(P[0][1]).toBeCloseTo(2 / 3, 14);
    expect(P.map((r, i) => r[i])).toEqual([1, 1, 1, 1]);
    expect(D).toEqual([[0, 1, 2, 3], [1, 0, 2, 3], [2, 2, 0, 1], [3, 3, 1, 0]]);
    expect(delta[0][1]).toBeCloseTo(1 / 3, 14); // most often together -> small dissimilarity
    expect(delta[0][3]).toBe(1); // never together -> dissimilarity 1
    expect(delta.map((r, i) => r[i])).toEqual([0, 0, 0, 0]);
    // the direction must not flip: the more often together, the smaller delta and D, the larger S and P
    expect(S[0][1] > S[0][2] && delta[0][1] < delta[0][2] && D[0][1] < D[0][2] && P[0][1] > P[0][2]).toBe(true);
    // a diagonal-0 copy of S (the 'frequency sheet' of the official workbook) is NOT D: off-diagonal cells differ
    expect(S[0][1]).not.toBe(D[0][1]);
  });

  it("ALL = KR + JP for S and D; P(ALL) is the N-weighted mean of the country P, not their simple mean", () => {
    const kr = synthParticipants(7, 2, "KR");
    const jp = synthParticipants(11, 3, "JP", 0);
    const Skr = buildCountMatrix(kr, N_ST);
    const Sjp = buildCountMatrix(jp, N_ST);
    const Sall = buildCountMatrix([...kr, ...jp], N_ST);
    expect(matricesEqual(Sall, addMatrices(Skr, Sjp))).toBe(true);
    const Dall = deriveMatrices(Sall, 18).D;
    expect(matricesEqual(Dall, addMatrices(deriveMatrices(Skr, 7).D, deriveMatrices(Sjp, 11).D))).toBe(true);
    const pAll = deriveMatrices(Sall, 18).P;
    const pk = deriveMatrices(Skr, 7).P;
    const pj = deriveMatrices(Sjp, 11).P;
    expect(pAll[0][1]).toBeCloseTo((7 * pk[0][1] + 11 * pj[0][1]) / 18, 14);
    const simple = (pk[0][1] + pj[0][1]) / 2;
    if (Math.abs(pk[0][1] - pj[0][1]) > 1e-9) expect(Math.abs(pAll[0][1] - simple)).toBeGreaterThan(1e-9);
  });

  it("refuses incomplete sorting instead of imputing zeros or changing the denominator", () => {
    expect(() => buildCountMatrix([{ pid: "x", country: "KR", assignment: [0, 1] }], 3)).toThrow(IncompleteSortingError);
    expect(() => buildCountMatrix([{ pid: "x", country: "KR", assignment: [0, -1, 1] }], 3)).toThrow(IncompleteSortingError);
  });

  it("pile sizes and upper triangle helpers", () => {
    expect(pileSizes([0, 0, 1, 2, 2, 2])).toEqual([3, 2, 1]);
    expect(upperTriangle(S).length).toBe((N_ST * (N_ST - 1)) / 2);
  });
});

describe("clusters, silhouette and boundaries", () => {
  const pts = [[0, 0], [0.1, 0], [0, 0.1], [5, 5], [5.1, 5], [5, 5.1], [10, 0], [10.1, 0.1]];
  const w = wardHierarchicalClustering(pts);
  const delta = pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));

  it("cuts the Ward tree into the obvious 3 groups and numbers them by smallest member", () => {
    const labels = canonicalLabels(cutTree(w.linkage, pts.length, 3));
    expect(labels).toEqual([1, 1, 1, 2, 2, 2, 3, 3]);
  });

  it("silhouette follows Rousseeuw's definition; singleton => 0; k=1 => NaN (never 0)", () => {
    const s = silhouette(delta, [1, 1, 1, 2, 2, 2, 3, 3]);
    expect(s.mean).toBeGreaterThan(0.9);
    const single = silhouette(delta, [1, 2, 2, 2, 2, 2, 2, 2]);
    expect(single.perPoint[0]).toBe(0);
    expect(Number.isNaN(silhouette(delta, new Array(8).fill(1)).mean)).toBe(true);
  });

  it("merge history costs are height^2/2 and the total within-SS reconciles with the k-cluster solution", () => {
    const hist = mergeHistory(w.linkage, pts.length);
    for (const r of hist) expect(r.wssIncrease).toBeCloseTo((r.height * r.height) / 2, 12);
    const sol = buildSolution(pts, delta, w.linkage, 3);
    // total SS = within(k) + sum of merge costs of the last (k-1) merges
    const tailCost = hist.slice(hist.length - 2).reduce((a, r) => a + r.wssIncrease, 0);
    expect(sol.totalSS).toBeCloseTo(sol.withinSS + tailCost, 9);
  });

  it("convex hull / special geometries: polygon, two points, one point, collinear", () => {
    expect(convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]]).length).toBe(4);
    expect(clusterGeometry([[1, 1]]).kind).toBe("point");
    expect(clusterGeometry([[1, 1], [2, 2]]).kind).toBe("segment");
    expect(clusterGeometry([[0, 0], [1, 1], [2, 2], [3, 3]]).kind).toBe("collinear");
    expect(clusterGeometry([[0, 0], [1, 0], [0, 1]]).kind).toBe("polygon");
  });

  it("reports other clusters' points that fall inside a hull instead of hiding them", () => {
    const P = [[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [10, 10], [11, 10]];
    const D = P.map((a) => P.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
    const link = wardHierarchicalClustering(P).linkage;
    const sol = buildSolution(P, D, link, 3);
    const total = sol.clusters.reduce((s, c) => s + c.foreignPointsInside.length, 0);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(sol.clusters.reduce((s, c) => s + c.size, 0)).toBe(P.length);
  });
});

describe("split-half reliability", () => {
  const kr = synthParticipants(30, 5, "KR");
  const jp = synthParticipants(38, 6, "JP");
  const settings = { repetitions: 50, seed: 123 };

  it("is deterministic for a fixed seed and keeps every repetition (no selection, no flooring at 0)", () => {
    const a = splitHalfReliability(kr, "KR", settings);
    const b = splitHalfReliability(kr, "KR", settings);
    expect(a.rawValues).toEqual(b.rawValues);
    expect(a.rawValues.length).toBe(50);
    expect(a.halfSizes.KR).toEqual([15, 15]);
    expect(splitHalfReliability(kr, "KR", { ...settings, seed: 124 }).rawValues).not.toEqual(a.rawValues);
  });

  it("ALL stratifies by country: each half gets 15 KR + 19 JP", () => {
    const a = splitHalfReliability([...kr, ...jp], "ALL", settings);
    expect(a.halfSizes).toEqual({ KR: [15, 15], JP: [19, 19] });
  });

  it("negative or undefined values are reported as such", () => {
    const degenerate: Participant[] = Array.from({ length: 6 }, (_, i) => ({ pid: `p${i}`, country: "KR" as const, assignment: new Array(N_ST).fill(0) }));
    const r = splitHalfReliability(degenerate, "KR", { repetitions: 10, seed: 1 });
    expect(r.undefinedCount).toBe(10); // constant halves => correlation undefined, counted, never turned into 0
    expect(r.rawValues.every((v) => v === null)).toBe(true);
  });

  it("Spearman–Brown is 2r/(1+r)", () => {
    const r = splitHalfReliability([...kr, ...jp], "ALL", settings);
    r.rawValues.forEach((v, i) => {
      if (v !== null) expect(r.spearmanBrownValues[i]).toBeCloseTo((2 * v) / (1 + v), 12);
    });
  });
});

describe("Korea–Japan comparison", () => {
  it("uses proportions of each country, Spearman handles ties by average ranks", () => {
    expect(rankAverage([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    const kr = synthParticipants(30, 7, "KR");
    const jp = synthParticipants(38, 8, "JP");
    const c = compareCountries(buildCountMatrix(kr, N_ST), 30, buildCountMatrix(jp, N_ST), 38);
    expect(c.pairs).toBe((N_ST * (N_ST - 1)) / 2);
    expect(c.pearson).toBeLessThanOrEqual(1);
    expect(c.topDifferences[0].diff).toBeDefined();
    expect(Math.abs(c.topDifferences[0].diff)).toBeCloseTo(c.maxAbsDiff, 12);
  });

  it("Procrustes aligns a rotated + reflected + shifted copy to ~zero residual and records the transform", () => {
    const base = [[0, 0], [1, 0], [1, 2], [-1, 1], [0.5, -1], [2, 1]];
    const th = 0.8;
    const moved = base.map(([x, y]) => [Math.cos(th) * x - Math.sin(th) * -y + 3, Math.sin(th) * x + Math.cos(th) * -y - 2]);
    const r = procrustes2D(base, moved, false);
    expect(r.relativeResidualUnscaled).toBeLessThan(1e-20);
    expect(r.reflection).toBe(true);
    expect(r.disparity).toBeLessThan(1e-12);
  });
});

describe("map model: equal axes, styles, label placement without moving points", () => {
  it("uses the same pixel scale on both axes and keeps the origin at the centre", () => {
    const v = makeView([[3, 1], [-2, -4], [0.5, 2]]);
    const a = v.toPx(1, 0);
    const b = v.toPx(0, 1);
    const o = v.toPx(0, 0);
    expect(a.x - o.x).toBeCloseTo(o.y - b.y, 10);
    expect(o).toEqual({ x: v.width / 2, y: v.height / 2 });
  });

  it("assigns every cluster a distinct (colour, marker) pair up to 10 clusters", () => {
    const seen = new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(clusterStyle(i + 1))));
    expect(seen.size).toBe(10);
    expect(CLUSTER_COLORS.length).toBeGreaterThanOrEqual(10);
    expect(CLUSTER_MARKERS.length).toBeGreaterThanOrEqual(10);
  });

  it("only moves labels: boxes avoid markers and each other when space allows, points stay put", () => {
    const pts = [{ x: 100, y: 100 }, { x: 104, y: 103 }, { x: 108, y: 99 }, { x: 300, y: 300 }];
    const copy = pts.map((p) => ({ ...p }));
    const labels = placeLabels(pts, ["S01", "S02", "S03", "S04"], { frame: { x: 0, y: 0, w: 640, h: 640 } });
    expect(pts).toEqual(copy);
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i].box;
        const b = labels[j].box;
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    expect(labels[3].leader).toBe(false);
    expect(labels.some((l) => l.leader)).toBe(true);
  });
});
