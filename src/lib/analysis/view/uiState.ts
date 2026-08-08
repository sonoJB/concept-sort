/** Pure UI-state decision helpers, unit-testable without React/DOM (no Playwright/RTL dependency added). */

export function isRunButtonDisabled(eligible: boolean | null, creatingRun: boolean): boolean {
  if (creatingRun) return true;
  return eligible !== true;
}

export function showSingleParticipantWarning(participantCount: number): boolean {
  return participantCount === 1;
}

export function isResultHidden(executionStatus: string, numericFreshness: string): boolean {
  return executionStatus !== "COMPLETED" || numericFreshness !== "CURRENT";
}

export function isInterpretationEditorDisabled(status: string): boolean {
  return status === "FINALIZED";
}

export function is3DTabDisabled(dimension3Status: "COMPLETED" | "FAILED" | "NOT_REQUESTED"): boolean {
  return dimension3Status !== "COMPLETED";
}

/**
 * Gate 3's inputSnapshot never stores fitted disparity values (only
 * similarity count/proportion/dissimilarity), so a Shepard diagram cannot be
 * reconstructed from any COMPLETED run without recomputing disparities —
 * which this Gate must never do (no engine changes). This is therefore an
 * unconditional, run-independent unavailable state, not a per-run check.
 */
export const SHEPARD_UNAVAILABLE_MESSAGE =
  "이 실행에는 Shepard 도표를 재구성하는 데 필요한 세부 적합값(disparity)이 저장되어 있지 않아 도표를 표시하지 않습니다.";

export function isShepardUnavailable(): true {
  return true;
}

/**
 * The "official" full ZIP bundle (as opposed to individual CSV/SVG/PNG/HTML
 * downloads, which remain available for DRAFT preview per Gate 4 §10) is
 * gated to a FINALIZED interpretation. No interpretation at all, or a DRAFT
 * one, must disable it — finalizing is the researcher's explicit signal that
 * this is the result to hand out, not a moving target.
 */
export function isFinalZipAllowed(interpretationStatus: string | null): boolean {
  return interpretationStatus === "FINALIZED";
}
