# CI-executed R reference runner. Reads the shared fixtures JSON
# (exportFixtures.ts output) and produces r-smacof-results.json /
# r-ward-results.json / r-version-metadata.json for compareReferences.ts.
#
# Pinned dependencies (installed by the workflow via
# r-lib/actions/setup-r-dependencies@v2, public RSPM binaries):
#   jsonlite
#   smacof
#   (stats::hclust is base R, no install needed)
#
# smacof::mds() is used with type="ordinal" (nonmetric), ties="secondary"
# (matching this project's isotonic.ts tie-handling exactly, by name —
# unlike sklearn, the R smacof package documents its tie-handling
# convention explicitly, so this is a confirmed apples-to-apples setting,
# not an assumption), principal=FALSE (no post-hoc PCA rotation of the
# configuration, so coordinates are the majorization output as-is), and an
# explicit weightmat + init so every fixture, INCLUDING the off-diagonal-zero
# one, can be compared here (unlike sklearn, which lacks a weight parameter
# and is skipped for that fixture).
#
# Attempt 4 fix: the previous matrix_from_list() hardcoded ncol = nrow(lst),
# i.e. assumed every matrix is square. That is true for dissimilarity/weight
# (n x n) but false for initialCoordinates (n x dimension, e.g. 4x2) — for
# the zeroFree fixture (n=4) it tried to read row[[3]] / row[[4]] from a
# length-2 row, producing "Error in row[[j]] : subscript out of bounds".
# to_matrix() below infers row length per-input instead of assuming square,
# and validates the result explicitly rather than trusting a silent
# best-effort conversion.

suppressMessages(library(jsonlite))
suppressMessages(library(smacof))

args <- commandArgs(trailingOnly = TRUE)
fixtures_path <- args[1]
output_dir <- args[2]
dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

fixtures <- fromJSON(fixtures_path, simplifyVector = FALSE)

# ---- Structural diagnosis (no element values logged, per instructions) ----
log_structure <- function(x, label) {
  row_type_summary <- "n/a"
  row_length_summary <- "n/a"
  if (is.list(x) && length(x) > 0) {
    row_types <- vapply(x, typeof, character(1))
    row_lengths <- vapply(x, length, integer(1))
    row_type_summary <- paste(unique(row_types), collapse = ",")
    row_length_summary <- paste(unique(row_lengths), collapse = ",")
  }
  cat(sprintf(
    "[diag] %s: typeof=%s class=%s is.list=%s is.matrix=%s is.data.frame=%s length=%d row.typeof=%s row.length=%s\n",
    label, typeof(x), paste(class(x), collapse = "/"), is.list(x), is.matrix(x), is.data.frame(x),
    length(x), row_type_summary, row_length_summary
  ))
}

# ---- Robust, validated list/matrix/data.frame -> numeric matrix ----
to_matrix <- function(x, label, expected_nrow = NULL, expected_ncol = NULL) {
  if (is.matrix(x)) {
    m <- x
  } else if (is.data.frame(x)) {
    m <- as.matrix(x)
  } else if (is.list(x)) {
    nrow_x <- length(x)
    if (nrow_x == 0) stop(sprintf("R_MATRIX_SHAPE_INVALID: %s has zero rows", label))
    row_lengths <- vapply(x, length, integer(1))
    if (length(unique(row_lengths)) != 1) {
      stop(sprintf(
        "R_MATRIX_ROW_LENGTH_MISMATCH: %s rows have inconsistent lengths: %s",
        label, paste(row_lengths, collapse = ",")
      ))
    }
    ncol_x <- row_lengths[1]
    m <- matrix(NA_real_, nrow = nrow_x, ncol = ncol_x)
    for (i in seq_len(nrow_x)) {
      row <- x[[i]]
      for (j in seq_len(ncol_x)) {
        val <- if (is.list(row)) row[[j]] else row[j]
        if (!is.numeric(val)) {
          stop(sprintf("R_MATRIX_NOT_NUMERIC: %s[%d][%d] is not numeric (typeof=%s)", label, i, j, typeof(val)))
        }
        m[i, j] <- as.numeric(val)
      }
    }
  } else {
    stop(sprintf("R_MATRIX_SHAPE_INVALID: %s has unsupported type %s", label, typeof(x)))
  }

  if (length(dim(m)) != 2) stop(sprintf("R_MATRIX_SHAPE_INVALID: %s is not 2-dimensional", label))
  if (!is.numeric(m)) stop(sprintf("R_MATRIX_NOT_NUMERIC: %s is not numeric after conversion", label))
  if (any(is.nan(m))) stop(sprintf("R_MATRIX_NOT_NUMERIC: %s contains NaN", label))
  if (any(is.infinite(m))) stop(sprintf("R_MATRIX_NOT_NUMERIC: %s contains Infinity", label))
  if (!is.null(expected_nrow) && nrow(m) != expected_nrow) {
    stop(sprintf("R_MATRIX_SHAPE_INVALID: %s has %d rows, expected %d", label, nrow(m), expected_nrow))
  }
  if (!is.null(expected_ncol) && ncol(m) != expected_ncol) {
    stop(sprintf("R_MATRIX_SHAPE_INVALID: %s has %d cols, expected %d", label, ncol(m), expected_ncol))
  }
  m
}

assert_square <- function(m, label) {
  if (nrow(m) != ncol(m)) {
    stop(sprintf("R_MATRIX_SHAPE_INVALID: %s must be square, got %dx%d", label, nrow(m), ncol(m)))
  }
}

pairwise_distance <- function(coords) {
  as.matrix(dist(coords, method = "euclidean"))
}

matrix_to_json_rows <- function(m) {
  lapply(seq_len(nrow(m)), function(i) as.list(unname(m[i, ])))
}

active_pair_stats <- function(dissimilarity, weight) {
  n <- nrow(weight)
  active <- 0L
  zero_active <- 0L
  if (n >= 2) {
    for (i in 1:(n - 1)) {
      for (j in (i + 1):n) {
        if (weight[i, j] > 0) {
          active <- active + 1L
          if (dissimilarity[i, j] == 0) zero_active <- zero_active + 1L
        }
      }
    }
  }
  list(activeWeightedPairCount = active, zeroValuedActivePairCount = zero_active, totalPairs = n * (n - 1) / 2)
}

# ---- SMACOF ----
results <- list()
skipped <- list()
snapshots <- list()

SNAPSHOT_ITERS <- c(1, 2, 5, 10, 19)

for (key in names(fixtures$mds)) {
  fx <- fixtures$mds[[key]]

  log_structure(fx$dissimilarity, paste0(key, ".dissimilarity"))
  log_structure(fx$weight, paste0(key, ".weight"))
  log_structure(fx$initialCoordinates, paste0(key, ".initialCoordinates"))

  parsed <- tryCatch(
    {
      dissimilarity <- to_matrix(fx$dissimilarity, paste0(key, ".dissimilarity"))
      assert_square(dissimilarity, paste0(key, ".dissimilarity"))
      n <- nrow(dissimilarity)
      weight <- to_matrix(fx$weight, paste0(key, ".weight"), expected_nrow = n, expected_ncol = n)
      init <- to_matrix(fx$initialCoordinates, paste0(key, ".initialCoordinates"), expected_nrow = n, expected_ncol = fx$dimension)
      list(dissimilarity = dissimilarity, weight = weight, init = init, n = n)
    },
    error = function(e) list(.error = conditionMessage(e))
  )

  if (!is.null(parsed$.error)) {
    skipped[[key]] <- paste("Matrix conversion failed:", parsed$.error)
    next
  }

  dissimilarity <- parsed$dissimilarity
  weight <- parsed$weight
  init <- parsed$init
  pairStats <- active_pair_stats(dissimilarity, weight)

  fit <- tryCatch(
    {
      smacof::mds(
        delta = dissimilarity,
        type = "ordinal",
        ndim = fx$dimension,
        weightmat = weight,
        init = init,
        ties = "secondary",
        principal = FALSE,
        itmax = fx$maxIter,
        eps = fx$eps
      )
    },
    error = function(e) list(.error = conditionMessage(e))
  )

  if (!is.null(fit$.error)) {
    skipped[[key]] <- paste("smacof::mds() call failed:", fit$.error)
    next
  }

  coords <- fit$conf
  distance <- pairwise_distance(coords)
  confdist <- tryCatch(as.matrix(fit$confdist), error = function(e) NULL)
  dhat <- tryCatch(as.matrix(fit$dhat), error = function(e) NULL)

  results[[key]] <- list(
    coordinates = matrix_to_json_rows(coords),
    pairwiseDistance = matrix_to_json_rows(distance),
    rStress = fit$stress,
    # smacof package's own stress value; document its exact definition
    # relative to our normalizedStress1 in the comparison step rather than
    # assuming equivalence.
    niter = fit$niter,
    tiesMethodUsed = "secondary",
    weightmat = matrix_to_json_rows(weight),
    dhat = if (!is.null(dhat)) matrix_to_json_rows(dhat) else NULL,
    confdist = if (!is.null(confdist)) matrix_to_json_rows(confdist) else NULL,
    inputShape = list(nrow = parsed$n, ncol = parsed$n),
    initShape = list(nrow = nrow(init), ncol = ncol(init)),
    activeWeightedPairCount = pairStats$activeWeightedPairCount,
    zeroValuedActivePairCount = pairStats$zeroValuedActivePairCount,
    totalPairs = pairStats$totalPairs
  )

  # ---- Fixed-iteration diagnostics (zeroFree only, to bound runtime) ----
  # smacof::mds requires itmax >= 1, so "iteration 0" (the raw init, before
  # any update) is reported separately below using the shared coordinates,
  # not via an engine call. eps=0 is used to avoid the early-convergence
  # check from short-circuiting before the requested iteration count is
  # reached; if smacof::mds still stops earlier than requested (its own
  # internal stopping behavior is not otherwise overridable via public
  # parameters), that is reported explicitly via the `iterationsRun` field
  # rather than assumed to equal the requested snapshot iteration.
  if (key == "zeroFree") {
    snap_list <- list()
    for (iterCount in SNAPSHOT_ITERS) {
      snapFit <- tryCatch(
        smacof::mds(
          delta = dissimilarity,
          type = "ordinal",
          ndim = fx$dimension,
          weightmat = weight,
          init = init,
          ties = "secondary",
          principal = FALSE,
          itmax = iterCount,
          eps = 0
        ),
        error = function(e) list(.error = conditionMessage(e))
      )
      if (!is.null(snapFit$.error)) {
        snap_list[[as.character(iterCount)]] <- list(errored = TRUE, error = snapFit$.error)
        next
      }
      snapDist <- pairwise_distance(snapFit$conf)
      snapDhat <- tryCatch(as.matrix(snapFit$dhat), error = function(e) NULL)
      snap_list[[as.character(iterCount)]] <- list(
        requestedIterations = iterCount,
        iterationsRun = snapFit$niter,
        coordinates = matrix_to_json_rows(snapFit$conf),
        pairwiseDistance = matrix_to_json_rows(snapDist),
        dhat = if (!is.null(snapDhat)) matrix_to_json_rows(snapDhat) else NULL,
        libraryReportedStress = snapFit$stress
      )
    }
    snapshots[[key]] <- list(
      iteration0 = list(
        note = "Raw init (pre-iteration), computed once from the shared initial coordinates — not a smacof::mds() call.",
        coordinates = matrix_to_json_rows(init),
        pairwiseDistance = matrix_to_json_rows(pairwise_distance(init))
      ),
      snapshots = snap_list
    )
  }
}

write(toJSON(list(results = results, skipped = skipped, snapshots = snapshots), auto_unbox = TRUE, digits = 15), file.path(output_dir, "r-smacof-results.json"))

# ---- Ward via base R ----
ward_points <- to_matrix(fixtures$ward$tieFree$points, "ward.tieFree.points")
d <- dist(ward_points, method = "euclidean")
# ward.D2 expects RAW (non-squared) Euclidean distances — it applies the
# correct Lance-Williams squared-update internally. Passing pre-squared
# distances here would be the classic ward.D vs ward.D2 confusion this
# project is deliberately avoiding (see ward.ts module docstring).
hc <- hclust(d, method = "ward.D2")

n_points <- nrow(ward_points)
candidate_partitions <- list()
for (k in seq_len(n_points)) {
  candidate_partitions[[as.character(k)]] <- as.integer(cutree(hc, k = k)) - 1L # 0-indexed to match TS
}

write(
  toJSON(
    list(
      merge = hc$merge,
      height = hc$height,
      order = hc$order,
      originalCount = n_points,
      candidatePartitions = candidate_partitions
    ),
    auto_unbox = TRUE,
    digits = 15
  ),
  file.path(output_dir, "r-ward-results.json")
)

write(
  toJSON(
    list(
      rVersion = R.version.string,
      smacofVersion = as.character(packageVersion("smacof")),
      jsonliteVersion = as.character(packageVersion("jsonlite"))
    ),
    auto_unbox = TRUE
  ),
  file.path(output_dir, "r-version-metadata.json")
)

cat("R reference results written to:", output_dir, "\n")
cat("Skipped fixtures:", paste(names(skipped), collapse = ", "), "\n")
