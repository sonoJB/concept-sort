import { describe, it, expect } from "vitest";
import { validateNonBlankLines, splitBulkLines } from "./statementLines";

describe("validateNonBlankLines", () => {
  it("accepts N valid non-blank lines", () => {
    expect(validateNonBlankLines(["a", "b", "c"]).ok).toBe(true);
  });

  it("accepts an empty array", () => {
    expect(validateNonBlankLines([])).toEqual({ ok: true });
  });

  it("rejects a blank line", () => {
    const result = validateNonBlankLines(["a", "", "c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
    expect((result as { error: string }).error).toMatch(/비어 있습니다/);
  });

  it("rejects a whitespace-only line", () => {
    const result = validateNonBlankLines(["a", "   ", "c"]);
    expect(result).toMatchObject({ ok: false, lineIndex: 1 });
  });

  it("does not require or validate any numeric prefix", () => {
    expect(validateNonBlankLines(["no number here", "also no number"]).ok).toBe(true);
  });

  it("does not strip, parse, or reject legitimate content that happens to start with a number", () => {
    const lines = ["3명이 모였다", "24시간 내내", "1인 가구 증가"];
    expect(validateNonBlankLines(lines).ok).toBe(true);
  });

  it("reports the correct 1-based line number in the error message", () => {
    const result = validateNonBlankLines(["a", "b", ""]);
    expect(result).toMatchObject({ ok: false, lineIndex: 2 });
    expect((result as { error: string }).error).toMatch(/^3번째 줄이 비어 있습니다\./);
  });
});

describe("splitBulkLines", () => {
  it("splits on newlines and trims each line", () => {
    expect(splitBulkLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("trims leading/trailing whitespace per line", () => {
    expect(splitBulkLines("  a  \n b ")).toEqual(["a", "b"]);
  });

  it("returns an empty array for blank input", () => {
    expect(splitBulkLines("")).toEqual([]);
    expect(splitBulkLines("   \n  ")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(splitBulkLines("a\r\nb")).toEqual(["a", "b"]);
  });

  it("preserves content that begins with a number, unmodified", () => {
    expect(splitBulkLines("1. 진술문\n2. 진술문")).toEqual(["1. 진술문", "2. 진술문"]);
  });
});
