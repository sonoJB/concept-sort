import { prisma } from "@/lib/db";

/** Loads a project by slug and verifies the given admin token matches. */
export async function requireAdminProject(slug: string, adminToken: string | null) {
  const project = await prisma.project.findUnique({ where: { slug } });
  if (!project) return { error: "프로젝트를 찾을 수 없습니다.", status: 404 as const };
  if (!adminToken || adminToken !== project.adminToken) {
    return { error: "관리자 권한이 없습니다.", status: 403 as const };
  }
  return { project };
}
