import type { ExportDimensionPayload } from "./exportPayload";

export type DimensionDiagnosticRow = {
  dimension: number;
  dimensionStatus: string;
  /** Kruskal Stress-1 (commonStressDistance), unchanged from the engine. */
  stress1: number | null;
  /** R² is DEFINED as RSQ (squared correlation) — always the same value as `rsq`, never a second computation. */
  rSquared: number | null;
  rsq: number | null;
  /** null for the first present dimension (no preceding dimension to compare against), and whenever either side is missing. */
  deltaRSquared: number | null;
  /** Stress reduction from the previous dimension = previousStress - thisStress (positive = Stress went down). null under the same conditions as deltaRSquared. */
  deltaStress: number | null;
  converged: boolean | null;
  iterations: number | null;
  convergenceReason: string;
};

/**
 * Derives the ΔR²/ΔStress comparison columns from an already RSQ-enriched
 * dimension list (see exportPayload.ts), relative to the PREVIOUS entry in
 * the same sorted array — not a fixed 1D anchor — so this works correctly
 * whether the run evaluated the full 1D-5D range or (for a legacy run
 * created before this feature) only a subset like [2, 3].
 */
export function buildDimensionDiagnosticsView(
  dimensions: ExportDimensionPayload[]
): DimensionDiagnosticRow[] {
  const sorted = [...dimensions].sort((a, b) => a.dimension - b.dimension);
  let previous: ExportDimensionPayload | null = null;

  return sorted.map((d) => {
    const deltaRSquared =
      previous && previous.rSquared !== null && d.rSquared !== null ? d.rSquared - previous.rSquared : null;
    const deltaStress =
      previous && previous.commonStressDistance !== null && d.commonStressDistance !== null
        ? previous.commonStressDistance - d.commonStressDistance
        : null;
    previous = d;
    return {
      dimension: d.dimension,
      dimensionStatus: d.dimensionStatus,
      stress1: d.commonStressDistance,
      rSquared: d.rSquared,
      rsq: d.rsq,
      deltaRSquared,
      deltaStress,
      converged: d.converged,
      iterations: d.iterations,
      convergenceReason: d.convergenceReason,
    };
  });
}
