import type { Clock, IdGenerator } from '@cat-factory/kernel'

/** Wall-clock time source. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}

/** Prefixed, collision-resistant ids (`blk_<uuid-ish>`), built on Web Crypto. */
export class CryptoIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
  }
}
