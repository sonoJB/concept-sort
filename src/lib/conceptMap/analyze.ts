/**
 * One complete, self-contained analysis of a scope (KR / JP / ALL) from participant-level sorting data.
 * Pure function: same input + settings => same output (all randomness is seeded and recorded).
 */
import { euclideanDistanceMatrix, wardHierarchicalClustering } from "../conceptAnalysis";
import { runSmacofV2, evaluateConfiguration, shepardData, type SmacofV2Result } from "../conceptAnalysis/smacofV2";
import { buildCountMatrix, checkMatrices, deriveMatrices, summarizeParticipants, describe, upperTriangle, type Matrix, type Participant } from "./matrices";
import { buildSolution, mergeHistory, type ClusterSolution } from "./clusters";
import { splitHalfReliability, type SplitHalfSummary } from "./reliability";

export type ScopeName = "KR" | "JP" | "ALL";

export type ConceptMapSettings = {
  mds: { dimensions: number[]; primaryDimension: number; nInit: number; maxIter: number; eps: number; strictEps: number; strictMaxIter: number; randomSeed: number; tieHandling: "secondary" | "primary" };
  ward: { kMin: number; kMax: number };
  splitHalf: { repetitions: number; seed: number };
};

export const DEFAULT_CONCEPT_MAP_SETTINGS: ConceptMapSettings = {
  mds: { dimensions: [1, 2, 3, 4, 5], primaryDimension: 2, nInit: 64, maxIter: 10000, eps: 1e-9, strictEps: 1e-12, strictMaxIter: 20000, randomSeed: 42, tieHandling: "secondary" },
  ward: { kMin: 2, kMax: 10 },
  splitHalf: { repetitions: 1000, seed: 20261018 },
};

export type DimensionAnalysis = {
  dimension: number;
  isPrimary: boolean;
  /** the engine's explicit status for the selected solution */
  selectionStatus: SmacofV2Result["selectionStatus"];
  /** true only if the selected solution converged at eps AND the strict continuation converged at strictEps */
  numericallyConverged: boolean;
  convergedStarts: number;
  startCount: number;
  terminationReasonTally: Record<string, number>;
  selected: SmacofV2Result["selected"];
  rawStress: number | null;
  stress1: number | null;
  stressNormalizedSqrt: number | null;
  stress1V1Definition: number | null;
  rsq: number | null;
  minPairDistance: number | null;
  /** definition audit: numerator and denominator of Kruskal Stress-1, and sum of squared normalised disparities (= q) */
  kruskalNumerator: number | null;
  sumDistSq: number | null;
  sumDispSq: number | null;
  rawStressSpreadAmongConverged: SmacofV2Result["rawStressSpreadAmongConverged"];
  startsWithinRelTol1e6OfBest: number;
  starts: SmacofV2Result["starts"];
  coordinates: number[][] | null;
  trace: { rawStress: number[]; relativeChange: number[]; thinned: boolean } | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type PairDiagnostic = {
  i: number;
  j: number;
  S: number;
  P: number;
  D: number;
  delta: number;
  distance: number;
  /** normalised disparity (sum d_hat^2 = n(n-1)/2) — used by raw stress, sqrt(raw/q), RSQ and the v1-style value */
  disparity: number;
  /** disparity - distance with the normalised disparity */
  residual: number;
  /** unnormalised monotone-regression disparity — used by Kruskal Stress-1 */
  disparityKruskal: number;
  /** disparityKruskal - distance */
  residualKruskal: number;
};

export type ScopeAnalysis = {
  scope: ScopeName;
  N: number;
  nKr: number;
  nJp: number;
  statementCount: number;
  settings: ConceptMapSettings;
  matrixChecks: ReturnType<typeof checkMatrices>;
  S: Matrix;
  participantSummary: { piles: ReturnType<typeof describe>; maxPile: ReturnType<typeof describe>; rows: ReturnType<typeof summarizeParticipants> };
  dimensions: DimensionAnalysis[];
  primary: DimensionAnalysis;
  pairDiagnostics: PairDiagnostic[] | null;
  ward: { linkage: { step: number; leftNode: number; rightNode: number; mergeDistance: number; mergedItemCount: number }[]; merges: ReturnType<typeof mergeHistory>; sourceDimension: number } | null;
  solutions: ClusterSolution[];
  splitHalf: SplitHalfSummary;
  /** supplementary 2D run with the PRIMARY tie approach ("break ties"); a sensitivity analysis, not the official result */
  tieSensitivity: { tieHandling: "primary"; converged: boolean; selectionStatus: string; rawStress: number | null; stress1: number | null; rsq: number | null; mainReason: string | null; strictReason: string | null; convergedStarts: number; startCount: number } | null;
};

const THIN_LIMIT = 2000;

function thin(trace: { rawStress: number[]; relativeChange: number[] }) {
  if (trace.rawStress.length <= THIN_LIMIT) return { ...trace, thinned: false };
  const stride = Math.ceil(trace.rawStress.length / THIN_LIMIT);
  const keep = (_: number, i: number) => i % stride === 0 || i === trace.rawStress.length - 1;
  return { rawStress: trace.rawStress.filter(keep), relativeChange: trace.relativeChange.filter((_, i) => keep(0, i + 1)), thinned: true };
}

export function analyzeScope(scope: ScopeName, participants: Participant[], statementCount: number, settings: ConceptMapSettings = DEFAULT_CONCEPT_MAP_SETTINGS): ScopeAnalysis {
  const inScope = scope === "ALL" ? participants : participants.filter((p) => p.country === scope);
  const N = inScope.length;
  const S = buildCountMatrix(inScope, statementCount);
  const m = deriveMatrices(S, N);
  const checks = checkMatrices(m);
  const weight: Matrix = m.delta.map((row, i) => row.map((_, j) => (i === j ? 0 : 1)));
  const rows = summarizeParticipants(inScope);

  const dimensions: DimensionAnalysis[] = settings.mds.dimensions.map((dimension) => {
    const r = runSmacofV2(m.delta, weight, { dimension, nInit: settings.mds.nInit, maxIter: settings.mds.maxIter, eps: settings.mds.eps, strictEps: settings.mds.strictEps, strictMaxIter: settings.mds.strictMaxIter, randomSeed: settings.mds.randomSeed, tieHandling: settings.mds.tieHandling });
    const tally: Record<string, number> = {};
    for (const s of r.starts) tally[s.reason] = (tally[s.reason] ?? 0) + 1;
    const converged = r.selected !== null && r.selected.main.reason === "CONVERGED" && r.selected.strict.reason === "CONVERGED";
    const conv = r.starts.filter((s) => s.reason === "CONVERGED").map((s) => s.rawStress);
    const best = conv.length ? Math.min(...conv) : NaN;
    const ev = r.evaluation;
    return {
      dimension,
      isPrimary: dimension === settings.mds.primaryDimension,
      selectionStatus: r.selectionStatus,
      numericallyConverged: converged,
      convergedStarts: r.convergedCount,
      startCount: r.starts.length,
      terminationReasonTally: tally,
      selected: r.selected,
      rawStress: ev?.rawStress ?? null,
      stress1: ev?.stress1 ?? null,
      stressNormalizedSqrt: ev?.stressNormalizedSqrt ?? null,
      stress1V1Definition: ev?.stress1V1Definition ?? null,
      rsq: ev?.rsq ?? null,
      minPairDistance: ev?.minPairDistance ?? null,
      kruskalNumerator: ev?.kruskalNumerator ?? null,
      sumDistSq: ev?.sumDistSq ?? null,
      sumDispSq: ev?.sumDispSq ?? null,
      rawStressSpreadAmongConverged: r.rawStressSpreadAmongConverged,
      startsWithinRelTol1e6OfBest: conv.filter((x) => x <= best * (1 + 1e-6)).length,
      starts: r.starts,
      coordinates: r.coordinates,
      trace: r.trace ? thin(r.trace) : null,
      errorCode: r.errorCode ?? null,
      errorMessage: r.errorMessage ?? null,
    };
  });
  const primary = dimensions.find((d) => d.isPrimary)!;

  // Pair diagnostics and Ward only for a solution that converged (an unconverged map is never clustered).
  let pairDiagnostics: PairDiagnostic[] | null = null;
  let ward: ScopeAnalysis["ward"] = null;
  const solutions: ClusterSolution[] = [];
  if (primary.coordinates && primary.numericallyConverged) {
    const sh = shepardData(primary.coordinates, m.delta, weight, settings.mds.tieHandling);
    pairDiagnostics = sh.delta.map((d, k) => ({ i: sh.i[k], j: sh.j[k], S: S[sh.i[k]][sh.j[k]], P: S[sh.i[k]][sh.j[k]] / N, D: N - S[sh.i[k]][sh.j[k]], delta: d, distance: sh.distance[k], disparity: sh.disparity[k], residual: sh.disparity[k] - sh.distance[k], disparityKruskal: sh.disparityKruskal[k], residualKruskal: sh.disparityKruskal[k] - sh.distance[k] }));
    const w = wardHierarchicalClustering(primary.coordinates);
    ward = { linkage: w.linkage, merges: mergeHistory(w.linkage, statementCount), sourceDimension: settings.mds.primaryDimension };
    for (let k = settings.ward.kMin; k <= Math.min(settings.ward.kMax, statementCount - 1); k++) solutions.push(buildSolution(primary.coordinates, m.delta, w.linkage, k));
  }

  const tieRun = runSmacofV2(m.delta, weight, { dimension: settings.mds.primaryDimension, nInit: settings.mds.nInit, maxIter: settings.mds.maxIter, eps: settings.mds.eps, strictEps: settings.mds.strictEps, strictMaxIter: settings.mds.strictMaxIter, randomSeed: settings.mds.randomSeed, tieHandling: "primary" });
  const tieSensitivity: ScopeAnalysis["tieSensitivity"] = tieRun.selected
    ? { tieHandling: "primary", converged: tieRun.selected.main.reason === "CONVERGED" && tieRun.selected.strict.reason === "CONVERGED", selectionStatus: tieRun.selectionStatus, rawStress: tieRun.evaluation?.rawStress ?? null, stress1: tieRun.evaluation?.stress1 ?? null, rsq: tieRun.evaluation?.rsq ?? null, mainReason: tieRun.selected.main.reason, strictReason: tieRun.selected.strict.reason, convergedStarts: tieRun.convergedCount, startCount: tieRun.starts.length }
    : null;

  return {
    scope,
    N,
    nKr: inScope.filter((p) => p.country === "KR").length,
    nJp: inScope.filter((p) => p.country === "JP").length,
    statementCount,
    settings,
    matrixChecks: checks,
    S,
    participantSummary: { piles: describe(rows.map((r) => r.piles)), maxPile: describe(rows.map((r) => r.maxPile)), rows },
    dimensions,
    primary,
    pairDiagnostics,
    ward,
    solutions,
    splitHalf: splitHalfReliability(inScope, scope, settings.splitHalf),
    tieSensitivity,
  };
}

/** Distances between the map points, for figures / checks. */
export function mapDistances(coords: number[][]): Matrix {
  return euclideanDistanceMatrix(coords);
}

export { evaluateConfiguration, upperTriangle };
