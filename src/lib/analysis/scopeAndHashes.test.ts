import { describe, it, expect } from "vitest";
import { filterSessionsForScope, type FixtureProject, type FixtureSession } from "@/lib/conceptAnalysis";
import { buildNumericAggregate } from "./aggregates";
import { computeNumericDataHash, computeStatementStructureHash, computeStatementContentHashKo, computeStatementContentHashJa } from "./hashes";
import type { RawStatementRow } from "./dbAdapter";

const project: FixtureProject = { projectKey: "p1", statementIds: ["s1", "s2", "s3"] };

function session(id: string, countryCode: "KR" | "JP" | null, groups: string[][]): FixtureSession {
  return { sessionId: id, countryCode, groups };
}

describe("scope isolation", () => {
  const sessions: FixtureSession[] = [
    session("a", "KR", [["s1", "s2"], ["s3"]]),
    session("b", "KR", [["s1"], ["s2", "s3"]]),
    session("c", "JP", [["s1", "s2", "s3"]]),
    session("d", null, [["s1"], ["s2"], ["s3"]]),
  ];

  it("KR scope includes only KR sessions", () => {
    const result = filterSessionsForScope(project, sessions, "KR");
    expect(result.validSessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(result.nKr).toBe(2);
    expect(result.nJp).toBe(0);
  });

  it("JP scope includes only JP sessions", () => {
    const result = filterSessionsForScope(project, sessions, "JP");
    expect(result.validSessions.map((s) => s.sessionId)).toEqual(["c"]);
  });

  it("ALL scope pools KR+JP, one unit per participant, no reweighting", () => {
    const result = filterSessionsForScope(project, sessions, "ALL");
    expect(result.validSessions.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
    expect(result.nTotal).toBe(3);
  });

  it("null-country sessions are excluded from KR, JP, and ALL", () => {
    for (const scope of ["KR", "JP", "ALL"] as const) {
      const result = filterSessionsForScope(project, sessions, scope);
      expect(result.validSessions.some((s) => s.sessionId === "d")).toBe(false);
    }
    expect(filterSessionsForScope(project, sessions, "ALL").exclusions.excludedNullCountry).toBe(1);
  });

  it("null-country sessions are never treated as KR", () => {
    const result = filterSessionsForScope(project, sessions, "KR");
    expect(result.nKr).toBe(2); // not 3 — the null-country session never counted
  });
});

describe("numericDataHash", () => {
  it("depends only on scope + statement order + N + count matrix, not session identity", () => {
    const sessionsA: FixtureSession[] = [session("sess-1", "KR", [["s1", "s2"], ["s3"]])];
    const sessionsB: FixtureSession[] = [session("totally-different-id", "KR", [["s1", "s2"], ["s3"]])];

    const aggA = buildNumericAggregate(project, sessionsA);
    const aggB = buildNumericAggregate(project, sessionsB);

    expect(computeNumericDataHash("KR", "MAIN", aggA)).toBe(computeNumericDataHash("KR", "MAIN", aggB));
  });

  it("two different participant sets that coincidentally produce the same count matrix and N hash identically", () => {
    // Two participants each grouping (s1,s2) and (s3) alone yields the same
    // count matrix as one participant doing it twice — same N either way is
    // what's being asserted: the hash is a function of the resulting
    // geometry input, not of who produced it.
    const sessionsA: FixtureSession[] = [
      session("x", "KR", [["s1", "s2"], ["s3"]]),
      session("y", "KR", [["s1", "s2"], ["s3"]]),
    ];
    const sessionsB: FixtureSession[] = [
      session("m", "KR", [["s1", "s2"], ["s3"]]),
      session("n", "KR", [["s1", "s2"], ["s3"]]),
    ];
    const aggA = buildNumericAggregate(project, sessionsA);
    const aggB = buildNumericAggregate(project, sessionsB);
    expect(computeNumericDataHash("KR", "MAIN", aggA)).toBe(computeNumericDataHash("KR", "MAIN", aggB));
  });

  it("changes when the count matrix differs", () => {
    const sessionsA: FixtureSession[] = [session("a", "KR", [["s1", "s2"], ["s3"]])];
    const sessionsB: FixtureSession[] = [session("a", "KR", [["s1"], ["s2"], ["s3"]])];
    const aggA = buildNumericAggregate(project, sessionsA);
    const aggB = buildNumericAggregate(project, sessionsB);
    expect(computeNumericDataHash("KR", "MAIN", aggA)).not.toBe(computeNumericDataHash("KR", "MAIN", aggB));
  });

  it("changes when scope differs, even with identical aggregate", () => {
    const sessions: FixtureSession[] = [session("a", "KR", [["s1", "s2"], ["s3"]])];
    const agg = buildNumericAggregate(project, sessions);
    expect(computeNumericDataHash("KR", "MAIN", agg)).not.toBe(computeNumericDataHash("JP", "MAIN", agg));
  });

  it("changes when dataset mode differs, even with identical scope and aggregate", () => {
    const sessions: FixtureSession[] = [session("a", "KR", [["s1", "s2"], ["s3"]])];
    const agg = buildNumericAggregate(project, sessions);
    const main = computeNumericDataHash("KR", "MAIN", agg);
    const pilot = computeNumericDataHash("KR", "PILOT", agg);
    const allWithPilot = computeNumericDataHash("KR", "ALL_WITH_PILOT", agg);
    expect(main).not.toBe(pilot);
    expect(main).not.toBe(allWithPilot);
    expect(pilot).not.toBe(allWithPilot);
  });
});

describe("statement hashes", () => {
  const base: RawStatementRow[] = [
    { id: "s1", order: 0, text: "가", textJa: null, jaStatus: "MISSING" },
    { id: "s2", order: 1, text: "나", textJa: "", jaStatus: "DRAFT" },
  ];

  it("statementContentHashJa distinguishes null vs empty-string textJa", () => {
    const withNull: RawStatementRow[] = [{ id: "s1", order: 0, text: "x", textJa: null, jaStatus: "MISSING" }];
    const withEmpty: RawStatementRow[] = [{ id: "s1", order: 0, text: "x", textJa: "", jaStatus: "MISSING" }];
    expect(computeStatementContentHashJa(withNull)).not.toBe(computeStatementContentHashJa(withEmpty));
  });

  it("statementContentHashJa is always computable even when all textJa are null", () => {
    expect(() => computeStatementContentHashJa(base)).not.toThrow();
  });

  it("statementStructureHash depends only on id+order, not text", () => {
    const a: RawStatementRow[] = [{ id: "s1", order: 0, text: "A", textJa: null, jaStatus: "MISSING" }];
    const b: RawStatementRow[] = [{ id: "s1", order: 0, text: "B", textJa: null, jaStatus: "MISSING" }];
    expect(computeStatementStructureHash(a)).toBe(computeStatementStructureHash(b));
  });

  it("statementContentHashKo changes when text changes", () => {
    const a: RawStatementRow[] = [{ id: "s1", order: 0, text: "A", textJa: null, jaStatus: "MISSING" }];
    const b: RawStatementRow[] = [{ id: "s1", order: 0, text: "B", textJa: null, jaStatus: "MISSING" }];
    expect(computeStatementContentHashKo(a)).not.toBe(computeStatementContentHashKo(b));
  });
});
