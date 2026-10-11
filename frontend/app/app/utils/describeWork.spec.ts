import { describe, expect, it } from 'vitest'
import { DERIVED_TITLE_MAX, splitDescribedWork } from '~/utils/describeWork'

describe('splitDescribedWork', () => {
  it('uses one short sentence as the title and adds no description', () => {
    expect(splitDescribedWork('  Fix the login redirect  ')).toEqual({
      title: 'Fix the login redirect',
    })
  })

  it('titles with the first sentence and keeps the WHOLE text as the description', () => {
    const text = 'Add an audit log. Record each sign-in with the time and the user.'
    expect(splitDescribedWork(text)).toEqual({ title: 'Add an audit log', description: text })
  })

  it('reads only the first line for the title', () => {
    const text = 'Rate limit per API key\nUse a token bucket. 100 requests a minute.'
    expect(splitDescribedWork(text)).toEqual({ title: 'Rate limit per API key', description: text })
  })

  it('shortens a long first sentence at a word boundary, with an ellipsis', () => {
    const words = 'word '.repeat(40).trim()
    const { title, description } = splitDescribedWork(words)
    expect(title.length).toBeLessThanOrEqual(DERIVED_TITLE_MAX)
    expect(title.endsWith('word…')).toBe(true)
    expect(description).toBe(words)
  })

  it('does not cut a dotted name such as a file or a version', () => {
    expect(splitDescribedWork('Bump vite to 7.1 in package.json').title).toBe(
      'Bump vite to 7.1 in package.json',
    )
  })

  it('does not end a sentence at a common abbreviation', () => {
    const text = 'Fix e.g. the login redirect loop. It happens on Safari.'
    expect(splitDescribedWork(text)).toEqual({
      title: 'Fix e.g. the login redirect loop',
      description: text,
    })
    expect(splitDescribedWork('Ask Dr. Smith about the export. She owns it.').title).toBe(
      'Ask Dr. Smith about the export',
    )
  })

  it('treats a run of dots as one mark', () => {
    expect(splitDescribedWork('Fix this... later, after the release.').title).toBe('Fix this')
    expect(splitDescribedWork('Use a cache, e.g. Redis, for sessions.').title).toBe(
      'Use a cache, e.g. Redis, for sessions',
    )
  })

  it('ends a sentence at a full-width mark, with or without a space after it', () => {
    const text = '修复登录重定向。记录每次登录。'
    expect(splitDescribedWork(text)).toEqual({ title: '修复登录重定向', description: text })
  })

  it('keeps a question or an exclamation mark, and drops a period', () => {
    expect(splitDescribedWork('Why does login fail?')).toEqual({ title: 'Why does login fail?' })
    // A final period says nothing the title does not, so it adds no description.
    expect(splitDescribedWork('Fix the login redirect.')).toEqual({
      title: 'Fix the login redirect',
    })
  })

  it('never cuts an emoji in half when it shortens', () => {
    const text = `${'a'.repeat(DERIVED_TITLE_MAX - 2)}😀😀😀 more words after it`
    const { title } = splitDescribedWork(text)
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(Array.from(title).length).toBeLessThanOrEqual(DERIVED_TITLE_MAX)
  })

  it('returns an empty title for blank input, so the dialog cannot submit it', () => {
    expect(splitDescribedWork('   \n ')).toEqual({ title: '' })
  })
})
