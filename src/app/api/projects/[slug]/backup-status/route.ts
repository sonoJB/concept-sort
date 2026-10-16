import { NextRequest, NextResponse } from "next/server";
import { requireAdminProject } from "@/lib/auth";
import { backupRootFromDatabaseUrl, readBackupStatus } from "@/lib/backupStatus";

/**
 * Admin-only, read-only: status and metadata of the automatic database
 * backups (see scripts/backup/auto-backup.mjs). It exposes no file contents
 * and offers no way to create, modify or delete a backup.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const adminToken = request.headers.get("x-admin-token") ?? request.nextUrl.searchParams.get("token");
  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status, headers: { "Cache-Control": "no-store" } });
  }
  const status = readBackupStatus(backupRootFromDatabaseUrl(process.env.DATABASE_URL));
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
