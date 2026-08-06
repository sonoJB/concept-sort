import type { AnalysisScope, ExclusionSummary, FixtureProject, FixtureSession, ScopeFilterResult } from "./types";

/**
 * Determines whether a single session's group structure fully and validly
 * covers a project's statement set: every statement placed exactly once,
 * no duplicates, no foreign statementIds.
 */
function isCompleteValidSort(
  session: FixtureSession,
  validStatementIds: Set<string>
): { complete: boolean; duplicate: boolean; invalid: boolean } {
  const seen = new Set<string>();
  let duplicate = false;
  let invalid = false;

  for (const group of session.groups) {
    if (group.length === 0) continue; // an empty group carries no assignments either way
    for (const id of group) {
      if (!validStatementIds.has(id)) {
        invalid = true;
        continue;
      }
      if (seen.has(id)) {
        duplicate = true;
        continue;
      }
      seen.add(id);
    }
  }

  const complete = seen.size === validStatementIds.size;
  return { complete, duplicate, invalid };
}

/**
 * Filters a project's sessions down to the valid set for one AnalysisScope.
 * countryCode === null is NEVER included in KR, JP, or ALL — existing null
 * rows are excluded, not inferred to be "KR" or backfilled in any way.
 *
 * ALL is a pooled union of KR-valid and JP-valid sessions, one observation
 * per participant — no 50/50 reweighting between countries.
 */
export function filterSessionsForScope(
  project: FixtureProject,
  sessions: FixtureSession[],
  scope: AnalysisScope
): ScopeFilterResult {
  const validStatementIds = new Set(project.statementIds);

  let excludedNullCountry = 0;
  let excludedWrongCountryForScope = 0;
  let excludedIncomplete = 0;
  let excludedDuplicate = 0;
  let excludedInvalidStatement = 0;

  const validSessions: FixtureSession[] = [];
  let nKr = 0;
  let nJp = 0;

  for (const session of sessions) {
    if (session.countryCode === null) {
      excludedNullCountry++;
      continue;
    }
    const inScope =
      scope === "ALL" ? true : scope === "KR" ? session.countryCode === "KR" : session.countryCode === "JP";
    if (!inScope) {
      excludedWrongCountryForScope++;
      continue;
    }

    const { complete, duplicate, invalid } = isCompleteValidSort(session, validStatementIds);
    if (invalid) {
      excludedInvalidStatement++;
      continue;
    }
    if (duplicate) {
      excludedDuplicate++;
      continue;
    }
    if (!complete) {
      excludedIncomplete++;
      continue;
    }

    validSessions.push(session);
    if (session.countryCode === "KR") nKr++;
    else if (session.countryCode === "JP") nJp++;
  }

  const exclusions: ExclusionSummary = {
    scope,
    totalSessionsInProject: sessions.length,
    excludedNullCountry,
    excludedWrongCountryForScope,
    excludedIncomplete,
    excludedDuplicate,
    excludedInvalidStatement,
    validCount: validSessions.length,
  };

  return {
    scope,
    validSessions,
    nKr,
    nJp,
    nTotal: validSessions.length,
    exclusions,
  };
}
