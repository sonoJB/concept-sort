import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDisposableDb, seedProject, seedSession } from "./testSupport/disposableDb";
import { backfillPilotSessions, PilotSetMismatchError } from "./backfillPilotSessions";
import type { PrismaClient } from "@/generated/prisma/client";

let ctx: ReturnType<typeof createDisposableDb>;
let prisma: PrismaClient;

beforeEach(() => {
  ctx = createDisposableDb();
  prisma = ctx.prisma;
});

afterEach(async () => {
  await prisma.$disconnect();
  ctx.cleanup();
});

describe("(3) backfillPilotSessions — exact-ID pilot backfill", () => {
  it("marks exactly the six expected session IDs as PILOT when the current set matches exactly", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "backfill-exact-six", statementCount: 4 });
    const g = () => [statementIds.slice(0, 2), statementIds.slice(2)];
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push(await seedSession(prisma, { projectId, countryCode: "KR", groups: g() }));
    for (let i = 0; i < 3; i++) sessions.push(await seedSession(prisma, { projectId, countryCode: "JP", groups: g() }));
    const ids = sessions.map((s) => s.id);

    const result = await backfillPilotSessions(prisma, projectId, ids);
    expect(result.pilotCount).toBe(6);

    const rows = await prisma.sortSession.findMany({ where: { projectId } });
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.dataRole === "PILOT")).toBe(true);
  });

  it("STOPs (throws PilotSetMismatchError, zero writes) when an extra unexpected session exists", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "backfill-extra-session", statementCount: 4 });
    const g = () => [statementIds.slice(0, 2), statementIds.slice(2)];
    const expected = await seedSession(prisma, { projectId, countryCode: "KR", groups: g() });
    const unexpected = await seedSession(prisma, { projectId, countryCode: "JP", groups: g() });

    await expect(backfillPilotSessions(prisma, projectId, [expected.id])).rejects.toBeInstanceOf(PilotSetMismatchError);

    const rows = await prisma.sortSession.findMany({ where: { projectId } });
    // No write occurred at all — every row still carries the schema default MAIN.
    expect(rows.find((r) => r.id === expected.id)?.dataRole).toBe("MAIN");
    expect(rows.find((r) => r.id === unexpected.id)?.dataRole).toBe("MAIN");
  });

  it("STOPs when the current set is missing one of the expected IDs (fewer sessions than expected)", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "backfill-missing-session", statementCount: 4 });
    const g = () => [statementIds.slice(0, 2), statementIds.slice(2)];
    const only = await seedSession(prisma, { projectId, countryCode: "KR", groups: g() });

    await expect(
      backfillPilotSessions(prisma, projectId, [only.id, "cm_this_id_does_not_exist_yet"])
    ).rejects.toBeInstanceOf(PilotSetMismatchError);

    const row = await prisma.sortSession.findUniqueOrThrow({ where: { id: only.id } });
    expect(row.dataRole).toBe("MAIN");
  });

  it("never selects by participantName, phone, or country — only by immutable session ID", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "backfill-id-only", statementCount: 4 });
    const g = () => [statementIds.slice(0, 2), statementIds.slice(2)];
    // Two sessions with IDENTICAL participant-facing fields (same synthetic
    // name/phone/country from seedSession) except their opaque ID — proves
    // the backfill can only be distinguishing them by ID, since nothing else
    // differs. A third, untouched session (not in the expected/current set
    // scenario) is intentionally NOT seeded here — exact-set-equality
    // requires the full current set to equal the expected set, so both `a`
    // and `b` are included below and both must become PILOT.
    const a = await seedSession(prisma, { projectId, countryCode: "KR", groups: g() });
    const b = await seedSession(prisma, { projectId, countryCode: "KR", groups: g() });

    await backfillPilotSessions(prisma, projectId, [a.id, b.id]);

    const rowA = await prisma.sortSession.findUniqueOrThrow({ where: { id: a.id } });
    const rowB = await prisma.sortSession.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowA.dataRole).toBe("PILOT");
    expect(rowB.dataRole).toBe("PILOT");
  });

  it("does not modify SortGroup or SortGroupItem rows", async () => {
    const { projectId, statementIds } = await seedProject(prisma, { slug: "backfill-no-group-mutation", statementCount: 4 });
    const g = () => [statementIds.slice(0, 2), statementIds.slice(2)];
    const session = await seedSession(prisma, { projectId, countryCode: "KR", groups: g() });

    const groupsBefore = await prisma.sortGroup.findMany({ where: { sortSessionId: session.id } });
    const itemsBefore = await prisma.sortGroupItem.findMany({ where: { group: { sortSessionId: session.id } } });

    await backfillPilotSessions(prisma, projectId, [session.id]);

    const groupsAfter = await prisma.sortGroup.findMany({ where: { sortSessionId: session.id } });
    const itemsAfter = await prisma.sortGroupItem.findMany({ where: { group: { sortSessionId: session.id } } });
    expect(groupsAfter).toEqual(groupsBefore);
    expect(itemsAfter).toEqual(itemsBefore);
  });
});
