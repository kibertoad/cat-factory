// Ambient runtime ports. Injected rather than imported so the domain stays
// deterministic under test: a seeded Rng and a counting IdGenerator make the
// whole simulation reproducible, and a fixed Clock removes wall-clock flakiness.

/** Produces unique ids (e.g. `blk_a1b2c3`). */
export interface IdGenerator {
  next(prefix?: string): string
}

/** A 0..1 random source. */
export interface Rng {
  next(): number
}

/** Wall-clock access. */
export interface Clock {
  now(): number
}
