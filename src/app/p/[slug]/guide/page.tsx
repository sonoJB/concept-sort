import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  computeGroupBounds,
  describeMaxGroupBreakdown,
  describeMinGroupBreakdown,
} from "@/lib/groupBounds";

export default async function GuidePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { _count: { select: { statements: true } } },
  });

  if (!project) notFound();

  const n = project._count.statements;
  const { maxCardsPerGroup, minGroups, maxGroups } = computeGroupBounds(n);
  const minBreakdown = describeMinGroupBreakdown(n, maxCardsPerGroup, minGroups);
  const maxBreakdown = describeMaxGroupBreakdown(n, maxGroups);

  return (
    <main className="flex-1 px-6 py-12">
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
