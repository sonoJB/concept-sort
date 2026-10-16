import { createHash } from "node:crypto";
import {
  assertSquareSymmetric,
  buildSimilarityCountMatrix,
  buildSimilarityProportionMatrix,
  filterSessionsForScope,
  type AnalysisScope,
  type FixtureSession,
  type Matrix,
} from "@/lib/conceptAnalysis";

/**
 * Official 본조사 (MAIN-study) similarity-matrix computation, shared by the
 * admin download route and the offline backup/restore-verification scripts so
 * that "the file the button downloads" and "the matrix regenerated from a
 * restored backup" are produced by exactly the same code.
 *
 * Definitions are NOT new: eligibility (complete, duplicate-free, valid
 * statements only; null country never included) and the count/proportion
 * matrices are the existing, verified concept-analysis engine functions
 * (`filterSessionsForScope`, `buildSimilarityCountMatrix`,
 * `buildSimilarityProportionMatrix`). This module only adds:
 *   - the hard dataRole=MAIN gate (pilots/anything else can never enter),
 *   - an optional `asOf` cut-off so several files can share one data snapshot,
 *   - pseudonymous participant IDs and fingerprints for cross-file checks.
 */

export type OfficialScope = "ALL" | "KR" | "JP";

export const OFFICIAL_SCOPES: readonly OfficialScope[] = ["ALL", "KR", "JP"];

export function isOfficialScope(value: unknown): value is OfficialScope {
  return value === "ALL" || value === "KR" || value === "JP";
}

export type OfficialStatement = {
  id: string;
  order: number;
  textKo: string;
  textJa: string | null;
  jaStatus: string;
};

export type OfficialSessionInput = {
  id: string;
  countryCode: string | null;
  dataRole: string;
  createdAt: Date;
  /** statementIds per group, exactly as stored. */
  groups: string[][];
};

export type ExcludedReason =
  | "NOT_MAIN_ROLE"
  | "AFTER_AS_OF"
  | "NULL_COUNTRY"
  | "OUT_OF_SCOPE_COUNTRY"
  | "INCOMPLETE"
  | "DUPLICATE_STATEMENT"
  | "INVALID_STATEMENT";

export type OfficialMatrixResult = {
  scope: OfficialScope;
  asOf: string | null;
  statements: OfficialStatement[];
  /** Valid N used as the denominator of the proportion matrix. */
  nKr: number;
  nJp: number;
  nTotal: number;
  /** Counts of every session that was NOT included, by reason (MAIN-role sessions only, plus NOT_MAIN_ROLE / AFTER_AS_OF bookkeeping). */
  exclusionCounts: Record<ExcludedReason, number>;
  /** Pseudonymous IDs of excluded MAIN-role sessions that are individually reportable (data-quality reasons). */
  excludedMainDetail: { anonId: string; reason: ExcludedReason; countryCode: string | null }[];
  included: { anonId: string; countryCode: "KR" | "JP"; submittedAt: string; groupCount: number }[];
  /** Null when nTotal === 0: an empty scope has no defined matrix and must never be exported as a "zero matrix". */
  countMatrix: Matrix | null;
  proportionMatrix: Matrix | null;
  /** Hash of the whole MAIN data snapshot (both countries) — identical across the ALL/KR/JP files when generated from the same data. */
  sourceFingerprint: string;
  /** Hash of exactly the sessions + statement order included in THIS scope. */
  scopeFingerprint: string;
};

/**
 * Returns a NEW frequency matrix equal to `count` everywhere off the diagonal,
 * with every diagonal cell set to `n` (the scope's valid participant count).
 * The input matrix is never modified, so the analysis engine's matrices and the
 * other worksheets are unaffected.
 */
export function withDiagonalN(count: Matrix, n: number): Matrix {
  return count.map((row, i) => row.map((v, j) => (i === j ? n : v)));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable pseudonym for a session: not the DB id (which embeds a creation timestamp), not reversible without the DB. */
export function anonymousParticipantId(sessionId: string): string {
  return "MP-" + sha256("official-matrix:" + sessionId).slice(0, 10);
}

function canonicalGroups(groups: string[][]): string {
  return JSON.stringify(
    groups
      .map((g) => [...g].sort())
      .filter((g) => g.length > 0)
      .sort((a, b) => (a.join(",") < b.join(",") ? -1 : a.join(",") > b.join(",") ? 1 : 0))
  );
}

function emptyExclusions(): Record<ExcludedReason, number> {
  return {
    NOT_MAIN_ROLE: 0,
    AFTER_AS_OF: 0,
    NULL_COUNTRY: 0,
    OUT_OF_SCOPE_COUNTRY: 0,
    INCOMPLETE: 0,
    DUPLICATE_STATEMENT: 0,
    INVALID_STATEMENT: 0,
  };
}

function normalizeCountry(code: string | null): "KR" | "JP" | null {
  return code === "KR" || code === "JP" ? code : null;
}

/**
 * Builds the official 본조사 matrices for one scope.
 *
 * `sessions` may contain every session of the project (any dataRole, any
 * time); this function applies the MAIN gate and the optional `asOf` cut-off
 * itself so no caller can accidentally widen the population.
 */
export function buildOfficialMatrix(input: {
  projectKey: string;
  scope: OfficialScope;
  statements: OfficialStatement[];
  sessions: OfficialSessionInput[];
  asOf?: Date | null;
}): OfficialMatrixResult {
  const { scope } = input;
  const statements = [...input.statements].sort((a, b) => a.order - b.order);
  const statementIds = statements.map((s) => s.id);
  const asOf = input.asOf ?? null;

  const exclusionCounts = emptyExclusions();
  const excludedMainDetail: OfficialMatrixResult["excludedMainDetail"] = [];

  // 1) Hard population gate: dataRole must be exactly MAIN, and not newer than asOf.
  const mainSessions: OfficialSessionInput[] = [];
  for (const s of input.sessions) {
    if (s.dataRole !== "MAIN") {
      exclusionCounts.NOT_MAIN_ROLE++;
      continue;
    }
    if (asOf && s.createdAt.getTime() > asOf.getTime()) {
      exclusionCounts.AFTER_AS_OF++;
      continue;
    }
    mainSessions.push(s);
  }

  // 2) Eligibility + scope filter: the existing verified engine function.
  const fixtures: FixtureSession[] = mainSessions.map((s) => ({
    sessionId: s.id,
    countryCode: normalizeCountry(s.countryCode),
    groups: s.groups,
  }));
  const filtered = filterSessionsForScope(
    { projectKey: input.projectKey, statementIds },
    fixtures,
    scope as AnalysisScope
  );

  const validIds = new Set(filtered.validSessions.map((s) => s.sessionId));
  const byId = new Map(mainSessions.map((s) => [s.id, s]));

  // Reason bookkeeping for every MAIN session that did not make it in.
  const statementSet = new Set(statementIds);
  for (const s of mainSessions) {
    if (validIds.has(s.id)) continue;
    const country = normalizeCountry(s.countryCode);
    let reason: ExcludedReason;
    if (country === null) {
      reason = "NULL_COUNTRY";
    } else if (scope !== "ALL" && country !== scope) {
      reason = "OUT_OF_SCOPE_COUNTRY";
    } else {
      const seen = new Set<string>();
      let invalid = false;
      let duplicate = false;
      for (const g of s.groups) {
        for (const id of g) {
          if (!statementSet.has(id)) invalid = true;
          else if (seen.has(id)) duplicate = true;
          else seen.add(id);
        }
      }
      reason = invalid ? "INVALID_STATEMENT" : duplicate ? "DUPLICATE_STATEMENT" : "INCOMPLETE";
    }
    exclusionCounts[reason]++;
    // Out-of-scope country is an expected consequence of choosing KR/JP, not a data problem — count only.
    if (reason !== "OUT_OF_SCOPE_COUNTRY") {
      excludedMainDetail.push({ anonId: anonymousParticipantId(s.id), reason, countryCode: s.countryCode });
    }
  }

  // 3) Matrices from the engine. N = 0 is NOT exported as a zero matrix.
  const nTotal = filtered.nTotal;
  let countMatrix: Matrix | null = null;
  let proportionMatrix: Matrix | null = null;
  if (nTotal > 0) {
    countMatrix = buildSimilarityCountMatrix(statementIds, filtered.validSessions);
    proportionMatrix = buildSimilarityProportionMatrix(countMatrix, nTotal);
    assertSquareSymmetric(countMatrix, "officialCountMatrix");
    assertSquareSymmetric(proportionMatrix, "officialProportionMatrix");
  }

  const included = filtered.validSessions
    .map((fs) => {
      const src = byId.get(fs.sessionId)!;
      return {
        anonId: anonymousParticipantId(fs.sessionId),
        countryCode: fs.countryCode as "KR" | "JP",
        submittedAt: src.createdAt.toISOString(),
        groupCount: fs.groups.filter((g) => g.length > 0).length,
      };
    })
    .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : a.anonId < b.anonId ? -1 : 1));

  const anonIds = new Set(included.map((p) => p.anonId));
  if (anonIds.size !== included.length) {
    throw new Error("officialMatrix: pseudonymous participant ID collision");
  }

  // 4) Fingerprints. sourceFingerprint covers the entire MAIN snapshot (both countries,
  // regardless of scope) so the three files can be proven to come from the same data.
  const sourceLines = mainSessions
    .map((s) => `${s.id}|${normalizeCountry(s.countryCode) ?? "NULL"}|${canonicalGroups(s.groups)}`)
    .sort();
  const sourceFingerprint = sha256(JSON.stringify({ statementIds, sessions: sourceLines }));
  const scopeLines = filtered.validSessions
    .map((s) => `${s.sessionId}|${s.countryCode}|${canonicalGroups(s.groups)}`)
    .sort();
  const scopeFingerprint = sha256(JSON.stringify({ scope, statementIds, sessions: scopeLines }));

  return {
    scope,
    asOf: asOf ? asOf.toISOString() : null,
    statements,
    nKr: filtered.nKr,
    nJp: filtered.nJp,
    nTotal,
    exclusionCounts,
    excludedMainDetail,
    included,
    countMatrix,
    proportionMatrix,
    sourceFingerprint,
    scopeFingerprint,
  };
}
