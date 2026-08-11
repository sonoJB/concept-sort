import { describe, it, expect } from "vitest";
import { validateNumberedLines, splitBulkLines } from "./statementNumbering";

describe("validateNumberedLines", () => {
  it("accepts N valid sequential numbered lines", () => {
    const result = validateNumberedLines(["1. a", "2. b", "3. c"]);
    expect(result.ok).toBe(true);
  });

  it("accepts an empty array", () => {
    expect(validateNumberedLines([])).toEqual({ ok: true });
  });

  it("rejects a blank line", () => {
    const result = validateNumberedLines(["1. a", "", "3. c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
    expect((result as { error: string }).error).toMatch(/비어 있습니다/);
  });

  it("rejects a whitespace-only line", () => {
    const result = validateNumberedLines(["1. a", "   ", "3. c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
  });

  it("rejects a missing number prefix", () => {
    const result = validateNumberedLines(["1. a", "no number", "3. c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
    expect((result as { error: string }).error).toMatch(/2번째 줄은 '2\. '로 시작해야 합니다/);
  });

  it("rejects a skipped number", () => {
    const result = validateNumberedLines(["1. a", "3. b", "4. c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
  });

  it("rejects a duplicated number", () => {
    const result = validateNumberedLines(["1. a", "1. b", "3. c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
  });

  it("rejects out-of-order numbering", () => {
    const result = validateNumberedLines(["1. a", "3. b", "2. c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
  });

  it("rejects a number-only line with no content", () => {
    const result = validateNumberedLines(["1. a", "2.", "3. c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
    expect((result as { error: string }).error).toMatch(/번호만 있고 내용이 없습니다/);
  });

  it("validates against visible array position, not any embedded gap semantics", () => {
    // Position 0 must be "1.", position 1 must be "2.", regardless of what
    // any caller's underlying Statement.order values happen to be.
    const result = validateNumberedLines(["1. first", "2. second"]);
    expect(result.ok).toBe(true);
  });

  it("accepts numbers with multiple digits at the correct position", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}. line`);
    expect(validateNumberedLines(lines).ok).toBe(true);
  });

  it("accepts extra whitespace after the period", () => {
    expect(validateNumberedLines(["1.   spaced"]).ok).toBe(true);
  });
});

describe("splitBulkLines", () => {
  it("splits on newlines and trims each line", () => {
    expect(splitBulkLines("1. a\n2. b\n3. c")).toEqual(["1. a", "2. b", "3. c"]);
  });

  it("trims leading/trailing whitespace per line", () => {
    expect(splitBulkLines("  1. a  \n 2. b ")).toEqual(["1. a", "2. b"]);
  });

  it("returns an empty array for blank input", () => {
    expect(splitBulkLines("")).toEqual([]);
    expect(splitBulkLines("   \n  ")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(splitBulkLines("1. a\r\n2. b")).toEqual(["1. a", "2. b"]);
  });
});
