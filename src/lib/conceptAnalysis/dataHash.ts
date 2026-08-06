import { createHash } from "node:crypto";
import type { AnalysisScope, FixtureProject, FixtureSession } from "./types";

/**
 * Pure dataHash function: given a project's statement set and the sessions
 * that are valid for a given scope, produces a hash that changes whenever
 * anything the analysis actually depends on changes, and stays the same
 * when only irrelevant things change (array input order, for example).
 *
 * Deliberately excludes participantName/phoneNumber/adminToken — the hash
 * input is built only from statementIds, order, sessionId, countryCode, and
 * group structure, matching the finalized dataHash design.
 */
export function computeDataHash(
  project: FixtureProject,
  scope: AnalysisScope,
  validSessions: FixtureSession[],
  algorithmVersion: string
): string {
  const statementPart = project.statementIds.map((id, order) => `${order}:${id}`).join("|");

  const sessionParts = validSessions
    .map((s) => {
      const groupsCanonical = s.groups
        .map((g) => [...g].sort()) // membership within a group is order-independent
        .map((g) => g.join(","))
        .sort() // group order within a session is not semantically meaningful
        .join(";");
      return `${s.sessionId}:${s.countryCode}:${groupsCanonical}`;
    })
    .sort() // session order in the input array must not affect the hash
    .join("|");

  const payload = [
    `project=${project.projectKey}`,
    `scope=${scope}`,
    `algorithmVersion=${algorithmVersion}`,
    `statements=${statementPart}`,
    `sessions=${sessionParts}`,
  ].join("\n");

  return createHash("sha256").update(payload, "utf-8").digest("hex");
}
