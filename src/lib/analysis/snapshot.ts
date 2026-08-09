import type { AnalysisScope, ExclusionSummary } from "@/lib/conceptAnalysis";
import type { NumericAggregate } from "./aggregates";
import type { RawStatementRow } from "./dbAdapter";
import type { AnalysisParameters, Provenance } from "./hashes";
import { canonicalize } from "./canonicalJson";

export const INPUT_SNAPSHOT_VERSION = 1;

export type InputSnapshotSummary = {
  statementCount: number;
  nKr: number;
  nJp: number;
  nTotal: number;
  includedParticipantCount: number;
  excludedNullCountry: number;
  /** engine's excludedDuplicate + excludedInvalidStatement combined (see Gate 3 audit note in dbAdapter usage). */
  excludedInvalid: number;
  excludedIncomplete: number;
};

export type InputSnapshot = {
  snapshotVersion: number;
  scope: AnalysisScope;
  summary: InputSnapshotSummary;
  statements: { id: string; order: number; textKo: string; textJa: string | null; jaStatus: string }[];
  numeric: {
    similarityCountMatrix: number[][];
    similarityProportionMatrix: number[][];
    dissimilarityMatrix: number[][];
    weightMatrix: number[][];
  };
};

/**
 * Builds the PII-free canonical inputSnapshot. No SortSession IDs, no raw
 * per-participant grouping list, no participantName/phoneNumber anywhere in
 * this structure or its inputs (see dbAdapter.ts / aggregates.ts, which
 * already strip those before this function ever sees the data).
 */
export function buildInputSnapshot(
  scope: AnalysisScope,
  statements: RawStatementRow[],
  aggregate: NumericAggregate,
  exclusions: ExclusionSummary,
  nKr: number,
  nJp: number
): InputSnapshot {
  const ordered = [...statements].sort((a, b) => a.order - b.order);
  return {
    snapshotVersion: INPUT_SNAPSHOT_VERSION,
    scope,
    summary: {
      statementCount: statements.length,
      nKr,
      nJp,
      nTotal: nKr + nJp,
      includedParticipantCount: aggregate.includedParticipantCount,
      excludedNullCountry: exclusions.excludedNullCountry,
      excludedInvalid: exclusions.excludedDuplicate + exclusions.excludedInvalidStatement,
      excludedIncomplete: exclusions.excludedIncomplete,
    },
    statements: ordered.map((s) => ({ id: s.id, order: s.order, textKo: s.text, textJa: s.textJa, jaStatus: s.jaStatus })),
    numeric: {
      similarityCountMatrix: aggregate.similarityCountMatrix,
      similarityProportionMatrix: aggregate.similarityProportionMatrix,
      dissimilarityMatrix: aggregate.dissimilarityMatrix,
      weightMatrix: aggregate.weightMatrix,
    },
  };
}

export function buildParametersSnapshot(analysisParameters: AnalysisParameters, provenance: Provenance) {
  return { analysisParameters, provenance };
}

/** Storage form: same canonical ordering as hashing, stored as plain JSON text (String column). */
export function serializeSnapshot(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
