import { toCsvWithBom } from "@/lib/csv";
import type { ExportPayload } from "./exportPayload";

export type CsvFile = { filename: string; content: string };

function matrixRows(matrix: number[][], header: string): string[][] {
  const labels = matrix.map((_, i) => String(i + 1));
  const headerRow = [header, ...labels];
  const body = matrix.map((row, i) => [labels[i], ...row.map((v) => String(v))]);
  return [headerRow, ...body];
}

/** Builds every export CSV file for the given payload — no data invented beyond what's already in the payload. */
export function buildCsvFiles(payload: ExportPayload): CsvFile[] {
  const files: CsvFile[] = [];
  const m = payload.meta;

  files.push({
    filename: "01_run_metadata.csv",
    content: toCsvWithBom([
      ["key", "value"],
      ["project_slug", m.projectSlug],
      ["scope", m.scope],
      ["run_id", m.runId],
      ["started_at", m.startedAt],
      ["finished_at", m.finishedAt ?? ""],
      ["included_n", String(m.includedParticipantCount)],
      ["n_kr", String(m.nKr)],
      ["n_jp", String(m.nJp)],
      ["statement_count", String(m.statementCount)],
      ["algorithm_version", m.algorithmVersion],
      ["engine_source_commit_sha", m.engineSourceCommitSha],
      ["validation_baseline_sha", m.validationBaselineSha],
      ["parameter_hash", m.parameterHash],
      ["numeric_data_hash", m.numericDataHash],
      ["statement_structure_hash", m.statementStructureHash],
      ["statement_content_hash_ko", m.statementContentHashKo],
      ["statement_content_hash_ja", m.statementContentHashJa],
      ["primary_map_dimension", String(m.primaryMapDimension)],
      ["ward_source_dimension", String(m.wardSourceDimension)],
      ["linkage_method", m.linkageMethod],
      ["execution_status", m.executionStatus],
      ["ward_status", m.wardStatus],
      ["selected_k", m.selectedClusterCount !== null ? String(m.selectedClusterCount) : ""],
      ["interpretation_version", m.interpretationVersion !== null ? String(m.interpretationVersion) : ""],
      ["interpretation_status", m.interpretationStatus ?? ""],
      ["export_language", m.exportLanguage],
      ["export_generated_at", m.exportGeneratedAt],
    ]),
  });

  files.push({
    filename: "02_statements.csv",
    content: toCsvWithBom([
      ["id", "order", "text", ...(m.exportLanguage === "ja" ? ["ja_status"] : [])],
      ...payload.statements.map((s) => [
        s.id,
        String(s.order + 1),
        s.text,
        ...(m.exportLanguage === "ja" ? [s.jaStatus ?? ""] : []),
      ]),
    ]),
  });

  files.push({ filename: "03_similarity_count.csv", content: toCsvWithBom(matrixRows(payload.numeric.similarityCountMatrix, "no.")) });
  files.push({ filename: "04_similarity_proportion.csv", content: toCsvWithBom(matrixRows(payload.numeric.similarityProportionMatrix, "no.")) });
  files.push({ filename: "05_dissimilarity.csv", content: toCsvWithBom(matrixRows(payload.numeric.dissimilarityMatrix, "no.")) });

  files.push({
    filename: "06_mds_diagnostics.csv",
    content: toCsvWithBom([
      ["dimension", "dimension_status", "raw_stress", "common_stress_distance", "common_stress_q", "converged", "iterations", "best_init_index", "best_seed", "error_code"],
      ...payload.dimensions.map((d) => [
        String(d.dimension),
        d.dimensionStatus,
        d.rawStress !== null ? String(d.rawStress) : "",
        d.commonStressDistance !== null ? String(d.commonStressDistance) : "",
        d.commonStressQ !== null ? String(d.commonStressQ) : "",
        d.converged !== null ? String(d.converged) : "",
        d.iterations !== null ? String(d.iterations) : "",
        d.bestInitIndex !== null ? String(d.bestInitIndex) : "",
        d.bestSeed !== null ? String(d.bestSeed) : "",
        d.errorCode ?? "",
      ]),
    ]),
  });

  const primary2d = payload.dimensions.find((d) => d.dimension === 2 && d.coordinates);
  if (primary2d?.coordinates) {
    files.push({
      filename: "07_mds_coordinates_2d.csv",
      content: toCsvWithBom([
        ["statement_id", "order", "x", "y"],
        ...payload.statements.map((s, i) => [s.id, String(s.order + 1), String(primary2d.coordinates![i][0]), String(primary2d.coordinates![i][1])]),
      ]),
    });
  }

  if (payload.ward) {
    files.push({
      filename: "08_ward_linkage.csv",
      content: toCsvWithBom([
        ["step", "left_node", "right_node", "merge_distance", "merged_item_count"],
        ...payload.ward.linkage.map((r) => [String(r.step), String(r.leftNode), String(r.rightNode), String(r.mergeDistance), String(r.mergedItemCount)]),
      ]),
    });
  }

  if (payload.clusters) {
    const k = payload.clusters.centroids.length;
    const kLabel = String(k).padStart(2, "0");
    files.push({
      filename: `09_cluster_assignments_k${kLabel}.csv`,
      content: toCsvWithBom([
        ["statement_id", "order", "cluster_index"],
        ...payload.statements.map((s) => {
          const a = payload.clusters!.assignments.find((x) => x.statementId === s.id);
          return [s.id, String(s.order + 1), a ? String(a.clusterIndex) : ""];
        }),
      ]),
    });
    files.push({
      filename: `10_cluster_centroids_k${kLabel}.csv`,
      content: toCsvWithBom([
        ["cluster_index", "centroid_x", "centroid_y", "member_count"],
        ...payload.clusters.centroids.map((c) => [String(c.clusterIndex), String(c.x), String(c.y), String(c.memberCount)]),
      ]),
    });
  }

  if (payload.interpretationLabels.length > 0) {
    files.push({
      filename: "11_interpretation_labels.csv",
      content: toCsvWithBom([
        ["cluster_index", "language", "label", "memo"],
        ...payload.interpretationLabels.map((l) => [String(l.clusterIndex), l.language, l.label, l.memo ?? ""]),
      ]),
    });
  }

  const dim3d = payload.dimensions.find((d) => d.dimension === 3 && d.coordinates);
  if (dim3d?.coordinates) {
    files.push({
      filename: "12_mds_coordinates_3d.csv",
      content: toCsvWithBom([
        ["statement_id", "order", "x", "y", "z"],
        ...payload.statements.map((s, i) => [
          s.id,
          String(s.order + 1),
          String(dim3d.coordinates![i][0]),
          String(dim3d.coordinates![i][1]),
          String(dim3d.coordinates![i][2]),
        ]),
      ]),
    });
  }

  return files;
}
