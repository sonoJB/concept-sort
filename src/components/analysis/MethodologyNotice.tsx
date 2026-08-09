const NOTICE_ITEMS = [
  "2차원 MDS가 대표 개념도입니다.",
  "3차원 결과는 보조자료입니다.",
  "Stress가 더 낮다는 이유만으로 3차원을 자동으로 최종 선택하지 않습니다.",
  "MDS 축의 방향·부호·회전·반사에는 본질적 의미가 없습니다.",
  "축의 의미는 연구자가 해석을 통해 부여합니다.",
  "Stress에 보편적인 절대 합격/불합격 절단점을 임의로 적용하지 않습니다.",
  "Ward 군집분석은 2차원 MDS 좌표의 Euclidean geometry를 기반으로 수행됩니다.",
  "계층적 군집분석(HCA)이 MDS 좌표를 생성한다고 표현하지 않습니다.",
];

export function MethodologyNotice() {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
      <p className="font-medium text-slate-600 mb-1">연구방법론 안내</p>
      <ul className="list-disc list-inside space-y-0.5">
        {NOTICE_ITEMS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
