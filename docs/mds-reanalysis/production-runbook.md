# 운영 실행 순서 (병합·배포 이후)

비밀값은 어느 명령에도 적지 않습니다. 관리자 토큰은 환경변수 **이름**(`CS_ADMIN_TOKEN`)으로만 전달하며, 값은 로컬 DB 사본에서 읽어 환경변수에 넣되 출력하지 않습니다.

## 0. 이미 끝난 것
- 배포 직전 검증 백업: `…\concept-sort-research-backups\20261018T101212Z_pre-mds-v2-reanalysis\`(SHA-256 `f81b44cf…`, 서버 볼륨 `/data/backups/pre-mds-v2_20261018T101212Z`). 원자료 5개 테이블은 v2 백업과 행·컬럼 단위로 동일(`raw_unchanged_since_v2.json`).
- 병합 뒤 배포 시작 때 `pre-migrate-guard`가 마이그레이션 전에 서버 백업을 한 번 더 만든다(실패하면 배포가 멈춘다).

## 1. 병합·배포 확인
1. PR #18 병합(검토·승인 필요) → Railway 자동 배포.
2. 배포 커밋 확인: `railway ssh` 안에서 `RAILWAY_GIT_COMMIT_SHA`, `/data/backups/status.json`(새 백업 OK), 마이그레이션 9개 적용.

## 2. 운영 재분석 (범위당 약 1~2분, 동기 실행)
계산이 서버의 단일 Node 프로세스에서 돌아 그동안 같은 서버의 다른 요청(참여자 제출·화면)이 지연됩니다. 조사는 종료됐지만 실행 전에 최근 제출이 없는지 확인하고(`SortSession` 최신 `createdAt`), 세 범위를 **차례로** 실행하며(동시 실행 금지), 클라이언트 제한 시간은 15분 이상(`curl -m 900`)으로 합니다. 응답이 끊겨도 서버 실행은 계속되며 같은 범위를 다시 보내면 `RUN_ALREADY_RUNNING`입니다 — 15분이 지나기 전에는 다시 보내지 말고 `GET …/runs`로 상태를 확인합니다. 예외가 나면 실행은 `FAILED(ANALYSIS_EXCEPTION)`로 닫히고 잠금이 풀립니다.
`POST /api/projects/rrrvvnux/analysis/runs {"scope":"KR|JP|ALL","dataset":"MAIN"}` 를 세 번. 응답이 `COMPLETED`이고 `GET …/runs/<id>/bundle`의 `officialResult:true`인지 확인. 로컬 동일 빌드 결과와 좌표가 같은지(비트 단위) 대조.

## 3. 국가별 ZIP 생성·검증·등록
1. 운영 DB 사본으로 가명 응답 내보내기(`scripts/mds/export-raw.ts`), 번들 3개 내려받기.
2. `python -X utf8 scripts/package/build_packages.py --bundles <dir> --raw <raw.json> --out <새 결과 폴더> --repo . --evidence <근거 폴더>`
3. 각 ZIP: `python -X utf8 scripts/package/verify_package_zip.py <zip> --expect-scope <S> --expect-n <N> --extract-to <dir> --db <운영 사본 DB> --reproduce`
4. `python -X utf8 scripts/package/upload_packages.py --base-url https://concept-sort-production.up.railway.app --slug rrrvvnux --token-env CS_ADMIN_TOKEN <zip…>`
5. 내려받기 API로 받은 ZIP의 SHA-256이 로컬 ZIP과 같은지, 다시 `verify_package_zip.py`.

## 4. 제한된 이전 분석 삭제
1. `GET …/analysis/cleanup-superseded` — 대상 목록(예상: 본조사 KR v1 실행 1건)·건수·`preconditions.ok:true` 확인. 파일럿·레거시 6건은 대상이 아님.
2. 삭제 직전 서버 백업(`node scripts/backup/auto-backup.mjs --once --reason pre-cleanup`)과 로컬 사본.
3. `POST` (`confirm`, `algorithmVersions:["1.0.0"]`, 조회된 `runIds`).
4. 삭제 후 사본과 직전 사본을 `python -X utf8 scripts/mds/verify_raw_preservation.py <전> <후>`로 비교(원자료 변경 0건).

## 5. 최종 확인
- API: overview 3범위 official·package, bundle·package 응답 ↔ 로컬 결과 일치.
- 서버 백업에 새 ZIP 3개가 포함됐는지(`manifest.json`의 `analysisPackages`이며 `analysisPackageProblems`는 비어 있어야 함 — 손상된 ZIP은 백업을 막지 않고 이 항목에만 기록됨), `node scripts/backup/restore-tool.mjs check-packages`.
- 운영 관리자 화면은 토큰이 주소에 들어가므로 작업자가 직접 열지 않는다 — 사용자가 확인하거나 미확인으로 기록. 같은 빌드·같은 데이터의 로컬 화면 확인과 구분해 보고.
- 연구자 PC 새 결과 폴더(`concept-sort-research-backups\<시각>_mds-v2-reanalysis-results\`)에 최종 ZIP 3종, 근거 폴더, 번들 JSON, 검증 출력, 재현 코드(스냅샷 커밋)를 보존. 기존 v1·v2 백업, D: 패키지, 키는 건드리지 않는다.
- 인수인계 문서(`인수인계_한페이지.md`)와 날짜별 기록에 실제 완료·미완료를 갱신.
