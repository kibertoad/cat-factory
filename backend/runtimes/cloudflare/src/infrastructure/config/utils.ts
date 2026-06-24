// Shared parsing helpers for translating the flat, string-typed Worker
// environment into structured config.

export function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

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
export function retentionMs(raw: string | undefined, defaultDays: number): number {
  const days = num(raw)
  return (days !== undefined && days >= 0 ? days : defaultDays) * DAY_MS
}
