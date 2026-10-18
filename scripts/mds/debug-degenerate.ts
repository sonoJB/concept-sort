import { runSmacofV2 } from "../../src/lib/conceptAnalysis/smacofV2";
import { loadScopeInputs } from "./inputs";
const inp = loadScopeInputs(process.argv[2], "JP");
const r = runSmacofV2(inp.dissimilarity, inp.weight, { dimension: 2, nInit: 64, maxIter: 10000, eps: 1e-9, strictEps: 1e-12, strictMaxIter: 20000, randomSeed: 42, tieHandling: "secondary" });
console.log(r.starts.filter((s) => s.reason !== "CONVERGED"));
// identical-profile statements?
const n = inp.dissimilarity.length; const seen = new Map<string, number[]>();
for (let a = 0; a < n; a++) { const key = inp.dissimilarity[a].filter((_, k) => k !== a).join(","); }
let dup = 0; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (inp.dissimilarity[a][b] === 1) dup++;
console.log("pairs never co-sorted (delta=1):", dup);
