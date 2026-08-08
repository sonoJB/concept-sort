import type { FixtureProject, FixtureSession } from "@/lib/conceptAnalysis";

/** Minimal shape read from the DB inside the snapshot transaction — no PII fields included. */
export type RawStatementRow = { id: string; order: number; text: string; textJa: string | null; jaStatus: string };
export type RawSessionRow = {
  id: string;
  countryCode: string | null;
  groups: { items: { statementId: string }[] }[];
};

/** Statement snapshot ordered by `order`, as the conceptAnalysis engine expects. */
export function toFixtureProject(projectKey: string, statements: RawStatementRow[]): FixtureProject {
  const ordered = [...statements].sort((a, b) => a.order - b.order);
  return { projectKey, statementIds: ordered.map((s) => s.id) };
}

/**
 * Converts raw SortSession rows into the engine's PII-free FixtureSession
 * shape. sessionId here is only used internally within this request/
 * transaction to drive scope filtering — it is never persisted into
 * inputSnapshot or any hash input (see hashes.ts / snapshot.ts).
 */
export function toFixtureSessions(sessions: RawSessionRow[]): FixtureSession[] {
  return sessions.map((s) => ({
    sessionId: s.id,
    countryCode: s.countryCode === "KR" || s.countryCode === "JP" ? s.countryCode : null,
    groups: s.groups.map((g) => g.items.map((i) => i.statementId)),
  }));
}
