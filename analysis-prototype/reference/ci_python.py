"""
CI-executed Python reference runner. Reads the shared fixtures JSON
(exportFixtures.ts output) and an optional diagnostic fixtures JSON
(exportDiagnosticFixtures.ts output — strictNoTies), and produces
python-smacof-results.json / python-ward-results.json /
python-version-metadata.json / python-diagnostic-smacof-results.json for
compareReferences.ts to consume.

Pinned dependencies are recorded in python-version-metadata.json at runtime
(the actual resolved versions, not just what was requested) rather than only
in the workflow file, since this script runs against two different
scikit-learn version pins in two separate jobs (current vs legacy) — see
--label below.

Usage:
  python ci_python.py <fixtures.json> <output-dir> [--label current|legacy] [--diagnostic-fixtures <path>]

IMPORTANT, documented here rather than silently assumed:
- sklearn.manifold.smacof's public signature does not accept a per-pair
  weight matrix in any version checked so far. This script therefore only
  calls it on fixtures whose weight matrix is uniform (all off-diagonal = 1)
  — which is true for every fixture we run it on, since the offDiagonalZero
  and ties fixtures are excluded from sklearn comparison anyway (see below).
- sklearn's nonmetric SMACOF historically has ambiguous behavior for
  dissimilarity=0 off-diagonal entries in some versions/code paths (treated
  close to "missing" internally in parts of the ties-handling logic). Per
  instructions, the offDiagonalZero fixture is NOT run through sklearn at
  all — this is recorded explicitly in the metadata output, not silently
  skipped.
- Attempt-5 correction: sklearn.isotonic.IsotonicRegression DOES perform
  proper tie handling (ties in x share one fitted y, matching the
  "secondary" convention by construction) — this script's own
  stress_breakdown() recompute below now explicitly pools ties in the
  dissimilarity RANK KEY before calling IsotonicRegression, using x=pooled
  tie-block index rather than x=arange(n_pairs), so tied dissimilarities are
  guaranteed to receive one shared fitted disparity (matching isotonic.ts's
  isotonicRegressionByRank behavior) rather than being silently broken by
  Python's sort-stability. This does NOT change how sklearn's own internal
  smacof() computes disparities during majorization — that remains sklearn's
  own implementation, inspected read-only below (see
  inspect_sklearn_smacof_source) rather than assumed.
- This script independently RECOMPUTES stress from sklearn's returned
  embedding using this project's own formulas, rather than trusting
  sklearn's own internally-reported stress value to already be in the same
  normalization convention. All of rss / sumSquaredDistances /
  sumSquaredDisparities / both stress-1 denominator variants / sklearn's own
  reported stress / disparity-normalization metadata are reported side by
  side under distinct names — never conflated.
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


def active_pairs(n, weight=None):
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    if weight is None:
        return pairs
    return [(i, j) for (i, j) in pairs if weight[i][j] > 0]


def stress_breakdown(dissimilarity, distance, n):
    """Independently computes every stress-related quantity this project's
    stress.ts distinguishes by name.

    Tie handling (attempt-5 fix): dissimilarity values are pooled into tie
    blocks (values within 1e-9 of each other) BEFORE isotonic regression, and
    IsotonicRegression is fit on x=block_index (one x per DISTINCT
    dissimilarity value, weighted by block size) rather than x=arange(n) —
    this mirrors isotonic.ts's isotonicRegressionByRank secondary-tie
    behavior: every pair sharing a dissimilarity value receives one shared
    fitted disparity, not an artifact of sort-order stability.

    Returns a dict with distinctly-named fields (see module docstring):
      rss, sumSquaredDistances, sumSquaredDisparities,
      stress1DistanceDenominator, stress1DisparityDenominator,
      disparities (list of {pairKey, i, j, dissimilarity, disparity,
      configurationDistance}), activePairCount, targetNormQ,
      preNormalizationDisparitySumSquares,
      postNormalizationDisparitySumSquares, disparityNormalizationApplied
      (always False here — this recompute never rescales; sklearn's OWN
      internal normalization, if any, is inspected separately via
      inspect_sklearn_smacof_source, not replicated here).
    """
    pairs = active_pairs(n)
    sorted_pairs = sorted(pairs, key=lambda p: dissimilarity[p[0]][p[1]])

    # Pool exact ties in the dissimilarity rank key into blocks.
    tie_eps = 1e-9
    block_of_pair = {}
    block_targets = []
    block_weights = []
    for (i, j) in sorted_pairs:
        d_val = dissimilarity[i][j]
        if block_targets and abs(block_targets[-1][0] - d_val) <= tie_eps:
            block_idx = len(block_targets) - 1
        else:
            block_targets.append((d_val, []))
            block_idx = len(block_targets) - 1
            block_weights.append(0)
        block_targets[block_idx][1].append(distance[i][j])
        block_weights[block_idx] += 1
        block_of_pair[(i, j)] = block_idx

    block_means = np.array([np.mean(vals) for _, vals in block_targets])
    x = np.arange(len(block_means))
    ir = IsotonicRegression(increasing=True)
    fitted_blocks = ir.fit_transform(x, block_means, sample_weight=np.array(block_weights))

    disparity_by_pair = {}
    for (i, j) in pairs:
        disparity_by_pair[(i, j)] = float(fitted_blocks[block_of_pair[(i, j)]])

    rss = 0.0
    sum_sq_dist = 0.0
    sum_sq_disp = 0.0
    disparities_out = []
    for (i, j) in pairs:
        d_hat = disparity_by_pair[(i, j)]
        d_ij = distance[i][j]
        rss += (d_hat - d_ij) ** 2
        sum_sq_dist += d_ij ** 2
        sum_sq_disp += d_hat ** 2
        disparities_out.append({
            "pairKey": f"{i}-{j}",
            "i": i,
            "j": j,
            "dissimilarity": float(dissimilarity[i][j]),
            "disparity": d_hat,
            "configurationDistance": float(d_ij),
        })

    stress1_distance_denom = float(np.sqrt(rss / sum_sq_dist)) if sum_sq_dist > 0 else None
    stress1_disparity_denom = float(np.sqrt(rss / sum_sq_disp)) if sum_sq_disp > 0 else None

    return {
        "rss": float(rss),
        "sumSquaredDistances": float(sum_sq_dist),
        "sumSquaredDisparities": float(sum_sq_disp),
        "stress1DistanceDenominator": stress1_distance_denom,
        "stress1DisparityDenominator": stress1_disparity_denom,
        "disparities": disparities_out,
        "activePairCount": len(pairs),
        "targetNormQ": len(pairs),
        "preNormalizationDisparitySumSquares": float(sum_sq_disp),
        "postNormalizationDisparitySumSquares": float(sum_sq_disp),
        "disparityNormalizationApplied": False,
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
    convergence check and (b) any disparity-normalization step, WITHOUT
    calling any private function or monkey-patching anything.
    """
    try:
        from sklearn.manifold import _mds as mds_module

        source_file = inspect.getsourcefile(mds_module)
        with open(source_file, "r", encoding="utf-8") as f:
            source_text = f.read()
        file_hash = hashlib.sha256(source_text.encode("utf-8")).hexdigest()

        convergence_lines = []
        normalization_lines = []
        for lineno, line in enumerate(source_text.splitlines(), start=1):
            stripped = line.strip()
            if "eps" in stripped and ("stress" in stripped.lower() or "old_stress" in stripped or "<" in stripped or "break" in stripped):
                convergence_lines.append({"line": lineno, "text": stripped})
            if "disparities" in stripped and ("sqrt" in stripped or "*=" in stripped or "normalize" in stripped.lower()):
                normalization_lines.append({"line": lineno, "text": stripped})

        return {
            "sourceFile": source_file,
            "sourceFileSha256": file_hash,
            "convergenceRelatedLines": convergence_lines[:20],
            "disparityNormalizationRelatedLines": normalization_lines[:20],
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
    breakdown = stress_breakdown(dissimilarity, distance, n)

    result = {
        "coordinates": embedding.tolist(),
        "pairwiseDistance": distance.tolist(),
        "sklearnReportedStress": float(sklearn_stress),
        "recomputedRawStress": breakdown["rss"],
        "recomputedNormalizedStress1": breakdown["stress1DistanceDenominator"],
        "nIter": int(n_iter),
        "initShape": list(init.shape),
        **breakdown,
    }
    tie_blocks = compute_tie_blocks(breakdown["disparities"])

    snapshots = None
    if key in snapshot_keys:
        iteration0_distance = pairwise_distance(init)
        iteration0_breakdown = stress_breakdown(dissimilarity, iteration0_distance, n)
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
            snap_breakdown = stress_breakdown(dissimilarity, snap_distance, n)
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
                "note": "S1_INITIAL_DISPARITY: isotonic fit (tie-pooled) of S0's distances against the dissimilarity ranking.",
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
