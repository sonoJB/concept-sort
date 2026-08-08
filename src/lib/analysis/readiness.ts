export type EligibilityResult = {
  eligible: boolean;
  errorCode: "PARTICIPANT_COUNT_ZERO" | null;
  warnings: ("EXPLORATORY_SINGLE_PARTICIPANT")[];
};

/**
 * N=0 blocks execution outright. N=1 is explicitly permitted (not a
 * blanket cutoff) but carries a structured exploratory warning. No
 * arbitrary "N < 10" style threshold exists anywhere in this layer.
 */
export function checkEligibility(includedParticipantCount: number): EligibilityResult {
  if (includedParticipantCount === 0) {
    return { eligible: false, errorCode: "PARTICIPANT_COUNT_ZERO", warnings: [] };
  }
  if (includedParticipantCount === 1) {
    return { eligible: true, errorCode: null, warnings: ["EXPLORATORY_SINGLE_PARTICIPANT"] };
  }
  return { eligible: true, errorCode: null, warnings: [] };
}
