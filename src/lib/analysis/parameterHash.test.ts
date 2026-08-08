import { describe, it, expect } from "vitest";
import { computeParameterHash, type AnalysisParameters } from "./hashes";
import { buildParametersSnapshot } from "./snapshot";
import { DEFAULT_ANALYSIS_PARAMETERS } from "./config";

describe("parameterHash / provenance separation", () => {
  it("is unaffected by engineSourceCommitSha or validationBaselineSha differences", () => {
    const snapshotA = buildParametersSnapshot(DEFAULT_ANALYSIS_PARAMETERS, { validationBaselineSha: "d2e41f5c" });
    const snapshotB = buildParametersSnapshot(DEFAULT_ANALYSIS_PARAMETERS, { validationBaselineSha: "aaaaaaaa" });
    expect(computeParameterHash(snapshotA)).toBe(computeParameterHash(snapshotB));
  });

  it("changes when a real analysis parameter changes (nInit)", () => {
    const params: AnalysisParameters = { ...DEFAULT_ANALYSIS_PARAMETERS, nInit: 4 };
    const snapshotA = buildParametersSnapshot(DEFAULT_ANALYSIS_PARAMETERS, { validationBaselineSha: "x" });
    const snapshotB = buildParametersSnapshot(params, { validationBaselineSha: "x" });
    expect(computeParameterHash(snapshotA)).not.toBe(computeParameterHash(snapshotB));
  });

  it("changes when dimensionsEvaluated changes", () => {
    const params: AnalysisParameters = { ...DEFAULT_ANALYSIS_PARAMETERS, dimensionsEvaluated: [2] };
    const snapshotA = buildParametersSnapshot(DEFAULT_ANALYSIS_PARAMETERS, { validationBaselineSha: "x" });
    const snapshotB = buildParametersSnapshot(params, { validationBaselineSha: "x" });
    expect(computeParameterHash(snapshotA)).not.toBe(computeParameterHash(snapshotB));
  });

  it("changes when wardSourceDimension or eps changes", () => {
    const base = buildParametersSnapshot(DEFAULT_ANALYSIS_PARAMETERS, { validationBaselineSha: "x" });
    const epsChanged = buildParametersSnapshot({ ...DEFAULT_ANALYSIS_PARAMETERS, eps: 1e-6 }, { validationBaselineSha: "x" });
    expect(computeParameterHash(base)).not.toBe(computeParameterHash(epsChanged));
  });
});
