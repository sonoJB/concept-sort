import type { DataRole } from "@/lib/analysis/dataset";

/**
 * Server-clock-only PILOT/MAIN classification for a new participant
 * submission. `receivedAt` must come from a single trusted server
 * `new Date()` read at submission time — never a browser/client clock,
 * never re-derived from participant fields (name/phone/countryCode), and
 * never taken from the request body.
 *
 * `mainStudyStartsAt === null` means no cutover is configured for this
 * project: every submission classifies MAIN, matching the original
 * (pre-cutover) behavior. When set, the boundary is inclusive on the MAIN
 * side: `receivedAt < mainStudyStartsAt` → PILOT, `receivedAt >=
 * mainStudyStartsAt` → MAIN.
 */
export function classifySubmissionDataRole({
  receivedAt,
  mainStudyStartsAt,
}: {
  receivedAt: Date;
  mainStudyStartsAt: Date | null;
}): DataRole {
  if (mainStudyStartsAt === null) return "MAIN";
  return receivedAt.getTime() >= mainStudyStartsAt.getTime() ? "MAIN" : "PILOT";
}
