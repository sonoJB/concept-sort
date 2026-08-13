import type { PrismaClient } from "@/generated/prisma/client";

export class PilotSetMismatchError extends Error {
  constructor(
    public readonly expectedIds: string[],
    public readonly actualIds: string[]
  ) {
    super(
      `Pilot backfill aborted: current SortSession ID set does not exactly equal the expected pilot ID set. ` +
        `expected=[${expectedIds.join(",")}] actual=[${actualIds.join(",")}]`
    );
    this.name = "PilotSetMismatchError";
  }
}

/**
 * One-time, exact-ID backfill: marks ONLY the given session IDs as PILOT.
 * Never selects rows by participantName, phone, submittedAt, country, or
 * group count — identity is the immutable SortSession.id only.
 *
 * Fail-closed: before writing anything, verifies the CURRENT full set of
 * SortSession IDs for this project exactly equals `expectedPilotSessionIds`
 * (same size, same members) — no more, no fewer. Any mismatch throws
 * PilotSetMismatchError and performs zero writes. This is the same
 * discipline used by every other production data-mutation in this project:
 * verify exact expected state, then mutate in one transaction, never guess.
 *
 * Does not touch SortGroup or SortGroupItem — this is a SortSession.dataRole
 * classification only.
 */
export async function backfillPilotSessions(
  prisma: PrismaClient,
  projectId: string,
  expectedPilotSessionIds: string[]
): Promise<{ pilotCount: number }> {
  const current = await prisma.sortSession.findMany({ where: { projectId }, select: { id: true } });
  const currentIds = current.map((s) => s.id);

  const expectedSet = new Set(expectedPilotSessionIds);
  const currentSet = new Set(currentIds);
  const exactMatch =
    expectedSet.size === currentSet.size && [...expectedSet].every((id) => currentSet.has(id));

  if (!exactMatch) {
    throw new PilotSetMismatchError(expectedPilotSessionIds, currentIds);
  }

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.sortSession.updateMany({
      where: { projectId, id: { in: expectedPilotSessionIds } },
      data: { dataRole: "PILOT" },
    });
    if (updated.count !== expectedPilotSessionIds.length) {
      throw new Error(
        `Pilot backfill count mismatch: expected to update ${expectedPilotSessionIds.length}, actually updated ${updated.count}`
      );
    }
    return updated;
  });

  return { pilotCount: result.count };
}
