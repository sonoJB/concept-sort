import { runSmacof, wardHierarchicalClustering, type Matrix, type WeightMatrix, type Point } from "@/lib/conceptAnalysis";
import type { AnalysisParameters } from "./hashes";

export type DimensionResult = {
  dimension: number;
  dimensionStatus: "COMPLETED" | "FAILED";
  coordinates: Point[] | null;
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
 * Runs SMACOF for one dimension via the verified engine (runSmacof), then
 * derives commonStressQ from the same rawStress the engine already
 * returned — q = n(n-1)/2 is the ONLY additional input, no second stress
 * recomputation against the fit's disparity matrix (that's not exposed by
 * the engine's public API and isn't needed: both common-stress metrics
 * share the same numerator, see Gate 3 report §"Ward source/result design").
 * converged=false is never treated as a failure — only a returned
 * errorCode is.
 */
export function runDimension(
  dimension: number,
  dissimilarity: Matrix,
  weight: WeightMatrix,
  params: AnalysisParameters
): DimensionResult {
  if (dimension < 1 || dimension > 6 || !Number.isInteger(dimension)) {
    return {
      dimension,
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
      errorCode: "INVALID_DIMENSION",
      errorMessageSafe: "Requested dimension must be an integer between 1 and 6.",
    };
  }

  const result = runSmacof(dissimilarity, weight, {
    algorithm: "SMACOF",
    metric: false,
    dimension: dimension as 1 | 2 | 3 | 4 | 5 | 6,
    normalizedStress: true,
    randomSeed: params.randomSeed,
    nInit: params.nInit,
    maxIter: params.maxIter,
    eps: params.eps,
    tieHandling: params.tieHandling,
  });

  if (result.errorCode || result.coordinates === null || result.bestInitIndex === null) {
    return {
      dimension,
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
      errorCode: result.errorCode ?? "SMACOF_NO_RESULT",
      errorMessageSafe: result.errorMessage ?? "SMACOF did not produce a usable result for this dimension.",
    };
  }

  const bestInit = result.inits[result.bestInitIndex];
  const n = dissimilarity.length;
  const q = (n * (n - 1)) / 2;
  const commonStressDistance = result.normalizedStress1;
  const commonStressQ =
    result.rawStress !== null && Number.isFinite(result.rawStress) && q > 0
      ? Math.sqrt(result.rawStress / q)
      : null;

  return {
    dimension,
    dimensionStatus: "COMPLETED",
    coordinates: result.coordinates,
    rawStress: result.rawStress,
    commonStressDistance,
    commonStressQ,
    converged: result.converged,
    iterations: bestInit?.iterations ?? null,
    bestInitIndex: result.bestInitIndex,
    bestSeed: result.bestSeed,
    stressHistory: bestInit?.stressHistory ?? null,
    normalizationMeta: bestInit
      ? {
          disparityNormalizationFactor: bestInit.disparityNormalizationFactor ?? null,
          disparityNormBefore: bestInit.disparityNormBefore ?? null,
          disparityNormAfter: bestInit.disparityNormAfter ?? null,
          normalizationTarget: bestInit.normalizationTarget ?? null,
        }
      : null,
    errorCode: null,
    errorMessageSafe: null,
  };
}

export type WardResultSummary = {
  wardStatus: "NOT_RUN" | "COMPLETED" | "FAILED";
  wardLinkageSnapshot: Record<string, unknown> | null;
  wardErrorCode: string | null;
  wardErrorMessageSafe: string | null;
};

/**
 * Official Ward result: input is the primary (2D) MDS coordinates, never a
 * separate coordinate space. Ward itself never produces coordinates.
 */
export function runOfficialWard(primaryDimensionResult: DimensionResult): WardResultSummary {
  if (primaryDimensionResult.dimensionStatus !== "COMPLETED" || !primaryDimensionResult.coordinates) {
    return { wardStatus: "NOT_RUN", wardLinkageSnapshot: null, wardErrorCode: null, wardErrorMessageSafe: null };
  }
  try {
    const result = wardHierarchicalClustering(primaryDimensionResult.coordinates);
    return {
      wardStatus: "COMPLETED",
      wardLinkageSnapshot: { linkage: result.linkage, originalCount: result.originalCount },
      wardErrorCode: null,
      wardErrorMessageSafe: null,
    };
  } catch {
    return {
      wardStatus: "FAILED",
      wardLinkageSnapshot: null,
      wardErrorCode: "WARD_EXECUTION_ERROR",
      wardErrorMessageSafe: "Ward clustering failed to produce a result for the primary configuration.",
    };
  }
}
