import { describe, it, expect } from "vitest";
import {
  filterSessionsForScope,
  runSmacof,
  type FixtureProject,
  type FixtureSession,
} from "@/lib/conceptAnalysis";
import { buildNumericAggregate } from "./aggregates";
import { DEFAULT_ANALYSIS_PARAMETERS } from "./config";
import { computeRSQForDimension, deriveConvergenceReason } from "./rsq";
import fixture from "./testSupport/pilotRegressionFixture.json";

/**
 * Regression fixture: the 6 real, researcher-submitted pilot sessions for
 * production project rrrvvnux (KR=3, JP=3; statement IDs are opaque
 * database identifiers, never PII — session labels here are synthetic
 * KR1/KR2/KR3/JP1/JP2/JP3, never the real SortSession.id). This test
 * reproduces the exact 1D-5D Stress/R²/RSQ values independently verified
 * against production's own AnalysisRun computation in an earlier read-only
 * verification pass, and locks them in as a permanent regression guard.
 */
describe("computeRSQForDimension — pilot regression (N=6, ALL scope)", () => {
  const project: FixtureProject = { projectKey: "rrrvvnux", statementIds: fixture.statementIds };
  const sessions: FixtureSession[] = fixture.fixtureSessions.map((s) => ({
    sessionId: s.sessionId,
    countryCode: s.countryCode as "KR" | "JP",
    groups: s.groups,
  }));
  const scopeResult = filterSessionsForScope(project, sessions, "ALL");
  const agg = buildNumericAggregate(project, scopeResult.validSessions);
  const params = DEFAULT_ANALYSIS_PARAMETERS;

  it("pools exactly N=6 (KR=3, JP=3) with no exclusions", () => {
    expect(scopeResult.nTotal).toBe(6);
    expect(scopeResult.nKr).toBe(3);
    expect(scopeResult.nJp).toBe(3);
    expect(scopeResult.exclusions.excludedIncomplete).toBe(0);
    expect(scopeResult.exclusions.excludedDuplicate).toBe(0);
    expect(scopeResult.exclusions.excludedInvalidStatement).toBe(0);
  });

  const EXPECTED: Record<number, { stress: number; rsq: number; converged: boolean; iterations: number }> = {
    1: { stress: 0.6795394170812906, rsq: 0.011256587651938712, converged: true, iterations: 7 },
    2: { stress: 0.4443438226480203, rsq: 0.009462101185021056, converged: false, iterations: 2 },
    3: { stress: 0.23758420940724334, rsq: 0.46351041405030374, converged: false, iterations: 300 },
    4: { stress: 0.1875803096560873, rsq: 0.5058631737392911, converged: false, iterations: 300 },
    5: { stress: 0.14545652415045746, rsq: 0.6090678657555672, converged: false, iterations: 300 },
  };

  for (const dim of [1, 2, 3, 4, 5] as const) {
    it(`${dim}D matches the independently-verified pilot regression values exactly`, () => {
      const result = runSmacof(agg.dissimilarityMatrix, agg.weightMatrix, {
        algorithm: "SMACOF",
        metric: false,
        dimension: dim,
        normalizedStress: true,
        randomSeed: params.randomSeed,
        nInit: params.nInit,
        maxIter: params.maxIter,
        eps: params.eps,
        tieHandling: params.tieHandling,
      });

      expect(result.errorCode).toBeUndefined();
      expect(result.coordinates).not.toBeNull();
      expect(result.normalizedStress1).toBeCloseTo(EXPECTED[dim].stress, 12);
      expect(result.converged).toBe(EXPECTED[dim].converged);

      const bestInit = result.inits[result.bestInitIndex!];
      expect(bestInit.iterations).toBe(EXPECTED[dim].iterations);

      const rsqResult = computeRSQForDimension(agg.dissimilarityMatrix, agg.weightMatrix, result.coordinates!);
      expect(rsqResult.errorCode).toBeNull();
      expect(rsqResult.rsq).toBeCloseTo(EXPECTED[dim].rsq, 12);
      // R² is DEFINED as RSQ — same value, not two separately-derived numbers.
      expect(rsqResult.rsq).toBe(rsqResult.rsq);
      expect(rsqResult.pairCount).toBe((47 * 46) / 2);
    });
  }

  it("2D's ΔR² from 1D is negative and reported as-is (not clamped to zero)", () => {
    const delta = EXPECTED[2].rsq - EXPECTED[1].rsq;
    expect(delta).toBeLessThan(0);
    expect(delta).toBeCloseTo(-0.0017944864669176564, 12);
  });

  it("2D's convergence reason is STRESS_INCREASED (iterations=2, well short of maxIter=300)", () => {
    expect(deriveConvergenceReason("COMPLETED", false, EXPECTED[2].iterations, params.maxIter)).toBe(
      "STRESS_INCREASED"
    );
  });

  it("3D-5D's convergence reason is MAX_ITER_REACHED (iterations=300=maxIter)", () => {
    for (const dim of [3, 4, 5] as const) {
      expect(deriveConvergenceReason("COMPLETED", false, EXPECTED[dim].iterations, params.maxIter)).toBe(
        "MAX_ITER_REACHED"
      );
    }
  });
});

describe("deriveConvergenceReason", () => {
  it("reports CONVERGED when converged=true", () => {
    expect(deriveConvergenceReason("COMPLETED", true, 7, 300)).toBe("CONVERGED");
  });
  it("reports MAX_ITER_REACHED when converged=false and iterations reached maxIter", () => {
    expect(deriveConvergenceReason("COMPLETED", false, 300, 300)).toBe("MAX_ITER_REACHED");
  });
  it("reports STRESS_INCREASED when converged=false and iterations stopped well short of maxIter", () => {
    expect(deriveConvergenceReason("COMPLETED", false, 2, 300)).toBe("STRESS_INCREASED");
  });
  it("reports NOT_APPLICABLE for a FAILED dimension", () => {
    expect(deriveConvergenceReason("FAILED", null, null, 300)).toBe("NOT_APPLICABLE");
  });
});
