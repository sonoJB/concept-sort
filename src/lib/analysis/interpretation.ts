/**
 * No existing admin-text length precedent was found in the current codebase
 * (checked content/statements routes) — these are conservative,
 * DB-independent safe upper bounds defined here, not derived from any
 * existing policy.
 */
export const CLUSTER_LABEL_MAX_LENGTH = 200;
export const CLUSTER_MEMO_MAX_LENGTH = 2000;

export const VALID_LANGUAGES = ["ko", "ja"] as const;
export type ClusterLabelLanguage = (typeof VALID_LANGUAGES)[number];

export function isValidLanguage(value: unknown): value is ClusterLabelLanguage {
  return typeof value === "string" && (VALID_LANGUAGES as readonly string[]).includes(value);
}

export function isValidClusterIndex(clusterIndex: unknown, selectedClusterCount: number): clusterIndex is number {
  return Number.isInteger(clusterIndex) && (clusterIndex as number) >= 0 && (clusterIndex as number) < selectedClusterCount;
}

export function isValidSelectedClusterCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}
