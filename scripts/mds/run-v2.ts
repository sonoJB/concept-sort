import { runSmacofV2, evaluateConfiguration } from "../../src/lib/conceptAnalysis/smacofV2";
import { loadScopeInputs } from "./inputs";
const db = process.argv[2];
const nInit = Number(process.argv[3] ?? 64);
const maxIter = Number(process.argv[4] ?? 10000);
for (const scope of ["KR", "JP", "ALL"] as const) {
  const inp = loadScopeInputs(db, scope);
  const t0 = Date.now();
  const r = runSmacofV2(inp.dissimilarity, inp.weight, { dimension: 2, nInit, maxIter, eps: 1e-9, strictEps: 1e-12, strictMaxIter: 20000, randomSeed: 42, tieHandling: "secondary" });
  const tally: Record<string, number> = {};
  for (const s of r.starts) tally[s.reason] = (tally[s.reason] ?? 0) + 1;
  const ev = r.coordinates ? evaluateConfiguration(r.coordinates, inp.dissimilarity, inp.weight) : null;
  console.log(scope, { N: inp.n, ms: Date.now() - t0, tally, status: r.selectionStatus, selected: r.selected, spread: r.rawStressSpreadAmongConverged, ev });
}
