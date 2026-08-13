import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { SortBoard } from "@/components/SortBoard";
import { computeLocaleContentStatus } from "@/lib/localeContentStatus";

export default async function SortPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { statements: { orderBy: { order: "asc" } } },
  });

  if (!project) notFound();

  // Participant access never trusts the enabled Booleans alone — readiness
  // is re-checked here on every load, same as the submit API re-checks it
  // server-side. Neither internal missing-content details nor statement
  // numbers are exposed to the (unauthenticated) participant beyond this.
  const koStatus = computeLocaleContentStatus("ko", project, project.statements);
  const jaStatus = computeLocaleContentStatus("ja", project, project.statements);
  const koreanAvailable = project.koreanEnabled && koStatus.ready;
  const japaneseAvailable = project.japaneseEnabled && jaStatus.ready;

  if (!koreanAvailable && !japaneseAvailable) {
    return (
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="max-w-md text-center space-y-2 py-24">
          <p className="text-lg font-medium">현재 참여 자료를 준비 중입니다.</p>
          <p className="text-lg font-medium">現在、参加資料を準備しています。</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1">
      <SortBoard
        slug={project.slug}
        title={project.title}
        prompt={project.prompt}
        consentKo={project.consentKo}
        legacyConsentFallbackEnabled={project.legacyConsentFallbackEnabled}
        titleJa={project.titleJa}
        promptJa={project.promptJa}
        consentJa={project.consentJa}
        koreanAvailable={koreanAvailable}
        japaneseAvailable={japaneseAvailable}
        guideVideoUrlKo={project.guideVideoUrlKo}
        guideVideoUrlJa={project.guideVideoUrlJa}
        statements={project.statements.map((s) => ({
          id: s.id,
          order: s.order,
          text: s.text,
          textJa: s.textJa,
          jaStatus: s.jaStatus,
        }))}
      />
    </main>
  );
}
