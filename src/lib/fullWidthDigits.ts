/**
 * Converts full-width digit characters (U+FF10–U+FF19, e.g. "０１２３") to
 * their ASCII equivalents ("0123"). Only digits are touched — every other
 * character (including other full-width punctuation) passes through
 * unchanged. Pure string manipulation throughout, so a leading zero (e.g.
 * "0123") is never lost the way it would be if the value were parsed as a
 * number at any point.
 */
export function normalizeFullWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

/**
 * true iff `value`, after full-width normalization, is exactly 4 ASCII
 * digits. Used for the Japan-only "last 4 digits of mobile phone number"
 * participant-identification field — never a uniqueness or authentication
 * check, just a format check.
 */
export function isValidJapanesePhoneLast4(value: string): boolean {
  return /^\d{4}$/.test(normalizeFullWidthDigits(value));
}
