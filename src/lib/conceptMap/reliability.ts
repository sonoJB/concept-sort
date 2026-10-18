/**
 * Repeated random split-half reliability of the item-pair similarity matrix (Trochim, Cook & Setze, 1994).
 * For each repetition participants are split into two halves, each half is aggregated into its own co-occurrence
 * matrix, and the two halves' upper-triangle off-diagonal values (the same 1,081 item pairs) are correlated
 * (Pearson). The Spearman–Brown value 2r/(1+r) projects the half-length correlation to full length under the
 * assumption of parallel halves. This is a reliability of the MATRIX, not of the map.
 *
 *  - KR 30 -> 15/15, JP 38 -> 19/19; ALL: each half receives 15 KR + 19 JP (stratified by country).
 *  - Splitting happens on a copy of the data only; the main analysis always uses all valid responses.
 *  - Nothing is selected, truncated or floored: negative r stay negative, undefined values are counted separately.
 *  - The quantile ranges are the empirical spread over random splits of THIS sample, not a population
 *    confidence interval.
 */
import { mulberry32, deriveSeed } from "../conceptAnalysis/prng";
import { describe, quantile, type Distribution, type Participant } from "./matrices";

export type SplitHalfSettings = { repetitions: number; seed: number };

export type SplitHalfSummary = {
  design: string;
  repetitions: number;
  seed: number;
  halfSizes: Record<string, number[]>;
  rawR: Distribution | null;
  spearmanBrown: Distribution | null;
  rawQuantiles: Record<string, number> | null;
  spearmanBrownQuantiles: Record<string, number> | null;
  undefinedCount: number;
  spearmanBrownUndefinedCount: number;
  negativeRawCount: number;
  /** per repetition raw r (NaN stored as null) so the distribution can be re-plotted */
  rawValues: (number | null)[];
  spearmanBrownValues: (number | null)[];
};

function pairVector(assignment: number[]): Uint8Array {
  const n = assignment.length;
  const out = new Uint8Array((n * (n - 1)) / 2);
  let k = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out[k++] = assignment[i] === assignment[j] ? 1 : 0;
  return out;
}

export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

const QS: [string, number][] = [["p2.5", 0.025], ["p5", 0.05], ["p25", 0.25], ["p50", 0.5], ["p75", 0.75], ["p95", 0.95], ["p97.5", 0.975]];

function summarizeValues(values: (number | null)[]) {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return { dist: null, q: null };
  const s = [...finite].sort((a, b) => a - b);
  return { dist: describe(finite), q: Object.fromEntries(QS.map(([k, p]) => [k, quantile(s, p)])) };
}

export function splitHalfReliability(participants: Participant[], scope: "KR" | "JP" | "ALL", settings: SplitHalfSettings): SplitHalfSummary {
  const vecs = new Map(participants.map((p) => [p.pid, pairVector(p.assignment)]));
  const pairs = vecs.values().next().value!.length;
  const byCountry = { KR: participants.filter((p) => p.country === "KR"), JP: participants.filter((p) => p.country === "JP") };
  const groups: { name: string; people: Participant[] }[] = scope === "ALL" ? [{ name: "KR", people: byCountry.KR }, { name: "JP", people: byCountry.JP }] : [{ name: scope, people: participants }];
  const halfSizes: Record<string, number[]> = {};
  for (const g of groups) halfSizes[g.name] = [Math.floor(g.people.length / 2), g.people.length - Math.floor(g.people.length / 2)];
  const raw: (number | null)[] = [];
  const sb: (number | null)[] = [];
  let undef = 0;
  let sbUndef = 0;
  let negative = 0;
  for (let rep = 0; rep < settings.repetitions; rep++) {
    const rng = mulberry32(deriveSeed(settings.seed, rep));
    const a = new Float64Array(pairs);
    const b = new Float64Array(pairs);
    for (const g of groups) {
      const sh = shuffle(g.people, rng);
      const h = Math.floor(sh.length / 2);
      sh.forEach((p, idx) => {
        const v = vecs.get(p.pid)!;
        const tgt = idx < h ? a : b;
        for (let t = 0; t < pairs; t++) tgt[t] += v[t];
      });
    }
    const r = pearson(a, b);
    if (!Number.isFinite(r)) {
      undef++;
      raw.push(null);
      sb.push(null);
      sbUndef++;
      continue;
    }
    if (r < 0) negative++;
    raw.push(r);
    if (1 + r === 0) {
      sb.push(null);
      sbUndef++;
    } else sb.push((2 * r) / (1 + r));
  }
  const rs = summarizeValues(raw);
  const ss = summarizeValues(sb);
  return {
    design: scope === "ALL" ? "stratified by country: each half receives 15 KR + 19 JP" : `${scope} random halves`,
    repetitions: settings.repetitions,
    seed: settings.seed,
    halfSizes,
    rawR: rs.dist,
    spearmanBrown: ss.dist,
    rawQuantiles: rs.q,
    spearmanBrownQuantiles: ss.q,
    undefinedCount: undef,
    spearmanBrownUndefinedCount: sbUndef,
    negativeRawCount: negative,
    rawValues: raw,
    spearmanBrownValues: sb,
  };
}
