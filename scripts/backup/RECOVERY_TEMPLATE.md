# 복구 절차서 (README_복구절차서)

연구: **사이버폭력의 특징** (slug `rrrvvnux`) · 백업 묶음: `{{LABEL}}` · 배포 코드 커밋: `{{COMMIT}}` · 스키마 마지막 마이그레이션: `{{LAST_MIGRATION}}`

> ⚠ 이 묶음의 `db/`, `export/` 안에는 **개인정보**(이름·전화번호 등)와 `db/` 안의 **관리자 토큰**이 들어 있습니다. 공개 저장소·이메일·공유 폴더에 올리지 마세요.
> 비밀값(관리자 토큰, Railway 계정 정보)은 이 문서에 적지 않았습니다. 아래 "환경변수 이름 목록"은 **이름만** 적혀 있습니다.

## 0. 먼저 알아둘 것

| 파일 | 용도 |
|---|---|
| `db/*.db` | **복원용 SQLite 전체 백업**. 서비스를 그대로 되살리는 데 쓰는 1순위 파일 |
| `export/json/*.json` | 표별 원자료. `.db`를 쓸 수 없을 때 DB를 다시 만드는 데 사용(관리자 토큰은 제외됨) |
| `export/csv/*.csv` | 표별 원자료 CSV(UTF-8 BOM). 사람이 훑어보는 용도 — Excel로 열면 앞자리 0이 사라질 수 있음 |
| `export/연구원자료_전체.xlsx` | 연구자 열람용(참여자·분류결과·진술문·설정·분석실행). 개인정보 포함 |
| `matrices/본조사_유사성행렬_*.xlsx` | 전체/한국/일본 본조사 유사성 행렬 3종(비식별) |
| `code/concept-sort_*.zip` | 배포된 소스 코드(비밀값 없음). GitHub를 못 쓸 때 서비스를 다시 세우는 데 사용 |
| `MANIFEST.json` / `SHA256SUMS.txt` | 파일 목록·건수·체크섬 / 무결성 검증 |
| `VERIFICATION_REPORT.md` | 이 묶음을 실제로 복원해 본 검증 결과 |
| `DATA_DICTIONARY.md` | 표·컬럼 설명 |

### 무결성 확인 (복구 전에 항상)

묶음 폴더에서:

```bash
sha256sum -c SHA256SUMS.txt
```

(Windows PowerShell: `Get-FileHash <파일> -Algorithm SHA256` 값을 `SHA256SUMS.txt`의 해당 줄과 비교)

## 1. 장애 유형별 복구

### A. 웹앱이 안 열림 / 배포 실패 (DB는 정상)

데이터는 Railway 볼륨(`/data/prod.db`)에 있으므로 **DB 복원은 필요 없습니다.**
1. Railway 대시보드 → 프로젝트 `adequate-magic` → 서비스 `concept-sort` → Deployments에서 마지막으로 성공한 배포를 **Redeploy**.
2. 안 되면 GitHub `sonoJB/concept-sort`의 커밋 `{{COMMIT}}` 으로 배포.
3. 배포 후 `https://concept-sort-production.up.railway.app/p/rrrvvnux/sort` 가 열리고 관리자 화면의 참가자 수가 그대로인지 확인.

서버는 시작할 때마다(=배포마다) **마이그레이션 직전에 자동으로 DB 백업**을 만들어 `/data/backups/` 에 둡니다(변경이 없으면 건너뜀).

### B. DB 손상 · 실수로 삭제/수정 (볼륨은 살아 있음)

1. **새 응답이 더 들어오지 않게** 관리자 화면에서 한국어/일본어 참여를 모두 끕니다(데이터는 지워지지 않음).
2. 현재 상태를 먼저 따로 보존합니다(덮어쓰기 금지):
   ```bash
   railway ssh "cp -n /data/prod.db /data/prod.db.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
   ```
3. 복원할 백업을 고릅니다 — 서버 안의 사본(`/data/backups/<시각>_<사유>/concept-sort_*.db`, 관리자 화면 '서버 자동 백업 상태'에서 목록 확인) 또는 이 묶음의 `db/*.db`.
4. 복원본을 **다른 이름으로** 올려 먼저 검사합니다:
   ```bash
   scp db/<파일>.db concept-sort-prod:/data/prod.db.restore-candidate     # 이 묶음의 파일을 쓸 때
   railway ssh "node -e \"const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/prod.db.restore-candidate',{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get(), d.prepare('select count(*) c from SortSession').get())\""
   ```
   `integrity_check`가 `ok`이고 건수가 `MANIFEST.json`의 `tableCounts`와 같아야 합니다.
5. 서비스를 잠깐 멈추거나(Railway에서 Stop) 쓰기가 없는 시간에 교체합니다:
   ```bash
   railway ssh "mv /data/prod.db /data/prod.db.replaced && mv /data/prod.db.restore-candidate /data/prod.db"
   ```
   그 뒤 서비스를 다시 시작하고, 관리자 화면의 참가자 수·분석 화면을 확인합니다. 문제가 있으면 `prod.db.replaced` 로 되돌릴 수 있습니다.
6. 이 때 `-journal`/`-wal` 파일이 남아 있으면 교체 전에 서비스를 멈춘 상태에서 확인하세요(이 DB는 journal_mode=delete 입니다).

### C. Railway 볼륨/프로젝트까지 사라짐

1. 새 Railway 프로젝트(또는 서비스)를 만들고 GitHub `sonoJB/concept-sort` 의 커밋 `{{COMMIT}}` 을 연결합니다. GitHub가 불가능하면 `code/concept-sort_*.zip` 을 풀어 `railway up` 등으로 올립니다.
2. 서비스에 **볼륨**을 만들어 `/data` 에 마운트합니다.
3. 환경변수를 설정합니다 (값은 이 묶음에 없음 — 본인 보관본에서 가져오세요):
{{ENV_NAMES}}
   - 최소한 `DATABASE_URL=file:/data/prod.db` 가 필요합니다.
4. `db/*.db` 를 `/data/prod.db` 로 올립니다(위 B-4와 같은 방법). 앱 시작 때 `prisma migrate deploy` 가 실행되며 이미 적용된 마이그레이션은 건너뜁니다.
5. 관리자 토큰은 DB 안에 있으므로 **기존 관리자 URL이 그대로 동작**합니다. 참여 링크(`/p/rrrvvnux/sort`)도 slug가 같아 동일합니다(도메인이 바뀌면 새 도메인으로 안내).

### D. `.db` 파일이 없고 JSON/CSV만 남은 경우

저장소 코드가 있는 곳(`code/` zip을 풀거나 GitHub 클론)에서:

```bash
npm ci
npx tsx scripts/backup/restore-from-json.ts --json-dir <묶음>/export/json --out <새 DB 파일>
```

- 빈 DB는 프로젝트의 `prisma migrate deploy` 로 만들고, JSON 행을 부모 → 자식 순서로 넣으며 외래키를 검사합니다.
- 관리자 토큰은 JSON에 없으므로 **새 토큰**이 생성되어 `<새 DB 파일>.admin-token.txt` 에 저장됩니다(화면에 출력하지 않음). 관리자 URL은 `/p/rrrvvnux/admin/<새 토큰>` 이 됩니다. 이 파일은 안전하게 보관하세요.
- 이 방식으로 복원한 DB는 `.db` 복원본과 **행 단위로 동일**함을 `VERIFICATION_REPORT.md` 에서 확인했습니다(관리자 토큰 제외).

### E. 행렬만 다시 만들고 싶을 때

관리자 화면 → **결과·분석** → "본조사 유사성 행렬 다운로드" 세 버튼(전체/한국/일본). 또는 이 묶음의 `matrices/` 파일을 그대로 사용하세요.
같은 원자료에서 다시 계산한 결과가 묶음 안 파일과 일치함은 `VERIFICATION_REPORT.md` 에 기록되어 있습니다.

## 2. 복원 후 확인 체크리스트

- [ ] `PRAGMA integrity_check` = ok
- [ ] 표별 건수가 `MANIFEST.json` 의 `tableCounts` 와 같음
- [ ] 관리자 화면: 참가자 수, 본조사/파일럿 구분, 국가별 수
- [ ] 결과·분석 화면: 세 행렬 파일 다운로드 후 `메타데이터` 시트의 유효 N 확인
- [ ] 참여 화면(한국어/일본어)이 정상이고, 새 응답을 받기 전이라면 참여 허용 설정이 의도대로인지 확인

## 3. 한계 (이 백업이 지켜주지 못하는 것)

- 백업 시점 **이후**에 들어온 응답은 이 묶음에 없습니다. 서버의 자동 백업은 데이터가 바뀔 때만 새로 만들어집니다.
- 서버 볼륨 안의 사본(`/data/backups`)은 **같은 Railway 볼륨**에 있어 볼륨/프로젝트 자체가 사라지면 함께 사라집니다. 서버와 독립된 사본은 이 묶음(연구자 PC 등 별도 저장소)뿐이므로 **반드시 별도 위치에 추가로 복사해 두세요**.
- 백업은 자동으로 삭제되지 않지만, 사람이 지우거나 디스크가 가득 차면 새 백업이 실패할 수 있습니다(실패는 관리자 화면에 표시).
- 보존기간·삭제 기준은 확인된 연구계획/IRB 기준이 없어 정하지 않았습니다.
