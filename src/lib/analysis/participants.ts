import type { FixtureSession } from "@/lib/conceptAnalysis";
import type { Participant } from "@/lib/conceptMap/matrices";

/**
 * Pseudonymous participant records for the analysis snapshot. Ids are `KR-001`, `JP-001`, ... assigned in
 * submission order (createdAt, then session id as a stable tie-break); real session ids, names and phone numbers
 * never enter the result. Pile indices are renumbered by each pile's smallest statement index — membership is
 * unchanged, only the arbitrary pile numbering is canonical.
 */
export function buildParticipants(statementIds: string[], valid: FixtureSession[], createdAtMs: Map<string, number>): Participant[] {
  const idx = new Map(statementIds.map((id, i) => [id, i]));
  const ordered = [...valid].sort((a, b) => {
    const d = (createdAtMs.get(a.sessionId) ?? 0) - (createdAtMs.get(b.sessionId) ?? 0);
    if (d !== 0) return d;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
  const counters: Record<string, number> = {};
  return ordered.map((s) => {
    const country = s.countryCode as "KR" | "JP";
    counters[country] = (counters[country] ?? 0) + 1;
    const piles = s.groups.map((g) => g.map((id) => idx.get(id)!).sort((x, y) => x - y)).sort((a, b) => a[0] - b[0]);
    const assignment = new Array<number>(statementIds.length).fill(-1);
    piles.forEach((p, g) => p.forEach((i) => (assignment[i] = g)));
    return { pid: `${country}-${String(counters[country]).padStart(3, "0")}`, country, assignment };
  });
}
