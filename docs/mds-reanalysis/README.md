# 2차원 MDS 재분석·개념도·국가별 분석자료 (엔진 v2.0.0)

이 문서는 엔진 v2 로 바뀐 점, 실행·검증·배포 절차, 알려진 한계를 적습니다. 비밀값(관리자 토큰·키)은 어디에도 적지 않습니다.

## 1. 무엇이 바뀌었나

| 항목 | 이전(v1) | 현재(v2) |
|---|---|---|
| 수렴 판정 | Stress-1이 직전보다 커지면 `STRESS_INCREASED`로 실패 처리 | raw stress의 상대 감소 `(σ_{k-1}−σ_k)/σ_{k-1} ≤ ε`. Stress-1은 판정에 쓰지 않음. 목적함수 증가는 `OBJECTIVE_INCREASED`, 반복 상한은 `MAX_ITER`로 구분 |
| 최종 해 선택 | 유한한 Stress-1이 가장 작은 시작(미수렴·오류 포함 가능) | 오류 없이 **수렴한** 시작 중 raw stress 최소. 수렴한 시작이 없으면 `NO_CONVERGED_CANDIDATE`이며 실행은 `MDS_NOT_CONVERGED`로 실패하고 군집분석을 하지 않음 |
| 설정 | 8회 시작, 300회, 1e-9 | 64회 시작, 시작당 10,000회, 1e-9 → 선택한 해를 1e-12로 계속(엄격 재검증) |
| 지표 | 시점이 다른 값이 섞일 수 있음 | 최종 좌표에서 raw stress·Stress-1·RSQ를 다시 계산해 저장(`evaluateConfiguration`) |
| Stress-1 | 분모는 Kruskal식, 분자는 명시적 정규화 디스패리티(두 정규화 혼합) | Kruskal Stress-1 (암묵적 정규화). 국소 최소에서 √(raw/q)와 같음(Mair et al., 2022, p. 4 식 4)을 계산으로 확인 |
| 종료 사유 | 저장·표시되지 않음(UI가 반복 횟수로 추정) | 주 실행·엄격 계속 각각의 종료 사유, 반복 수, 최종 변화량, 모든 시작의 결과를 저장·표시 |

코드: `src/lib/conceptAnalysis/smacofV2.ts`, 분석 묶음: `src/lib/conceptMap/*`, 실행: `src/lib/analysis/executionService.ts`.
v1 엔진(`smacof.ts`)은 결함 재현(`scripts/mds/diagnose-old-engine.ts`)을 위해서만 남겨 두었고 운영 경로에서 쓰지 않습니다.

## 2. 입력 행렬

개인 이진 유사성(같은 묶음 1, 다른 묶음 0, 대각선 1)의 합 S(대각선 N), P=S/N, D=N−S, **δ=1−S/N(대각선 0)** 이 MDS 입력입니다. 유사성이 높은 쌍이 더 가깝게 배치됩니다. 기존 Excel의 `빈도행렬`은 S의 대각선만 0으로 표시한 것이며 비유사성이 아닙니다.

## 3. 분석 실행과 저장

- `POST /api/projects/<slug>/analysis/runs {scope, dataset:"MAIN"}` (관리자 Bearer 토큰) — 한 범위당 약 1~2분(동기 실행).
- 결과는 `AnalysisRun.resultBundle`(JSON)과 `AnalysisRunDimension`에 저장되고 불변입니다. 참여자 단위 기록은 가명 ID(`KR-001`…)로 `inputSnapshot.participants`에 저장되며 이름·전화번호·세션 ID는 없습니다.
- 군집 추천·군집명 제안은 `src/lib/conceptMap/proposals/data.ts`(`scripts/mds/gen_proposals.py`가 생성)이며 **군집 소속 서명이 일치할 때만** 결과에 붙습니다. 상태는 `AUTO_PROPOSED`(자동 제안·연구자 검토 전)입니다.

## 4. 국가별 ZIP

`scripts/package/build_packages.py`가 저장된 결과 묶음(API)과 같은 자료 시점의 가명 응답에서 세 ZIP을 만듭니다(그림은 CJK 글꼴이 있는 로컬에서 생성). 업로드는 `PUT .../runs/<id>/package` — 서버가 매니페스트의 실행 ID·자료 지문·파일별 SHA-256을 모두 대조합니다. ZIP 본문은 DB가 아니라 DB 옆 `analysis-packages/` 폴더(`<sha256>.zip`)에 두고 DB에는 메타데이터만 둡니다. **이 폴더는 DB 백업에 포함되지 않으므로** 패키지는 결과 묶음과 스크립트로 언제든 다시 만들 수 있습니다.

## 5. 이전 분석 결과 삭제

`POST .../analysis/cleanup-superseded {confirm:"DELETE_SUPERSEDED_DERIVED_RESULTS"}` — 세 범위 모두에 현재 버전의 완료 결과와 ZIP이 있을 때만, 이전 버전 `AnalysisRun`과 거기에 딸린 행(차원·해석·라벨·락·패키지)만 삭제합니다. 원자료 테이블에는 `AnalysisRun`을 가리키는 외래 키가 없어 연쇄 삭제가 일어나지 않습니다. 삭제 전후 원자료 행·컬럼 비교: `scripts/mds/verify_raw_preservation.py`.

## 6. 검증 스크립트

| 목적 | 스크립트 |
|---|---|
| 기존 Excel과 독립 재집계 비교 | `scripts/mds/verify_inputs.py` |
| MDS 독립 구현(numpy) 교차검증 | `scripts/mds/crossval.py` |
| Ward·실루엣·볼록껍질·분할 신뢰도·상관 교차검증 | `scripts/mds/crossval_clusters.py` |
| 패키지 안 독립 재현 | `scripts/package/reproduce_mds.py` |
| 패키지 개인정보 검사 | `scripts/package/pii_scan.py` |
| 원자료 보존(행·컬럼) | `scripts/mds/verify_raw_preservation.py` |

## 7. 알려진 한계

- 여러 시작 중 최저 해이며 전역 최적의 증명이 아닙니다.
- 2차원 Stress-1은 Kruskal 구술 척도의 poor(0.20)보다 큽니다(범위별 값은 결과 화면·보고서 참조). 개념도 비교 범위(0.205–0.365)는 2차 인용이며 Rosas & Kane(2012) 원문 위치는 확인하지 못했습니다.
- RSQ·실루엣·분할 신뢰도의 양호 기준은 원문에서 확인하지 못해 판정하지 않습니다. 브리징 값은 산식 미확인으로 산출하지 않습니다. 평정 자료는 수집되지 않았습니다.
- 군집 수·군집명은 자동 제안입니다. 번역 동등성·표집·내용 타당도 검토는 포함되지 않습니다.
- 운영 관리자 화면 검증은 토큰이 URL에 들어가므로 작업자가 직접 열지 않았습니다(API와 로컬 동일 빌드 검증으로 대체; 최종 보고의 구분 참조).
