import fs from "node:fs";
import path from "node:path";
import { backupRootFromDatabaseUrl } from "@/lib/backupStatus";

/**
 * File-based write freeze for recovery work. Creating an empty file named
 * `MAINTENANCE` next to the database file (e.g. /data/MAINTENANCE) makes the
 * participant submission route refuse new submissions with 503 BEFORE it
 * touches the database. It needs no admin screen and no working database, so
 * it still works when the DB is damaged; removing the file reopens submissions.
 * It does nothing else: pages keep loading and no data is read or modified.
 */
export function maintenanceFlagPath(databaseUrl: string | undefined = process.env.DATABASE_URL): string | null {
  const root = backupRootFromDatabaseUrl(databaseUrl);
  return root ? path.join(path.dirname(root), "MAINTENANCE") : null;
}

export function isMaintenanceMode(databaseUrl: string | undefined = process.env.DATABASE_URL): boolean {
  const p = maintenanceFlagPath(databaseUrl);
  return p !== null && fs.existsSync(p);
}
