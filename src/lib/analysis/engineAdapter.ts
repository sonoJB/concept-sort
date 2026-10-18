import type { DimensionAnalysis, ConceptMapSettings } from "@/lib/conceptMap/analyze";
import type { AnalysisParameters } from "./hashes";

/** Maps the stored analysis parameters onto the analysis library's settings (the library has no defaults of its own here). */
export function toConceptMapSettings(p: AnalysisParameters): ConceptMapSettings {
  return {
    mds: {
      dimensions: Array.from(new Set([p.primaryMapDimension, ...p.dimensionsEvaluated])).sort((a, b) => a - b),
      primaryDimension: p.primaryMapDimension,
      nInit: p.nInit,
      maxIter: p.maxIter,
      eps: p.eps,
      strictEps: p.strictEps,
      strictMaxIter: p.strictMaxIter,
      randomSeed: p.randomSeed,
      tieHandling: p.tieHandling,
    },
    ward: { kMin: p.wardKMin, kMax: p.wardKMax },
    splitHalf: { repetitions: p.splitHalfRepetitions, seed: p.splitHalfSeed },
  };
}

export type DimensionRowData = {
  dimension: number;
  dimensionStatus: "COMPLETED" | "FAILED";
  coordinates: number[][] | null;
  rawStress: number | null;
  commonStressDistance: number | null;
  commonStressQ: number | null;
  converged: boolean | null;
  iterations: number | null;
  bestInitIndex: number | null;
  bestSeed: number | null;
  stressHistory: number[] | null;
  normalizationMeta: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
};

/**
 * One AnalysisRunDimension row from a dimension analysis. `converged` is the strict statement "the selected
 * solution converged at eps AND its continuation converged at strictEps"; the individual termination reasons are
 * kept in normalizationMeta so nothing is reduced to a bare COMPLETED/converged flag. A dimension without any
 * usable solution is FAILED with the engine's own error code.
 */
export function toDimensionRow(d: DimensionAnalysis): DimensionRowData {
  if (!d.coordinates || !d.selected) {
    return {
      dimension: d.dimension,
      dimensionStatus: "FAILED",
      coordinates: null,
      rawStress: null,
      commonStressDistance: null,
      commonStressQ: null,
      converged: null,
      iterations: null,
      bestInitIndex: null,
      bestSeed: null,
      stressHistory: null,
      normalizationMeta: null,
      errorCode: d.errorCode ?? "MDS_NO_RESULT",
      errorMessageSafe: d.errorMessage ?? "The MDS engine did not produce a usable solution for this dimension.",
    };
  }
  return {
    dimension: d.dimension,
    dimensionStatus: "COMPLETED",
    coordinates: d.coordinates,
    rawStress: d.rawStress,
    commonStressDistance: d.stress1,
    commonStressQ: d.stressNormalizedSqrt,
    converged: d.numericallyConverged,
    iterations: d.selected.main.iterations + d.selected.strict.iterations,
    bestInitIndex: d.selected.initIndex,
    bestSeed: d.selected.seed,
    stressHistory: d.trace?.rawStress ?? null,
    normalizationMeta: {
      historyKind: "rawStress",
      selectionStatus: d.selectionStatus,
      mainRun: d.selected.main,
      strictRun: d.selected.strict,
      convergedStarts: d.convergedStarts,
      startCount: d.startCount,
      terminationReasonTally: d.terminationReasonTally,
      stress1: d.stress1,
      stressNormalizedSqrt: d.stressNormalizedSqrt,
      stress1V1Definition: d.stress1V1Definition,
      rsq: d.rsq,
      minPairDistance: d.minPairDistance,
      rawStressSpreadAmongConverged: d.rawStressSpreadAmongConverged,
      startsWithinRelTol1e6OfBest: d.startsWithinRelTol1e6OfBest,
    },
    errorCode: null,
    errorMessageSafe: null,
  };
}
