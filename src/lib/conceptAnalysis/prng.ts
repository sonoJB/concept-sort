/**
 * Deterministic seeded PRNG. `Math.random()` is never used anywhere in this
 * module tree — every source of randomness flows through here so identical
 * seed + identical inputs reproduce identical output, independent of
 * platform, Node version, or call order elsewhere in the process.
 *
 * Algorithm: mulberry32 (public-domain, attributed to Tommy Ettinger),
 * a 32-bit state generator chosen for being small, well-known, and easy to
 * hand-verify — not a cryptographic RNG, which is not a requirement here.
 */

export type Prng = () => number; // returns a float in [0, 1)

export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically derives a per-init seed from a base seed + init index
 * (splitmix-style mixing), so `nInit` independent-looking streams can be
 * reconstructed from (randomSeed, initIndex) alone without storing an array
 * of seeds.
 */
export function deriveSeed(baseSeed: number, index: number): number {
  let h = (baseSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** Uniform float in [lo, hi) using the given generator. */
export function uniform(rng: Prng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}
