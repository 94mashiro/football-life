/**
 * Deterministic RNG — FNV-1a hash + xorshift32 step.
 *
 * Ported from the target game's engine so the whole sim is reproducible from a
 * single seed string. State is a plain mutable number box; we mutate it in
 * place rather than allocating {rng,value} tuples on every draw, which matters
 * because a single career draws tens of thousands of times.
 *
 * The string-seed namespace pattern (ln) is the key idea: each logical event
 * derives its own seed via `hash("seed:tag1:tag2")`, giving independent but
 * reproducible streams that never collide.
 */

export interface RngState {
  /** FNV-1a hash of the seed string; stepped by xorshift32. Never 0. */
  s: number;
}

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a 32-bit hash of a string → nonzero uint32. */
export function hash(str: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  // >>> 0 coerces to uint32; || 1 guarantees nonzero (0 state would freeze xorshift)
  return h >>> 0 || 1;
}

/** Create an RngState from a seed string. */
export function create(seed: string): RngState {
  return { s: hash(seed) };
}

/** One xorshift32 step → {state, value in [0,1)}. Mutates `state` in place. */
export function next(state: RngState): number {
  let t = state.s;
  t ^= t << 13;
  t ^= t >>> 17;
  t ^= t << 5;
  const n = t >>> 0 || 1;
  state.s = n;
  return n / 4294967296;
}

/** Uniform float in [min, max). */
export function float(state: RngState, min: number, max: number): number {
  return min + next(state) * (max - min);
}

/** Uniform integer in [min, max] inclusive. */
export function int(state: RngState, min: number, max: number): number {
  return Math.floor(next(state) * (max - min + 1)) + min;
}

/** Bernoulli trial: true with probability p (clamped to [0,1]). */
export function chance(state: RngState, p: number): boolean {
  return next(state) < clamp01(p);
}

/** Pick a random element of an array. Returns undefined if empty. */
export function pick<T>(state: RngState, arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[int(state, 0, arr.length - 1)]!;
}

/** Weighted pick. items: [{item, weight}]. Returns the chosen item, or undefined if total weight <= 0. */
export function weighted<T>(
  state: RngState,
  items: ReadonlyArray<readonly [T, number]>,
): T | undefined {
  let total = 0;
  for (const [, w] of items) if (w > 0) total += w;
  if (total <= 0) return undefined;
  let r = float(state, 0, total);
  for (const [item, w] of items) {
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1]?.[0];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Derive a namespaced sub-seed: hash("base:tag1:tag2"). Used so each logical
 * event draws from an independent, reproducible stream. The returned state is
 * fresh (does not share mutation with the caller's state).
 */
export function derive(base: string, ...tags: ReadonlyArray<string | number>): RngState {
  return create(`${base}:${tags.join(":")}`);
}
