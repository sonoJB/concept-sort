export type CountryCode = "KR" | "JP";
export type ParticipantLocale = "ko" | "ja";
export type ParticipantFirstStep = "country" | "name";

/** The exact, fixed country options shown on the country-selection screen. */
export const COUNTRY_OPTIONS: { code: CountryCode; label: string }[] = [
  { code: "KR", label: "Korea (한국)" },
  { code: "JP", label: "Japan (日本)" },
];

export function localeToCountry(locale: ParticipantLocale): CountryCode {
  return locale === "ja" ? "JP" : "KR";
}

export function countryToLocale(country: CountryCode): ParticipantLocale {
  return country === "JP" ? "ja" : "ko";
}

/**
 * The live participant route (`/p/[slug]/sort`) always starts at the
 * country screen, regardless of how many languages are currently available
 * — a participant must explicitly see and confirm their country every
 * visit. Only an authenticated researcher preview (previewMode=true) is
 * allowed to skip straight to a specific locale.
 */
export function initialParticipantStep(previewMode: boolean): ParticipantFirstStep {
  return previewMode ? "name" : "country";
}

export function initialCountry(
  previewMode: boolean,
  previewLocale: ParticipantLocale | undefined
): CountryCode | null {
  if (previewMode) return localeToCountry(previewLocale ?? "ko");
  return null;
}

/**
 * Restores a previously chosen country from sessionStorage for
 * PRESELECTION ONLY — the caller must still render the country screen and
 * require an explicit confirm click. Never returns a value that should
 * cause skipping the country screen.
 */
export function restoredCountryFromStorage(
  stored: string | null,
  koreanAvailable: boolean,
  japaneseAvailable: boolean
): CountryCode | null {
  if (stored === "KR" && koreanAvailable) return "KR";
  if (stored === "JP" && japaneseAvailable) return "JP";
  return null;
}

export function isCountryAvailable(
  country: CountryCode,
  koreanAvailable: boolean,
  japaneseAvailable: boolean
): boolean {
  return country === "KR" ? koreanAvailable : japaneseAvailable;
}
