import type { ResultBundle } from "./bundle";
import { INTERPRETATION_TEXT_VERSION, evaluateMetrics } from "./metrics";
import { REFERENCES } from "./references";

/** Interpretation text version recorded by the first release (before the text was versioned). */
export const FIRST_RELEASE_TEXT_VERSION = "interpretation-1";

/**
 * The stored result bundle with its INTERPRETATION layer (metric criteria, verdict wording, reference list) re-evaluated
 * with the current wording. Every number (matrices, coordinates, stress values, cluster membership, fingerprints) is
 * passed through untouched: the metric records are recomputed from the stored `analysis` only, so this never changes
 * a result — it only keeps the screen, the report and the ZIP of an old run on the current, corrected wording.
 *
 * `interpretation.storedTextVersion` says which wording was stored with the run; `textVersion` is the wording shown.
 */
export function withCurrentInterpretation(bundle: ResultBundle): ResultBundle {
  const recommendedK = bundle.naming.status === "ATTACHED" ? bundle.naming.proposal.recommendedK : null;
  return {
    ...bundle,
    metrics: evaluateMetrics(bundle.analysis, recommendedK),
    references: Object.values(REFERENCES),
    interpretation: { textVersion: INTERPRETATION_TEXT_VERSION, storedTextVersion: bundle.interpretation?.textVersion ?? FIRST_RELEASE_TEXT_VERSION },
  };
}
