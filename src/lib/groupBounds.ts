/**
 * Card-sorting group-count rules:
 * - Every group must hold at least 2 statements.
 * - No group may reach ~1/3 of all statements (kept strictly below that share).
 * Those two per-group size bounds determine the valid range for how many
 * groups a participant may create.
 */
export function computeGroupBounds(statementCount: number) {
  const maxCardsPerGroup = Math.max(2, Math.ceil(statementCount / 3) - 1);
  const minGroups = Math.max(2, Math.ceil(statementCount / maxCardsPerGroup));
  const maxGroups = Math.max(minGroups, Math.floor(statementCount / 2));
  return { maxCardsPerGroup, minGroups, maxGroups };
}

/** Describes one way to build the minimum number of groups (largest-first). */
export function describeMinGroupBreakdown(
  statementCount: number,
  maxCardsPerGroup: number,
  minGroups: number
): string {
  const remainder = statementCount - (minGroups - 1) * maxCardsPerGroup;
  if (remainder === maxCardsPerGroup) {
    return `카드 ${maxCardsPerGroup}장으로 구성된 ${minGroups}개 묶음`;
  }
  return `카드 ${remainder}장으로 구성된 1개 묶음, 카드 ${maxCardsPerGroup}장으로 구성된 ${
    minGroups - 1
  }개 묶음`;
}

/** Describes one way to build the maximum number of groups (smallest-first). */
export function describeMaxGroupBreakdown(
  statementCount: number,
  maxGroups: number
): string {
  const remainder = statementCount - maxGroups * 2;
  if (remainder === 0) {
    return `카드 2장으로 구성된 ${maxGroups}개 묶음`;
  }
  return `카드 2장으로 구성된 ${maxGroups - 1}개 묶음, 카드 ${
    2 + remainder
  }장으로 구성된 1개 묶음`;
}
