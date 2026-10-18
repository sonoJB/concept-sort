#!/usr/bin/env python3
"""Builds the three independent per-scope analysis packages (ZIP) from stored result bundles.

  python -X utf8 build_packages.py --bundles DIR --raw raw.json --out OUT --repo REPO --evidence EVDIR [--scopes KR JP ALL]

DIR holds bundle_KR.json / bundle_JP.json / bundle_ALL.json exactly as returned by
GET .../analysis/runs/<id>/bundle. raw.json is the pseudonymous participant export of the SAME data snapshot
(its recomputed fingerprint must equal the bundle's, otherwise the build stops).
"""
import argparse
import csv
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timedelta, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figures as F  # noqa: E402
from common import SCOPE_LABEL_KO, SCOPE_NAME_KO, canonical_hash, fmt, load_json, sha256_bytes, sha256_file, sid, write_csv, write_text  # noqa: E402
from report import blocks_for, render_docx, render_md, render_pdf  # noqa: E402
from scopedata import ScopeData  # noqa: E402
from tables import build_tables, kst, write_csvs, write_xlsx  # noqa: E402

KST = timezone(timedelta(hours=9))


def adjusted_rand(a, b):
    a, b = np.asarray(a), np.asarray(b)
    ua, ub = np.unique(a), np.unique(b)
    C = np.array([[np.sum((a == x) & (b == y)) for y in ub] for x in ua], dtype=float)
    comb2 = lambda v: v * (v - 1) / 2
    sum_ij = comb2(C).sum()
    sum_a = comb2(C.sum(1)).sum()
    sum_b = comb2(C.sum(0)).sum()
    n = C.sum()
    exp = sum_a * sum_b / comb2(n)
    mx = (sum_a + sum_b) / 2
    return float((sum_ij - exp) / (mx - exp)) if mx != exp else 1.0


def procrustes(A, B):
    A = np.asarray(A) - np.mean(A, axis=0)
    B = np.asarray(B) - np.mean(B, axis=0)
    U, s, Vt = np.linalg.svd(B.T @ A)
    R = U @ Vt
    refl = np.linalg.det(R) < 0
    aligned = B @ R
    disparity = float(1 - (s.sum() / (np.linalg.norm(A) * np.linalg.norm(B))) ** 2)
    rel = float(((A - aligned) ** 2).sum() / (A**2).sum())
    ang = float(np.degrees(np.arctan2(R[1, 0], R[0, 0])))
    return aligned, refl, ang, disparity, rel


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundles", required=True)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--evidence", required=True)
    ap.add_argument("--scopes", nargs="*", default=["KR", "JP", "ALL"])
    ap.add_argument("--skip-repro", action="store_true")
    args = ap.parse_args()

    raw = load_json(args.raw)
    bundles = {s: load_json(os.path.join(args.bundles, f"bundle_{s}.json"))["bundle"] for s in ["KR", "JP", "ALL"] if os.path.exists(os.path.join(args.bundles, f"bundle_{s}.json"))}
    results = {}
    for scope in args.scopes:
        results[scope] = build_one(scope, bundles, raw, args)
    print(json.dumps(results, ensure_ascii=False, indent=1))


def build_one(scope, bundles, raw, args):
    b = bundles[scope]
    d = ScopeData(scope, b, raw)
    vr = d.verify_raw()
    if not (vr["S_equals_recount_from_participant_records"] and vr["participants_hash_match"]):
        raise SystemExit(f"[{scope}] raw export does not reproduce the bundle's data fingerprint: {vr}")
    snap = datetime.fromisoformat(b["meta"]["dataSnapshotAt"].replace("Z", "+00:00")).astimezone(KST).strftime("%Y%m%d")
    base = f"{SCOPE_NAME_KO[scope]}_개념도_전체분석자료_{snap}_v{b['meta']['algorithmVersion']}"
    root = os.path.join(args.out, base)
    if os.path.exists(root):
        raise SystemExit(f"{root} exists — refusing to overwrite")
    files = {}  # relative path -> description

    def reg(path, desc):
        files[os.path.relpath(path, root).replace(os.sep, "/")] = desc

    D01, D02, D03, D04, D05, D06, D07, D08, D09, D10, D11 = (os.path.join(root, x) for x in ["01_요약", "02_원자료_가명", "03_진술문", "04_행렬", "05_MDS", "06_진단", "07_군집", "08_그림", "09_보완분석", "10_재현", "11_검증"])
    os.makedirs(root)

    # ---------------------------------------------------------------- tables
    T = build_tables(d, raw)
    ps = d.participants
    # compute alignment for ALL
    cmp_extra = {}
    if scope == "ALL" and "KR" in bundles and "JP" in bundles:
        dk, dj = ScopeData("KR", bundles["KR"], raw), ScopeData("JP", bundles["JP"], raw)
        aligned, refl, ang, disp, rel = procrustes(dk.coords, dj.coords)
        cmp_extra = {"aligned": aligned, "dk": dk, "dj": dj, "refl": refl, "ang": ang, "disp": disp, "rel": rel}
        ari = {"KR k=%d vs JP k=%d" % (dk.rec_k, dj.rec_k): adjusted_rand(dk.sol["labels"], dj.sol["labels"]), "KR k=%d vs ALL k=%d" % (dk.rec_k, d.rec_k): adjusted_rand(dk.sol["labels"], d.sol["labels"]), "JP k=%d vs ALL k=%d" % (dj.rec_k, d.rec_k): adjusted_rand(dj.sol["labels"], d.sol["labels"])}
        name, hdr, rows, note = T["compare"]
        rows += [["지도 비교: Procrustes 정렬(직교 변환 + 평행 이동, 크기 조정 없음)", f"반사 {'예' if refl else '아니오'}, 회전 {ang:.1f}°, 정규화 불일치도(1−(Σσ)²/(‖A‖²‖B‖²)) {disp:.4f}, 상대 잔차 {rel:.4f}"], ["지도 비교 해석 주의", "정렬 후에도 같은 위치가 같은 의미임을 뜻하지 않음; 탐색적"]] + [[f"군집 소속 일치(조정 Rand 지수) {k}", v] for k, v in ari.items()]
        T["compare"] = (name, hdr, rows, note)

    # ---------------------------------------------------------------- figures
    figs = {}
    figinfo = []

    def fig(key, fname, desc, make):
        out = F.save_all(make(), os.path.join(D08, fname))
        figs[key] = f"08_그림/{fname}.png"
        for o in out:
            reg(o, desc)
        figinfo.append([fname, desc])

    coords = d.coords
    label = SCOPE_LABEL_KO[scope]
    k = d.rec_k
    names = {c: d.cluster_name(c) for c in range(1, (k or 0) + 1)}
    fig("map_plain", f"F01_quadrant_point_map_{scope}", f"{label} 사분면 점지도(군집 구분 없음)", lambda: F.draw_plain_quadrant_map(coords, f"{label} 사분면 점지도 (2차원, 문항 번호)"))
    if d.sol:
        fig("map_color", f"F02_concept_map_k{k}_color_{scope}", f"{label} 개념도 추천 {k}군집(색)", lambda: F.draw_map(coords, d.sol["labels"], d.sol["clusters"], names, f"{label} 개념도 (2차원, {k}군집 — 자동 제안명)"))
        fig("map_gray", f"F03_concept_map_k{k}_bw_{scope}", f"{label} 개념도 추천 {k}군집(흑백)", lambda: F.draw_map(coords, d.sol["labels"], d.sol["clusters"], names, f"{label} 개념도 (흑백, {k}군집)", gray=True))
        for alt in d.proposal["alternatives"]:
            s_alt = d.solution(alt["k"])
            fig(f"map_alt{alt['k']}", f"F04_concept_map_k{alt['k']}_alternative_{scope}", f"{label} 개념도 비교 대안 {alt['k']}군집", lambda s_alt=s_alt, alt=alt: F.draw_map(coords, s_alt["labels"], s_alt["clusters"], {}, f"{label} 개념도 비교 대안 ({alt['k']}군집, 명칭 미부여)"))
        fig("dendro", f"F05_ward_dendrogram_{scope}", f"{label} Ward 덴드로그램", lambda: F.fig_dendrogram(a_ward(d), d.n, d.sol["labels"], k, f"{label} Ward 덴드로그램 (k={k} 절단)"))
        fig("sil", f"F06_silhouette_k{k}_{scope}", f"{label} 문항별 실루엣(지도 좌표 기준)", lambda: F.fig_silhouette(d.sol["labels"], d.sol["silhouetteMap"]["perPoint"], names, f"{label} 실루엣 (k={k})"))
        fig("kcmp", f"F07_k_comparison_{scope}", f"{label} 군집 수 비교", lambda: F.fig_k_comparison(d.a["solutions"], d.a["ward"]["merges"], k, f"{label} 군집 수 비교"))
    pr = d.a["pairDiagnostics"]
    fig("shepard", f"F08_shepard_{scope}", f"{label} Shepard 다이어그램", lambda: F.fig_shepard([x["delta"] for x in pr], [x["distance"] for x in pr], [x["disparityKruskal"] for x in pr], f"{label} Shepard 다이어그램 (2차원)"))
    fig("iter", f"F09_objective_history_{scope}", f"{label} 목적함수 반복 이력", lambda: F.fig_iterations(d.a["primary"]["trace"]["rawStress"], d.a["primary"]["selected"]["main"]["iterations"], d.a["primary"]["trace"]["thinned"], f"{label} raw stress 반복 이력"))
    fig("dims", f"F10_stress_by_dimension_{scope}", f"{label} 차원별 Stress-1", lambda: F.fig_dimensions(d.a["dimensions"], f"{label} 차원별 Stress-1 (1~5차원, 보조 비교)"))
    sh = d.a["splitHalf"]
    fig("split", f"F11_split_half_{scope}", f"{label} 반복 분할 신뢰도 분포", lambda: F.fig_split_half(sh["rawValues"], sh["spearmanBrownValues"], sh["design"], f"{label} 반복 분할 신뢰도 ({sh['repetitions']}회)"))
    if scope == "ALL" and cmp_extra:
        c = d.b["comparison"]
        diff = np.array(c["Skr"], dtype=float) / c["nKr"] - np.array(c["Sjp"], dtype=float) / c["nJp"]
        fig("cmp_heat", "F12_KR_JP_difference_heatmap", "P_KR − P_JP 히트맵(공통 색 범위)", lambda: F.fig_heatmap(diff, c["diffColorLimit"], "P_KR − P_JP"))
        iu = np.triu_indices(d.n, 1)
        pk = (np.array(c["Skr"], dtype=float) / c["nKr"])[iu]
        pj = (np.array(c["Sjp"], dtype=float) / c["nJp"])[iu]
        fig("cmp_scatter", "F13_KR_JP_P_scatter", "P_KR 대 P_JP 산점도", lambda: F.fig_scatter_p(pk, pj, "한국 대 일본 문항 쌍 유사성 비율", c["pearson"], c["spearman"]))
        dk, dj = cmp_extra["dk"], cmp_extra["dj"]
        fig("cmp_proc", "F14_KR_JP_procrustes", "한국·일본 지도 Procrustes 정렬(탐색적)", lambda: F.fig_aligned_maps(dk.coords - dk.coords.mean(0), cmp_extra["aligned"], dk.sol["labels"], dj.sol["labels"], f"직교 변환·평행 이동만 허용(크기 조정 없음): 반사 {'예' if cmp_extra['refl'] else '아니오'}, 회전 {cmp_extra['ang']:.1f}°, 정규화 불일치도 {cmp_extra['disp']:.3f}. 각 지도는 자신의 군집(한국 k={dk.rec_k}, 일본 k={dj.rec_k})을 표시. 같은 위치가 같은 의미임을 뜻하지 않음", "한국 · 일본 지도의 Procrustes 정렬(탐색적)"))
    write_csv(os.path.join(D08, "그림목록.csv"), ["파일(확장자 제외)", "설명(.png .svg .pdf 세 형식)"], figinfo)
    reg(os.path.join(D08, "그림목록.csv"), "그림 파일 목록")

    # ---------------------------------------------------------------- csv + xlsx
    csv_map = {
        "summary": "01_요약/분석요약.csv", "metrics": "01_요약/지표_기준_출처.csv", "recommended": "07_군집/추천_군집.csv", "items": "07_군집/군집별_문항_명명근거.csv",
        "coords": "05_MDS/좌표_2D.csv", "kcompare": "07_군집/군집후보비교.csv", "membership": "07_군집/군집소속_k별.csv", "merges": "07_군집/병합이력_병합비용.csv", "clusters_all_k": "07_군집/군집구성_k별.csv",
        "dims": "05_MDS/차원비교_1-5D.csv", "starts": "05_MDS/초기화별_결과_2D.csv", "history": "05_MDS/반복이력_2D.csv", "tie": "05_MDS/동점처리_민감도.csv",
        "pairs": "06_진단/쌍진단_1081.csv", "metric_recompute": "06_진단/지표_독립재계산표.csv", "spp": "06_진단/점별_stress기여.csv", "reliability": "09_보완분석/반복분할_신뢰도_요약.csv", "split_values": "09_보완분석/반복분할_신뢰도_전체값.csv",
        "validation": "02_원자료_가명/자료검증표.csv", "participants_summary": "02_원자료_가명/참여자별_묶음요약.csv", "references": "01_요약/참고문헌.csv",
        "M_S": "04_행렬/S_집단유사성빈도_대각선N.csv", "M_P": "04_행렬/P_유사성비율_대각선1.csv", "M_D": "04_행렬/D_비유사성빈도_대각선0.csv", "M_delta": "04_행렬/delta_비유사성비율_MDS입력_대각선0.csv",
        "M_legacy0": "04_행렬/기존표시형식_빈도행렬_대각선0.csv", "M_legacyN": "04_행렬/기존표시형식_분석용_유사성빈도_대각선N.csv",
        "compare": "09_보완분석/한일비교_요약.csv", "compare_diff": "09_보완분석/P_KR-P_JP.csv", "compare_pkr": "09_보완분석/P_KR.csv", "compare_pjp": "09_보완분석/P_JP.csv",
    }
    desc_csv = {"summary": "분석 요약(핵심 수치)", "metrics": "지표별 정의·계산식·값·기준·판정·출처·한계", "recommended": "추천 군집 표(이름·핵심 내용·명명 근거·경계 문항·검토 상태)", "items": "군집별 문항(한국어·일본어)·실루엣·경계 여부", "coords": "2차원 최종 좌표와 군집", "kcompare": "군집 수 후보 비교", "membership": "k=2~10 군집 소속", "merges": "Ward 전체 병합 이력과 병합 비용", "clusters_all_k": "k별 군집 구성", "dims": "1~5차원 Stress·수렴 비교", "starts": "초기화별(2D) 결과·종료 사유", "history": "선택한 해의 목적함수 반복 이력", "tie": "동점 처리 민감도(공식 결과 아님)", "pairs": "1,081개 문항 쌍 진단표(δ·거리·정규화 디스패리티 d̂·Kruskal 디스패리티 d̂*·각 잔차)", "spp": "점별 stress 기여", "metric_recompute": "쌍 진단표만으로 raw stress·Stress-1(Kruskal)·√(raw/q)·이전 정의·RSQ를 다시 계산해 저장값과 대조한 표", "reliability": "반복 분할 신뢰도 요약", "split_values": "반복 분할 신뢰도 전체 값", "validation": "자료 검증표", "participants_summary": "참여자별 묶음 수·크기 요약", "references": "참고문헌과 열람 상태", "M_S": "S: 집단 유사성 빈도(대각선 N)", "M_P": "P = S/N (대각선 1)", "M_D": "D = N − S (대각선 0)", "M_delta": "δ = 1 − S/N (대각선 0) — MDS 실제 입력", "M_legacy0": "기존 표시 형식: 빈도행렬(대각선만 0으로 표시한 유사성 빈도; 비유사성 아님)", "M_legacyN": "기존 표시 형식: 분석용 유사성빈도(대각선 N)", "compare": "한국·일본 비교(탐색적)", "compare_diff": "P_KR − P_JP", "compare_pkr": "P_KR", "compare_pjp": "P_JP"}
    written = write_csvs(root, T, csv_map)
    for key, rel in csv_map.items():
        if key in T:
            reg(os.path.join(root, rel), desc_csv[key])

    order = ["summary", "metrics", "recommended", "items", "coords", "M_S", "M_P", "M_D", "M_delta", "M_legacy0", "M_legacyN", "kcompare", "merges", "membership", "dims", "starts", "pairs", "metric_recompute", "spp", "reliability", "validation", "tie", "compare", "compare_diff", "references"]
    xl = os.path.join(D01, f"{SCOPE_NAME_KO[scope]}_분석요약.xlsx")
    write_xlsx(xl, T, order)
    reg(xl, "요약 Excel: 분석요약·지표·기준·출처·추천군집·군집별문항·명명근거·좌표·S·P·D·δ·군집후보비교·신뢰도·자료검증·참고문헌 등")

    # ---------------------------------------------------------------- raw (pseudonymous) data
    stm = d.statements
    st_rows = [[s["no"], i + 1, s["id"], s["textKo"], s["textJa"] or "", s["jaStatus"]] for i, s in enumerate(stm)]
    write_csv(os.path.join(D03, "진술문_대응표.csv"), ["진술문 번호", "분석 순서", "DB 진술문 ID", "한국어 원문", "日本語 対応文", "일본어 검수 상태(시스템 값)"], st_rows)
    reg(os.path.join(D03, "진술문_대응표.csv"), "진술문 ID·분석 순서·한국어 원문·일본어 대응문(기존 원문 미변경)")
    resp_rows = []
    wide_hdr = ["가명ID", "국가"] + [f"{sid(i)}-{sid(j)}" for i in range(d.n) for j in range(i + 1, d.n)]
    wide_rows = []
    for p in ps:
        ex = d.extras[p["pid"]]
        piles = sorted({g for g in p["assignment"]})
        for i in range(d.n):
            g = p["assignment"][i]
            resp_rows.append([p["pid"], p["country"], kst(ex["createdAtMs"]), sid(i), i + 1, g + 1, ex["pileLabels"][g]])
        a_ = np.array(p["assignment"])
        same = (a_[:, None] == a_[None, :])[np.triu_indices(d.n, 1)].astype(int)
        wide_rows.append([p["pid"], p["country"]] + same.tolist())
    write_csv(os.path.join(D02, "참여자별_분류응답표.csv"), ["가명ID", "국가", "제출시각(KST)", "진술문", "문항번호", "묶음번호(참여자 내)", "묶음 이름(참여자 입력)"], resp_rows)
    reg(os.path.join(D02, "참여자별_분류응답표.csv"), "참여자별 전체 분류 응답(가명 ID). 묶음 구성은 원본과 동일")
    write_csv(os.path.join(D02, "참여자별_이진유사성행렬_상삼각.csv"), wide_hdr, wide_rows)
    reg(os.path.join(D02, "참여자별_이진유사성행렬_상삼각.csv"), "참여자별 이진 유사성(같은 묶음=1, 다른 묶음=0)의 상삼각 1,081열 — 대각선은 1")
    import xlsxwriter

    xp = os.path.join(D02, "참여자별_분류응답표.xlsx")
    wb = xlsxwriter.Workbook(xp)
    wb.set_properties({"created": datetime(2026, 1, 1, tzinfo=timezone.utc), "title": os.path.basename(xp), "author": "concept-sort analysis package"})
    ws = wb.add_worksheet("분류응답")
    for j, h in enumerate(["가명ID", "국가", "제출시각(KST)", "진술문", "문항번호", "묶음번호", "묶음 이름(참여자 입력)"]):
        ws.write(0, j, h)
    for i, r in enumerate(resp_rows):
        for j, v in enumerate(r):
            ws.write(i + 1, j, v)
    ws2 = wb.add_worksheet("묶음요약")
    for j, h in enumerate(T["participants_summary"][1]):
        ws2.write(0, j, h)
    for i, r in enumerate(T["participants_summary"][2]):
        for j, v in enumerate(r):
            ws2.write(i + 1, j, v)
    wb.close()
    from common import rewrite_zip_deterministic

    rewrite_zip_deterministic(xp)
    reg(xp, "참여자별 분류 응답 Excel(분류응답·묶음요약)")
    ls = d.label_scan()
    rules = f"""# 자료 포함 규칙 · 원자료 지문 ({SCOPE_LABEL_KO[scope]})

- 대상: 본조사(dataRole=MAIN). 파일럿·테스트는 포함하지 않음.
- 포함: 국가 코드가 {('KR 또는 JP' if scope == 'ALL' else scope)}이고 47개 진술문을 정확히 한 번씩 분류한 완결 제출.
- 제외: 파일럿/비본조사, 국가 코드 없음, 미완료, 진술문 중복 배치, 무효 진술문. 적합도를 높이기 위한 참여자·진술문 제외, 재분류, 빈도 수정, 가중치, 평활화, 잡음 추가는 없음.
- 유효 참여자: {d.N}명 (한국 {b['meta']['nKr']}, 일본 {b['meta']['nJp']}).
- 가명화: 이름·전화번호·실제 세션 ID·접근 토큰·인구통계 항목(성별·나이·학교급·학년)은 이 패키지에 없음. 가명 ID는 제출 순서(KR-001…, JP-001…)이며 원본과의 연결표는 이 패키지에 없음.
- 보존: 분류 응답값(묶음 구성)과 참여자가 붙인 묶음 이름은 원본과 동일. 묶음 이름 {ls['labels']}개 중 빈 이름 {ls['empty']}개, 식별자 의심 패턴 {len(ls['flagged_possible_identifier'])}개(수정하지 않음).
- 원본 개인정보 포함 자료는 기존 보호된 백업에만 있음.

## 지문(sha256)
- 참여자 응답 지문(정규화 JSON): {b['meta']['fingerprints']['participantsHash']}
- 동시분류 행렬 지문: {b['meta']['fingerprints']['numericDataHash']}
- 진술문 구조 지문: {b['meta']['fingerprints']['statementStructureHash']}
- 진술문 한국어 내용 지문: {b['meta']['fingerprints']['statementContentHashKo']}
- 진술문 일본어 내용 지문: {b['meta']['fingerprints']['statementContentHashJa']}
- 설정 지문: {b['meta']['fingerprints']['parameterHash']}
- 이 패키지의 응답표에서 지문을 다시 계산한 값과 일치: {vr['participants_hash_match']}
"""
    write_text(os.path.join(D02, "포함규칙_원자료지문.md"), rules)
    reg(os.path.join(D02, "포함규칙_원자료지문.md"), "포함·제외 규칙과 원자료 지문")
    write_text(os.path.join(D04, "행렬설명.md"), matrix_doc(d))
    reg(os.path.join(D04, "행렬설명.md"), "S·P·D·δ 정의, 기존 표시 형식 설명, MDS 실제 입력")

    # naming proposal note + brokerage notes
    write_text(os.path.join(D09, "브리징값_미산출_사유.md"), "# 브리징 값\n\n산출하지 않았습니다. 진술문·군집별 브리징 값의 산식과 정규화 방식을 학술지 원문에서 확인하지 못했고, 임의 대체식을 공식 브리징 값이라고 부를 수 없기 때문입니다. 브리징 값은 MDS 적합도와 구분되며 값만으로 문항 제외·군집 변경을 하지 않습니다.\n")
    reg(os.path.join(D09, "브리징값_미산출_사유.md"), "브리징 값 미산출 사유")
    write_text(os.path.join(D09, "평정자료_미수집.md"), "# 중요도·실행가능성 평정\n\n이 연구 데이터베이스에는 평정 자료(중요도·실행가능성)를 저장하는 항목이 없어 수집되지 않았습니다. 따라서 평정 평균·표준편차·유효 N, 평정지도, 패턴매칭, Go-Zone은 만들지 않았고 분류 빈도로 대체하지 않았습니다. 사분면은 MDS 좌표의 시각적 구획일 뿐 Go-Zone이 아닙니다.\n")
    reg(os.path.join(D09, "평정자료_미수집.md"), "평정 자료 미수집 기록")
    write_text(os.path.join(D07, "군집명_검토상태.md"), review_note(d))
    reg(os.path.join(D07, "군집명_검토상태.md"), "추천 군집 수·군집명의 검토 상태(자동 제안)")

    # ---------------------------------------------------------------- report
    blocks = blocks_for(d, figs, T, vr)
    write_text(os.path.join(D01, f"{SCOPE_NAME_KO[scope]}_분석보고서.md"), render_md(blocks, "../"))
    reg(os.path.join(D01, f"{SCOPE_NAME_KO[scope]}_분석보고서.md"), "분석보고서(편집 가능한 원문, Markdown)")
    render_docx(blocks, D08, os.path.join(D01, f"{SCOPE_NAME_KO[scope]}_분석보고서.docx"))
    reg(os.path.join(D01, f"{SCOPE_NAME_KO[scope]}_분석보고서.docx"), "분석보고서(편집 가능한 원문, Word)")
    pages = render_pdf(blocks, D08, os.path.join(D01, f"{SCOPE_NAME_KO[scope]}_분석보고서.pdf"))
    reg(os.path.join(D01, f"{SCOPE_NAME_KO[scope]}_분석보고서.pdf"), f"분석보고서 PDF({pages}쪽)")

    # ---------------------------------------------------------------- reproduction material
    settings = {"analysis": b["analysis"]["settings"], "algorithmVersion": b["meta"]["algorithmVersion"], "engineSourceCommitSha": b["meta"]["engineSourceCommitSha"], "runId": b["meta"]["runId"], "nodeVersion": b["meta"]["nodeVersion"]}
    write_text(os.path.join(D10, "settings.json"), json.dumps(settings, ensure_ascii=False, indent=2))
    reg(os.path.join(D10, "settings.json"), "분석 설정(seed·허용오차·반복 상한 등)")
    copy_repro(args.repo, D10, reg)
    write_text(os.path.join(D10, "환경.txt"), f"Node.js (analysis run): {b['meta']['nodeVersion']}\nPython: {platform.python_version()}\nnumpy: {np.__version__}\nsource commit: {b['meta']['engineSourceCommitSha']}\n패키지 제작: scripts/package/build_packages.py\n")
    reg(os.path.join(D10, "환경.txt"), "의존성·환경 버전")
    write_text(os.path.join(D10, "실행방법.md"), repro_doc(scope, base))
    reg(os.path.join(D10, "실행방법.md"), "재현 실행 방법")

    # ---------------------------------------------------------------- verification
    repro_out = ""
    repro_ok = None
    if not args.skip_repro:
        # the hash/manifest files do not exist yet; reproduce_mds reads only content files
        pr_ = subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(D10, "reproduce_mds.py"), root], capture_output=True, text=True, encoding="utf-8")
        repro_out, repro_ok = pr_.stdout + pr_.stderr, pr_.returncode == 0
        write_text(os.path.join(D11, "독립재현_실행결과.txt"), repro_out)
        reg(os.path.join(D11, "독립재현_실행결과.txt"), "패키지 안의 reproduce_mds.py(독립 구현) 실행 결과")
    ev = slice_evidence(args.evidence, scope)
    for name, content in ev.items():
        write_text(os.path.join(D11, "교차검증", name), content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, indent=1))
        reg(os.path.join(D11, "교차검증", name), "교차검증·검증 근거 자료")
    write_text(os.path.join(D11, "검증보고서.md"), verification_report(d, vr, repro_ok, repro_out, ev, figs, root))
    reg(os.path.join(D11, "검증보고서.md"), "검증 보고서(자료·행렬·MDS·교차검증·한계)")

    # ---------------------------------------------------------------- README + file list + hashes + manifest
    write_text(os.path.join(root, "00_안내", "README.txt"), readme(d, base))
    reg(os.path.join(root, "00_안내", "README.txt"), "안내: 범위·N·자료 시점·파일 설명·분석 버전")
    listed = {k: v for k, v in files.items()}
    lst_rows = []
    for rel in sorted(listed):
        full = os.path.join(root, rel)
        lst_rows.append([rel, listed[rel], os.path.getsize(full), sha256_file(full)])
    write_csv(os.path.join(root, "00_안내", "파일목록.csv"), ["경로", "설명", "바이트", "SHA-256"], lst_rows)
    files["00_안내/파일목록.csv"] = "파일 목록(자기 자신·SHA256SUMS.txt·manifest.json 제외)"
    sums = "".join(f"{sha256_file(os.path.join(root, rel))}  {rel}\n" for rel in sorted(files))
    write_text(os.path.join(root, "SHA256SUMS.txt"), sums)
    files["SHA256SUMS.txt"] = "SHA-256 목록(자기 자신과 manifest.json 제외)"
    mf = []
    for rel in sorted(files):
        full = os.path.join(root, rel)
        mf.append({"path": rel, "sha256": sha256_file(full), "bytes": os.path.getsize(full), "description": files[rel]})
    manifest = {"manifestVersion": 1, "runId": b["meta"]["runId"], "scope": scope, "zipFilename": base + ".zip", "fingerprints": {"participantsHash": b["meta"]["fingerprints"]["participantsHash"], "numericDataHash": b["meta"]["fingerprints"]["numericDataHash"], "parameterHash": b["meta"]["fingerprints"]["parameterHash"]}, "algorithmVersion": b["meta"]["algorithmVersion"], "engineSourceCommitSha": b["meta"]["engineSourceCommitSha"], "files": mf}
    write_text(os.path.join(root, "manifest.json"), json.dumps(manifest, ensure_ascii=False, indent=1))

    zpath = os.path.join(args.out, base + ".zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel in sorted(list(files) + ["manifest.json"]):
            zi = zipfile.ZipInfo(f"{base}/{rel}", date_time=(2026, 1, 1, 0, 0, 0))  # fixed time: identical content gives identical ZIP bytes
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            with open(os.path.join(root, rel), "rb") as fh:
                z.writestr(zi, fh.read(), compresslevel=6)
    # zip self-check
    with zipfile.ZipFile(zpath) as z:
        bad = z.testzip()
        names = [n for n in z.namelist() if not n.endswith("/")]
        hash_ok = all(sha256_bytes(z.read(f"{base}/{m['path']}")) == m["sha256"] for m in mf)
    return {"zip": zpath, "bytes": os.path.getsize(zpath), "sha256": sha256_file(zpath), "files": len(names), "testzip": bad, "all_hashes_ok": hash_ok, "independent_reproduction": repro_ok, "pdf_pages": pages}


def a_ward(d):
    return d.a["ward"]["linkage"]


def matrix_doc(d):
    return f"""# 행렬 설명 ({SCOPE_LABEL_KO[d.scope]})

개인 이진 유사성 행렬은 같은 묶음이면 1, 다른 묶음이면 0이며 대각선은 1입니다. 이를 N={d.N}명에 대해 합산한 집단 유사성 빈도행렬 S의 대각선은 N입니다(Trochim, 1989).

| 행렬 | 정의 | 대각선 | 큰 값의 의미 | 파일 |
|---|---|---:|---|---|
| S | 같은 묶음에 분류한 참여자 수 | {d.N} | 더 유사함 | S_집단유사성빈도_대각선N.csv |
| P | S/N | 1 | 더 유사함 | P_유사성비율_대각선1.csv |
| D | N−S | 0 | 더 다름 | D_비유사성빈도_대각선0.csv |
| δ | 1−S/N | 0 | 더 다름 (MDS 입력) | delta_비유사성비율_MDS입력_대각선0.csv |

- **실제 MDS 입력**: δ (대각선 0, 모든 비대각 가중치 1). 같은 묶음에 자주 분류된(유사한) 문항 쌍은 δ가 작아 가깝게 배치됩니다. 방향 혼동과 이중 변환은 없습니다.
- **기존 표시 형식**: `기존표시형식_빈도행렬_대각선0.csv`는 유사성 빈도 S의 대각선만 0으로 표시한 것이며 비유사성 행렬이 아닙니다. `기존표시형식_분석용_유사성빈도_대각선N.csv`는 S(대각선 N)와 같습니다. 두 파일을 거리 행렬로 그대로 쓰지 마십시오.
- 검증: 47×47, 대칭, 0≤S≤N, 대각선=N, P=S/N, D=N−S, δ=1−S/N이 모두 계산으로 확인됨{'; 전체 S = 한국 S + 일본 S, 전체 D = 한국 D + 일본 D 이며 전체 P는 국가별 P의 단순 평균이 아니라 N을 가중한 평균임' if d.scope == 'ALL' else ''}.
- 이 식은 분석 대상자 전원이 47개 진술문을 완전히 분류했음을 확인한 뒤에만 적용합니다. 불완전 자료에서 결측을 0으로 바꾸거나 분모를 바꾸지 않습니다.
"""


def review_note(d):
    if not d.proposal:
        return "# 군집명 검토 상태\n\n추천이 첨부되지 않았습니다.\n"
    pr = d.proposal
    return f"""# 추천 군집 수·군집명의 검토 상태

- 상태: **{pr['reviewStatus']} — 자동 제안 (연구자 검토 전)**
- 추천 군집 수: {pr['recommendedK']} (검토한 후보 k={d.a['settings']['ward']['kMin']}–{d.a['settings']['ward']['kMax']}와 보고서의 기준에서의 추천이며 수학적 유일 정답이 아님)
- 군집명은 문항 내용을 읽고 만든 제안입니다. 참여자·전문가 합의를 거치지 않았으므로 ‘합의된 최종 군집명’이 아닙니다.
- 일본어 군집명은 ‘검토용 번역안’이며 기존 일본어 문항 원문을 덮어쓰지 않았습니다.
- 한국·일본이 같은 군집 수여야 한다고 가정하지 않았습니다.
"""


def repro_doc(scope, base):
    return f"""# 재현 실행 방법

1. Python 3.10 이상과 numpy가 필요합니다(scipy·scikit-learn 불필요).
2. 압축을 푼 폴더(`{base}`)에서:
   `python -X utf8 10_재현/reproduce_mds.py .`
   - 02_원자료_가명의 응답표에서 S를 다시 만들고, 응용 프로그램과 같은 의사난수 시작(mulberry32, seed 파생)으로 64회 시작 SMACOF를 독립 구현으로 다시 계산하며, 선택한 해를 1e-12로 계속한 뒤 좌표·Stress-1·Ward 군집 소속·실루엣을 이 패키지의 값과 대조합니다.
   - 모든 항목이 PASS여야 종료 코드 0입니다. `--skip-mds`는 MDS 재계산을 건너뛰고 저장된 좌표로 군집만 확인합니다.
3. `10_재현/ts-source`에는 응용 프로그램이 사용한 TypeScript 분석 소스가 있습니다(소스 커밋은 settings.json). 전체 저장소가 있어야 실행할 수 있으며 참고용입니다.
4. 그림·보고서를 다시 만들려면 `10_재현/package-builder`의 스크립트를 사용합니다(맑은 고딕 또는 Noto Sans CJK 글꼴 필요).
"""


def readme(d, base):
    m = d.meta
    return f"""{SCOPE_LABEL_KO[d.scope]} 개념도 전체 분석자료
================================================
범위: {SCOPE_LABEL_KO[d.scope]}   유효 N: {d.N} (한국 {m['nKr']} · 일본 {m['nJp']})   진술문: {d.n}개   조사 단계: 본조사(MAIN)만
자료 기준 시점: {m['dataSnapshotAt']} (UTC)    분석 실행: {m['computedAt']} (UTC)
분석 버전: {m['algorithmVersion']}   소스 커밋: {m['engineSourceCommitSha']}   실행 ID: {m['runId']}
자료 지문(참여자 응답 sha256): {m['fingerprints']['participantsHash']}

이 ZIP은 다른 두 범위의 ZIP 없이 단독으로 해당 범위의 결과를 이해하고 재현할 수 있도록 만들었습니다.
개인정보(이름·전화번호·실제 세션 ID·토큰)는 없으며 개별 응답은 가명 연구 ID로만 제공합니다.

폴더
  01_요약     요약 Excel, 분석보고서(PDF·Word·Markdown), 지표·기준·출처, 참고문헌
  02_원자료_가명  참여자별 분류 응답, 이진 유사성(상삼각), 묶음 요약, 자료검증표, 포함 규칙·원자료 지문
  03_진술문    진술문 ID·순서·한국어 원문·일본어 대응문
  04_행렬     S·P·D·δ, 기존 표시 형식 두 가지, 행렬 설명
  05_MDS      2차원 좌표, 차원 비교(1~5D), 초기화별 결과·종료 사유, 반복 이력, 동점 처리 민감도
  06_진단     1,081개 문항 쌍 진단표(δ·거리·디스패리티·잔차), 점별 stress 기여
  07_군집     추천 군집·명명 근거, 군집 후보 비교, k별 소속, 병합 이력·비용, 군집명 검토 상태
  08_그림     사분면 점지도·개념도(색·흑백)·덴드로그램·진단 그래프 (PNG 300dpi + SVG + PDF)
  09_보완분석   반복 분할 신뢰도, 브리징 값 미산출 사유, 평정 자료 미수집 기록{', 한국·일본 비교' if d.scope == 'ALL' else ''}
  10_재현     설정, 환경, 실행 방법, 독립 구현(reproduce_mds.py), 분석 소스
  11_검증     검증 보고서, 독립 재현 실행 결과, 교차검증 근거
  파일목록.csv / SHA256SUMS.txt / manifest.json  무결성 확인용

읽는 순서: 01_요약의 요약 Excel과 보고서 → 08_그림 → 필요 시 각 폴더의 CSV.
주의: 수렴과 적합도는 별개입니다. 군집 수·군집명은 자동 제안(연구자 검토 전)이며 확정 명칭이 아닙니다.
"""


def copy_repro(repo, D10, reg):
    ts = os.path.join(D10, "ts-source")
    pairs = [("src/lib/conceptAnalysis", ["smacofV2.ts", "prng.ts", "linalg.ts", "types.ts", "ward.ts", "stress.ts", "smacofV2.test.ts"]), ("src/lib/conceptMap", ["matrices.ts", "clusters.ts", "reliability.ts", "compare.ts", "analyze.ts", "metrics.ts", "references.ts", "mapModel.ts", "bundle.ts", "conceptMap.test.ts"]), ("src/lib/conceptMap/proposals", ["types.ts", "data.ts"])]
    for sub, names in pairs:
        for n in names:
            src = os.path.join(repo, sub, n)
            if os.path.exists(src):
                dst = os.path.join(ts, sub, n)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(src, dst)
                reg(dst, "분석 TypeScript 소스(참고)")
    pb = os.path.join(D10, "package-builder")
    for n in os.listdir(os.path.join(repo, "scripts", "package")):
        if n.endswith(".py") and n != "pdf_test.py":
            os.makedirs(pb, exist_ok=True)
            dst = os.path.join(pb, n)
            shutil.copyfile(os.path.join(repo, "scripts", "package", n), dst)
            reg(dst, "패키지(그림·표·보고서) 제작 스크립트")
    shutil.copyfile(os.path.join(repo, "scripts", "package", "reproduce_mds.py"), os.path.join(D10, "reproduce_mds.py"))
    reg(os.path.join(D10, "reproduce_mds.py"), "독립 재현 스크립트(numpy)")
    for n in ["crossval.py", "crossval_clusters.py", "verify_inputs.py"]:
        src = os.path.join(repo, "scripts", "mds", n)
        if os.path.exists(src):
            dst = os.path.join(D10, "verification-scripts", n)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)
            reg(dst, "검증 스크립트(교차검증·입력 검증)")


def slice_evidence(evdir, scope):
    out = {}
    for name in sorted(os.listdir(evdir)):
        p = os.path.join(evdir, name)
        if name.endswith(".json"):
            j = load_json(p)
            if isinstance(j, dict) and any(k in j for k in ("KR", "JP", "ALL")):
                keep = {k: v for k, v in j.items() if k == scope or k not in ("KR", "JP", "ALL")}
                if scope != "ALL":
                    keep.pop("comparison", None)
                    keep.pop("procrustes", None)
                    for k in ("sessions_total", "main_by_country", "non_main_by_role", "scope_N", "problems", "ALL_equals_KR_plus_JP"):
                        keep.pop(k, None)
                out[name] = keep
        elif name.endswith(".txt") or name.endswith(".md"):
            out[name] = open(p, encoding="utf-8").read()
    return out


def verification_report(d, vr, repro_ok, repro_out, ev, figs, root):
    a = d.a
    p = a["primary"]
    L = [f"# 검증 보고서 — {SCOPE_LABEL_KO[d.scope]}", "", f"분석 버전 {d.meta['algorithmVersion']}, 소스 커밋 {d.meta['engineSourceCommitSha']}, 실행 ID {d.meta['runId']}", ""]
    L += ["## 1. 자료 지문과 행렬", f"- 참여자 기록 → S 재집계 일치: {vr['S_equals_recount_from_participant_records']}", f"- 참여자 기록 지문 재계산 = 분석 실행 시 저장된 지문: {vr['participants_hash_match']} ({vr['participants_hash_recomputed']})", f"- 행렬 점검: {json.dumps(a['matrixChecks'], ensure_ascii=False)}", ""]
    L += ["## 2. MDS 계산", f"- 수치적 수렴: {p['numericallyConverged']}; 시작 {p['convergedStarts']}/{p['startCount']} 수렴; 종료 사유 집계 {json.dumps(p['terminationReasonTally'])}", f"- 선택: 시작 #{p['selected']['initIndex']}, seed {p['selected']['seed']}, 주 실행 {p['selected']['main']['reason']}, 엄격 계속 {p['selected']['strict']['reason']}", f"- 최종 좌표에서 재계산한 지표: raw stress {p['rawStress']}, Stress-1 {p['stress1']}, √(raw/q) {p['stressNormalizedSqrt']}, RSQ {p['rsq']} (Stress-1 = √(raw/q): 국소 최소에서 성립하는 식(Mair et al., 2022, 식 4)을 계산으로 확인)", ""]
    L += ["## 3. 독립 구현 재현(패키지 안의 reproduce_mds.py)", "```", repro_out.strip() or "(실행하지 않음)", "```", ""]
    L += ["## 4. 교차 검증 근거 파일", *(f"- 11_검증/교차검증/{k}" for k in ev), ""]
    L += ["## 5. 이전 계산 방식에서 확인되어 수정한 결함(근거는 교차검증 폴더의 진단 파일)", "- 목적함수(raw stress)가 줄고 있는데 Stress-1이 일시적으로 올랐다는 이유로 시작을 실패 처리해 모든 시작이 2번째 반복에서 끝남.", "- 미수렴·오류 시작이 최종 해로 선택될 수 있었고, 실제 종료 사유가 저장·표시되지 않아 COMPLETED 또는 ‘수렴’처럼 보일 수 있었음.", "- 이전 구현이 표시한 ‘Stress-1’은 분자에 명시적으로 정규화한 디스패리티, 분모에 Σd²를 쓰는 정의로 scikit-learn의 normalized_stress와 같은 정의였음. 오류가 아니라 Kruskal 원정의(디스패리티 크기 최적화)·smacof(R) 보고값과 다른 정의이며 같은 좌표에서 더 큰 값을 냄. 새 분석은 Kruskal 정의를 ‘Stress-1’로 쓰고 이전 정의 값도 함께 보고함. 이전 표시값과 새 값의 차이에는 수렴 상태의 변화와 정의 정비가 함께 들어 있음(교차검증 폴더의 stress_definition_decomposition.json).", "- 수정: raw stress 기준 상대 감소 수렴, 명시적 종료 사유, 수렴한 시작만 선택, 최종 좌표에서 모든 지표 재계산.", ""]
    L += ["## 5-0. Stress 계산 정의와 이전 표시값과의 차이", "- 같은 최종 좌표에서 raw stress(정규화 d̂), Stress-1(Kruskal, 크기 제약 없는 단조 회귀 d̂*), √(raw/q), 이전 구현·scikit-learn 정의 √(raw/Σd²)를 구분해 보고함. 06_진단/지표_독립재계산표.csv는 06_진단/쌍진단_1081.csv의 거리·d̂·d̂*만으로 이들을 다시 계산해 저장값과 대조한 표임.", "- 쌍 진단표·잔차표에는 두 디스패리티(정규화 d̂ → raw stress·√(raw/q)·RSQ, Kruskal d̂* → Stress-1)와 각각의 잔차를 모두 실었고, Shepard 다이어그램의 계단선은 d̂*(Stress-1 정의)임."]
    dec = ev.get("stress_definition_decomposition.json")
    if dec and d.scope in dec:
        r_ = dec[d.scope]
        L += [f"- 이전 표시값 {r_['previously_displayed_stress1_old_engine_unconverged_2_iterations']:.4f}(이전 엔진, 2회 반복 미수렴 상태) → 새 Stress-1 {r_['kruskal_stress1_at_converged_solution']:.4f}. 전체 변화 {r_['total_change']:+.4f} 중 수렴 상태 변화의 효과(이전 정의로 미수렴→수렴) {r_['effect_of_convergence (old definition: unconverged -> converged)']:+.4f}({r_['share_of_total_from_convergence']:.0%}), 정의 정비의 효과(같은 수렴 좌표에서 이전 정의 {r_['old_definition_at_converged_solution']:.4f} → Kruskal {r_['kruskal_stress1_at_converged_solution']:.4f}) {r_['effect_of_definition (old definition -> Kruskal, same converged coordinates)']:+.4f}({r_['share_of_total_from_definition']:.0%}). 감소분 전부가 수렴 개선 효과는 아님."]
    sk = ev.get("external_sklearn_check.json")
    if sk and d.scope in sk:
        x = sk[d.scope]["sklearn_eps_1e-12"]
        L += [f"- 외부 라이브러리 비교(scikit-learn {sk['sklearn_version']}, 같은 시작 배치): 최종 배치 Procrustes 상대 차이 {x['procrustes_relative_difference_vs_ours']:.1e}; sklearn이 보고한 normalized_stress {x['sklearn_reported_normalized_stress']:.5f} = 이전 정의 값 {sk[d.scope]['ours']['v1_definition']:.5f}, 이 분석의 Kruskal Stress-1 {sk[d.scope]['ours']['stress1_kruskal']:.5f}는 sklearn 배치에서 다시 계산해도 {x['metrics_by_this_analysis_on_sklearn_configuration']['stress1_kruskal']:.5f}로 같음.", ""]
    L += ["## 5-1. 라이브러리 동작 확인(비유사성 0의 처리)", "- 이 분석의 엔진은 비유사성 δ=0인 쌍을 결측으로 처리하지 않고 가중치 1의 실제 관측치로 유지함(단위 시험으로 확인).", f"- 이번 자료에서 한 번도 빠짐없이 모두가 함께 분류한 문항 쌍(δ=0)은 {a['matrixChecks']['alwaysTogether']}개이므로 어떤 라이브러리의 0 처리 방식도 결과에 영향을 주지 않음.", "- 참고: scikit-learn 1.8 소스(`sklearn/manifold/_mds.py`, _smacof_single)는 비계량 모드에서 대각선 밖 비유사성 0을 등위회귀에서 제외(결측 취급)하고, 수렴 판정에 정규화 전 raw stress를 사용함(소스 직접 열람).", ""]
    L += ["## 6. 한계", "- 독립 numpy 구현(reproduce_mds.py·crossval.py)은 같은 알고리즘 정의를 다른 코드로 다시 구현한 것이지 외부 검증이 아님. 외부 라이브러리와의 비교: scikit-learn 1.9.1(격리 설치)을 같은 시작 배치로 실행해 최종 배치가 일치함(Procrustes 상대 차이 약 1e-10~1e-7)을 확인했고, sklearn이 보고하는 normalized_stress는 이전 정의 값과 일치함. 이 비교는 R smacof와는 하지 않았음(R 미설치).", "- 참고문헌 일부는 원문을 열람하지 못했음(보고서 참고문헌 표의 ‘열람 상태’ 참조).", "- 번역 동등성·표집·내용 타당도 검토는 이 분석에 포함되지 않음.", ""]
    return "\n".join(L)


if __name__ == "__main__":
    main()
