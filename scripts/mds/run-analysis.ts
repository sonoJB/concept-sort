import { writeFileSync } from "node:fs";
import { analyzeScope } from "../../src/lib/conceptMap/analyze";
import { loadParticipants } from "./participants";
const [db, outDir] = process.argv.slice(2);
const raw = loadParticipants(db);
console.log("participants", raw.participants.length, "statements", raw.statements.length);
for (const scope of ["KR", "JP", "ALL"] as const) {
  const t0 = Date.now();
  const a = analyzeScope(scope, raw.participants, raw.statements.length);
  console.log(scope, "N", a.N, "ms", Date.now() - t0, "S1", a.primary.stress1, "conv", a.primary.numericallyConverged, a.primary.selected?.main.reason, a.primary.selected?.strict.reason, "dims", a.dimensions.map((d) => `${d.dimension}D:${d.stress1?.toFixed(4)}${d.numericallyConverged ? "" : "!"}`).join(" "));
  console.log("  split-half r mean/median", a.splitHalf.rawR?.mean, a.splitHalf.rawR?.median, "SB", a.splitHalf.spearmanBrown?.mean, "undef", a.splitHalf.undefinedCount);
  console.log("  k: ", a.solutions.map((s) => `${s.k}:sil=${s.silhouetteMap.mean.toFixed(3)} min=${s.minSize}`).join(" | "));
  writeFileSync(`${outDir}/analysis_${scope}.json`, JSON.stringify(a));
}
