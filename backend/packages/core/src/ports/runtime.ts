// Ambient runtime ports. Injected rather than imported so the domain stays
// deterministic under test: a counting IdGenerator makes ids reproducible, and a
// fixed Clock removes wall-clock flakiness.

/** Produces unique ids (e.g. `blk_a1b2c3`). */
export interface IdGenerator {
  next(prefix?: string): string
}

/** Wall-clock access. */
export interface Clock {
  now(): number
}
