/** Shared pure filtering logic for participant CSV export and the admin table's 전체/본조사/파일럿 view filter — one implementation, used by both, so "what the button downloads" and "what the table shows" can never silently diverge. */
export type DataRoleFilter = "ALL" | "MAIN" | "PILOT";

export function filterByDataRole<T extends { dataRole: string }>(rows: T[], filter: DataRoleFilter): T[] {
  if (filter === "ALL") return rows;
  return rows.filter((r) => r.dataRole === filter);
}
