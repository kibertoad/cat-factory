import type { Clock, IdGenerator } from '@cat-factory/kernel'

// Production implementations of the ambient runtime ports, backed by the Web
// Crypto API available in the Workers runtime.

export class CryptoIdGenerator implements IdGenerator {
  next(prefix = 'id'): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}
