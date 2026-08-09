import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PrismaClient } from "@/generated/prisma/client";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
const MIGRATION_ORDER = [
  "20260803154453_init",
  "20260803180717_add_consent_and_demographics",
  "20260805233213_add_multilingual_project_support",
  "20260807144811_add_analysis_run_models",
  "20260807180000_scope_legacy_consent_fallback",
];

/**
 * Creates a brand-new, empty SQLite file and applies the full verified
 * migration chain (M1-M5) directly via node:sqlite — no production data,
 * no pristine/backup file involved. Returns a PrismaClient bound to it via
 * an explicit datasourceUrl override (no reliance on process.env timing).
 */
export function createDisposableDb(): { filePath: string; prisma: PrismaClient; cleanup: () => void } {
  const filePath = path.join(os.tmpdir(), `concept-sort-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const name of MIGRATION_ORDER) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8");
    db.exec(sql);
  }
  db.close();

  const prisma = new PrismaClient({ datasourceUrl: `file:${filePath}` });

  return {
    filePath,
    prisma,
    cleanup: () => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // best-effort cleanup only
      }
    },
  };
}

export async function seedProject(
  prisma: PrismaClient,
  opts: { slug: string; statementCount: number }
): Promise<{ projectId: string; statementIds: string[] }> {
  const project = await prisma.project.create({
    data: { slug: opts.slug, adminToken: `token-${opts.slug}`, title: "Test project" },
  });
  const statements = [];
  for (let i = 0; i < opts.statementCount; i++) {
    statements.push(await prisma.statement.create({ data: { projectId: project.id, text: `stmt-${i}`, order: i } }));
  }
  return { projectId: project.id, statementIds: statements.map((s) => s.id) };
}

export async function seedSession(
  prisma: PrismaClient,
  opts: { projectId: string; countryCode: "KR" | "JP" | null; groups: string[][] }
) {
  return prisma.sortSession.create({
    data: {
      projectId: opts.projectId,
      participantName: "synthetic",
      gender: "unspecified",
      age: 20,
      schoolLevel: "unspecified",
      grade: "unspecified",
      phoneNumber: "000-0000-0000",
      countryCode: opts.countryCode,
      groups: {
        create: opts.groups.map((g) => ({ items: { create: g.map((statementId) => ({ statementId })) } })),
      },
    },
  });
}
