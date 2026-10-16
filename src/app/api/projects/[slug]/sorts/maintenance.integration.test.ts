import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

// Own temp DIRECTORY so the MAINTENANCE flag file (next to the DB file) cannot collide with other tests.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-maint-"));
const dbFile = path.join(dir, "prod.db");
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
{
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((n) => /^\d/.test(n)).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8"));
  }
  db.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;

const { prisma } = await import("@/lib/db");
const route = await import("@/app/api/projects/[slug]/sorts/route");

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("participant submission write-freeze (MAINTENANCE file)", () => {
  it("returns 503 before touching the database while the flag exists; submissions work again once it is removed", async () => {
    const project = await prisma.project.create({
      data: {
        slug: "maint",
        adminToken: "t",
        title: "t",
        prompt: "p",
        consentKo: "동의",
        titleJa: "t",
        promptJa: "p",
        koreanEnabled: false,
        japaneseEnabled: false,
      },
    });
    const call = async () =>
      route.POST(
        new NextRequest("http://localhost/api/projects/maint/sorts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ consentAgreed: true, countryCode: "KR", gender: "남자", age: 14, schoolLevel: "중학교", grade: "1학년", phoneNumber: "010-0000-0000", groups: [] }),
        }),
        { params: Promise.resolve({ slug: "maint" }) }
      );

    // normal behaviour first: reaches the normal validation path (not 503)
    expect((await call()).status).not.toBe(503);

    fs.writeFileSync(path.join(dir, "MAINTENANCE"), "");
    const frozen = await call();
    expect(frozen.status).toBe(503);
    expect((await frozen.json()).errorCode).toBe("COUNTRY_NOT_AVAILABLE");
    expect(await prisma.sortSession.count({ where: { projectId: project.id } })).toBe(0);

    fs.rmSync(path.join(dir, "MAINTENANCE"));
    expect((await call()).status).not.toBe(503);
  });
});
