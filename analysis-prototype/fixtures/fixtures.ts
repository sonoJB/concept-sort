/**
 * Synthetic, neutral fixtures for the concept-map statistics prototype.
 * None of this is real production data — no rrrvvnux content, no real
 * research statements, no participant names/phone numbers/adminTokens.
 */
import type { FixtureProject, FixtureSession, Matrix } from "../../src/lib/conceptAnalysis";

// ---- A. 3-point simple structure (hand-verifiable) ----
// Dissimilarities chosen so distances/stress can be checked by hand.
export const fixtureA_dissimilarity: Matrix = [
  [0, 0.2, 0.8],
  [0.2, 0, 0.6],
  [0.8, 0.6, 0],
];

// ---- B. 4-point square (2D should recover it near-perfectly, low stress) ----
// True 2D coordinates: (0,0) (1,0) (1,1) (0,1) -> pairwise Euclidean distances below.
const sqrt2 = Math.sqrt(2);
export const fixtureB_square_dissimilarity: Matrix = [
  [0, 1, sqrt2, 1],
  [1, 0, 1, sqrt2],
  [sqrt2, 1, 0, 1],
  [1, sqrt2, 1, 0],
];

// ---- C. Two clean clusters of 3 (for Ward merge-order verification) ----
// Cluster {0,1,2} close together, cluster {3,4,5} close together, far apart.
export const fixtureC_twoClusters_dissimilarity: Matrix = [
  [0, 0.1, 0.15, 0.9, 0.92, 0.88],
  [0.1, 0, 0.12, 0.91, 0.9, 0.89],
  [0.15, 0.12, 0, 0.93, 0.91, 0.9],
  [0.9, 0.91, 0.93, 0, 0.1, 0.14],
  [0.92, 0.9, 0.91, 0.1, 0, 0.11],
  [0.88, 0.89, 0.9, 0.14, 0.11, 0],
];

// ---- D. Ties-heavy dissimilarity (many repeated values) ----
export const fixtureD_ties_dissimilarity: Matrix = [
  [0, 0.5, 0.5, 0.5, 0.5],
  [0.5, 0, 0.5, 0.5, 0.5],
  [0.5, 0.5, 0, 0.3, 0.3],
  [0.5, 0.5, 0.3, 0, 0.3],
  [0.5, 0.5, 0.3, 0.3, 0],
];

// ---- E. Off-diagonal zero (two statements always co-sorted => dissimilarity 0) ----
export const fixtureE_offDiagonalZero_dissimilarity: Matrix = [
  [0, 0, 0.7, 0.6],
  [0, 0, 0.65, 0.62],
  [0.7, 0.65, 0, 0.3],
  [0.6, 0.62, 0.3, 0],
];

// ---- F. All dissimilarities identical (degenerate / no structure) ----
export const fixtureF_allEqual_dissimilarity: Matrix = [
  [0, 0.4, 0.4, 0.4],
  [0.4, 0, 0.4, 0.4],
  [0.4, 0.4, 0, 0.4],
  [0.4, 0.4, 0.4, 0],
];

// ---- G. 8 statements, synthetic participants for KR/JP/ALL scope tests ----
export const fixtureG_project: FixtureProject = {
  projectKey: "proto-fixture-g",
  statementIds: ["st1", "st2", "st3", "st4", "st5", "st6", "st7", "st8"],
};

export const fixtureG_sessions: FixtureSession[] = [
  // KR valid sessions (structure: {st1,st2,st3,st4} + {st5,st6,st7,st8})
  { sessionId: "kr-1", countryCode: "KR", groups: [["st1", "st2", "st3", "st4"], ["st5", "st6", "st7", "st8"]] },
  { sessionId: "kr-2", countryCode: "KR", groups: [["st1", "st2"], ["st3", "st4", "st5"], ["st6", "st7", "st8"]] },
  { sessionId: "kr-3", countryCode: "KR", groups: [["st1", "st2", "st3"], ["st4", "st5", "st6"], ["st7", "st8"]] },
  // JP valid sessions (different structure on purpose: {st1,st5} together etc.)
  { sessionId: "jp-1", countryCode: "JP", groups: [["st1", "st5"], ["st2", "st6"], ["st3", "st7"], ["st4", "st8"]] },
  { sessionId: "jp-2", countryCode: "JP", groups: [["st1", "st5", "st2"], ["st6", "st3", "st7"], ["st4", "st8"]] },
  // null countryCode — must be excluded from KR, JP, and ALL
  { sessionId: "null-1", countryCode: null, groups: [["st1", "st2", "st3", "st4"], ["st5", "st6", "st7", "st8"]] },
  // incomplete (missing st8) — must be excluded
  { sessionId: "incomplete-1", countryCode: "KR", groups: [["st1", "st2", "st3", "st4"], ["st5", "st6", "st7"]] },
  // duplicate assignment (st1 appears twice) — must be excluded
  { sessionId: "duplicate-1", countryCode: "JP", groups: [["st1", "st2", "st3", "st4"], ["st1", "st5", "st6", "st7", "st8"]] },
  // invalid statementId (from a different fictitious project) — must be excluded
  { sessionId: "invalid-1", countryCode: "KR", groups: [["st1", "st2", "st3", "NOT-IN-PROJECT"], ["st5", "st6", "st7", "st8"]] },
];

// ---- H. 47-statement performance fixture (neutral ids, synthetic sessions) ----
export function buildFixtureH(participantCount: number): { project: FixtureProject; sessions: FixtureSession[] } {
  const statementIds = Array.from({ length: 47 }, (_, i) => `perf_st_${String(i + 1).padStart(2, "0")}`);
  const project: FixtureProject = { projectKey: "proto-fixture-h", statementIds };

  // Deterministic synthetic sessions: no Math.random — simple LCG-free
  // pattern based on participant index, split into a variable number of
  // near-equal groups so every session's assignment is still "complete".
  const sessions: FixtureSession[] = [];
  for (let p = 0; p < participantCount; p++) {
    const groupCount = 4 + (p % 5); // 4..8 groups
    const groups: string[][] = Array.from({ length: groupCount }, () => []);
    statementIds.forEach((id, idx) => {
      const g = (idx + p) % groupCount;
      groups[g].push(id);
    });
    sessions.push({
      sessionId: `perf-${p}`,
      countryCode: p % 3 === 0 ? "JP" : "KR",
      groups: groups.filter((g) => g.length > 0),
    });
  }
  return { project, sessions };
}
