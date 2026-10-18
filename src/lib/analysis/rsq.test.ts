import { describe, it, expect } from "vitest";
import { filterSessionsForScope, type FixtureProject, type FixtureSession } from "@/lib/conceptAnalysis";
import { evaluateConfiguration, runSmacofV2 } from "@/lib/conceptAnalysis/smacofV2";
import { buildNumericAggregate } from "./aggregates";
import { computeRSQForDimension } from "./rsq";
import fixture from "./testSupport/pilotRegressionFixture.json";

/**
 * Regression fixture: the 6 real pilot sessions (statement ids are opaque database identifiers, session labels
 * synthetic). The previous version of this file pinned the OLD engine's behaviour for this data — "2D stops at
 * iteration 2 as STRESS_INCREASED, 3D–5D hit MAX_ITER=300" — which is exactly the defect that was fixed: the old
 * loop treated a rising Stress-1 as an error although the objective (raw stress) was still falling. These tests
 * pin the corrected behaviour instead.
 */
describe("RSQ and convergence on the pilot regression data (N=6, ALL scope)", () => {
  const project: FixtureProject = { projectKey: "rrrvvnux", statementIds: fixture.statementIds };
  const sessions: FixtureSession[] = fixture.fixtureSessions.map((s) => ({ sessionId: s.sessionId, countryCode: s.countryCode as "KR" | "JP", groups: s.groups }));
  const scopeResult = filterSessionsForScope(project, sessions, "ALL");
  const agg = buildNumericAggregate(project, scopeResult.validSessions);
  const settings = { nInit: 8, maxIter: 5000, eps: 1e-9, strictEps: 1e-12, strictMaxIter: 20000, randomSeed: 42, tieHandling: "secondary" as const };

  it("pools exactly N=6 (KR=3, JP=3) with no exclusions", () => {
    expect(scopeResult.nTotal).toBe(6);
    expect(scopeResult.nKr).toBe(3);
    expect(scopeResult.nJp).toBe(3);
    expect(scopeResult.exclusions.excludedIncomplete).toBe(0);
  });

  for (const dimension of [2, 3]) {
    it(`${dimension}D: the stored coordinates reproduce every reported metric, including RSQ`, () => {
      const r = runSmacofV2(agg.dissimilarityMatrix, agg.weightMatrix, { ...settings, dimension });
      expect(r.coordinates).not.toBeNull();
      const ev = evaluateConfiguration(r.coordinates!, agg.dissimilarityMatrix, agg.weightMatrix);
      expect(ev.rawStress).toBeCloseTo(r.evaluation!.rawStress, 10);
      const rsq = computeRSQForDimension(agg.dissimilarityMatrix, agg.weightMatrix, r.coordinates!);
      expect(rsq.errorCode).toBeNull();
      expect(rsq.rsq).toBeCloseTo(ev.rsq, 12);
      expect(rsq.pairCount).toBe((47 * 46) / 2);
    });

    it(`${dimension}D: no start is abandoned only because Stress-1 rose while raw stress fell`, () => {
      const r = runSmacofV2(agg.dissimilarityMatrix, agg.weightMatrix, { ...settings, dimension });
      for (const s of r.starts) {
        expect(s.reason).not.toBe("OBJECTIVE_INCREASED");
        expect(s.maxRelativeIncrease).toBeLessThan(1e-9);
      }
      // the old engine ended every 2D start at iteration 2 on this data
      expect(Math.max(...r.starts.map((s) => s.iterations))).toBeGreaterThan(2);
    });
  }

  it("a non-converged selection is reported as such and never as converged", () => {
    const r = runSmacofV2(agg.dissimilarityMatrix, agg.weightMatrix, { ...settings, dimension: 2, maxIter: 3, strictMaxIter: 3 });
    expect(r.selectionStatus).toBe("NO_CONVERGED_CANDIDATE");
    expect(r.convergedCount).toBe(0);
  });

  it("RSQ is null with an error code for fewer than two points instead of a fabricated value", () => {
    expect(computeRSQForDimension([[0]], [[0]], [[0, 0]]).rsq).toBeNull();
  });
});
