import { describe, it, expect } from "vitest";
import { checkExportEligibility } from "./exportGate";
import type { FreshnessResult } from "@/lib/analysis/freshness";

const allCurrent: FreshnessResult = {
  numericFreshness: "CURRENT",
  contentFreshnessKo: "CURRENT",
  contentFreshnessJa: "CURRENT",
  parameterStatus: "CURRENT",
  publicationStatus: "READY",
  freshnessReasons: [],
};

describe("checkExportEligibility", () => {
  it("A. allows export for a CURRENT COMPLETED run with the language publication-ready", () => {
    expect(checkExportEligibility("COMPLETED", allCurrent, "ko", true)).toEqual({ allowed: true });
  });

  it("B. blocks on numeric stale", () => {
    const f: FreshnessResult = { ...allCurrent, numericFreshness: "STALE" };
    expect(checkExportEligibility("COMPLETED", f, "ko", true)).toEqual({ allowed: false, reason: "NUMERIC_STALE" });
  });

  it("C. blocks KO export when KO content is stale, independent of JA", () => {
    const f: FreshnessResult = { ...allCurrent, contentFreshnessKo: "STALE" };
    expect(checkExportEligibility("COMPLETED", f, "ko", true)).toEqual({ allowed: false, reason: "CONTENT_STALE" });
    // A JA export under the same freshness state is unaffected by KO staleness.
    expect(checkExportEligibility("COMPLETED", f, "ja", true)).toEqual({ allowed: true });
  });

  it("D. blocks JA export when JA content is stale, independent of KO", () => {
    const f: FreshnessResult = { ...allCurrent, contentFreshnessJa: "STALE" };
    expect(checkExportEligibility("COMPLETED", f, "ja", true)).toEqual({ allowed: false, reason: "CONTENT_STALE" });
    expect(checkExportEligibility("COMPLETED", f, "ko", true)).toEqual({ allowed: true });
  });

  it("E. blocks when the requested export language is not publication-ready, even if run-scope freshness.publicationStatus is READY", () => {
    // allCurrent.publicationStatus is READY (e.g. a KR-scope run never
    // considers JA) — but publicationReadyForLanguage=false must still block.
    expect(checkExportEligibility("COMPLETED", allCurrent, "ja", false)).toEqual({ allowed: false, reason: "PUBLICATION_BLOCKED" });
  });

  it("F. blocks on PARAMETERS_SUPERSEDED", () => {
    const f: FreshnessResult = { ...allCurrent, parameterStatus: "SUPERSEDED" };
    expect(checkExportEligibility("COMPLETED", f, "ko", true)).toEqual({ allowed: false, reason: "PARAMETERS_SUPERSEDED" });
  });

  it("G. blocks a non-COMPLETED run regardless of freshness", () => {
    expect(checkExportEligibility("RUNNING", allCurrent, "ko", true)).toEqual({ allowed: false, reason: "RUN_NOT_COMPLETED" });
    expect(checkExportEligibility("FAILED", allCurrent, "ko", true)).toEqual({ allowed: false, reason: "RUN_NOT_COMPLETED" });
  });
});
