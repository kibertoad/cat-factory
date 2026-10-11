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

  it('returns an empty title for blank input, so the dialog cannot submit it', () => {
    expect(splitDescribedWork('   \n ')).toEqual({ title: '' })
  })
})
