import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex-1 flex items-center justify-center px-6 py-16">
      <div className="max-w-xl w-full text-center space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">
          유사성 분류 · 개념도 연구 도구
        </h1>
        <p className="text-slate-600 leading-relaxed">
          진술문(카드)을 등록하고 참가자에게 링크를 공유하면, 참가자들이 비슷한
          카드끼리 그룹으로 묶는 카드 소팅을 수행합니다. 결과는 유사도 행렬과
          다차원척도법(MDS)·군집분석을 거쳐 개념도로 시각화됩니다.
        </p>
        <Link
          href="/projects/new"
          className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors"
        >
          새 프로젝트 만들기
        </Link>
      </div>
    </main>
  );
}
