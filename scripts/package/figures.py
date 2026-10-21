"""Research figures drawn from a stored result bundle, for print at a 16 cm column width.

Every figure is rendered ONCE at its print size (6.30 in = 16 cm wide) and written as
  * PNG at 600 dpi (3,780 px wide) — a real render at that resolution, not an enlarged screen capture,
  * SVG (text converted to paths, so it needs no font) and PDF (TrueType subset embedded),
all from the same matplotlib figure. Colour and grey-scale variants of the cluster maps differ by colour AND marker shape
(and hatch in grey scale). Point coordinates are never altered; only the number labels are moved, with leader lines.
Glyph coverage is enforced: a character that no available font can draw stops the build instead of printing a box.
"""
import math
import os
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon

from common import CLUSTER_COLORS, CLUSTER_MARKERS, GRAY_LEVELS, HATCHES, RING_INDEX, cluster_style, sid


def _available_families():
    """Korean-capable families that exist on this machine, in preference order (no 'font not found' noise for the others)."""
    from matplotlib import font_manager

    have = {f.name for f in font_manager.fontManager.ttflist}
    return [f for f in ("Noto Sans CJK KR", "Noto Sans KR", "Malgun Gothic", "Noto Sans CJK JP") if f in have] + ["DejaVu Sans"]


PRINT_WIDTH_CM = 16.0
DPI_OUT = 600
W_IN = 6.3  # 16.0 cm (16.002): a whole number of pixels at 600 dpi
PNG_WIDTH_PX = int(round(W_IN * DPI_OUT))  # 3,780

plt.rcParams.update(
    {
        "font.family": _available_families(),
        "mathtext.fontset": "dejavusans",
        "axes.unicode_minus": False,
        "svg.fonttype": "path",
        "svg.hashsalt": "concept-sort-package-v4",
        "pdf.fonttype": 42,
        "figure.dpi": 100,
        "font.size": 7.5,
        "axes.titlesize": 8.5,
        "axes.labelsize": 8,
        "xtick.labelsize": 7,
        "ytick.labelsize": 7,
        "legend.fontsize": 7,
        "axes.linewidth": 0.6,
        "lines.linewidth": 1.0,
    }
)


def font_used():
    """Name of the font file matplotlib resolves for the first family that exists (recorded in the figure list)."""
    from matplotlib import font_manager

    path = font_manager.findfont(font_manager.FontProperties(family=plt.rcParams["font.family"]))
    return f"{font_manager.FontProperties(fname=path).get_name()} ({os.path.basename(path)})"


class GlyphError(RuntimeError):
    pass


def save_all(fig, base, formats=("png", "svg", "pdf")):
    """Writes the figure at its print size; PNG at 600 dpi. Raises GlyphError if any character could not be drawn."""
    out = []
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        for fmt in formats:
            p = f"{base}.{fmt}"
            os.makedirs(os.path.dirname(p), exist_ok=True)
            meta = {"svg": {"Date": None}, "pdf": {"CreationDate": None, "ModDate": None, "Producer": "matplotlib"}, "png": {}}[fmt]
            kw = {"dpi": DPI_OUT, "pil_kwargs": {"optimize": True}} if fmt == "png" else {}
            fig.savefig(p, facecolor="white", metadata=meta, **kw)  # no bbox_inches="tight": the page size is the print size
            out.append(p)
    plt.close(fig)
    bad = sorted({str(w.message) for w in caught if "Glyph" in str(w.message) or "missing from font" in str(w.message)})
    if bad:
        raise GlyphError(f"{os.path.basename(base)}: {bad[:3]}")
    return out


def png_size(path):
    from PIL import Image

    with Image.open(path) as im:
        return im.size


def stamp(fig, text):
    """Scope / sample / version note along the bottom edge of the figure."""
    fig.text(0.012, 0.008, text, fontsize=5.8, color="#64748b", ha="left", va="bottom")


def _fig(height, rows=1, cols=1, bottom=0.045, **kw):
    """Figure at print width with constrained layout; the bottom 4% is kept free for the note."""
    fig = plt.figure(figsize=(W_IN, height), layout="constrained")
    fig.get_layout_engine().set(rect=(0, bottom, 1, 1 - bottom), w_pad=0.04, h_pad=0.04)
    if rows * cols == 1:
        return fig, fig.add_subplot(1, 1, 1)
    return fig, fig.subplots(rows, cols, **kw)


def _clean(ax):
    ax.spines[["top", "right"]].set_visible(False)


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


def place_badges(clusters, all_pts, frame, mr=6.0, W=15.0, H=13.0):
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
        kw.update(facecolor="white", edgecolor=col, linewidths=1.4)
    else:
        kw.update(facecolor=col, edgecolor=col if not gray else "black", linewidths=0.5)
    return kw, col


def _halo():
    import matplotlib.patheffects as pe

    return [pe.withStroke(linewidth=1.8, foreground="white")]


def draw_map(coords, labels, clusters, names, title, show_numbers=True, show_boundaries=True, gray=False, legend_title="군집 (색·기호가 같은 점 = 같은 군집)", note="", show_legend=True):
    """coords: n×2; labels: cluster number per statement (1..k); clusters: bundle solution clusters; names: {cluster: name} or {}.
    Both axes use the same distance unit; the zero lines are drawn for orientation only (the four quadrants are not units of interpretation)."""
    coords = np.asarray(coords)
    n = len(coords)
    half = float(np.max(np.abs(coords))) * 1.12
    k = len(clusters)
    if gray and legend_title.startswith("군집 (색"):
        legend_title = "군집 (명도·기호·해치가 같은 점 = 같은 군집)"
    left, right_m, top, gap, head, row, foot = 0.52, 0.12, 0.34, 0.20, 0.22, 0.20, 0.30
    if not show_legend:
        gap, head, row, foot = 0.05, 0.0, 0.0, 0.50  # the x-axis label needs its own line above the note
    ax_w = W_IN - left - right_m
    H = top + ax_w + gap + head + k * row + foot
    fig = plt.figure(figsize=(W_IN, H))
    ax = fig.add_axes([left / W_IN, (H - top - ax_w) / H, ax_w / W_IN, ax_w / H])
    ax.set_xlim(-half, half)
    ax.set_ylim(-half, half)
    ax.set_aspect("equal", adjustable="box")
    step = nice_step(half / 2.5)
    ticks = np.arange(-math.floor(half / step) * step, math.floor(half / step) * step + step / 2, step)
    ax.set_xticks(ticks)
    ax.set_yticks(ticks)
    ax.tick_params(labelsize=6.5, colors="#475569", length=2.5, width=0.5)
    ax.grid(color="#e2e8f0", linewidth=0.5, zorder=0)
    for s in ax.spines.values():
        s.set_color("#94a3b8")
        s.set_linewidth(0.6)
    ax.set_xlabel("차원 1 (축의 방향은 임의)", fontsize=7.5, labelpad=2)
    ax.set_ylabel("차원 2 (축의 방향은 임의)", fontsize=7.5, labelpad=2)
    ax.set_title(title, fontsize=8.5, pad=14, loc="left")
    ax.axvline(0, color="#64748b", lw=0.6, ls=(0, (4, 3)), zorder=1)
    ax.axhline(0, color="#64748b", lw=0.6, ls=(0, (4, 3)), zorder=1)
    ax.text(1.0, 1.012, f"눈금 간격 {step:g} (두 축 동일한 거리 단위)", transform=ax.transAxes, ha="right", va="bottom", fontsize=6, color="#64748b")

    if show_boundaries:
        for c in clusters:
            color, marker, ring = cluster_style(c["cluster"])
            col = GRAY_LEVELS[(c["cluster"] - 1) % len(GRAY_LEVELS)] if gray else color
            g = c["geometry"]
            if g["kind"] == "polygon":
                ax.add_patch(Polygon(np.array(g["hull"]), closed=True, facecolor=col, alpha=0.13 if not gray else 0.10, edgecolor=col, lw=0, zorder=2, hatch=HATCHES[(c["cluster"] - 1) % len(HATCHES)] if gray else None))
                ax.add_patch(Polygon(np.array(g["hull"]), closed=True, fill=False, edgecolor=col, lw=1.1, joinstyle="round", zorder=3))
            elif g["kind"] in ("segment", "collinear"):
                a, b = g.get("from"), g.get("to")
                ax.plot([a[0], b[0]], [a[1], b[1]], color=col, alpha=0.55, lw=6, solid_capstyle="round", zorder=2)
            else:
                ax.add_patch(plt.Circle(tuple(g["point"]), half * 0.035, facecolor=col, alpha=0.13, edgecolor=col, lw=1.1, zorder=2))

    for i in range(n):
        kw, _ = _marker_kwargs(labels[i], gray, 30)
        ax.scatter([coords[i][0]], [coords[i][1]], **kw)

    fig.canvas.draw()
    tr = ax.transData
    pix = [tuple(tr.transform(p)) for p in coords]
    bb = ax.get_window_extent()
    frame = (bb.x0 + 2, bb.y0 + 2, bb.width - 4, bb.height - 4)
    badges = place_badges([(c["cluster"], [pix[i] for i in c["members"]]) for c in clusters], pix, frame) if show_boundaries else []
    if show_numbers:
        fs = 6.8
        cw = fs * 0.62 * fig.dpi / 72
        placed = place_labels(pix, [str(i + 1) for i in range(n)], frame, [b for _, b in badges], mr=4.6, cw=cw, h=fs * 1.25 * fig.dpi / 72)
        inv = tr.inverted()
        for i, (box, leader) in enumerate(placed):
            tx, ty = inv.transform((box[0] + 1, box[1] + box[3] / 2))
            ax.text(tx, ty, str(i + 1), fontsize=fs, ha="left", va="center", color="#0f172a", zorder=7, path_effects=_halo())
            if leader:
                cxd, cyd = inv.transform((box[0] + box[2] / 2, box[1] + box[3] / 2))
                ax.plot([coords[i][0], cxd], [coords[i][1], cyd], color="#94a3b8", lw=0.5, zorder=4)
    for c, box in badges:
        color, _, _ = cluster_style(c)
        col = GRAY_LEVELS[(c - 1) % len(GRAY_LEVELS)] if gray else color
        x0, y0 = tr.inverted().transform((box[0], box[1]))
        x1, y1 = tr.inverted().transform((box[0] + box[2], box[1] + box[3]))
        ax.add_patch(plt.Rectangle((x0, y0), x1 - x0, y1 - y0, facecolor=col, edgecolor="none", zorder=8))
        ax.text((x0 + x1) / 2, (y0 + y1) / 2, str(c), color="white", fontsize=7.5, fontweight="bold", ha="center", va="center", zorder=9)

    # legend below, positioned in inches
    if show_legend:
        fig.text(left / W_IN, (foot + k * row + 0.04) / H, legend_title, fontsize=7, color="#475569", ha="left", va="bottom")
    for idx, c in enumerate(clusters if show_legend else []):
        yc = (foot + (k - 1 - idx) * row + row / 2) / H
        kw, col = _marker_kwargs(c["cluster"], gray, 34)
        fig.patches.append(plt.Rectangle((left / W_IN, yc - 0.065 / H), 0.17 / W_IN, 0.13 / H, transform=fig.transFigure, facecolor=col, edgecolor="none"))
        fig.text((left + 0.085) / W_IN, yc, str(c["cluster"]), color="white", fontsize=6.8, fontweight="bold", ha="center", va="center", transform=fig.transFigure)
        lax = fig.add_axes([(left + 0.22) / W_IN, yc - 0.08 / H, 0.16 / W_IN, 0.16 / H])
        lax.axis("off")
        lax.set_xlim(-1, 1)
        lax.set_ylim(-1, 1)
        lax.scatter([0], [0], **{**kw, "s": 30})
        nm = names.get(c["cluster"], "(명칭 없음)")
        fig.text((left + 0.45) / W_IN, yc, f"{nm} · {c['size']}문항", fontsize=7.5, va="center", ha="left", transform=fig.transFigure)
    if note:
        stamp(fig, note)
    return fig


def draw_plain_point_map(coords, title, note=""):
    """Point map: every statement one point + number, no cluster information."""
    n = len(coords)
    clusters = [{"cluster": 1, "members": list(range(n)), "size": n, "geometry": {"kind": "none"}}]
    return draw_map(coords, [1] * n, [clusters[0]], {1: "모든 문항 (군집 구분 없음)"}, title, show_boundaries=False, note=note, show_legend=False)


draw_plain_quadrant_map = draw_plain_point_map  # old name kept for scripts that still import it


# ------------------------------------------------------------------------------------------- diagnostics
def fig_dendrogram(linkage, n, labels, k, title, note=""):
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
    fig, ax = _fig(3.6)
    for i, r in enumerate(linkage):
        a, b = r["leftNode"], r["rightNode"]
        h = r["mergeDistance"]
        xa, xb = xpos[a], xpos[b]
        ax.plot([xa, xa, xb, xb], [ypos[a], h, h, ypos[b]], color="#475569", lw=0.7)
        xpos[n + i] = (xa + xb) / 2
        ypos[n + i] = h
    if k >= 2 and n - k < len(linkage):
        cut = (linkage[n - k - 1]["mergeDistance"] + linkage[n - k]["mergeDistance"]) / 2
        ax.axhline(cut, color="#D55E00", ls="--", lw=0.9)
        ax.text(n - 0.5, cut, f" k={k} 절단", color="#D55E00", fontsize=6.5, va="bottom", ha="right")
    ax.set_xticks(range(n))
    ax.set_xticklabels([str(leaf + 1) for leaf in order], fontsize=6, rotation=90)
    for tick, leaf in zip(ax.get_xticklabels(), order):
        color, _, _ = cluster_style(labels[leaf])
        tick.set_color(color)
        tick.set_fontweight("bold")
    ax.set_ylabel("Ward 병합 높이")
    ax.set_xlabel("문항 번호 (색 = 절단 시 군집)")
    ax.set_title(title, loc="left")
    _clean(ax)
    stamp(fig, note)
    return fig


def fig_shepard(delta, distance, disparity, title, note=""):
    fig, ax = _fig(3.9)
    ax.scatter(delta, distance, s=3, color="#0072B2", alpha=0.35, linewidths=0, label=f"배치 거리 d (문항 쌍 {len(delta)}개)")
    levels = {}
    for d, v in zip(delta, disparity):
        levels[round(d, 12)] = v
    xs = sorted(levels)
    ax.plot(xs, [levels[x] for x in xs], color="#D55E00", lw=1.4, label=r"디스패리티 $\hat{d}^{*}$ (δ 수준별 단조 회귀값, Stress-1 정의)")
    ax.set_xlabel(r"입력 비유사성 $\delta = 1 - S/N$")
    ax.set_ylabel("배치 거리 / 디스패리티")
    ax.set_title(title, loc="left")
    ax.legend(loc="upper left", frameon=False)
    _clean(ax)
    stamp(fig, note)
    return fig


def fig_residuals(delta, residual_k, title, note=""):
    """Residual diagnostics: (a) residual vs input dissimilarity with the mean residual at each distinct δ level, (b) residual distribution."""
    delta = np.asarray(delta, dtype=float)
    res = np.asarray(residual_k, dtype=float)
    fig, axes = _fig(3.3, 1, 2, gridspec_kw={"width_ratios": [1.7, 1]})
    ax = axes[0]
    ax.scatter(delta, res, s=3, color="#0072B2", alpha=0.35, linewidths=0)
    ax.axhline(0, color="#333333", lw=0.7)
    levels = sorted(set(np.round(delta, 12)))
    ax.plot(levels, [res[np.round(delta, 12) == v].mean() for v in levels], "o-", color="#D55E00", lw=1.0, ms=2.6, label="δ 수준별 평균 잔차")
    ax.set_xlabel(r"입력 비유사성 $\delta$")
    ax.set_ylabel(r"잔차 $\hat{d}^{*} - d$")
    ax.set_title("(a) 잔차 대 입력 비유사성", loc="left", fontsize=8)
    ax.legend(frameon=False, loc="upper right", fontsize=6.5)
    _clean(ax)
    ax = axes[1]
    ax.hist(res, bins=30, color="#56B4E9", edgecolor="#0072B2", lw=0.4, orientation="horizontal")
    ax.axhline(0, color="#333333", lw=0.7)
    ax.set_xlabel("문항 쌍 수")
    ax.set_title("(b) 잔차 분포", loc="left", fontsize=8)
    _clean(ax)
    fig.suptitle(title, fontsize=8.5, x=0.01, ha="left")
    stamp(fig, note)
    return fig


def fig_item_stress(values_pct, title, note=""):
    n = len(values_pct)
    fig, ax = _fig(2.9)
    ax.bar(range(n), values_pct, color="#0072B2", width=0.78)
    ax.axhline(100 / n, color="#D55E00", ls="--", lw=0.8, label=f"균등 배분 시 {100 / n:.2f}%")
    ax.set_ylim(0, max(values_pct) * 1.22)
    ax.legend(loc="upper right", frameon=True, facecolor="white", edgecolor="none", fontsize=6.5)
    ax.set_xticks(range(n))
    ax.set_xticklabels([str(i + 1) for i in range(n)], fontsize=5.8, rotation=90)
    ax.set_xlabel("문항 번호")
    ax.set_ylabel("전체 raw stress 대비 기여 비율 (%)")
    ax.set_title(title, loc="left")
    _clean(ax)
    stamp(fig, note)
    return fig


def fig_iterations(raw, main_iters, thinned, title, note=""):
    fig, ax = _fig(3.2)
    xs = np.arange(1, len(raw) + 1)
    ax.plot(xs, raw, color="#0072B2", lw=1.2)
    if max(raw) / max(min(raw), 1e-12) > 8:
        ax.set_yscale("log")
    if 0 < main_iters < len(raw):
        ax.axvline(main_iters, color="#D55E00", ls="--", lw=0.8)
        ax.text(main_iters, ax.get_ylim()[1], r" ← ε=1e-9 수렴 | ε=1e-12 계속 →", color="#D55E00", fontsize=6.5, va="top")
    ax.set_xlabel("반복 횟수" + (" (표시는 간격 축소)" if thinned else ""))
    ax.set_ylabel("raw stress")
    ax.set_title(title, loc="left")
    _clean(ax)
    stamp(fig, note)
    return fig


def fig_dimensions(dims, title, note=""):
    """Stress-1 and RSQ by number of dimensions (stored values); open circle = not numerically converged."""
    fig, axes = _fig(3.0, 1, 2)
    xs = [d["dimension"] for d in dims if d["stress1"] is not None]
    for ax, key, lab, fmt_ in ((axes[0], "stress1", "Stress-1 (Kruskal)", "{:.3f}"), (axes[1], "rsq", "RSQ", "{:.3f}")):
        ys = [d[key] for d in dims if d["stress1"] is not None]
        ax.plot(xs, ys, color="#475569", lw=1.0)
        for d in dims:
            if d["stress1"] is None:
                continue
            ax.scatter([d["dimension"]], [d[key]], s=30, facecolor="#0072B2" if d["numericallyConverged"] else "white", edgecolor="#0072B2", linewidths=1.2, zorder=3)
            ax.annotate(fmt_.format(d[key]), (d["dimension"], d[key]), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=6.3, zorder=6, path_effects=_halo())
        ax.set_xticks(xs)
        ax.set_xlabel("차원 수 (2차원 이외는 보조 비교)")
        ax.set_ylabel(lab)
        lo, hi = min(ys), max(ys)
        pad = (hi - lo) * 0.18 or 0.05
        ax.set_ylim(max(0, lo - pad) if key == "rsq" else 0, hi + pad)
        _clean(ax)
    axes[0].text(0.03, 0.05, "● 수렴  ○ 미수렴", transform=axes[0].transAxes, fontsize=6.5, color="#334155")
    fig.suptitle(title, fontsize=8.5, x=0.01, ha="left")
    stamp(fig, note)
    return fig


def fig_split_half(raw_values, sb_values, design, title, note=""):
    raw = [v for v in raw_values if v is not None]
    sb = [v for v in sb_values if v is not None]
    fig, axes = _fig(3.1, 1, 2, sharey=True)
    top = max(max(np.histogram(v, bins=24)[0]) for v in (raw, sb))
    for ax, vals, name in ((axes[0], raw, "원상관 r"), (axes[1], sb, "Spearman–Brown 2r/(1+r)")):
        ax.hist(vals, bins=24, color="#56B4E9", edgecolor="#0072B2", lw=0.4)
        ax.set_ylim(0, top * 1.16)  # the mean label sits in this head-room, never on a bar
        m = float(np.mean(vals))
        ax.axvline(m, color="#D55E00", ls="--", lw=0.8)
        ax.text(m, top * 1.14, f" 평균 {m:.3f}", color="#D55E00", fontsize=6.5, va="top")
        ax.set_xlabel(name)
        _clean(ax)
    axes[0].set_ylabel("분할 횟수")
    from common import ko_design

    fig.suptitle(f"{title}\n{ko_design(design)}", fontsize=8, x=0.01, ha="left")
    stamp(fig, note)
    return fig


def fig_silhouette(labels, per_point, names, title, note=""):
    n = len(labels)
    order = sorted(range(n), key=lambda i: (labels[i], -per_point[i]))
    fig, ax = _fig(0.115 * n + 1.9)
    for rank, i in enumerate(order):
        color, _, _ = cluster_style(labels[i])
        ax.barh(rank, per_point[i], color=color, height=0.85)
    ax.set_yticks(range(n))
    ax.set_yticklabels([str(i + 1) for i in order], fontsize=5.6)
    ax.axvline(0, color="black", lw=0.6)
    ax.invert_yaxis()
    ax.set_xlabel("지도 좌표 기준 실루엣 s(i)")
    ax.set_ylabel("문항 번호")
    ax.set_title(title, loc="left")
    handles = [plt.Rectangle((0, 0), 1, 1, color=cluster_style(c)[0]) for c in sorted(set(labels))]
    ax.legend(handles, [f"군집 {c} {names.get(c, '')}".strip() for c in sorted(set(labels))], loc="upper center", bbox_to_anchor=(0.5, -0.07), ncol=2, fontsize=6.3, frameon=False)
    _clean(ax)
    stamp(fig, note)
    return fig


def fig_k_comparison(solutions, merges, rec_k, title, note=""):
    ks = [s["k"] for s in solutions]
    fig, axes = _fig(4.6, 2, 2)
    a = axes[0][0]
    a.plot(ks, [s["silhouetteMap"]["mean"] for s in solutions], "o-", color="#0072B2", ms=3, label="지도 좌표 기준")
    a.plot(ks, [s["silhouetteDelta"]["mean"] for s in solutions], "s--", color="#D55E00", ms=3, label=r"원래 비유사성 $\delta$ 기준")
    a.set_ylabel("실루엣 평균 폭")
    a.legend(frameon=False, fontsize=6.3)
    a.set_title("(a) 실루엣", loc="left", fontsize=8)
    h = {m["clustersAfter"]: m["height"] for m in merges}
    b = axes[0][1]
    b.plot(ks, [h.get(k) for k in ks], "o-", color="#475569", ms=3)
    b.set_ylabel("Ward 병합 높이 (k+1→k)")
    b.set_title("(b) 병합 높이", loc="left", fontsize=8)
    c = axes[1][0]
    c.plot(ks, [s["betweenShare"] for s in solutions], "o-", color="#009E73", ms=3)
    c.set_ylabel("군집 간 제곱합 비율")
    c.set_title("(c) 군집 간 제곱합 비율", loc="left", fontsize=8)
    dd = axes[1][1]
    dd.bar(ks, [s["minSize"] for s in solutions], color="#CC79A7", width=0.6)
    dd.set_ylabel("최소 군집 크기 (문항)")
    dd.set_title("(d) 최소 군집 크기", loc="left", fontsize=8)
    for ax in axes.flat:
        if rec_k:
            ax.axvline(rec_k, color="#009E73", ls=":", lw=1.1)
        ax.set_xticks(ks)
        ax.set_xlabel("군집 수 k")
        _clean(ax)
    fig.suptitle(title + (f" (점선 = 자동 추천 k={rec_k}, 연구자 확정 전)" if rec_k else ""), fontsize=8.5, x=0.01, ha="left")
    stamp(fig, note)
    return fig


def fig_heatmap(M, limit, title, note=""):
    fig, ax = _fig(5.6)
    M = np.array(M, dtype=float)
    np.fill_diagonal(M, np.nan)
    im = ax.imshow(M, cmap="RdBu_r", vmin=-limit, vmax=limit, interpolation="nearest")
    ax.set_xticks(range(0, len(M), 5))
    ax.set_xticklabels([str(i + 1) for i in range(0, len(M), 5)], fontsize=6.5)
    ax.set_yticks(range(0, len(M), 5))
    ax.set_yticklabels([str(i + 1) for i in range(0, len(M), 5)], fontsize=6.5)
    ax.set_xlabel("문항 번호")
    ax.set_ylabel("문항 번호")
    cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
    cb.set_label("P_KR − P_JP (두 국가 공통 색 범위)", fontsize=7)
    ax.set_title(title, loc="left")
    stamp(fig, note)
    return fig


def fig_scatter_p(pk, pj, title, pearson, spearman, note=""):
    fig, ax = _fig(4.6)
    ax.scatter(pj, pk, s=3, alpha=0.4, color="#0072B2", linewidths=0)
    lim = max(max(pk), max(pj)) * 1.05
    ax.plot([0, lim], [0, lim], color="#999999", lw=0.6, ls="--")
    ax.set_xlim(0, lim)
    ax.set_ylim(0, lim)
    ax.set_aspect("equal")
    ax.set_xlabel("P_JP = S_JP / N_JP")
    ax.set_ylabel("P_KR = S_KR / N_KR")
    ax.set_title(f"{title}\nPearson r = {pearson:.3f}, Spearman ρ = {spearman:.3f} (탐색적; 쌍은 독립 관측치가 아님)", fontsize=7.8, loc="left")
    _clean(ax)
    stamp(fig, note)
    return fig


def fig_aligned_maps(A, B, labelsA, labelsB, rot_info, title, note=""):
    fig, axes = _fig(3.9, 1, 2, bottom=0.115)
    for ax, pts, labs, name in ((axes[0], A, labelsA, "한국 지도(기준)"), (axes[1], B, labelsB, "일본 지도(정렬 후)")):
        pts = np.asarray(pts)
        for i, p in enumerate(pts):
            color, marker, ring = cluster_style(labs[i])
            ax.scatter([p[0]], [p[1]], marker=marker, s=22, facecolor="white" if ring else color, edgecolor=color, linewidths=0.9)
        ax.axhline(0, color="#999", lw=0.5, ls="--")
        ax.axvline(0, color="#999", lw=0.5, ls="--")
        ax.set_aspect("equal")
        ax.set_title(name, fontsize=8, loc="left")
        ax.tick_params(labelsize=6)
    lim = max(np.abs(np.asarray(A)).max(), np.abs(np.asarray(B)).max()) * 1.15
    for ax in axes:
        ax.set_xlim(-lim, lim)
        ax.set_ylim(-lim, lim)
    fig.canvas.draw()  # final axes geometry, so that the numbers can be placed without overlapping each other or the markers
    fs = 5.6
    cw = fs * 0.62 * fig.dpi / 72
    for ax, pts in ((axes[0], A), (axes[1], B)):
        pts = np.asarray(pts)
        pix = [tuple(ax.transData.transform(p)) for p in pts]
        bb = ax.get_window_extent()
        frame = (bb.x0 + 2, bb.y0 + 2, bb.width - 4, bb.height - 4)
        placed = place_labels(pix, [str(i + 1) for i in range(len(pts))], frame, [], mr=4.0, cw=cw, h=fs * 1.25 * fig.dpi / 72)
        inv = ax.transData.inverted()
        for i, (box, leader) in enumerate(placed):
            tx, ty = inv.transform((box[0] + 1, box[1] + box[3] / 2))
            ax.text(tx, ty, str(i + 1), fontsize=fs, ha="left", va="center", color="#0f172a", zorder=7, path_effects=_halo())
            if leader:
                cxd, cyd = inv.transform((box[0] + box[2] / 2, box[1] + box[3] / 2))
                ax.plot([pts[i][0], cxd], [pts[i][1], cyd], color="#94a3b8", lw=0.5, zorder=4)
    import textwrap

    fig.suptitle(title, fontsize=8.5, x=0.01, ha="left")
    fig.text(0.012, 0.042, "\n".join(textwrap.wrap(rot_info, 105)), fontsize=6.3, color="#334155", ha="left", va="bottom")
    stamp(fig, note)
    return fig
