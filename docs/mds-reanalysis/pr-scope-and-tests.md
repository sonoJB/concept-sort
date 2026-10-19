# PR #18 — 전체 범위와 테스트 대응표

> **결과(2026-10-19)**: PR #18은 `main` `86e7203`으로 병합·배포됐습니다(자세한 내용 `README.md` 9절). 최종 검증 수치는 테스트 49개 파일·529개 통과, `tsc`·`eslint`(오류 0)·`next build` 통과입니다. 이 문서의 "추가 63 · 수정 27 · 삭제 26" 등 범위 수치는 작성 시점 기준이며 이후 검토 라운드의 수정이 모두 반영됐다고 확인하지는 않았습니다. 공식 리뷰어 승인은 없었고(리뷰 0건) AI 서브에이전트 검토와 작성자 검토로 진행했습니다.

## 1. 변경 범위 (diff 기준, `origin/main` 대비)

작업 중 편집 도구가 보여 준 "33개 편집"은 파일 편집 연산의 집계일 뿐 PR의 범위가 아닙니다. PR의 실제 범위는 아래와 같습니다(추가 63 · 수정 27 · 삭제 26, 합계 116개 파일).

| 영역 | 추가 | 수정 | 삭제 | 내용 |
|---|---:|---:|---:|---|
| MDS 엔진 `src/lib/conceptAnalysis` | 1 | 0 | 0 | `smacofV2.ts` (v1 `smacof.ts`는 결함 재현용으로만 남김, 운영 경로에서 쓰지 않음) |
| 개념도 분석 라이브러리 `src/lib/conceptMap` | 13 | 0 | 0 | 행렬, Ward 군집·실루엣·볼록껍질, 분할 신뢰도, 한일 비교, 지표·출처 카탈로그, 군집명 제안 |
| 분석 서비스 `src/lib/analysis` | 4 | 7 | 0 | 실행 서비스(v2 연결), 스냅샷(가명 참여자), 패키지 저장·검증, 삭제 가드 |
| 분석 API 라우트 | 4 | 1 | 1 | 새: `bundle`·`overview`·`package`·`cleanup-superseded` / 수정: 실행 상세 / 삭제: `export-data` |
| 분석 화면 | 3 | 0 | 6 | 새 `ConceptMapPanel`·`MapFigure`·`Charts` / 삭제: 기존 분석·내보내기 화면 6개 |
| 기존 내보내기 보조 코드 `src/lib/analysis/view` | 0 | 0 | 17 | 기존 내보내기(HTML/ZIP/CSV/SVG)와 화면 상태 코드 — 새 설계에서는 서버 ZIP으로 대체 |
| DB | 1 | 1 | 0 | 가산형 마이그레이션(`resultBundle`, `AnalysisPackage`) |
| 백업·복구 `scripts/backup` | 0 | 5 | 0 | 패키지 ZIP을 백업과 함께 보관·검증, `restore-packages`·`check-packages`, 데이터 사전 |
| 검증·재현 `scripts/mds` | 18 | 0 | 0 | 독립 재집계, numpy·scikit-learn 교차검증, 원자료 보존 비교, 민감도 |
| 패키지 제작 `scripts/package` | 12 | 0 | 0 | 국가별 ZIP 제작·검증·재생성·업로드, 개인정보 검사 |
| 테스트 | 6 | 10 | 2 | 아래 대응표 |
| 문서·기타 | 1 | 3 | 0 | |

## 2. 삭제·교체한 테스트와 대응표

테스트 총개수가 아니라 **무엇을 보장하던 테스트인지**로 대응시켰습니다.

| 삭제한 테스트(보장하던 것) | 대체 | 비고 |
|---|---|---|
| `exportData.integration` — CURRENT 실행만 내보내기 가능 | `analysisRoutesGuards` "a current COMPLETED run is exposed as official…" | 새 경로 `bundle` |
| 〃 — 새 응답 도착(numeric stale) 차단 | `analysisRoutesGuards` "numeric stale …" (bundle 본문 차단 + package 다운로드 409) | |
| 〃 — KO/JA 내용 변경이 언어별로 차단 | 〃 (KO·JA 각각) | 범위별 정책(JP 실행은 일본어만 관련)도 검증 |
| 〃 — 게시 준비 안 됨 차단 | 〃 "publication" | |
| 〃 — 파라미터 불일치(superseded) 차단 | 〃 "parameters" | |
| 〃 — FAILED 실행 차단 | 〃 "a FAILED run shows its failure…" | 새 정책: 실패 사유를 보여 주되 공식 결과·다운로드·ZIP 등록은 불가 |
| 〃 — 다른 프로젝트 404, 인증 401 | 〃 "authentication and project isolation…" | bundle·package(GET/PUT)·overview·cleanup(GET/POST) 전부 |
| 〃 — PII·bestSeed(부호) 감사 | 〃 "seeds are unsigned", "personal-data marker audit" | 이름·전화·묶음 이름 마커가 스냅샷·결과에 없음 |
| `exportPrivacyPipeline.integration` — 어떤 내보내기 산출물에도 비밀 마커 없음 | ① 위 마커 감사 ② 업로드 시 서버 개인정보 가드(`conceptMapPipeline` "rejects an upload that contains personal data…", 숫자 전용 식별자 규칙) ③ `pii_scan.py`(패키지 전체 텍스트 검사) | 기존은 클라이언트 생성 산출물, 새 설계는 서버가 업로드를 검사 |
| 〃 — FINALIZED 해석만 공식 ZIP | **대응 없음(의도적 폐기)** | 해석 확정(FINALIZED) 절차 자체가 새 설계에 없음. 대신 군집 추천·명칭은 모든 화면·파일에 "자동 제안(연구자 검토 전)"으로 표시하고 `attachNaming`·`SCOPE_PROPOSALS` 테스트가 상태가 AUTO_PROPOSED뿐임을 고정 |
| `view/exportGate` — 내보내기 자격 판정 | `analysisRoutesGuards`(위) + `isResultBodyExposable` 사용 | 같은 함수를 새 라우트가 사용 |
| `view/clusterCut` — k 범위, 소속 1..k, 결정성, 중심 | `conceptMap` + `csvAndNaming` (k<1·k>n 거부, 결정성, 중심=평균, 번호 규칙) | |
| `view/csvAndEscaping` — CSV 왕복, XSS 마커 | `csvAndNaming`(CSV 왕복·XSS 마커 inert), `test_report_escaping.py`(HTML 이스케이프) | 새 화면은 React(자동 이스케이프) |
| `view/quadrant` — 사분면 배정 경계 정책 | **대응 없음** | 새 화면은 사분면에 배정 로직이 없고 x=0·y=0 기준선만 그림. 축 등비·원점 중심은 `mapModel` 테스트 |
| `view/uiState` — 실행 버튼 활성, 3D 탭 등 | `execution.integration`(N=0 거부, 이미 있음), 새 화면 상태는 서버 응답에서 파생 | 화면 로직은 상태 변수 없이 파생 |
| `engineAdapter.test` — 완료/실패 구분, converged=false도 COMPLETED, Ward 규칙 | 새 `engineAdapter.test` | 이제 "수렴 아님 + 주 해 실패 시 Ward·군집 없음"까지 검증 |

## 3. 약화 여부 점검 (요청 항목별)

- **인증**: 새 라우트 5종(+PUT/POST)이 모두 Bearer 없음·틀린 토큰에서 401, 다른 프로젝트 토큰으로 404. 기존 `auth.test`·`api.integration`은 그대로 통과.
- **개인정보**: 기존 내보내기 마커 검사를 ①저장 결과 감사 ②업로드 서버 가드 ③패키지 전체 스캔으로 대체. 서버 가드는 DB의 실제 이름·전화·세션 ID·토큰으로 검사하고 값은 응답에 싣지 않음.
- **파일럿/본조사 구분**: 기존 `pilotMainSegregation*` 테스트는 수정 없이 통과. 새로 PILOT 실행에 패키지 등록 거부, overview 공식 결과에서 제외, 삭제 대상에서 제외를 테스트.
- **다운로드**: `package` GET은 최신성 게이트를 적용하고 파일 SHA-256을 다시 확인, 헤더의 한글 파일명 인코딩 테스트. **기존 국가별 행렬 다운로드**(`official-matrix`)와 그 테스트는 변경 없음.
- **원자료 보존**: 삭제 전후 행·컬럼 해시 비교 테스트(`conceptMapPipeline`), 운영 전후 비교 스크립트 `verify_raw_preservation.py`.
- 테스트 개수만으로 판단하지 않았으며, 위 표에서 대응이 없는 두 항목(FINALIZED 게이트, 사분면 배정)은 설계 폐기로 인한 것임을 명시했습니다.
