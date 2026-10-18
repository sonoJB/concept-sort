/** Read-only loader: 본조사(MAIN) participants as pseudonymous research records (no names, phones, session ids). */
import { DatabaseSync } from "node:sqlite";
import type { Participant } from "../../src/lib/conceptMap/matrices";

export type RawExport = {
  statements: { id: string; order: number; text: string; textJa: string | null; jaStatus: string }[];
  participants: Participant[];
  /** package-only extras keyed by pid (never part of the analysis input) */
  extras: Record<string, { createdAtMs: number; pileLabels: string[]; sessionIdSha?: never }>;
  excludedPilot: number;
};

export function loadParticipants(dbFile: string): RawExport {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const statements = db.prepare('select id, "order", text, textJa, jaStatus from Statement order by "order"').all() as RawExport["statements"];
    const idx = new Map(statements.map((s, i) => [s.id, i]));
    const sessions = db.prepare("select id, countryCode, createdAt from SortSession where dataRole = 'MAIN' order by createdAt, id").all() as { id: string; countryCode: string; createdAt: number }[];
    const rows = db.prepare("select g.sortSessionId sid, g.id gid, g.label label, i.statementId st from SortGroup g join SortGroupItem i on i.groupId = g.id").all() as { sid: string; gid: string; label: string; st: string }[];
    const bySession = new Map<string, Map<string, { label: string; items: number[] }>>();
    for (const r of rows) {
      const m = bySession.get(r.sid) ?? new Map();
      if (!m.has(r.gid)) m.set(r.gid, { label: r.label, items: [] });
      m.get(r.gid)!.items.push(idx.get(r.st)!);
      bySession.set(r.sid, m);
    }
    const counters: Record<string, number> = {};
    const participants: Participant[] = [];
    const extras: RawExport["extras"] = {};
    for (const s of sessions) {
      if (s.countryCode !== "KR" && s.countryCode !== "JP") throw new Error("MAIN session without KR/JP country");
      counters[s.countryCode] = (counters[s.countryCode] ?? 0) + 1;
      const pid = `${s.countryCode}-${String(counters[s.countryCode]).padStart(3, "0")}`;
      const piles = [...(bySession.get(s.id)?.values() ?? [])].map((p) => ({ ...p, items: p.items.sort((a, b) => a - b) })).sort((a, b) => a.items[0] - b.items[0]);
      const assignment = new Array(statements.length).fill(-1);
      piles.forEach((p, g) => p.items.forEach((i) => (assignment[i] = g)));
      participants.push({ pid, country: s.countryCode, assignment });
      extras[pid] = { createdAtMs: s.createdAt, pileLabels: piles.map((p) => p.label) };
    }
    const excludedPilot = (db.prepare("select count(*) c from SortSession where dataRole <> 'MAIN'").get() as { c: number }).c;
    return { statements, participants, extras, excludedPilot };
  } finally {
    db.close();
  }
}
