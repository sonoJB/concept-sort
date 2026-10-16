# 복구 절차서 (README_복구절차서)

연구: **사이버폭력의 특징** (slug `rrrvvnux`) · 백업 묶음: `{{LABEL}}` · 이 묶음을 만든 코드 커밋: `{{COMMIT}}` · 스키마 마지막 마이그레이션: `{{LAST_MIGRATION}}`

> ⚠ `db/`, `export/`, `changelog/` 에는 **개인정보**(이름·전화번호 등)와 `db/` 안의 **관리자 토큰**이 들어 있습니다. 공개 저장소·이메일·공유 폴더에 올리지 마세요.
> 서버 밖(외부 드라이브·클라우드 등)에 두는 사본은 반드시 **암호화본(`.enc`)** 으로 두고, **키는 암호화본과 다른 곳**(비밀번호 관리자·오프라인 매체)에 보관하세요. 이 문서에는 비밀값이 없습니다.

## 0. 먼저 알아둘 것

### 파일

| 파일 | 용도 |
|---|---|
| `db/*.db` | **복원용 SQLite 전체 백업**. 서비스를 그대로 되살리는 1순위 파일 |
| `export/json/*.json` | 표별 원자료. `.db`를 쓸 수 없을 때 DB를 다시 만드는 용도(관리자 토큰은 제외) |
| `export/csv/*.csv` | 표별 원자료 CSV(UTF-8 BOM). 사람이 훑어보는 용도 — Excel로 열면 앞자리 0이 사라질 수 있으니 JSON/xlsx를 기준으로 사용 |
| `export/연구원자료_전체.xlsx` | 연구자 열람용(참여자·분류결과·진술문·설정·분석실행). 개인정보 포함 |
| `matrices/본조사_유사성행렬_*.xlsx` | 전체/한국/일본 본조사 유사성 행렬 3종(비식별) |
| `changelog/` | 한국 전화번호 정비의 변경 전·후 값 기록(개인정보 포함, 접근 제한 파일) |
| `code/concept-sort_*.zip` | 배포된 소스 코드(비밀값 없음). GitHub 없이도 서비스를 다시 세울 수 있음 |
| `MANIFEST.json` / `SHA256SUMS.txt` | 파일 목록·건수·버전·체크섬 |
| `VERIFICATION_REPORT.md` | 이 묶음을 실제로 복원해 본 검증 결과 |
| `DATA_DICTIONARY.md` | 표·컬럼 설명, Excel 시트별 정의(대각선 포함) |

### '읽기 전용 파일'과 '불변 보관'은 다릅니다

이 묶음과 서버의 백업 파일에는 읽기 전용 속성(0444 / Windows 읽기 전용)을 걸어 두었지만, 이것은 **실수로 고치거나 지우는 것을 막는 표시**일 뿐입니다. 파일 소유자·관리자는 속성을 풀고 지울 수 있고, 디스크 고장·계정 삭제·랜섬웨어는 막지 못합니다. 변경·삭제를 기술적으로 막는 **불변(immutable) 보관**(예: 객체 잠금/WORM이 켜진 저장소)은 현재 구성되어 있지 않습니다.

### 암호화본 열기 (필요한 경우)

Node.js 22 이상이 있는 컴퓨터에서, 저장소(또는 `code/` 안 zip을 푼 폴더)의 `scripts/backup/crypt.mjs` 를 사용합니다. 키 파일 내용은 화면에 출력되지 않습니다.

```bash
node scripts/backup/crypt.mjs decrypt --in 묶음.zip.enc --out 묶음.zip --key-file 키파일경로
```

### 무결성 확인 (복구 전에 항상)

묶음 폴더에서 — Git Bash/Linux/macOS:

```bash
sha256sum -c SHA256SUMS.txt
```

PowerShell: `Get-FileHash <파일> -Algorithm SHA256` 값을 `SHA256SUMS.txt` 의 같은 파일 줄과 비교합니다.

### 서버에서 명령을 실행하는 방법 (Railway)

1. Railway CLI 설치 후 `railway login`
2. 프로젝트 연결(이 폴더에서 한 번): `railway link -p adequate-magic -e production -s concept-sort`
3. 컨테이너 안에서 명령 실행: `railway ssh "명령"` — **서비스가 실행 중인 배포가 있어야** 접속됩니다(중지·삭제된 서비스에는 접속할 수 없고, 계속 죽고 다시 뜨는 중이면 접속이 불안정합니다. → 아래 'C 상황' 참조).
4. 컨테이너 안 앱 폴더는 `/app`, 데이터 볼륨은 `/data` (DB 파일 `/data/prod.db`).

**파일을 서버로 보내는 방법** (`scp`나 별도 SSH 설정이 필요 없는, `railway ssh` 만 쓰는 방식 — 이 방법으로 1.6 MB DB 파일이 SHA-256 일치로 전송됨을 확인함):

- Git Bash / Linux / macOS:
  ```bash
  base64 -w0 로컬파일.db | railway ssh "tr -d '\r\n' | base64 -d > /data/restore-candidate.db && sha256sum /data/restore-candidate.db"
  ```
- PowerShell:
  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("로컬파일.db")) | railway ssh "tr -d '\r\n' | base64 -d > /data/restore-candidate.db; sha256sum /data/restore-candidate.db"
  ```
  출력된 SHA-256 이 로컬 파일의 값과 같아야 합니다. (`/data` 에 두면 볼륨 용량을 쓰므로 확인 후 불필요한 후보 파일은 사람이 직접 정리하세요 — 자동 삭제는 없습니다.)

## 1. 장애 유형별 복구

### A. 웹앱이 안 열림 / 배포 실패 (DB는 정상)

데이터는 볼륨(`/data/prod.db`)에 있으므로 **DB 복원은 필요 없습니다.**
1. Railway 대시보드 → 프로젝트 `adequate-magic` → 서비스 `concept-sort` → Deployments 에서 마지막으로 성공한 배포를 **Redeploy**.
2. 안 되면 GitHub `sonoJB/concept-sort` 의 커밋 `{{COMMIT}}` 으로 배포.
3. 배포 후 `https://concept-sort-production.up.railway.app/p/rrrvvnux/sort` 가 열리고 관리자 화면의 참가자 수가 그대로인지 확인.

서버는 시작할 때마다 `scripts/backup/pre-migrate-guard.mjs` 를 먼저 실행합니다.
- **적용할 마이그레이션이 있거나 마이그레이션 기록이 비정상이면**, 현재 DB의 복원 가능한 백업이 검증되지 않는 한 **마이그레이션을 실행하지 않고 시작을 중단**합니다(이전 정상 배포가 계속 서비스). 로그에 `[guard] BLOCKED (…)` 와 이유가 남습니다.
- 적용할 것이 없으면 백업을 시도하되, 실패해도 정상 서비스를 멈추지는 않고 관리자 화면에 실패로 표시합니다.
- **DB 파일이 없는데 백업이 있는 볼륨**, 빈 DB, 볼륨 밖의 DB 경로는 '새 설치'로 취급하지 않고 시작을 막습니다(빈 DB가 새로 만들어지는 사고 방지). 의도한 새 설치라면 한 번만 환경변수 `ALLOW_NEW_DATABASE=1` 을 지정합니다.

### B. DB 손상 · 실수로 삭제/수정 (서비스는 실행 중, 볼륨은 살아 있음) — 서비스를 멈추지 않는 방식

> 핵심 원칙: 실행 중인 서버는 **예전 DB 파일을 계속 열고 있습니다.** Railway(리눅스) 컨테이너에서 파일을 바꾸면, 재시작 전의 서버는 옛 데이터를 계속 보여 주고 쓰기는 SQLite가 `attempt to write a readonly database`(SQLITE_READONLY_DBMOVED)로 거부합니다(리눅스 임시 폴더의 가짜 DB로 확인함 — 조용히 옛 파일에 기록되지는 않지만, 재시작 전까지 제출은 실패하고 화면은 옛 데이터). 그래서 **① 쓰기 중지 → ② 교체 → ③ 서비스 재시작** 순서를 반드시 지켜야 합니다. 관리자 화면이 열리지 않아도 ①~③ 은 모두 `railway ssh` 와 대시보드로 할 수 있습니다.

1. **쓰기 중지 (관리자 화면 불필요)** — 참여자 제출이 503으로 거절되고 DB에는 접근하지 않습니다:
   ```bash
   railway ssh "touch /data/MAINTENANCE"
   ```
   관리자 화면의 '서버 자동 백업 상태' 카드에 '점검 모드 켜짐'이 표시됩니다. 이 동안 관리자 화면에서 응답 삭제·내용 수정 같은 쓰기 작업은 하지 마세요.
2. **복원 후보 파일을 서버로 전송** — 위 '파일을 서버로 보내는 방법' 으로 `/data/restore-candidate.db` 에 올립니다. 후보는 이 묶음의 `db/*.db` 또는 서버의 `/data/backups/<시각>_<사유>/concept-sort_*.db` 입니다(서버 안 사본이면 전송 없이 `cp` 로 `/data/restore-candidate.db` 를 만들면 됩니다).
3. **후보 검사 (읽기 전용, 개인정보는 출력하지 않고 건수만 출력)**:
   ```bash
   railway ssh "cd /app && node --no-warnings scripts/backup/restore-tool.mjs inspect --candidate /data/restore-candidate.db"
   ```
   `"ok": true` 여야 합니다. 무결성·외래키·마이그레이션 이력(이 코드가 모르는 미래 마이그레이션이 있으면 거절)을 검사하고, 현재 DB의 journal 모드와 `-journal/-wal/-shm` 파일 유무를 보여줍니다.
4. **교체** — 도구가 다음을 한 번에 수행합니다: 쓰기 중지 확인 → 현재 DB를 일관된 방식(`VACUUM INTO`)으로 검증된 백업으로 보존 → 현재 DB와 `-journal/-wal/-shm` 를 `replaced_<시각>/` 로 **이동**(삭제 없음; 옛 hot journal 이 새 파일에 적용되면 손상되기 때문) → 후보를 복사·체크섬 확인·원자적 이름 변경으로 설치 → 설치된 파일의 무결성·내용 지문 검증. 중간에 하나라도 실패하면 **자동으로 원래 파일을 되돌립니다.**
   ```bash
   railway ssh "cd /app && node --no-warnings scripts/backup/restore-tool.mjs replace --candidate /data/restore-candidate.db"
   ```
   출력의 `replacedDir` 이름을 적어 두세요(되돌릴 때 필요). hot journal 이 남아 있는 손상 DB는 읽기 전용 백업이 불가능해 `preservedBackup` 이 `null` 일 수 있으며, 이 경우에도 원본 파일들은 `replaced_<시각>/` 에 그대로 보존됩니다.
5. **서비스 재시작** — Railway 대시보드 → `concept-sort` → 최신 배포의 `⋯` → **Restart** (또는 Redeploy). 재시작해야 서버가 새 파일을 엽니다. (CLI의 `railway restart` 는 멈추는 경우가 있어 권장하지 않음. 재시작 시 시작 가드가 다시 실행되어 새 DB 기준으로 백업·마이그레이션 점검을 합니다.)
6. **확인** — 관리자 화면의 참가자 수·본조사/파일럿 수, '결과·분석' 의 세 행렬 N, '서버 자동 백업 상태'. 이상이 없으면 쓰기 중지를 해제합니다:
   ```bash
   railway ssh "rm /data/MAINTENANCE"
   ```
7. **되돌리기(교체 결과가 잘못된 경우)** — `MAINTENANCE` 가 켜진 상태에서:
   ```bash
   railway ssh "cd /app && node --no-warnings scripts/backup/restore-tool.mjs rollback --replaced /data/replaced_<시각>"
   ```
   이후 5번처럼 재시작하고 6번으로 확인합니다. (교체됐던 파일은 `rolled-back_<시각>/` 에 보존됩니다.)

### C. 앱이 DB 손상 때문에 계속 죽고 다시 뜸 / 서비스가 중지된 상태

중지·삭제된 배포에는 `railway ssh` 가 접속되지 않습니다(컨테이너가 없음). 볼륨 파일을 만지려면 컨테이너가 떠 있어야 하므로:
1. Railway 대시보드 → 서비스 → Settings → Deploy → **Custom Start Command** 를 `sleep 86400` 으로 바꾸고 Redeploy (앱은 시작되지 않고 컨테이너와 볼륨만 유지 — 이 동안 참여자는 접속할 수 없음).
2. `railway ssh` 로 접속해 위 B의 2~4 단계를 수행(`MAINTENANCE` 는 앱이 떠 있지 않으므로 필요 없지만 도구가 요구하므로 `touch /data/MAINTENANCE` 후 진행).
3. Custom Start Command 를 **원래 값(비움)** 으로 되돌리고 Redeploy, 5~6 단계로 확인.

> 이 C 절차(대시보드 설정 변경과 재배포)는 실제 Railway 환경에서 시험하지 **않았습니다.** 운영 서비스를 멈추게 되기 때문입니다. 컨테이너 안에서 실행되는 도구 부분(inspect/replace/rollback)은 격리된 환경에서 검증했습니다.

### D. Railway 볼륨/프로젝트까지 사라짐

1. 새 Railway 프로젝트(또는 서비스)를 만들고 GitHub `sonoJB/concept-sort` 의 커밋 `{{COMMIT}}` 을 연결합니다. GitHub가 불가능하면 `code/concept-sort_*.zip` 을 풀어 올립니다.
2. 서비스에 **볼륨**을 만들어 `/data` 에 마운트합니다.
3. 환경변수를 설정합니다 (값은 이 묶음에 없음 — 본인 보관본에서 가져오세요):
{{ENV_NAMES}}
   - 최소한 `DATABASE_URL=file:/data/prod.db` 가 필요합니다.
4. 첫 배포는 DB가 없으므로 '새 설치'로 시작합니다(백업 기록이 없는 새 볼륨이므로 가드가 허용). 그 뒤 `db/*.db` 를 B의 2~5 단계로 올려 교체합니다.
5. 관리자 토큰은 DB 안에 있으므로 **기존 관리자 URL이 그대로 동작**합니다. 참여 링크(`/p/rrrvvnux/sort`)도 slug가 같아 동일합니다(도메인이 바뀌면 새 도메인으로 안내).

### E. `.db` 파일이 없고 JSON/CSV만 남은 경우

저장소 코드가 있는 곳(`code/` zip을 풀거나 GitHub 클론)에서:

```bash
npm ci
npx tsx scripts/backup/restore-from-json.ts --json-dir <묶음>/export/json --out <새 DB 파일>
```

- 빈 DB는 프로젝트의 `prisma migrate deploy` 로 만들고, JSON 행을 부모 → 자식 순서로 넣으며 외래키를 검사합니다.
- 관리자 토큰은 JSON에 없으므로 **새 토큰**이 만들어져 `<새 DB 파일>.admin-token.txt` 에 저장됩니다(화면에 출력하지 않음). 관리자 URL은 `/p/rrrvvnux/admin/<새 토큰>` 이 되며, **예전 토큰은 더 이상 동작하지 않습니다.** 이 파일은 안전하게 보관하세요.
- 이렇게 복원한 DB는 `.db` 복원본과 행 단위로 동일하고, 새 토큰으로 관리자 API가 열리고 예전 토큰은 거절됨을 `VERIFICATION_REPORT.md` 에서 확인했습니다.

### F. 행렬만 다시 만들고 싶을 때

관리자 화면 → **결과·분석** → '본조사 유사성 행렬 다운로드' 세 버튼(전체/한국/일본). 또는 이 묶음의 `matrices/` 파일을 그대로 사용하세요. 같은 원자료에서 다시 계산한 결과가 묶음 안 파일과 일치함은 `VERIFICATION_REPORT.md` 에 기록되어 있습니다.

## 2. 복원 후 확인 체크리스트

- [ ] `PRAGMA integrity_check` = ok (restore-tool 이 이미 확인)
- [ ] 표별 건수가 `MANIFEST.json` 의 `tableCounts` 와 같음
- [ ] 관리자 화면: 참가자 수, 본조사/파일럿 구분, 국가별 수
- [ ] 결과·분석 화면: 세 행렬 파일의 `메타데이터` 시트 유효 N, `분석용_유사성빈도_대각선N` 시트의 대각선이 그 N 과 같은지
- [ ] '서버 자동 백업 상태' 카드에 '확인 필요' 항목이 없음 / `MAINTENANCE` 파일을 지웠는지
- [ ] 참여 화면(한국어/일본어)이 정상이고, 참여 허용 설정이 의도대로인지

## 3. 한계 (이 백업이 지켜주지 못하는 것)

- 백업 시점 **이후**에 들어온 응답은 이 묶음에 없습니다. 서버의 자동 백업은 데이터가 바뀔 때마다 따라갑니다(6시간 주기).
- 서버 볼륨 안의 사본(`/data/backups`)은 **운영 DB와 같은 Railway 볼륨**에 있습니다. 볼륨 장애·프로젝트 삭제·계정 문제에는 함께 사라질 수 있으므로 독립 보관으로 계산하지 않습니다. 이 묶음이 있는 연구자 PC의 폴더와 ZIP 은 **같은 컴퓨터(같은 디스크)** 이므로 서로 독립된 사본이 아닙니다. 서버·이 PC 와 별개의 저장소에 **암호화본**을 하나 이상 두어야 합니다.
- 실패는 **관리자 화면을 열어 보아야** 알 수 있고(알림 없음), **서버가 꺼져 있으면 자동 백업도 동작하지 않습니다.**
- 자동 백업은 디스크 여유가 100 MB 미만이면 새 백업을 만들지 않고 실패로 기록합니다. 기존 백업은 자동으로 지우지 않습니다.
- 보존기간·삭제 기준은 확인된 연구계획/IRB 기준이 없어 정하지 않았습니다.

## 4. 이 절차서의 검증 현황

이 묶음의 `VERIFICATION_REPORT.md` 와 함께 읽으세요.

**격리된 환경에서 실제로 실행해 확인한 것**
- `.db` 복원, JSON 복원(새 관리자 토큰 동작·예전 토큰 거절 포함), 행렬 재생성과 독립 SQL 재계산 일치
- `restore-tool.mjs`: 쓰기 중지 플래그 없이는 거절 / 불량 후보 거절 / 현재 DB 일관 보존 / journal·WAL·SHM 분리 이동 / 설치 후 검증 / 실패 시 자동 복귀 / rollback
- 로컬 프로덕션 모드 서버(Windows)에서 `MAINTENANCE` 플래그로 제출 503 → (Windows는 열린 DB 파일을 바꿀 수 없어 서버를 멈춘 뒤) 교체 → **서버 재시작** → 새 DB 서비스 → rollback → 재시작
- 리눅스(운영 컨테이너의 임시 폴더, 가짜 DB)에서 '열린 채로 파일을 바꾸면 재시작 전 서버는 옛 데이터를 보고 쓰기가 거부됨'을 확인
- 시작 가드: 마이그레이션 전 백업 실패 시 차단, 정기 백업 실패는 서비스 유지, DB 없음/빈 DB/볼륨 밖 경로/손상 DB 구분
- Railway 컨테이너로의 파일 전송(`railway ssh` base64 방식, bash·PowerShell 모두; 임시 폴더에서 SHA-256 일치 확인 후 삭제)

**실제 Railway 운영 환경에서는 실행하지 않은 것** (운영 DB 교체 실험 금지)
- 위 B의 `replace`/`rollback` 을 운영 볼륨에 실행하는 것, 대시보드 Restart/Redeploy, C의 Custom Start Command 방식
- 새 Railway 프로젝트로의 전체 재구축(D)
