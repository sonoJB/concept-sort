import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  computeGuideTemplateVariables,
  defaultGuideTemplateFor,
  renderGuideTemplate,
} from "@/lib/guideTemplate";
import { getStudyGuidePageOverride } from "@/lib/studyWebAppText";

const DEFAULT_TITLE = { ko: "[유사성 분류 방법 - 세부 지침]", ja: "［類似性分類の方法－詳細ガイドライン］" };

export default async function GuidePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { slug } = await params;
  const { lang } = await searchParams;
  const locale = lang === "ja" ? "ja" : "ko";

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { _count: { select: { statements: true } } },
  });

  if (!project) notFound();

  const cardCount = project._count.statements;
  const storedTemplate = locale === "ko" ? project.guideTemplateKo : project.guideTemplateJa;
  const template =
    storedTemplate && storedTemplate.trim().length > 0 ? storedTemplate : defaultGuideTemplateFor(locale);
  const variables = computeGuideTemplateVariables(cardCount, locale);
  const { rendered } = renderGuideTemplate(template, variables);
  const lines = rendered.split("\n");

  const title = getStudyGuidePageOverride(slug, locale)?.title ?? DEFAULT_TITLE[locale];

  return (
    <main lang={locale} className="flex-1 px-6 py-12">
      <div className="max-w-2xl mx-auto space-y-4">
        <h1 className="text-xl font-bold">{title}</h1>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700 leading-relaxed space-y-2">
          {lines.map((line, i) => (
            <p key={i} className={i === 0 ? "font-medium" : undefined}>
              {line}
            </p>
          ))}
        </div>
      </div>
    </main>
  );
}
