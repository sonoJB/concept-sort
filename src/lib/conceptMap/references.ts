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
    accessNoteKo: "원문 접근이 차단되어 PubMed 초록만 확인함(초록에는 Stress 수치가 없음). 0.205–0.365 범위가 이 논문의 어느 표·쪽에 있는지는 원문에서 확인하지 못함.",
    locations: [],
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
    url: "https://doi.org/10.1016/0149-7189(89)90016-5",
    access: "NOT_ACCESSED",
    accessNoteKo: "원문 미열람. 개념도 절차(분류 → 유사성 행렬 → MDS → 군집)의 일반 출처로만 인용하며 개별 수치·쪽수는 주장하지 않음.",
    locations: [],
  },
  trochim1994: {
    key: "trochim1994",
    kind: "journal",
    apa: "Trochim, W. M. K., Cook, J. A., & Setze, R. J. (1994). Using concept mapping to develop a conceptual framework of staff’s views of a supported employment program for individuals with severe mental illness. *Journal of Consulting and Clinical Psychology, 62*(4), 766–775. https://doi.org/10.1037/0022-006X.62.4.766",
    doi: "10.1037/0022-006X.62.4.766",
    url: "https://doi.org/10.1037/0022-006X.62.4.766",
    access: "NOT_ACCESSED",
    accessNoteKo: "원문 미열람. 반복 분할 신뢰도 설계의 출처로 지정된 문헌이나 본 분석의 세부 설계(1,000회, 국가 층화)는 이 연구의 사전 고정 설정이며 원문의 내용으로 주장하지 않음.",
    locations: [],
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
    locations: [{ claimKo: "eps 정의(Stress의 상대적 감소), 정규화 서술, Kruskal 구술 척도 표기(0.025/0.05/0.1/0.2)", where: "Parameters 및 Notes" }],
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
