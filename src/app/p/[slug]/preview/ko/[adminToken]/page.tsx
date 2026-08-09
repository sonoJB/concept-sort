import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { computeLocaleContentStatus } from "@/lib/localeContentStatus";
import { PreviewClient } from "@/components/PreviewClient";

export default async function KoPreviewPage({
  params,
}: {
  params: Promise<{ slug: string; adminToken: string }>;
}) {
  const { slug, adminToken } = await params;

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { statements: { orderBy: { order: "asc" } } },
  });

  if (!project || project.adminToken !== adminToken) notFound();

  const status = computeLocaleContentStatus("ko", project, project.statements, {
    ignorePreviewConfirmation: true,
  });

  return (
    <PreviewClient
      slug={project.slug}
      adminToken={project.adminToken}
      locale="ko"
      status={status}
      boardProps={{
        slug: project.slug,
        title: project.title,
        prompt: project.prompt,
        consentKo: project.consentKo,
        legacyConsentFallbackEnabled: project.legacyConsentFallbackEnabled,
        titleJa: project.titleJa,
        promptJa: project.promptJa,
        consentJa: project.consentJa,
        statements: project.statements.map((s) => ({
          id: s.id,
          order: s.order,
          text: s.text,
          textJa: s.textJa,
          jaStatus: s.jaStatus,
        })),
      }}
    />
  );
}
