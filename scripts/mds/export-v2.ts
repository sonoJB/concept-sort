import { writeFileSync } from "node:fs";
import { runSmacofV2, randomStart } from "../../src/lib/conceptAnalysis/smacofV2";
import { loadScopeInputs } from "./inputs";
const [db, outDir] = process.argv.slice(2);
for (const scope of ["KR", "JP", "ALL"] as const) {
  const inp = loadScopeInputs(db, scope);
  const r = runSmacofV2(inp.dissimilarity, inp.weight, { dimension: 2, nInit: 64, maxIter: 10000, eps: 1e-9, strictEps: 1e-12, strictMaxIter: 20000, randomSeed: 42, tieHandling: "secondary" });
  const n = inp.dissimilarity.length;
  const startOf = (seed: number) => Array.from(randomStart(n, 2, seed));
  writeFileSync(`${outDir}/ts_v2_${scope}.json`, JSON.stringify({
    scope, n: inp.n, coordinates: r.coordinates, evaluation: r.evaluation, selected: r.selected, starts: r.starts,
    selectedStart: startOf(r.selected!.seed), someStarts: r.starts.slice(0, 5).map((s) => ({ seed: s.seed, start: startOf(s.seed), rawStress: s.rawStress, iterations: s.iterations })),
    trace: r.trace, dissimilarity: inp.dissimilarity,
  }));
}
