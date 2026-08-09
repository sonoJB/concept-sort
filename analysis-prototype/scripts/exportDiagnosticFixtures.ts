/**
 * Exports a SEPARATE, diagnostic-only fixtures file (does not touch or
 * replace exportFixtures.ts / fixtures.json) containing strictNoTies — a
 * fixture specifically designed to isolate tie-handling from
 * disparity-normalization and Guttman-update questions raised by the
 * attempt-4 SMACOF divergence report (see fixtures.ts fixture G for the
 * rationale). Same shared-init design as the main fixtures: one fixed
 * initial configuration, used identically by TS/Python/R.
 *
 * Usage: npx tsx analysis-prototype/scripts/exportDiagnosticFixtures.ts <output-path>
 */
import fs from "node:fs";
import path from "node:path";
import { fixtureG_strictNoTies_dissimilarity } from "../fixtures/fixtures";

const ALGORITHM_VERSION = "concept-analysis-prototype-v0.1";

const initial5 = [
  [0.4, -0.5],
  [-0.6, 0.3],
  [0.8, 0.2],
  [-0.3, -0.7],
  [0.1, 0.6],
];

function squareWeight(n: number): number[][] {
  const w = Array.from({ length: n }, () => new Array(n).fill(1));
  for (let i = 0; i < n; i++) w[i][i] = 0;
  return w;
}

const payload = {
  meta: {
    algorithmVersion: ALGORITHM_VERSION,
    exportedFrom: "analysis-prototype/fixtures/fixtures.ts (fixtureG_strictNoTies_dissimilarity)",
    note: "Diagnostic-only fixture set, additive to the main fixtures.json — synthetic, neutral values, no production/rrrvvnux content, no participant PII.",
  },
  mds: {
    strictNoTies: {
      description: "5-point, all 10 pairwise dissimilarities distinct (no ties, no off-diagonal zeros) — isolates tie-handling from other SMACOF divergence causes.",
      statementOrder: [0, 1, 2, 3, 4],
      dissimilarity: fixtureG_strictNoTies_dissimilarity,
      weight: squareWeight(5),
      initialCoordinates: initial5,
      dimension: 2,
      maxIter: 300,
      eps: 1e-9,
      tieMethod: "secondary",
    },
  },
};

const outputPath = process.argv[2];
if (!outputPath) {
  console.error("Usage: exportDiagnosticFixtures.ts <output-path>");
  process.exit(1);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");
console.log("Diagnostic fixtures exported to:", outputPath);
