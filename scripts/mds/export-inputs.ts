/** Dumps the application's own analysis inputs (count + dissimilarity) per scope so an independent implementation can compare. */
import { writeFileSync } from "node:fs";
import { loadScopeInputs } from "./inputs";
const [db, outDir] = process.argv.slice(2);
for (const scope of ["KR", "JP", "ALL"] as const) {
  const i = loadScopeInputs(db, scope);
  writeFileSync(`${outDir}/app_inputs_${scope}.json`, JSON.stringify({ n: i.n, statementCount: i.statementCount, statementIds: i.statementIds, count: i.count, dissimilarity: i.dissimilarity, weightAllOne: i.weight.every((r, a) => r.every((v, b) => v === (a === b ? 0 : 1))) }));
}
