/**
 * Data dictionary for the concept-sort SQLite database. `assertDictionaryCovers`
 * compares it against the REAL columns of the database being backed up and
 * fails if any table or column is undocumented, so the dictionary can never
 * silently drift from the schema.
 */
export type TableDoc = { description: string; sensitive?: string; columns: Record<string, string> };

export const DATA_DICTIONARY: Record<string, TableDoc> = {
  Project: {
    description: "연구(프로젝트) 1건. 현재 운영 DB에는 '사이버폭력의 특징' 연구 1건(slug=rrrvvnux)만 있음.",
    sensitive: "adminToken은 관리자 URL의 비밀 토큰입니다. DB 파일에만 존재하며 일반 내보내기(JSON/CSV/Excel)에서는 제외됩니다.",
    columns: {
      id: "프로젝트 내부 ID(cuid)",
      slug: "연구 식별자. 참여 링크(/p/<slug>/sort)와 관리자 링크에 사용",
      adminToken: "관리자 접근 토큰(비밀). 복구 시 그대로 필요",
      title: "연구명(한국어)",
      prompt: "연구 소개문(한국어)",
      createdAt: "생성 시각(UTC epoch ms)",
      titleJa: "연구명(일본어)",
      promptJa: "연구 소개문(일본어)",
      consentKo: "한국어 연구 참여 동의서 본문",
      consentJa: "일본어 연구 참여 동의서 본문",
      koreanEnabled: "한국어 참여 허용 여부(0/1)",
      japaneseEnabled: "일본어 참여 허용 여부(0/1)",
      legacyConsentFallbackEnabled: "과거 하드코딩 한국어 동의서 사용 여부(0/1)",
      koPreviewConfirmedAt: "한국어 화면 미리보기 확정 시각(UTC epoch ms)",
      jaPreviewConfirmedAt: "일본어 화면 미리보기 확정 시각(UTC epoch ms)",
      guideTemplateKo: "한국어 세부 지침(템플릿; {{CARD_COUNT}} 등 치환자 포함)",
      guideTemplateJa: "일본어 세부 지침(템플릿)",
      guideVideoUrlJa: "일본어 가이드라인 동영상 URL",
      guideVideoUrlKo: "한국어 가이드라인 동영상 URL",
      mainStudyStartsAt: "본조사 시작 시각(UTC epoch ms). 이 시각 이전 제출은 PILOT, 이후는 MAIN으로 서버가 분류",
    },
  },
  Statement: {
    description: "진술문(분류 카드). 한국어 원문과 일본어 번역을 한 행에 보관. `order`가 행렬의 행·열 순서(공통 진술문 순서)",
    columns: {
      id: "진술문 ID(cuid). 분류 결과(SortGroupItem.statementId)가 이 ID를 참조",
      projectId: "소속 프로젝트 ID",
      text: "진술문 한국어 원문",
      order: "표시·행렬 순서(0부터). 행렬의 S01은 order=0",
      textJa: "진술문 일본어 번역",
      jaStatus: "일본어 번역 검수 상태(MISSING/DRAFT/REVIEWING/APPROVED)",
    },
  },
  SortSession: {
    description: "참여자 1명의 최종 제출 1건. 제출이 완료될 때만 생성되므로 임시저장·미완료 행은 존재하지 않음.",
    sensitive:
      "participantName, phoneNumber, gender, age, schoolLevel, grade는 개인정보입니다. 한국: 전화번호 전체, 일본: 휴대전화번호 끝 4자리(본인 식별용, 고유 ID 아님·중복 가능). participantName은 참가자가 입력한 원문 그대로(전각 숫자 포함)이며 수정되지 않았습니다.",
    columns: {
      id: "제출(참여자) 내부 ID(cuid)",
      projectId: "소속 프로젝트 ID",
      participantName: "참가자가 '이름/氏名' 칸에 입력한 원문(일본 본조사는 4자리 숫자 코드; 전각이면 전각 그대로)",
      createdAt: "제출 시각(서버 시계, UTC epoch ms)",
      consentAgreed: "연구 참여 동의 여부(0/1)",
      gender: "성별(저장값은 언어와 무관한 한국어 값)",
      age: "연령(정수)",
      schoolLevel: "학교급(저장값)",
      grade: "학년(저장값)",
      phoneNumber: "한국=스마트폰 번호 전체, 일본=휴대전화번호 끝 4자리(문자열; 앞자리 0 보존)",
      countryCode: "참여 국가(KR/JP). 참가자가 직접 선택한 값. NULL이면 미지정",
      dataRole: "자료 구분: MAIN(본조사) / PILOT(파일럿). 서버가 제출 시각과 mainStudyStartsAt로 분류",
    },
  },
  SortGroup: {
    description: "참여자가 만든 묶음(그룹) 1개.",
    columns: {
      id: "묶음 ID(cuid)",
      sortSessionId: "소속 제출 ID",
      label: "참가자가 붙인 묶음 이름(선택 입력, 빈 문자열 가능)",
    },
  },
  SortGroupItem: {
    description: "묶음에 들어간 진술문 1개(묶음–진술문 연결). 같은 묶음에 같은 진술문은 1번만 가능(UNIQUE).",
    columns: {
      id: "연결 ID(cuid)",
      groupId: "묶음 ID",
      statementId: "진술문 ID",
    },
  },
  AnalysisRun: {
    description: "개념도 분석 1회 실행 결과(불변). 계산에 쓴 입력 스냅샷(개인정보 없음)·해시·파라미터·버전을 함께 보관해 재현 가능.",
    columns: {
      id: "분석 실행 ID",
      projectId: "프로젝트 ID",
      scope: "국가 범위(KR/JP/ALL)",
      executionStatus: "실행 상태(RUNNING/COMPLETED/FAILED)",
      errorCode: "실패 코드",
      errorMessageSafe: "실패 메시지(개인정보 없음)",
      startedAt: "시작 시각(UTC epoch ms)",
      finishedAt: "종료 시각(UTC epoch ms)",
      numericDataHash: "수치 입력 해시",
      statementStructureHash: "진술문 구조 해시",
      statementContentHashKo: "한국어 진술문 내용 해시",
      statementContentHashJa: "일본어 진술문 내용 해시",
      parameterHash: "분석 파라미터 해시",
      sourceSnapshotAt: "입력 스냅샷 기준 시각",
      inputSnapshot: "입력 스냅샷(JSON; 유사성 빈도·비율·비유사성 행렬 포함, 개인정보 없음)",
      parametersSnapshot: "파라미터·출처 스냅샷(JSON)",
      algorithmVersion: "알고리즘 버전",
      engineSourceCommitSha: "분석 엔진 소스 커밋",
      primaryMapDimension: "주 지도 차원",
      wardSourceDimension: "Ward 군집 입력 차원",
      linkageMethod: "연결 방식",
      dimensionsEvaluated: "평가한 차원 목록",
      include3dSupplement: "3차원 보충 포함 여부",
      statementCount: "진술문 수",
      nKr: "한국 유효 N",
      nJp: "일본 유효 N",
      nTotal: "전체 유효 N",
      includedParticipantCount: "포함 참여자 수",
      excludedNullCountry: "국가 없음으로 제외된 수",
      excludedIncomplete: "미완료로 제외된 수",
      excludedInvalid: "중복·무효로 제외된 수",
      dataset: "사용한 자료 범위(MAIN/PILOT/ALL_WITH_PILOT/LEGACY_PRE_SEGREGATION)",
      pilotCount: "포함된 파일럿 수",
      mainCount: "포함된 본조사 수",
      wardStatus: "Ward 결과 상태",
      wardLinkageSnapshot: "Ward 연결(JSON)",
      wardErrorCode: "Ward 오류 코드",
      wardErrorMessageSafe: "Ward 오류 메시지",
    },
  },
  AnalysisRunDimension: {
    description: "분석 실행의 차원별(1~6차원) MDS 결과.",
    columns: {
      id: "ID",
      analysisRunId: "분석 실행 ID",
      dimension: "차원 수",
      dimensionStatus: "COMPLETED/FAILED",
      coordinates: "좌표(JSON)",
      rawStress: "원 스트레스",
      commonStressDistance: "공통 스트레스(거리)",
      commonStressQ: "공통 스트레스(Q)",
      converged: "수렴 여부",
      iterations: "반복 횟수",
      bestInitIndex: "최적 초기값 번호",
      bestSeed: "최적 시드",
      stressHistory: "스트레스 이력(JSON)",
      normalizationMeta: "정규화 메타(JSON)",
      errorCode: "오류 코드",
      errorMessageSafe: "오류 메시지",
    },
  },
  AnalysisInterpretation: {
    description: "분석 해석(축·사분면 라벨·메모). 현재 0건.",
    columns: {
      id: "ID",
      analysisRunId: "분석 실행 ID",
      status: "DRAFT/FINALIZED",
      version: "버전",
      previousInterpretationId: "이전 해석 ID",
      selectedClusterCount: "선택 군집 수",
      axisLabels: "축 라벨(JSON)",
      quadrantLabels: "사분면 라벨(JSON)",
      notes: "메모",
      createdAt: "생성 시각",
      finalizedAt: "확정 시각",
    },
  },
  AnalysisClusterLabel: {
    description: "군집 라벨. 현재 0건.",
    columns: {
      id: "ID",
      analysisInterpretationId: "해석 ID",
      clusterIndex: "군집 번호",
      language: "ko/ja",
      label: "라벨",
      memo: "메모",
    },
  },
  AnalysisExecutionLock: {
    description: "분석 동시 실행 방지 잠금. 정상 상태에서는 0건.",
    columns: {
      id: "ID",
      projectId: "프로젝트 ID",
      scope: "국가 범위",
      analysisRunId: "분석 실행 ID",
      acquiredAt: "획득 시각",
    },
  },
  _prisma_migrations: {
    description: "Prisma 마이그레이션 적용 이력(스키마 버전). 복구 시 앱 코드의 prisma/migrations와 일치해야 함.",
    columns: {
      id: "ID",
      checksum: "마이그레이션 SQL 체크섬",
      finished_at: "완료 시각",
      migration_name: "마이그레이션 이름",
      logs: "로그",
      rolled_back_at: "롤백 시각",
      started_at: "시작 시각",
      applied_steps_count: "적용 단계 수",
    },
  },
};

export function assertDictionaryCovers(actual: Record<string, string[]>): void {
  const problems: string[] = [];
  for (const [table, cols] of Object.entries(actual)) {
    const doc = DATA_DICTIONARY[table];
    if (!doc) {
      problems.push(`undocumented table: ${table}`);
      continue;
    }
    for (const c of cols) if (!(c in doc.columns)) problems.push(`undocumented column: ${table}.${c}`);
    for (const c of Object.keys(doc.columns)) if (!cols.includes(c)) problems.push(`dictionary has unknown column: ${table}.${c}`);
  }
  for (const t of Object.keys(DATA_DICTIONARY)) if (!(t in actual)) problems.push(`dictionary table missing from DB: ${t}`);
  if (problems.length) throw new Error("Data dictionary out of sync with database:\n" + problems.join("\n"));
}

export function dictionaryMarkdown(): string {
  const lines: string[] = ["# 데이터 사전 (DATA_DICTIONARY)", ""];
  lines.push("시간 값은 별도 표기가 없으면 **UTC epoch 밀리초**(JavaScript `Date.getTime()`)입니다. 불리언은 0/1입니다.", "");
  for (const [table, doc] of Object.entries(DATA_DICTIONARY)) {
    lines.push(`## ${table}`, "", doc.description, "");
    if (doc.sensitive) lines.push(`> **민감정보**: ${doc.sensitive}`, "");
    lines.push("| 컬럼 | 설명 |", "|---|---|");
    for (const [c, d] of Object.entries(doc.columns)) lines.push(`| \`${c}\` | ${d.replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  return lines.join("\n");
}
