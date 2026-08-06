/**
 * Dimension diagnostics: runs SMACOF at 1D through 6D on the same
 * dissimilarity/weight input so the Stress trend across dimensions can be
 * inspected. This module makes NO automatic dimension choice — Kane &
 * Trochim's traditional procedure (per the design-review phase, grounded in
 * Trochim's own technical-procedures document) treats 2D as the standard
 * representation and does not describe an automatic Stress-based rule for
 * preferring 3D, so `diagnosticPreferredDimension` is always left `null`
 * here rather than inventing a cutoff. `primaryMapDimension` is always 2,
 * fixed by methodology, not computed.
 */
import { runSmacof } from "./smacof";
import type { DimensionDiagnostic, Matrix, WeightMatrix } from "./types";

export const PRIMARY_MAP_DIMENSION = 2 as const;

export function runDimensionDiagnostics(
  dissimilarity: Matrix,
  weight: WeightMatrix,
  options: { randomSeed: number; nInit: number; maxIter: number; eps: number; maxDimension?: 3 | 6 }
): {
  diagnostics: DimensionDiagnostic[];
  primaryMapDimension: 2;
  diagnosticPreferredDimension: null;
  diagnosticReasonCodes: string[];
} {
  const maxDim = options.maxDimension ?? 6;
  const dims = [1, 2, 3, 4, 5, 6].filter((d) => d <= maxDim) as (1 | 2 | 3 | 4 | 5 | 6)[];

  const diagnostics: DimensionDiagnostic[] = [];
  let previousStress: number | null = null;

  for (const dimension of dims) {
    const n = dissimilarity.length;
    if (dimension >= n) {
      diagnostics.push({
        dimension,
        normalizedStress1: null,
        rawStress: null,
        converged: false,
        iterations: null,
        bestInit: null,
        bestSeed: null,
        absoluteReductionFromPrevious: null,
        relativeReductionFromPrevious: null,
        errorCode: "DIMENSION_TOO_HIGH",
      });
      continue;
    }

    const result = runSmacof(dissimilarity, weight, {
      algorithm: "SMACOF",
      metric: false,
      dimension,
      normalizedStress: true,
      randomSeed: options.randomSeed,
      nInit: options.nInit,
      maxIter: options.maxIter,
      eps: options.eps,
      tieHandling: "secondary",
    });

    const stress = result.normalizedStress1;
    const absReduction = previousStress !== null && stress !== null ? previousStress - stress : null;
    const relReduction =
      previousStress !== null && stress !== null && previousStress > 0 ? (previousStress - stress) / previousStress : null;

    diagnostics.push({
      dimension,
      normalizedStress1: stress,
      rawStress: result.rawStress,
      converged: result.converged,
      iterations: result.inits.find((i) => i.initIndex === result.bestInitIndex)?.iterations ?? null,
      bestInit: result.bestInitIndex,
      bestSeed: result.bestSeed,
      absoluteReductionFromPrevious: absReduction,
      relativeReductionFromPrevious: relReduction,
      errorCode: result.errorCode,
    });

    if (stress !== null) previousStress = stress;
  }

  return {
    diagnostics,
    primaryMapDimension: PRIMARY_MAP_DIMENSION,
    diagnosticPreferredDimension: null,
    diagnosticReasonCodes: [
      "NO_AUTOMATIC_DIMENSION_RULE: the source methodology (Trochim technical-procedures document) states 2D is preferred for interpretability when combined with cluster analysis, but does not define a numeric Stress cutoff for accepting 3D as a final map — this prototype does not invent one.",
      "RESEARCHER_JUDGMENT_REQUIRED: compare the 2D and 3D rows above and decide manually; a lower 3D stress alone is not sufficient justification per the finalized design.",
    ],
  };
}
