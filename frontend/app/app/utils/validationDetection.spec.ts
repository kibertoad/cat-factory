import { describe, expect, it } from 'vitest'
import { mergeDetectedChecks } from './validationDetection'

const check = (label: string, command: string) => ({ label, command })

describe('mergeDetectedChecks', () => {
  it('appends suggestions to an empty (or blank-row) panel', () => {
    const result = mergeDetectedChecks(
      [check('', '')],
      [check('install', 'pnpm install --frozen-lockfile'), check('lint', 'pnpm run lint')],
      10,
    )
    expect(result.rows).toEqual([
      check('install', 'pnpm install --frozen-lockfile'),
      check('lint', 'pnpm run lint'),
    ])
    expect(result.added).toBe(2)
    expect(result.dropped).toBe(0)
  })

  it('never rewrites or duplicates what the operator already has', () => {
    // The same command with a hand-tuned label must survive untouched, and pressing Detect
    // again must be a no-op rather than a second copy of every check.
    const existing = [check('our lint', 'pnpm run lint')]
    const result = mergeDetectedChecks(existing, [check('lint', 'pnpm run lint')], 10)
    expect(result.rows).toEqual(existing)
    expect(result.added).toBe(0)
  })

  it('disambiguates a label that collides with an existing row', () => {
    // A duplicate label is REJECTED by the write contract, so a collision the merge created
    // would surface as a save error on a row the operator never typed.
    const result = mergeDetectedChecks(
      [check('test', 'make test')],
      [check('test', 'go test ./...')],
      10,
    )
    expect(result.rows.map((r) => r.label)).toEqual(['test', 'test 2'])
  })

  it('reports what the row cap dropped instead of silently truncating', () => {
    const result = mergeDetectedChecks(
      [check('lint', 'pnpm run lint')],
      [check('test', 'pnpm run test'), check('build', 'pnpm run build')],
      2,
    )
    expect(result.rows).toHaveLength(2)
    expect(result.added).toBe(1)
    expect(result.dropped).toBe(1)
  })
})
