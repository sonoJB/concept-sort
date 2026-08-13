/**
 * PILOT/MAIN data segregation — explicit, server-controlled classification
 * of SortSession.dataRole, and the "which sessions are eligible input"
 * layer this feature adds ON TOP OF the existing (unmodified) country
 * `AnalysisScope` ("KR"|"JP"|"ALL"). `AnalysisScope` and `DatasetMode` are
 * orthogonal: scope=ALL means "Korea + Japan pooled", dataset=MAIN means
 * "official main-study participants only" — combining scope=ALL with
 * dataset=MAIN means all-country MAIN data, zero pilots, never confused
 * with dataset=ALL_WITH_PILOT which folds pilots back in explicitly.
 */

export type DataRole = "MAIN" | "PILOT";

export function isValidDataRole(value: unknown): value is DataRole {
  return value === "MAIN" || value === "PILOT";
}

export type DatasetMode = "MAIN" | "PILOT" | "ALL_WITH_PILOT";

export const DATASET_MODES: readonly DatasetMode[] = ["MAIN", "PILOT", "ALL_WITH_PILOT"];

export function isValidDatasetMode(value: unknown): value is DatasetMode {
  return value === "MAIN" || value === "PILOT" || value === "ALL_WITH_PILOT";
}

/**
 * The SortSession.dataRole values a given dataset mode admits.
 * `undefined` means "no dataRole filter" (ALL_WITH_PILOT) — callers building
 * a Prisma `where` clause should only add a `dataRole: { in: [...] }`
 * constraint when this returns a non-undefined array, never pass an empty
 * array (which would silently match zero rows) as a stand-in for "no filter".
 */
export function dataRolesForDataset(dataset: DatasetMode): DataRole[] | undefined {
  if (dataset === "MAIN") return ["MAIN"];
  if (dataset === "PILOT") return ["PILOT"];
  return undefined;
}
