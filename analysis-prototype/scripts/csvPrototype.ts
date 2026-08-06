/**
 * Pure functions converting a fixture's analysis output into CSV row
 * arrays. No API route exists yet — this only proves the column
 * structures are sound and BOM/precision/no-PII requirements hold. Writes
 * to a scratch temp directory and deletes it at the end of this script.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  filterSessionsForScope,
  buildSimilarityCountMatrix,
  buildSimilarityProportionMatrix,
  buildDissimilarityMatrix,
  buildWeightMatrix,
  runSmacof,
  wardHierarchicalClustering,
  cutTreeToKClusters,
  computeDataHash,
  type AnalysisScope,
} from "../../src/lib/conceptAnalysis";
import { toCsvWithBom } from "../../src/lib/csv";
import { fixtureG_project, fixtureG_sessions } from "../fixtures/fixtures";

function matrixToCsv(header: string, matrix: number[][]): string {
  const rows = [["statement_order", ...matrix.map((_, i) => String(i))]];
  matrix.forEach((row, i) => rows.push([String(i), ...row.map((v) => String(v))]));
  return toCsvWithBom(rows);
}

function buildForScope(scope: AnalysisScope) {
  const filtered = filterSessionsForScope(fixtureG_project, fixtureG_sessions, scope);
  const count = buildSimilarityCountMatrix(fixtureG_project.statementIds, filtered.validSessions);
  const proportion = buildSimilarityProportionMatrix(count, filtered.nTotal);
  const dissimilarity = buildDissimilarityMatrix(proportion);
  const weight = buildWeightMatrix(fixtureG_project.statementIds.length);

  const files: Record<string, string> = {};
  files["similarity_matrix_count.csv"] = matrixToCsv("count", count);
  files["similarity_matrix_proportion.csv"] = matrixToCsv("proportion", proportion);
  files["dissimilarity_matrix.csv"] = matrixToCsv("dissimilarity", dissimilarity);

  if (filtered.nTotal === 0) {
    files["analysis_metadata.csv"] = toCsvWithBom([
      ["scope", "status", "errorCode", "reason"],
      [scope, "SKIPPED", "INSUFFICIENT_DATA", "N=0 for this scope; no analysis performed"],
    ]);
    return files;
  }

  const mdsResult = runSmacof(dissimilarity, weight, {
    algorithm: "SMACOF",
    metric: false,
    dimension: 2,
    normalizedStress: true,
    randomSeed: 123,
    nInit: 6,
    maxIter: 300,
    eps: 1e-9,
    tieHandling: "secondary",
  });

  if (!mdsResult.coordinates) {
    files["mds_diagnostics.csv"] = toCsvWithBom([
      ["dimension", "status", "errorCode"],
      ["2", "FAILED", mdsResult.errorCode ?? "UNKNOWN"],
    ]);
    files["analysis_metadata.csv"] = toCsvWithBom([
      ["scope", "status", "errorCode"],
      [scope, "MDS_FAILED", mdsResult.errorCode ?? "UNKNOWN"],
    ]);
    return files;
  }

  files["mds_diagnostics.csv"] = toCsvWithBom([
    ["dimension", "normalizedStress1", "converged", "bestInit", "bestSeed"],
    ["2", String(mdsResult.normalizedStress1), String(mdsResult.converged), String(mdsResult.bestInitIndex), String(mdsResult.bestSeed)],
  ]);

  files["mds_coordinates_2d.csv"] = toCsvWithBom([
    ["statement_order", "statement_id", "x", "y"],
    ...mdsResult.coordinates.map((p, i) => [String(i), fixtureG_project.statementIds[i], String(p[0]), String(p[1])]),
  ]);

  const ward = wardHierarchicalClustering(mdsResult.coordinates);
  files["hca_linkage.csv"] = toCsvWithBom([
    ["step", "leftNode", "rightNode", "mergeDistance", "mergedItemCount"],
    ...ward.linkage.map((r) => [String(r.step), String(r.leftNode), String(r.rightNode), String(r.mergeDistance), String(r.mergedItemCount)]),
  ]);

  const candidateRows: string[][] = [["k", "statement_order", "clusterLabel"]];
  for (let k = 2; k <= Math.min(6, fixtureG_project.statementIds.length - 1); k++) {
    const labels = cutTreeToKClusters(ward, k);
    labels.forEach((label, i) => candidateRows.push([String(k), String(i), String(label)]));
  }
  files["hca_cluster_candidates.csv"] = toCsvWithBom(candidateRows);

  const dataHash = computeDataHash(fixtureG_project, scope, filtered.validSessions, "prototype-v0.1");
  files["analysis_metadata.csv"] = toCsvWithBom([
    ["scope", "nKr", "nJp", "nTotal", "excludedNullCountry", "excludedIncomplete", "excludedDuplicate", "excludedInvalidStatement", "dataHash"],
    [
      scope,
      String(filtered.nKr),
      String(filtered.nJp),
      String(filtered.nTotal),
      String(filtered.exclusions.excludedNullCountry),
      String(filtered.exclusions.excludedIncomplete),
      String(filtered.exclusions.excludedDuplicate),
      String(filtered.exclusions.excludedInvalidStatement),
      dataHash,
    ],
  ]);

  return files;
}

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "concept-analysis-csv-proto-"));
  console.log("Writing prototype CSVs to:", tmpDir);

  let allOk = true;
  for (const scope of ["KR", "JP", "ALL"] as AnalysisScope[]) {
    const files = buildForScope(scope);
    const scopeDir = path.join(tmpDir, scope);
    fs.mkdirSync(scopeDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(scopeDir, name);
      fs.writeFileSync(filePath, content, "utf-8");
      const buf = fs.readFileSync(filePath);
      const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      const containsPii = /participantName|phoneNumber|adminToken/i.test(content);
      console.log(`  ${scope}/${name}: ${buf.length} bytes, BOM=${hasBom}, containsPiiFieldNames=${containsPii}`);
      if (!hasBom) allOk = false;
      if (containsPii) allOk = false;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\nTemp directory removed:", tmpDir, "exists after cleanup:", fs.existsSync(tmpDir));
  console.log(allOk ? "OK: all CSV prototype files had BOM and no PII field names" : "FAIL: some CSV file failed BOM or PII check");
  if (!allOk) process.exitCode = 1;
}

main();
