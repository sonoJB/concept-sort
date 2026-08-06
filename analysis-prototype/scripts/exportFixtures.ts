/**
 * Exports fixed (non-random) fixtures — dissimilarity/weight matrices AND
 * explicit initial coordinates — to a JSON file that TypeScript, Python,
 * and R reference runners all read from. Using the SAME hand-specified
 * initial coordinates in every language is the point: matching PRNG seeds
 * across three different languages would not produce the same starting
 * configuration, so a shared explicit start is used instead (per the
 * cross-validation design).
 *
 * Usage: npx tsx analysis-prototype/scripts/exportFixtures.ts <output-path>
 */
import fs from "node:fs";
import path from "node:path";
import {
  fixtureB_square_dissimilarity,
  fixtureD_ties_dissimilarity,
  fixtureE_offDiagonalZero_dissimilarity,
} from "../fixtures/fixtures";

const ALGORITHM_VERSION = "concept-analysis-prototype-v0.1";

// Fixed (hand-specified, not PRNG-derived) initial configurations so every
// language starts from bit-identical coordinates.
const initial4 = [
  [0.5, -0.3],
  [-0.4, 0.6],
  [0.9, 0.9],
  [-0.6, -0.5],
];
const initial5 = [
  [0.4, -0.5],
  [-0.6, 0.3],
  [0.8, 0.2],
  [-0.3, -0.7],
  [0.1, 0.6],
];

// Ward-only fixture: fixed point coordinates with NO exactly-equal pairwise
// distances (tie-free), so merge order is unambiguous across implementations.
const wardTieFreePoints = [
  [0, 0],
  [10, 0],
  [10.5, 0.2],
  [20, 20],
  [20.3, 20.4],
];

const payload = {
  meta: {
    algorithmVersion: ALGORITHM_VERSION,
    exportedFrom: "analysis-prototype/fixtures/fixtures.ts",
    note: "Synthetic, neutral fixtures only — no production/rrrvvnux content, no participant PII.",
  },
  mds: {
    zeroFree: {
      description: "4-point square, no off-diagonal zeros — safe for sklearn nonmetric MDS comparison.",
      statementOrder: [0, 1, 2, 3],
      dissimilarity: fixtureB_square_dissimilarity,
      weight: squareWeight(4),
      initialCoordinates: initial4,
      dimension: 2,
      maxIter: 300,
      eps: 1e-9,
      tieMethod: "secondary",
    },
    ties: {
      description: "5-point, ties-heavy dissimilarity matrix — for tie-handling comparison (R only; sklearn tie method not independently confirmed).",
      statementOrder: [0, 1, 2, 3, 4],
      dissimilarity: fixtureD_ties_dissimilarity,
      weight: squareWeight(5),
      initialCoordinates: initial5,
      dimension: 2,
      maxIter: 300,
      eps: 1e-9,
      tieMethod: "secondary",
    },
    offDiagonalZero: {
      description: "4-point, contains genuine off-diagonal dissimilarity=0 (perfect similarity) — MUST be excluded from sklearn comparison per its 0=missing ambiguity; used for R comparison only.",
      statementOrder: [0, 1, 2, 3],
      dissimilarity: fixtureE_offDiagonalZero_dissimilarity,
      weight: squareWeight(4),
      initialCoordinates: initial4,
      dimension: 2,
      maxIter: 300,
      eps: 1e-9,
      tieMethod: "secondary",
    },
  },
  ward: {
    tieFree: {
      description: "5-point coordinates, no exactly-equal pairwise distances — Ward merge order is unambiguous.",
      points: wardTieFreePoints,
    },
  },
};

function squareWeight(n: number): number[][] {
  const w = Array.from({ length: n }, () => new Array(n).fill(1));
  for (let i = 0; i < n; i++) w[i][i] = 0;
  return w;
}

const outputPath = process.argv[2];
if (!outputPath) {
  console.error("Usage: exportFixtures.ts <output-path>");
  process.exit(1);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");
console.log("Fixtures exported to:", outputPath);
