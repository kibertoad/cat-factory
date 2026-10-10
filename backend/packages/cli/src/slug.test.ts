import { describe, expect, it } from 'vitest'
import { pagesProjectName, slugifyProjectName } from './slug.js'

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

describe('pagesProjectName', () => {
  it('keeps a slug Pages already accepts', () => {
    expect(pagesProjectName('my-cats')).toBe('my-cats-frontend')
  })

  it('drops the npm characters `wrangler pages deploy` refuses', () => {
    // Pages takes lowercase letters, digits and hyphens only, so these valid npm names would
    // otherwise ship a deploy target that fails on the project name.
    expect(pagesProjectName('acme.site')).toBe('acme-site-frontend')
    expect(pagesProjectName('my_app')).toBe('my-app-frontend')
    expect(pagesProjectName('a.b_c.d')).toBe('a-b-c-d-frontend')
  })

  it('emits a name Pages accepts for every slug slugifyProjectName can produce', () => {
    for (const raw of [
      'My Cats',
      ' Todo List ',
      'ACME Site',
      'acme.site',
      '.__Acme..Site__',
      'my_app',
      '!!!',
      'x',
    ]) {
      // Cloudflare's own rule for a Pages project name.
      expect(pagesProjectName(slugifyProjectName(raw))).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    }
  })
})
