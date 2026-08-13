/**
 * Shared line-validation contract for the bulk Korean/Japanese statement
 * editors. Statement number is NOT part of statement content — the
 * similarity-sorting UI renders the visible card number (1..N) from
 * Statement.order / array position, never by parsing it out of the text.
 * One non-blank line = one statement; this module only validates line
 * count/blankness, it never inspects or rewrites the line's content.
 */

export type LineValidationResult =
  | { ok: true }
  | { ok: false; lineIndex: number; error: string };

/** Validates that every line is non-blank. Content itself is never inspected. */
export function validateNonBlankLines(lines: string[]): LineValidationResult {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) {
      return {
        ok: false,
        lineIndex: i,
        error: `${i + 1}번째 줄이 비어 있습니다.`,
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
