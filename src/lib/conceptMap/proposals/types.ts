/**
 * Researcher-facing content attached to a cluster solution: recommended cluster count, cluster names and the
 * evidence for them. Everything here is an AUTOMATED PROPOSAL (written from reading the statement texts) until a
 * researcher reviews it; reviewStatus says so on every screen and file. A proposal only attaches to a computed
 * solution whose membership signature matches exactly, so a changed analysis can never inherit stale names.
 */
export type ReviewStatus = "AUTO_PROPOSED" | "RESEARCHER_REVIEWED" | "FINALIZED";

export type ClusterProposal = {
  cluster: number; // canonical number (1..k by smallest member statement)
  nameKo: string;
  /** review translation (검토용 번역안); the original Japanese statements are never overwritten */
  nameJa: string;
  coreContentKo: string;
  basisKo: string; // why this name: representative statements and their correspondence
  representativeStatements: number[]; // 1-based statement numbers
};

export type SolutionProposal = {
  k: number;
  signature: string; // membership signature the proposal was written for
  clusters: ClusterProposal[];
};

export type AlternativeNote = { k: number; signature: string; commentKo: string };

export type ScopeProposal = {
  scope: "KR" | "JP" | "ALL";
  reviewStatus: ReviewStatus;
  recommendedK: number;
  recommendationRationaleKo: string[];
  solution: SolutionProposal;
  alternatives: AlternativeNote[];
};
