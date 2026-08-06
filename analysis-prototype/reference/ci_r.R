# CI-executed R reference runner. Reads the shared fixtures JSON
# (exportFixtures.ts output) and produces r-smacof-results.json /
# r-ward-results.json / r-version-metadata.json for compareReferences.ts.
#
# Pinned dependencies (installed by the workflow via install.packages with
# explicit versions where feasible — CRAN does not always serve arbitrary
# historical versions without remotes::install_version, used below):
#   jsonlite
#   smacof
#   (stats::hclust is base R, no install needed)
#
# smacof::mds() is used with type="ordinal" (nonmetric), ties="secondary"
# (matching this project's isotonic.ts tie-handling exactly, by name —
# unlike sklearn, the R smacof package documents its tie-handling
# convention explicitly, so this is a confirmed apples-to-apples setting,
# not an assumption) and an explicit weightmat + init so every fixture,
# INCLUDING the off-diagonal-zero one, can be compared here (unlike
# sklearn, which lacks a weight parameter and is skipped for that fixture).

suppressMessages(library(jsonlite))
suppressMessages(library(smacof))

args <- commandArgs(trailingOnly = TRUE)
fixtures_path <- args[1]
output_dir <- args[2]
dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

fixtures <- fromJSON(fixtures_path, simplifyVector = FALSE)

matrix_from_list <- function(lst) {
  n <- length(lst)
  m <- matrix(0, nrow = n, ncol = n)
  for (i in seq_len(n)) {
    row <- lst[[i]]
    for (j in seq_len(n)) {
      m[i, j] <- row[[j]]
    }
  }
  m
}

pairwise_distance <- function(coords) {
  as.matrix(dist(coords, method = "euclidean"))
}

results <- list()
skipped <- list()

for (key in names(fixtures$mds)) {
  fx <- fixtures$mds[[key]]
  dissimilarity <- matrix_from_list(fx$dissimilarity)
  weight <- matrix_from_list(fx$weight)
  init <- matrix_from_list(fx$initialCoordinates)

  fit <- tryCatch(
    {
      smacof::mds(
        delta = dissimilarity,
        type = "ordinal",
        ndim = fx$dimension,
        weightmat = weight,
        init = init,
        ties = "secondary",
        itmax = fx$maxIter,
        eps = fx$eps
      )
    },
    error = function(e) {
      list(.error = conditionMessage(e))
    }
  )

  if (!is.null(fit$.error)) {
    skipped[[key]] <- paste("smacof::mds() call failed:", fit$.error)
    next
  }

  coords <- fit$conf
  distance <- pairwise_distance(coords)

  results[[key]] <- list(
    coordinates = unname(as.list(as.data.frame(t(coords)))),
    pairwiseDistance = lapply(seq_len(nrow(distance)), function(i) as.list(distance[i, ])),
    rStress = fit$stress,
    # smacof package's own stress value; document its exact definition
    # relative to our normalizedStress1 in the comparison step rather than
    # assuming equivalence.
    niter = fit$niter,
    tiesMethodUsed = "secondary"
  )
}

write(toJSON(list(results = results, skipped = skipped), auto_unbox = TRUE, digits = 15), file.path(output_dir, "r-smacof-results.json"))

# ---- Ward via base R ----
ward_points <- matrix_from_list(fixtures$ward$tieFree$points)
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
