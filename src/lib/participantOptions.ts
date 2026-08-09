/**
 * Demographic option lists shared between the participant UI and the submit
 * API. `value` is the string actually stored in SortSession and is never
 * changed by locale — it stays the existing Korean internal value so
 * current data, server validation, and CSV exports keep working unchanged.
 * `ko`/`ja` are display labels only. Country is never inferred from these
 * values; countryCode is validated independently.
 */
export type LocalizedOption<V extends string> = { value: V; ko: string; ja: string };

export const GENDER_OPTIONS = [
  { value: "남자", ko: "남자", ja: "男性" },
  { value: "여자", ko: "여자", ja: "女性" },
] as const satisfies readonly LocalizedOption<string>[];
export type GenderValue = (typeof GENDER_OPTIONS)[number]["value"];

export const SCHOOL_LEVEL_OPTIONS = [
  { value: "중학교", ko: "중학교", ja: "中学校" },
  { value: "고등학교", ko: "고등학교", ja: "高等学校" },
] as const satisfies readonly LocalizedOption<string>[];
export type SchoolLevelValue = (typeof SCHOOL_LEVEL_OPTIONS)[number]["value"];

export const GRADE_OPTIONS = [
  { value: "1학년", ko: "1학년", ja: "1年生" },
  { value: "2학년", ko: "2학년", ja: "2年生" },
  { value: "3학년", ko: "3학년", ja: "3年生" },
] as const satisfies readonly LocalizedOption<string>[];
export type GradeValue = (typeof GRADE_OPTIONS)[number]["value"];

export const GENDER_VALUES = new Set(GENDER_OPTIONS.map((o) => o.value));
export const SCHOOL_LEVEL_VALUES = new Set(SCHOOL_LEVEL_OPTIONS.map((o) => o.value));
export const GRADE_VALUES = new Set(GRADE_OPTIONS.map((o) => o.value));

export function labelFor<V extends string>(
  options: readonly LocalizedOption<V>[],
  value: string,
  locale: "ko" | "ja"
): string {
  return options.find((o) => o.value === value)?.[locale] ?? value;
}
