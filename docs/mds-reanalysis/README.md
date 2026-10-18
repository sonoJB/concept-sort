# 2차원 MDS 재분석·개념도·국가별 분석자료 (엔진 v2.0.0)

이 문서는 엔진 v2 로 바뀐 점, 실행·검증·배포 절차, 알려진 한계를 적습니다. 비밀값(관리자 토큰·키)은 어디에도 적지 않습니다.

## 1. 무엇이 바뀌었나

| 항목 | 이전(v1) | 현재(v2) |
|---|---|---|
| 수렴 판정 | Stress-1이 직전보다 커지면 `STRESS_INCREASED`로 실패 처리 | raw stress의 상대 감소 `(σ_{k-1}−σ_k)/σ_{k-1} ≤ ε`. Stress-1은 판정에 쓰지 않음. 목적함수 증가는 `OBJECTIVE_INCREASED`, 반복 상한은 `MAX_ITER`로 구분 |
| 최종 해 선택 | 유한한 Stress-1이 가장 작은 시작(미수렴·오류 포함 가능) | 오류 없이 **수렴한** 시작 중 raw stress 최소. 수렴한 시작이 없으면 `NO_CONVERGED_CANDIDATE`이며 실행은 `MDS_NOT_CONVERGED`로 실패하고 군집분석을 하지 않음 |
| 설정 | 8회 시작, 300회, 1e-9 | 64회 시작, 시작당 10,000회, 1e-9 → 선택한 해를 1e-12로 계속(엄격 재검증) |
| 지표 | 시점이 다른 값이 섞일 수 있음 | 최종 좌표에서 raw stress·Stress-1·RSQ를 다시 계산해 저장(`evaluateConfiguration`) |
| Stress-1 | `√(σ_raw/Σd²)` — 분자는 명시적으로 정규화한 디스패리티 d̂(Σd̂²=q), 분모는 Σd². scikit-learn `normalized_stress`와 같은 정의(오류가 아닌 다른 정의) | Kruskal Stress-1 `√(Σ(d̂*−d)²/Σd²)` — d̂*는 크기 제약 없는 단조 회귀값. 국소 최소에서 √(σ_raw/q)와 같음(Mair et al., 2022, p. 4 식 4; 계산으로 확인). 이전 정의 값도 항상 함께 보고 |
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

`scripts/package/build_packages.py`가 저장된 결과 묶음(API)과 같은 자료 시점의 가명 응답에서 세 ZIP을 만듭니다(그림은 CJK 글꼴이 있는 로컬에서 생성). 빌드는 결정적이어서(고정 타임스탬프·고정 시드·무작위 ID 제거) 같은 입력과 같은 코드면 ZIP 바이트가 같습니다. 업로드는 `scripts/package/upload_packages.py`(= `PUT .../runs/<id>/package`) — 서버가 매니페스트의 실행 ID·자료 지문·파일별 SHA-256을 모두 대조하고, DB의 실제 이름·전화·세션 ID·토큰이 어떤 텍스트 파일에도 없는지 검사하며(숫자만의 식별자는 참여자 응답 폴더에서만), 본조사(MAIN) 실행에만 등록을 허용합니다. ZIP 본문은 DB 옆 `analysis-packages/<sha256>.zip`(읽기 전용, 한 번만 기록)에 두고 DB에는 메타데이터만 둡니다.

**보존**: 서버 자동 백업(`auto-backup.mjs`)이 백업 폴더마다 `analysis-packages/`를 함께 담습니다(같은 볼륨의 하드링크라 공간이 늘지 않고, 이후 원본 파일이 지워져도 백업의 링크는 남음). 매니페스트에 이름·크기·SHA-256이 기록되고 `verifyBackupDir`가 모두 검증합니다. 연구자 PC에도 최종 ZIP·재현 자료를 새 결과 폴더에 보관합니다.

## 5. 오류가 확인된 이전 분석의 교체 (범위 제한)

대상은 `dataset = MAIN` · `scope ∈ {KR, JP, ALL}` · 알고리즘 버전이 오류 확인 목록(`ERRONEOUS_ALGORITHM_VERSIONS` = `1.0.0`)에 명시된 실행뿐입니다. "현재 버전이 아님"만으로는 삭제하지 않으며 파일럿·점검용(`PILOT`, `ALL_WITH_PILOT`)·레거시·다른 버전 실행은 대상이 아닙니다.

1. `GET .../analysis/cleanup-superseded` — 삭제하지 않고 정확한 대상 목록·건수·종속 행 수와 사전 조건 충족 여부를 조회.
2. `POST` — `{confirm, algorithmVersions:["1.0.0"], runIds:[…]}`; `runIds`가 방금 조회한 대상과 정확히 같아야 하고, 사전 조건을 그 순간 다시 검증: 세 범위 모두 현재 버전의 최신·완료·수렴(주 실행·엄격 계속 모두) 결과가 있고, 연결 ZIP 파일이 디스크에 있고 SHA-256·매니페스트(실행 ID·지문·파일별 해시·미등록 파일 없음)가 맞으며, N(전체)=N(한국)+N(일본)·S(전체)=S(한국)+S(일본)·진술문 구조 동일.
3. 삭제는 한 트랜잭션에서 하며 안에서 원자료 테이블 행 수와 대상 밖 실행·패키지 수가 불변임을 확인하고, 어긋나면 롤백. 원자료 테이블에는 `AnalysisRun`을 가리키는 외래 키가 없어 연쇄 삭제가 일어나지 않음.
4. 전후 원자료 행·컬럼 비교: `scripts/mds/verify_raw_preservation.py`.

## 6. 검증 스크립트

| 목적 | 스크립트 |
|---|---|
| 기존 Excel과 독립 재집계 비교 | `scripts/mds/verify_inputs.py` |
| MDS 독립 구현(numpy) 교차검증 | `scripts/mds/crossval.py` |
| Ward·실루엣·볼록껍질·분할 신뢰도·상관 교차검증 | `scripts/mds/crossval_clusters.py` |
| 패키지 안 독립 재현 | `scripts/package/reproduce_mds.py` |
| 패키지 개인정보 검사 | `scripts/package/pii_scan.py` |
| 내려받은 ZIP을 풀어 전체 검증 | `scripts/package/verify_package_zip.py` |
| 외부 라이브러리 비교(scikit-learn) | `scripts/mds/external_check_sklearn.py` |
| Stress 변화 분해(수렴 효과 vs 정의 효과) | `scripts/mds/decompose_stress.py` |
| 패키지 재생성·재등록 | `scripts/package/regenerate_packages.py` |
| 원자료 보존(행·컬럼) | `scripts/mds/verify_raw_preservation.py` |

## 7. 알려진 한계

- 여러 시작 중 최저 해이며 전역 최적의 증명이 아닙니다.
- 2차원 Stress-1은 Kruskal 구술 척도의 poor(0.20)보다 큽니다(범위별 값은 결과 화면·보고서 참조). 개념도 비교 범위(0.205–0.365)는 2차 인용이며 Rosas & Kane(2012) 원문 위치는 확인하지 못했습니다.
- RSQ·실루엣·분할 신뢰도의 양호 기준은 원문에서 확인하지 못해 판정하지 않습니다. 브리징 값은 산식 미확인으로 산출하지 않습니다. 평정 자료는 수집되지 않았습니다.
- 군집 수·군집명은 자동 제안입니다. 번역 동등성·표집·내용 타당도 검토는 포함되지 않습니다.
- 운영 관리자 화면 검증은 토큰이 URL에 들어가므로 작업자가 직접 열지 않았습니다(API와 로컬 동일 빌드 검증으로 대체; 최종 보고의 구분 참조).

## 8. 복구 절차 (DB 복원 후 ZIP 3종)

1. 서버 쓰기를 멈추고(`MAINTENANCE` 파일) `restore-tool.mjs replace --candidate <백업 DB>`로 DB를 교체한 뒤 서비스를 재시작합니다(기존 절차).
2. 같은 백업 폴더에서 패키지를 되돌립니다: `node scripts/backup/restore-tool.mjs restore-packages --from <백업 폴더>` — 쓰기 한 번(같은 이름·다른 내용이면 중단), 끝에 모든 `AnalysisPackage` 행을 디스크 파일과 대조합니다. 이후 `check-packages`로 언제든 재확인.
3. 파일이 없는 행이 보고되면(백업에 ZIP이 없던 경우 등) **재생성**합니다: `python -X utf8 scripts/package/regenerate_packages.py --base-url … --slug … --token-env <환경변수 이름> --db <복원된 DB> --repo . --evidence <근거 폴더> --out <작업 폴더> --upload` — 저장된 분석 결과(API)와 복원된 DB의 가명 응답으로 같은 코드·설정으로 다시 만들고 서버가 다시 검증해 등록합니다. `--compare-stored`는 ZIP 해시 일치와, 다를 때 분석 내용/재현 도구/색인 파일 차이를 구분해 보고합니다.
4. 비교 해석: ZIP 해시가 같으면 전부 같은 것입니다. 해시가 달라도 `분석 내용` 차이가 0이면 분석 결과는 같고, 제작 도구 복사본(코드가 바뀐 경우)과 그 해시를 적은 색인(`manifest.json`·`SHA256SUMS.txt`·`파일목록.csv`)만 다른 것입니다.

격리 환경 리허설(2026-10-18, 로컬): ① 백업에 ZIP 3개 포함 → 새 볼륨에 DB만 복원(파일 없는 행 3개) → `restore-packages` → 별도 서버에서 3개 다운로드, 원본과 SHA-256 일치·ZIP 검증 전 항목 통과 ② ZIP 폴더 삭제 후 `regenerate_packages.py --upload` → 3개 재등록·다운로드 검증 통과, 원본과의 차이는 분석 내용 0 / 제작 도구 4 / 색인 3개 파일.
