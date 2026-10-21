"""Tables for the package: summary Excel workbook + CSV files for every table. Every number is read from the stored
bundle or recomputed deterministically from it (matrices from S); nothing is typed in by hand."""
import os
from datetime import datetime, timedelta, timezone

import numpy as np
import xlsxwriter

from common import SCOPE_LABEL_KO, fmt, ko_design, ko_text, sid, write_csv
from scopedata import ScopeData

KST = timezone(timedelta(hours=9))


def kst(ms):
    return datetime.fromtimestamp(ms / 1000, KST).strftime("%Y-%m-%d %H:%M:%S")


def matrix_rows(M, as_int=False):
    header = ["문항"] + [sid(i) for i in range(M.shape[0])]
    rows = [[sid(i)] + [int(round(v)) if as_int else float(v) for v in M[i]] for i in range(M.shape[0])]
    return header, rows


def build_tables(d: ScopeData, raw, cross=None):
    """Return {key: (sheet_name, header, rows, note)} — an ordered dict of every table."""
    T = {}
    a, m, scope = d.a, d.meta, d.scope
    p = a["primary"]
    sel = p["selected"]
    # ------------------------------------------------------------------ summary
    summ = [
        ["범위", SCOPE_LABEL_KO[scope]],
        ["유효 참여자 N", f"{d.N} (한국 {m['nKr']} · 일본 {m['nJp']})"],
        ["진술문 수", d.n],
        ["조사 단계", "본조사(MAIN)만 — 파일럿·테스트 제외"],
        ["자료 기준 시점(KST)", datetime.fromisoformat(m["dataSnapshotAt"].replace("Z", "+00:00")).astimezone(KST).strftime("%Y-%m-%d %H:%M:%S")],
        ["분석 실행 시각(KST)", datetime.fromisoformat(m["computedAt"].replace("Z", "+00:00")).astimezone(KST).strftime("%Y-%m-%d %H:%M:%S")],
        ["분석 버전(엔진)", m["algorithmVersion"]],
        ["소스 커밋", m["engineSourceCommitSha"]],
        ["실행 ID", m["runId"]],
        ["자료 지문(참여자 응답, sha256)", m["fingerprints"]["participantsHash"]],
        ["행렬 지문(sha256)", m["fingerprints"]["numericDataHash"]],
        ["설정 지문(sha256)", m["fingerprints"]["parameterHash"]],
        ["MDS", "2차원 비계량 SMACOF, 동점 처리 secondary, 입력 δ = 1 − S/N, 가중치 1"],
        ["시작 / 최대 반복 / 허용오차 / 엄격 허용오차", f"{a['settings']['mds']['nInit']} / {a['settings']['mds']['maxIter']} / {a['settings']['mds']['eps']} / {a['settings']['mds']['strictEps']}"],
        ["선택한 시작", f"#{sel['initIndex']} (seed {sel['seed']})" if sel else "없음"],
        ["수치적 수렴", "예" if p["numericallyConverged"] else "아니오"],
        ["종료 사유(주 실행 / 엄격 계속)", f"{sel['main']['reason']} / {sel['strict']['reason']}" if sel else ""],
        ["반복 횟수(주 + 엄격)", f"{sel['main']['iterations']} + {sel['strict']['iterations']}" if sel else ""],
        ["최종 변화량(주 / 엄격)", f"{sel['main']['finalRelativeChange']:.3e} / {sel['strict']['finalRelativeChange']:.3e}" if sel else ""],
        ["raw stress", p["rawStress"]],
        ["Stress-1 (Kruskal)", p["stress1"]],
        ["RSQ (디스패리티–거리 상관의 제곱)", p["rsq"]],
        ["추천 군집 수 / 검토 상태", f"{d.rec_k} / {d.proposal['reviewStatus']} (자동 제안, 연구자 검토 전)" if d.proposal else "없음"],
        ["분할 신뢰도(원상관 평균 / SB 평균)", f"{fmt(a['splitHalf']['rawR']['mean'], 3)} / {fmt(a['splitHalf']['spearmanBrown']['mean'], 3)}" if a["splitHalf"]["rawR"] else "계산 불가"],
        ["해석 주의", "전역 최적을 증명하지 않음; 수렴과 적합도는 별개; 사분면은 시각적 구획; 군집명은 자동 제안"],
    ]
    T["summary"] = ("분석요약", ["항목", "값"], summ, "")

    # ------------------------------------------------------------------ metrics
    mrows = []
    for me in d.b["metrics"]:
        for ci, c in enumerate(me["criteria"]):
            mrows.append([me["nameKo"] if ci == 0 else "", me.get("evaluates", "") if ci == 0 else "", me["definitionKo"] if ci == 0 else "", me["formula"] if ci == 0 else "", ko_text(me["valueDisplay"]) if ci == 0 else "", c["kind"], c["labelKo"], ko_text(c["text"]), ", ".join(c["sourceKeys"]), c.get("location", "")])
        mrows.append(["", "", "", "", "", "판정", "", " | ".join(f"{v['aspectKo']}[{v['tone']}] {v['textKo']}" for v in me["verdicts"]), ", ".join(me["sourceKeys"]), ""])
        mrows.append(["", "", "", "", "", "적용 한계", "", " / ".join(me["limitsKo"]), "", ""])
    T["metrics"] = ("지표·기준·출처", ["지표", "평가 대상", "정의", "계산식", "실제 값", "기준 종류", "기준 이름", "기준 내용·판정·한계", "출처 키", "원문 위치"], mrows, "")

    # ------------------------------------------------------------------ recommended clusters
    rec_rows, items_rows = [], []
    if d.sol:
        bd = d.boundary(d.sol)
        for c in d.sol["clusters"]:
            nm = d.names.get(c["cluster"], {})
            bnd = [f"{sid(i)}({bd[i]['silhouette']:.2f}→군집{bd[i]['nearest_other']})" for i in c["members"] if bd[i]["is_boundary"]]
            rec_rows.append([c["cluster"], nm.get("nameKo", ""), nm.get("nameJa", "") + " (검토용 번역안)" if nm else "", c["size"], nm.get("coreContentKo", ""), nm.get("basisKo", ""), ", ".join(f"S{x}" for x in nm.get("representativeStatements", [])), ", ".join(bnd), round(c["meanSilhouette"], 4), d.proposal["reviewStatus"] + " (자동 제안·연구자 검토 전)"])
            for i in c["members"]:
                s = d.statements[i]
                items_rows.append([c["cluster"], nm.get("nameKo", ""), s["no"], s["textKo"], s["textJa"] or "", round(bd[i]["silhouette"], 4), "예" if bd[i]["is_boundary"] else "", bd[i]["nearest_other"], round(float(d.coords[i][0]), 6), round(float(d.coords[i][1]), 6)])
    T["recommended"] = ("추천군집", ["군집 번호", "추천 군집명", "일본어(검토용 번역안)", "문항 수", "핵심 내용", "명명 근거", "대표 문항", "경계 문항(지도 실루엣<0.1 → 가장 가까운 다른 군집)", "평균 실루엣(지도)", "검토 상태"], rec_rows, "")
    T["items"] = ("군집별문항·명명근거", ["군집 번호", "추천 군집명", "문항", "한국어 원문", "日本語 対応文", "지도 실루엣", "경계 문항", "가장 가까운 다른 군집", "차원 1", "차원 2"], items_rows, "")

    # ------------------------------------------------------------------ coordinates
    crow = []
    for i in range(d.n):
        c = d.sol["labels"][i] if d.sol else ""
        crow.append([sid(i), float(d.coords[i][0]), float(d.coords[i][1]), c, d.cluster_name(c) if c != "" else ""])  # full precision: this CSV is a numeric reference file
    T["coords"] = ("좌표", ["문항", "차원 1", "차원 2", f"군집(k={d.rec_k})", "추천 군집명"], crow, "")

    # ------------------------------------------------------------------ matrices
    for key, name, M, as_int in (("S", "S 집단유사성빈도", d.S, True), ("P", "P 유사성비율", d.P, False), ("D", "D 비유사성빈도", d.D, True), ("delta", "δ 비유사성비율(MDS입력)", d.delta, False)):
        h, r = matrix_rows(M, as_int)
        T["M_" + key] = (name, h, r, "")
    legacy0 = d.S.copy()
    np.fill_diagonal(legacy0, 0)
    h, r = matrix_rows(legacy0, True)
    T["M_legacy0"] = ("기존표시_빈도행렬(대각0)", h, r, "")
    h, r = matrix_rows(d.S, True)
    T["M_legacyN"] = ("기존표시_분석용대각선N", h, r, "")

    # ------------------------------------------------------------------ cluster candidates
    merges = {mm["clustersAfter"]: mm["height"] for mm in a["ward"]["merges"]} if a["ward"] else {}
    alt = {x["k"]: x["commentKo"] for x in d.proposal["alternatives"]} if d.proposal else {}
    kc = [[s["k"], s["minSize"], s["smallClusters"], round(s["silhouetteMap"]["mean"], 6), round(s["silhouetteDelta"]["mean"], 6), round(s["betweenShare"], 6), merges.get(s["k"]), "추천" if s["k"] == d.rec_k else ("비교 대안" if s["k"] in alt else ""), alt.get(s["k"], "")] for s in a["solutions"]]
    T["kcompare"] = ("군집후보비교", ["군집 수 k", "최소 군집 크기", "2문항 이하 군집 수", "지도 실루엣 평균", "δ 실루엣 평균", "군집 간 제곱합 비율", "k+1→k 병합 높이", "구분", "병합·분할 변화와 내용 비교"], kc, "")
    mem = [[sid(i)] + [s["labels"][i] for s in a["solutions"]] for i in range(d.n)]
    T["membership"] = ("군집소속_k별", ["문항"] + [f"k={s['k']}" for s in a["solutions"]], mem, "")
    T["merges"] = ("병합이력", ["단계", "왼쪽 노드", "오른쪽 노드", "병합 높이", "병합 비용(군집 내 제곱합 증가량)", "병합 후 크기", "병합 후 남은 군집 수"], [[x["step"], x["left"], x["right"], x["height"], x["wssIncrease"], x["sizeAfter"], x["clustersAfter"]] for x in a["ward"]["merges"]] if a["ward"] else [], "")
    rat = []
    for s in a["solutions"]:
        for c in s["clusters"]:
            rat.append([s["k"], c["cluster"], c["size"], c["geometry"]["kind"], round(c["meanSilhouette"], 6), round(c["withinSS"], 6), ",".join(sid(i) for i in c["members"]), ",".join(sid(i) for i in c["foreignPointsInside"])])
    T["clusters_all_k"] = ("군집구성_k별", ["k", "군집 번호", "문항 수", "경계 도형", "평균 실루엣(지도)", "군집 내 제곱합", "포함 문항", "경계 안 다른 군집 문항"], rat, "")

    # ------------------------------------------------------------------ MDS
    T["dims"] = ("차원비교", ["차원", "Stress-1", "√(raw/q)", "raw stress", "RSQ", "수렴 시작/전체", "선택 시작", "주 실행 종료 사유", "엄격 계속 종료 사유", "반복(주)", "반복(엄격)", "수치적 수렴", "비고"], [[x["dimension"], x["stress1"], x["stressNormalizedSqrt"], x["rawStress"], x["rsq"], f"{x['convergedStarts']}/{x['startCount']}", x["selected"]["initIndex"] if x["selected"] else "", x["selected"]["main"]["reason"] if x["selected"] else "", x["selected"]["strict"]["reason"] if x["selected"] else "", x["selected"]["main"]["iterations"] if x["selected"] else "", x["selected"]["strict"]["iterations"] if x["selected"] else "", "예" if x["numericallyConverged"] else "아니오", "지도에 사용" if x["isPrimary"] else "보조 비교(2차원 결과의 대용 아님)"] for x in a["dimensions"]], "")
    T["starts"] = ("초기화별(2D)", ["시작 번호", "seed", "종료 사유", "반복", "raw stress", "Stress-1", "최종 변화량", "최대 상대 증가", "선택"], [[s["initIndex"], s["seed"], s["reason"], s["iterations"], s["rawStress"], s["stress1"], s["finalRelativeChange"], s["maxRelativeIncrease"], "선택" if sel and s["initIndex"] == sel["initIndex"] else ""] for s in p["starts"]], "")
    T["history"] = ("반복이력(2D)", ["반복", "raw stress", "직전 대비 상대 감소"], [[i + 1, v, (p["trace"]["relativeChange"][i - 1] if i >= 1 and i - 1 < len(p["trace"]["relativeChange"]) else None)] for i, v in enumerate(p["trace"]["rawStress"])] if p["trace"] else [], "")
    if a["tieSensitivity"]:
        t = a["tieSensitivity"]
        T["tie"] = ("동점처리_민감도", ["항목", "값"], [["동점 처리", "primary (동점 분리 허용) — 공식 결과 아님"], ["수렴", t["converged"]], ["선택 상태", t["selectionStatus"]], ["raw stress", t["rawStress"]], ["Stress-1", t["stress1"]], ["RSQ", t["rsq"]], ["종료 사유(주/엄격)", f"{t['mainReason']} / {t['strictReason']}"], ["수렴 시작", f"{t['convergedStarts']}/{t['startCount']}"]], "")

    # ------------------------------------------------------------------ pair diagnostics + stress per point
    pr = a["pairDiagnostics"] or []
    T["pairs"] = ("쌍진단_1081", ["문항 i", "문항 j", "S", "P", "D", "δ(입력)", "배치 거리 d", "정규화 디스패리티 d̂ (raw stress·√(raw/q)·RSQ에 사용; Σd̂²=q)", "잔차 d̂−d (정규화)", "Kruskal 디스패리티 d̂* (Stress-1에 사용; 단조 회귀, 크기 제약 없음)", "잔차 d̂*−d (Kruskal)"], [[sid(x["i"]), sid(x["j"]), x["S"], x["P"], x["D"], x["delta"], x["distance"], x["disparity"], x["residual"], x["disparityKruskal"], x["residualKruskal"]] for x in pr], "")
    # independent recomputation of every metric from the exported pair table alone (no stored metric is used as input)
    if pr:
        dd = np.array([x["distance"] for x in pr])
        dh = np.array([x["disparity"] for x in pr])
        ds = np.array([x["disparityKruskal"] for x in pr])
        qn = d.n * (d.n - 1) / 2
        raw_ = float(((dh - dd) ** 2).sum())
        num_ = float(((ds - dd) ** 2).sum())
        den_ = float((dd**2).sum())
        rec = [
            ["쌍 수 (= n(n−1)/2)", len(pr), qn, len(pr) == qn],
            ["Σ d̂² (정규화 디스패리티; q와 같아야 함)", float((dh**2).sum()), qn, abs((dh**2).sum() - qn) < 1e-6],
            ["raw stress σ_raw = Σ(d̂−d)²", raw_, p["rawStress"], abs(raw_ - p["rawStress"]) < 1e-8],
            ["Kruskal 분자 Σ(d̂*−d)²", num_, p["kruskalNumerator"], abs(num_ - p["kruskalNumerator"]) < 1e-8],
            ["분모 Σ d²", den_, p["sumDistSq"], abs(den_ - p["sumDistSq"]) < 1e-8],
            ["Stress-1 (Kruskal) = √(분자/분모)", float(np.sqrt(num_ / den_)), p["stress1"], abs(np.sqrt(num_ / den_) - p["stress1"]) < 1e-9],
            ["√(σ_raw / q)", float(np.sqrt(raw_ / qn)), p["stressNormalizedSqrt"], abs(np.sqrt(raw_ / qn) - p["stressNormalizedSqrt"]) < 1e-9],
            ["이전 정의 √(σ_raw / Σd²)", float(np.sqrt(raw_ / den_)), p["stress1V1Definition"], abs(np.sqrt(raw_ / den_) - p["stress1V1Definition"]) < 1e-9],
            ["RSQ = corr(d̂, d)²", float(np.corrcoef(dh, dd)[0, 1] ** 2), p["rsq"], abs(np.corrcoef(dh, dd)[0, 1] ** 2 - p["rsq"]) < 1e-9],
            ["Stress-1 − √(σ_raw/q) (국소 최소에서 0)", float(np.sqrt(num_ / den_) - np.sqrt(raw_ / qn)), 0.0, abs(np.sqrt(num_ / den_) - np.sqrt(raw_ / qn)) < 1e-6],
        ]
        T["metric_recompute"] = ("지표_독립재계산", ["항목", "쌍 진단표에서 다시 계산한 값", "저장된 값(분석 결과)", "일치"], rec, "")
    contrib = np.zeros(d.n)
    for x in pr:
        contrib[x["i"]] += x["residual"] ** 2
        contrib[x["j"]] += x["residual"] ** 2
    tot = contrib.sum() / 2 if contrib.sum() else 1
    T["spp"] = ("점별_stress기여", ["문항", "stress 기여(Σ_j 잔차²)", "전체 raw stress 대비 비율(%)"], [[sid(i), float(contrib[i]), float(contrib[i] / 2 / tot * 100)] for i in range(d.n)], "")

    # ------------------------------------------------------------------ reliability
    sh = a["splitHalf"]
    rel = [["설계", ko_design(sh["design"])], ["설계(저장된 원문값, 변경하지 않음)", sh["design"]], ["반복 횟수", sh["repetitions"]], ["seed", sh["seed"]], ["반쪽 크기", str(sh["halfSizes"])], ["계산 불능 횟수", sh["undefinedCount"]], ["음수 원상관 횟수", sh["negativeRawCount"]]]
    for key, nm in (("rawR", "원상관 r"), ("spearmanBrown", "Spearman–Brown 2r/(1+r)")):
        dist = sh[key]
        if dist:
            rel += [[f"{nm} 평균", dist["mean"]], [f"{nm} 표준편차", dist["sd"]], [f"{nm} 최소", dist["min"]], [f"{nm} 중앙값", dist["median"]], [f"{nm} 최대", dist["max"]]]
    for key, nm in (("rawQuantiles", "원상관 분위수"), ("spearmanBrownQuantiles", "SB 분위수")):
        for q, v in (sh[key] or {}).items():
            rel.append([f"{nm} {q}", v])
    rel.append(["주의", "행렬 신뢰도이며 지도 신뢰도가 아님; 분위수 범위는 이 표본의 무작위 분할 분포이지 모집단 신뢰구간이 아님; SB는 평행 반쪽 가정"])
    T["reliability"] = ("신뢰도", ["항목", "값"], rel, "")
    T["split_values"] = ("분할신뢰도_전체값", ["반복", "원상관 r", "Spearman–Brown"], [[i + 1, sh["rawValues"][i], sh["spearmanBrownValues"][i]] for i in range(sh["repetitions"])], "")

    # ------------------------------------------------------------------ data validation
    vr = d.verify_raw()
    prow = d.participant_rows()
    piles = [r["piles"] for r in prow]
    maxs = [r["max"] for r in prow]
    ls = d.label_scan()
    c = a["matrixChecks"]
    val = [
        ["포함 참여자(본조사)", d.N], ["한국 / 일본", f"{m['nKr']} / {m['nJp']}"], ["진술문 수", d.n],
        ["모든 참여자가 47개 진술문을 중복·누락 없이 분류", all(r["complete"] for r in prow)],
        ["묶음 수 최소 / 중앙값 / 최대", f"{min(piles)} / {float(np.median(piles))} / {max(piles)}"],
        ["가장 큰 묶음 크기 최소 / 중앙값 / 최대", f"{min(maxs)} / {float(np.median(maxs))} / {max(maxs)}"],
        ["S 재집계 일치(참여자 기록 → S)", vr["S_equals_recount_from_participant_records"]],
        ["참여자 기록 지문 재계산 일치", vr["participants_hash_match"]],
        ["행렬 크기/대칭/범위/대각선=N", f"{c['size']}×{c['size']} / {c['symmetric']} / {c['offDiagonalInRange']} / {c['diagonalEqualsN']}"],
        ["비대각 최소·최대", f"{c['minOffDiagonal']} · {c['maxOffDiagonal']}"],
        ["한 번도 함께 분류되지 않은 쌍 / 전체 쌍", f"{c['neverTogether']} / {c['pairs']}"],
        ["모두가 함께 분류한 쌍", c["alwaysTogether"]], ["서로 다른 비유사성 수준 수", c["distinctLevels"]],
        ["묶음 이름(참여자 입력) 수 / 빈 이름", f"{ls['labels']} / {ls['empty']}"],
        ["묶음 이름 중 식별자 의심 패턴(숫자 4자리 이상·@·URL·전화형)", len(ls["flagged_possible_identifier"])],
        ["일본어 대응문 검수 상태(시스템 값)", ", ".join(sorted({s["jaStatus"] for s in d.statements}))],
        ["번역 동등성 검토 기록", "이 분석 자료에는 없음 — 수행했다고 주장하지 않음"],
        ["중요도·실행가능성 평정 자료", "수집되지 않음(데이터베이스에 평정 필드 없음) — 평정지도·패턴매칭·Go-Zone 미산출"],
        ["브리징 값", "미산출 — 산식·정규화를 학술지 원문에서 확인하지 못함"],
    ]
    T["validation"] = ("자료검증", ["항목", "결과"], val, "")
    T["participants_summary"] = ("참여자별묶음요약", ["가명 ID", "국가", "묶음 수", "묶음 크기(큰 순)", "최대 묶음", "최소 묶음", "47문항 완전 분류"], [[r["pid"], r["country"], r["piles"], " ".join(map(str, r["sizes"])), r["max"], r["min"], "예" if r["complete"] else "아니오"] for r in prow], "")

    # ------------------------------------------------------------------ references
    refs = [[r["apa"].replace("*", ""), r.get("doi", "") or r.get("url", ""), r["access"], r["accessNoteKo"], " / ".join(f"{l['where']}: {l['claimKo']}" for l in r["locations"])] for r in d.b["references"]]
    T["references"] = ("참고문헌", ["참고문헌(APA 7판)", "DOI/링크", "열람 상태", "열람 메모", "원문에서 확인한 위치와 근거 주장"], refs, "")

    # ------------------------------------------------------------------ comparison (ALL only)
    cmp_ = d.b.get("comparison")
    if cmp_:
        T["compare"] = ("한일비교", ["항목", "값"], [["N_KR / N_JP", f"{cmp_['nKr']} / {cmp_['nJp']}"], ["문항 쌍 수", cmp_["pairs"]], ["Pearson r (P_KR vs P_JP)", cmp_["pearson"]], ["Spearman ρ", cmp_["spearman"]], ["|P_KR−P_JP| 평균", cmp_["meanAbsDiff"]], ["|P_KR−P_JP| 최대", cmp_["maxAbsDiff"]], ["주의", "탐색적 기술 통계; 문항 쌍은 독립 관측치가 아니므로 p값 미제시; 전체는 한국·일본을 포함"]] + [[f"큰 차이 {i + 1}: {sid(x['i'])}–{sid(x['j'])}", f"P_KR {x['pKr']:.3f}, P_JP {x['pJp']:.3f}, 차이 {x['diff']:+.3f}"] for i, x in enumerate(cmp_["topDifferences"])], "")
        diff = np.array(cmp_["Skr"], dtype=float) / cmp_["nKr"] - np.array(cmp_["Sjp"], dtype=float) / cmp_["nJp"]
        np.fill_diagonal(diff, 0)
        h, r = matrix_rows(diff)
        T["compare_diff"] = ("P_KR−P_JP", h, r, "")
        h, r = matrix_rows(np.array(cmp_["Skr"], dtype=float) / cmp_["nKr"])
        T["compare_pkr"] = ("P_KR", h, r, "")
        h, r = matrix_rows(np.array(cmp_["Sjp"], dtype=float) / cmp_["nJp"])
        T["compare_pjp"] = ("P_JP", h, r, "")
    return T


def write_xlsx(path, T, order, extra_sheets=()):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wb = xlsxwriter.Workbook(path, {"constant_memory": False, "strings_to_numbers": False})
    wb.set_properties({"created": datetime(2026, 1, 1, tzinfo=timezone.utc), "title": os.path.basename(path), "author": "concept-sort analysis package"})
    head = wb.add_format({"bold": True, "bg_color": "#E2E8F0", "border": 1, "text_wrap": True, "valign": "top"})
    wrap = wb.add_format({"text_wrap": True, "valign": "top"})
    used = set()
    for key in order:
        if key not in T:
            continue
        name, header, rows, _ = T[key]
        nm = name[:31]
        while nm in used:
            nm = nm[:-1] + "_"
        used.add(nm)
        ws = wb.add_worksheet(nm)
        ws.freeze_panes(1, 0)
        for j, h in enumerate(header):
            ws.write(0, j, h, head)
        for i, r in enumerate(rows):
            for j, v in enumerate(r):
                if v is None or v == "":
                    continue
                if isinstance(v, (np.integer,)):
                    v = int(v)
                if isinstance(v, (np.floating,)):
                    v = float(v)
                if isinstance(v, float) and v != v:
                    ws.write(i + 1, j, "계산 불가")
                elif isinstance(v, bool):
                    ws.write(i + 1, j, "예" if v else "아니오")
                elif isinstance(v, (int, float)):
                    ws.write_number(i + 1, j, v)
                else:
                    ws.write(i + 1, j, str(v), wrap)
        widths = [max(len(str(header[j])), *(len(str(r[j])) if j < len(r) and r[j] is not None else 0 for r in rows[:80])) if rows else len(str(header[j])) for j in range(len(header))]
        for j, w in enumerate(widths):
            ws.set_column(j, j, min(max(w + 2, 8), 60))
    wb.close()
    from common import rewrite_zip_deterministic

    rewrite_zip_deterministic(path)


def write_csvs(outdir, T, mapping):
    """mapping: {key: relative csv path}"""
    written = []
    for key, rel in mapping.items():
        if key not in T:
            continue
        _, header, rows, _ = T[key]
        path = os.path.join(outdir, rel)
        write_csv(path, header, rows)
        written.append(path)
    return written
