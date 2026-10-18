import type { ScopeProposal } from "./types";
import { PROPOSALS_DATA } from "./data";

/** Registered per-scope proposals (automated; reviewStatus says so). Attached only when the membership signature matches. */
export const SCOPE_PROPOSALS: Partial<Record<"KR" | "JP" | "ALL", ScopeProposal>> = PROPOSALS_DATA;
