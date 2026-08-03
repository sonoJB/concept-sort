import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { AdminDashboard } from "@/components/AdminDashboard";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ slug: string; adminToken: string }>;
}) {
  const { slug, adminToken } = await params;

  const project = await prisma.project.findUnique({
    where: { slug },
    include: {
      statements: { orderBy: { order: "asc" } },
      _count: { select: { sortSessions: true } },
    },
  });

  if (!project || project.adminToken !== adminToken) notFound();

  return (
    <main className="flex-1">
      <AdminDashboard
        slug={project.slug}
        adminToken={project.adminToken}
        title={project.title}
        prompt={project.prompt}
        initialStatements={project.statements.map((s) => ({ id: s.id, text: s.text }))}
        initialSubmissionCount={project._count.sortSessions}
      />
    </main>
  );
}
