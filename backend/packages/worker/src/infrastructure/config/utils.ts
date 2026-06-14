import type { Env } from '../env'

// Shared parsing helpers for translating the flat, string-typed Worker
// environment into structured config.

export function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Parse a non-negative retention-day var into ms, falling back to `defaultDays`. */
export function retentionMs(raw: string | undefined, defaultDays: number): number {
  const days = num(raw)
  return (days !== undefined && days >= 0 ? days : defaultDays) * DAY_MS
}

/**
 * A model's direct flavour activates when its API key env var is present and
 * non-empty. Keys are looked up by name (from the catalog's `keyEnv`).
 */
export function directKeyAvailable(env: Env): (keyEnv: string) => boolean {
  const bag = env as unknown as Record<string, string | undefined>
  return (keyEnv) => {
    const value = bag[keyEnv]
    return typeof value === 'string' && value.trim() !== ''
  }
}
