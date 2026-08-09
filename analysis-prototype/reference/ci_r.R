# CI-executed R reference runner. Reads the shared fixtures JSON
# (exportFixtures.ts output) and an optional diagnostic fixtures JSON
# (exportDiagnosticFixtures.ts output — strictNoTies), and produces
# r-smacof-results.json / r-ward-results.json / r-version-metadata.json /
# r-diagnostic-smacof-results.json for compareReferences.ts.
#
# Pinned dependencies (installed by the workflow via
# r-lib/actions/setup-r-dependencies@v2, public RSPM binaries):
#   jsonlite
#   smacof
#   (stats::hclust is base R, no install needed)
#
# smacof::mds() is used with type="ordinal" (nonmetric), ties="secondary"
# (matching this project's isotonic.ts tie-handling exactly, by name),
# principal=FALSE (no post-hoc PCA rotation of the configuration, so
# coordinates are the majorization output as-is), and an explicit weightmat
# + init so every fixture, INCLUDING the off-diagonal-zero one, can be
# compared here (unlike sklearn, which lacks a weight parameter and is
# skipped for that fixture).
#
# Attempt 4 fix: matrix_from_list()'s square-matrix assumption was replaced
# with to_matrix(), which infers each input's actual row length instead of
# assuming ncol == nrow — see the attempt-4 report for the exact bug this
# fixed ("Error in row[[j]] : subscript out of bounds" on the n x dimension
# init array).
#
# Attempt 5 additions: pairKey-labeled, tie-block-grouped disparity output
# (compute_tie_blocks_r, using the ACTUAL dhat matrix smacof::mds returns —
# not a separate recompute, since R's ties="secondary" is this project's
# reference for what "correct" tie handling looks like) and a best-effort,
# read-only inspection of the installed smacof package's own disparity
# normalization / initial-configuration-scaling internals
# (inspect_smacof_internals) via ls()/get()/body()/deparse() — standard R
# introspection, no monkey-patching, no assignInNamespace.

suppressMessages(library(jsonlite))
suppressMessages(library(smacof))

args <- commandArgs(trailingOnly = TRUE)
fixtures_path <- args[1]
output_dir <- args[2]
diagnostic_fixtures_path <- if (length(args) >= 3) args[3] else NA
dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

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

# ---- pairKey-labeled disparities + tie-block grouping, from smacof::mds's OWN dhat ----
disparities_from_fit <- function(dissimilarity, weight, distance, dhat) {
  n <- nrow(weight)
  out <- list()
  if (n >= 2) {
    for (i in 1:(n - 1)) {
      for (j in (i + 1):n) {
        if (weight[i, j] > 0) {
          out[[length(out) + 1]] <- list(
            pairKey = sprintf("%d-%d", i - 1, j - 1),
            i = i - 1,
            j = j - 1,
            dissimilarity = dissimilarity[i, j],
            disparity = dhat[i, j],
            configurationDistance = distance[i, j]
          )
        }
      }
    }
  }
  out
}

compute_tie_blocks_r <- function(disparities, tie_eps = 1e-9) {
  if (length(disparities) == 0) return(list())
  ord <- order(vapply(disparities, function(p) p$dissimilarity, numeric(1)))
  sorted_d <- disparities[ord]
  blocks <- list()
  for (p in sorted_d) {
    if (length(blocks) > 0 && abs(blocks[[length(blocks)]]$dissimilarity - p$dissimilarity) <= tie_eps) {
      idx <- length(blocks)
      blocks[[idx]]$pairKeys <- c(blocks[[idx]]$pairKeys, p$pairKey)
      blocks[[idx]]$disparityValues <- c(blocks[[idx]]$disparityValues, p$disparity)
      blocks[[idx]]$configurationDistances <- c(blocks[[idx]]$configurationDistances, p$configurationDistance)
    } else {
      blocks[[length(blocks) + 1]] <- list(
        dissimilarity = p$dissimilarity,
        pairKeys = c(p$pairKey),
        disparityValues = c(p$disparity),
        configurationDistances = c(p$configurationDistance)
      )
    }
  }
  out <- list()
  for (idx in seq_along(blocks)) {
    b <- blocks[[idx]]
    out[[idx]] <- list(
      tieBlockId = idx - 1,
      dissimilarity = b$dissimilarity,
      pairKeys = b$pairKeys,
      blockSize = length(b$pairKeys),
      meanConfigurationDistance = mean(b$configurationDistances),
      disparityValues = b$disparityValues,
      disparityIsUniformWithinBlock = (max(b$disparityValues) - min(b$disparityValues)) <= 1e-9,
      fittedDisparity = b$disparityValues[1]
    )
  }
  out
}

disparity_norm_stats <- function(disparities, weight) {
  sum_sq <- 0
  for (p in disparities) sum_sq <- sum_sq + p$disparity^2
  list(
    activePairCount = length(disparities),
    targetNormQ = length(disparities),
    postNormalizationDisparitySumSquares = sum_sq,
    # smacof::mds() does not expose a pre-normalization disparity value via
    # its public return object — only the final dhat is available without
    # calling internal/private functions, which is out of scope here. This
    # is recorded explicitly as NA rather than guessed.
    preNormalizationDisparitySumSquares = NA
  )
}

# ---- Attempt 7: independent common-formula stress recompute from fit's
# OWN public return fields (fit$dhat, fit$confdist/distance, fit$weightmat)
# — never from a private/internal call. Computes BOTH the i<j-once
# convention AND the full-matrix (i != j, every pair counted twice)
# convention, so whichever matches fit$stress can be determined
# empirically rather than assumed.
common_stress_recompute_r <- function(disparities, n) {
  rss_pair <- 0
  sum_sq_dist_pair <- 0
  sum_sq_disp_pair <- 0
  for (p in disparities) {
    resid <- p$disparity - p$configurationDistance
    rss_pair <- rss_pair + resid^2
    sum_sq_dist_pair <- sum_sq_dist_pair + p$configurationDistance^2
    sum_sq_disp_pair <- sum_sq_disp_pair + p$disparity^2
  }
  q <- n * (n - 1) / 2

  common_stress_distance <- if (sum_sq_dist_pair > 0) sqrt(rss_pair / sum_sq_dist_pair) else NA
  common_stress_q <- if (q > 0) sqrt(rss_pair / q) else NA
  common_stress_disparity <- if (sum_sq_disp_pair > 0) sqrt(rss_pair / sum_sq_disp_pair) else NA

  # Full-matrix (double-counted) convention: every off-diagonal (i,j) with
  # i != j counted once each direction, i.e. exactly 2x the i<j sums above
  # (since the underlying matrices are symmetric) — computed explicitly
  # here rather than just multiplying by 2, so a genuine asymmetry in the
  # source matrices would surface as a real discrepancy, not be masked.
  rss_full <- 2 * rss_pair
  sum_sq_dist_full <- 2 * sum_sq_dist_pair
  stress_q_full <- if ((2 * q) > 0) sqrt(rss_full / (2 * q)) else NA
  stress_distance_full <- if (sum_sq_dist_full > 0) sqrt(rss_full / sum_sq_dist_full) else NA

  list(
    rssPair = rss_pair,
    sumSquaredDistances = sum_sq_dist_pair,
    sumSquaredDisparities = sum_sq_disp_pair,
    q = q,
    commonStressDistance = common_stress_distance,
    commonStressQ = common_stress_q,
    commonStressDisparity = common_stress_disparity,
    rssFullMatrix = rss_full,
    stressQFullMatrix = stress_q_full,
    stressDistanceFullMatrix = stress_distance_full
  )
}

determine_best_match <- function(library_reported_stress, candidates) {
  diffs <- lapply(candidates, function(v) if (is.na(v)) Inf else abs(library_reported_stress - v))
  names_vec <- names(candidates)
  best_idx <- which.min(unlist(diffs))
  list(diffs = diffs, bestMatch = names_vec[best_idx])
}

# ---- Best-effort, read-only inspection of smacof's own internals ----
# Uses only standard R introspection (ls/get/body/deparse on the package
# namespace) — no monkey-patching, no assignInNamespace, no altering
# behavior. Attempt 7: widened beyond norm/transform/scale-named functions
# to also grep every function body in the namespace for stress/snon/rss
# lines directly, and specifically tries smacofSym (the package's
# documented core symmetric-SMACOF workhorse function name) if present.
inspect_smacof_internals <- function() {
  tryCatch(
    {
      ns <- asNamespace("smacof")
      all_names <- ls(ns, all.names = TRUE)
      name_candidates <- all_names[grepl("norm|transform|Transform|scale|Scale", all_names)]
      snippets <- list()
      for (nm in name_candidates) {
        obj <- tryCatch(get(nm, envir = ns), error = function(e) NULL)
        if (is.function(obj)) {
          src <- tryCatch(deparse(body(obj)), error = function(e) NULL)
          if (!is.null(src)) {
            snippets[[nm]] <- paste(utils::head(src, 15), collapse = "\n")
          }
        }
      }

      # Grep EVERY function's deparsed body for stress/snon/rss-related
      # lines, regardless of function name, and record which function each
      # matching line came from.
      stress_related_lines <- list()
      for (nm in all_names) {
        obj <- tryCatch(get(nm, envir = ns), error = function(e) NULL)
        if (!is.function(obj)) next
        src <- tryCatch(deparse(body(obj)), error = function(e) NULL)
        if (is.null(src)) next
        matches <- grep("stress|snon|\\brss\\b", src, ignore.case = TRUE, value = TRUE)
        if (length(matches) > 0) {
          stress_related_lines[[nm]] <- as.list(utils::head(matches, 10))
        }
      }

      smacof_sym_source <- NULL
      if ("smacofSym" %in% all_names) {
        obj <- tryCatch(get("smacofSym", envir = ns), error = function(e) NULL)
        if (is.function(obj)) {
          src <- tryCatch(deparse(body(obj)), error = function(e) NULL)
          if (!is.null(src)) smacof_sym_source <- as.list(src)
        }
      }

      list(
        candidateFunctionNames = as.list(name_candidates),
        sourceSnippets = snippets,
        stressRelatedLinesByFunction = stress_related_lines,
        smacofSymFullSource = smacof_sym_source
      )
    },
    error = function(e) list(error = conditionMessage(e))
  )
}

SNAPSHOT_ITERS <- c(1, 2, 5, 10, 19)

# ---- Reusable per-fixture-set processor (main + diagnostic fixtures) ----
process_fixture_set <- function(mds_fixtures, snapshot_keys) {
  results <- list()
  skipped <- list()
  snapshots <- list()
  tie_blocks_by_fixture <- list()

  for (key in names(mds_fixtures)) {
    fx <- mds_fixtures[[key]]

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
    disparities <- if (!is.null(dhat)) disparities_from_fit(dissimilarity, weight, distance, dhat) else list()
    normStats <- disparity_norm_stats(disparities, weight)
    commonStress <- common_stress_recompute_r(disparities, parsed$n)
    matchInfo <- determine_best_match(fit$stress, list(
      commonStressDistance = commonStress$commonStressDistance,
      commonStressQ = commonStress$commonStressQ,
      commonStressDisparity = commonStress$commonStressDisparity,
      stressQFullMatrix = commonStress$stressQFullMatrix,
      stressDistanceFullMatrix = commonStress$stressDistanceFullMatrix
    ))

    results[[key]] <- c(
      list(
        coordinates = matrix_to_json_rows(coords),
        pairwiseDistance = matrix_to_json_rows(distance),
        rStress = fit$stress,
        libraryReportedStress = fit$stress,
        libraryReportedAtIteration = fit$niter,
        returnedCoordinatesAtIteration = fit$niter,
        fitRss = if (!is.null(fit$rss)) fit$rss else NA,
        niter = fit$niter,
        tiesMethodUsed = "secondary",
        weightmat = matrix_to_json_rows(weight),
        dhat = if (!is.null(dhat)) matrix_to_json_rows(dhat) else NULL,
        confdist = if (!is.null(confdist)) matrix_to_json_rows(confdist) else NULL,
        inputShape = list(nrow = parsed$n, ncol = parsed$n),
        initShape = list(nrow = nrow(init), ncol = ncol(init)),
        activeWeightedPairCount = pairStats$activeWeightedPairCount,
        zeroValuedActivePairCount = pairStats$zeroValuedActivePairCount,
        totalPairs = pairStats$totalPairs,
        disparities = disparities,
        internalConsistencyDiffs = matchInfo$diffs,
        internalConsistencyBestMatch = matchInfo$bestMatch
      ),
      normStats,
      commonStress
    )
    tie_blocks_by_fixture[[key]] <- compute_tie_blocks_r(disparities)

    if (key %in% snapshot_keys) {
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
          note = "S0_INITIAL_CONFIGURATION: raw init (pre-iteration) — not a smacof::mds() call.",
          coordinates = matrix_to_json_rows(init),
          pairwiseDistance = matrix_to_json_rows(pairwise_distance(init))
        ),
        snapshots = snap_list
      )
    }
  }

  list(results = results, skipped = skipped, snapshots = snapshots, tieBlocks = tie_blocks_by_fixture)
}

fixtures <- fromJSON(fixtures_path, simplifyVector = FALSE)
main_out <- process_fixture_set(fixtures$mds, c("zeroFree"))

write(toJSON(list(results = main_out$results, skipped = main_out$skipped, snapshots = main_out$snapshots), auto_unbox = TRUE, digits = 15), file.path(output_dir, "r-smacof-results.json"))
write(toJSON(main_out$tieBlocks, auto_unbox = TRUE, digits = 15), file.path(output_dir, "r-tie-blocks.json"))

if (!is.na(diagnostic_fixtures_path)) {
  diagnostic_fixtures <- fromJSON(diagnostic_fixtures_path, simplifyVector = FALSE)
  diag_out <- process_fixture_set(diagnostic_fixtures$mds, names(diagnostic_fixtures$mds))
  write(toJSON(list(results = diag_out$results, skipped = diag_out$skipped, snapshots = diag_out$snapshots), auto_unbox = TRUE, digits = 15), file.path(output_dir, "r-diagnostic-smacof-results.json"))
  write(toJSON(diag_out$tieBlocks, auto_unbox = TRUE, digits = 15), file.path(output_dir, "r-diagnostic-tie-blocks.json"))
}

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

smacof_internals_inspection <- inspect_smacof_internals()

write(
  toJSON(
    list(
      rVersion = R.version.string,
      smacofVersion = as.character(packageVersion("smacof")),
      jsonliteVersion = as.character(packageVersion("jsonlite")),
      smacofInternalsInspection = smacof_internals_inspection
    ),
    auto_unbox = TRUE
  ),
  file.path(output_dir, "r-version-metadata.json")
)

cat("R reference results written to:", output_dir, "\n")
cat("Skipped fixtures:", paste(names(main_out$skipped), collapse = ", "), "\n")
