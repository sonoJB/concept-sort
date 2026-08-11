/**
 * Shared numbering-validation contract for the bulk Korean/Japanese
 * statement editors. Numbering ("1. ", "2. ", ...) is part of the research
 * statement content itself — never stripped before storage, never
 * generated on save. This module only validates that manually-typed
 * numbering is well-formed and sequential; it never rewrites the line.
 */

const NUMBERED_LINE_PATTERN = /^(\d+)\.\s*(.*)$/;

export type LineValidationResult =
  | { ok: true }
  | { ok: false; lineIndex: number; error: string };

/**
 * Validates that `lines[i]` begins with the exact visible sequence number
 * `i + 1` (i.e. position in the array, not any stored Statement.order
 * value, which callers must sort into display order before calling this).
 */
export function validateNumberedLines(lines: string[]): LineValidationResult {
  for (let i = 0; i < lines.length; i++) {
    const visibleIndex = i + 1;
    const raw = lines[i];

    if (raw.trim().length === 0) {
      return {
        ok: false,
        lineIndex: i,
        error: `${visibleIndex}번째 줄이 비어 있습니다.`,
      };
    }

    const match = raw.trim().match(NUMBERED_LINE_PATTERN);
    if (!match) {
      return {
        ok: false,
        lineIndex: i,
        error: `${visibleIndex}번째 줄은 '${visibleIndex}. '로 시작해야 합니다.`,
      };
    }

    const number = Number(match[1]);
    if (number !== visibleIndex) {
      return {
        ok: false,
        lineIndex: i,
        error: `${visibleIndex}번째 줄은 '${visibleIndex}. '로 시작해야 합니다.`,
      };
    }

    if (match[2].trim().length === 0) {
      return {
        ok: false,
        lineIndex: i,
        error: `${visibleIndex}번째 줄은 번호만 있고 내용이 없습니다.`,
      };
    }
  }

  return { ok: true };
}

/** Splits bulk textarea input into lines, trimming only the whole line. */
export function splitBulkLines(text: string): string[] {
  if (text.trim().length === 0) return [];
  return text.split(/\r\n|\r|\n/).map((l) => l.trim());
}
