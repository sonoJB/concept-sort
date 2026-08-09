/**
 * Deterministic quadrant assignment, origin at (0,0). Zero is always
 * grouped with the positive side on both axes (documented policy, not
 * incidental): x>=0 -> right, x<0 -> left; y>=0 -> upper, y<0 -> lower.
 * Labels are always Q1..Q4 unless the researcher has entered their own
 * quadrant labels via the interpretation editor — no automatic semantic
 * naming is ever generated here.
 */
export type Quadrant = "Q1" | "Q2" | "Q3" | "Q4";

/** Q1 = upper-right, Q2 = upper-left, Q3 = lower-left, Q4 = lower-right — the conventional Cartesian ordering. */
export function assignQuadrant(x: number, y: number): Quadrant {
  const right = x >= 0;
  const upper = y >= 0;
  if (right && upper) return "Q1";
  if (!right && upper) return "Q2";
  if (!right && !upper) return "Q3";
  return "Q4";
}
