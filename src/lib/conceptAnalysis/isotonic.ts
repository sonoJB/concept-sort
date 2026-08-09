/**
 * Weighted isotonic regression (Pool Adjacent Violators Algorithm), used to
 * fit the nonmetric MDS "disparities": a monotone-non-decreasing sequence
 * closest (in weighted least squares) to a target sequence, when the target
 * is presented in a fixed external order (here: ascending dissimilarity).
 *
 * This file is a pure, DB- and MDS-independent numerical function so it can
 * be unit-tested in isolation.
 */

export type IsotonicInput = {
  /** Target values, already in the order the fit must be non-decreasing over. */
  values: number[];
  /** Non-negative weights, same length as `values`. A weight of 0 means "ignore this observation's value but keep its slot". */
  weights: number[];
};

/**
 * Ties handling: this implementation uses the "secondary" approach — values
 * whose *rank key* is exactly equal (see `isotonicRegressionByRank`) are
 * pre-pooled into one block before PAVA runs, so tied inputs always receive
 * identical fitted output. This is a deliberate, documented choice (Kruskal
 * 1964 describes primary/secondary/tertiary tie-handling; secondary is used
 * here for determinism — it does not depend on how the tied group happens to
 * be ordered internally).
 */
export function isotonicRegressionAscending(values: number[], weights: number[]): number[] {
  if (values.length !== weights.length) {
    throw new Error("isotonicRegressionAscending: values and weights must have equal length");
  }
  const n = values.length;
  if (n === 0) {
    throw new Error("isotonicRegressionAscending: empty input is not a valid regression target");
  }

  type Block = { weightedSum: number; weight: number; mean: number; start: number; end: number };
  const blocks: Block[] = [];

  for (let i = 0; i < n; i++) {
    const w = weights[i];
    const block: Block = {
      weightedSum: values[i] * w,
      weight: w,
      mean: w > 0 ? values[i] : values[i],
      start: i,
      end: i,
    };
    blocks.push(block);

    while (blocks.length > 1 && blocks[blocks.length - 2].mean > blocks[blocks.length - 1].mean) {
      const b2 = blocks.pop()!;
      const b1 = blocks.pop()!;
      const weightedSum = b1.weightedSum + b2.weightedSum;
      const weight = b1.weight + b2.weight;
      const mean = weight > 0 ? weightedSum / weight : (b1.mean * (b1.end - b1.start + 1) + b2.mean * (b2.end - b2.start + 1)) / (b1.end - b1.start + 1 + (b2.end - b2.start + 1));
      blocks.push({ weightedSum, weight, mean, start: b1.start, end: b2.end });
    }
  }

  const fitted = new Array<number>(n);
  for (const b of blocks) {
    for (let i = b.start; i <= b.end; i++) fitted[i] = b.mean;
  }
  return fitted;
}

/**
 * Fits disparities for a set of (rankKey, targetValue, weight) observations
 * where rankKey is the dissimilarity used to establish ascending order
 * (e.g. δ_ij). Values that share an identical rankKey (within `tieEps`) are
 * pooled into a single tie block *before* PAVA runs (secondary tie
 * handling), so they always receive one shared fitted value. Ties are
 * resolved using the pooled (weighted-mean) target, and PAVA is then run
 * over the block sequence; the result is expanded back to the original
 * per-observation order.
 *
 * Returns fitted values in the SAME order as the input array (not sorted).
 */
export function isotonicRegressionByRank(
  observations: { rankKey: number; value: number; weight: number }[],
  tieEps = 1e-9
): number[] {
  const n = observations.length;
  if (n === 0) {
    throw new Error("isotonicRegressionByRank: empty input is not a valid regression target");
  }

  const order = observations
    .map((o, i) => ({ ...o, originalIndex: i }))
    .sort((a, b) => a.rankKey - b.rankKey);

  // Group consecutive equal-rankKey observations into tie blocks.
  type TieGroup = { rankKey: number; indices: number[]; weightedSum: number; weight: number };
  const groups: TieGroup[] = [];
  for (const o of order) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.rankKey - o.rankKey) <= tieEps) {
      last.indices.push(o.originalIndex);
      last.weightedSum += o.value * o.weight;
      last.weight += o.weight;
    } else {
      groups.push({ rankKey: o.rankKey, indices: [o.originalIndex], weightedSum: o.value * o.weight, weight: o.weight });
    }
  }

  const groupTargets = groups.map((g) => (g.weight > 0 ? g.weightedSum / g.weight : 0));
  const groupWeights = groups.map((g) => g.weight);
  const fittedGroups = isotonicRegressionAscending(groupTargets, groupWeights);

  const fitted = new Array<number>(n);
  groups.forEach((g, gi) => {
    for (const idx of g.indices) fitted[idx] = fittedGroups[gi];
  });
  return fitted;
}
