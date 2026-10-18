"""Publication figures (PNG 300 dpi + SVG + PDF) drawn from a stored result bundle. Colour and grey-scale variants of
the cluster maps are produced; clusters differ by colour AND marker shape (and hatch in grey scale).
Point coordinates are never altered; only text labels are moved, with leader lines."""
import math
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon

from common import CLUSTER_COLORS, CLUSTER_MARKERS, GRAY_LEVELS, HATCHES, RING_INDEX, cluster_style, sid

plt.rcParams.update(
    {
        "font.family": ["Malgun Gothic", "Noto Sans KR", "DejaVu Sans"],
        "axes.unicode_minus": False,
        "svg.fonttype": "path",
        "svg.hashsalt": "concept-sort-package-v2",
        "pdf.fonttype": 42,
        "figure.dpi": 100,
        "axes.titlesize": 12,
        "axes.labelsize": 10,
        "legend.fontsize": 9,
    }
)

DPI_OUT = 300
FONT = "Malgun Gothic"


def save_all(fig, base, formats=("png", "svg", "pdf")):
    out = []
    for fmt in formats:
        p = f"{base}.{fmt}"
        os.makedirs(os.path.dirname(p), exist_ok=True)
        meta = {"svg": {"Date": None}, "pdf": {"CreationDate": None, "ModDate": None, "Producer": "matplotlib"}, "png": {}}[fmt]
        fig.savefig(p, dpi=DPI_OUT if fmt == "png" else None, bbox_inches="tight", facecolor="white", metadata=meta)
        out.append(p)
    plt.close(fig)
    return out


# ------------------------------------------------------------------------------------------- label placement
def _hit_circle(cx, cy, r, b):
    nx = max(b[0], min(cx, b[0] + b[2]))
    ny = max(b[1], min(cy, b[1] + b[3]))
    return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r


def _inter(a, b, pad=1):
    return a[0] < b[0] + b[2] + pad and a[0] + a[2] + pad > b[0] and a[1] < b[1] + b[3] + pad and a[1] + a[3] + pad > b[1]


def place_labels(pts, texts, frame, obstacles, mr=6.0, cw=6.0, h=11.0):
    """Greedy deterministic placement in display pixels (y up). Returns [(box, leader)] aligned with pts."""
    radii = [mr + 3, mr + 12, mr + 24, mr + 38, mr + 54, mr + 74]
    dirs = [k * math.pi / 4 + math.pi / 8 - math.pi / 4 for k in range(8)]
    n = len(pts)
    crowd = [sum(1 for j in range(n) if j != i and math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < 28) for i in range(n)]
    order = sorted(range(n), key=lambda i: (-crowd[i], i))
    placed = {}
    for i in order:
        px, py = pts[i]
        w = len(texts[i]) * cw + 3
        best = None
        done = False
        for r in radii:
            for a in dirs:
                cx = px + math.cos(a) * r
                cy = py + math.sin(a) * r
                box = (cx if math.cos(a) >= 0 else cx - w, cy - h / 2, w, h)
                ov = 0
                if box[0] < frame[0] or box[1] < frame[1] or box[0] + box[2] > frame[0] + frame[2] or box[1] + box[3] > frame[1] + frame[3]:
                    ov += 5
                ov += sum(1 for b, _ in placed.values() if _inter(box, b))
                ov += sum(1 for ob in obstacles if _inter(box, ob))
                ov += sum(1 for qx, qy in pts if _hit_circle(qx, qy, mr + 1, box))
                if ov == 0:
                    best = (box, r, ov)
                    done = True
                    break
                if best is None or ov < best[2]:
                    best = (box, r, ov)
            if done:
                break
        placed[i] = (best[0], best[1] > radii[0])
    return [placed[i] for i in range(n)]


def place_badges(clusters, all_pts, frame, mr=6.0, W=17.0, H=15.0):
    out = []
    for c, pts in clusters:
        top = max(pts, key=lambda p: p[1])
        bottom = min(pts, key=lambda p: p[1])
        left = min(pts, key=lambda p: p[0])
        right = max(pts, key=lambda p: p[0])
        cands = [
            (top[0] - W / 2, top[1] + 12, W, H),
            (bottom[0] - W / 2, bottom[1] - 12 - H, W, H),
            (left[0] - W - 14, left[1] - H / 2, W, H),
            (right[0] + 14, right[1] - H / 2, W, H),
            (top[0] + 10, top[1] + 8, W, H),
            (top[0] - W - 10, top[1] + 8, W, H),
        ]
        best = None
        for box in cands:
            ov = 0
            if box[0] < frame[0] or box[1] < frame[1] or box[0] + box[2] > frame[0] + frame[2] or box[1] + box[3] > frame[1] + frame[3]:
                ov += 5
            ov += sum(1 for q in all_pts if _hit_circle(q[0], q[1], mr + 3, box))
            ov += sum(1 for b in out if _inter(box, b[1], 2))
            if ov == 0:
                best = (box, ov)
                break
            if best is None or ov < best[1]:
                best = (box, ov)
        out.append((c, best[0]))
    return out


def nice_step(raw):
    p = 10 ** math.floor(math.log10(raw))
    m = raw / p
    return (1 if m < 1.5 else 2 if m < 3.5 else 5 if m < 7.5 else 10) * p


# ------------------------------------------------------------------------------------------- the concept map
def _marker_kwargs(c, gray, size):
    color, marker, ring = cluster_style(c)
    col = GRAY_LEVELS[(c - 1) % len(GRAY_LEVELS)] if gray else color
    kw = dict(marker=marker, s=size, zorder=5)
    if ring:
        kw.update(facecolor="white", edgecolor=col, linewidths=1.8)
    else:
        kw.update(facecolor=col, edgecolor=col if not gray else "black", linewidths=0.6)
    return kw, col


def draw_map(coords, labels, clusters, names, title, show_quadrants=True, show_numbers=True, show_boundaries=True, gray=False, legend_title="군집 (색·기호가 같은 점 = 같은 군집)"):
    """coords: n×2 list; labels: cluster number per statement (1..k); clusters: bundle solution clusters;
    names: {cluster: name} or {}."""
    coords = np.asarray(coords)
    n = len(coords)
    half = float(np.max(np.abs(coords))) * 1.12
    k = len(clusters)
    leg_rows = k
    fig = plt.figure(figsize=(7.2, 7.4 + 0.27 * leg_rows))
    ax_h = 6.2 / (7.4 + 0.27 * leg_rows)
    ax = fig.add_axes([0.10, 1 - 0.06 - ax_h, 0.86, ax_h])
    ax.set_xlim(-half, half)
    ax.set_ylim(-half, half)
    ax.set_aspect("equal", adjustable="box")
    step = nice_step(half / 2.5)
    ticks = np.arange(-math.floor(half / step) * step, math.floor(half / step) * step + step / 2, step)
    ax.set_xticks(ticks)
    ax.set_yticks(ticks)
    ax.tick_params(labelsize=7, colors="#475569")
    ax.grid(color="#e2e8f0", linewidth=0.6, zorder=0)
    for s in ax.spines.values():
        s.set_color("#cbd5e1")
    ax.set_xlabel("차원 1", fontsize=10)
    ax.set_ylabel("차원 2", fontsize=10)
    ax.set_title(title, fontsize=11, pad=8)
    if show_quadrants:
        ax.axvline(0, color="#475569", lw=1.1, ls=(0, (5, 4)), zorder=1)
        ax.axhline(0, color="#475569", lw=1.1, ls=(0, (5, 4)), zorder=1)
        for t, x, y, ha, va in [("Ⅰ", 0.97, 0.97, "right", "top"), ("Ⅱ", 0.03, 0.97, "left", "top"), ("Ⅲ", 0.03, 0.03, "left", "bottom"), ("Ⅳ", 0.97, 0.03, "right", "bottom")]:
            ax.text(x, y, t, transform=ax.transAxes, ha=ha, va=va, fontsize=12, color="#94a3b8")
    ax.text(1.0, 1.015, f"눈금 간격 {step:g} (두 축 동일)", transform=ax.transAxes, ha="right", va="bottom", fontsize=7, color="#64748b")

    # hulls
    if show_boundaries:
        for c in clusters:
            color, marker, ring = cluster_style(c["cluster"])
            col = GRAY_LEVELS[(c["cluster"] - 1) % len(GRAY_LEVELS)] if gray else color
            g = c["geometry"]
            if g["kind"] == "polygon":
                ax.add_patch(Polygon(np.array(g["hull"]), closed=True, facecolor=col, alpha=0.13 if not gray else 0.10, edgecolor=col, lw=0, zorder=2, hatch=HATCHES[(c["cluster"] - 1) % len(HATCHES)] if gray else None))
                ax.add_patch(Polygon(np.array(g["hull"]), closed=True, fill=False, edgecolor=col, lw=1.5, joinstyle="round", zorder=3))
            elif g["kind"] in ("segment", "collinear"):
                a, b = g.get("from"), g.get("to")
                ax.plot([a[0], b[0]], [a[1], b[1]], color=col, alpha=0.55, lw=8, solid_capstyle="round", zorder=2)
            else:
                ax.add_patch(plt.Circle(tuple(g["point"]), half * 0.035, facecolor=col, alpha=0.13, edgecolor=col, lw=1.5, zorder=2))

    # points
    for i in range(n):
        kw, _ = _marker_kwargs(labels[i], gray, 46)
        ax.scatter([coords[i][0]], [coords[i][1]], **kw)

    # label + badge placement in display pixels (y up)
    fig.canvas.draw()
    tr = ax.transData
    pix = [tuple(tr.transform(p)) for p in coords]
    bb = ax.get_window_extent()
    frame = (bb.x0 + 2, bb.y0 + 2, bb.width - 4, bb.height - 4)
    badges = place_badges([(c["cluster"], [pix[i] for i in c["members"]]) for c in clusters], pix, frame) if show_boundaries else []
    if show_numbers:
        fs = 8.0
        cw = fs * 0.62 * fig.dpi / 72
        placed = place_labels(pix, [str(i + 1) for i in range(n)], frame, [b for _, b in badges], mr=5.5, cw=cw, h=fs * 1.25 * fig.dpi / 72)
        inv = tr.inverted()
        for i, (box, leader) in enumerate(placed):
            tx, ty = inv.transform((box[0] + 1, box[1] + box[3] / 2))
            ha = "left"
            ax.text(tx, ty, str(i + 1), fontsize=fs, ha=ha, va="center", color="#0f172a", zorder=7, path_effects=_halo())
            if leader:
                cxd, cyd = inv.transform((box[0] + box[2] / 2, box[1] + box[3] / 2))
                ax.plot([coords[i][0], cxd], [coords[i][1], cyd], color="#94a3b8", lw=0.6, zorder=4)
    for c, box in badges:
        color, _, _ = cluster_style(c)
        col = GRAY_LEVELS[(c - 1) % len(GRAY_LEVELS)] if gray else color
        x0, y0 = tr.inverted().transform((box[0], box[1]))
        x1, y1 = tr.inverted().transform((box[0] + box[2], box[1] + box[3]))
        ax.add_patch(plt.Rectangle((x0, y0), x1 - x0, y1 - y0, facecolor=col, edgecolor="none", zorder=8))
        ax.text((x0 + x1) / 2, (y0 + y1) / 2, str(c), color="white", fontsize=8.5, fontweight="bold", ha="center", va="center", zorder=9)

    # legend below
    ly = 1 - 0.06 - ax_h - 0.07
    fig.text(0.10, ly + 0.025, legend_title, fontsize=8.5, color="#475569", ha="left")
    for idx, c in enumerate(clusters):
        yy = ly - idx * (0.27 / (7.4 + 0.27 * leg_rows)) * 1.0 - 0.005
        kw, col = _marker_kwargs(c["cluster"], gray, 40)
        fig.patches.append(plt.Rectangle((0.10, yy - 0.006), 0.026, 0.020, transform=fig.transFigure, facecolor=col, edgecolor="none"))
        fig.text(0.113, yy + 0.004, str(c["cluster"]), color="white", fontsize=8, fontweight="bold", ha="center", va="center", transform=fig.transFigure)
        lax = fig.add_axes([0.14, yy - 0.006, 0.02, 0.02])
        lax.axis("off")
        lax.set_xlim(-1, 1)
        lax.set_ylim(-1, 1)
        lax.scatter([0], [0], **{**kw, "s": 38})
        nm = names.get(c["cluster"], "(명칭 없음)")
        fig.text(0.175, yy + 0.004, f"{nm} · {c['size']}문항", fontsize=9, va="center", ha="left", transform=fig.transFigure)
    return fig


def _halo():
    import matplotlib.patheffects as pe

    return [pe.withStroke(linewidth=2.2, foreground="white")]


def draw_plain_quadrant_map(coords, title):
    """사분면 점지도: every statement one point + number, no cluster information."""
    n = len(coords)
    clusters = [{"cluster": 1, "members": list(range(n)), "size": n, "geometry": {"kind": "none"}}]
    fig = draw_map(coords, [1] * n, [clusters[0]], {1: "모든 문항 (군집 구분 없음)"}, title, show_boundaries=False)
    return fig


# ------------------------------------------------------------------------------------------- diagnostics
def fig_dendrogram(linkage, n, labels, k, title):
    children = {n + i: (r["leftNode"], r["rightNode"]) for i, r in enumerate(linkage)}
    root = n + len(linkage) - 1
    order = []

    def walk(i):
        if i in children:
            walk(children[i][0])
            walk(children[i][1])
        else:
            order.append(i)

    walk(root)
    xpos = {leaf: i for i, leaf in enumerate(order)}
    ypos = {leaf: 0.0 for leaf in order}
    fig, ax = plt.subplots(figsize=(10.5, 4.8))
    for i, r in enumerate(linkage):
        a, b = r["leftNode"], r["rightNode"]
        h = r["mergeDistance"]
        xa, xb = xpos[a], xpos[b]
        ax.plot([xa, xa, xb, xb], [ypos[a], h, h, ypos[b]], color="#475569", lw=0.9)
        xpos[n + i] = (xa + xb) / 2
        ypos[n + i] = h
    if k >= 2 and n - k < len(linkage):
        cut = (linkage[n - k - 1]["mergeDistance"] + linkage[n - k]["mergeDistance"]) / 2
        ax.axhline(cut, color="#D55E00", ls="--", lw=1.1)
        ax.text(n - 0.5, cut, f" k={k} 절단", color="#D55E00", fontsize=8, va="bottom", ha="right")
    ax.set_xticks(range(n))
    ax.set_xticklabels([str(leaf + 1) for leaf in order], fontsize=7)
    for tick, leaf in zip(ax.get_xticklabels(), order):
        color, _, _ = cluster_style(labels[leaf])
        tick.set_color(color)
        tick.set_fontweight("bold")
    ax.set_ylabel("Ward 병합 높이")
    ax.set_xlabel("문항 번호 (색 = 절단 시 군집)")
    ax.set_title(title)
    ax.spines[["top", "right"]].set_visible(False)
    return fig


def fig_shepard(delta, distance, disparity, title):
    fig, ax = plt.subplots(figsize=(6.4, 5.0))
    ax.scatter(delta, distance, s=6, color="#0072B2", alpha=0.35, label=f"배치 거리 d (문항 쌍 {len(delta)}개)")
    levels = {}
    for d, v in zip(delta, disparity):
        levels[round(d, 12)] = v
    xs = sorted(levels)
    ax.plot(xs, [levels[x] for x in xs], color="#D55E00", lw=2, label="디스패리티 d̂* (δ 수준별 단조 회귀값, Stress-1 정의)")
    ax.set_xlabel("입력 비유사성 δ = 1 − S/N")
    ax.set_ylabel("배치 거리 / 디스패리티")
    ax.set_title(title)
    ax.legend(loc="upper left", frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    return fig


def fig_iterations(raw, main_iters, thinned, title):
    fig, ax = plt.subplots(figsize=(6.4, 4.6))
    xs = np.arange(1, len(raw) + 1)
    ax.plot(xs, raw, color="#0072B2", lw=1.6)
    if max(raw) / max(min(raw), 1e-12) > 8:
        ax.set_yscale("log")
    if 0 < main_iters < len(raw):
        ax.axvline(main_iters, color="#D55E00", ls="--", lw=1)
        ax.text(main_iters, ax.get_ylim()[1], " ← ε=1e-9 수렴 | ε=1e-12 계속 →", color="#D55E00", fontsize=8, va="top")
    ax.set_xlabel("반복 횟수" + (" (표시는 간격 축소)" if thinned else ""))
    ax.set_ylabel("raw stress")
    ax.set_title(title)
    ax.spines[["top", "right"]].set_visible(False)
    return fig


def fig_dimensions(dims, title):
    fig, ax = plt.subplots(figsize=(6.0, 4.4))
    xs = [d["dimension"] for d in dims if d["stress1"] is not None]
    ys = [d["stress1"] for d in dims if d["stress1"] is not None]
    ax.plot(xs, ys, color="#475569", lw=1.3)
    for d in dims:
        if d["stress1"] is None:
            continue
        ax.scatter([d["dimension"]], [d["stress1"]], s=60, facecolor="#0072B2" if d["numericallyConverged"] else "white", edgecolor="#0072B2", linewidths=2, zorder=3)
        ax.annotate(f"{d['stress1']:.3f}", (d["dimension"], d["stress1"]), textcoords="offset points", xytext=(0, 8), ha="center", fontsize=8)
    ax.set_xticks(xs)
    ax.set_xlabel("차원 수 (2차원 이외는 보조 비교)")
    ax.set_ylabel("Stress-1 (Kruskal)")
    ax.set_ylim(0, max(ys) * 1.15)
    ax.set_title(title)
    ax.text(0.02, 0.04, "● 수렴  ○ 미수렴", transform=ax.transAxes, fontsize=8, color="#334155")
    ax.spines[["top", "right"]].set_visible(False)
    return fig


def fig_split_half(raw_values, sb_values, design, title):
    raw = [v for v in raw_values if v is not None]
    sb = [v for v in sb_values if v is not None]
    fig, axes = plt.subplots(1, 2, figsize=(9.4, 4.0), sharey=True)
    for ax, vals, name in ((axes[0], raw, "원상관 r"), (axes[1], sb, "Spearman–Brown 2r/(1+r)")):
        ax.hist(vals, bins=24, color="#56B4E9", edgecolor="#0072B2", lw=0.6)
        m = float(np.mean(vals))
        ax.axvline(m, color="#D55E00", ls="--", lw=1)
        ax.text(m, ax.get_ylim()[1] * 0.97, f" 평균 {m:.3f}", color="#D55E00", fontsize=8, va="top")
        ax.set_xlabel(name)
        ax.spines[["top", "right"]].set_visible(False)
    axes[0].set_ylabel("분할 횟수")
    fig.suptitle(f"{title}\n{design}", fontsize=10)
    return fig


def fig_silhouette(labels, per_point, names, title):
    n = len(labels)
    order = sorted(range(n), key=lambda i: (labels[i], -per_point[i]))
    fig, ax = plt.subplots(figsize=(6.4, 0.16 * n + 1.6))
    for rank, i in enumerate(order):
        color, _, _ = cluster_style(labels[i])
        ax.barh(rank, per_point[i], color=color, height=0.85)
    ax.set_yticks(range(n))
    ax.set_yticklabels([str(i + 1) for i in order], fontsize=6)
    ax.axvline(0, color="black", lw=0.8)
    ax.invert_yaxis()
    ax.set_xlabel("지도 좌표 기준 실루엣 s(i)")
    ax.set_title(title)
    handles = [plt.Rectangle((0, 0), 1, 1, color=cluster_style(c)[0]) for c in sorted(set(labels))]
    ax.legend(handles, [f"{c} {names.get(c, '')}".strip() for c in sorted(set(labels))], loc="lower right", fontsize=7, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    return fig


def fig_k_comparison(solutions, merges, rec_k, title):
    ks = [s["k"] for s in solutions]
    fig, axes = plt.subplots(1, 2, figsize=(10.0, 4.0))
    axes[0].plot(ks, [s["silhouetteMap"]["mean"] for s in solutions], "o-", color="#0072B2", label="지도 좌표 기준")
    axes[0].plot(ks, [s["silhouetteDelta"]["mean"] for s in solutions], "s--", color="#D55E00", label="원래 비유사성 δ 기준")
    axes[0].set_xlabel("군집 수 k")
    axes[0].set_ylabel("실루엣 평균 폭")
    axes[0].legend(frameon=False)
    h = {m["clustersAfter"]: m["height"] for m in merges}
    axes[1].plot(ks, [h.get(k) for k in ks], "o-", color="#475569")
    axes[1].set_xlabel("군집 수 k (k+1 → k 병합이 일어나는 높이)")
    axes[1].set_ylabel("Ward 병합 높이")
    for ax in axes:
        if rec_k:
            ax.axvline(rec_k, color="#009E73", ls=":", lw=1.4)
        ax.set_xticks(ks)
        ax.spines[["top", "right"]].set_visible(False)
    fig.suptitle(title + (f" (점선 = 추천 k={rec_k})" if rec_k else ""), fontsize=10)
    return fig


def fig_heatmap(M, limit, title):
    fig, ax = plt.subplots(figsize=(6.8, 6.0))
    M = np.array(M, dtype=float)
    np.fill_diagonal(M, np.nan)
    im = ax.imshow(M, cmap="RdBu_r", vmin=-limit, vmax=limit, interpolation="nearest")
    ax.set_xticks(range(0, len(M), 5))
    ax.set_xticklabels([str(i + 1) for i in range(0, len(M), 5)], fontsize=7)
    ax.set_yticks(range(0, len(M), 5))
    ax.set_yticklabels([str(i + 1) for i in range(0, len(M), 5)], fontsize=7)
    cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cb.set_label("P_KR − P_JP (두 국가 공통 색 범위)")
    ax.set_title(title)
    return fig


def fig_scatter_p(pk, pj, title, pearson, spearman):
    fig, ax = plt.subplots(figsize=(5.4, 5.2))
    ax.scatter(pj, pk, s=6, alpha=0.4, color="#0072B2")
    lim = max(max(pk), max(pj)) * 1.05
    ax.plot([0, lim], [0, lim], color="#999999", lw=0.8, ls="--")
    ax.set_xlim(0, lim)
    ax.set_ylim(0, lim)
    ax.set_aspect("equal")
    ax.set_xlabel("P_JP = S_JP / N_JP")
    ax.set_ylabel("P_KR = S_KR / N_KR")
    ax.set_title(f"{title}\nPearson r = {pearson:.3f}, Spearman ρ = {spearman:.3f} (탐색적; 쌍은 독립 관측치가 아님)", fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)
    return fig


def fig_aligned_maps(A, B, labelsA, labelsB, rot_info, title):
    fig, axes = plt.subplots(1, 2, figsize=(10.6, 5.2))
    for ax, pts, labs, name in ((axes[0], A, labelsA, "한국 지도(기준)"), (axes[1], B, labelsB, "일본 지도(정렬 후)")):
        pts = np.asarray(pts)
        for i, p in enumerate(pts):
            color, marker, ring = cluster_style(labs[i])
            ax.scatter([p[0]], [p[1]], marker=marker, s=40, facecolor="white" if ring else color, edgecolor=color, linewidths=1.2)
            ax.annotate(str(i + 1), (p[0], p[1]), textcoords="offset points", xytext=(4, 3), fontsize=6.5)
        ax.axhline(0, color="#999", lw=0.6, ls="--")
        ax.axvline(0, color="#999", lw=0.6, ls="--")
        ax.set_aspect("equal")
        ax.set_title(name, fontsize=10)
    lim = max(np.abs(np.asarray(A)).max(), np.abs(np.asarray(B)).max()) * 1.15
    for ax in axes:
        ax.set_xlim(-lim, lim)
        ax.set_ylim(-lim, lim)
    fig.suptitle(f"{title}\n{rot_info}", fontsize=9)
    return fig
