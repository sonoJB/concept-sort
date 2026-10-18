/**
 * Per-metric disclosure: definition / formula / actual value / reference value(s) / verdict / source / limits.
 *
 * Four different kinds of "reference" are kept strictly apart and labelled as such, never merged into one
 * "good" verdict:
 *   computation_setting          a setting chosen for THIS computation (e.g. tolerance) — not a literature cutoff
 *   definitional_range           the range the quantity can take by definition — never a quality criterion
 *   general_rule_of_thumb        a general MDS verbal scale (Kruskal), quoted with the authors' own caveats
 *   empirical_comparison_range   values reported by earlier concept-mapping studies — a comparison range only
 *   good_fit_criterion_unconfirmed  no cutoff could be verified at an original source -> no verdict is issued
 */
import type { ScopeAnalysis, DimensionAnalysis } from "./analyze";
import type { ReferenceKey } from "./references";

export type CriterionKind = "computation_setting" | "definitional_range" | "general_rule_of_thumb" | "empirical_comparison_range" | "good_fit_criterion_unconfirmed";

export type Criterion = { kind: CriterionKind; labelKo: string; text: string; sourceKeys: ReferenceKey[]; location?: string };

export type Tone = "met" | "unfavorable" | "neutral" | "unconfirmed";

export type MetricRecord = {
  id: string;
  group: "convergence" | "fit" | "cluster" | "reliability" | "data";
  nameKo: string;
  definitionKo: string;
  formula: string;
  value: number | string | null;
  valueDisplay: string;
  criteria: Criterion[];
  verdicts: { aspectKo: string; textKo: string; tone: Tone }[];
  sourceKeys: ReferenceKey[];
  limitsKo: string[];
};

const f = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? "계산 불가" : v.toFixed(d));
const e = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "계산 불가" : v.toExponential(2));

export const KRUSKAL_SCALE: { max: number; label: string }[] = [
  { max: 0.025, label: "excellent" },
  { max: 0.05, label: "good" },
  { max: 0.1, label: "fair" },
  { max: 0.2, label: "poor" },
];
export const CONCEPT_MAPPING_STRESS_RANGE = { low: 0.205, high: 0.365 } as const;

export function kruskalBand(s: number): string {
  for (const b of KRUSKAL_SCALE) if (s <= b.max) return `Kruskal 구술 척도에서 ${b.max} 이하(${b.label})`;
  return "Kruskal 구술 척도의 가장 낮은 구간(poor, 0.20)보다 큼";
}

export function rangePosition(s: number): { text: string; tone: Tone } {
  const { low, high } = CONCEPT_MAPPING_STRESS_RANGE;
  if (s < low) return { text: `비교 범위(${low}–${high})의 하한보다 낮음. 하한 미만이라는 사실이 '부적합'을 뜻하지는 않음`, tone: "neutral" };
  if (s > high) return { text: `비교 범위(${low}–${high})의 상한보다 높음`, tone: "unfavorable" };
  return { text: `비교 범위(${low}–${high}) 안에 있음. 범위 안이라는 사실이 지도의 타당성을 입증하지는 않음`, tone: "neutral" };
}

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

  // 2. raw stress ----------------------------------------------------------------------------
  out.push({
    id: "raw_stress",
    group: "fit",
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
  const pos = s1 !== null ? rangePosition(s1) : null;
  out.push({
    id: "stress1",
    group: "fit",
    nameKo: "Stress-1 (Kruskal)",
    definitionKo:
      "Kruskal(1964)의 암묵적 정규화 Stress. 디스패리티는 거리에 대한 단조 회귀값(크기 제약 없음)이며 분모는 배치 거리의 제곱합. 국소 최소에서 √(σ_raw / (n(n−1)/2))와 같으므로 이 분석은 두 식의 일치를 계산으로 확인한다.",
    formula: "σ₁ = √( Σ_{i<j}(d̂*_ij − d_ij)² / Σ_{i<j} d_ij² ),  d̂* = 단조회귀(d | δ)",
    value: s1,
    valueDisplay: `${f(s1, 5)}  (√(σ_raw/q) = ${f(p.stressNormalizedSqrt, 5)})`,
    criteria: [
      {
        kind: "general_rule_of_thumb",
        labelKo: "일반 MDS 참고 구분 (Kruskal)",
        text: "20% poor, 10% fair, 5% good, 2.5% excellent (Kruskal이 실험·합성 자료 경험으로 제시). Mair 등은 문항 수 증가에 따라 Stress가 커지고 상한이 자명하지 않으며 자료 오차·동점·결측이 Stress에 영향을 주므로 이 경험칙만으로 판단하지 말 것을 권고함",
        sourceKeys: ["kruskal1964", "mair2016", "mair2022"],
        location: "Mair et al. (2016) 원고 pp. 3, 8–9; Mair et al. (2022) p. 7–9",
      },
      {
        kind: "empirical_comparison_range",
        labelKo: "개념도 연구의 비교 범위",
        text: `${CONCEPT_MAPPING_STRESS_RANGE.low}–${CONCEPT_MAPPING_STRESS_RANGE.high}: Henderikx & Stoffers(2023)가 Rosas & Kane(2012)을 인용해 제시한 개념도 연구들의 Stress 범위. Rosas & Kane 원문에서의 위치는 확인하지 못했고, 개념도 소프트웨어의 Stress 정의가 위 Stress-1과 같은지는 원문에 명시되어 있지 않아 동일 정의의 비교인지 미확정`,
        sourceKeys: ["henderikx2023", "rosas2012"],
        location: "Henderikx & Stoffers (2023) 초록, §3.1, §4.1",
      },
    ],
    verdicts: [
      { aspectKo: "일반 MDS 참고 구분", textKo: s1 === null ? "계산 불가" : `${kruskalBand(s1)}. 이는 불리한 결과이며 숨기지 않음`, tone: s1 !== null && s1 > 0.2 ? "unfavorable" : "neutral" },
      { aspectKo: "개념도 연구의 비교 범위", textKo: pos ? pos.text : "계산 불가", tone: pos ? pos.tone : "unconfirmed" },
    ],
    sourceKeys: ["mair2022", "mair2016", "kruskal1964", "henderikx2023", "rosas2012"],
    limitsKo: [
      "47개 문항·서열 MDS·동점이 많은 자료(서로 다른 비유사성 수준이 적음)에서의 Stress는 문항 수·동점 처리·분석 조건과 함께 해석해야 함.",
      "동점 처리(secondary: 같은 비유사성은 같은 디스패리티)는 primary보다 높은 Stress를 낼 수 있음 — 민감도 분석 참조.",
      "이전 구현(v1)의 'Stress-1'은 분모만 Kruskal식이고 분자의 디스패리티는 명시적 정규화 값을 써서 두 정규화를 섞은 값이었음(본 분석의 정의와 다름).",
    ],
  });

  // 4. RSQ -----------------------------------------------------------------------------------
  out.push({
    id: "rsq",
    group: "fit",
    nameKo: "RSQ",
    definitionKo: "정규화된 디스패리티와 배치 거리 사이 피어슨 상관의 제곱(MultBiplotR의 MDS RSQ 정의). 비유사성 δ와 거리의 회귀 R²나 ALSCAL의 RSQ와는 정의가 다름.",
    formula: "RSQ = [ corr(d̂_ij, d_ij) ]²  (모든 i<j 쌍)",
    value: p.rsq,
    valueDisplay: f(p.rsq, 4),
    criteria: [
      { kind: "definitional_range", labelKo: "정의상 범위", text: "0 이상 1 이하", sourceKeys: ["multbiplotr"] },
      { kind: "good_fit_criterion_unconfirmed", labelKo: "양호 기준", text: "같은 정의에 대한 양호 기준을 원문(학술지 논문·공식 구현 문서)에서 확인하지 못함", sourceKeys: [] },
    ],
    verdicts: [{ aspectKo: "판정", textKo: "참고 지표 · 양호 기준 미확정", tone: "unconfirmed" }],
    sourceKeys: ["multbiplotr"],
    limitsKo: ["정의상 범위(0–1)를 양호 기준으로 사용하지 않음.", "상관은 모든 쌍을 동등하게 취급한 값이며 일부 구조(예: 큰 군집 간 분리)에 지배될 수 있음."],
  });

  // 5. dimension scree -------------------------------------------------------------------------
  out.push({
    id: "stress_by_dimension",
    group: "fit",
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
      nameKo: `실루엣 평균 폭 — 지도 좌표 기준 (k=${sol.k})`,
      definitionKo: "각 문항 i에 대해 자기 군집 내 평균 거리 a(i)와 가장 가까운 다른 군집까지의 평균 거리 b(i)로 s(i)=(b−a)/max(a,b). 단일 점 군집은 0. 여기서는 2차원 지도 위의 유클리드 거리로 계산한 값이며 Ward가 이 지도 위에서 수행된 것과 같은 공간임.",
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
    nameKo: "반복 분할 신뢰도 (행렬 신뢰도)",
    definitionKo: `참여자를 무작위로 반분(${Object.entries(sh.halfSizes).map(([k, v]) => `${k} ${v.join("/")}`).join(", ")})해 각 반쪽의 문항 쌍 동시분류 빈도(1,081쌍)의 상관을 ${sh.repetitions}회 반복 계산. Spearman–Brown 값 2r/(1+r)은 두 반쪽이 평행 측정이라는 가정 하의 전체 길이 환산값.`,
    formula: "r = corr(S_A[i<j], S_B[i<j]);  SB = 2r / (1 + r)",
    value: sh.rawR ? sh.rawR.mean : null,
    valueDisplay: sh.rawR && sh.spearmanBrown ? `원상관 평균 ${f(sh.rawR.mean, 3)} (중앙값 ${f(sh.rawR.median, 3)}, 최소–최대 ${f(sh.rawR.min, 3)}–${f(sh.rawR.max, 3)}); SB 평균 ${f(sh.spearmanBrown.mean, 3)} (중앙값 ${f(sh.spearmanBrown.median, 3)}); 계산 불능 ${sh.undefinedCount}회, 음수 ${sh.negativeRawCount}회` : "계산 불가",
    criteria: [
      { kind: "computation_setting", labelKo: "이번 계산의 설정값", text: `반복 ${sh.repetitions}회, seed ${sh.seed} 사전 고정. ${sh.design}`, sourceKeys: ["trochim1994"] },
      { kind: "good_fit_criterion_unconfirmed", labelKo: "양호 기준", text: "분할 신뢰도의 양호 기준을 원문에서 확인하지 못함", sourceKeys: [] },
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
    nameKo: "입력 행렬 검증",
    definitionKo: "47×47 크기, 대칭성, 값의 범위(0≤S_ij≤N), 대각선=N, 동시분류 빈도의 분포.",
    formula: "S_ij = Σ_참여자 1{i,j 같은 묶음};  P=S/N;  D=N−S;  δ=1−S/N (MDS 입력)",
    value: c.size,
    valueDisplay: `크기 ${c.size}×${c.size}, 대칭 ${c.symmetric ? "예" : "아니오"}, 범위 ${c.offDiagonalInRange ? "정상" : "이상"}, 대각선=N ${c.diagonalEqualsN ? "예" : "아니오"}; 비대각 최소 ${c.minOffDiagonal} · 최대 ${c.maxOffDiagonal}; 한 번도 함께 분류되지 않은 쌍 ${c.neverTogether}/${c.pairs}; 모두가 함께 분류한 쌍 ${c.alwaysTogether}; 서로 다른 비유사성 수준 ${c.distinctLevels}개`,
    criteria: [{ kind: "definitional_range", labelKo: "정의상 조건", text: "대칭, 0≤S_ij≤N, S_ii=N", sourceKeys: ["trochim1989"] }],
    verdicts: [{ aspectKo: "판정", textKo: c.symmetric && c.offDiagonalInRange && c.diagonalEqualsN ? "정의상 조건 충족" : "정의상 조건 위반", tone: c.symmetric && c.offDiagonalInRange && c.diagonalEqualsN ? "met" : "unfavorable" }],
    sourceKeys: ["trochim1989"],
    limitsKo: ["모든 참여자가 47개 문항을 중복·누락 없이 분류했음을 확인한 뒤에만 위 식을 적용함(불완전 자료는 결측을 0으로 바꾸지 않고 분모를 바꾸지 않음)."],
  });

  return out;
}
