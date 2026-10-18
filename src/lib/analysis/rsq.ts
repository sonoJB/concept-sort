import { evaluateConfiguration } from "@/lib/conceptAnalysis/smacofV2";
import type { Matrix, WeightMatrix, Point } from "@/lib/conceptAnalysis";

/**
 * RSQ as used throughout this application: the squared Pearson correlation between the (normalised) disparities
 * and the configuration distances over all active item pairs (same definition as MultBiplotR::MDS "RSQ"; it is
 * NOT an R² of a regression of δ on distance, and not ALSCAL's RSQ). It is recomputed here from the stored final
 * coordinates and the stored dissimilarities by the same function the analysis uses, so a displayed value can
 * never come from a different configuration than the displayed map.
 */
export type RsqResult = { rsq: number | null; pairCount: number; errorCode: string | null };

export function computeRSQForDimension(dissimilarity: Matrix, weight: WeightMatrix, coordinates: Point[]): RsqResult {
  if (coordinates.length < 2) return { rsq: null, pairCount: 0, errorCode: "INSUFFICIENT_ITEMS" };
  try {
    const ev = evaluateConfiguration(coordinates, dissimilarity, weight, "secondary");
    return Number.isFinite(ev.rsq) ? { rsq: ev.rsq, pairCount: ev.pairCount, errorCode: null } : { rsq: null, pairCount: ev.pairCount, errorCode: "DEGENERATE_CORRELATION" };
  } catch {
    return { rsq: null, pairCount: 0, errorCode: "EVALUATION_FAILED" };
  }
}
