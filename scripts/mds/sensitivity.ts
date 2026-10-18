import { runSmacofV2 } from "../../src/lib/conceptAnalysis/smacofV2";
import { loadScopeInputs } from "./inputs";
const db = process.argv[2]; const nInit = Number(process.argv[3] ?? 1000);
const out: Record<string, unknown> = { description: "multi-start sensitivity: same method, more reproducible starts (seed 42); official analysis uses 64", nInit };
for (const scope of ["KR", "JP", "ALL"] as const) {
  const inp = loadScopeInputs(db, scope);
  const mk = (seed: number, n: number) => runSmacofV2(inp.dissimilarity, inp.weight, { dimension: 2, nInit: n, maxIter: 10000, eps: 1e-9, strictEps: 1e-12, strictMaxIter: 20000, randomSeed: seed, tieHandling: "secondary" });
  const r = mk(42, nInit);
  const conv = r.starts.filter((s) => s.reason === "CONVERGED").map((s) => s.rawStress).sort((a, b) => a - b);
  const best = conv[0];
  const base = mk(42, 64);
  out[scope] = { nInit, converged: conv.length, best: r.evaluation!.rawStress, official64Best: base.evaluation!.rawStress, rawDiff: r.evaluation!.rawStress - base.evaluation!.rawStress, startsWithin1e6OfBest: conv.filter((x) => x <= best * (1 + 1e-6)).length, distinctLocalMinimaApprox: new Set(conv.map((x) => x.toPrecision(6))).size, lowestFive: conv.slice(0, 5) };
}
console.log(JSON.stringify(out, null, 1));
