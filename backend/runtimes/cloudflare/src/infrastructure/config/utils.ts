// Shared parsing helpers for translating the flat, string-typed Worker
// environment into structured config.

import { parseNumericEnv } from '@cat-factory/server'

// Parse a numeric env var, warning when a present value is un-parseable rather than
// silently coercing garbage to the caller's default (error-message coverage A8). The
// message lives in the shared server layer so it reads identically on the Node facade.
export const num = parseNumericEnv

/** Parse a comma-separated var into a trimmed, non-empty list (empty when unset). */
export function csv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Parse a non-negative retention-day var into ms, falling back to `defaultDays`. */
export function retentionMs(name: string, raw: string | undefined, defaultDays: number): number {
  const days = num(name, raw)
  return (days !== undefined && days >= 0 ? days : defaultDays) * DAY_MS
}
