import { describe, it, expect } from "vitest";
import {
  isRunButtonDisabled,
  showSingleParticipantWarning,
  isResultHidden,
  isInterpretationEditorDisabled,
  is3DTabDisabled,
  isShepardUnavailable,
  isFinalZipAllowed,
} from "./uiState";

describe("isRunButtonDisabled", () => {
  it("N=0 (eligible=false) -> disabled", () => {
    expect(isRunButtonDisabled(false, false)).toBe(true);
  });
  it("N=1 or more (eligible=true) -> enabled", () => {
    expect(isRunButtonDisabled(true, false)).toBe(false);
  });
  it("eligibility not yet loaded (null) -> disabled", () => {
    expect(isRunButtonDisabled(null, false)).toBe(true);
  });
  it("already creating a run -> disabled regardless of eligibility", () => {
    expect(isRunButtonDisabled(true, true)).toBe(true);
  });
});

describe("showSingleParticipantWarning", () => {
  it("shows only at exactly N=1", () => {
    expect(showSingleParticipantWarning(1)).toBe(true);
    expect(showSingleParticipantWarning(0)).toBe(false);
    expect(showSingleParticipantWarning(2)).toBe(false);
    expect(showSingleParticipantWarning(50)).toBe(false);
  });
});

describe("isResultHidden", () => {
  it("hides result unless COMPLETED and numeric CURRENT", () => {
    expect(isResultHidden("COMPLETED", "CURRENT")).toBe(false);
    expect(isResultHidden("COMPLETED", "STALE")).toBe(true);
    expect(isResultHidden("RUNNING", "CURRENT")).toBe(true);
    expect(isResultHidden("FAILED", "CURRENT")).toBe(true);
  });
});

describe("isInterpretationEditorDisabled", () => {
  it("DRAFT -> enabled, FINALIZED -> disabled", () => {
    expect(isInterpretationEditorDisabled("DRAFT")).toBe(false);
    expect(isInterpretationEditorDisabled("FINALIZED")).toBe(true);
  });
});

describe("is3DTabDisabled", () => {
  it("only enabled when the 3D dimension COMPLETED", () => {
    expect(is3DTabDisabled("COMPLETED")).toBe(false);
    expect(is3DTabDisabled("FAILED")).toBe(true);
    expect(is3DTabDisabled("NOT_REQUESTED")).toBe(true);
  });
});

describe("isShepardUnavailable", () => {
  it("is unconditionally true — Gate 3's inputSnapshot never stores fitted disparities", () => {
    expect(isShepardUnavailable()).toBe(true);
  });
});

describe("isFinalZipAllowed", () => {
  it("A. DRAFT interpretation -> official ZIP disabled", () => {
    expect(isFinalZipAllowed("DRAFT")).toBe(false);
  });
  it("B. FINALIZED interpretation -> official ZIP allowed", () => {
    expect(isFinalZipAllowed("FINALIZED")).toBe(true);
  });
  it("C. no interpretation at all (null) -> official ZIP disabled", () => {
    expect(isFinalZipAllowed(null)).toBe(false);
  });
});
