import { describe, expect, it } from 'vitest'
import { slugifyProjectName } from './slug.js'

describe('slugifyProjectName', () => {
  it('leaves an already-valid slug unchanged', () => {
    expect(slugifyProjectName('my-cats')).toBe('my-cats')
  })

  it('lowercases and replaces spaces/invalid chars with hyphens', () => {
    expect(slugifyProjectName('My Cats')).toBe('my-cats')
    expect(slugifyProjectName('Cat Factory!!')).toBe('cat-factory')
  })

  it('collapses repeats and strips leading/trailing separators and leading dot/underscore', () => {
    expect(slugifyProjectName('  __Hello   World__  ')).toBe('hello-world')
    expect(slugifyProjectName('.hidden')).toBe('hidden')
  })

  it('falls back when nothing usable remains', () => {
    expect(slugifyProjectName('   ')).toBe('cat-factory')
    expect(slugifyProjectName('!!!', 'fallback')).toBe('fallback')
  })
})
