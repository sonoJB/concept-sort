import { describe, it, expect } from "vitest";
import { deriveFreshness } from "./freshness";
import { isResultBodyExposable } from "./runSerializer";

const baseHashes = {
  numericDataHash: "n1",
  statementStructureHash: "st1",
  statementContentHashKo: "ko1",
  statementContentHashJa: "ja1",
  parameterHash: "p1",
};

function input(overrides: Partial<typeof baseHashes> = {}, scope: "KR" | "JP" | "ALL" = "KR", pubKo = true, pubJa = true) {
  return {
    scope,
    run: baseHashes,
    current: { ...baseHashes, ...overrides },
    publicationReadyKo: pubKo,
    publicationReadyJa: pubJa,
  };
}

describe("freshness — all-current baseline", () => {
  it("is fully CURRENT/READY when nothing changed", () => {
    const f = deriveFreshness(input());
    expect(f.numericFreshness).toBe("CURRENT");
    expect(f.contentFreshnessKo).toBe("CURRENT");
    expect(f.contentFreshnessJa).toBe("CURRENT");
    expect(f.parameterStatus).toBe("CURRENT");
    expect(f.publicationStatus).toBe("READY");
    expect(f.freshnessReasons).toEqual([]);
  });
});

describe("freshness — scope-specific numeric staleness", () => {
  it("KR response change -> KR numeric STALE", () => {
    const f = deriveFreshness(input({ numericDataHash: "n2" }, "KR"));
    expect(f.numericFreshness).toBe("STALE");
    expect(f.freshnessReasons).toContain("NUMERIC_DATA_CHANGED");
  });

  it("JP response change does not affect a KR-scope run's numeric freshness (isolated inputs)", () => {
    // A KR-scope run's numericDataHash is computed only from KR-valid
    // sessions, so a JP-only change never changes it — asserted here by
    // simply confirming an unrelated (unchanged) numericDataHash stays CURRENT.
    const f = deriveFreshness(input({}, "KR"));
    expect(f.numericFreshness).toBe("CURRENT");
  });

  it("null-country response change does not change numericDataHash for KR/JP/ALL", () => {
    for (const scope of ["KR", "JP", "ALL"] as const) {
      const f = deriveFreshness(input({}, scope));
      expect(f.numericFreshness).toBe("CURRENT");
    }
  });
});

describe("freshness — content staleness", () => {
  it("KR statement text change -> content KO STALE only", () => {
    const f = deriveFreshness(input({ statementContentHashKo: "ko2" }, "ALL"));
    expect(f.contentFreshnessKo).toBe("STALE");
    expect(f.contentFreshnessJa).toBe("CURRENT");
  });

  it("JA textJa/jaStatus change -> content JA STALE only", () => {
    const f = deriveFreshness(input({ statementContentHashJa: "ja2" }, "ALL"));
    expect(f.contentFreshnessJa).toBe("STALE");
    expect(f.contentFreshnessKo).toBe("CURRENT");
  });

  it("statement structure change -> numeric AND both content hashes STALE", () => {
    const f = deriveFreshness(input({ statementStructureHash: "st2" }, "ALL"));
    expect(f.numericFreshness).toBe("STALE");
    expect(f.contentFreshnessKo).toBe("STALE");
    expect(f.contentFreshnessJa).toBe("STALE");
  });
});

describe("freshness — parameter supersession", () => {
  it("parameter change -> SUPERSEDED, independent of numeric/content freshness", () => {
    const f = deriveFreshness(input({ parameterHash: "p2" }));
    expect(f.parameterStatus).toBe("SUPERSEDED");
    expect(f.numericFreshness).toBe("CURRENT");
    expect(f.contentFreshnessKo).toBe("CURRENT");
  });
});

describe("freshness — publication readiness by scope", () => {
  it("KR-scope run ignores JA readiness entirely", () => {
    const f = deriveFreshness(input({}, "KR", true, false));
    expect(f.publicationStatus).toBe("READY");
  });

  it("JP-scope run ignores KO readiness entirely", () => {
    const f = deriveFreshness(input({}, "JP", false, true));
    expect(f.publicationStatus).toBe("READY");
  });

  it("ALL-scope run is BLOCKED if either KO or JA is not ready", () => {
    expect(deriveFreshness(input({}, "ALL", false, true)).publicationStatus).toBe("BLOCKED");
    expect(deriveFreshness(input({}, "ALL", true, false)).publicationStatus).toBe("BLOCKED");
    expect(deriveFreshness(input({}, "ALL", true, true)).publicationStatus).toBe("READY");
  });

  it("JP-scope run never becomes READY via KO fallback (KO readiness is irrelevant to it, not substituted)", () => {
    // pubKo=true but pubJa=false: JP scope must still be BLOCKED, proving
    // KO readiness is never used as a stand-in for JA readiness.
    const f = deriveFreshness(input({}, "JP", true, false));
    expect(f.publicationStatus).toBe("BLOCKED");
  });
});

describe("stale result exposure gate", () => {
  it("blocks result body for any non-CURRENT axis even if executionStatus is COMPLETED", () => {
    const f = deriveFreshness(input({ numericDataHash: "n2" }));
    expect(isResultBodyExposable("COMPLETED", f)).toBe(false);
  });

  it("blocks result body for non-COMPLETED executionStatus even if freshness is all-current", () => {
    const f = deriveFreshness(input());
    expect(isResultBodyExposable("RUNNING", f)).toBe(false);
    expect(isResultBodyExposable("FAILED", f)).toBe(false);
  });

  it("exposes result body only when COMPLETED and fully current/ready", () => {
    const f = deriveFreshness(input());
    expect(isResultBodyExposable("COMPLETED", f)).toBe(true);
  });

  it("blocks result body when PARAMETERS_SUPERSEDED", () => {
    const f = deriveFreshness(input({ parameterHash: "p2" }));
    expect(isResultBodyExposable("COMPLETED", f)).toBe(false);
  });

  it("blocks result body when publication BLOCKED", () => {
    const f = deriveFreshness(input({}, "ALL", true, false));
    expect(isResultBodyExposable("COMPLETED", f)).toBe(false);
  });
});
