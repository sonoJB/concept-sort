import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { AdminDashboard } from "@/components/AdminDashboard";

export default async function AdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; adminToken: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug, adminToken } = await params;
  const { tab } = await searchParams;
  const initialTab = tab === "ja" || tab === "readiness" ? tab : "ko";

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
        titleJa={project.titleJa}
        promptJa={project.promptJa}
        consentKo={project.consentKo}
        consentJa={project.consentJa}
        koreanEnabled={project.koreanEnabled}
        japaneseEnabled={project.japaneseEnabled}
        legacyConsentFallbackEnabled={project.legacyConsentFallbackEnabled}
        koPreviewConfirmedAt={project.koPreviewConfirmedAt?.toISOString() ?? null}
        jaPreviewConfirmedAt={project.jaPreviewConfirmedAt?.toISOString() ?? null}
        initialStatements={project.statements.map((s) => ({
          id: s.id,
          text: s.text,
          order: s.order,
          textJa: s.textJa,
          jaStatus: s.jaStatus,
        }))}
        initialSubmissionCount={project._count.sortSessions}
        initialTab={initialTab}
      />
    </main>
  );
}
