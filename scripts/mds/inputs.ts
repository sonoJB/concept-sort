/**
 * Loads the official 본조사 MDS inputs for one scope from a SQLite snapshot, through the SAME
 * functions the application uses when it creates an AnalysisRun (scope filter -> numeric aggregate),
 * so offline analysis and the admin-created runs cannot diverge. Read-only.
 */
import { DatabaseSync } from "node:sqlite";
import { filterSessionsForScope, type AnalysisScope, type Matrix } from "../../src/lib/conceptAnalysis";
import { buildNumericAggregate } from "../../src/lib/analysis/aggregates";
import { toFixtureProject, toFixtureSessions, type RawSessionRow, type RawStatementRow } from "../../src/lib/analysis/dbAdapter";

export type ScopeInputs = {
  scope: AnalysisScope;
  n: number;
  nKr: number;
  nJp: number;
  statementCount: number;
  statementIds: string[];
  count: Matrix;
  proportion: Matrix;
  dissimilarity: Matrix;
  weight: Matrix;
};

export function loadScopeInputs(dbFile: string, scope: AnalysisScope, dataset: "MAIN" = "MAIN"): ScopeInputs {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const stmts = db.prepare('select id, "order", text, textJa, jaStatus from Statement order by "order"').all() as {
      id: string;
      order: number;
      text: string;
      textJa: string | null;
      jaStatus: string;
    }[];
    const rawStatements: RawStatementRow[] = stmts.map((s) => ({ id: s.id, order: s.order, text: s.text, textJa: s.textJa, jaStatus: s.jaStatus }));
    const sessions = db.prepare("select id, countryCode, dataRole from SortSession where dataRole = ?").all(dataset) as {
      id: string;
      countryCode: string | null;
      dataRole: string;
    }[];
    const groupRows = db
      .prepare("select g.sortSessionId sid, g.id gid, i.statementId st from SortGroup g join SortGroupItem i on i.groupId = g.id")
      .all() as { sid: string; gid: string; st: string }[];
    const bySession = new Map<string, Map<string, string[]>>();
    for (const r of groupRows) {
      const m = bySession.get(r.sid) ?? new Map<string, string[]>();
      if (!m.has(r.gid)) m.set(r.gid, []);
      m.get(r.gid)!.push(r.st);
      bySession.set(r.sid, m);
    }
    const rawSessions: RawSessionRow[] = sessions.map((s) => ({
      id: s.id,
      countryCode: s.countryCode,
      dataRole: "MAIN",
      groups: [...(bySession.get(s.id)?.values() ?? [])].map((items) => ({ items: items.map((statementId) => ({ statementId })) })),
    }));
    const project = toFixtureProject("offline", rawStatements);
    const filtered = filterSessionsForScope(project, toFixtureSessions(rawSessions), scope);
    const agg = buildNumericAggregate(project, filtered.validSessions);
    return {
      scope,
      n: filtered.validSessions.length,
      nKr: filtered.nKr,
      nJp: filtered.nJp,
      statementCount: rawStatements.length,
      statementIds: project.statementIds,
      count: agg.similarityCountMatrix,
      proportion: agg.similarityProportionMatrix,
      dissimilarity: agg.dissimilarityMatrix,
      weight: agg.weightMatrix,
    };
  } finally {
    db.close();
  }
}
