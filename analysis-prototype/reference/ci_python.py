"""
CI-executed Python reference runner. Reads the shared fixtures JSON
(exportFixtures.ts output) and an optional diagnostic fixtures JSON
(exportDiagnosticFixtures.ts output — strictNoTies), and produces
python-smacof-results.json / python-ward-results.json /
python-version-metadata.json / python-diagnostic-smacof-results.json for
compareReferences.ts to consume.

Usage:
  python ci_python.py <fixtures.json> <output-dir> [--label current|legacy] [--diagnostic-fixtures <path>]

Attempt 7 rewrite of the disparity/stress recompute (stress_breakdown),
per the exact spec approved this round:
  1. pairwise distances from sklearn's returned embedding
  2. active pairs extracted i<j
  3. dissimilarity=0 pairs only reached via the zeroFree/strictNoTies
     fixtures (ties/offDiagonalZero remain excluded from sklearn entirely —
     unchanged policy, see below)
  4-9. public sklearn.isotonic.IsotonicRegression(increasing=True), no
     y_min/y_max, sample_weight=active weight, X=dissimilarity (the ACTUAL
     value, not a rank index or manually pooled tie-block index — sklearn's
     IsotonicRegression pools exactly-equal X values into one fitted Y
     itself when sorting internally; this is a public, documented behavior)
  10. same disparity normalization as the TypeScript engine:
      factor = sqrt(q / sum(w * disparity^2)), q = n(n-1)/2
  11. results restored to original pairKey order
  12. metadata: unique dissimilarity count, tie block count, X_thresholds_,
      y_thresholds_ (both PUBLIC post-fit attributes of IsotonicRegression),
      normalizationFactor, pre/post-normalization sum of squares

Three DISTINCTLY-named common-formula stress metrics are reported
(commonStressDistance / commonStressQ / commonStressDisparity), separate
from sklearn's own libraryReportedStress — never conflated. Internal
consistency between libraryReportedStress and each common metric is
reported so compareReferences.ts can determine, empirically, which
denominator convention sklearn's own reported stress actually uses,
without assuming it in advance.

IMPORTANT, unchanged from earlier attempts:
- sklearn.manifold.smacof's public signature does not accept a per-pair
  weight matrix in any version checked so far, and its nonmetric SMACOF has
  historically ambiguous behavior for dissimilarity=0 entries — the ties
  and offDiagonalZero fixtures remain excluded from sklearn comparison,
  recorded explicitly (not silently skipped).
"""
import argparse
import hashlib
import inspect
import json
import platform

import numpy as np
import scipy
import sklearn
from scipy.cluster.hierarchy import cut_tree, linkage
from sklearn.isotonic import IsotonicRegression
from sklearn.manifold import smacof

parser = argparse.ArgumentParser()
parser.add_argument("fixtures_path")
parser.add_argument("output_dir")
parser.add_argument("--label", default="current", choices=["current", "legacy"])
parser.add_argument("--diagnostic-fixtures", default=None)
args = parser.parse_args()

fixtures_path = args.fixtures_path
output_dir = args.output_dir
version_label = args.label
diagnostic_fixtures_path = args.diagnostic_fixtures

with open(fixtures_path, "r", encoding="utf-8") as f:
    fixtures = json.load(f)


def pairwise_distance(coords):
    coords = np.asarray(coords)
    n = coords.shape[0]
    d = np.zeros((n, n))
    for i in range(n):
        for j in range(n):
            d[i, j] = np.linalg.norm(coords[i] - coords[j])
    return d


def validate_init_shape(init, dissimilarity, n_components):
    """Defensive validation for the SMACOF init array, run immediately before
    every smacof() call. sklearn's public smacof() expects `init` shaped
    exactly (n_samples, n_components) — a plain 2D array, not wrapped in an
    extra leading dimension. Raises PYTHON_INIT_SHAPE_INVALID with a precise
    message instead of silently reshaping on mismatch.
    """
    n = dissimilarity.shape[0]
    if dissimilarity.ndim != 2 or dissimilarity.shape[0] != dissimilarity.shape[1]:
        raise ValueError(f"PYTHON_INIT_SHAPE_INVALID: dissimilarity is not square, got shape {dissimilarity.shape}")
    if init.ndim != 2:
        raise ValueError(f"PYTHON_INIT_SHAPE_INVALID: init.ndim must be 2, got {init.ndim} (shape {init.shape})")
    if init.shape[0] != n:
        raise ValueError(
            f"PYTHON_INIT_SHAPE_INVALID: init.shape[0] ({init.shape[0]}) must equal "
            f"dissimilarity.shape[0] ({n})"
        )
    if init.shape[1] != n_components:
        raise ValueError(
            f"PYTHON_INIT_SHAPE_INVALID: init.shape[1] ({init.shape[1]}) must equal "
            f"n_components ({n_components})"
        )


def active_pairs(n, weight):
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    return [(i, j) for (i, j) in pairs if weight[i][j] > 0]


def stress_breakdown(dissimilarity, distance, weight, n):
    """Independently computes rssPair/sumSquaredDistances/sumSquaredDisparities/q
    and three DISTINCTLY-named common-formula stress metrics, using the
    public sklearn.isotonic.IsotonicRegression directly on X=dissimilarity
    (not a rank index, not a manually pooled tie-block index) per the
    attempt-7 spec. See module docstring for the full 12-step procedure.
    """
    pairs = active_pairs(n, weight)
    x = np.array([dissimilarity[i][j] for (i, j) in pairs], dtype=float)
    y = np.array([distance[i][j] for (i, j) in pairs], dtype=float)
    w = np.array([weight[i][j] for (i, j) in pairs], dtype=float)

    ir = IsotonicRegression(increasing=True)
    fitted = ir.fit_transform(x, y, sample_weight=w)  # returned in ORIGINAL (x, y) order, not sorted

    unique_dissimilarity_count = int(len(np.unique(x)))
    x_thresholds = ir.X_thresholds_.tolist() if hasattr(ir, "X_thresholds_") else None
    y_thresholds = ir.y_thresholds_.tolist() if hasattr(ir, "y_thresholds_") else None
    tie_block_count = len(x_thresholds) if x_thresholds is not None else unique_dissimilarity_count

    q = n * (n - 1) / 2
    pre_norm_sumsq = float(np.sum(w * fitted ** 2))
    if pre_norm_sumsq > 0:
        normalization_factor = float(np.sqrt(q / pre_norm_sumsq))
    else:
        normalization_factor = float("nan")
    normalized = fitted * normalization_factor
    post_norm_sumsq = float(np.sum(w * normalized ** 2))

    rss = 0.0
    sum_sq_dist = 0.0
    sum_sq_disp = 0.0
    disparities_out = []
    for idx, (i, j) in enumerate(pairs):
        d_hat = float(normalized[idx])
        d_ij = float(y[idx])
        ww = float(w[idx])
        rss += ww * (d_hat - d_ij) ** 2
        sum_sq_dist += ww * d_ij ** 2
        sum_sq_disp += ww * d_hat ** 2
        disparities_out.append({
            "pairKey": f"{i}-{j}",
            "i": i,
            "j": j,
            "dissimilarity": float(dissimilarity[i][j]),
            "disparity": d_hat,
            "configurationDistance": d_ij,
        })

    common_stress_distance = float(np.sqrt(rss / sum_sq_dist)) if sum_sq_dist > 0 else None
    common_stress_q = float(np.sqrt(rss / q)) if q > 0 else None
    common_stress_disparity = float(np.sqrt(rss / sum_sq_disp)) if sum_sq_disp > 0 else None

    return {
        "rssPair": float(rss),
        "sumSquaredDistances": float(sum_sq_dist),
        "sumSquaredDisparities": float(sum_sq_disp),
        "q": q,
        "commonStressDistance": common_stress_distance,
        "commonStressQ": common_stress_q,
        "commonStressDisparity": common_stress_disparity,
        "disparities": disparities_out,
        "activePairCount": len(pairs),
        "uniqueDissimilarityCount": unique_dissimilarity_count,
        "tieBlockCount": tie_block_count,
        "xThresholds": x_thresholds,
        "yThresholds": y_thresholds,
        "normalizationFactor": normalization_factor,
        "preNormalizationSumSquares": pre_norm_sumsq,
        "postNormalizationSumSquares": post_norm_sumsq,
        # Legacy aliases (attempt 4-6 field names), kept for output consumers.
        "rss": float(rss),
        "stress1DistanceDenominator": common_stress_distance,
        "stress1DisparityDenominator": common_stress_disparity,
        "targetNormQ": q,
        "preNormalizationDisparitySumSquares": pre_norm_sumsq,
        "postNormalizationDisparitySumSquares": post_norm_sumsq,
        "disparityNormalizationApplied": True,
    }


def compute_tie_blocks(disparities, tie_eps=1e-9):
    """Groups this recompute's active pairs by (near-)equal dissimilarity —
    for direct tie-block comparison against TS's ts-tie-blocks.json.
    """
    sorted_d = sorted(disparities, key=lambda d: d["dissimilarity"])
    blocks = []
    for d in sorted_d:
        if blocks and abs(blocks[-1]["dissimilarity"] - d["dissimilarity"]) <= tie_eps:
            blocks[-1]["pairKeys"].append(d["pairKey"])
            blocks[-1]["disparityValues"].append(d["disparity"])
            blocks[-1]["configurationDistances"].append(d["configurationDistance"])
        else:
            blocks.append({
                "dissimilarity": d["dissimilarity"],
                "pairKeys": [d["pairKey"]],
                "disparityValues": [d["disparity"]],
                "configurationDistances": [d["configurationDistance"]],
            })
    out = []
    for idx, b in enumerate(blocks):
        out.append({
            "tieBlockId": idx,
            "dissimilarity": b["dissimilarity"],
            "pairKeys": b["pairKeys"],
            "blockSize": len(b["pairKeys"]),
            "meanConfigurationDistance": float(np.mean(b["configurationDistances"])),
            "disparityValues": b["disparityValues"],
            "disparityIsUniformWithinBlock": (max(b["disparityValues"]) - min(b["disparityValues"])) <= 1e-9,
            "fittedDisparity": b["disparityValues"][0],
        })
    return out


def inspect_sklearn_smacof_source():
    """Read-only inspection of the installed sklearn._mds module: records
    the file's version, a content hash (so a specific inspected file is
    traceable), and the exact source line(s) implementing (a) the
    convergence check and (b) the disparity-normalization / stress-return
    formula, WITHOUT calling any private function or monkey-patching
    anything. Widened this round to also capture the full "normalized_stress"
    computation block (previously only the disparity-rescale line and
    convergence check were captured).
    """
    try:
        from sklearn.manifold import _mds as mds_module

        source_file = inspect.getsourcefile(mds_module)
        with open(source_file, "r", encoding="utf-8") as f:
            source_text = f.read()
        file_hash = hashlib.sha256(source_text.encode("utf-8")).hexdigest()
        lines = source_text.splitlines()

        convergence_lines = []
        normalization_lines = []
        stress_return_lines = []
        for lineno, line in enumerate(lines, start=1):
            stripped = line.strip()
            if "eps" in stripped and ("stress" in stripped.lower() or "old_stress" in stripped or "<" in stripped or "break" in stripped):
                convergence_lines.append({"line": lineno, "text": stripped})
            if "disparities" in stripped and ("sqrt" in stripped or "*=" in stripped or "normalize" in stripped.lower()):
                normalization_lines.append({"line": lineno, "text": stripped})
            if "normalized_stress" in stripped or ("stress" in stripped.lower() and "return" in stripped.lower()):
                stress_return_lines.append({"line": lineno, "text": stripped})

        # Also capture a wider context window (+/- 8 lines) around the first
        # "normalized_stress" occurrence, since the actual formula often
        # spans several lines (an if/else branch), not just the matched line.
        context_block = []
        for idx, line in enumerate(lines):
            if "normalized_stress" in line:
                start = max(0, idx - 8)
                end = min(len(lines), idx + 9)
                context_block = [{"line": i + 1, "text": lines[i]} for i in range(start, end)]
                break

        return {
            "sourceFile": source_file,
            "sourceFileSha256": file_hash,
            "convergenceRelatedLines": convergence_lines[:20],
            "disparityNormalizationRelatedLines": normalization_lines[:20],
            "stressReturnRelatedLines": stress_return_lines[:20],
            "normalizedStressContextBlock": context_block,
        }
    except Exception as e:  # noqa: BLE001 - diagnostic best-effort, must not crash the run
        return {"error": str(e)}


SNAPSHOT_ITERS = [1, 2, 5, 10, 19]


def run_smacof_on_fixture(key, fx, snapshot_keys):
    """Runs sklearn's smacof() on one fixture and returns (result_dict,
    tie_blocks, snapshots_dict_or_None, skip_reason_or_None). Shared between
    the main fixtures.json loop and the diagnostic fixtures loop.
    """
    if key in ("ties", "offDiagonalZero"):
        return None, None, None, (
            "Excluded from sklearn comparison: sklearn.manifold.smacof's public API "
            "has no per-pair weight matrix and no independently-confirmed tie-handling "
            "convention matching this project's 'secondary' approach; off-diagonal "
            "dissimilarity=0 handling is not independently confirmed safe either. "
            "See ci_python.py module docstring."
        )

    dissimilarity = np.array(fx["dissimilarity"])
    weight = np.array(fx["weight"])
    init = np.array(fx["initialCoordinates"])
    n = dissimilarity.shape[0]
    n_components = fx["dimension"]

    validate_init_shape(init, dissimilarity, n_components)

    try:
        embedding, sklearn_stress, n_iter = smacof(
            dissimilarity,
            metric=False,
            n_components=n_components,
            init=init,
            n_init=1,
            max_iter=fx["maxIter"],
            eps=fx["eps"],
            random_state=0,
            normalized_stress=True,
            return_n_iter=True,
        )
    except TypeError:
        embedding, sklearn_stress, n_iter = smacof(
            dissimilarity,
            metric=False,
            n_components=n_components,
            init=init,
            n_init=1,
            max_iter=fx["maxIter"],
            eps=fx["eps"],
            random_state=0,
            return_n_iter=True,
        )

    distance = pairwise_distance(embedding)
    breakdown = stress_breakdown(dissimilarity, distance, weight, n)

    # ---- Internal consistency: which common-formula denominator does
    # sklearn's OWN reported stress actually match? Determined empirically
    # (never assumed) by comparing against all three candidates.
    library_reported_stress = float(sklearn_stress)
    candidates = {
        "commonStressDistance": breakdown["commonStressDistance"],
        "commonStressQ": breakdown["commonStressQ"],
        "commonStressDisparity": breakdown["commonStressDisparity"],
    }
    diffs = {k: (abs(library_reported_stress - v) if v is not None else float("inf")) for k, v in candidates.items()}
    best_match = min(diffs, key=diffs.get)

    result = {
        "coordinates": embedding.tolist(),
        "pairwiseDistance": distance.tolist(),
        "sklearnReportedStress": library_reported_stress,
        "libraryReportedStress": library_reported_stress,
        "libraryReportedAtIteration": int(n_iter),
        "returnedCoordinatesAtIteration": int(n_iter),
        "internalConsistencyDiffs": diffs,
        "internalConsistencyBestMatch": best_match,
        "recomputedRawStress": breakdown["rssPair"],
        "recomputedNormalizedStress1": breakdown["commonStressDistance"],
        "nIter": int(n_iter),
        "initShape": list(init.shape),
        **breakdown,
    }
    tie_blocks = compute_tie_blocks(breakdown["disparities"])

    snapshots = None
    if key in snapshot_keys:
        iteration0_distance = pairwise_distance(init)
        iteration0_breakdown = stress_breakdown(dissimilarity, iteration0_distance, weight, n)
        snap_list = {}
        for iter_count in SNAPSHOT_ITERS:
            snap_embedding, snap_stress, snap_n_iter = smacof(
                dissimilarity,
                metric=False,
                n_components=n_components,
                init=init,
                n_init=1,
                max_iter=iter_count,
                eps=0.0,
                random_state=0,
                return_n_iter=True,
            )
            snap_distance = pairwise_distance(snap_embedding)
            snap_breakdown = stress_breakdown(dissimilarity, snap_distance, weight, n)
            snap_list[str(iter_count)] = {
                "requestedIterations": iter_count,
                "iterationsRun": int(snap_n_iter),
                "coordinates": snap_embedding.tolist(),
                "pairwiseDistance": snap_distance.tolist(),
                "libraryReportedStress": float(snap_stress),
                **snap_breakdown,
            }
        snapshots = {
            "iteration0": {
                "note": "S0_INITIAL_CONFIGURATION: raw init, before any disparity fit or Guttman update.",
                "coordinates": init.tolist(),
                "pairwiseDistance": iteration0_distance.tolist(),
                **iteration0_breakdown,
            },
            "s1InitialDisparity": {
                "note": "S1_INITIAL_DISPARITY: isotonic fit of S0's distances against the dissimilarity ranking, via public sklearn.isotonic.IsotonicRegression with X=dissimilarity.",
                **iteration0_breakdown,
            },
            "snapshots": snap_list,
        }

    return result, tie_blocks, snapshots, None


def process_fixture_set(mds_fixtures, snapshot_keys):
    results = {}
    tie_blocks_by_fixture = {}
    snapshots_by_fixture = {}
    skipped = {}
    for key, fx in mds_fixtures.items():
        result, tie_blocks, snapshots, skip_reason = run_smacof_on_fixture(key, fx, snapshot_keys)
        if skip_reason:
            skipped[key] = skip_reason
            continue
        results[key] = result
        tie_blocks_by_fixture[key] = tie_blocks
        if snapshots:
            snapshots_by_fixture[key] = snapshots
    return results, tie_blocks_by_fixture, snapshots_by_fixture, skipped


# ---- Main fixtures ----
smacof_results, tie_blocks, snapshots, skipped = process_fixture_set(fixtures["mds"], {"zeroFree"})

with open(f"{output_dir}/python-smacof-results.json", "w", encoding="utf-8") as f:
    json.dump({"results": smacof_results, "skipped": skipped, "snapshots": snapshots, "versionLabel": version_label}, f, indent=2)
with open(f"{output_dir}/python-tie-blocks.json", "w", encoding="utf-8") as f:
    json.dump(tie_blocks, f, indent=2)

# ---- Diagnostic fixtures (strictNoTies), if provided ----
if diagnostic_fixtures_path:
    with open(diagnostic_fixtures_path, "r", encoding="utf-8") as f:
        diagnostic_fixtures = json.load(f)
    diag_results, diag_tie_blocks, diag_snapshots, diag_skipped = process_fixture_set(
        diagnostic_fixtures["mds"], set(diagnostic_fixtures["mds"].keys())
    )
    with open(f"{output_dir}/python-diagnostic-smacof-results.json", "w", encoding="utf-8") as f:
        json.dump({"results": diag_results, "skipped": diag_skipped, "snapshots": diag_snapshots, "versionLabel": version_label}, f, indent=2)
    with open(f"{output_dir}/python-diagnostic-tie-blocks.json", "w", encoding="utf-8") as f:
        json.dump(diag_tie_blocks, f, indent=2)

# ---- Ward via SciPy ----
ward_points = np.array(fixtures["ward"]["tieFree"]["points"])
Z = linkage(ward_points, method="ward")
n_points = ward_points.shape[0]

# cut_tree(..., n_clusters=[k]) is used instead of
# fcluster(..., criterion="maxclust"), which SciPy documents as returning AT
# MOST k clusters (not necessarily exactly k) when tie/threshold ambiguity
# exists near the cut boundary. cut_tree cuts the dendrogram directly at the
# n-k'th merge, which always yields exactly k clusters for 1<=k<=n. Each
# result is asserted before being trusted.
candidate_partitions = {}
for k in range(1, n_points + 1):
    labels = cut_tree(Z, n_clusters=[k])[:, 0]
    assert 1 <= k <= n_points, f"WARD_EXACT_K_INVALID: k={k} out of range [1,{n_points}]"
    assert len(labels) == n_points, f"WARD_EXACT_K_INVALID: assignment length {len(labels)} != n {n_points}"
    unique_count = len(set(labels.tolist()))
    assert unique_count == k, f"WARD_EXACT_K_INVALID: k={k} requested but got {unique_count} unique clusters"
    candidate_partitions[str(k)] = [int(x) for x in labels]

linkage_rows = []
for step, row in enumerate(Z):
    linkage_rows.append(
        {
            "step": step,
            "leftNode": int(row[0]),
            "rightNode": int(row[1]),
            "mergeDistance": float(row[2]),
            "mergedItemCount": int(row[3]),
        }
    )

with open(f"{output_dir}/python-ward-results.json", "w", encoding="utf-8") as f:
    json.dump(
        {
            "linkage": linkage_rows,
            "originalCount": n_points,
            "candidatePartitions": candidate_partitions,
            "exactKMethod": "scipy.cluster.hierarchy.cut_tree",
        },
        f,
        indent=2,
    )

sklearn_source_inspection = inspect_sklearn_smacof_source()

with open(f"{output_dir}/python-version-metadata.json", "w", encoding="utf-8") as f:
    json.dump(
        {
            "versionLabel": version_label,
            "pythonVersion": platform.python_version(),
            "numpyVersion": np.__version__,
            "scipyVersion": scipy.__version__,
            "scikitLearnVersion": sklearn.__version__,
            "sklearnSmacofSourceInspection": sklearn_source_inspection,
        },
        f,
        indent=2,
    )

print("Python reference results written to:", output_dir, "(label:", version_label, ")")
print("Skipped fixtures:", list(skipped.keys()))
