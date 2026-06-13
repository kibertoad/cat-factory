import type { Clock, IdGenerator, Rng } from '@cat-factory/core'

// Production implementations of the ambient runtime ports, backed by the Web
// Crypto API available in the Workers runtime.

export class CryptoIdGenerator implements IdGenerator {
  next(prefix = 'id'): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  }
}

export class CryptoRng implements Rng {
  next(): number {
    return crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000
  }
}

/**
 * Deterministic RNG (mulberry32). Wired in when `RNG_SEED` is set, making the
 * simulation — decision timing, confidence rolls — fully reproducible in tests.
 */
export class SeededRng implements Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}
