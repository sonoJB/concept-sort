import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

// Route modules import the `@/lib/db` singleton, which reads DATABASE_URL at
// construction time — set it BEFORE importing them (same pattern as the other
// route integration tests).
const dbFile = path.join(os.tmpdir(), `concept-sort-official-matrix-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
const route = await import("@/app/api/projects/[slug]/official-matrix/route");
const { readXlsx } = await import("@/lib/officialMatrix/readXlsx");

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    // best-effort
  }
});

const SLUG = "om-route";
const TOKEN = "token-om-route";
let ids: string[] = [];

async function addSession(countryCode: "KR" | "JP" | null, dataRole: "MAIN" | "PILOT", groups: number[][], createdAt?: Date) {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: SLUG } });
  await prisma.sortSession.create({
    data: {
      projectId: project.id,
      participantName: "PII_NAME_SHOULD_NEVER_LEAK",
      gender: "남자",
      age: 14,
      schoolLevel: "중학교",
      grade: "1학년",
      phoneNumber: "010-9999-8888",
      countryCode,
      dataRole,
      ...(createdAt ? { createdAt } : {}),
      groups: { create: groups.map((g) => ({ items: { create: g.map((i) => ({ statementId: ids[i] })) } })) },
    },
  });
}

async function seed() {
  const project = await prisma.project.create({ data: { slug: SLUG, adminToken: TOKEN, title: "테스트 연구", prompt: "p" } });
  ids = [];
  for (let i = 0; i < 4; i++) {
    const s = await prisma.statement.create({ data: { projectId: project.id, text: `ko-${i}`, textJa: `ja-${i}`, jaStatus: "APPROVED", order: i } });
    ids.push(s.id);
  }
  // MAIN: KR 3, JP 2 (different N). PILOT: KR 2, JP 1 with deliberately different structure. NULL-country MAIN: 1.
  await addSession("KR", "MAIN", [[0, 1], [2, 3]]);
  await addSession("KR", "MAIN", [[0, 1], [2, 3]]);
  await addSession("KR", "MAIN", [[0, 1, 2], [3]]);
  await addSession("JP", "MAIN", [[0, 2], [1, 3]]);
  await addSession("JP", "MAIN", [[0, 1], [2, 3]]);
  await addSession("KR", "PILOT", [[0, 3], [1, 2]]);
  await addSession("KR", "PILOT", [[0, 3], [1, 2]]);
  await addSession("JP", "PILOT", [[0, 3], [1, 2]]);
  await addSession(null, "MAIN", [[0, 1], [2, 3]]);
}

function req(query: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/projects/${SLUG}/official-matrix?${query}`, { headers });
}
const ctx = { params: Promise.resolve({ slug: SLUG }) };
const authed = { "x-admin-token": TOKEN };

async function summary(scope: string) {
  const res = await route.GET(req(`scope=${scope}&format=json`, authed), ctx);
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/projects/[slug]/official-matrix", () => {
  it("seeds", async () => {
    await seed();
  });

  it("requires admin authentication (no token / wrong token / wrong slug)", async () => {
    expect((await route.GET(req("scope=ALL"), ctx)).status).toBe(403);
    expect((await route.GET(req("scope=ALL", { "x-admin-token": "nope" }), ctx)).status).toBe(403);
    expect((await route.GET(req("scope=ALL&token=nope"), ctx)).status).toBe(403);
    const res = await route.GET(req("scope=ALL", authed), { params: Promise.resolve({ slug: "does-not-exist" }) });
    expect(res.status).toBe(404);
    // Auth failures must not leak any matrix bytes and must not be cacheable.
    const denied = await route.GET(req("scope=ALL"), ctx);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(denied.headers.get("Content-Type")).toContain("application/json");
  });

  it("accepts the token from the header or the query string", async () => {
    expect((await route.GET(req("scope=KR", authed), ctx)).status).toBe(200);
    expect((await route.GET(req(`scope=KR&token=${TOKEN}`), ctx)).status).toBe(200);
  });

  it("requires an explicit valid scope — never defaults", async () => {
    expect((await route.GET(req("", authed), ctx)).status).toBe(422);
    expect((await route.GET(req("scope=all", authed), ctx)).status).toBe(422);
    expect((await route.GET(req("scope=BOTH", authed), ctx)).status).toBe(422);
  });

  it("fails closed on any dataset other than MAIN, and on bad format/asOf", async () => {
    expect((await route.GET(req("scope=ALL&dataset=PILOT", authed), ctx)).status).toBe(422);
    expect((await route.GET(req("scope=ALL&dataset=ALL_WITH_PILOT", authed), ctx)).status).toBe(422);
    expect((await route.GET(req("scope=ALL&dataset=MAIN", authed), ctx)).status).toBe(200);
    expect((await route.GET(req("scope=ALL&format=csv", authed), ctx)).status).toBe(422);
    expect((await route.GET(req("scope=ALL&asOf=garbage", authed), ctx)).status).toBe(422);
  });

  it("each scope returns its own population; pilots and null-country never leak in", async () => {
    const all = await summary("ALL");
    const kr = await summary("KR");
    const jp = await summary("JP");
    expect(kr.nTotal).toBe(3);
    expect(jp.nTotal).toBe(2);
    expect(all.nTotal).toBe(5);
    expect(all.nTotal).toBe(kr.nTotal + jp.nTotal);
    expect(all.exclusionCounts.NOT_MAIN_ROLE).toBe(3); // 3 pilot sessions
    expect(all.exclusionCounts.NULL_COUNTRY).toBe(1);
    expect(all.dataset).toBe("MAIN");
    expect(all.sourceFingerprint).toBe(kr.sourceFingerprint);
    expect(all.sourceFingerprint).toBe(jp.sourceFingerprint);
  });

  it("downloads are independent of call order / previously requested scope", async () => {
    const orders = [["KR", "JP", "ALL"], ["ALL", "JP", "KR"], ["JP", "ALL", "KR"]];
    const seen: Record<string, number> = {};
    for (const order of orders) {
      for (const scope of order) {
        const res = await route.GET(req(`scope=${scope}`, authed), ctx);
        expect(res.status).toBe(200);
        expect(res.headers.get("X-Official-Matrix-Scope")).toBe(scope);
        const n = Number(res.headers.get("X-Official-Matrix-N"));
        if (scope in seen) expect(n).toBe(seen[scope]);
        seen[scope] = n;
      }
    }
    expect(seen).toEqual({ ALL: 5, KR: 3, JP: 2 });
  });

  it("xlsx download: correct type, UTF-8 file name, matrices match an independent recount", async () => {
    const res = await route.GET(req("scope=ALL", authed), ctx);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const cd = res.headers.get("Content-Disposition")!;
    expect(cd).toContain("attachment");
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1])).toMatch(/^본조사_유사성행렬_전체_KR-JP_\d{8}_\d{4}\.xlsx$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const sheets = readXlsx(new Uint8Array(await res.arrayBuffer()));
    const counts = sheets.find((s) => s.name === "빈도행렬")!.rows.slice(1).map((r) => r.slice(1));
    // Independent recount straight from the seeded MAIN/KR+JP sorts (pilots + null-country excluded).
    const mainSorts = [
      [[0, 1], [2, 3]], [[0, 1], [2, 3]], [[0, 1, 2], [3]], [[0, 2], [1, 3]], [[0, 1], [2, 3]],
    ];
    const expected = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (const sort of mainSorts) for (const g of sort) for (const a of g) for (const b of g) if (a !== b) expected[a][b]++;
    expect(counts).toEqual(expected);
    const props = sheets.find((s) => s.name === "비율행렬")!.rows.slice(1).map((r) => r.slice(1));
    expect(props[0][1]).toBeCloseTo(4 / 5, 12);
  });

  it("workbook never contains participant names, phone numbers or the admin token", async () => {
    for (const scope of ["ALL", "KR", "JP"]) {
      const res = await route.GET(req(`scope=${scope}`, authed), ctx);
      const text = JSON.stringify(readXlsx(new Uint8Array(await res.arrayBuffer())));
      for (const forbidden of ["PII_NAME_SHOULD_NEVER_LEAK", "010-9999-8888", TOKEN]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  it("a scope with zero eligible participants is flagged, not exported as a zero matrix", async () => {
    await prisma.sortSession.deleteMany({ where: { countryCode: "JP", dataRole: "MAIN" } });
    const jp = await summary("JP");
    expect(jp.nTotal).toBe(0);
    const res = await route.GET(req("scope=JP", authed), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Official-Matrix-N")).toBe("0");
    const sheets = readXlsx(new Uint8Array(await res.arrayBuffer()));
    expect(JSON.stringify(sheets.find((s) => s.name === "빈도행렬")!.rows)).toContain("대상 본조사 완료자 없음");
    // KR/ALL still work and now agree.
    expect((await summary("ALL")).nTotal).toBe(3);
  });

  it("asOf freezes the data cut-off so later submissions do not change the file", async () => {
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 15));
    await addSession("KR", "MAIN", [[0, 1], [2, 3]], new Date(Date.now() + 1000));
    const live = await (await route.GET(req("scope=KR&format=json", authed), ctx)).json();
    const frozen = await (await route.GET(req(`scope=KR&format=json&asOf=${encodeURIComponent(cutoff.toISOString())}`, authed), ctx)).json();
    expect(live.nTotal).toBe(frozen.nTotal + 1);
    expect(frozen.exclusionCounts.AFTER_AS_OF).toBe(1);
  });
});
