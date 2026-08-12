import { describe, it, expect } from "vitest";
import {
  COUNTRY_OPTIONS,
  countryToLocale,
  initialCountry,
  initialParticipantStep,
  isCountryAvailable,
  localeToCountry,
  restoredCountryFromStorage,
} from "./participantCountryFlow";

describe("COUNTRY_OPTIONS — exact labels", () => {
  it("has exactly Korea and Japan, in order, with the exact required labels", () => {
    expect(COUNTRY_OPTIONS).toEqual([
      { code: "KR", label: "Korea (한국)" },
      { code: "JP", label: "Japan (日本)" },
    ]);
  });
});

describe("initialParticipantStep — normal participant route", () => {
  it("clean normal visit (previewMode=false) → country first", () => {
    expect(initialParticipantStep(false)).toBe("country");
  });

  it("single-locale-available projects no longer skip country (caller passes previewMode=false regardless of availability)", () => {
    // Availability is intentionally NOT a parameter here — the fix removed
    // the single-locale skip entirely, so this function has no way to skip
    // based on availability at all.
    expect(initialParticipantStep(false)).toBe("country");
  });

  it("researcher preview (previewMode=true) bypasses country and starts at name", () => {
    expect(initialParticipantStep(true)).toBe("name");
  });
});

describe("initialCountry", () => {
  it("previewMode with previewLocale=ko → KR", () => {
    expect(initialCountry(true, "ko")).toBe("KR");
  });

  it("previewMode with previewLocale=ja → JP", () => {
    expect(initialCountry(true, "ja")).toBe("JP");
  });

  it("previewMode with no previewLocale defaults to ko → KR", () => {
    expect(initialCountry(true, undefined)).toBe("KR");
  });

  it("normal participant route always starts with no country selected", () => {
    expect(initialCountry(false, "ko")).toBeNull();
    expect(initialCountry(false, undefined)).toBeNull();
  });
});

describe("restoredCountryFromStorage — sessionStorage restore is a PRESELECTION ONLY", () => {
  it("stored KR with Korean available → restores KR", () => {
    expect(restoredCountryFromStorage("KR", true, true)).toBe("KR");
  });

  it("stored JP with Japanese available → restores JP", () => {
    expect(restoredCountryFromStorage("JP", true, true)).toBe("JP");
  });

  it("stored KR but Korean no longer available → does not restore", () => {
    expect(restoredCountryFromStorage("KR", false, true)).toBeNull();
  });

  it("stored JP but Japanese no longer available → does not restore", () => {
    expect(restoredCountryFromStorage("JP", true, false)).toBeNull();
  });

  it("nothing stored → null", () => {
    expect(restoredCountryFromStorage(null, true, true)).toBeNull();
  });

  it("garbage stored value → null", () => {
    expect(restoredCountryFromStorage("not-a-country", true, true)).toBeNull();
  });

  it("this function's return value must never be used to skip the country step — it is a preselection value only, consumed by CountryStep's initialSelected prop, never by SortBoard's step state", () => {
    // Documented via the two tests above that return non-null: callers must
    // treat this as "highlight this option" data, not "advance past country".
    expect(restoredCountryFromStorage("KR", true, true)).toBe("KR");
  });
});

describe("isCountryAvailable", () => {
  it("KR available when koreanAvailable=true", () => {
    expect(isCountryAvailable("KR", true, false)).toBe(true);
  });

  it("KR unavailable when koreanAvailable=false", () => {
    expect(isCountryAvailable("KR", false, true)).toBe(false);
  });

  it("JP available when japaneseAvailable=true", () => {
    expect(isCountryAvailable("JP", false, true)).toBe(true);
  });

  it("JP unavailable when japaneseAvailable=false", () => {
    expect(isCountryAvailable("JP", true, false)).toBe(false);
  });

  it("both available", () => {
    expect(isCountryAvailable("KR", true, true)).toBe(true);
    expect(isCountryAvailable("JP", true, true)).toBe(true);
  });
});

describe("localeToCountry / countryToLocale", () => {
  it("ko -> KR -> ko round-trips", () => {
    expect(localeToCountry("ko")).toBe("KR");
    expect(countryToLocale("KR")).toBe("ko");
  });

  it("ja -> JP -> ja round-trips", () => {
    expect(localeToCountry("ja")).toBe("JP");
    expect(countryToLocale("JP")).toBe("ja");
  });
});
