import type { AnalysisScope } from "@/lib/conceptAnalysis";
import { canonicalHash } from "./canonicalJson";
import type { NumericAggregate } from "./aggregates";
import type { RawStatementRow } from "./dbAdapter";

/**
 * numericDataHash depends ONLY on scope, statement order/identity, N, and
 * the similarity COUNT matrix — never on session IDs, group-membership
 * detail beyond what's folded into the count matrix, or participant data.
 * Two different sets of participants that happen to produce the same count
 * matrix and the same N necessarily get the same hash — that's intended,
 * not a collision to guard against (see Gate 3 spec §8).
 */
export function computeNumericDataHash(scope: AnalysisScope, aggregate: NumericAggregate): string {
  return canonicalHash({
    scope,
    orderedStatementIds: aggregate.statementIds,
    includedParticipantCount: aggregate.includedParticipantCount,
    similarityCountMatrix: aggregate.similarityCountMatrix,
  });
}

export function computeStatementStructureHash(statements: RawStatementRow[]): string {
  const ordered = [...statements].sort((a, b) => a.order - b.order);
  return canonicalHash(ordered.map((s) => ({ id: s.id, order: s.order })));
}

export function computeStatementContentHashKo(statements: RawStatementRow[]): string {
  const ordered = [...statements].sort((a, b) => a.order - b.order);
  return canonicalHash(ordered.map((s) => ({ id: s.id, order: s.order, text: s.text })));
}

/**
 * Always non-null (matches AnalysisRun.statementContentHashJa's NOT NULL
 * column) — textJa is genuinely `null` when untranslated, distinct from an
 * empty string, and canonicalize() never coerces null to a sentinel string.
 */
export function computeStatementContentHashJa(statements: RawStatementRow[]): string {
  const ordered = [...statements].sort((a, b) => a.order - b.order);
  return canonicalHash(
    ordered.map((s) => ({ id: s.id, order: s.order, textJa: s.textJa, jaStatus: s.jaStatus }))
  );
}

/**
 * The set of numeric-result-affecting engine parameters. parameterHash is
 * computed ONLY from this object — never from provenance fields
 * (engineSourceCommitSha, validationBaselineSha) — so an app rebuild with no
 * parameter change never marks a past run's parameters as superseded, and a
 * genuine parameter change always does (see Gate 3 spec §4).
 */
export type AnalysisParameters = {
  algorithmVersion: string;
  dimensionsEvaluated: number[];
  primaryMapDimension: number;
  nInit: number;
  maxIter: number;
  eps: number;
  tieHandling: "secondary";
  metric: false;
  normalizedStress: true;
  disparityNormalizationConvention: string;
  normalizationTargetConvention: string;
  randomSeed: number;
  wardSourceDimension: number;
  linkageMethod: "ward";
  stressDefinition: string;
};

export type Provenance = {
  validationBaselineSha: string;
};

export type ParametersSnapshot = {
  analysisParameters: AnalysisParameters;
  provenance: Provenance;
};

export function computeParameterHash(snapshot: ParametersSnapshot): string {
  return canonicalHash(snapshot.analysisParameters);
}
