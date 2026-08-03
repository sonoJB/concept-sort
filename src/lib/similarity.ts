export type SortedSession = {
  groups: { statementIds: string[] }[];
};

/**
 * Raw co-occurrence counts between statements: how many participants placed
 * each pair in the same group. This is the aggregate "group matrix" used in
 * concept mapping methodology, before it's normalized for MDS/clustering.
 */
export function buildCooccurrenceMatrix(
  statementIds: string[],
  sessions: SortedSession[]
): number[][] {
  const n = statementIds.length;
  const index = new Map(statementIds.map((id, i) => [id, i]));
  const cooccurrence = Array.from({ length: n }, () => new Array(n).fill(0));

  for (const session of sessions) {
    for (const group of session.groups) {
      const memberIndices = group.statementIds
        .map((id) => index.get(id))
        .filter((i): i is number => i !== undefined);

      for (let a = 0; a < memberIndices.length; a++) {
        for (let b = a; b < memberIndices.length; b++) {
          const i = memberIndices[a];
          const j = memberIndices[b];
          cooccurrence[i][j] += 1;
          if (i !== j) cooccurrence[j][i] += 1;
        }
      }
    }
  }

  return cooccurrence;
}

/**
 * Builds a symmetric similarity matrix (0..1) between statements based on how
 * often participants placed each pair in the same group.
 */
export function buildSimilarityMatrix(
  statementIds: string[],
  sessions: SortedSession[]
): number[][] {
  const n = statementIds.length;
  const cooccurrence = buildCooccurrenceMatrix(statementIds, sessions);

  const sessionCount = Math.max(sessions.length, 1);
  const similarity = cooccurrence.map((row) =>
    row.map((count) => count / sessionCount)
  );
  for (let i = 0; i < n; i++) similarity[i][i] = 1;

  return similarity;
}
