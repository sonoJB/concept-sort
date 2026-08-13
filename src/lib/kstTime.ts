/**
 * Korea and Japan are both fixed UTC+9 with no DST, so this conversion is a
 * pure, deterministic ±9h shift — never dependent on the researcher's
 * browser timezone. Used for the Admin-editable 본조사 시작 일시 field,
 * which must always be interpreted/displayed as KST/JST regardless of
 * where the researcher's browser happens to be.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC ISO string -> "YYYY-MM-DDTHH:mm" wall-clock value for a `<input type="datetime-local">` in KST/JST. */
export function utcIsoToKstInputValue(utcIso: string | null): string {
  if (!utcIso) return "";
  const kst = new Date(new Date(utcIso).getTime() + KST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm" KST/JST wall-clock value -> UTC ISO string. Empty/invalid input -> null. */
export function kstInputValueToUtcIso(value: string): string | null {
  if (!value) return null;
  const asUtcEpoch = Date.parse(`${value}:00Z`);
  if (Number.isNaN(asUtcEpoch)) return null;
  return new Date(asUtcEpoch - KST_OFFSET_MS).toISOString();
}

/** Formats a UTC ISO string as a "YYYY. M. D. HH:mm (KST/JST)" display string, again independent of browser timezone. */
export function formatUtcIsoAsKst(utcIso: string | null): string {
  if (!utcIso) return "미설정";
  const kst = new Date(new Date(utcIso).getTime() + KST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}. ${kst.getUTCMonth() + 1}. ${kst.getUTCDate()}. ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())} (KST/JST)`;
}
