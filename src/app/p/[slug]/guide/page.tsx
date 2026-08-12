import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  computeGroupBounds,
  describeMaxGroupBreakdown,
  describeMaxGroupBreakdownJa,
  describeMinGroupBreakdown,
  describeMinGroupBreakdownJa,
} from "@/lib/groupBounds";
import { getStudyGuidePageOverride } from "@/lib/studyWebAppText";

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

  const n = project._count.statements;
  const { maxCardsPerGroup, minGroups, maxGroups } = computeGroupBounds(n);

  const override = getStudyGuidePageOverride(slug, locale);
  if (override) {
    return (
      <main lang={locale} className="flex-1 px-6 py-12">
        <div className="max-w-2xl mx-auto space-y-4">
          <h1 className="text-xl font-bold">{override.title}</h1>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700 leading-relaxed space-y-2">
            <p className="font-medium">{override.intro}</p>
            <p>{override.rule1}</p>
            <p>{override.rule2}</p>
            <p>{override.rule3}</p>
            <p>{override.rule4}</p>
            <p>{override.rule5}</p>
            <p>
              - {override.minBundleLine}
              <br />- {override.maxBundleLine}
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (locale === "ja") {
    const minBreakdown = describeMinGroupBreakdownJa(n, maxCardsPerGroup, minGroups);
    const maxBreakdown = describeMaxGroupBreakdownJa(n, maxGroups);
    return (
      <main lang="ja" className="flex-1 px-6 py-12">
        <div className="max-w-2xl mx-auto space-y-4">
          <h1 className="text-xl font-bold">［類似性分類の方法］</h1>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700 leading-relaxed space-y-2">
            <p className="font-medium">
              ※ 類似性分類を行う際は、次の5つのルールを必ず守ってください。
            </p>
            <p>① 1つのグループは、必ず2枚以上のカードで構成してください。</p>
            <p>
              ② すべてのカードを1つのグループにまとめることはできません。（全{n}
              枚のカードを1つのグループにすることはできません。）
            </p>
            <p>
              ③ 1つのグループに{maxCardsPerGroup + 1}枚以上のカードを入れることはできません。
              全カードの3分の1以上が1つのグループに含まれることを防ぐためです。
            </p>
            <p>
              ④ 残ったカードに共通点がない場合でも、それらをすべて「その他」という1つの
              グループにまとめることはできません。お手数ですが、カード同士の類似性を改めて
              確認し、別のテーマ（グループ名）を考えてください。類似性のあるカード同士でグ
              ループを作ってください。
            </p>
            <p>
              ⑤ 分類されないカード（記述文）がないようにしてください。全{n}
              枚のカードを、必ずいずれか1つのグループに含めてください。
            </p>
            <p>
              - 最少：{minGroups}グループ（{minBreakdown}）<br />- 最多：{maxGroups}
              グループ（{maxBreakdown}）
            </p>
          </div>
        </div>
      </main>
    );
  }

  const minBreakdown = describeMinGroupBreakdown(n, maxCardsPerGroup, minGroups);
  const maxBreakdown = describeMaxGroupBreakdown(n, maxGroups);

  return (
    <main lang="ko" className="flex-1 px-6 py-12">
      <div className="max-w-2xl mx-auto space-y-4">
        <h1 className="text-xl font-bold">[유사성 분류 방법 안내문]</h1>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700 leading-relaxed space-y-2">
          <p className="font-medium">
            ※ 유사성 분류 작업 시, 다음의 5가지 지침을 반드시 준수해 주십시오.
          </p>
          <p>
            ① 하나의 묶음은 반드시 2장 이상의 카드로 구성되어야 합니다.
          </p>
          <p>
            ② 모든 카드를 하나의 묶음으로 만들 수는 없습니다. (전체 카드 {n}
            장을 하나의 묶음으로 불가)
          </p>
          <p>
            ③ 하나의 묶음에는 {maxCardsPerGroup + 1}장 이상의 카드가 포함될
            수 없습니다. 전체 카드의 1/3 이상이 포함된 묶음이 만들어지지
            않기 위함입니다.
          </p>
          <p>
            ④ 남는 카드 간 유사성(공통점)이 없을 때, &lt;기타&gt;라는
            묶음으로 몽땅 묶일 수 없습니다. 번거로우시겠지만 다른 주제(묶음
            제목)를 생각해 보셔야 합니다. (유사성이 있는 카드끼리만 묶음을
            만들 수 있습니다.)
          </p>
          <p>
            ⑤ 누락되는 카드(진술문)가 없도록 유의해 주세요. ({n}장의 모든
            카드는 하나 이상의 묶음에 포함되어야 합니다.)
          </p>
          <p>
            - 최소: {minGroups}개 묶음({minBreakdown})<br />- 최대: {maxGroups}
            개 묶음({maxBreakdown})
          </p>
        </div>
      </div>
    </main>
  );
}
