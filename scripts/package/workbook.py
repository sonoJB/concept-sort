"""Analysis workbook (one per scope): every table as real, editable cells — no numbers as pictures.

Stored-value sheets hold the numbers exactly as computed (full double precision; only the DISPLAY format rounds).
The one sheet with FORMULAS ("행렬정의·수식검산") re-derives P, D and δ from S inside Excel and shows the cached result;
nothing else depends on a formula or on an external link. Strings are always written as strings (a participant-typed pile
name that starts with "=" or "http" must never become a formula or a hyperlink).
"""
import os
from datetime import datetime, timezone

import numpy as np
import xlsxwriter

from common import SCOPE_LABEL_KO, ko_text, rewrite_zip_deterministic, sid

def _install_full_precision_numbers():
    """XlsxWriter prints numbers with 16 significant digits, which can change the last bit of a double. Print the shortest text that
    reads back as the SAME double instead, so the stored values keep full computed precision (only the display format rounds)."""
    from xlsxwriter import xmlwriter

    if getattr(xmlwriter.XMLwriter, "_full_precision_installed", False):
        return

    def _xml_number_element(self, number, attributes=()):
        attr = "".join(f' {k}="{self._escape_attributes(v)}"' for k, v in attributes)
        text = repr(float(number)) if isinstance(number, float) else str(number)
        self.fh.write(f"<c{attr}><v>{text}</v></c>")

    xmlwriter.XMLwriter._xml_number_element = _xml_number_element
    xmlwriter.XMLwriter._full_precision_installed = True


_install_full_precision_numbers()

SHEET = {
    "readme": "안내·데이터사전",
    "meta": "메타데이터",
    "resp": "참여자_분류응답(가명)",
    "psum": "참여자_묶음요약",
    "stm": "진술문_원문대응",
    "S": "S_유사성빈도",
    "P": "P_유사성비율",
    "D": "D_비유사성빈도",
    "delta": "delta_정규화비유사성",
    "legacy": "기존_빈도행렬_대각0(유사성)",
    "matdef": "행렬정의·수식검산",
    "coords": "좌표·군집(추천)",
    "rec": "추천군집·문항",
    "member": "군집소속_k별",
    "dims": "차원별_지표",
    "kcmp": "군집수별_지표",
    "merges": "Ward병합이력",
    "pairs": "문항쌍_진단",
    "spp": "문항별_stress기여",
    "split": "안정성_분할반분",
    "splitv": "분할반분_전체값",
    "valid": "포함제외·검증",
    "metrics": "지표정의·해석범위",
    "refs": "참고문헌",
    "figs": "그림목록",
    "chart": "차트",
    "cmp": "한일비교",
    "S_KR": "S_한국",
    "S_JP": "S_일본",
    "P_KR": "P_한국",
    "P_JP": "P_일본",
    "Pdiff": "P차이_한국-일본",
}

# direction of each metric's value (a definition, not a threshold)
DIRECTION = {
    "numeric_convergence": "수렴 여부(예/아니오). 마지막 상대 변화량이 작을수록 허용오차에 더 가깝게 멈춤",
    "fit_interpretation": "해당 없음(해석 안내)",
    "raw_stress": "작을수록 디스패리티와 배치 거리의 불일치가 작음",
    "stress1": "작을수록 불일치가 작음(낮을수록 좋음). 고정 임계값으로 판정하지 않음",
    "stress_definitions": "정의 구분표(각 값의 방향은 해당 지표와 같음)",
    "rsq": "클수록 디스패리티와 배치 거리의 선형 상관이 강함(0–1)",
    "stress_by_dimension": "차원이 늘면 Stress가 줄어드는 것이 일반적(차원 수가 많을수록 유리한 구조적 경향)",
    "tie_sensitivity": "공식 결과 아님(동점 처리 선택에 대한 민감도 참고)",
    "silhouette_map": "클수록 문항이 자기 군집에 가깝고 가장 가까운 다른 군집과 분리됨(−1–1)",
    "silhouette_delta": "클수록 문항이 원래 비유사성 δ에서도 자기 군집에 가까움(−1–1)",
    "between_share": "클수록 지도 좌표의 전체 제곱합 중 군집 간 몫이 큼(0–1); k가 클수록 커지는 경향",
    "split_half": "클수록 무작위 두 반쪽 참여자가 만든 유사성 행렬이 더 일치함",
    "data_validation": "해당 없음(자료 점검)",
}


def _num(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    return v


class Book:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.path = path
        self.wb = xlsxwriter.Workbook(path, {"constant_memory": False, "strings_to_numbers": False, "strings_to_urls": False, "strings_to_formulas": False})
        self.wb.set_properties({"created": datetime(2026, 1, 1, tzinfo=timezone.utc), "title": os.path.basename(path), "author": "concept-sort analysis package", "comments": "stored values; formulas only on the 행렬정의·수식검산 sheet"})
        f = self.wb.add_format
        self.f_head = f({"bold": True, "bg_color": "#E2E8F0", "border": 1, "text_wrap": True, "valign": "top"})
        self.f_wrap = f({"text_wrap": True, "valign": "top"})
        self.f_text = f({"num_format": "@", "valign": "top"})
        self.f_int = f({"num_format": "0", "valign": "top"})
        self.f_3 = f({"num_format": "0.000", "valign": "top"})
        self.f_4 = f({"num_format": "0.0000", "valign": "top"})
        self.f_6 = f({"num_format": "0.000000", "valign": "top"})
        self.f_sci = f({"num_format": "0.00E+00", "valign": "top"})
        self.f_title = f({"bold": True, "font_size": 13})
        self.f_note = f({"italic": True, "font_color": "#475569", "text_wrap": True, "valign": "top"})
        self.f_ok = f({"bold": True, "font_color": "#047857"})
        self.names = []

    def sheet(self, key):
        name = SHEET[key]
        self.names.append(name)
        return self.wb.add_worksheet(name)

    def put(self, ws, r, c, v, fmt=None):
        v = _num(v)
        if v is None or v == "":
            return
        if isinstance(v, bool):
            ws.write_string(r, c, "예" if v else "아니오", self.f_text)
        elif isinstance(v, float) and v != v:
            ws.write_string(r, c, "계산 불가", self.f_text)
        elif isinstance(v, (int, float)):
            ws.write_number(r, c, v, fmt) if fmt is not None else ws.write_number(r, c, v)
        else:
            ws.write_string(r, c, str(v), self.f_wrap)

    def table(self, key, header, rows, formats=None, text_cols=(), widths=None, note=None, freeze_cols=0, filter_=True):
        """formats: {col: xlsxwriter format}; text_cols: columns whose values are always strings (ids)."""
        ws = self.sheet(key)
        formats = formats or {}
        r0 = 0
        if note:
            ws.merge_range(0, 0, 0, max(len(header) - 1, 3), note, self.f_note)
            ws.set_row(0, 15 * (1 + len(note) // 110))
            r0 = 1
        for j, h in enumerate(header):
            ws.write_string(r0, j, str(h), self.f_head)
        for i, row in enumerate(rows):
            for j, v in enumerate(row):
                if j in text_cols:
                    if v is not None and v != "":
                        ws.write_string(r0 + 1 + i, j, str(v), self.f_text)
                else:
                    self.put(ws, r0 + 1 + i, j, v, formats.get(j))
        ws.freeze_panes(r0 + 1, freeze_cols)
        if filter_ and rows:
            ws.autofilter(r0, 0, r0 + len(rows), len(header) - 1)
        for j in range(len(header)):
            if widths and j in widths:
                w = widths[j]
            else:
                sample = [len(str(r[j])) if j < len(r) and r[j] is not None else 0 for r in rows[:120]]
                w = min(max([len(str(header[j])) * 1.5] + sample) + 2, 60)
            ws.set_column(j, j, max(w, 8))
        return ws

    def matrix(self, key, M, fmt, note=None):
        n = M.shape[0]
        ws = self.sheet(key)
        ws.write_string(0, 0, "문항", self.f_head)
        for j in range(n):
            ws.write_string(0, j + 1, sid(j), self.f_head)
        for i in range(n):
            ws.write_string(i + 1, 0, sid(i), self.f_head)
            for j in range(n):
                ws.write_number(i + 1, j + 1, float(M[i, j]), fmt)
        ws.freeze_panes(1, 1)
        ws.set_column(0, 0, 8)
        ws.set_column(1, n, 6.5)
        if note:
            ws.write_string(n + 2, 0, note, self.f_note)
        return ws

    def close(self):
        self.wb.close()
        rewrite_zip_deterministic(self.path)


def write_analysis_workbook(path, d, T, resp_rows, figrows, versions):
    """d: ScopeData; T: tables dict from tables.build_tables; resp_rows: long-format pseudonymous responses;
    figrows: list of dicts (figure list); versions: dict of version strings. Returns the list of sheet names written."""
    a, m, scope = d.a, d.meta, d.scope
    n = d.n
    label = SCOPE_LABEL_KO[scope]
    B = Book(path)

    # -------------------------------------------------------------------------- README / data dictionary (filled after the other sheets are known)
    ws_readme = B.sheet("readme")

    # -------------------------------------------------------------------------- metadata
    meta_rows = [list(r) for r in T["summary"][2]]
    meta_rows += [
        ["패키지 버전(이 실행의 ZIP 번호)", versions["packageVersion"]],
        ["패키지 형식 버전", versions["packageFormatVersion"]],
        ["해석 문구 버전", versions.get("interpretationTextVersion") or "—"],
        ["엔진·패키지·문서 버전의 구분", "분석 엔진 버전은 계산 방법, 패키지 형식·해석 문구 버전은 문서·설명의 버전이며 서로 독립임"],
        ["생성 방식", "서버가 저장된 분석 결과와 입력 스냅샷으로 만들었음(MDS 재계산 없음)"],
        ["포함 기준", "본조사(MAIN), 국가 코드가 해당 범위, 47개 진술문을 정확히 한 번씩 분류한 완결 제출"],
        ["제외 사항", "파일럿·비본조사, 국가 코드 없음, 미완료, 진술문 중복 배치. 적합도를 높이기 위한 참여자·문항 제외·응답 수정·가중치는 없음"],
        ["이 파일에 없는 것", "이름·전화번호·실제 세션 ID·접근 토큰·성별·나이·학교급·학년(가명 연구 ID만 사용)"],
        ["묶음 번호의 의미", "참여자 내부의 명목 식별자이며 크기·순서가 없음. 연속형 점수처럼 평균·상관을 계산하지 말 것"],
    ]
    B.table("meta", ["항목", "값"], meta_rows, widths={0: 38, 1: 90}, filter_=False)

    # -------------------------------------------------------------------------- responses
    B.table("resp", ["가명ID", "국가", "제출시각(KST)", "진술문", "문항번호", "묶음번호(참여자 내)", "묶음 이름(참여자 입력)"], resp_rows, formats={4: B.f_int, 5: B.f_int}, text_cols={0, 1, 2, 3, 6}, widths={0: 10, 1: 7, 2: 19, 3: 9, 4: 9, 5: 12, 6: 34},
            note="참여자가 제출한 분류 그대로(가명 ID). 묶음 번호는 참여자 안에서만 의미 있는 명목 식별자이고 묶음 이름은 참여자가 직접 입력한 문장입니다.")
    B.table("psum", T["participants_summary"][1], T["participants_summary"][2], formats={2: B.f_int, 4: B.f_int, 5: B.f_int}, text_cols={0, 1, 3})

    # -------------------------------------------------------------------------- statements
    stm = d.statements
    if scope == "KR":
        hdr = ["진술문 번호", "분석 순서", "DB 진술문 ID", "한국어 원문(참여자에게 제시)"]
        rows = [[sid(i), i + 1, s["id"], s["textKo"]] for i, s in enumerate(stm)]
    elif scope == "JP":
        hdr = ["진술문 번호", "분석 순서", "DB 진술문 ID", "日本語 対応文(참여자에게 제시)", "일본어 검수 상태(시스템 값)", "한국어 원문(번역 원본, 참고)"]
        rows = [[sid(i), i + 1, s["id"], s["textJa"] or "", s["jaStatus"], s["textKo"]] for i, s in enumerate(stm)]
    else:
        hdr = ["진술문 번호", "분석 순서", "DB 진술문 ID", "한국어 원문(한국 참여자에게 제시)", "日本語 対応文(일본 참여자에게 제시)", "일본어 검수 상태(시스템 값)"]
        rows = [[sid(i), i + 1, s["id"], s["textKo"], s["textJa"] or "", s["jaStatus"]] for i, s in enumerate(stm)]
    B.table("stm", hdr, rows, formats={1: B.f_int}, text_cols={0, 2}, widths={0: 10, 1: 8, 2: 28, 3: 60, 4: 60, 5: 22})

    # -------------------------------------------------------------------------- matrices
    legacy0 = d.S.copy()
    np.fill_diagonal(legacy0, 0)
    B.matrix("S", d.S, B.f_int, "S = 같은 묶음에 분류한 참여자 수(개인 이진 유사성 B의 합). 대각선 = N. 큰 값 = 더 유사.")
    B.matrix("P", d.P, B.f_3, "P = S/N. 대각선 1. 저장값은 전체 정밀도이며 표시만 소수 3자리.")
    B.matrix("D", d.D, B.f_int, "D = N − S. 대각선 0. 큰 값 = 더 다름.")
    B.matrix("delta", d.delta, B.f_3, "δ = 1 − S/N. 대각선 0. 큰 값 = 더 다름. 이 행렬이 MDS의 실제 입력입니다.")
    B.matrix("legacy", legacy0, B.f_int, "기존 '빈도행렬' 출력 형식: S에서 대각선만 0으로 표시한 유사성 빈도입니다. 비유사성 행렬이 아니며 거리 행렬로 쓰지 마십시오(큰 값 = 더 유사).")

    # -------------------------------------------------------------------------- definitions + formula check
    ws = B.sheet("matdef")
    ws.set_column(0, 0, 44)
    ws.set_column(1, 1, 70)
    ws.set_column(2, 4, 22)
    r = 0
    ws.write_string(r, 0, f"행렬 정의와 수식 검산 — {label}", B.f_title)
    r += 2
    for j, h in enumerate(["행렬", "정의", "대각선", "큰 값의 의미"]):
        ws.write_string(r, j, h, B.f_head)
    defs = [["B (개인 이진 유사성)", "같은 묶음 1, 다른 묶음 0, 대각선 1 (Trochim, 1989, Step 3)", "1", "더 유사함"], ["S (집단 유사성 빈도)", "개인 B의 합", "N", "더 유사함"], ["P (유사성 비율)", "S / N", "1", "더 유사함"], ["D (비유사성 빈도)", "N − S", "0", "더 다름"], ["δ (정규화 비유사성)", "1 − S / N  (이 분석의 변환식이며 Trochim(1989) 본문에 명시된 식이 아님) — MDS 입력", "0", "더 다름"],
            ["기존 '빈도행렬'(대각선 0)", "S의 대각선만 0으로 표시한 유사성 빈도 — 비유사성 행렬이 아님", "0(표시)", "더 유사함"]]
    for row in defs:
        r += 1
        for j, v in enumerate(row):
            ws.write_string(r, j, v, B.f_wrap)
    r += 2
    ws.write_string(r, 0, "수식 검산 (Excel이 계산; 저장값 시트와의 차이의 합이 0이어야 함)", B.f_head)
    ws.write_string(r, 1, "수식", B.f_head)
    ws.write_string(r, 2, "계산 결과", B.f_head)
    ws.write_string(r, 3, "판정", B.f_head)
    last_col = xlsxwriter.utility.xl_col_to_name(n)
    rng = lambda sh: f"'{SHEET[sh]}'!$B$2:${last_col}${n + 1}"
    r += 1
    ws.write_string(r, 0, "N (유효 참여자 수; 저장값)", B.f_wrap)
    ws.write_number(r, 2, d.N, B.f_int)
    n_cell = f"$C${r + 1}"
    checks = [
        ("Σ|P − S/N|", f"=SUMPRODUCT(ABS({rng('P')}-{rng('S')}/{n_cell}))", float(np.abs(d.P - d.S / d.N).sum())),
        ("Σ|D − (N − S)|", f"=SUMPRODUCT(ABS({rng('D')}-({n_cell}-{rng('S')})))", float(np.abs(d.D - (d.N - d.S)).sum())),
        ("Σ|δ − (1 − S/N)|", f"=SUMPRODUCT(ABS({rng('delta')}-(1-{rng('S')}/{n_cell})))", float(np.abs(d.delta - (1 - d.S / d.N)).sum())),
        ("S 시트의 숫자 칸 수 (n×n 이어야 함)", f"=COUNT({rng('S')})", float(n * n)),
    ]
    if scope == "ALL" and d.b.get("comparison"):
        checks.append(("Σ|S − S_한국 − S_일본|", f"=SUMPRODUCT(ABS({rng('S')}-{rng('S_KR')}-{rng('S_JP')}))", float(np.abs(d.S - np.array(d.b['comparison']['Skr'], dtype=float) - np.array(d.b['comparison']['Sjp'], dtype=float)).sum())))
    for lab, formula, cached in checks:
        r += 1
        ws.write_string(r, 0, lab, B.f_wrap)
        ws.write_string(r, 1, formula[1:], B.f_wrap)
        ws.write_formula(r, 2, formula, B.f_sci if "수" not in lab else B.f_int, cached)
        expected = n * n if "칸 수" in lab else 0
        ws.write_formula(r, 3, f'=IF(ABS(C{r + 1}-{expected})<0.000000001,"일치","불일치")', B.f_ok, "일치" if abs(cached - expected) < 1e-9 else "불일치")
    r += 2
    ws.write_string(r, 0, "대칭성·대각선·값의 범위·진술문 순서는 패키지의 독립 검증 스크립트(10_재현, 11_검증)가 확인합니다. 이 시트의 수식은 시트 사이의 변환식만 검산합니다.", B.f_note)

    # -------------------------------------------------------------------------- coordinates / clusters
    spp = {row[0]: row for row in T["spp"][2]}
    bd = d.boundary(d.sol) if d.sol else None
    crow = []
    for i in range(n):
        c = d.sol["labels"][i] if d.sol else ""
        crow.append([sid(i), i + 1, float(d.coords[i][0]), float(d.coords[i][1]), c, d.cluster_name(c) if c != "" else "", float(bd[i]["silhouette"]) if bd else "", ("예" if bd and bd[i]["is_boundary"] else ""), (bd[i]["nearest_other"] if bd else ""), float(spp[sid(i)][1]), float(spp[sid(i)][2])])
    B.table("coords", ["문항", "문항 번호", "차원 1", "차원 2", f"군집(k={d.rec_k})", "추천 군집명(자동 제안)", "지도 실루엣", "경계 문항(<0.1)", "가장 가까운 다른 군집", "stress 기여(Σ_j 잔차²)", "전체 raw stress 대비(%)"], crow,
            formats={1: B.f_int, 2: B.f_6, 3: B.f_6, 4: B.f_int, 6: B.f_4, 8: B.f_int, 9: B.f_4, 10: B.f_4}, text_cols={0}, widths={5: 36},
            note="좌표는 저장된 최종 MDS 해 그대로입니다(이동·회전·보정 없음). 축의 방향은 임의이고 축에는 의미를 부여하지 않았습니다. 군집 번호·명칭은 자동 제안이며 연구자 확정 전입니다.")
    if d.sol:
        rec_rows = []
        for c in d.sol["clusters"]:
            nm = d.names.get(c["cluster"], {})
            members = ", ".join(sid(i) for i in c["members"])
            bnd = [f"{sid(i)}({bd[i]['silhouette']:.2f}→군집{bd[i]['nearest_other']})" for i in c["members"] if bd[i]["is_boundary"]]
            rec_rows.append([c["cluster"], nm.get("nameKo", ""), (nm.get("nameJa", "") + " (검토용 번역안)") if nm else "", c["size"], members, ", ".join(bnd), round(float(c["meanSilhouette"]), 6), nm.get("coreContentKo", ""), nm.get("basisKo", ""), d.proposal["reviewStatus"] + " (자동 제안·연구자 검토 전)"])
        B.table("rec", ["군집 번호", "추천 군집명(자동 제안)", "日本語(검토용 번역안)", "문항 수", "포함 문항", "경계 문항(지도 실루엣<0.1 → 가장 가까운 다른 군집)", "평균 실루엣(지도)", "핵심 내용", "명명 근거", "검토 상태"], rec_rows,
                formats={0: B.f_int, 3: B.f_int, 6: B.f_4}, widths={1: 30, 2: 30, 4: 40, 5: 36, 7: 60, 8: 60, 9: 28},
                note=f"자동 추천 군집 수 k={d.rec_k}. 수학적 유일 해가 아니며 연구자 확정 전입니다. 군집 번호는 지도의 방향·다른 국가의 군집 번호와 대응하지 않습니다.")
    B.table("member", T["membership"][1], T["membership"][2], text_cols={0}, formats={j: B.f_int for j in range(1, len(T["membership"][1]))})

    # -------------------------------------------------------------------------- stored diagnostics
    dims_h, dims_r = T["dims"][1], T["dims"][2]
    B.table("dims", dims_h, dims_r, formats={0: B.f_int, 1: B.f_6, 2: B.f_6, 3: B.f_4, 4: B.f_6, 9: B.f_int, 10: B.f_int}, text_cols={5})
    B.table("kcmp", T["kcompare"][1], T["kcompare"][2], formats={0: B.f_int, 1: B.f_int, 2: B.f_int, 3: B.f_4, 4: B.f_4, 5: B.f_4, 6: B.f_4}, widths={8: 60})
    B.table("merges", T["merges"][1], T["merges"][2], formats={0: B.f_int, 3: B.f_6, 4: B.f_6, 5: B.f_int, 6: B.f_int})
    B.table("pairs", T["pairs"][1], T["pairs"][2], formats={2: B.f_int, 3: B.f_6, 4: B.f_int, 5: B.f_6, 6: B.f_6, 7: B.f_6, 8: B.f_6, 9: B.f_6, 10: B.f_6}, text_cols={0, 1}, widths={7: 24, 9: 24},
            note="문항 쌍별 입력(S·P·D·δ), 배치 거리 d, 디스패리티(정규화 d̂: raw stress·RSQ에 사용 / Kruskal d̂*: Stress-1에 사용)와 각각의 잔차. 모두 저장된 결과이며 새로 계산한 값이 아닙니다.")
    B.table("spp", T["spp"][1], T["spp"][2], text_cols={0}, formats={1: B.f_6, 2: B.f_4})

    # -------------------------------------------------------------------------- stability
    B.table("split", T["reliability"][1], T["reliability"][2], widths={0: 34, 1: 70}, filter_=False,
            note="행렬 안정성(무작위 반분 반복)입니다. 분위수 범위는 이 표본의 반복 분포이지 모집단 신뢰구간이 아니며, 군집 명칭의 타당성을 뜻하지 않습니다.")
    B.table("splitv", T["split_values"][1], T["split_values"][2], formats={0: B.f_int, 1: B.f_6, 2: B.f_6})

    # -------------------------------------------------------------------------- validation + metrics + references + figures
    vrows = [list(x) for x in T["validation"][2]]
    B.table("valid", T["validation"][1], vrows, widths={0: 56, 1: 70}, filter_=False)

    mrows = []
    for me in d.b["metrics"]:
        crit = " / ".join(f"[{c['labelKo']}] {ko_text(c['text'])}" + (f" (위치: {c['location']})" if c.get("location") else "") for c in me["criteria"])
        ver = " / ".join(f"{v['aspectKo']}: {v['textKo']}" for v in me["verdicts"])
        mrows.append([me["nameKo"], me["evaluates"], me["formula"], DIRECTION.get(me["id"], ""), ko_text(me["valueDisplay"]), crit, ver, " / ".join(me["limitsKo"]), ", ".join(me["sourceKeys"])])
    B.table("metrics", ["지표", "평가 대상", "산식", "값의 방향", "이 분석의 값", "적용 가능한 판단 근거·기준 종류", "판정(해석 범위)", "한계", "참고문헌 키"], mrows, widths={0: 28, 1: 18, 2: 44, 3: 40, 4: 40, 5: 70, 6: 60, 7: 60, 8: 22},
            note="수렴·적합도·분류 안정성·내용 타당성은 서로 다른 평가 대상입니다. 확인되지 않은 합격 기준은 만들지 않았고 Stress > 0.20만으로 부적합을 판정하지 않습니다.")
    B.table("refs", T["references"][1], T["references"][2], widths={0: 70, 1: 36, 2: 16, 3: 60, 4: 70})
    fh = ["그림 파일(확장자 제외)", "제목", "학술지용 캡션", "주석", "대응 데이터 파일(패키지 내 경로)", "대응 데이터 시트(이 파일)", "PNG 크기(px)", "인쇄 폭(cm)", "해상도", "글꼴"]
    B.table("figs", fh, [[f["file"], f["title"], f["caption"], f["note"], f["data"], f["sheet"], f["png_px"], f["width_cm"], f["dpi"], f["font"]] for f in figrows], widths={0: 34, 1: 34, 2: 70, 3: 60, 4: 48, 5: 28}, text_cols={0, 6})

    # -------------------------------------------------------------------------- ALL only
    cmp_ = d.b.get("comparison")
    if scope == "ALL" and cmp_:
        B.table("cmp", T["compare"][1], T["compare"][2], widths={0: 50, 1: 90}, filter_=False)
        B.matrix("S_KR", np.array(cmp_["Skr"], dtype=float), B.f_int, f"한국 참여자만의 S (N={cmp_['nKr']}). S_전체 = S_한국 + S_일본.")
        B.matrix("S_JP", np.array(cmp_["Sjp"], dtype=float), B.f_int, f"일본 참여자만의 S (N={cmp_['nJp']}).")
        B.matrix("P_KR", np.array(cmp_["Skr"], dtype=float) / cmp_["nKr"], B.f_3, "P_한국 = S_한국 / N_한국")
        B.matrix("P_JP", np.array(cmp_["Sjp"], dtype=float) / cmp_["nJp"], B.f_3, "P_일본 = S_일본 / N_일본")
        diff = np.array(cmp_["Skr"], dtype=float) / cmp_["nKr"] - np.array(cmp_["Sjp"], dtype=float) / cmp_["nJp"]
        np.fill_diagonal(diff, 0)
        B.matrix("Pdiff", diff, B.f_3, "P_한국 − P_일본(대각선 0 표시). 탐색적 기술 통계이며 통계검정이 아닙니다.")

    # -------------------------------------------------------------------------- editable charts (data live in this workbook)
    ws = B.sheet("chart")
    ws.write_string(0, 0, "편집 가능한 차트 — 데이터는 이 통합 문서 안의 셀이며 외부 연결이 없습니다", B.f_title)
    wb = B.wb
    if d.sol:
        ws.write_row(2, 0, ["군집", "문항", "차원 1", "차원 2"], B.f_head)
        rr = 3
        series = []
        for c in sorted(d.sol["clusters"], key=lambda x: x["cluster"]):
            first = rr
            labels = []
            for i in sorted(c["members"]):
                ws.write_number(rr, 0, c["cluster"], B.f_int)
                ws.write_string(rr, 1, sid(i), B.f_text)
                ws.write_number(rr, 2, float(d.coords[i][0]), B.f_6)
                ws.write_number(rr, 3, float(d.coords[i][1]), B.f_6)
                labels.append({"value": str(i + 1)})
                rr += 1
            series.append((c, first, rr - 1, labels))
        ch = wb.add_chart({"type": "scatter"})
        from common import cluster_style

        for c, first, last, labels in series:
            color, _, _ = cluster_style(c["cluster"])
            ch.add_series({"name": f"군집 {c['cluster']} {d.cluster_name(c['cluster'])}", "categories": [SHEET["chart"], first, 2, last, 2], "values": [SHEET["chart"], first, 3, last, 3],
                           "marker": {"type": "circle", "size": 6, "fill": {"color": color}, "border": {"color": color}}, "data_labels": {"custom": labels, "position": "right", "font": {"size": 7}}})
        ch.set_title({"name": f"{label} 2차원 지도 (점 = 문항 번호, k={d.rec_k} 자동 제안)", "name_font": {"size": 10}})
        ch.set_x_axis({"name": "차원 1", "major_gridlines": {"visible": True, "line": {"color": "#e2e8f0"}}})
        ch.set_y_axis({"name": "차원 2", "major_gridlines": {"visible": True, "line": {"color": "#e2e8f0"}}})
        ch.set_size({"width": 760, "height": 760})
        ch.set_legend({"position": "bottom", "font": {"size": 8}})
        ws.insert_chart(2, 6, ch)
    nd = len(dims_r)
    lc = wb.add_chart({"type": "line"})
    lc.add_series({"name": "Stress-1 (Kruskal)", "categories": [SHEET["dims"], 1, 0, nd, 0], "values": [SHEET["dims"], 1, 1, nd, 1], "marker": {"type": "circle"}})
    lc.add_series({"name": "RSQ", "categories": [SHEET["dims"], 1, 0, nd, 0], "values": [SHEET["dims"], 1, 4, nd, 4], "marker": {"type": "square"}})
    lc.set_title({"name": f"{label} 차원별 Stress-1·RSQ (2차원 외는 보조 비교)", "name_font": {"size": 10}})
    lc.set_x_axis({"name": "차원 수"})
    lc.set_size({"width": 560, "height": 340})
    ws.insert_chart(44, 6, lc)

    # -------------------------------------------------------------------------- README (data dictionary), written last so it lists every sheet
    ws = ws_readme
    ws.set_column(0, 0, 30)
    ws.set_column(1, 1, 110)
    ws.write_string(0, 0, f"{label} 개념도 분석자료 (Excel) — 안내와 데이터 사전", B.f_title)
    notes = [
        f"범위 {label} · 유효 N {d.N} (한국 {m['nKr']} · 일본 {m['nJp']}) · 진술문 {n}개 · 실행 {m['runId']} · 엔진 {m['algorithmVersion']} · 패키지 버전 {versions['packageVersion']} ({versions['packageFormatVersion']})",
        "모든 값은 저장된 분석 결과에서 읽은 실제 셀 값입니다(그림을 붙이지 않았음). 표시 자릿수만 서식으로 줄였고 저장값은 전체 정밀도입니다. 수식은 '행렬정의·수식검산' 시트에만 있고 계산된 결과값이 함께 저장되어 있습니다.",
        "수치의 기준 파일은 패키지의 CSV(04_행렬·05_MDS·06_진단 등)입니다. 이 Excel은 같은 값을 열람·편집하기 위한 사본이며, 원본 파일은 덮어쓰지 말고 사본으로 작업하십시오. Excel의 '표시된 정밀도로 계산' 옵션은 저장값을 표시 자릿수로 줄이므로 켜지 마십시오. 보고용으로 소수 4~6자리로 줄여 둔 표(군집별 실루엣, 군집 수별 지표 등)의 전체 정밀도 값은 좌표에서 다시 계산합니다.",
        "'random halves' 같은 영어 저장값의 한국어 표시 대응은 패키지 00_안내/README.txt의 용어 대응표에 있습니다.",
        "개인정보(이름·전화번호·세션 ID·토큰)는 포함하지 않으며 응답은 가명 연구 ID로만 제공합니다. 한국 파일에는 한국 응답만, 일본 파일에는 일본 응답만, 전체 파일에는 두 국가를 국가 열로 구분해 포함합니다.",
        "행렬: S(대각선 N, 유사성) → P=S/N(대각선 1) → D=N−S(대각선 0) → δ=1−S/N(대각선 0, MDS 입력). 기존 '빈도행렬(대각선 0)'은 S의 대각선만 0으로 표시한 유사성 빈도이며 비유사성 행렬이 아닙니다.",
        "묶음 번호는 명목 식별자입니다. 크기·순서에 의미가 없으며 평균·상관 등 연속형 점수처럼 계산하지 마십시오.",
        "군집 수·군집명·차원 해석은 연구자 확정 전의 자동 제안입니다. 수렴과 적합도는 별개이고 통과한 점검이 논문의 학술적 타당성을 입증하지 않습니다.",
    ]
    r = 2
    for t in notes:
        ws.merge_range(r, 0, r, 1, t, B.f_wrap)
        ws.set_row(r, 15 * (1 + len(t) // 115))
        r += 1
    r += 1
    ws.write_string(r, 0, "시트", B.f_head)
    ws.write_string(r, 1, "내용(저장값/수식)", B.f_head)
    desc = {
        "meta": "자료·분석·버전 메타데이터 (저장값)", "resp": "참여자별 분류 응답, 긴 형식(참여자×문항) (저장값)", "psum": "참여자별 묶음 수·크기 요약 (저장값)", "stm": "진술문 ID·순서와 해당 언어 원문 대응표 (저장값)",
        "S": "집단 유사성 빈도 47×47 (저장값, 정수)", "P": "유사성 비율 S/N (저장값)", "D": "비유사성 빈도 N−S (저장값, 정수)", "delta": "정규화 비유사성 1−S/N, MDS 실제 입력 (저장값)", "legacy": "기존 출력 형식(대각선만 0으로 표시한 유사성 빈도) (저장값)",
        "matdef": "행렬 정의표와 Excel 수식 검산 (수식 + 계산 결과값)", "coords": "문항별 2차원 좌표·군집 소속·지도 실루엣·stress 기여 (저장값)", "rec": "추천 군집별 이름·문항 수·포함 문항·명명 근거 (자동 제안·연구자 검토 전)",
        "member": "k=2~10 군집 소속 (저장값)", "dims": "1~5차원 Stress-1·raw stress·RSQ·수렴 (저장값)", "kcmp": "군집 수별 진단 지표 (저장값)", "merges": "Ward 병합 이력·비용 (저장값)",
        "pairs": "1,081개 문항 쌍의 S·P·D·δ·거리·디스패리티·잔차 (저장값)", "spp": "문항별 stress 기여 (저장값에서 합산)", "split": "분할 반분 안정성 요약 (저장값)", "splitv": "분할 반분 반복별 값 (저장값)",
        "valid": "포함·제외 기준과 자료 검증 결과", "metrics": "지표 정의·평가 대상·산식·값의 방향·판단 근거·한계·문헌", "refs": "참고문헌(APA 7판)과 원문 열람 상태", "figs": "그림 파일·캡션·주석·대응 데이터", "chart": "편집 가능한 차트(2차원 지도, 차원별 지표)",
        "cmp": "한국·일본 비교 요약(탐색적)", "S_KR": "한국 참여자만의 S", "S_JP": "일본 참여자만의 S", "P_KR": "P_한국", "P_JP": "P_일본", "Pdiff": "P_한국 − P_일본",
    }
    for key, text in desc.items():
        if SHEET[key] in B.names:
            r += 1
            ws.write_string(r, 0, SHEET[key], B.f_text)
            ws.write_string(r, 1, text, B.f_wrap)
    B.close()
    return B.names
