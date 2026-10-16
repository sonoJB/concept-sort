import type { NextConfig } from "next";
import { execSync } from "node:child_process";

/**
 * The deployed commit, embedded at build time so generated files (e.g. the
 * official-matrix workbooks) can record exactly which code produced them.
 * Falls back to `git` when building from a checkout, then to "unknown".
 */
function resolveBuildCommit(): string {
  const fromEnv = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  env: {
    APP_BUILD_COMMIT: resolveBuildCommit(),
  },
};

export default nextConfig;
