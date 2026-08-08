import { fromStoredSeed } from "@/lib/analysis/executionService";
import type { ParametersSnapshot } from "@/lib/analysis/hashes";
import type { InputSnapshot } from "@/lib/analysis/snapshot";
import { cutClusters, computeCentroids, type ClusterAssignment, type ClusterCentroid } from "./clusterCut";
import type { WardResult } from "@/lib/conceptAnalysis";

export type ExportDimensionPayload = {
  dimension: number;
  dimensionStatus: string;
  coordinates: number[][] | null;
  rawStress: number | null;
  commonStressDistance: number | null;
  commonStressQ: number | null;
  converged: boolean | null;
  iterations: number | null;
  bestInitIndex: number | null;
  /** Always the decoded unsigned algorithm value — the raw signed DB column must never reach this payload. */
  bestSeed: number | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
};

export type ExportPayload = {
  meta: {
    projectSlug: string;
    scope: string;
    runId: string;
    startedAt: string;
    finishedAt: string | null;
    includedParticipantCount: number;
    nKr: number;
    nJp: number;
    statementCount: number;
    algorithmVersion: string;
    engineSourceCommitSha: string;
    validationBaselineSha: string;
    parameterHash: string;
    numericDataHash: string;
    statementStructureHash: string;
    statementContentHashKo: string;
    statementContentHashJa: string;
    primaryMapDimension: number;
    wardSourceDimension: number;
    linkageMethod: string;
    executionStatus: string;
    wardStatus: string;
    exportGeneratedAt: string;
    exportLanguage: "ko" | "ja";
    selectedClusterCount: number | null;
    interpretationVersion: number | null;
    interpretationStatus: string | null;
    view3d: { azimuthDeg: number; elevationDeg: number } | null;
  };
  statements: { id: string; order: number; text: string; jaStatus: string | null }[];
  numeric: {
    similarityCountMatrix: number[][];
    similarityProportionMatrix: number[][];
    dissimilarityMatrix: number[][];
  };
  dimensions: ExportDimensionPayload[];
  ward: { linkage: WardResult["linkage"]; originalCount: number } | null;
  clusters: { assignments: ClusterAssignment[]; centroids: ClusterCentroid[] } | null;
  interpretationLabels: { clusterIndex: number; language: string; label: string; memo: string | null }[];
};

export type ExportPayloadInputs = {
  projectSlug: string;
  run: {
    id: string;
    scope: string;
    startedAt: Date;
    finishedAt: Date | null;
    includedParticipantCount: number;
    nKr: number;
    nJp: number;
    statementCount: number;
    algorithmVersion: string;
    engineSourceCommitSha: string;
    parameterHash: string;
    numericDataHash: string;
    statementStructureHash: string;
    statementContentHashKo: string;
    statementContentHashJa: string;
    primaryMapDimension: number;
    wardSourceDimension: number;
    linkageMethod: string;
    executionStatus: string;
    wardStatus: string;
    wardLinkageSnapshot: string | null;
    inputSnapshot: string;
    parametersSnapshot: string;
  };
  dimensions: {
    dimension: number;
    dimensionStatus: string;
    coordinates: string | null;
    rawStress: number | null;
    commonStressDistance: number | null;
    commonStressQ: number | null;
    converged: boolean | null;
    iterations: number | null;
    bestInitIndex: number | null;
    bestSeed: number | null;
    errorCode: string | null;
    errorMessageSafe: string | null;
  }[];
  exportLanguage: "ko" | "ja";
  interpretation: { version: number; status: string; selectedClusterCount: number } | null;
  interpretationLabels: { clusterIndex: number; language: string; label: string; memo: string | null }[];
  view3d?: { azimuthDeg: number; elevationDeg: number };
};

export function buildExportPayload(inputs: ExportPayloadInputs): ExportPayload {
  const { run } = inputs;
  const parametersSnapshot = JSON.parse(run.parametersSnapshot) as ParametersSnapshot;
  const inputSnapshot = JSON.parse(run.inputSnapshot) as InputSnapshot;

  const statements = inputSnapshot.statements.map((s) => ({
    id: s.id,
    order: s.order,
    text: inputs.exportLanguage === "ko" ? s.textKo : (s.textJa ?? ""),
    jaStatus: inputs.exportLanguage === "ja" ? s.jaStatus : null,
  }));

  const dimensions: ExportDimensionPayload[] = inputs.dimensions.map((d) => ({
    dimension: d.dimension,
    dimensionStatus: d.dimensionStatus,
    coordinates: d.coordinates ? (JSON.parse(d.coordinates) as number[][]) : null,
    rawStress: d.rawStress,
    commonStressDistance: d.commonStressDistance,
    commonStressQ: d.commonStressQ,
    converged: d.converged,
    iterations: d.iterations,
    bestInitIndex: d.bestInitIndex,
    bestSeed: fromStoredSeed(d.bestSeed),
    errorCode: d.errorCode,
    errorMessageSafe: d.errorMessageSafe,
  }));

  const ward = run.wardLinkageSnapshot
    ? (JSON.parse(run.wardLinkageSnapshot) as { linkage: WardResult["linkage"]; originalCount: number })
    : null;

  let clusters: ExportPayload["clusters"] = null;
  if (inputs.interpretation && ward) {
    const orderedStatementIds = inputSnapshot.statements.map((s) => s.id);
    const primaryDim = dimensions.find((d) => d.dimension === run.primaryMapDimension);
    const assignments = cutClusters(ward, orderedStatementIds, inputs.interpretation.selectedClusterCount);
    if (primaryDim?.coordinates) {
      const coordMap = new Map<string, [number, number]>(
        orderedStatementIds.map((id, i) => [id, [primaryDim.coordinates![i][0], primaryDim.coordinates![i][1]]])
      );
      const centroids = computeCentroids(assignments, coordMap);
      clusters = { assignments, centroids };
    }
  }

  return {
    meta: {
      projectSlug: inputs.projectSlug,
      scope: run.scope,
      runId: run.id,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      includedParticipantCount: run.includedParticipantCount,
      nKr: run.nKr,
      nJp: run.nJp,
      statementCount: run.statementCount,
      algorithmVersion: run.algorithmVersion,
      engineSourceCommitSha: run.engineSourceCommitSha,
      validationBaselineSha: parametersSnapshot.provenance.validationBaselineSha,
      parameterHash: run.parameterHash,
      numericDataHash: run.numericDataHash,
      statementStructureHash: run.statementStructureHash,
      statementContentHashKo: run.statementContentHashKo,
      statementContentHashJa: run.statementContentHashJa,
      primaryMapDimension: run.primaryMapDimension,
      wardSourceDimension: run.wardSourceDimension,
      linkageMethod: run.linkageMethod,
      executionStatus: run.executionStatus,
      wardStatus: run.wardStatus,
      exportGeneratedAt: new Date().toISOString(),
      exportLanguage: inputs.exportLanguage,
      selectedClusterCount: inputs.interpretation?.selectedClusterCount ?? null,
      interpretationVersion: inputs.interpretation?.version ?? null,
      interpretationStatus: inputs.interpretation?.status ?? null,
      view3d: dimensions.some((d) => d.dimension === 3 && d.dimensionStatus === "COMPLETED")
        ? (inputs.view3d ?? { azimuthDeg: 35, elevationDeg: 20 })
        : null,
    },
    statements,
    numeric: {
      similarityCountMatrix: inputSnapshot.numeric.similarityCountMatrix,
      similarityProportionMatrix: inputSnapshot.numeric.similarityProportionMatrix,
      dissimilarityMatrix: inputSnapshot.numeric.dissimilarityMatrix,
    },
    dimensions,
    ward,
    clusters,
    interpretationLabels: inputs.interpretationLabels,
  };
}
