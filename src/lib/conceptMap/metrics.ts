/**
 * Per-metric disclosure: definition / formula / actual value / reference value(s) / verdict / source / limits.
 *
 * Four different kinds of "reference" are kept strictly apart and labelled as such, never merged into one
 * "good" verdict:
 *   computation_setting          a setting chosen for THIS computation (e.g. tolerance) — not a literature cutoff
 *   definitional_range           the range the quantity can take by definition — never a quality criterion
 *   general_rule_of_thumb        a general MDS verbal scale (Kruskal), quoted with the authors' own caveats — shown as
 *                               background information, NEVER used to classify a result as adequate / inadequate
 *   empirical_comparison_range   values reported by earlier concept-mapping studies — a comparison range only
 *   good_fit_criterion_unconfirmed  no cutoff could be verified at an original source -> no verdict is issued
 *   interpretation_principle     how a group of metrics is to be read (what is evaluated, what is not claimed)
 *
 * Interpretation text is versioned separately from the analysis engine: the numbers in a stored result bundle never
 * change, while this text can be improved. `INTERPRETATION_TEXT_VERSION` identifies the wording; the metric records
 * of an old bundle are re-evaluated from its stored numbers (see bundleView.ts) so the screen, the report and the
 * ZIP always carry the same, current wording.
 */
import type { ScopeAnalysis, DimensionAnalysis } from "./analyze";
import type { ReferenceKey } from "./references";

export const INTERPRETATION_TEXT_VERSION = "interpretation-2";

export type CriterionKind = "computation_setting" | "definitional_range" | "general_rule_of_thumb" | "empirical_comparison_range" | "good_fit_criterion_unconfirmed" | "interpretation_principle";

export type Criterion = { kind: CriterionKind; labelKo: string; text: string; sourceKeys: ReferenceKey[]; location?: string };

export type Tone = "met" | "unfavorable" | "neutral" | "unconfirmed";

/** What a metric evaluates. Convergence, fit, classification stability and content validity are separate questions. */
export type EvaluationObject = "수렴" | "2차원 표현의 적합도" | "군집 구조" | "분류 안정성" | "자료 검증" | "해석 안내";

export type MetricRecord = {
  id: string;
  group: "convergence" | "fit" | "cluster" | "reliability" | "data";
  /** what this metric evaluates (added with interpretation-2; absent in text stored by the first release) */
  evaluates?: EvaluationObject;
  nameKo: string;
  definitionKo: string;
  formula: string;
  value: number | string | null;
  valueDisplay: string;
  criteria: Criterion[];
  verdicts: { aspectKo: string; textKo: string; tone: Tone }[];
  sourceKeys: ReferenceKey[];
  limitsKo: string[];
  /** optional detail table (header + rows) rendered under the metric */
  table?: { header: string[]; rows: (string | number)[][] };
};

const f = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? "계산 불가" : v.toFixed(d));
const e = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "계산 불가" : v.toExponential(2));

export const KRUSKAL_SCALE: { max: number; label: string }[] = [
  { max: 0.025, label: "excellent" },
  { max: 0.05, label: "good" },
  { max: 0.1, label: "fair" },
  { max: 0.2, label: "poor" },
];

/**
 * Stress values of earlier concept-mapping studies as attributed to Rosas & Kane (2012, §3.5): 69 studies, mean 0.28,
 * SD 0.04, observed range 0.17–0.34. NOT verified against the original article (access was blocked): the mean and the
 * range are attributed to it by two secondary papers that were read, the SD only by the researcher's instruction. It is
 * a comparison reference, never a pass/fail criterion.
 */
export const CONCEPT_MAPPING_STRESS_REFERENCE = { studies: 69, mean: 0.28, sd: 0.04, low: 0.17, high: 0.34 } as const;

/** Where a Stress value lies relative to that reference. Descriptive only — no tone, no adequacy verdict. */
export function stressComparisonText(s: number): string {
  const { low, high, mean } = CONCEPT_MAPPING_STRESS_REFERENCE;
  const diff = s - mean;
  const rel = `보고된 평균 ${mean.toFixed(2)}보다 ${diff >= 0 ? "높음" : "낮음"}(차이 ${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(4)})`;
  if (s < low) return `선행 개념도 연구의 관찰 범위(${low.toFixed(2)}–${high.toFixed(2)})의 하한보다 낮음; ${rel}.`;
  if (s > high) return `선행 개념도 연구의 관찰 범위(${low.toFixed(2)}–${high.toFixed(2)})의 상한보다 높음; ${rel}. 범위 밖이라는 사실만으로 부적합을 뜻하지는 않으나 잔차 진단·안정성·내용 해석을 더 면밀히 검토해야 함.`;
  return `선행 개념도 연구의 관찰 범위(${low.toFixed(2)}–${high.toFixed(2)}) 안; ${rel}.`;
}

const FIT_PRINCIPLE =
  "Stress는 참여자의 분류 관계와 2차원 지도 사이의 불일치를 나타내며 낮을수록 좋습니다. 일반 MDS의 고정 임계값만으로 개념도 연구의 적합 여부를 판정하지 않습니다. 선행 개념도 연구의 분포, 잔차 진단, 안정성 및 내용 해석을 함께 검토해야 합니다.";

export function evaluateMetrics(a: ScopeAnalysis, recommendedK: number | null): MetricRecord[] {
  const p: DimensionAnalysis = a.primary;
  const out: MetricRecord[] = [];
  const sel = p.selected;
  const eps = a.settings.mds.eps;
  const strictEps = a.settings.mds.strictEps;

  // 1. numeric convergence ------------------------------------------------------------------
  out.push({
    id: "numeric_convergence",
    group: "convergence",
    evaluates: "수렴",
    nameKo: "수치적 수렴 (2차원 SMACOF)",
    definitionKo:
      "majorization 반복에서 직전 반복 대비 raw stress의 상대적 감소량이 허용오차 이하가 되었는지. 분모는 직전 반복의 raw stress이며, 목적함수(raw stress)는 이론상 단조 비증가이므로 증가가 관측되면 별도 종료 사유(OBJECTIVE_INCREASED)로 구분한다.",
    formula: "변화량_k = (σ_{k−1} − σ_k) / σ_{k−1},  σ = Σ_{i<j}(d̂_ij − d_ij)²;  수렴: 변화량_k ≤ ε",
    value: sel ? sel.strict.finalRelativeChange : null,
    valueDisplay: sel
      ? `주 실행 ${sel.main.reason}(${sel.main.iterations}회, 최종 변화량 ${e(sel.main.finalRelativeChange)}, ε=${eps}) → 엄격 계속 ${sel.strict.reason}(${sel.strict.iterations}회 추가, 최종 변화량 ${e(sel.strict.finalRelativeChange)}, ε=${strictEps})`
      : "선택된 해 없음",
    criteria: [
      { kind: "computation_setting", labelKo: "이번 계산의 설정값", text: `시작 ${a.settings.mds.nInit}회, 시작당 최대 ${a.settings.mds.maxIter}회 반복, 허용오차 ε=${eps}, 선택한 해의 엄격 재검증 ε=${strictEps}. 이 값들은 이 작업의 계산 설정이며 문헌의 적합도 합격선이 아님`, sourceKeys: ["mair2022", "sklearn18"] },
    ],
    verdicts: [
      {
        aspectKo: "계산 수렴",
        textKo: p.numericallyConverged
          ? `수렴함: 선택한 해가 ε=${eps}에서 수렴했고, 같은 해에서 ε=${strictEps}로 계속해도 수렴함(목적함수 증가 최대치 ${e(sel?.strict.maxRelativeIncrease)})`
          : `수렴하지 못함 (${sel ? `${sel.main.reason} / ${sel.strict.reason}` : p.errorCode ?? "NO_RESULT"})`,
        tone: p.numericallyConverged ? "met" : "unfavorable",
      },
      {
        aspectKo: "전역 최적 여부",
        textKo: `${p.convergedStarts}/${p.startCount}개 시작이 수렴했고 최저 raw stress의 1e-6 이내에 도달한 시작은 ${p.startsWithinRelTol1e6OfBest}개. 여러 시작 중 최저 해를 고른 것이며 전역 최적임을 증명하지 않음`,
        tone: "neutral",
      },
    ],
    sourceKeys: ["mair2022", "sklearn18"],
    limitsKo: ["수렴은 국소 최소에 도달했다는 수치적 사실일 뿐 2차원 표현이 자료에 적합하다는 뜻이 아님.", "시작 수·반복 상한·허용오차는 이 작업의 계산 설정임."],
  });

  // 1b. how to read the fit metrics (what is evaluated, what is not claimed) ------------------------------------
  {
    const s1v = p.stress1;
    out.push({
      id: "fit_interpretation",
      group: "fit",
      evaluates: "해석 안내",
      nameKo: "2차원 표현의 적합도 해석",
      definitionKo: FIT_PRINCIPLE,
      formula: "평가 대상은 서로 다른 네 가지: ① 수치적 수렴(알고리즘이 국소 최소에 도달했는가) ② 2차원 표현의 적합도(Stress-1·raw stress·RSQ·잔차) ③ 분류 안정성(반복 분할 신뢰도) ④ 내용 타당성(군집 구성·명칭이 문항 내용과 맞는가)",
      value: null,
      valueDisplay: `Stress-1 ${f(s1v, 4)} · RSQ ${f(p.rsq, 4)} · ${p.numericallyConverged ? "수치적 수렴함" : "수치적 수렴하지 못함"}${s1v !== null ? ` · ${stressComparisonText(s1v)}` : ""}`,
      criteria: [
        {
          kind: "interpretation_principle",
          labelKo: "고정 임계값을 판정에 쓰지 않는 이유",
          text: "Kruskal(1964)의 구술 척도(20% poor, 10% fair, 5% good, 2.5% excellent, 0% perfect)는 실험·합성 자료의 경험에서 나온 것인데 이후 기계적으로 적용되어 왔고, Stress가 문항 수 n에 의존(n이 클수록 값이 커짐)하는 등의 이유로 문제가 있음. 이 시스템은 Stress > 0.20이라는 사실만으로 개념도 분석을 실패·부적합으로 분류하지 않음.",
          sourceKeys: ["mair2022", "mair2016", "kruskal1964"],
          location: "Mair et al. (2022) §3.2 Stress norms and permutation tests; Mair et al. (2016)",
        },
        {
          kind: "empirical_comparison_range",
          labelKo: "선행 개념도 연구의 분포(비교 참고)",
          text: `69개 개념도 연구의 Stress: 평균 ${CONCEPT_MAPPING_STRESS_REFERENCE.mean.toFixed(2)}, 표준편차 ${CONCEPT_MAPPING_STRESS_REFERENCE.sd.toFixed(2)}, 관찰 범위 ${CONCEPT_MAPPING_STRESS_REFERENCE.low.toFixed(2)}–${CONCEPT_MAPPING_STRESS_REFERENCE.high.toFixed(2)}(Rosas & Kane, 2012, §3.5에 귀속). 관찰된 범위일 뿐 보편적인 합격 기준이 아님. ※ 원문 직접 대조 불가(접근 차단): 평균과 범위는 2차 문헌(Rocliffe et al., 2023)이 같은 논문에 귀속하며 표준편차는 연구자 제공값이다(한 2차 문헌은 연구 수를 68편으로 적음). 0.205–0.365(평균 0.285)는 별개의 비교 범위로, 일부 2차 문헌은 이를 Kane & Trochim(2007)이 인용한 Trochim의 미발표 1993년 문헌 검토에서 나온 것으로 설명하고(검색 발췌 수준에서만 확인, 전문 미열람), Henderikx & Stoffers(2023)는 Rosas & Kane(2012)의 인용으로 제시한다. 두 범위는 서로 다른 자료·관찰 범위일 수 있어 모순이나 오류로 판단하지 않으며, 출처 귀속은 원문 확인이 필요하다.`,
          sourceKeys: ["rosas2012", "rocliffe2023", "henderikx2023"],
          location: "Rosas & Kane (2012) §3.5 (원문 미대조); Rocliffe et al. (2023) Results > Sorting/cluster map",
        },
        {
          kind: "interpretation_principle",
          labelKo: "선행 연구와 현재 엔진의 비교 가능성",
          text: "확인된 것: 이 엔진의 Stress-1은 Kruskal(1964) 정의 Σ(d̂*−d)²/Σd²의 제곱근(디스패리티 크기 최적화), 동점 처리 secondary, 서열 비계량 SMACOF. 미확인: 선행 개념도 연구들이 쓴 소프트웨어의 Stress 산식·정규화·동점 처리·문항 수·참여자 수가 같은지(원문에 명시되지 않거나 열람하지 못함). 따라서 숫자 비교는 동일 정의 비교가 아닐 수 있는 참고용임.",
          sourceKeys: ["mair2022", "henderikx2023"],
        },
      ],
      verdicts: [
        { aspectKo: "수렴", textKo: p.numericallyConverged ? "수치적으로 수렴함(적합도와 별개의 사실)" : "수치적으로 수렴하지 못함", tone: p.numericallyConverged ? "met" : "unfavorable" },
        { aspectKo: "2차원 표현의 적합도", textKo: s1v === null ? "계산 불가" : `선행 연구 분포 대비 위치(비교 참고, 판정 아님): ${stressComparisonText(s1v)}`, tone: "neutral" },
        { aspectKo: "분류 안정성", textKo: "반복 분할 신뢰도를 별도로 보고함(양호 기준 미확정, 아래 지표 참조)", tone: "unconfirmed" },
        { aspectKo: "내용 타당성", textKo: "이 시스템은 판정하지 않음 — 군집 수·명칭은 연구자 검토 전 추천안이며 문항 내용과의 대응은 연구자 검토 대상", tone: "unconfirmed" },
      ],
      sourceKeys: ["mair2022", "mair2016", "kruskal1964", "rosas2012", "rocliffe2023", "henderikx2023"],
      limitsKo: [
        "‘매우 적합’·‘타당성 입증’ 같은 판정을 하지 않음. 수치가 선행 연구의 관찰 범위 안이라는 사실은 지도의 타당성을 입증하지 않음.",
        "Mair 등(2022)이 소개한 무작위 자료 Stress 규준(randomstress)·순열 검정은 이번에 수행하지 않았음.",
      ],
    });
  }

  // 2. raw stress ----------------------------------------------------------------------------
  out.push({
    id: "raw_stress",
    group: "fit",
    evaluates: "2차원 표현의 적합도",
    nameKo: "Raw stress (정규화된 디스패리티 기준)",
    definitionKo: "정규화된 디스패리티와 배치 거리의 제곱 오차합. 디스패리티는 Σd̂² = n(n−1)/2가 되도록 정규화(smacof의 명시적 정규화).",
    formula: "σ_raw = Σ_{i<j} (d̂_ij − d_ij)²,  Σ_{i<j} d̂_ij² = n(n−1)/2",
    value: p.rawStress,
    valueDisplay: f(p.rawStress, 5),
    criteria: [{ kind: "definitional_range", labelKo: "정의상 범위", text: "0 이상; 값의 크기는 정규화 방식과 문항 수에 따라 달라져 단독 비교 기준이 없음", sourceKeys: ["mair2022"], location: "p. 4, 식 (2)" }],
    verdicts: [{ aspectKo: "판정", textKo: "참고 값 (적합도 판정 기준 없음)", tone: "unconfirmed" }],
    sourceKeys: ["mair2022"],
    limitsKo: ["scikit-learn 등 다른 구현은 정규화가 달라 같은 자료에서도 raw stress가 다르게 보고될 수 있음."],
  });

  // 3. Stress-1 ------------------------------------------------------------------------------
  const s1 = p.stress1;
  out.push({
    id: "stress1",
    group: "fit",
    evaluates: "2차원 표현의 적합도",
    nameKo: "Stress-1 (Kruskal)",
    definitionKo:
      "참여자의 분류 관계(비유사성 δ)와 2차원 지도의 거리 사이의 불일치 정도(낮을수록 좋음). Kruskal(1964)의 암묵적 정규화 Stress로, 디스패리티는 거리에 대한 단조 회귀값(크기 제약 없음)이며 분모는 배치 거리의 제곱합. 국소 최소에서 √(σ_raw / (n(n−1)/2))와 같으므로 이 분석은 두 식의 일치를 계산으로 확인한다.",
    formula: "σ₁ = √( Σ_{i<j}(d̂*_ij − d_ij)² / Σ_{i<j} d_ij² ),  d̂* = 단조회귀(d | δ)",
    value: s1,
    valueDisplay: `${f(s1, 5)}  (√(σ_raw/q) = ${f(p.stressNormalizedSqrt, 5)})`,
    criteria: [
      { kind: "definitional_range", labelKo: "정의상 범위", text: "0 이상, 0이면 완전 일치, 낮을수록 좋음. 값의 크기는 문항 수·동점·자료 오차·분석 조건에 의존하므로 단독 합격선이 없음", sourceKeys: ["mair2022", "mair2016"], location: "Mair et al. (2022) §3.2; Mair et al. (2016)" },
      {
        kind: "empirical_comparison_range",
        labelKo: "선행 개념도 연구의 분포(비교 참고)",
        text: `평균 ${CONCEPT_MAPPING_STRESS_REFERENCE.mean.toFixed(2)}, 표준편차 ${CONCEPT_MAPPING_STRESS_REFERENCE.sd.toFixed(2)}, 관찰 범위 ${CONCEPT_MAPPING_STRESS_REFERENCE.low.toFixed(2)}–${CONCEPT_MAPPING_STRESS_REFERENCE.high.toFixed(2)}(69개 연구; Rosas & Kane, 2012, §3.5에 귀속, 원문 미대조). 관찰 범위이며 보편적 합격 기준이 아님. Trochim 외(1994)는 최종 Stress .31을 보고했으나 정의와 허용 기준은 서술하지 않음`,
        sourceKeys: ["rosas2012", "rocliffe2023", "henderikx2023", "trochim1994"],
        location: "Rosas & Kane (2012) §3.5 (미대조); Trochim et al. (1994) Results(MDS)",
      },
      {
        kind: "general_rule_of_thumb",
        labelKo: "일반 MDS 구술 척도(방법론 참고 정보 · 판정에 사용하지 않음)",
        text: "Kruskal(1964): 20% poor, 10% fair, 5% good, 2.5% excellent, 0% perfect — 실험·합성 자료의 경험에서 나온 구술 평가. Mair 등(2022)은 이 경험칙이 기계적으로 적용되어 왔고 Stress가 n에 의존하는 등의 이유로 문제라고 지적하며 Mair 등(2016)도 자료 오차·동점·결측의 영향을 들어 이 경험칙만으로 판단하지 말 것을 권고함. 이 시스템은 이 척도로 결과를 분류하지 않음.",
        sourceKeys: ["kruskal1964", "mair2016", "mair2022"],
        location: "Mair et al. (2022) §3.2; Mair et al. (2016) 원고 pp. 3, 8–9",
      },
    ],
    verdicts: [
      { aspectKo: "선행 개념도 연구 분포와의 위치(비교 참고)", textKo: s1 === null ? "계산 불가" : stressComparisonText(s1), tone: "neutral" },
      { aspectKo: "일반 MDS 고정 임계값", textKo: "고정 임계값만으로 적합 여부를 판정하지 않음(Mair et al., 2022, §3.2). 잔차 진단·안정성·내용 해석을 함께 검토", tone: "unconfirmed" },
    ],
    sourceKeys: ["mair2022", "mair2016", "kruskal1964", "rosas2012", "rocliffe2023", "henderikx2023"],
    limitsKo: [
      "47개 문항·서열 MDS·동점이 많은 자료(서로 다른 비유사성 수준이 적음)에서의 Stress는 문항 수·동점 처리·분석 조건과 함께 해석해야 함.",
      "동점 처리(secondary: 같은 비유사성은 같은 디스패리티)는 primary보다 높은 Stress를 낼 수 있음 — 민감도 분석 참조.",
      "선행 연구와의 숫자 비교는 Stress 산식·정규화·동점 처리·문항 수가 같은지 확인되지 않아 동일 정의 비교가 아닐 수 있음(미확인).",
      "이전 구현(v1)의 'Stress-1'은 분자에 명시적으로 정규화한 디스패리티(Σd̂²=n(n−1)/2), 분모에 Σd²를 쓰는 정의였으며 scikit-learn의 normalized_stress와 같은 정의임(외부 라이브러리와 5자리까지 일치 확인)(오류가 아니라 다른 정의이며, 같은 좌표에서 Kruskal 값 이상의 값을 냄; 아래 ‘Stress 계산 정의 구분’ 표 참조). 이전 표시값과 새 값의 차이에는 수렴 상태의 변화와 계산 정의의 정비가 함께 들어 있으며 감소분 전부가 수렴 개선 효과는 아님.",
    ],
  });

  // 3b. definition audit ------------------------------------------------------------------------
  {
    const q = (a.statementCount * (a.statementCount - 1)) / 2;
    const num = p.kruskalNumerator;
    const den = p.sumDistSq;
    const raw = p.rawStress;
    out.push({
      id: "stress_definitions",
      group: "fit",
      evaluates: "2차원 표현의 적합도",
      nameKo: "Stress 계산 정의 구분 (같은 최종 좌표에서 네 값)",
      definitionKo: "같은 최종 좌표·같은 거리 d에서 서로 다른 정의가 서로 다른 값을 낸다. raw stress와 √(σ_raw/q)는 명시적으로 정규화한 디스패리티 d̂(Σd̂²=q)를, Kruskal Stress-1은 크기 제약 없이 단조 회귀한 디스패리티 d̂*를 쓴다. 국소 최소에서는 Kruskal Stress-1 = √(σ_raw/q)이고(Mair et al., 2022, 식 4), 이전 구현과 scikit-learn의 normalized_stress(분자 σ_raw, 분모 Σd²)는 디스패리티의 크기를 최적화하지 않아 같은 좌표에서 더 크거나 같은 값을 낸다. 둘 다 유효한 정의이며, 이 분석은 Kruskal 원정의 및 smacof(R)의 보고값과 일치하는 Σ(d̂*−d)²/Σd²를 ‘Stress-1’로 쓰고 다른 정의의 값은 항상 함께 보고한다.",
      formula: "σ_raw = Σ(d̂−d)²;  Stress-1 = √(Σ(d̂*−d)² / Σd²);  √(σ_raw/q);  이전 정의 = √(σ_raw / Σd²);  q = n(n−1)/2",
      value: p.stress1,
      valueDisplay: `raw ${f(raw, 5)} · Stress-1(Kruskal) ${f(p.stress1, 6)} · √(raw/q) ${f(p.stressNormalizedSqrt, 6)} · 이전 정의 ${f(p.stress1V1Definition, 6)}`,
      criteria: [{ kind: "definitional_range", labelKo: "정의 출처", text: "σ_n 식(2), Kruskal Stress-1 식(3), 국소 최소에서 σ₁=√σ_n 식(4)", sourceKeys: ["mair2022", "mair2016"], location: "Mair et al. (2022) p. 4; Mair et al. (2016) 원고 pp. 5–6" }],
      verdicts: [{ aspectKo: "판정", textKo: "정의 구분용 표 (적합도 판정 기준 아님)", tone: "unconfirmed" }],
      sourceKeys: ["mair2022", "mair2016"],
      limitsKo: [
        "쌍 진단표·Shepard 다이어그램에는 두 가지 디스패리티(정규화 d̂, Kruskal d̂*)와 각각의 잔차를 모두 실었으며 Shepard 계단선은 Kruskal d̂*(Stress-1 정의)를 그린다. d̂ = c·d̂*, c = √(q/Σd̂*²).",
        "독립 numpy 검증은 같은 알고리즘 정의를 다른 코드로 다시 구현한 것이며 외부 검증 라이브러리와의 비교와는 구분됨(검증 보고서 참조).",
      ],
      table: {
        header: ["지표", "분자", "분모", "디스패리티", "정규화", "값"],
        rows: [
          ["raw stress σ_raw", "Σ(d̂−d)²", "1", "정규화 d̂", "명시적: Σd̂² = q", f(raw, 6)],
          ["√(σ_raw / q)", `σ_raw = ${f(raw, 6)}`, `q = ${q} (= Σd̂² = ${f(p.sumDispSq, 6)})`, "정규화 d̂", "명시적", f(p.stressNormalizedSqrt, 6)],
          ["Kruskal Stress-1 (이 분석의 Stress-1)", `Σ(d̂*−d)² = ${f(num, 6)}`, `Σd² = ${f(den, 6)}`, "단조 회귀 d̂* (크기 제약 없음)", "암묵적: 분모 Σd²", f(p.stress1, 6)],
          ["이전 구현·scikit-learn 정의(normalized_stress)", `σ_raw = ${f(raw, 6)}`, `Σd² = ${f(den, 6)}`, "정규화 d̂", "분자는 명시적(Σd̂²=q), 분모는 Σd²", f(p.stress1V1Definition, 6)],
        ],
      },
    });
  }

  // 4. RSQ -----------------------------------------------------------------------------------
  out.push({
    id: "rsq",
    group: "fit",
    evaluates: "2차원 표현의 적합도",
    nameKo: "RSQ",
    definitionKo: "정규화된 디스패리티 d̂와 2차원 배치 거리 d 사이 피어슨 상관의 제곱(MultBiplotR의 MDS RSQ 정의). 거리가 (순서 변환된) 비유사성을 선형으로 얼마나 재현하는지를 보는 값이다. 비유사성 δ와 거리의 회귀 R²가 아니며, 다른 소프트웨어(예: SPSS ALSCAL)의 RSQ와 같은 정의인지는 확인하지 않았다.",
    formula: "RSQ = [ corr(d̂_ij, d_ij) ]²  (모든 i<j 쌍)",
    value: p.rsq,
    valueDisplay: f(p.rsq, 4),
    criteria: [
      { kind: "definitional_range", labelKo: "정의상 범위", text: "0 이상 1 이하", sourceKeys: ["multbiplotr"] },
      { kind: "good_fit_criterion_unconfirmed", labelKo: "양호 기준", text: "같은 정의에 대한 양호 기준을 원문(학술지 논문·공식 구현 문서)에서 확인하지 못함", sourceKeys: [] },
    ],
    verdicts: [{ aspectKo: "판정", textKo: "참고 지표 · 양호 기준 미확정", tone: "unconfirmed" }],
    sourceKeys: ["multbiplotr"],
    limitsKo: ["정의상 범위(0–1)를 양호 기준으로 사용하지 않음.", "참고 논문들이 인용한 RSQ ≥ .60 기준(Kruskal & Wish, 1978 인용)이 이 분석의 RSQ와 같은 정의에 대한 기준인지 확인되지 않아 적용하지 않음.", "d̂와 d 사이 상관의 제곱이며 참여자 응답 전체의 분산 설명 비율이 아님 — 그렇게 해석하지 않음.", "상관은 모든 쌍을 동등하게 취급한 값이며 일부 구조(예: 큰 군집 간 분리)에 지배될 수 있음."],
  });

  // 5. dimension scree -------------------------------------------------------------------------
  out.push({
    id: "stress_by_dimension",
    group: "fit",
    evaluates: "2차원 표현의 적합도",
    nameKo: "차원별 Stress-1 비교 (1~5차원)",
    definitionKo: "같은 방법·설정으로 1~5차원을 각각 계산한 보조 비교. 3차원 이상 결과는 2차원 지도의 대용이 아니며 지도에는 2차원 해만 사용함.",
    formula: "차원 p마다 σ₁(p)",
    value: null,
    valueDisplay: a.dimensions.map((d) => `${d.dimension}D ${f(d.stress1, 4)}${d.numericallyConverged ? "" : " (미수렴)"}`).join(" · "),
    criteria: [{ kind: "definitional_range", labelKo: "일반 원칙", text: "차원이 커질수록 Stress는 줄어듦(국소 최소에 갇히지 않는 한). 차원 수 선택에는 재현성·안정성·해석 가능성도 고려해야 함", sourceKeys: ["mair2016"], location: "원고 pp. 3, 7" }],
    verdicts: [{ aspectKo: "판정", textKo: "비교용 참고 정보 (엘보 기준 등 단일 합격선 없음)", tone: "unconfirmed" }],
    sourceKeys: ["mair2016"],
    limitsKo: ["2차원 표현의 한계는 2차원 Stress-1 자체와 위 비교를 함께 보고 판단해야 함."],
  });

  // 6. tie sensitivity ----------------------------------------------------------------------------
  if (a.tieSensitivity) {
    const t = a.tieSensitivity;
    out.push({
      id: "tie_sensitivity",
      group: "fit",
      evaluates: "2차원 표현의 적합도",
      nameKo: "동점 처리 민감도 (primary: 동점 분리 허용)",
      definitionKo: "공식 결과는 secondary(같은 비유사성은 같은 디스패리티). 동점을 분리하는 primary 접근으로 같은 설정에서 2차원을 다시 계산한 민감도 분석이며 공식 결과를 대체하지 않음.",
      formula: "tieHandling = primary; 나머지 설정 동일",
      value: t.stress1,
      valueDisplay: `Stress-1 ${f(t.stress1, 4)}, raw stress ${f(t.rawStress, 4)}, RSQ ${f(t.rsq, 4)}, 수렴 ${t.converged ? "예" : "아니오"} (${t.mainReason}/${t.strictReason}, ${t.convergedStarts}/${t.startCount} 시작 수렴)`,
      criteria: [{ kind: "definitional_range", labelKo: "동점 처리 정의", text: "primary는 동점이어도 d̂가 같을 필요 없음, secondary는 같아야 함", sourceKeys: ["mair2022"], location: "pp. 3–4" }],
      verdicts: [{ aspectKo: "판정", textKo: "참고 (공식 결과 아님)", tone: "unconfirmed" }],
      sourceKeys: ["mair2022", "mair2016"],
      limitsKo: ["동점이 많은 자료에서는 동점 처리 선택이 Stress를 크게 바꿀 수 있음(Mair et al., 2016, 원고 p. 9)."],
    });
  }

  // 7. clusters ----------------------------------------------------------------------------------------
  const sol = recommendedK ? a.solutions.find((s) => s.k === recommendedK) : undefined;
  if (sol) {
    out.push({
      id: "silhouette_map",
      group: "cluster",
      evaluates: "군집 구조",
      nameKo: `실루엣 평균 폭 — 지도 좌표 기준 (k=${sol.k})`,
      definitionKo: "[평가 대상: 군집 구조 — 지도 위 군집의 분리도이며 MDS 적합도나 분류 안정성이 아님] 각 문항 i에 대해 자기 군집 내 평균 거리 a(i)와 가장 가까운 다른 군집까지의 평균 거리 b(i)로 s(i)=(b−a)/max(a,b). 단일 점 군집은 0. 여기서는 2차원 지도 위의 유클리드 거리로 계산한 값이며 Ward가 이 지도 위에서 수행된 것과 같은 공간임.",
      formula: "s(i) = (b(i) − a(i)) / max(a(i), b(i)),  평균 = (1/n) Σ s(i)",
      value: sol.silhouetteMap.mean,
      valueDisplay: f(sol.silhouetteMap.mean, 4),
      criteria: [
        { kind: "definitional_range", labelKo: "정의상 범위", text: "−1 이상 1 이하", sourceKeys: ["rousseeuw1987"] },
        { kind: "good_fit_criterion_unconfirmed", labelKo: "양호 기준", text: "실루엣 해석 구간(예: 0.5, 0.7 등)을 학술지 원문에서 확인하지 못함", sourceKeys: [] },
      ],
      verdicts: [{ aspectKo: "판정", textKo: "참고 지표 · 양호 기준 미확정", tone: "unconfirmed" }],
      sourceKeys: ["rousseeuw1987"],
      limitsKo: ["군집 수 하나를 확정하는 근거로 단독 사용하지 않음.", "2차원 지도 위의 거리이므로 원래 비유사성 구조가 아니라 지도 표현의 군집성을 반영함.", "k=2~10 전반에서 평균 폭의 차이가 작을 수 있어 변별력이 낮을 수 있음(군집 수 비교표 참조)."],
    });
    out.push({
      id: "silhouette_delta",
      group: "cluster",
      evaluates: "군집 구조",
      nameKo: `실루엣 평균 폭 — 원래 비유사성 δ 기준 (k=${sol.k})`,
      definitionKo: "같은 군집 소속에 대해 지도 거리 대신 원래 비유사성 δ=1−S/N으로 계산한 실루엣. 2차원 지도가 군집 구조를 얼마나 왜곡했는지 보는 보조 값.",
      formula: "s(i) 동일, 거리 = δ_ij",
      value: sol.silhouetteDelta.mean,
      valueDisplay: f(sol.silhouetteDelta.mean, 4),
      criteria: [{ kind: "good_fit_criterion_unconfirmed", labelKo: "양호 기준", text: "확인된 기준 없음", sourceKeys: [] }],
      verdicts: [{ aspectKo: "판정", textKo: "참고 지표 · 양호 기준 미확정", tone: "unconfirmed" }],
      sourceKeys: ["rousseeuw1987"],
      limitsKo: ["δ 거리는 이산 값이 적고 동점이 많아 평균 폭이 작게 나오는 경향이 있음."],
    });
    out.push({
      id: "between_share",
      group: "cluster",
      evaluates: "군집 구조",
      nameKo: `군집 간 제곱합 비율 (k=${sol.k})`,
      definitionKo: "2차원 좌표의 전체 제곱합 중 군집 간 제곱합 비율(1 − 군집 내 제곱합/전체 제곱합). Ward가 최소화하는 기준과 직접 연결되는 기술 통계.",
      formula: "1 − W_k / T,  W_k = Σ_군집 Σ_점 ‖x − 군집중심‖²,  T = Σ ‖x − 전체중심‖²",
      value: sol.betweenShare,
      valueDisplay: f(sol.betweenShare, 4),
      criteria: [
        { kind: "definitional_range", labelKo: "정의상 범위", text: "0 이상 1 이하; k가 커질수록 항상 증가하므로 군집 수 선택 기준이 될 수 없음", sourceKeys: ["ward1963"] },
      ],
      verdicts: [{ aspectKo: "판정", textKo: "기술 통계 (적합도 기준 없음)", tone: "unconfirmed" }],
      sourceKeys: ["ward1963"],
      limitsKo: ["k에 대해 단조 증가하므로 군집 수 확정에 쓰지 않음."],
    });
  }

  // 8. split-half --------------------------------------------------------------------------------------
  const sh = a.splitHalf;
  out.push({
    id: "split_half",
    group: "reliability",
    evaluates: "분류 안정성",
    nameKo: "반복 분할 신뢰도 (행렬 신뢰도)",
    definitionKo: `[평가 대상: 분류 안정성(행렬 신뢰도) — 수렴·적합도와 별개] 참여자를 무작위로 반분(${Object.entries(sh.halfSizes).map(([k, v]) => `${k} ${v.join("/")}`).join(", ")})해 각 반쪽의 문항 쌍 동시분류 빈도(1,081쌍)의 상관을 ${sh.repetitions}회 반복 계산. Spearman–Brown 값 2r/(1+r)은 두 반쪽이 평행 측정이라는 가정 하의 전체 길이 환산값.`,
    formula: "r = corr(S_A[i<j], S_B[i<j]);  SB = 2r / (1 + r)",
    value: sh.rawR ? sh.rawR.mean : null,
    valueDisplay: sh.rawR && sh.spearmanBrown ? `원상관 평균 ${f(sh.rawR.mean, 3)} (중앙값 ${f(sh.rawR.median, 3)}, 최소–최대 ${f(sh.rawR.min, 3)}–${f(sh.rawR.max, 3)}); SB 평균 ${f(sh.spearmanBrown.mean, 3)} (중앙값 ${f(sh.spearmanBrown.median, 3)}); 계산 불능 ${sh.undefinedCount}회, 음수 ${sh.negativeRawCount}회` : "계산 불가",
    criteria: [
      { kind: "computation_setting", labelKo: "이번 계산의 설정값", text: `반복 ${sh.repetitions}회, seed ${sh.seed} 사전 고정. ${sh.design}`, sourceKeys: ["trochim1994"] },
      { kind: "empirical_comparison_range", labelKo: "개념도 사례의 값(비교 참고, 기준 아님)", text: "Trochim 외(1994)는 무작위 이분 후 Spearman–Brown 보정한 분할 신뢰도로 유사성 행렬 r = .79, MDS 배치 r = .56을 보고했으며 최소 허용값은 서술하지 않음(표본·문항 수가 달라 직접 비교 불가)", sourceKeys: ["trochim1994"], location: "Trochim et al. (1994) Results > Reliability and Consistency of Maps" },
      { kind: "good_fit_criterion_unconfirmed", labelKo: "양호 기준", text: "분할 신뢰도의 양호 기준을 원문에서 확인하지 못함(Trochim 외(1994) 본문에도 최소 허용값 없음)", sourceKeys: ["trochim1994"] },
    ],
    verdicts: [{ aspectKo: "판정", textKo: "참고 지표 · 양호 기준 미확정", tone: "unconfirmed" }],
    sourceKeys: ["trochim1994"],
    limitsKo: [
      "행렬 신뢰도이며 지도 신뢰도가 아님.",
      "분위수 범위는 이 표본의 무작위 분할 분포일 뿐 모집단 신뢰구간이 아님.",
      "SB 환산은 평행 반쪽 가정에 의존하며 이 가정은 검증되지 않았음.",
    ],
  });

  // 9. data validation -----------------------------------------------------------------------------
  const c = a.matrixChecks;
  out.push({
    id: "data_validation",
    group: "data",
    evaluates: "자료 검증",
    nameKo: "입력 행렬 검증",
    definitionKo: "47×47 크기, 대칭성, 값의 범위(0≤S_ij≤N), 대각선=N, 동시분류 빈도의 분포.",
    formula: "S_ij = Σ_참여자 1{i,j 같은 묶음};  P=S/N;  D=N−S;  δ=1−S/N (MDS 입력)",
    value: c.size,
    valueDisplay: `크기 ${c.size}×${c.size}, 대칭 ${c.symmetric ? "예" : "아니오"}, 범위 ${c.offDiagonalInRange ? "정상" : "이상"}, 대각선=N ${c.diagonalEqualsN ? "예" : "아니오"}; 비대각 최소 ${c.minOffDiagonal} · 최대 ${c.maxOffDiagonal}; 한 번도 함께 분류되지 않은 쌍 ${c.neverTogether}/${c.pairs}; 모두가 함께 분류한 쌍 ${c.alwaysTogether}; 서로 다른 비유사성 수준 ${c.distinctLevels}개`,
    criteria: [{ kind: "definitional_range", labelKo: "정의상 조건", text: "대칭, 0≤S_ij≤N, S_ii=N (집단 행렬은 개인 이진 행렬의 합, 대각선 = 분류자 수)", sourceKeys: ["trochim1989"], location: "Trochim (1989) Step 3: Structuring of Statements" }],
    verdicts: [{ aspectKo: "판정", textKo: c.symmetric && c.offDiagonalInRange && c.diagonalEqualsN ? "정의상 조건 충족" : "정의상 조건 위반", tone: c.symmetric && c.offDiagonalInRange && c.diagonalEqualsN ? "met" : "unfavorable" }],
    sourceKeys: ["trochim1989"],
    limitsKo: ["모든 참여자가 47개 문항을 중복·누락 없이 분류했음을 확인한 뒤에만 위 식을 적용함(불완전 자료는 결측을 0으로 바꾸지 않고 분모를 바꾸지 않음)."],
  });

  return out;
}
