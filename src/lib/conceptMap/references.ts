/**
 * Reference registry. `access` records what was ACTUALLY read while building this analysis; a claim is only
 * attributed to a location in a source when that location was read (`locations`). Sources that could not be
 * opened are listed with access = ABSTRACT_ONLY / NOT_ACCESSED and carry no location claims.
 */
export type ReferenceKey =
  | "mair2022"
  | "mair2016"
  | "henderikx2023"
  | "rosas2012"
  | "rocliffe2023"
  | "rousseeuw1987"
  | "trochim1989"
  | "trochim1994"
  | "ward1963"
  | "kruskal1964"
  | "sklearn18"
  | "multbiplotr";

export type Access = "FULL_TEXT_READ" | "ABSTRACT_ONLY" | "NOT_ACCESSED" | "SECONDARY_ONLY" | "DOCUMENTATION_READ";

export type Reference = {
  key: ReferenceKey;
  kind: "journal" | "software-documentation";
  apa: string;
  doi?: string;
  url?: string;
  access: Access;
  accessNoteKo: string;
  /** locations that were read, each tied to the claim it supports */
  locations: { claimKo: string; where: string }[];
};

export const REFERENCES: Record<ReferenceKey, Reference> = {
  mair2022: {
    key: "mair2022",
    kind: "journal",
    apa: "Mair, P., Groenen, P. J. F., & de Leeuw, J. (2022). More on multidimensional scaling and unfolding in R: smacof version 2. *Journal of Statistical Software, 102*(10), 1–47. https://doi.org/10.18637/jss.v102.i10",
    doi: "10.18637/jss.v102.i10",
    url: "https://www.jstatsoft.org/article/view/v102i10",
    access: "FULL_TEXT_READ",
    accessNoteKo: "공개 PDF 전문을 직접 열람함.",
    locations: [
      { claimKo: "서열(비계량) MDS와 동점 처리(primary/secondary/tertiary), 명시적 정규화 Σw·d̂²=n(n−1)/2, σ_n 식(2), Kruskal Stress-1 식(3), 국소 최소에서 σ1=√σ_n 식(4)", where: "p. 4, 식 (2)–(4)" },
      { claimKo: "임의 시작(random starts)과 국소 최소 문제", where: "p. 6, §3.1" },
      { claimKo: "Stress 규준·Kruskal 구술 척도와 그 적용상 주의", where: "pp. 7–9, §3.2" },
    ],
  },
  mair2016: {
    key: "mair2016",
    kind: "journal",
    apa: "Mair, P., Borg, I., & Rusch, T. (2016). Goodness-of-fit assessment in multidimensional scaling and unfolding. *Multivariate Behavioral Research, 51*(6), 772–789. https://doi.org/10.1080/00273171.2016.1235966",
    doi: "10.1080/00273171.2016.1235966",
    url: "https://research.wu.ac.at/ws/files/19828645/mairetal2016.pdf",
    access: "FULL_TEXT_READ",
    accessNoteKo: "저자 수락 원고(WU Vienna 저장소 PDF)를 직접 열람함. 아래 쪽수는 이 원고의 쪽수이며 학술지 면수와 다를 수 있음.",
    locations: [
      { claimKo: "Stress 경험칙(예: 0.20 미만)만으로 적합도를 판단해서는 안 됨", where: "원고 p. 3 (서론)" },
      { claimKo: "SMACOF 목적함수 식 (2)와 Stress-1 식 (3)", where: "원고 pp. 5–6" },
      { claimKo: "Kruskal(1964a) 구술 척도 인용(20% poor, 10% fair, 5% good, 2.5% excellent), n이 커지면 Stress가 커짐, 상한 불명확", where: "원고 p. 8, 절 'Scree Plot, Stress Rules of Thumb, and Stress Norms'" },
      { claimKo: "자료 오차가 클수록·동점이 적을수록·결측이 적을수록 Stress가 높아짐(서열 MDS), 무작위 규준은 느슨함", where: "원고 p. 9" },
      { claimKo: "순열 검정 H0(비유사성의 무작위 순열)과 순열 Stress 규준", where: "원고 pp. 14–15" },
    ],
  },
  henderikx2023: {
    key: "henderikx2023",
    kind: "journal",
    apa: "Henderikx, M., & Stoffers, J. (2023). Digital transformation and middle managers’ leadership skills and behavior: A group concept mapping approach. *Frontiers in Psychology, 14*, Article 1147002. https://doi.org/10.3389/fpsyg.2023.1147002",
    doi: "10.3389/fpsyg.2023.1147002",
    url: "https://www.frontiersin.org/articles/10.3389/fpsyg.2023.1147002/full",
    access: "FULL_TEXT_READ",
    accessNoteKo: "공개 전문을 직접 열람함.",
    locations: [
      { claimKo: "개념도 연구의 Stress 비교 범위 0.205–0.365를 Rosas & Kane(2012)의 인용으로 제시하고 자신의 Stress(0.2234, 14회 반복)와 비교. GCM 소프트웨어의 Stress 정의는 명시되어 있지 않음", where: "초록, §3.1, §4.1" },
    ],
  },
  rosas2012: {
    key: "rosas2012",
    kind: "journal",
    apa: "Rosas, S. R., & Kane, M. (2012). Quality and rigor of the concept mapping methodology: A pooled study analysis. *Evaluation and Program Planning, 35*(2), 236–245. https://doi.org/10.1016/j.evalprogplan.2011.10.003",
    doi: "10.1016/j.evalprogplan.2011.10.003",
    url: "https://doi.org/10.1016/j.evalprogplan.2011.10.003",
    access: "ABSTRACT_ONLY",
    accessNoteKo: "원문 접근이 차단되어(출판사 403) 초록 수준만 확인함. 69개 연구의 Stress 평균 0.28·관찰 범위 0.17–0.34(§3.5)는 2차 문헌(Rocliffe et al., 2023)이 이 논문에 귀속한 내용이며 표준편차 0.04는 연구자가 제공한 값으로 2차 문헌에서도 확인하지 못함. 원문 대조 필요. 0.205–0.365(평균 0.285)는 별개의 비교 범위로 일부 2차 문헌이 Kane & Trochim(2007)이 인용한 Trochim의 미발표 1993년 검토에서 나온 것으로 설명하며(전문 미열람) Henderikx & Stoffers(2023)는 이 논문의 인용으로 제시함: 서로 다른 자료·범위일 수 있어 모순으로 단정하지 않고 출처 귀속은 원문 확인 필요.",
    locations: [],
  },
  rocliffe2023: {
    key: "rocliffe2023",
    kind: "journal",
    apa: "Rocliffe, P., O’Keeffe, B. T., Sherwin, I., Mannix-McNamara, P., & MacDonncha, C. (2023). School-based physical education, physical activity and sports provision: A concept mapping framework for evaluation. *PLOS ONE, 18*(6), Article e0287505. https://doi.org/10.1371/journal.pone.0287505",
    doi: "10.1371/journal.pone.0287505",
    url: "https://doi.org/10.1371/journal.pone.0287505",
    access: "FULL_TEXT_READ",
    accessNoteKo: "공개 전문을 직접 열람함. 2차 문헌으로만 사용: Rosas & Kane(2012)이 69개 연구에서 ‘평균 Stress 0.17–0.34’를 보고했다고 서술함(‘optimum’이라는 표현과 이 범위를 합격 기준처럼 쓴 해석은 채택하지 않음).",
    locations: [{ claimKo: "Rosas & Kane(2012)의 Stress 범위 0.17–0.34 인용(자신의 Stress 0.266을 이 범위와 비교)", where: "Results > Sorting/cluster map" }],
  },
  rousseeuw1987: {
    key: "rousseeuw1987",
    kind: "journal",
    apa: "Rousseeuw, P. J. (1987). Silhouettes: A graphical aid to the interpretation and validation of cluster analysis. *Journal of Computational and Applied Mathematics, 20*, 53–65. https://doi.org/10.1016/0377-0427(87)90125-7",
    doi: "10.1016/0377-0427(87)90125-7",
    url: "https://doi.org/10.1016/0377-0427(87)90125-7",
    access: "ABSTRACT_ONLY",
    accessNoteKo: "서지 정보와 초록 수준의 요약만 확인함(전문 미열람). 실루엣 정의는 이 논문의 것으로 인용하되 식·해석 구간의 원문 위치는 확인하지 못함.",
    locations: [],
  },
  trochim1989: {
    key: "trochim1989",
    kind: "journal",
    apa: "Trochim, W. M. K. (1989). An introduction to concept mapping for planning and evaluation. *Evaluation and Program Planning, 12*(1), 1–16. https://doi.org/10.1016/0149-7189(89)90016-5",
    doi: "10.1016/0149-7189(89)90016-5",
    url: "https://billtrochim.net/research/epp1/epp1.htm",
    access: "FULL_TEXT_READ",
    accessNoteKo: "저자 공개 본문(billtrochim.net)을 직접 열람함. 쪽 표시가 없어 위치는 절(Step) 제목으로 기록함. 비유사성으로의 변환식, MDS 적합도 수치·진단 통계의 이름, 군집 수의 형식적 기준은 이 본문에 없음.",
    locations: [
      { claimKo: "개인 분류는 정사각 이진 대칭 유사성 행렬(같은 묶음 1), 대각선 1, 집단 행렬은 개인 행렬의 합이며 대각선은 분류자 수", where: "Step 3: Structuring of Statements" },
      { claimKo: "유사성 행렬에 대한 2차원 비계량 MDS, 1~5차원 비교 가능, 군집분석은 MDS X–Y 좌표에 대한 Ward 계층 군집", where: "Step 4: Representation of Statements" },
      { claimKo: "군집 수는 분석자의 재량(약 20개에서 3개 해를 검토, 더 많은 군집 쪽으로 기울임), 군집은 겹치지 않아야 하며 MDS 구조를 유지, 군집명은 참여자가 짧은 구·단어로 제안하고 합의, 2차원이 보통 충분하다고 서술", where: "Step 4 및 Step 5: Interpretation of Maps" },
    ],
  },
  trochim1994: {
    key: "trochim1994",
    kind: "journal",
    apa: "Trochim, W. M. K., Cook, J. A., & Setze, R. J. (1994). Using concept mapping to develop a conceptual framework of staff’s views of a supported employment program for individuals with severe mental illness. *Journal of Consulting and Clinical Psychology, 62*(4), 766–775. https://doi.org/10.1037/0022-006X.62.4.766",
    doi: "10.1037/0022-006X.62.4.766",
    url: "https://billtrochim.net/research/CCP/TCANDS.HTM",
    access: "FULL_TEXT_READ",
    accessNoteKo: "저자 공개 본문(billtrochim.net)을 직접 열람함. 쪽 표시가 없어 위치는 절 제목으로 기록함. 신뢰도·Stress의 허용 기준(최소 신뢰도 계수, 최대 Stress)은 이 본문에 없음. 이 연구의 반복 분할 설계(1,000회·국가 층화·seed 고정)는 이 논문의 설계가 아니라 이번 분석의 사전 고정 설정임.",
    locations: [
      { claimKo: "지도의 방향은 전적으로 임의이며(회전·반사해도 거리 불변) 군집의 크기나 모양에는 의미 있는 해석이 없음", where: "Results, 그림 2 관련 서술" },
      { claimKo: "군집명은 참가자가 각자 제안한 뒤 진행자가 합의를 이끌고, 합의가 어려우면 혼합 명칭을 제안", where: "Method > Procedure > Session 2: Interpretation of the Concept Maps" },
      { claimKo: "참가자를 무작위로 두 집단으로 나눠 Spearman–Brown 보정한 분할 신뢰도: 유사성 행렬 r = .79, 최종 MDS 배치 r = .56. 단일 신뢰도 추정치는 불가능하다고 서술", where: "Results > Reliability and Consistency of Maps" },
      { claimKo: "군집 수 18개는 ‘단순한 수학적 기준이 없다’며 내용 판단으로 선택, 최종 Stress .31 보고(정의·허용 기준은 서술되지 않음), 2차원은 사용 편의로 선택", where: "Method > Procedure: Data Analysis 및 Results (MDS)" },
    ],
  },
  ward1963: {
    key: "ward1963",
    kind: "journal",
    apa: "Ward, J. H., Jr. (1963). Hierarchical grouping to optimize an objective function. *Journal of the American Statistical Association, 58*(301), 236–244. https://doi.org/10.1080/01621459.1963.10500845",
    doi: "10.1080/01621459.1963.10500845",
    url: "https://doi.org/10.1080/01621459.1963.10500845",
    access: "NOT_ACCESSED",
    accessNoteKo: "원문 미열람. Ward 최소분산 기준의 출처로만 인용. 구현은 독립 구현(군집 내 제곱합 증가량을 직접 계산)과의 일치로 검증함.",
    locations: [],
  },
  kruskal1964: {
    key: "kruskal1964",
    kind: "journal",
    apa: "Kruskal, J. B. (1964). Multidimensional scaling by optimizing goodness of fit to a nonmetric hypothesis. *Psychometrika, 29*(1), 1–27.",
    access: "SECONDARY_ONLY",
    accessNoteKo: "원문 미열람. Stress-1과 구술 척도는 Mair et al.(2016, 원고 p. 8)과 Mair et al.(2022, p. 4·p. 7)의 인용을 통해서만 확인함.",
    locations: [],
  },
  sklearn18: {
    key: "sklearn18",
    kind: "software-documentation",
    apa: "scikit-learn developers. (n.d.). *sklearn.manifold.smacof* (version 1.8) [Software documentation]. https://scikit-learn.org/1.8/modules/generated/sklearn.manifold.smacof.html",
    url: "https://scikit-learn.org/1.8/modules/generated/sklearn.manifold.smacof.html",
    access: "DOCUMENTATION_READ",
    accessNoteKo: "공식 문서를 직접 열람함(구현 확인용 보조 근거이며 학술지 논문을 대체하지 않음).",
    locations: [
      { claimKo: "eps 정의(Stress의 상대적 감소), 정규화 서술, Kruskal 구술 척도 표기(0.025/0.05/0.1/0.2)", where: "공식 문서 Parameters 및 Notes" },
      { claimKo: "비계량 모드에서 대각선 밖 비유사성 0은 등위회귀에서 제외(결측 취급)되고, 수렴 판정은 정규화 전 raw stress로 하며, 비계량의 기본 반환값은 normalized_stress = √(stress/(Σd²/2)) (분자는 정규화 디스패리티; Kruskal의 크기 최적화 d̂*가 아님)", where: "소스 sklearn/manifold/_mds.py (1.8.X 브랜치) _smacof_single·smacof 함수(소스 코드 직접 열람)" },
    ],
  },
  multbiplotr: {
    key: "multbiplotr",
    kind: "software-documentation",
    apa: "MultBiplotR package authors. (n.d.). *MDS: Multidimensional scaling* [R package documentation]. https://search.r-project.org/CRAN/refmans/MultBiplotR/html/MDS.html",
    url: "https://search.r-project.org/CRAN/refmans/MultBiplotR/html/MDS.html",
    access: "DOCUMENTATION_READ",
    accessNoteKo: "공식 문서를 직접 열람함(구현 확인용 보조 근거). RSQ를 '디스패리티와 거리 사이의 제곱 상관'으로 정의하며 양호 기준은 제시하지 않음.",
    locations: [{ claimKo: "RSQ 정의", where: "Value 절의 rsq 항목" }],
  },
};
