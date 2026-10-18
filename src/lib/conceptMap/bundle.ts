import type { InputSnapshot } from "@/lib/analysis/snapshot";
import { buildCountMatrix } from "./matrices";
import { compareCountries, type CountryComparison } from "./compare";
import type { ScopeAnalysis } from "./analyze";
import { SCOPE_PROPOSALS } from "./proposals";
import type { ScopeProposal } from "./proposals/types";
import { evaluateMetrics, type MetricRecord } from "./metrics";
import { REFERENCES, type Reference } from "./references";

export type BundleRunMeta = {
  id: string;
  scope: string;
  algorithmVersion: string;
  engineSourceCommitSha: string;
  sourceSnapshotAt: Date;
  numericDataHash: string;
  parameterHash: string;
  statementStructureHash: string;
  statementContentHashKo: string;
  statementContentHashJa: string;
};

export type NamingAttachment =
  | { status: "NONE" }
  | { status: "SIGNATURE_MISMATCH"; detail: string }
  | { status: "ATTACHED"; proposal: ScopeProposal };

export type ResultBundle = {
  bundleVersion: 2;
  meta: {
    runId: string;
    scope: string;
    algorithmVersion: string;
    engineSourceCommitSha: string;
    nodeVersion: string;
    dataSnapshotAt: string;
    computedAt: string;
    computeMs: number;
    N: number;
    nKr: number;
    nJp: number;
    statementCount: number;
    fingerprints: {
      numericDataHash: string;
      participantsHash: string;
      parameterHash: string;
      statementStructureHash: string;
      statementContentHashKo: string;
      statementContentHashJa: string;
    };
  };
  statements: { no: string; id: string; order: number; textKo: string; textJa: string | null; jaStatus: string }[];
  analysis: ScopeAnalysis;
  naming: NamingAttachment;
  comparison: (CountryComparison & { Skr: number[][]; Sjp: number[][] }) | null;
  /** every metric with formula / value / reference kinds / verdict / sources / limits, evaluated at run time */
  metrics: MetricRecord[];
  references: Reference[];
};

export function attachNaming(scope: "KR" | "JP" | "ALL", analysis: ScopeAnalysis): NamingAttachment {
  const proposal = SCOPE_PROPOSALS[scope];
  if (!proposal) return { status: "NONE" };
  const sol = analysis.solutions.find((s) => s.k === proposal.solution.k);
  if (!sol) return { status: "SIGNATURE_MISMATCH", detail: `no computed ${proposal.solution.k}-cluster solution` };
  if (sol.signature !== proposal.solution.signature) return { status: "SIGNATURE_MISMATCH", detail: `membership of the ${sol.k}-cluster solution differs from the one the names were written for` };
  return { status: "ATTACHED", proposal };
}

export function buildResultBundle(args: { run: BundleRunMeta; inputSnapshot: InputSnapshot; analysis: ScopeAnalysis; computeMs: number; finishedAt: Date }): ResultBundle {
  const { run, inputSnapshot, analysis } = args;
  const scope = run.scope as "KR" | "JP" | "ALL";
  let comparison: ResultBundle["comparison"] = null;
  if (scope === "ALL") {
    const n = inputSnapshot.statements.length;
    const kr = inputSnapshot.participants.filter((p) => p.country === "KR");
    const jp = inputSnapshot.participants.filter((p) => p.country === "JP");
    if (kr.length > 0 && jp.length > 0) {
      const Skr = buildCountMatrix(kr, n);
      const Sjp = buildCountMatrix(jp, n);
      comparison = { ...compareCountries(Skr, kr.length, Sjp, jp.length), Skr, Sjp };
    }
  }
  const naming = attachNaming(scope, analysis);
  const recommendedK = naming.status === "ATTACHED" ? naming.proposal.recommendedK : null;
  return {
    bundleVersion: 2,
    meta: {
      runId: run.id,
      scope: run.scope,
      algorithmVersion: run.algorithmVersion,
      engineSourceCommitSha: run.engineSourceCommitSha,
      nodeVersion: process.version,
      dataSnapshotAt: run.sourceSnapshotAt.toISOString(),
      computedAt: args.finishedAt.toISOString(),
      computeMs: args.computeMs,
      N: analysis.N,
      nKr: analysis.nKr,
      nJp: analysis.nJp,
      statementCount: analysis.statementCount,
      fingerprints: {
        numericDataHash: run.numericDataHash,
        participantsHash: inputSnapshot.participantsHash,
        parameterHash: run.parameterHash,
        statementStructureHash: run.statementStructureHash,
        statementContentHashKo: run.statementContentHashKo,
        statementContentHashJa: run.statementContentHashJa,
      },
    },
    statements: inputSnapshot.statements.map((s, i) => ({ no: `S${String(i + 1).padStart(2, "0")}`, id: s.id, order: s.order, textKo: s.textKo, textJa: s.textJa, jaStatus: s.jaStatus })),
    analysis,
    naming,
    comparison,
    metrics: evaluateMetrics(analysis, recommendedK),
    references: Object.values(REFERENCES),
  };
}
