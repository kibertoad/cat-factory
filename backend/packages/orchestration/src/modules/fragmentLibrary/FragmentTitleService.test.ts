import { describe, expect, it } from 'vitest'
import { cleanTitle } from './FragmentTitleService.js'

// `cleanTitle` normalises the title generator's reply into a usable one-line title. The prompt
// asks for a bare line, but a reasoning model can wrap it in quotes, prefix "Title:", add trailing
// punctuation, or emit leading blank/thinking lines — all of which must be stripped.

describe('cleanTitle', () => {
  it('returns a clean single-line title unchanged', () => {
    expect(cleanTitle('Backend error handling')).toBe('Backend error handling')
  })

  it('takes the first non-empty line', () => {
    expect(cleanTitle('\n\n  React state management \nsome trailing rambling')).toBe(
      'React state management',
    )
  })

  it('strips wrapping quotes and backticks', () => {
    expect(cleanTitle('"Concise API docs"')).toBe('Concise API docs')
    expect(cleanTitle('`Concise API docs`')).toBe('Concise API docs')
    expect(cleanTitle("'Concise API docs'")).toBe('Concise API docs')
  })

  it('strips a leading Title: / Title - label (case-insensitive)', () => {
    expect(cleanTitle('Title: Backend error handling')).toBe('Backend error handling')
    expect(cleanTitle('title - Backend error handling')).toBe('Backend error handling')
  })

  it('strips trailing punctuation/whitespace', () => {
    expect(cleanTitle('Backend error handling.')).toBe('Backend error handling')
    expect(cleanTitle('Backend error handling...  ')).toBe('Backend error handling')
  })

  it('returns an empty string for blank input', () => {
    expect(cleanTitle('')).toBe('')
    expect(cleanTitle('\n   \n')).toBe('')
  })

  it('clamps to 200 characters', () => {
    expect(cleanTitle('x'.repeat(500)).length).toBe(200)
  })
})
