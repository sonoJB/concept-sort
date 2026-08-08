import {
  buildSimilarityCountMatrix,
  buildSimilarityProportionMatrix,
  buildDissimilarityMatrix,
  buildWeightMatrix,
  assertSquareSymmetric,
  type FixtureProject,
  type FixtureSession,
  type Matrix,
  type WeightMatrix,
} from "@/lib/conceptAnalysis";

export type NumericAggregate = {
  statementIds: string[];
  includedParticipantCount: number;
  similarityCountMatrix: Matrix;
  similarityProportionMatrix: Matrix;
  dissimilarityMatrix: Matrix;
  weightMatrix: WeightMatrix;
};

/**
 * Builds the canonical numeric aggregate from a project's statement order
 * and the sessions already filtered to one scope (see
 * conceptAnalysis/scope.ts). This is the ONLY input the statistics engine
 * and the numericDataHash are computed from — no session IDs, no
 * participant PII, no group-membership detail beyond what's folded into
 * these matrices.
 */
export function buildNumericAggregate(
  project: FixtureProject,
  validSessions: FixtureSession[]
): NumericAggregate {
  const n = project.statementIds.length;
  const countMatrix = buildSimilarityCountMatrix(project.statementIds, validSessions);
  const proportionMatrix = buildSimilarityProportionMatrix(countMatrix, validSessions.length);
  const dissimilarityMatrix = buildDissimilarityMatrix(proportionMatrix);
  const weightMatrix = buildWeightMatrix(n);

  assertSquareSymmetric(countMatrix, "similarityCountMatrix");
  if (validSessions.length > 0) {
    assertSquareSymmetric(proportionMatrix, "similarityProportionMatrix");
    assertSquareSymmetric(dissimilarityMatrix, "dissimilarityMatrix");
  }

  return {
    statementIds: project.statementIds,
    includedParticipantCount: validSessions.length,
    similarityCountMatrix: countMatrix,
    similarityProportionMatrix: proportionMatrix,
    dissimilarityMatrix,
    weightMatrix,
  };
}
