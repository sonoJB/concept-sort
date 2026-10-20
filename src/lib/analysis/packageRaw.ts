import type { PrismaClient } from "@/generated/prisma/client";
import type { AnalysisScope } from "@/lib/conceptAnalysis";
import { filterSessionsForScope } from "@/lib/conceptAnalysis";
import type { Participant } from "@/lib/conceptMap/matrices";
import { toFixtureProject, toFixtureSessions, type RawSessionRow, type RawStatementRow } from "./dbAdapter";
import { buildParticipants } from "./participants";
import { canonicalHash } from "./canonicalJson";
import type { InputSnapshot } from "./snapshot";
import type { DataRole } from "./dataset";

/** The data of this run's snapshot can no longer be reproduced from the database (responses or statements changed). */
export class PackageInputChangedError extends Error {
  constructor(detail: string) {
    super(`PACKAGE_INPUT_CHANGED: ${detail}`);
    this.name = "PackageInputChangedError";
  }
}

export type RawForPackage = {
  participants: Participant[];
  /** package-only extras keyed by pseudonymous id: submission time and the participant's own pile labels */
  extras: Record<string, { createdAtMs: number; pileLabels: string[] }>;
  excludedPilot: number;
};

/**
 * The pseudonymous participant export that goes into a package, rebuilt for a COMPLETED run. The participants (ids and pile
 * assignments) come from the same functions that built the run's input snapshot and must reproduce its stored
 * `participantsHash` exactly; only then are the two package-only extras (submission time, pile labels) attached.
 * If the database no longer reproduces the snapshot, the package would describe different data than the run, so the
 * build stops with PackageInputChangedError instead of mixing data.
 *
 * Nothing here is ever written back: it is read-only, and real session ids, names and phone numbers never leave this function.
 */
export async function loadPackageRaw(prisma: PrismaClient, run: { projectId: string; scope: string; inputSnapshot: string }): Promise<RawForPackage> {
  const snap = JSON.parse(run.inputSnapshot) as InputSnapshot;
  const dbStatements = await prisma.statement.findMany({ where: { projectId: run.projectId } });
  const rawStatements: RawStatementRow[] = dbStatements.map((s) => ({ id: s.id, order: s.order, text: s.text, textJa: s.textJa, jaStatus: s.jaStatus }));
  const ordered = [...rawStatements].sort((a, b) => a.order - b.order);
  if (ordered.length !== snap.statements.length || ordered.some((s, i) => s.id !== snap.statements[i].id || s.text !== snap.statements[i].textKo)) {
    throw new PackageInputChangedError("statements differ from the run's snapshot");
  }
  const sessions = await prisma.sortSession.findMany({
    where: { projectId: run.projectId },
    include: { groups: { include: { items: true } } },
  });
  const mainSessions = sessions.filter((s) => s.dataRole === "MAIN");
  const rawSessions: RawSessionRow[] = mainSessions.map((s) => ({
    id: s.id,
    countryCode: s.countryCode,
    dataRole: s.dataRole as DataRole,
    groups: s.groups.map((g) => ({ items: g.items.map((i) => ({ statementId: i.statementId })) })),
  }));
  const project = toFixtureProject(run.projectId, rawStatements);
  const scopeResult = filterSessionsForScope(project, toFixtureSessions(rawSessions), run.scope as AnalysisScope);
  const createdAt = new Map(mainSessions.map((s) => [s.id, s.createdAt.getTime()]));
  const participants = buildParticipants(project.statementIds, scopeResult.validSessions, createdAt);
  if (canonicalHash(participants) !== snap.participantsHash) throw new PackageInputChangedError("responses differ from the run's snapshot");

  // pid -> session, with exactly the ordering buildParticipants used (submission time, then session id; per-country counters)
  const idx = new Map(project.statementIds.map((id, i) => [id, i]));
  const bySession = new Map(mainSessions.map((s) => [s.id, s]));
  const orderedValid = [...scopeResult.validSessions].sort((a, b) => {
    const d = (createdAt.get(a.sessionId) ?? 0) - (createdAt.get(b.sessionId) ?? 0);
    if (d !== 0) return d;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
  const extras: RawForPackage["extras"] = {};
  const counters: Record<string, number> = {};
  orderedValid.forEach((v, n) => {
    const country = v.countryCode as "KR" | "JP";
    counters[country] = (counters[country] ?? 0) + 1;
    const pid = `${country}-${String(counters[country]).padStart(3, "0")}`;
    if (participants[n].pid !== pid) throw new PackageInputChangedError("pseudonymous id order differs");
    const db = bySession.get(v.sessionId)!;
    const piles = db.groups.map((g) => ({ label: g.label, min: Math.min(...g.items.map((i) => idx.get(i.statementId)!)) })).sort((a, b) => a.min - b.min);
    extras[pid] = { createdAtMs: db.createdAt.getTime(), pileLabels: piles.map((p) => p.label) };
  });
  return { participants, extras, excludedPilot: sessions.length - mainSessions.length };
}
