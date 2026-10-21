import { NextRequest, NextResponse } from "next/server";
import { requireAdminProject } from "@/lib/auth";
import { backupRootFromDatabaseUrl } from "@/lib/backupStatus";
import { RAW_TABLES, backupDbFile, compareFingerprints, fingerprintTables, liveDbFileFromDatabaseUrl } from "@/lib/rawIntegrity";

/**
 * Admin-only, READ-ONLY. Compares the participant-response tables of a server-side backup with the live database (or with
 * another backup, `?against=<dir>`) at row and column level and returns only counts and hashes — no row, name, phone number
 * or session id. It opens every database read-only and writes nothing.
 *
 *   GET /api/projects/<slug>/raw-integrity?backup=<backup folder name>[&against=<backup folder name>]
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const adminToken = request.headers.get("x-admin-token") ?? request.nextUrl.searchParams.get("token");
  const check = await requireAdminProject(slug, adminToken);
  const headers = { "Cache-Control": "no-store" };
  if ("error" in check) return NextResponse.json({ error: check.error }, { status: check.status, headers });

  const root = backupRootFromDatabaseUrl(process.env.DATABASE_URL);
  if (!root) return NextResponse.json({ errorCode: "BACKUP_ROOT_UNAVAILABLE" }, { status: 409, headers });
  const dirA = request.nextUrl.searchParams.get("backup") ?? "";
  const dirB = request.nextUrl.searchParams.get("against");
  const fileA = backupDbFile(root, dirA);
  if (!fileA) return NextResponse.json({ errorCode: "BACKUP_NOT_FOUND" }, { status: 404, headers });
  const fileB = dirB ? backupDbFile(root, dirB) : liveDbFileFromDatabaseUrl(process.env.DATABASE_URL);
  if (!fileB) return NextResponse.json({ errorCode: dirB ? "AGAINST_NOT_FOUND" : "LIVE_DB_UNAVAILABLE" }, { status: 404, headers });

  // node:sqlite ships with Node (22.13+) but has no bundled typings here; the specifier is built at run time so the bundler leaves it alone
  type SqliteDb = { prepare(sql: string): { all(): unknown[] }; close(): void };
  const { DatabaseSync } = (await import(/* webpackIgnore: true */ "node:" + "sqlite")) as unknown as { DatabaseSync: new (file: string, opts: { readOnly: boolean }) => SqliteDb };
  const a = new DatabaseSync(fileA, { readOnly: true });
  const b = new DatabaseSync(fileB, { readOnly: true });
  try {
    const fa = fingerprintTables(a);
    const fb = fingerprintTables(b);
    const tables = RAW_TABLES.map((t) => compareFingerprints(t, fa[t], fb[t]));
    const integrityA = (a.prepare("pragma integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check).join(",");
    return NextResponse.json(
      {
        checkedAt: new Date().toISOString(),
        backup: dirA,
        against: dirB ?? "live",
        backupIntegrityCheck: integrityA,
        allIdentical: tables.every((t) => t.identical),
        tables,
        // hashes of the first side, so the same value can be recomputed from an independent copy of the same data
        tableSha256: Object.fromEntries(RAW_TABLES.map((t) => [t, fa[t]?.tableSha256 ?? null])),
      },
      { headers }
    );
  } finally {
    a.close();
    b.close();
  }
}
