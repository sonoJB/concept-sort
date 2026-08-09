import { createHash } from "node:crypto";

/**
 * Deterministic JSON canonicalization: object keys sorted, array order
 * preserved (arrays are semantically ordered), `null` stays `null` (never
 * coerced to a sentinel string), `undefined` is rejected rather than
 * silently dropped, and non-finite numbers are rejected outright — a value
 * this couldn't faithfully round-trip must never silently enter a hash.
 *
 * -0 is canonicalized to 0 so two computations that differ only in float
 * sign-of-zero don't produce different hashes for what is semantically the
 * same value.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) {
    throw new TypeError("canonicalize: undefined is not allowed (use null explicitly)");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalize: non-finite number not allowed (${value})`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  throw new TypeError(`canonicalize: unsupported value type (${typeof value})`);
}

/** Canonical JSON text — deterministic regardless of input key/insertion order. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Convenience: canonicalize + stringify + hash in one call. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJsonStringify(value));
}
