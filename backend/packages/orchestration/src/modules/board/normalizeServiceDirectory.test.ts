import { describe, expect, it } from 'vitest'
import { ValidationError } from '@cat-factory/kernel'
import { normalizeServiceDirectory } from './BoardService.js'

// The monorepo service subdirectory is stored on the service and later becomes an
// agent's cwd, so it must be coerced to a safe relative path before persistence (the
// harness re-enforces the same — this is the board-layer half of that defence).
describe('normalizeServiceDirectory', () => {
  it('returns undefined for absent/empty/blank input', () => {
    expect(normalizeServiceDirectory(undefined)).toBeUndefined()
    expect(normalizeServiceDirectory('')).toBeUndefined()
    expect(normalizeServiceDirectory('   ')).toBeUndefined()
    expect(normalizeServiceDirectory('/')).toBeUndefined()
    expect(normalizeServiceDirectory('./')).toBeUndefined()
  })

  it('normalises separators and strips leading/trailing slashes and `.` segments', () => {
    expect(normalizeServiceDirectory('/packages/api/')).toBe('packages/api')
    expect(normalizeServiceDirectory('packages\\api')).toBe('packages/api')
    expect(normalizeServiceDirectory('  packages/./api  ')).toBe('packages/api')
  })

  it('rejects a path that escapes the checkout', () => {
    expect(() => normalizeServiceDirectory('../secrets')).toThrow(ValidationError)
    expect(() => normalizeServiceDirectory('packages/../../etc')).toThrow(ValidationError)
  })
})
