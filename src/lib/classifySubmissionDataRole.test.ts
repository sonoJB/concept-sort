import { describe, it, expect } from "vitest";
import { classifySubmissionDataRole } from "./classifySubmissionDataRole";

const CUTOVER = new Date("2026-08-16T15:00:00.000Z"); // 2026-08-17T00:00:00+09:00 (KST/JST)

describe("classifySubmissionDataRole — exact-boundary cutover classification", () => {
  it("(1) 1ms before cutoff -> PILOT", () => {
    const receivedAt = new Date("2026-08-16T14:59:59.999Z");
    expect(classifySubmissionDataRole({ receivedAt, mainStudyStartsAt: CUTOVER })).toBe("PILOT");
  });

  it("(2) exact cutoff instant -> MAIN", () => {
    const receivedAt = new Date("2026-08-16T15:00:00.000Z");
    expect(classifySubmissionDataRole({ receivedAt, mainStudyStartsAt: CUTOVER })).toBe("MAIN");
  });

  it("(3) 1ms after cutoff -> MAIN", () => {
    const receivedAt = new Date("2026-08-16T15:00:00.001Z");
    expect(classifySubmissionDataRole({ receivedAt, mainStudyStartsAt: CUTOVER })).toBe("MAIN");
  });

  it("(4) mainStudyStartsAt=null -> MAIN regardless of receivedAt", () => {
    expect(
      classifySubmissionDataRole({ receivedAt: new Date("2020-01-01T00:00:00.000Z"), mainStudyStartsAt: null })
    ).toBe("MAIN");
    expect(
      classifySubmissionDataRole({ receivedAt: new Date("2099-01-01T00:00:00.000Z"), mainStudyStartsAt: null })
    ).toBe("MAIN");
  });

  it("a submission well before the boundary is PILOT", () => {
    const receivedAt = new Date("2026-08-10T00:00:00.000Z");
    expect(classifySubmissionDataRole({ receivedAt, mainStudyStartsAt: CUTOVER })).toBe("PILOT");
  });

  it("a submission well after the boundary is MAIN", () => {
    const receivedAt = new Date("2026-09-01T00:00:00.000Z");
    expect(classifySubmissionDataRole({ receivedAt, mainStudyStartsAt: CUTOVER })).toBe("MAIN");
  });
});
