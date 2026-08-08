import type { NextRequest } from "next/server";
import { requireAdminProject } from "@/lib/auth";

/**
 * Thin adapter for the /api/projects/[slug]/analysis/** namespace only:
 * extracts the admin token from `Authorization: Bearer <token>` and reuses
 * the existing requireAdminProject(slug, token) ownership check unchanged.
 * Never reads a query-string or body token — raw adminToken must never
 * appear in a URL for this namespace (Gate 1 FINAL §6).
 *
 * Status remapping is specific to this namespace's contract: a missing or
 * malformed Authorization header, or one that doesn't match the project's
 * token, is 401 here (legacy requireAdminProject returns 403 for the same
 * case — that legacy behavior is untouched).
 */
export async function requireAdminProjectFromRequest(request: NextRequest, slug: string) {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;

  const result = await requireAdminProject(slug, token || null);
  if ("error" in result) {
    if (result.status === 404) {
      return { error: "PROJECT_NOT_FOUND" as const, status: 404 as const };
    }
    return { error: "UNAUTHORIZED" as const, status: 401 as const };
  }
  return result;
}
