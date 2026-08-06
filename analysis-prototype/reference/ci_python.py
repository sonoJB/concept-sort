"""
CI-executed Python reference runner. Reads the shared fixtures JSON
(exportFixtures.ts output) and produces python-smacof-results.json /
python-ward-results.json / python-version-metadata.json for
compareReferences.ts to consume.

Pinned dependencies are recorded in python-version-metadata.json at runtime
(the actual resolved versions, not just what was requested) rather than only
in the workflow file, since attempt 4 runs this same script against two
different scikit-learn version pins in two separate jobs (current vs
legacy) — see --label below.

Usage:
  python ci_python.py <fixtures.json> <output-dir> [--label current|legacy]

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
- This script independently RECOMPUTES stress from sklearn's returned
  embedding using this project's own formulas (isotonic fit via
  sklearn.isotonic.IsotonicRegression, weighted, on the same
  ascending-dissimilarity-rank ordering used in isotonic.ts), rather than
  trusting sklearn's own internally-reported stress value to already be in
  the same normalization convention. All of rss / sumSquaredDistances /
  sumSquaredDisparities / both stress-1 denominator variants /
  sklearn's own reported stress are reported side by side under distinct
  names — never conflated.
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
args = parser.parse_args()

fixtures_path = args.fixtures_path
output_dir = args.output_dir
version_label = args.label

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
    stress.ts distinguishes by name, using this project's own formulas
    (weighted isotonic regression on ascending-dissimilarity rank, secondary
    tie handling via sklearn.isotonic.IsotonicRegression which pools ties by
    construction when x-values repeat). Uniform weight=1 is assumed here
    (this function is only called on fixtures run through sklearn, which
    excludes the weighted/off-diagonal-zero fixtures already).

    Returns a dict with distinctly-named fields:
      rss                        = sum w_ij (disparity_ij - distance_ij)^2
      sumSquaredDistances         = sum w_ij distance_ij^2
      sumSquaredDisparities       = sum w_ij disparity_ij^2
      stress1DistanceDenominator  = sqrt(rss / sumSquaredDistances)   -- this
                                     project's normalizedStress1 definition
      stress1DisparityDenominator = sqrt(rss / sumSquaredDisparities) -- an
                                     alternative denominator convention some
                                     libraries use; reported for comparison,
                                     never written into normalizedStress1
      disparities                 = list of {i, j, dissimilarity, disparity}
                                     in pair order (i<j, row-major)
    """
    pairs = active_pairs(n)
    sorted_pairs = sorted(pairs, key=lambda p: dissimilarity[p[0]][p[1]])
    y = np.array([distance[i][j] for i, j in sorted_pairs])
    x = np.arange(len(sorted_pairs))
    ir = IsotonicRegression(increasing=True)
    disparity_sorted = ir.fit_transform(x, y)

    disparity_by_pair = {}
    for (i, j), d_hat in zip(sorted_pairs, disparity_sorted):
        disparity_by_pair[(i, j)] = float(d_hat)

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
        disparities_out.append({"i": i, "j": j, "dissimilarity": float(dissimilarity[i][j]), "disparity": d_hat})

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
    }


def inspect_sklearn_convergence_source():
    """Read-only inspection of the installed sklearn._mds module: records
    the file's version, a content hash (so a specific inspected file is
    traceable), and the exact source line(s) implementing the convergence
    check, WITHOUT calling any private function or monkey-patching anything.
    """
    try:
        from sklearn.manifold import _mds as mds_module

        source_file = inspect.getsourcefile(mds_module)
        with open(source_file, "r", encoding="utf-8") as f:
            source_text = f.read()
        file_hash = hashlib.sha256(source_text.encode("utf-8")).hexdigest()

        convergence_lines = []
        for lineno, line in enumerate(source_text.splitlines(), start=1):
            stripped = line.strip()
            if "eps" in stripped and ("stress" in stripped.lower() or "old_stress" in stripped or "<" in stripped or "break" in stripped):
                convergence_lines.append({"line": lineno, "text": stripped})

        return {
            "sourceFile": source_file,
            "sourceFileSha256": file_hash,
            "convergenceRelatedLines": convergence_lines[:20],
        }
    except Exception as e:  # noqa: BLE001 - diagnostic best-effort, must not crash the run
        return {"error": str(e)}


smacof_results = {}
skipped = {}
snapshots = {}

SNAPSHOT_ITERS = [1, 2, 5, 10, 19]

for key, fx in fixtures["mds"].items():
    if key in ("ties", "offDiagonalZero"):
        skipped[key] = (
            "Excluded from sklearn comparison: sklearn.manifold.smacof's public API "
            "has no per-pair weight matrix and no independently-confirmed tie-handling "
            "convention matching this project's 'secondary' approach; off-diagonal "
            "dissimilarity=0 handling is not independently confirmed safe either. "
            "See ci_python.py module docstring."
        )
        continue

    dissimilarity = np.array(fx["dissimilarity"])
    init = np.array(fx["initialCoordinates"])
    n = dissimilarity.shape[0]
    n_components = fx["dimension"]

    # sklearn's public smacof() expects init shaped (n_samples, n_components)
    # directly — a plain 2D array. No reshape here; validate instead of
    # coercing, so a genuine shape mismatch surfaces as a clear error rather
    # than being silently "fixed" into some other unintended shape.
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
        # Older sklearn without normalized_stress kwarg — retry without it,
        # and record that sklearn's own stress value in that case is its
        # legacy (non-normalized) convention, not necessarily Stress-1.
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

    smacof_results[key] = {
        "coordinates": embedding.tolist(),
        "pairwiseDistance": distance.tolist(),
        "sklearnReportedStress": float(sklearn_stress),
        "recomputedRawStress": breakdown["rss"],
        "recomputedNormalizedStress1": breakdown["stress1DistanceDenominator"],
        "rss": breakdown["rss"],
        "sumSquaredDistances": breakdown["sumSquaredDistances"],
        "sumSquaredDisparities": breakdown["sumSquaredDisparities"],
        "stress1DistanceDenominator": breakdown["stress1DistanceDenominator"],
        "stress1DisparityDenominator": breakdown["stress1DisparityDenominator"],
        "disparities": breakdown["disparities"],
        "activePairCount": breakdown["activePairCount"],
        "nIter": int(n_iter),
        "initShape": list(init.shape),
    }

    # ---- Fixed-iteration diagnostics (zeroFree only, to bound runtime) ----
    # eps=0 is the public, documented parameter used to discourage
    # early-convergence stopping so the state after exactly N iterations can
    # be observed. sklearn's smacof() may still stop earlier than max_iter
    # for reasons unrelated to eps (e.g. a stress-non-decrease guard); if
    # the returned n_iter is less than the requested snapshot iteration
    # count, that is recorded explicitly via "iterationsRun" rather than
    # assumed to equal the request.
    if key == "zeroFree":
        snap_list = {}
        iteration0_distance = pairwise_distance(init)
        iteration0_breakdown = stress_breakdown(dissimilarity, iteration0_distance, n)
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
                "rss": snap_breakdown["rss"],
                "stress1DistanceDenominator": snap_breakdown["stress1DistanceDenominator"],
                "stress1DisparityDenominator": snap_breakdown["stress1DisparityDenominator"],
                "libraryReportedStress": float(snap_stress),
            }
        snapshots[key] = {
            "iteration0": {
                "note": "Raw init (pre-iteration), computed directly — not a smacof() call.",
                "coordinates": init.tolist(),
                "pairwiseDistance": iteration0_distance.tolist(),
                "rss": iteration0_breakdown["rss"],
                "stress1DistanceDenominator": iteration0_breakdown["stress1DistanceDenominator"],
            },
            "snapshots": snap_list,
        }

with open(f"{output_dir}/python-smacof-results.json", "w", encoding="utf-8") as f:
    json.dump({"results": smacof_results, "skipped": skipped, "snapshots": snapshots, "versionLabel": version_label}, f, indent=2)

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

sklearn_source_inspection = inspect_sklearn_convergence_source()

with open(f"{output_dir}/python-version-metadata.json", "w", encoding="utf-8") as f:
    json.dump(
        {
            "versionLabel": version_label,
            "pythonVersion": platform.python_version(),
            "numpyVersion": np.__version__,
            "scipyVersion": scipy.__version__,
            "scikitLearnVersion": sklearn.__version__,
            "sklearnConvergenceSourceInspection": sklearn_source_inspection,
        },
        f,
        indent=2,
    )

print("Python reference results written to:", output_dir, "(label:", version_label, ")")
print("Skipped fixtures:", list(skipped.keys()))
