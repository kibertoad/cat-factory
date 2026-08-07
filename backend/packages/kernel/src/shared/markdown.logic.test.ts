import { describe, expect, it } from 'vitest'
import { buildExcerpt, estimateTokens, markdownToText } from './markdown.logic.js'

// What an external body (a Jira description, a Confluence page) collapses to before it is shown
// in a list or folded into a prompt. It is a lossy projection on purpose, so what matters is
// which markers disappear and which TEXT survives.

describe('markdownToText', () => {
  it('drops the markers and keeps the words', () => {
    expect(markdownToText('# Heading')).toBe('Heading')
    expect(markdownToText('## Sub heading')).toBe('Sub heading')
    expect(markdownToText('- one\n- two')).toBe('one two')
    expect(markdownToText('* star\n+ plus')).toBe('star plus')
    expect(markdownToText('**bold** and _italic_ and ~struck~')).toBe('bold and italic and struck')
    expect(markdownToText('> quoted')).toBe('quoted')
    expect(markdownToText('`code` and ```fenced```')).toBe('code and fenced')
  })

  it('keeps a link’s TEXT and drops its target', () => {
    expect(markdownToText('see [the docs](https://example.com/a_b) now')).toBe('see the docs now')
    // An empty label collapses to nothing rather than leaking the URL.
    expect(markdownToText('[](https://example.com)')).toBe('')
  })

  it('collapses every run of whitespace into one space, and trims the ends', () => {
    expect(markdownToText('  a\n\n\tb   c  ')).toBe('a b c')
  })

  it('leaves plain prose untouched', () => {
    expect(markdownToText('Just a sentence.')).toBe('Just a sentence.')
    expect(markdownToText('')).toBe('')
  })
})

describe('buildExcerpt', () => {
  it('returns the whole text when it is within the budget', () => {
    expect(buildExcerpt('# Short heading', 100)).toBe('Short heading')
    const exact = 'a'.repeat(10)
    expect(buildExcerpt(exact, 10)).toBe(exact)
  })

  it('truncates with an ellipsis, staying WITHIN the budget', () => {
    const excerpt = buildExcerpt('a'.repeat(50), 10)
    expect(excerpt).toBe(`${'a'.repeat(9)}…`)
    expect(excerpt.length).toBe(10)
  })

  it('does not leave a dangling space before the ellipsis', () => {
    expect(buildExcerpt('abcde fghij', 7)).toBe('abcde…')
  })

  it('measures the COLLAPSED text, not the markup', () => {
    // A body that is mostly markers is not a long body: truncating on the raw string would cut
    // an excerpt short for a sentence that fits comfortably.
    expect(buildExcerpt('**bold** ~text~', 12)).toBe('bold text')
  })
})

describe('estimateTokens', () => {
  it('approximates four characters per token, rounding UP', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('grows with the text, so a budget check can never shrink as context is added', () => {
    expect(estimateTokens('a'.repeat(100))).toBeLessThan(estimateTokens('a'.repeat(200)))
  })
})
