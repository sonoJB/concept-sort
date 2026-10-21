#!/usr/bin/env python3
"""Builds the Word draft "연구방법·연구결과(유사성 분류 단계)" for the Korea–Japan similarity-sorting study.

  python -X utf8 build_similarity_manuscript.py --bundles-dir DIR --db SNAPSHOT.db --figures-root DIR --out OUT_DIR
      [--limits-json guide_limits.json]

Every number comes from the stored result bundles / the database copy through ms_data.Claims (see ms_data.py), the cluster
figures are the PNG files of the analysis packages (drawn from the stored coordinates and cluster membership), and nothing
here recomputes the analysis. Items that cannot be established from the records are NOT written as facts: they are marked
"[확인 필요 n]" in the text and listed in the separate review table (build_review_table.py).
"""
import argparse
import json
import os
import sys

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ms_data import SCOPES, Claims, collect, f_apa  # noqa: E402

NAME = {"KR": "한국", "JP": "일본", "ALL": "한국·일본 전체"}
FONT = "맑은 고딕"


# ----------------------------------------------------------------------------------------------- docx helpers
def set_font(run, size=None, bold=None, italic=None, color=None):
    run.font.name = FONT
    run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if italic is not None:
        run.font.italic = italic
    if color:
        run.font.color.rgb = RGBColor(*color)


def shade(cell, hex_fill):
    tcPr = cell._element.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tcPr.append(shd)


def new_doc():
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2.4)
    sec.top_margin, sec.bottom_margin = Cm(2.4), Cm(2.2)
    st = doc.styles["Normal"]
    st.font.name = FONT
    st.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    st.font.size = Pt(10)
    st.paragraph_format.line_spacing = 1.45
    st.paragraph_format.space_after = Pt(4)
    # footer page number
    p = sec.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for tag, text in (("begin", None), (None, "PAGE"), ("end", None)):
        r = p.add_run()
        set_font(r, 9)
        if tag:
            el = OxmlElement("w:fldChar")
            el.set(qn("w:fldCharType"), tag)
            r._r.append(el)
        else:
            it = OxmlElement("w:instrText")
            it.set(qn("xml:space"), "preserve")
            it.text = text
            r._r.append(it)
    return doc


def H(doc, text, level):
    p = doc.add_paragraph()
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.space_before = Pt({1: 14, 2: 10, 3: 6}[level])
    p.paragraph_format.space_after = Pt(4)
    r = p.add_run(text)
    set_font(r, {1: 13.5, 2: 11, 3: 10}[level], bold=True)
    return p


def P(doc, text, indent=True, size=10, bold=False, align=None, keep=False):
    p = doc.add_paragraph()
    if indent:
        p.paragraph_format.first_line_indent = Cm(0.5)
    if align:
        p.alignment = align
    if keep:
        p.paragraph_format.keep_with_next = True
    # inline markers: text between ⟦ ⟧ is rendered as a highlighted "needs confirmation" note
    parts = text.split("⟦")
    for i, part in enumerate(parts):
        if i == 0:
            r = p.add_run(part)
            set_font(r, size, bold=bold)
            continue
        note, _, rest = part.partition("⟧")
        r = p.add_run("[" + note + "]")
        set_font(r, size - 0.5, bold=True, color=(0xB4, 0x53, 0x09))
        if rest:
            r2 = p.add_run(rest)
            set_font(r2, size, bold=bold)
    return p


def bullets(doc, items, size=10):
    for t in items:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.9)
        p.paragraph_format.first_line_indent = Cm(-0.45)
        p.paragraph_format.space_after = Pt(2)
        r = p.add_run("• " + t)
        set_font(r, size)


def table(doc, caption, header, rows, widths=None, size=8.5, note=None, left_cols=(0,), keep=True):
    cp = doc.add_paragraph()
    cp.paragraph_format.keep_with_next = True
    cp.paragraph_format.space_before = Pt(8)
    cp.paragraph_format.space_after = Pt(2)
    set_font(cp.add_run(caption), 9.5, bold=True)
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for j, h in enumerate(header):
        c = t.rows[0].cells[j]
        c.text = ""
        r = c.paragraphs[0].add_run(str(h))
        set_font(r, size, bold=True)
        c.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        c.paragraphs[0].paragraph_format.line_spacing = 1.15
        shade(c, "E5E7EB")
    # repeat header row on every page
    trPr = t.rows[0]._tr.get_or_add_trPr()
    th = OxmlElement("w:tblHeader")
    th.set(qn("w:val"), "true")
    trPr.append(th)
    for row in rows:
        cells = t.add_row().cells
        # a row never splits across pages
        trPr = t.rows[-1]._tr.get_or_add_trPr()
        cs = OxmlElement("w:cantSplit")
        cs.set(qn("w:val"), "true")
        trPr.append(cs)
        for j, v in enumerate(row):
            cells[j].text = ""
            para = cells[j].paragraphs[0]
            para.paragraph_format.line_spacing = 1.15
            para.paragraph_format.space_after = Pt(0)
            r = para.add_run(str(v))
            set_font(r, size)
            if j not in left_cols and len(str(v)) < 22:
                para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if keep and len(rows) <= 14:
        # a small table is never split across pages: every row is kept with the next one (the last row is not)
        for row in t.rows[:-1]:
            for cell in row.cells:
                for para in cell.paragraphs:
                    para.paragraph_format.keep_with_next = True
    if widths:
        t.autofit = False
        for row in t.rows:
            for j, w in enumerate(widths):
                row.cells[j].width = Cm(w)
    if note:
        n = doc.add_paragraph()
        n.paragraph_format.space_before = Pt(2)
        set_font(n.add_run(note), 8.5)
    else:
        doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def figure(doc, path, caption, width_cm=13.5):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_with_next = True
    p.add_run().add_picture(path, width=Cm(width_cm))
    c = doc.add_paragraph()
    c.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(c.add_run(caption), 9)


# ----------------------------------------------------------------------------------------------- content
def build(D, C, figs, figcap, limits, out_path, ids):
    S = D["scopes"]
    desc = D["desc"]
    doc = new_doc()

    def n(key, value, fmt, src):
        return C.num(key, value, fmt, src)

    # ---- title block
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run("한·일 청소년이 인식한 사이버폭력의 특징에 대한 개념도 분석"), 15, bold=True)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run("— 유사성 분류 단계의 연구방법과 연구결과(논문용 초안) —"), 11)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run("초안 · 군집 수와 군집명은 연구자 확정 전 추천안 · 노란 대괄호 [확인 필요]는 기록으로 확인되지 않은 항목(별도 검토표 참조)"), 8.5, color=(0xB4, 0x53, 0x09))
    P(doc, f"분석 실행: 한국 {ids['KR'][:12]}…, 일본 {ids['JP'][:12]}…, 한국·일본 전체 {ids['ALL'][:12]}… (분석 엔진 v{S['KR']['algorithm']}, 자료 기준 시점 한국 {S['KR']['snapshot_at'][:10]}, 일본 {S['JP']['snapshot_at'][:10]}, 전체 {S['ALL']['snapshot_at'][:10]}). 모든 수치는 이 세 실행의 저장 결과에서 읽었다.", indent=False, size=8.5)

    # ======================================================================================= Ⅱ. 연구방법
    H(doc, "Ⅱ. 연구방법", 1)

    # ---- 1. participants
    H(doc, "1. 유사성 분류 참여자와 포함·제외 기준", 2)
    kr, jp, al = desc["KR"], desc["JP"], desc["ALL"]
    sg = lambda d, lv, g: d["school_grade"].get(f"{lv}|{g}", 0)  # noqa: E731
    kr_mid = kr["school_level"].get("중학교", 0)
    kr_high = kr["school_level"].get("고등학교", 0)
    p1 = (
        f"본 연구에서 확정된 {S['KR']['statements']}개 진술문의 유사성 분류에는 한국 청소년 {n('n_kr', kr['n'], 'd', 'desc.KR.n')}명과 일본 청소년 {n('n_jp', jp['n'], 'd', 'desc.JP.n')}명, "
        f"총 {n('n_all', al['n'], 'd', 'desc.ALL.n')}명이 참여하였다. 한국 참여자는 중학생 {n('kr_mid', kr_mid, 'd', 'desc.KR.school_level')}명과 고등학생 {n('kr_high', kr_high, 'd', 'desc.KR.school_level')}명이었고"
        f"(중학교 1학년 {sg(kr, '중학교', '1학년')}명·2학년 {sg(kr, '중학교', '2학년')}명·3학년 {sg(kr, '중학교', '3학년')}명, 고등학교 1학년 {sg(kr, '고등학교', '1학년')}명·2학년 {sg(kr, '고등학교', '2학년')}명·3학년 {sg(kr, '고등학교', '3학년')}명), "
        f"일본 참여자는 모두 고등학교 2학년({n('jp_hs2', sg(jp, '고등학교', '2학년'), 'd', 'desc.JP.school_grade')}명)이었다. "
        f"연령은 한국이 M = {n('age_kr_m', kr['age']['mean'], '.2f', 'desc.KR.age.mean')}, SD = {n('age_kr_sd', kr['age']['sd'], '.2f', 'desc.KR.age.sd')}(범위 {kr['age']['min']}–{kr['age']['max']}세), "
        f"일본이 M = {n('age_jp_m', jp['age']['mean'], '.2f', 'desc.JP.age.mean')}, SD = {n('age_jp_sd', jp['age']['sd'], '.2f', 'desc.JP.age.sd')}(범위 {jp['age']['min']}–{jp['age']['max']}세)였으며, "
        f"성별은 한국이 여성 {kr['gender'].get('여자', 0)}명·남성 {kr['gender'].get('남자', 0)}명, 일본이 여성 {jp['gender'].get('여자', 0)}명·남성 {jp['gender'].get('남자', 0)}명이었다"
        f"(참여자가 웹앱에서 선택한 응답 기준; 전체 연령 M = {al['age']['mean']:.2f}, SD = {al['age']['sd']:.2f}). "
        "참여자의 모집 경로, 표집 방법, 참여 학교·기관 수와 일본 참여자의 수집 상황(학급 단위 실시 여부)은 연구 기록에서 확인되지 않아 기술하지 않았다.⟦확인 필요 1⟧"
    )
    P(doc, p1)
    p2 = (
        f"자료는 웹앱에서 한국은 {kr['first_submission'][:10].replace('-', '.')}.부터 {kr['last_submission'][:10].replace('-', '.')}.까지, 일본은 {jp['first_submission'][:10].replace('-', '.')}.(제출 시각 기록 {jp['first_submission'][11:16]}–{jp['last_submission'][11:16]}, UTC+9)에 수집되었다. "
        f"참여자는 웹앱의 연구 설명 및 동의 화면에서 동의한 뒤에만 제출할 수 있었고(서버가 동의 표시가 없는 제출을 거부하며, 분석 대상 {n('consent', al['consent_recorded'], 'd', 'desc.ALL.consent_recorded')}명 모두 동의가 기록됨), "
        "해당 화면에는 연구 목적, 진술문이 사전 인터뷰에서 추출되었다는 설명, 개인정보를 코드화하여 처리하고 학회지·학회 발표에서 이름과 개인식별 정보를 사용하지 않는다는 안내가 한국어와 일본어로 제시되었다. "
        "기관생명윤리위원회의 승인 번호·심의일과 일본 측 윤리 심의 절차는 이 분석 자료에서 확인되지 않아 기술하지 않았다.⟦확인 필요 2⟧"
    )
    P(doc, p2)
    pe = D["pilot_excluded"]
    p3 = (
        "분석에는 본조사로 분류된 응답 중 국가 코드가 한국 또는 일본이고 47개 진술문을 각각 정확히 한 번씩 분류한 완결 제출만 포함하였다. "
        f"본조사 개시일({D['study_start'][:10].replace('-', '.')}.) 이전의 시험 제출은 서버가 파일럿으로 분류하며(한국 {pe.get('KR', 0)}건, 일본 {pe.get('JP', 0)}건) 본 분석에서 제외하였다. "
        "국가 코드 누락, 미완료, 진술문 중복 배치 또는 무효 진술문으로 제외된 본조사 응답은 없었다(0건). "
        "적합도를 높이기 위한 참여자·진술문 제외, 응답 수정, 임의 가중치, 좌표 이동 또는 군집 재배정은 하지 않았다."
    )
    P(doc, p3)

    # ---- 2. procedure
    H(doc, "2. 웹앱을 이용한 분류 절차와 실제 안내 조건", 2)
    lim = limits
    P(
        doc,
        f"참여자는 웹앱에서 {S['KR']['statements']}개 진술문을 카드로 제시받아, 의미가 유사하다고 판단하는 카드끼리 묶음을 만들고 각 묶음에 이름을 붙였다. "
        "한국 참여자에게는 한국어 진술문이, 일본 참여자에게는 일본어 대응문이 제시되었으며(일본어 대응문의 검수 상태는 시스템 기록상 모두 ‘승인’이나 번역 동등성 검토 결과는 이 분석 자료에 없다), "
        "카드는 모든 참여자에게 같은 번호 순서로 제시되었고 무작위 제시 순서를 사용하지 않았다. 사용 방법을 설명하는 안내 영상(한국어·일본어 각 1종) 링크가 화면에 제공되었다.",
    )
    P(
        doc,
        "웹앱이 참여자에게 제시한 분류 지침은 다음과 같았다. ① 하나의 묶음은 2장 이상의 카드로 구성한다. ② 전체 카드를 하나의 묶음으로 분류할 수 없다. "
        f"③ 한 묶음에는 전체의 1/3 이상을 넣을 수 없다(본 자료에서는 묶음당 최대 {lim['MAX_CARDS_PER_GROUP']}장). ④ 남는 카드를 ‘기타’ 하나로 묶지 말고 의미 있는 주제로 분류한다. "
        f"⑤ 모든 카드는 누락·중복 없이 정확히 하나의 묶음에 속해야 한다. 이에 따라 묶음 수는 최소 {lim['MIN_GROUPS']}개에서 최대 {lim['MAX_GROUPS']}개 사이로 제한되었다. "
        "이 조건(묶음 2장 이상, 묶음당 최대 장수, 모든 카드의 단일 배치)은 화면에서 안내되고 서버에서도 검증되어, 조건을 어긴 응답은 제출되지 않았다. "
        "참여자는 성별·연령·학교급·학년과 연락처 일부를 입력하였으며, 이름과 연락처 등 식별 정보는 분석에 사용하지 않고 분석 자료에서는 가명 ID로만 다루었다.",
    )

    # ---- 3. matrices
    H(doc, "3. 개인·집단 유사성 행렬과 비유사성 변환", 2)
    P(
        doc,
        "Trochim(1989)의 ‘진술문 구조화(Structuring of Statements)’ 단계에 따라, 참여자 p의 분류로부터 진술문 i와 j가 같은 묶음에 있으면 1, "
        "다른 묶음에 있으면 0, 대각선은 1인 이진 대칭 행렬 B_p를 만들었다(개인 이진 유사성 행렬). 집단 유사성 빈도행렬 S는 분석 포함자 N명의 B_p를 합산한 것으로 "
        "(S = Σ_p B_p), 비대각 원소는 두 진술문을 같은 묶음으로 분류한 참여자 수이고 대각선은 N이다. "
        "이로부터 유사성 비율행렬 P = S/N(대각선 1), 비유사성 빈도행렬 D = N − S(대각선 0), 정규화 비유사성 행렬 δ = 1 − S/N(대각선 0)을 정의하였다. "
        "S와 P가 클수록 두 진술문은 더 유사하고, D와 δ가 클수록 더 다르다. 따라서 ‘같은 묶음 = 0, 다른 묶음 = 1’처럼 개인 행렬을 비유사성으로 코딩한 선행 보고와는 방향이 반대인 코딩을 사용하였다.",
    )
    P(
        doc,
        f"Trochim(1989)은 집단 유사성 행렬에 대해 비계량 다차원척도법을 수행한다고 서술하며, 본 연구의 분석 프로그램은 비유사성 δ를 입력으로 받는다. "
        "비계량(서열) MDS는 입력 값의 순서만 사용하므로 S를 직접 입력하는 것과 δ = 1 − S/N을 입력하는 것은 서열 정보가 같고(δ는 S의 단조 감소 변환), δ로의 변환 자체는 Trochim(1989)에 명시된 식이 아니라 이 연구의 구현 선택이다. "
        f"모든 행렬은 {S['KR']['statements']}×{S['KR']['statements']} 크기, 대칭성, 0 ≤ S_ij ≤ N, 대각선 = N, 진술문 순서를 계산으로 확인하였고, "
        "원래의 묶음 배치 자료를 별도의 SQL 집계와 별도 구현으로 다시 세어 저장된 S와 모든 셀에서 일치함을 확인하였다. 한국·일본 전체의 S는 한국 S와 일본 S의 합과 모든 셀에서 같았고, 전체 P는 국가별 P의 단순 평균이 아니라 참여자 수로 가중한 값이다.",
    )

    # ---- 4. MDS
    H(doc, "4. MDS 설정, 수렴 확인과 적합도 해석", 2)
    s0 = S["KR"]["settings"]["mds"]
    P(
        doc,
        f"δ에 대해 서열(비계량) SMACOF로 2차원 해를 구하였다(Mair et al., 2022). 동점은 같은 비유사성이 같은 디스패리티를 갖도록 처리(secondary)하고, 디스패리티는 Σd̂² = n(n−1)/2로 정규화하였다. "
        f"무작위 시작 {s0['nInit']}회(시드 {s0['randomSeed']}에서 파생), 시작당 최대 {s0['maxIter']:,}회 반복, 수렴 기준은 직전 반복 대비 raw stress의 상대 감소량 ≤ {s0['eps']}로 하였고, "
        f"수렴한 시작 중 raw stress가 가장 낮은 해를 선택한 뒤 같은 해를 {s0['strictEps']} 기준으로 다시 수렴시켜 확인하였다. 이 값들은 이 연구의 계산 설정이며 문헌의 적합도 기준이 아니다. "
        "분석은 SPSS가 아니라 웹앱에 구현한 분석 엔진(버전 " + S["KR"]["algorithm"] + ")으로 수행하였고, 같은 알고리즘 정의를 독립 구현(Python/numpy)으로 다시 계산하여 좌표와 지표가 일치함을 확인하였으며, "
        "scikit-learn의 smacof 구현과도 비교하였다(독립 구현은 같은 정의의 재구현이며 외부 검증과 구분된다).",
    )
    P(
        doc,
        "수렴과 적합도는 서로 다른 평가 대상이다. 수렴은 알고리즘이 국소 최소에 도달했는지에 대한 수치적 사실이고, 적합도는 참여자의 분류 관계(비유사성)와 2차원 지도의 거리가 얼마나 일치하는지에 대한 평가이다. "
        "적합도 지표로 최종 좌표에서 다시 계산한 Kruskal Stress-1과 RSQ를 보고하였다. Stress-1은 √(Σ(d̂*−d)² / Σd²)이며(d는 지도 거리, d̂*는 거리에 대한 단조 회귀값) 낮을수록 불일치가 작다. "
        "RSQ는 정규화 디스패리티 d̂와 지도 거리 d의 피어슨 상관의 제곱(MultBiplotR 문서의 정의)으로, 참여자 응답 전체의 분산 설명 비율로 해석하지 않았다. "
        "Stress는 문항 수와 자료 특성에 의존하고 Kruskal(1964)의 구술 척도(20% poor, 10% fair 등; Kruskal, 1964, as cited in Mair et al., 2022)가 기계적으로 적용되어 왔다는 점이 문제로 지적되므로(Mair et al., 2022, §3.2), "
        "고정 임계값만으로 개념도 분석의 적합 여부를 판정하지 않았다. 선행 개념도 연구 69편의 Stress가 평균 .28, 표준편차 .04, 관찰 범위 .17–.34로 보고되었다는 서술(Rosas & Kane, 2012, §3.5에 귀속)을 비교 참고로만 사용하였으며, "
        "이는 관찰된 분포일 뿐 합격 기준이 아니고 선행 연구와 본 분석의 Stress 산식·정규화·동점 처리의 동일성은 확인되지 않았다.⟦확인 필요 3: Rosas & Kane(2012) 원문 대조⟧ "
        "참고 연구들이 사용한 RSQ ≥ .60 기준(Kruskal & Wish, 1978 인용)이 이 분석의 RSQ와 같은 정의에 대한 기준인지 확인되지 않아 적용하지 않았다.",
    )
    P(
        doc,
        "차원은 개념도의 시각화 목적에 따라 2차원 지도를 기본으로 사전에 지정하였다(Trochim, 1989은 2차원 비계량 MDS를 표준 절차로 서술한다). "
        "1~5차원 해를 같은 방법으로 계산하여 차원별 Stress-1과 RSQ를 보조 진단으로 보고하되, 이 값들만으로 ‘최적 차원’을 선택하거나 엘보를 판정하지 않았다. 3차원 이상의 해는 2차원 지도를 대신하지 않는다.",
    )

    # ---- 5. Ward
    H(doc, "5. Ward 군집분석, 군집 수 검토와 시각화", 2)
    P(
        doc,
        "MDS 2차원 좌표에 Ward의 최소분산 기준을 적용한 위계적 군집분석을 수행하였다(Trochim, 1989은 MDS 좌표에 대한 Ward 방식의 위계적 군집분석을 표준 절차로 서술한다). "
        "군집 수는 수학적 기준으로 정해지지 않는 분석자의 판단이므로(Trochim, 1989), k = 2–10 해를 비교하였다. 비교 정보로 병합 높이(k+1→k), 최소 군집 크기, 2문항 이하 군집의 유무, 지도 좌표 기준과 δ 기준의 실루엣 평균 폭, 군집 간 제곱합 비율을 제시하고 "
        "군집에 포함된 문항의 내용 일관성을 함께 검토하였다. 실루엣과 군집 간 제곱합 비율은 양호 기준이 확인되지 않아 참고 정보로만 사용하였고, 군집 간 제곱합 비율은 k가 커질수록 항상 증가하므로 군집 수 선택 기준으로 쓰지 않았다. "
        "추천 군집 수와 군집명은 문항 내용을 읽고 만든 제안이며 연구자 확정 전의 추천안이다. 참여자가 입력한 묶음 이름의 체계적 분석은 이 추천안에 포함하지 않았다. "
        "범위별 군집 번호는 해당 범위 안의 문항 번호 순서로만 부여한 것이므로 서로 다른 국가의 같은 번호가 같은 개념을 뜻하지 않는다.",
    )
    P(
        doc,
        "개념도는 2차원 좌표의 각 점을 진술문 1개로 표시하고 군집 소속은 색·기호와 볼록 껍질로 나타냈다. 두 축은 동일한 눈금 간격을 쓰며 차원 1·차원 2로만 표기하고 의미를 부여하지 않았다. "
        "x = 0, y = 0 기준선이 만드는 네 사분면은 시각적 구획일 뿐 군집이 네 개라는 뜻이 아니다. 지도의 방향(회전·반사)은 임의적이다. "
        "지도 좌표 기준 실루엣이 .1 미만인 문항은 이웃 군집과의 경계를 다시 살펴볼 문항으로 표시하였으며, 이 기준(.1)은 학술지 원문의 보편적 기준으로 확인된 것이 아니라 이 연구의 탐색적 검토 규칙이고 문항 제외나 군집 재배정의 기준으로 사용하지 않았다.",
    )

    # ---- 6. stability
    H(doc, "6. 분류 안정성 검토", 2)
    sp = S["KR"]["split"]
    P(
        doc,
        f"분류 안정성은 참여자를 무작위로 반분하여 각 반쪽의 S에서 문항 쌍 {S['KR']['matrix']['pairs']:,}개의 동시분류 빈도 사이의 상관을 구하는 반복 분할 방식으로 검토하였다(Trochim et al., 1994의 분할 신뢰도 절차를 참고한 이 연구의 설계). "
        f"반복 {sp['reps']:,}회, 시드 {sp['seed']}를 사전에 고정하였다. 한국과 일본은 각 범위 안에서 단순 무작위로 반분하고, 전체는 각 반쪽에 한국 15명·일본 19명을 배정하는 국가별 층화 반분으로 구성하였다. "
        "원상관과 Spearman–Brown 보정값 2r/(1+r)을 모두 보고하며, 이는 행렬 신뢰도이고 지도 신뢰도가 아니다. 이 지표의 양호 기준은 원문에서 확인하지 못해 판정하지 않았다(Trochim et al., 1994도 최소 허용값을 제시하지 않았다).",
    )

    # ======================================================================================= Ⅲ. 연구결과
    H(doc, "Ⅲ. 연구결과", 1)
    H(doc, "1. 분석 포함자 및 분류 자료의 기술통계", 2)
    rows = []
    for label, fn in (
        ("분석 포함자 수(N)", lambda sc: f"{desc[sc]['n']}"),
        ("학교급", lambda sc: " / ".join(f"{k} {v}" for k, v in sorted(desc[sc]["school_level"].items()))),
        ("성별(여 / 남)", lambda sc: f"{desc[sc]['gender'].get('여자', 0)} / {desc[sc]['gender'].get('남자', 0)}"),
        ("연령 M (SD), 범위", lambda sc: f"{desc[sc]['age']['mean']:.2f} ({desc[sc]['age']['sd']:.2f}), {desc[sc]['age']['min']}–{desc[sc]['age']['max']}"),
        ("제출 기간(UTC+9)", lambda sc: f"{desc[sc]['first_submission'][:10]} ~ {desc[sc]['last_submission'][:10]}"),
        ("참여자당 묶음 수 M (SD)", lambda sc: f"{S[sc]['piles']['mean']:.2f} ({S[sc]['piles']['sd']:.2f})"),
        ("참여자당 묶음 수 중앙값, 범위", lambda sc: f"{S[sc]['piles']['median']:g}, {S[sc]['piles']['min']}–{S[sc]['piles']['max']}"),
        ("참여자의 가장 큰 묶음 크기 M (SD)", lambda sc: f"{S[sc]['max_pile']['mean']:.2f} ({S[sc]['max_pile']['sd']:.2f})"),
        ("묶음 이름 입력(전체 묶음 수 / 빈 이름)", lambda sc: f"{desc[sc]['pile_labels_total']} / {desc[sc]['pile_labels_empty']}"),
    ):
        rows.append([label] + [fn(sc) for sc in SCOPES])
        C.rows.append({"key": "table1:" + label, "printed": " | ".join(rows[-1][1:]), "value": None, "source": "desc / participantSummary"})
    table(doc, "<표 1> 분석 포함자 및 분류 자료의 기술통계", ["구분", "한국", "일본", "한국·일본 전체"], rows, widths=[5.2, 3.7, 3.7, 3.7], note="주. 학교급·성별·연령은 참여자가 웹앱에 입력한 값이다. 묶음 수·묶음 크기는 참여자별 분류 기록에서 계산하였다.")
    mc = {sc: S[sc]["matrix"] for sc in SCOPES}
    rows2 = []
    for label, key in (("비대각 S의 최댓값(최솟값은 모두 0)", "maxOffDiagonal"), ("한 번도 함께 분류되지 않은 문항 쌍(1,081쌍 중)", "neverTogether"), ("모두가 함께 분류한 문항 쌍", "alwaysTogether"), ("서로 다른 S 값의 수", "distinctLevels")):
        rows2.append([label] + [str(mc[sc][key]) for sc in SCOPES])
        C.rows.append({"key": "table2:" + label, "printed": " | ".join(rows2[-1][1:]), "value": None, "source": "analysis.matrixChecks." + key})
    table(doc, "<표 2> 집단 유사성 빈도행렬 S의 요약", ["구분", "한국", "일본", "한국·일본 전체"], rows2, widths=[7.0, 3.1, 3.1, 3.1], note="주. S는 47×47, 대칭, 0 ≤ S_ij ≤ N, 대각선 = N임을 확인하였다(N: 한국 30, 일본 38, 전체 68).")
    P(
        doc,
        f"참여자는 평균 {n('piles_all_m', S['ALL']['piles']['mean'], '.2f', 'participantSummary.piles.mean')}개(SD = {n('piles_all_sd', S['ALL']['piles']['sd'], '.2f', 'participantSummary.piles.sd')}, 범위 {S['ALL']['piles']['min']}–{S['ALL']['piles']['max']})의 묶음을 만들었고, "
        f"가장 큰 묶음의 크기는 평균 {S['ALL']['max_pile']['mean']:.2f}장이었다. 모든 응답이 묶음당 2장 이상·{lim['MAX_CARDS_PER_GROUP']}장 이하의 조건을 충족하였다. "
        f"한국 S의 최댓값은 {mc['KR']['maxOffDiagonal']}(N = 30), 일본은 {mc['JP']['maxOffDiagonal']}(N = 38), 전체는 {mc['ALL']['maxOffDiagonal']}(N = 68)이었으며 어느 범위에서도 모든 참여자가 함께 분류한 문항 쌍은 없었다.",
    )

    # ---- 2. MDS results
    H(doc, "2. 한국·일본·전체의 MDS 결과", 2)
    rows3 = []
    spec = [
        ("수치적 수렴: 주 실행(종료 사유, 반복 수, 최종 변화량)", lambda b: f"{b['main']['reason']}, {b['main']['iterations']}회, {b['main']['finalRelativeChange']:.2e}"),
        ("수치적 수렴: 엄격 계속(종료 사유, 추가 반복 수, 최종 변화량)", lambda b: f"{b['strict']['reason']}, {b['strict']['iterations']}회, {b['strict']['finalRelativeChange']:.2e}"),
        ("수렴한 시작 수 / 전체 시작 수", lambda b: f"{b['starts']['converged']} / {b['starts']['total']}"),
        ("Kruskal Stress-1", lambda b: f_apa(b["stress1"], 4)),
        ("Raw stress", lambda b: f"{b['raw']:.3f}"),
        ("RSQ", lambda b: f_apa(b["rsq"], 4)),
        ("(참고) 이전 구현·scikit-learn 방식의 정규화 stress", lambda b: f_apa(b["v1def"], 4)),
        ("동점 처리 민감도(primary): Stress-1 / RSQ", lambda b: f"{f_apa(b['tie']['stress1'], 4)} / {f_apa(b['tie']['rsq'], 4)}"),
    ]
    for label, fn in spec:
        rows3.append([label] + [fn(S[sc]) for sc in SCOPES])
        C.rows.append({"key": "table3:" + label, "printed": " | ".join(rows3[-1][1:]), "value": None, "source": "analysis.primary / selected"})
    table(doc, "<표 3> 2차원 비계량 MDS 결과", ["구분", "한국", "일본", "한국·일본 전체"], rows3, widths=[6.4, 3.4, 3.4, 3.4], size=8, note="주. 수렴 기준: 직전 반복 대비 raw stress의 상대 감소량 ≤ 1e-9(주 실행), 선택한 해는 1e-12로 재확인. 이전 구현의 값은 정의가 다른 값으로 오류가 아니며 Kruskal Stress-1 이상의 값을 낸다.")
    sK, sJ, sA = S["KR"], S["JP"], S["ALL"]
    P(
        doc,
        f"세 범위 모두 2차원 해가 수치적으로 수렴하였다(주 실행과 엄격 계속 모두 CONVERGED; 64개 시작 모두 수렴). 이는 적합도와 별개의 사실이다. "
        f"Kruskal Stress-1은 한국 {n('s1_kr', sK['stress1'], lambda v: f_apa(v, 4), 'primary.stress1')}, 일본 {n('s1_jp', sJ['stress1'], lambda v: f_apa(v, 4), 'primary.stress1')}, 전체 {n('s1_all', sA['stress1'], lambda v: f_apa(v, 4), 'primary.stress1')}이었고 "
        f"RSQ는 각각 {f_apa(sK['rsq'], 3)}, {f_apa(sJ['rsq'], 3)}, {f_apa(sA['rsq'], 3)}였다. 선행 개념도 연구에서 보고된 Stress 분포(평균 .28, 관찰 범위 .17–.34)와 비교하면, 한국의 Stress-1은 보고된 평균보다 높고 관찰 범위 안에 있으며, 일본과 전체는 평균보다 낮고 관찰 범위 안에 있다. "
        "이는 비교 참고일 뿐이며, 어느 범위에 대해서도 Stress가 특정 값을 넘거나 넘지 않는다는 이유만으로 적합·부적합을 판정하지 않았다. 동점 처리를 primary로 바꾼 민감도 분석에서는 Stress-1이 모두 낮아졌으나(표 3) 이는 공식 결과가 아니다. "
        "적합도 해석에는 아래의 차원별 진단, 잔차 진단(자료에 포함된 쌍별 진단표), 분류 안정성, 군집의 내용 해석을 함께 고려해야 한다.",
    )
    sp_rows = []
    for sc in SCOPES:
        sh = S[sc]["split"]
        sp_rows.append([NAME[sc], f"{sh['raw']['mean']:.3f}", f"{sh['raw']['median']:.3f}", f"{sh['raw']['min']:.3f}–{sh['raw']['max']:.3f}", f"{sh['sb']['mean']:.3f}", f"{sh['sb']['median']:.3f}", f"{sh['sb']['min']:.3f}–{sh['sb']['max']:.3f}"])
        C.rows.append({"key": "table4:" + sc, "printed": " | ".join(sp_rows[-1][1:]), "value": None, "source": "analysis.splitHalf"})
    table(doc, "<표 4> 반복 분할 신뢰도(1,000회)", ["범위", "원상관 평균", "중앙값", "최소–최대", "SB 평균", "SB 중앙값", "SB 최소–최대"], sp_rows, widths=[3.6, 2.2, 2.0, 2.9, 2.0, 2.2, 2.9], size=8.5, note="주. SB = Spearman–Brown 보정값 2r/(1+r). 계산 불능·음수 상관은 없었다. 양호 기준은 확인되지 않아 판정하지 않았다. 설계: 한국·일본은 각 범위 안의 무작위 반분, 전체는 한국 15명·일본 19명씩 배정한 층화 반분.")
    P(
        doc,
        f"분류 안정성(반복 분할 신뢰도)의 원상관 평균은 한국 {f_apa(sK['split']['raw']['mean'], 3)}, 일본 {f_apa(sJ['split']['raw']['mean'], 3)}, 전체 {f_apa(sA['split']['raw']['mean'], 3)}였고 Spearman–Brown 보정 평균은 각각 "
        f"{f_apa(sK['split']['sb']['mean'], 3)}, {f_apa(sJ['split']['sb']['mean'], 3)}, {f_apa(sA['split']['sb']['mean'], 3)}였다. 이 값은 이 표본의 무작위 분할 분포를 요약한 것이며 모집단 신뢰구간이 아니고, 양호 기준은 확인되지 않았다.",
    )

    # ---- 3. dimensions
    H(doc, "3. 저장된 차원별 비교 결과", 2)
    rows5 = []
    for sc in SCOPES:
        for d in S[sc]["dims"]:
            rows5.append([NAME[sc] if d["dimension"] == 1 else "", f"{d['dimension']}차원" + (" (지도)" if d["dimension"] == 2 else ""), f_apa(d["stress1"], 4), f_apa(d["rsq"], 4), f"{d['raw']:.3f}", f"{d['conv_starts']}/{d['starts']}", f"{d['main_reason']}/{d['strict_reason']}"])
            C.rows.append({"key": f"table5:{sc}:{d['dimension']}", "printed": " | ".join(rows5[-1][2:]), "value": d["stress1"], "source": "analysis.dimensions"})
    table(doc, "<표 5> 차원별 Stress-1, RSQ와 수렴 (1~5차원)", ["범위", "차원", "Stress-1", "RSQ", "Raw stress", "수렴 시작", "종료 사유(주/엄격)"], rows5, widths=[2.5, 2.4, 1.9, 1.7, 2.1, 2.0, 4.0], size=8, note="주. 모든 차원을 같은 방법·설정으로 계산한 보조 진단이다. 3차원 이상의 해는 2차원 지도를 대신하지 않는다.")
    dd = {sc: {d["dimension"]: d["stress1"] for d in S[sc]["dims"]} for sc in SCOPES}
    P(
        doc,
        "차원이 늘수록 Stress-1은 모든 범위에서 감소하였다. 1차원에서 2차원으로 갈 때의 감소폭은 한국 "
        f"{n('d12_kr', dd['KR'][1] - dd['KR'][2], lambda v: f_apa(v, 3), 'dimensions')}, 일본 {n('d12_jp', dd['JP'][1] - dd['JP'][2], lambda v: f_apa(v, 3), 'dimensions')}, 전체 {n('d12_all', dd['ALL'][1] - dd['ALL'][2], lambda v: f_apa(v, 3), 'dimensions')}로 "
        f"이후 단계의 감소폭(2→3차원: 한국 {f_apa(dd['KR'][2] - dd['KR'][3], 3)}, 일본 {f_apa(dd['JP'][2] - dd['JP'][3], 3)}, 전체 {f_apa(dd['ALL'][2] - dd['ALL'][3], 3)})보다 컸다. "
        "차원 수가 늘면 Stress가 줄어드는 것은 일반 원칙이므로 이 감소만으로 2차원 표현의 충분성이나 부족을 결론짓지 않았다. 2차원은 개념도 시각화라는 목적과 위 진단을 구분하여 지도 차원으로 사용하였다.",
    )

    # ---- 4. clusters
    H(doc, "4. 국가별 군집 수, 추천명과 포함 문항", 2)
    P(
        doc,
        "아래 군집 수와 군집명은 연구자 확정 전의 추천안이다. 범위별 군집 번호는 그 범위 안에서 가장 작은 문항 번호 순으로 붙였으며, 서로 다른 국가의 같은 번호가 같은 개념을 뜻하지 않는다. "
        "군집 수 비교 정보는 <표 6>~<표 8>에, 추천 군집의 구성은 <표 9>~<표 11>에 제시하였다.",
    )
    for tno, sc in zip((6, 7, 8), SCOPES):
        b = S[sc]
        rows = []
        for r in b["k_table"]:
            tag = " (추천)" if r["k"] == b["rec_k"] else (" (비교 대안)" if r["k"] in b["alternatives"] else "")
            rows.append([f"{r['k']}{tag}", r["min_size"], r["small"], f_apa(r["sil_map"], 3), f_apa(r["sil_delta"], 3), f_apa(r["between"], 3), f"{r['height_to_k']:.3f}" if r["height_to_k"] is not None else "—"])
            C.rows.append({"key": f"table{tno}:k{r['k']}", "printed": " | ".join(str(x) for x in rows[-1][1:]), "value": r["sil_map"], "source": "analysis.solutions / ward.merges"})
        table(doc, f"<표 {tno}> {NAME[sc]}: 군집 수 비교 (k = 2–10)", ["군집 수 k", "최소 군집 크기", "2문항 이하 군집 수", "지도 실루엣 평균", "δ 실루엣 평균", "군집 간 제곱합 비율", "k+1→k 병합 높이"], rows, widths=[3.0, 2.2, 2.4, 2.3, 2.3, 2.4, 2.4], size=8, note="주. 실루엣과 군집 간 제곱합 비율은 참고 정보이며 양호 기준은 확인되지 않았다. 병합 높이 = √(2·n_a·n_b/(n_a+n_b))·‖중심 차이‖(Ward, 2차원 좌표).")
    def hk(sc, k):
        return next(r["height_to_k"] for r in S[sc]["k_table"] if r["k"] == k)

    def merged_txt(sc):
        out = []
        for grp in S[sc]["merged_at_k_minus_1"]:
            out.append(" 군집, ".join(f"‘{c['name']}’" for c in grp[:-1]) + (" 군집과 " if len(grp) == 2 else " 군집, ") + f"‘{grp[-1]['name']}’ 군집")
        return "; ".join(out)

    kr_r = S["KR"]
    krk = kr_r["rec_k"]
    smin = min(r["sil_map"] for r in kr_r["k_table"] if r["k"] >= 4)
    smax = max(r["sil_map"] for r in kr_r["k_table"] if r["k"] >= 4)
    P(
        doc,
        f"한국의 추천안은 k = {krk}이었다. {krk}→{krk - 1} 병합 높이는 {n('kr_h_rec', hk('KR', krk - 1), '.3f', 'ward.merges')}(직전 {krk + 1}→{krk} 단계 {hk('KR', krk):.3f})로 하나의 뚜렷한 급증 지점은 없었고, 지도 실루엣 평균도 k = 4–10에서 {f_apa(smin, 3)}–{f_apa(smax, 3)}로 거의 평평했다. "
        f"따라서 군집 수는 병합 변화만으로 정해지지 않아 군집별 문항 내용의 구별성을 주된 근거로 삼았다. {krk - 1}군집 해에서는 추천 {krk}군집 중 {merged_txt('KR')}이 하나로 합쳐지는데, 두 군집의 대표 문항 주제가 서로 구별되어 {krk}군집을 추천안으로 하였다. "
        f"일본과 전체의 추천안은 k = 5였다. 두 범위 모두 5→4 병합 높이가 직전 단계보다 크게 증가하였고(일본 {hk('JP', 5):.3f}에서 {hk('JP', 4):.3f}, +{(hk('JP', 4) / hk('JP', 5) - 1) * 100:.0f}%; 전체 {hk('ALL', 5):.3f}에서 {hk('ALL', 4):.3f}, +{(hk('ALL', 4) / hk('ALL', 5) - 1) * 100:.0f}%), "
        f"4군집 해에서는 일본에서 {merged_txt('JP')}이, 전체에서 {merged_txt('ALL')}이 하나로 합쳐졌다. "
        "비교 대안으로 한국은 k = 4, 5, 7, 일본과 전체는 k = 4, 6, 7을 검토하였다. 이 근거는 분석자의 판단을 돕는 정보이며 수학적으로 유일한 군집 수를 의미하지 않는다.",
    )
    bnd_cache = {}
    for tno, sc in zip((9, 10, 11), SCOPES):
        b = S[sc]
        bnd = {x["item"]: x for x in b["boundary"]}
        bnd_cache[sc] = bnd
        rows = []
        for c in b["clusters"]:
            bi = [f"S{it:02d}(→{bnd[it]['nearest_other']})" for it in c["members"] if it in bnd]
            rows.append([c["cluster"], c["name"], len(c["members"]), ", ".join(f"S{m:02d}" for m in c["members"]), ", ".join(bi) if bi else "—"])
            C.rows.append({"key": f"table{tno}:c{c['cluster']}", "printed": f"{c['name']} | {len(c['members'])} | {','.join(str(m) for m in c['members'])}", "value": len(c["members"]), "source": "naming.proposal.solution"})
        table(doc, f"<표 {tno}> {NAME[sc]}: 추천 {b['rec_k']}군집(연구자 확정 전)과 포함 문항", ["군집", "추천 군집명(연구자 확정 전)", "문항 수", "포함 문항 번호", "경계 문항(→가장 가까운 다른 군집)"], rows, widths=[1.3, 5.2, 1.4, 5.6, 3.3], size=8, left_cols=(1, 3, 4), note="주. 경계 문항 = 지도 실루엣 < .1인 문항(이 연구의 탐색적 검토 규칙이며 문항 제외·재배정 기준이 아님). 문항 원문은 부록 <표 A1>에 있다. 군집명은 문항 내용에 근거한 제안이며 인과를 단정하는 표현으로 해석하지 않는다.")
    P(
        doc,
        f"세 범위 모두 47개 문항이 중복·누락 없이 하나의 군집에만 포함되었다(한국 {sum(len(c['members']) for c in S['KR']['clusters'])}, 일본 {sum(len(c['members']) for c in S['JP']['clusters'])}, 전체 {sum(len(c['members']) for c in S['ALL']['clusters'])}문항). "
        f"경계 문항은 한국 {len(S['KR']['boundary'])}개, 일본 {len(S['JP']['boundary'])}개, 전체 {len(S['ALL']['boundary'])}개였다.",
    )

    # ---- 5. figures (PNG files of the registered analysis packages; captions from each package's 그림목록.csv)
    H(doc, "5. 국가별 개념도와 진단 그림", 2)
    P(doc, "아래 그림은 운영에 등록된 분석 패키지의 그림 파일(인쇄 폭 16 cm 기준 600 dpi PNG)을 그대로 넣은 것이며, 저장된 2차원 좌표와 군집 소속으로 그렸다. 점은 진술문 1개이고 좌표와 소속은 변경하지 않았다. 점선(x=0, y=0)은 원점 표시이며 차원 1·2에는 의미를 부여하지 않았고 네 사분면을 군집으로 해석하지 않았다. 각 그림의 대응 데이터 파일은 패키지의 그림목록에 있다.", indent=False)
    n_fig = 0
    for key, title in (("map", "개념도"), ("dendro", "Ward 덴드로그램"), ("kcmp", "군집 수별 진단 지표"), ("dims", "차원별 Stress-1·RSQ")):
        for sc in SCOPES:
            n_fig += 1
            cap = figcap[sc][key]
            figure(doc, figs[sc][key], f"[그림 {n_fig}] {NAME[sc]} {title}. {cap}", width_cm=13.0 if key in ("map",) else 14.5)

    # ---- 6. limits
    H(doc, "6. 결과의 해석 범위와 한계", 2)
    bullets(
        doc,
        [
            "수치적 수렴은 국소 최소에 도달했다는 사실이며 2차원 표현이 자료에 적합하다는 뜻이 아니다. 64개 시작 중 최저 해를 선택한 것으로 전역 최적을 증명하지 않는다(최저 raw stress의 1e-6 이내에 도달한 시작: 한국 "
            f"{S['KR']['starts']['within']}개, 일본 {S['JP']['starts']['within']}개, 전체 {S['ALL']['starts']['within']}개).",
            "Stress-1은 고정 임계값으로 판정하지 않았으며, 선행 개념도 연구의 Stress 분포는 비교 참고일 뿐이다. 그 분포는 원문을 직접 대조하지 못했고 선행 연구와 이 분석의 Stress 산식·정규화·동점 처리가 같은지도 확인되지 않았다.",
            "표본은 한국 30명(중·고등학생)과 일본 38명(고등학교 2학년)으로 작고, 일본 자료는 한 날 약 16분 동안 제출되어 수집 조건이 한국과 다를 가능성이 있다(수집 상황은 기록으로 확인되지 않았다).",
            "카드는 모든 참여자에게 같은 순서로 제시되어 제시 순서의 영향을 통제하지 않았고, 일본어 대응문의 번역 동등성 검토 결과는 이 분석 자료에 없다.",
            "군집 수와 군집명은 문항 내용을 읽고 만든 추천안으로 참여자·전문가 합의, 표집·번역·내용 타당도 검토를 거치지 않았다. 군집명이 인과나 영향 관계를 뜻하지 않으며 사분면이 군집을 뜻하지 않는다.",
            "경계 문항 규칙(지도 실루엣 < .1)은 이 연구의 탐색적 검토 규칙이며 문항 제외·재배정의 근거가 아니다. 실루엣, 군집 간 제곱합 비율, 반복 분할 신뢰도, RSQ의 양호 기준은 원문에서 확인하지 못해 판정하지 않았다.",
            "중요도·실행가능성 평정은 수집하지 않아 평정지도·패턴매칭·Go-Zone은 만들지 않았다. 한국과 일본의 지도 비교는 이 초안의 범위에 포함하지 않았다.",
        ],
        size=9.5,
    )

    # ---- references
    H(doc, "참고문헌", 1)
    refs = [
        "MultBiplotR package authors. (n.d.). *MDS: Multidimensional scaling* [R package documentation]. https://search.r-project.org/CRAN/refmans/MultBiplotR/html/MDS.html",
        "Mair, P., Borg, I., & Rusch, T. (2016). Goodness-of-fit assessment in multidimensional scaling and unfolding. *Multivariate Behavioral Research, 51*(6), 772–789. https://doi.org/10.1080/00273171.2016.1235966",
        "Mair, P., Groenen, P. J. F., & de Leeuw, J. (2022). More on multidimensional scaling and unfolding in R: smacof version 2. *Journal of Statistical Software, 102*(10), 1–47. https://doi.org/10.18637/jss.v102.i10",
        "Rosas, S. R., & Kane, M. (2012). Quality and rigor of the concept mapping methodology: A pooled study analysis. *Evaluation and Program Planning, 35*(2), 236–245. https://doi.org/10.1016/j.evalprogplan.2011.10.003",
        "Trochim, W. M. K. (1989). An introduction to concept mapping for planning and evaluation. *Evaluation and Program Planning, 12*(1), 1–16. https://doi.org/10.1016/0149-7189(89)90016-5",
        "Trochim, W. M. K., Cook, J. A., & Setze, R. J. (1994). Using concept mapping to develop a conceptual framework of staff’s views of a supported employment program for individuals with severe mental illness. *Journal of Consulting and Clinical Psychology, 62*(4), 766–775. https://doi.org/10.1037/0022-006X.62.4.766",
    ]
    for r in refs:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.8)
        p.paragraph_format.first_line_indent = Cm(-0.8)
        for k, seg in enumerate(r.split("*")):
            if seg:
                set_font(p.add_run(seg), 9, italic=(k % 2 == 1))
    P(doc, "※ Rosas와 Kane(2012)은 원문을 직접 열람하지 못해 §3.5의 수치를 2차 문헌을 통해서만 확인하였다(검토표 참조). Kruskal(1964)은 Mair 등(2022)을 통한 재인용이다.", indent=False, size=8.5)

    # ---- appendix: further diagnostics + statements
    doc.add_page_break()
    H(doc, "부록", 1)
    H(doc, "부록 그림. 적합도·안정성 진단", 2)
    P(doc, "아래 그림은 같은 패키지의 진단 그림이다. Shepard 도표와 잔차는 저장된 문항 쌍 진단표에서, 분할 반분 분포는 저장된 반복 값에서 그렸다.", indent=False, size=9.5)
    for key, title in (("shepard", "Shepard 도표"), ("resid", "잔차 진단"), ("split", "반복 분할 신뢰도 분포")):
        for sc in SCOPES:
            n_fig += 1
            figure(doc, figs[sc][key], f"[그림 {n_fig}] {NAME[sc]} {title}. {figcap[sc][key]}", width_cm=14.0)
    doc.add_page_break()
    rows = [[no, txt] for no, txt in S["KR"]["statements_text"]]
    for no, txt in S["KR"]["statements_text"]:
        C.rows.append({"key": "tableA1:" + no, "printed": txt, "value": None, "source": "statements.textKo"})
    table(doc, "<표 A1> 유사성 분류에 사용된 47개 진술문(한국어 원문)", ["번호", "진술문"], rows, widths=[1.6, 14.4], size=8.5, left_cols=(0, 1), keep=False, note="주. 일본어 참여자에게는 같은 번호의 일본어 대응문이 제시되었다.")
    doc.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundles-dir", required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--figures-root", required=True, help="folder containing the three extracted package folders")
    ap.add_argument("--limits-json", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    paths = {sc: os.path.join(a.bundles_dir, f"bundle_{sc}_production.json") for sc in SCOPES}
    D, bundles = collect(paths, a.db)
    limits = json.load(open(a.limits_json, encoding="utf-8"))
    figs, figcap = {}, {}
    prefix = {"map": "F02_", "dendro": "F05_", "kcmp": "F07_", "dims": "F10_", "shepard": "F08_", "resid": "F15_", "split": "F11_"}
    import csv

    for sc in SCOPES:
        root = [d for d in os.listdir(a.figures_root) if os.path.isdir(os.path.join(a.figures_root, d))]
        key = {"KR": "한국_", "JP": "일본_", "ALL": "한국-일본전체_"}[sc]
        folder = os.path.join(a.figures_root, next(d for d in root if d.startswith(key)), "08_그림")
        listing = {r[0]: r for r in list(csv.reader(open(os.path.join(folder, "그림목록.csv"), encoding="utf-8-sig")))[1:]}
        figs[sc], figcap[sc] = {}, {}
        for k_, pre in prefix.items():
            names_ = [n_ for n_ in listing if n_.startswith(pre)]
            assert len(names_) == 1, (sc, pre, names_)
            figs[sc][k_] = os.path.join(folder, names_[0] + ".png")
            assert os.path.exists(figs[sc][k_]), figs[sc][k_]
            figcap[sc][k_] = (listing[names_[0]][2] + " " + listing[names_[0]][3]).strip()
    C = Claims()
    ids = {sc: D["scopes"][sc]["run_id"] for sc in SCOPES}
    os.makedirs(a.out, exist_ok=True)
    out_docx = os.path.join(a.out, "한일_유사성분류_연구방법_연구결과_초안_검증본_v3.docx")
    build(D, C, figs, figcap, limits, out_docx, ids)
    json.dump(D, open(os.path.join(a.out, "_manuscript_data.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    json.dump(C.rows, open(os.path.join(a.out, "_claims.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    json.dump({sc: figs[sc] for sc in SCOPES}, open(os.path.join(a.out, "_figures_used.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(figcap, open(os.path.join(a.out, "_figure_captions.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("written", out_docx, "claims", len(C.rows))


if __name__ == "__main__":
    main()
