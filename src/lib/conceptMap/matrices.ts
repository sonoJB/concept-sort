/**
 * Group similarity / dissimilarity matrices from participant-level sorting data (Trochim, 1989).
 *
 *   individual binary similarity  b_ij = 1 if statements i and j are in the same pile, else 0 (diagonal 1)
 *   S  = sum over participants of b        (diagonal = N)              "more similar = larger"
 *   P  = S / N                             (diagonal = 1)
 *   D  = N - S                             (diagonal = 0)              "more different = larger"
 *   δ  = 1 - S / N  = D / N                (diagonal = 0)              <- the MDS input
 *
 * These formulas assume every analysed participant placed every statement exactly once; `buildCountMatrix`
 * refuses incomplete input instead of imputing zeros or changing the denominator.
 */

export type Participant = {
  /** pseudonymous research id, never a session id */
  pid: string;
  country: "KR" | "JP";
  /** pile index per statement, in analysis order (0-based, contiguous) */
  assignment: number[];
};

export type Matrix = number[][];

export class IncompleteSortingError extends Error {
  constructor(pid: string, detail: string) {
    super(`participant ${pid}: ${detail}`);
    this.name = "IncompleteSortingError";
  }
}

export function pileCount(a: number[]): number {
  return new Set(a).size;
}

export function pileSizes(a: number[]): number[] {
  const m = new Map<number, number>();
  for (const g of a) m.set(g, (m.get(g) ?? 0) + 1);
  return [...m.values()].sort((x, y) => y - x);
}

/** S with diagonal N. Throws on any incomplete / invalid participant. */
export function buildCountMatrix(participants: Participant[], statementCount: number): Matrix {
  const n = statementCount;
  const S: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const p of participants) {
    if (p.assignment.length !== n) throw new IncompleteSortingError(p.pid, `has ${p.assignment.length} placements, expected ${n}`);
    for (const g of p.assignment) if (!Number.isInteger(g) || g < 0) throw new IncompleteSortingError(p.pid, "invalid pile index");
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (p.assignment[i] === p.assignment[j]) S[i][j] += 1;
  }
  return S;
}

export type DerivedMatrices = { N: number; S: Matrix; P: Matrix; D: Matrix; delta: Matrix };

export function deriveMatrices(S: Matrix, N: number): DerivedMatrices {
  const n = S.length;
  const P: Matrix = [];
  const D: Matrix = [];
  const delta: Matrix = [];
  for (let i = 0; i < n; i++) {
    P.push([]);
    D.push([]);
    delta.push([]);
    for (let j = 0; j < n; j++) {
      P[i].push(S[i][j] / N);
      D[i].push(N - S[i][j]);
      delta[i].push(i === j ? 0 : 1 - S[i][j] / N);
    }
  }
  return { N, S, P, D, delta };
}

export type MatrixChecks = {
  size: number;
  symmetric: boolean;
  diagonalEqualsN: boolean;
  offDiagonalInRange: boolean;
  minOffDiagonal: number;
  maxOffDiagonal: number;
  pairs: number;
  neverTogether: number;
  alwaysTogether: number;
  distinctLevels: number;
};

export function checkMatrices(m: DerivedMatrices): MatrixChecks {
  const n = m.S.length;
  let symmetric = true;
  let diag = true;
  let inRange = true;
  let min = Infinity;
  let max = -Infinity;
  let never = 0;
  let always = 0;
  const levels = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (m.S[i][i] !== m.N) diag = false;
    for (let j = 0; j < n; j++) {
      if (m.S[i][j] !== m.S[j][i]) symmetric = false;
      if (i < j) {
        const v = m.S[i][j];
        if (v < 0 || v > m.N) inRange = false;
        min = Math.min(min, v);
        max = Math.max(max, v);
        if (v === 0) never++;
        if (v === m.N) always++;
        levels.add(v);
      }
    }
  }
  return { size: n, symmetric, diagonalEqualsN: diag, offDiagonalInRange: inRange, minOffDiagonal: min, maxOffDiagonal: max, pairs: (n * (n - 1)) / 2, neverTogether: never, alwaysTogether: always, distinctLevels: levels.size };
}

/** Sum of two count matrices (used to prove ALL = KR + JP). */
export function addMatrices(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((v, j) => v + b[i][j]));
}

export function matricesEqual(a: Matrix, b: Matrix, tol = 0): boolean {
  return a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((v, j) => Math.abs(v - b[i][j]) <= tol));
}

export type ParticipantSummaryRow = { pid: string; country: string; piles: number; sizes: number[]; maxPile: number; minPile: number };

export function summarizeParticipants(ps: Participant[]): ParticipantSummaryRow[] {
  return ps.map((p) => {
    const sizes = pileSizes(p.assignment);
    return { pid: p.pid, country: p.country, piles: sizes.length, sizes, maxPile: sizes[0], minPile: sizes[sizes.length - 1] };
  });
}

export type Distribution = { n: number; min: number; q1: number; median: number; q3: number; max: number; mean: number; sd: number };

export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

export function describe(values: number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
  return { n, min: s[0], q1: quantile(s, 0.25), median: quantile(s, 0.5), q3: quantile(s, 0.75), max: s[n - 1], mean, sd };
}

/** Upper-triangle (i<j) off-diagonal values in row-major order — the 1,081 item-pair vector for 47 statements. */
export function upperTriangle(m: Matrix): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) out.push(m[i][j]);
  return out;
}
