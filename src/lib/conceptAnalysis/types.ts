/**
 * Shared types for the concept-map statistics prototype. This module tree is
 * intentionally isolated from the running app (no imports from/into
 * src/components, src/app, or src/lib/mds.ts, src/lib/clustering.ts) — it
 * exists to get the statistics right in isolation before anything touches
 * the database or the UI.
 */

export type AnalysisScope = "KR" | "JP" | "ALL";

/** A minimal, DB-agnostic description of one participant's sort — no PII. */
export type FixtureSession = {
  /** Opaque id, never a real SortSession.id from production. */
  sessionId: string;
  countryCode: "KR" | "JP" | null;
  /** Every group the participant created; each entry is the statementIds placed in it. */
  groups: string[][];
};

export type FixtureProject = {
  projectKey: string;
  statementIds: string[]; // in `order` sequence
};

export type ExclusionSummary = {
  scope: AnalysisScope;
  totalSessionsInProject: number;
  excludedNullCountry: number;
  excludedWrongCountryForScope: number;
  excludedIncomplete: number; // statement coverage != full statement set
  excludedDuplicate: number; // a statementId placed in >1 group
  excludedInvalidStatement: number; // references a statementId outside the project's set
  validCount: number;
};

export type ScopeFilterResult = {
  scope: AnalysisScope;
  validSessions: FixtureSession[];
  nKr: number;
  nJp: number;
  nTotal: number;
  exclusions: ExclusionSummary;
};

/** n x n numeric matrix, rows/cols aligned to FixtureProject.statementIds order. */
export type Matrix = number[][];

export type WeightMatrix = Matrix; // 0 or 1 (0 = diagonal or genuinely missing pair)

export type Point = number[]; // length == dimension

export type IsotonicTieHandling = "secondary"; // tied dissimilarities forced to equal disparities

export type SmacofParams = {
  algorithm: "SMACOF";
  metric: false;
  dimension: 1 | 2 | 3 | 4 | 5 | 6;
  normalizedStress: true;
  randomSeed: number;
  nInit: number;
  maxIter: number;
  eps: number;
  tieHandling: IsotonicTieHandling;
};

export type SmacofInitResult = {
  initIndex: number;
  seed: number;
  coordinates: Point[];
  rawStress: number;
  normalizedStress1: number;
  converged: boolean;
  iterations: number;
  stressHistory: number[];
  errorCode?: string;
  errorMessage?: string;
};

export type SmacofRunResult = {
  dimension: number;
  params: SmacofParams;
  inits: SmacofInitResult[];
  bestInitIndex: number | null; // null only if every init failed
  bestSeed: number | null;
  coordinates: Point[] | null;
  rawStress: number | null;
  normalizedStress1: number | null;
  converged: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export type DimensionDiagnostic = {
  dimension: number;
  normalizedStress1: number | null;
  rawStress: number | null;
  converged: boolean;
  iterations: number | null;
  bestInit: number | null;
  bestSeed: number | null;
  absoluteReductionFromPrevious: number | null;
  relativeReductionFromPrevious: number | null;
  errorCode?: string;
};

export type WardLinkageRow = {
  step: number;
  leftNode: number;
  rightNode: number;
  mergeDistance: number;
  mergedItemCount: number;
};

export type WardResult = {
  linkage: WardLinkageRow[];
  originalCount: number;
};
