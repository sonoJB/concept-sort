import { describe, it, expect } from "vitest";
import { runDimension, runOfficialWard, type DimensionResult } from "./engineAdapter";
import { DEFAULT_ANALYSIS_PARAMETERS } from "./config";
import { buildDissimilarityMatrix, buildSimilarityProportionMatrix, buildSimilarityCountMatrix, buildWeightMatrix } from "@/lib/conceptAnalysis";

function fixture(n: number) {
  // A small, well-behaved synthetic co-occurrence pattern (no PII, no DB).
  const statementIds = Array.from({ length: n }, (_, i) => `s${i}`);
  const sessions = [
    { sessionId: "a", countryCode: "KR" as const, groups: [statementIds.slice(0, Math.ceil(n / 2)), statementIds.slice(Math.ceil(n / 2))] },
    { sessionId: "b", countryCode: "KR" as const, groups: [statementIds.slice(0, Math.floor(n / 2)), statementIds.slice(Math.floor(n / 2))] },
    { sessionId: "c", countryCode: "KR" as const, groups: [[...statementIds]] },
  ];
  const count = buildSimilarityCountMatrix(statementIds, sessions);
  const proportion = buildSimilarityProportionMatrix(count, sessions.length);
  const dissimilarity = buildDissimilarityMatrix(proportion);
  const weight = buildWeightMatrix(n);
  return { dissimilarity, weight };
}

describe("runDimension", () => {
  it("returns COMPLETED with populated results for a well-formed dimension < n", () => {
    const { dissimilarity, weight } = fixture(6);
    const result = runDimension(2, dissimilarity, weight, DEFAULT_ANALYSIS_PARAMETERS);
    expect(result.dimensionStatus).toBe("COMPLETED");
    expect(result.coordinates).not.toBeNull();
    expect(result.errorCode).toBeNull();
    expect(typeof result.commonStressDistance).toBe("number");
    expect(typeof result.commonStressQ).toBe("number");
  });

  it("returns FAILED with errorCode when dimension >= n (hard engine failure, not a data problem)", () => {
    const { dissimilarity, weight } = fixture(2); // n=2, dimension 2 >= n
    const result = runDimension(2, dissimilarity, weight, DEFAULT_ANALYSIS_PARAMETERS);
    expect(result.dimensionStatus).toBe("FAILED");
    expect(result.errorCode).toBe("DIMENSION_TOO_HIGH");
    expect(result.coordinates).toBeNull();
  });

  it("rejects an out-of-range requested dimension before calling the engine", () => {
    const { dissimilarity, weight } = fixture(6);
    const result = runDimension(7, dissimilarity, weight, DEFAULT_ANALYSIS_PARAMETERS);
    expect(result.dimensionStatus).toBe("FAILED");
    expect(result.errorCode).toBe("INVALID_DIMENSION");
  });

  it("converged=false is reported as COMPLETED, never as FAILED", () => {
    // maxIter=1 makes convergence within tolerance unlikely for a non-trivial
    // fixture, while still producing a finite, valid result.
    const { dissimilarity, weight } = fixture(6);
    const result = runDimension(2, dissimilarity, weight, { ...DEFAULT_ANALYSIS_PARAMETERS, maxIter: 1 });
    expect(result.dimensionStatus).toBe("COMPLETED");
    expect(result.errorCode).toBeNull();
    // converged may be true or false depending on the fixture, but either
    // way dimensionStatus must stay COMPLETED — that's the actual assertion.
  });
});

describe("runOfficialWard", () => {
  it("is NOT_RUN when the primary dimension failed", () => {
    const failed: DimensionResult = {
      dimension: 2,
      dimensionStatus: "FAILED",
      coordinates: null,
      rawStress: null,
      commonStressDistance: null,
      commonStressQ: null,
      converged: null,
      iterations: null,
      bestInitIndex: null,
      bestSeed: null,
      stressHistory: null,
      normalizationMeta: null,
      errorCode: "DIMENSION_TOO_HIGH",
      errorMessageSafe: "x",
    };
    const ward = runOfficialWard(failed);
    expect(ward.wardStatus).toBe("NOT_RUN");
  });

  it("is COMPLETED for a valid primary configuration", () => {
    const { dissimilarity, weight } = fixture(6);
    const primary = runDimension(2, dissimilarity, weight, DEFAULT_ANALYSIS_PARAMETERS);
    const ward = runOfficialWard(primary);
    expect(ward.wardStatus).toBe("COMPLETED");
    expect(ward.wardLinkageSnapshot).not.toBeNull();
  });

  it("is FAILED (hard engine failure, not NOT_RUN) when Ward itself cannot process the primary coordinates", () => {
    // Tested at the engine boundary per Gate 3 spec §29: fewer than 2 points
    // is the one documented hard-failure condition of wardHierarchicalClustering.
    const degenerate: DimensionResult = {
      dimension: 2,
      dimensionStatus: "COMPLETED",
      coordinates: [[0, 0]], // only 1 point
      rawStress: 0,
      commonStressDistance: 0,
      commonStressQ: 0,
      converged: true,
      iterations: 1,
      bestInitIndex: 0,
      bestSeed: 1,
      stressHistory: [0],
      normalizationMeta: null,
      errorCode: null,
      errorMessageSafe: null,
    };
    const ward = runOfficialWard(degenerate);
    expect(ward.wardStatus).toBe("FAILED");
    expect(ward.wardErrorCode).toBe("WARD_EXECUTION_ERROR");
  });
});
