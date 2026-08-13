import { toCsvWithBom } from "@/lib/csv";
import type { ExportPayload } from "./exportPayload";
import { buildDimensionDiagnosticsView } from "./dimensionDiagnosticsView";
import { cutClusters } from "./clusterCut";

/** Practical illustrative candidate range for the cluster-candidates exports — mirrors the AnalysisPanel UI's comparison table. Never claims this is the app's full supported range (2..N). */
const CSV_CANDIDATE_K_RANGE = [2, 3, 4, 5, 6, 7, 8, 9, 10];

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
      ["dataset", m.dataset],
      ["pilot_count", String(m.pilotCount)],
      ["main_count", String(m.mainCount)],
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
      ["interpretation_axis_labels", m.axisLabels ?? ""],
      ["interpretation_quadrant_labels", m.quadrantLabels ?? ""],
      ["interpretation_notes", m.notes ?? ""],
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

  const diagnosticsView = buildDimensionDiagnosticsView(payload.dimensions);
  const diagnosticsByDim = new Map(diagnosticsView.map((d) => [d.dimension, d]));
  files.push({
    filename: "06_mds_diagnostics.csv",
    content: toCsvWithBom([
      [
        "dimension",
        "dimension_status",
        "raw_stress",
        "common_stress_distance",
        "common_stress_q",
        "r_squared",
        "delta_r_squared",
        "rsq",
        "converged",
        "convergence_reason",
        "iterations",
        "best_init_index",
        "best_seed",
        "error_code",
      ],
      ...payload.dimensions.map((d) => {
        const diag = diagnosticsByDim.get(d.dimension);
        return [
          String(d.dimension),
          d.dimensionStatus,
          d.rawStress !== null ? String(d.rawStress) : "",
          d.commonStressDistance !== null ? String(d.commonStressDistance) : "",
          d.commonStressQ !== null ? String(d.commonStressQ) : "",
          d.rSquared !== null ? String(d.rSquared) : "",
          diag?.deltaRSquared !== null && diag?.deltaRSquared !== undefined ? String(diag.deltaRSquared) : "",
          d.rsq !== null ? String(d.rsq) : "",
          d.converged !== null ? String(d.converged) : "",
          d.convergenceReason ?? "",
          d.iterations !== null ? String(d.iterations) : "",
          d.bestInitIndex !== null ? String(d.bestInitIndex) : "",
          d.bestSeed !== null ? String(d.bestSeed) : "",
          d.errorCode ?? "",
        ];
      }),
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

  // Ward candidate exports: computed directly from payload.ward.linkage
  // (cutClusters, unmodified) for a practical illustrative k range — never
  // require an AnalysisInterpretation to exist. Distinct from
  // 09_cluster_assignments_k{k}.csv, which is the officially SELECTED
  // interpretation's single k (only present once one exists).
  if (payload.ward) {
    const orderedIds = payload.statements.map((s) => s.id);
    const candidateRows: {
      k: number;
      clusterCount: number;
      minClusterSize: number;
      maxClusterSize: number;
      sizeDistribution: number[];
      assignments: { statementId: string; order: number; clusterIndex: number }[];
    }[] = [];

    for (const k of CSV_CANDIDATE_K_RANGE) {
      if (k > payload.statements.length) continue;
      const assignments = cutClusters(payload.ward, orderedIds, k);
      const sizes = new Map<number, number>();
      assignments.forEach((a) => sizes.set(a.clusterIndex, (sizes.get(a.clusterIndex) ?? 0) + 1));
      const sizeDistribution = [...sizes.values()].sort((a, b) => a - b);
      candidateRows.push({
        k,
        clusterCount: sizes.size,
        minClusterSize: Math.min(...sizeDistribution),
        maxClusterSize: Math.max(...sizeDistribution),
        sizeDistribution,
        assignments: assignments.map((a) => {
          const s = payload.statements.find((st) => st.id === a.statementId)!;
          return { statementId: a.statementId, order: s.order, clusterIndex: a.clusterIndex };
        }),
      });
    }

    if (candidateRows.length > 0) {
      files.push({
        filename: "13_cluster_candidates_summary.csv",
        content: toCsvWithBom([
          ["k", "cluster_count", "min_cluster_size", "max_cluster_size", "size_distribution"],
          ...candidateRows.map((r) => [
            String(r.k),
            String(r.clusterCount),
            String(r.minClusterSize),
            String(r.maxClusterSize),
            r.sizeDistribution.join(";"),
          ]),
        ]),
      });

      files.push({
        filename: "14_cluster_candidates_membership.csv",
        content: toCsvWithBom([
          ["k", "cluster_index", "statement_number", "statement_id"],
          ...candidateRows.flatMap((r) =>
            [...r.assignments]
              .sort((a, b) => a.clusterIndex - b.clusterIndex || a.order - b.order)
              .map((a) => [String(r.k), String(a.clusterIndex), String(a.order + 1), a.statementId])
          ),
        ]),
      });
    }
  }

  return files;
}
