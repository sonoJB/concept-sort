/**
 * One-time maintenance script: keeps exactly one Project (its Statements
 * untouched) and permanently deletes everything else — all other Projects
 * (with their Statements/SortSessions/SortGroups/SortGroupItems), plus all
 * SortSession/SortGroup/SortGroupItem rows belonging to the kept project.
 *
 * Defaults to dry-run. Real deletion requires ALL of:
 *   --apply
 *   --keep-project=<slug>
 *   --confirm=DELETE_OTHER_PROJECTS_AND_RESET_RRRVVNUX_RESPONSES
 *   --backup=<path-to-an-existing-db-backup-file>
 *
 * Usage:
 *   DATABASE_URL="file:/path/to/db" npx tsx scripts/cleanup-project-data.ts --keep-project=rrrvvnux
 *   DATABASE_URL="file:/path/to/db" npx tsx scripts/cleanup-project-data.ts \
 *     --apply --keep-project=rrrvvnux \
 *     --confirm=DELETE_OTHER_PROJECTS_AND_RESET_RRRVVNUX_RESPONSES \
 *     --backup=/path/to/backup.db
 *
 * Never prints adminToken, participantName, phoneNumber, or any other
 * demographic/personal free-text field.
 */
import fs from "node:fs";
import { PrismaClient } from "../src/generated/prisma/client";

const REQUIRED_CONFIRMATION = "DELETE_OTHER_PROJECTS_AND_RESET_RRRVVNUX_RESPONSES";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    flags[key] = rest.length > 0 ? rest.join("=") : true;
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const apply = flags.apply === true;
  const keepSlug = typeof flags["keep-project"] === "string" ? (flags["keep-project"] as string) : null;
  const confirmation = typeof flags.confirm === "string" ? (flags.confirm as string) : null;
  const backupPath = typeof flags.backup === "string" ? (flags.backup as string) : null;

  if (!keepSlug) {
    console.error("ERROR: --keep-project=<slug> is required.");
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();

  try {
    const keepProject = await prisma.project.findUnique({ where: { slug: keepSlug } });
    if (!keepProject) {
      console.error(`ERROR: no project found with slug "${keepSlug}". Nothing will be done.`);
      process.exitCode = 1;
      return;
    }

    const [
      otherProjectCount,
      otherStatementCount,
      keepStatementCount,
      totalSessionCount,
      totalGroupCount,
      totalGroupItemCount,
      keepSessionCount,
      keepGroupCount,
      keepGroupItemCount,
    ] = await Promise.all([
      prisma.project.count({ where: { id: { not: keepProject.id } } }),
      prisma.statement.count({ where: { projectId: { not: keepProject.id } } }),
      prisma.statement.count({ where: { projectId: keepProject.id } }),
      prisma.sortSession.count(),
      prisma.sortGroup.count(),
      prisma.sortGroupItem.count(),
      prisma.sortSession.count({ where: { projectId: keepProject.id } }),
      prisma.sortGroup.count({ where: { sortSession: { projectId: keepProject.id } } }),
      prisma.sortGroupItem.count({ where: { group: { sortSession: { projectId: keepProject.id } } } }),
    ]);

    console.log("===== cleanup-project-data.ts =====");
    console.log("mode:", apply ? "APPLY" : "DRY-RUN");
    console.log("유지할 프로젝트 slug:", keepProject.slug);
    console.log("삭제할 다른 Project 수:", otherProjectCount);
    console.log("삭제할 다른 Statement 수:", otherStatementCount);
    console.log("삭제할 전체 SortSession 수 (유지 프로젝트 포함 전체):", totalSessionCount);
    console.log("삭제할 전체 SortGroup 수 (유지 프로젝트 포함 전체):", totalGroupCount);
    console.log("삭제할 전체 SortGroupItem 수 (유지 프로젝트 포함 전체):", totalGroupItemCount);
    console.log(`  - 그중 ${keepProject.slug} 소속: session=${keepSessionCount}, group=${keepGroupCount}, groupItem=${keepGroupItemCount}`);
    console.log(`${keepProject.slug}에서 유지할 Statement 수:`, keepStatementCount);
    console.log("\n정리 후 예상 모델별 행 수:");
    console.log("  Project:", 1);
    console.log("  Statement:", keepStatementCount);
    console.log("  SortSession:", 0);
    console.log("  SortGroup:", 0);
    console.log("  SortGroupItem:", 0);

    if (!apply) {
      console.log("\nDRY-RUN 완료. 실제 삭제 없음. --apply로 재실행하면 실제 삭제를 시도합니다.");
      return;
    }

    // ---- Gate every precondition before touching anything. ----
    const missing: string[] = [];
    if (confirmation !== REQUIRED_CONFIRMATION) missing.push("--confirm 문구가 일치하지 않음");
    if (!backupPath) missing.push("--backup=<path> 누락");
    else if (!fs.existsSync(backupPath)) missing.push(`--backup 파일이 존재하지 않음: ${backupPath}`);
    else if (fs.statSync(backupPath).size === 0) missing.push(`--backup 파일이 비어 있음: ${backupPath}`);

    if (missing.length > 0) {
      console.error("\nAPPLY 거부됨 — 다음 조건이 충족되지 않았습니다:");
      for (const m of missing) console.error("  -", m);
      process.exitCode = 1;
      return;
    }

    console.log(`\n백업 확인됨: ${backupPath} (${fs.statSync(backupPath!).size} bytes)`);
    console.log("\n실제 삭제를 시작합니다...");

    const result = await prisma.$transaction(
      async (tx) => {
        // A. Reset the kept project's own participation records.
        const keepSessions = await tx.sortSession.findMany({
          where: { projectId: keepProject.id },
          select: { id: true },
        });
        const keepSessionIds = keepSessions.map((s) => s.id);
        const keepGroups = await tx.sortGroup.findMany({
          where: { sortSessionId: { in: keepSessionIds } },
          select: { id: true },
        });
        const keepGroupIds = keepGroups.map((g) => g.id);

        const aItems = await tx.sortGroupItem.deleteMany({ where: { groupId: { in: keepGroupIds } } });
        const aGroups = await tx.sortGroup.deleteMany({ where: { id: { in: keepGroupIds } } });
        const aSessions = await tx.sortSession.deleteMany({ where: { id: { in: keepSessionIds } } });

        if (aItems.count !== keepGroupItemCount || aGroups.count !== keepGroupCount || aSessions.count !== keepSessionCount) {
          throw new Error(
            `keep-project 삭제 개수 불일치: items ${aItems.count}/${keepGroupItemCount}, groups ${aGroups.count}/${keepGroupCount}, sessions ${aSessions.count}/${keepSessionCount}`
          );
        }

        // B. Delete every other project entirely (cascades cover groups/items/sessions/statements,
        // but we delete explicitly and verify counts rather than relying on cascade alone).
        const otherProjects = await tx.project.findMany({
          where: { id: { not: keepProject.id } },
          select: { id: true },
        });
        const otherProjectIds = otherProjects.map((p) => p.id);

        const otherSessions = await tx.sortSession.findMany({
          where: { projectId: { in: otherProjectIds } },
          select: { id: true },
        });
        const otherSessionIds = otherSessions.map((s) => s.id);
        const otherGroups = await tx.sortGroup.findMany({
          where: { sortSessionId: { in: otherSessionIds } },
          select: { id: true },
        });
        const otherGroupIds = otherGroups.map((g) => g.id);
        const expectedOtherItemCount = await tx.sortGroupItem.count({ where: { groupId: { in: otherGroupIds } } });

        const bItems = await tx.sortGroupItem.deleteMany({ where: { groupId: { in: otherGroupIds } } });
        const bGroups = await tx.sortGroup.deleteMany({ where: { id: { in: otherGroupIds } } });
        const bSessions = await tx.sortSession.deleteMany({ where: { id: { in: otherSessionIds } } });
        const bStatements = await tx.statement.deleteMany({ where: { projectId: { in: otherProjectIds } } });
        const bProjects = await tx.project.deleteMany({ where: { id: { in: otherProjectIds } } });

        if (
          bItems.count !== expectedOtherItemCount ||
          bGroups.count !== otherGroups.length ||
          bSessions.count !== otherSessions.length ||
          bStatements.count !== otherStatementCount ||
          bProjects.count !== otherProjectCount
        ) {
          throw new Error("다른 프로젝트 삭제 개수 불일치 — 롤백됩니다.");
        }

        return {
          keepProjectSessionsDeleted: aSessions.count,
          keepProjectGroupsDeleted: aGroups.count,
          keepProjectItemsDeleted: aItems.count,
          otherProjectsDeleted: bProjects.count,
          otherStatementsDeleted: bStatements.count,
          otherSessionsDeleted: bSessions.count,
          otherGroupsDeleted: bGroups.count,
          otherItemsDeleted: bItems.count,
        };
      },
      { timeout: 30_000 }
    );

    console.log("\n삭제 완료:");
    console.log(JSON.stringify(result, null, 2));

    const final = await Promise.all([
      prisma.project.count(),
      prisma.statement.count(),
      prisma.sortSession.count(),
      prisma.sortGroup.count(),
      prisma.sortGroupItem.count(),
    ]);
    console.log("\n정리 후 실제 모델별 행 수:");
    console.log({ Project: final[0], Statement: final[1], SortSession: final[2], SortGroup: final[3], SortGroupItem: final[4] });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
