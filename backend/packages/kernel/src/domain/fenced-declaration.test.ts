import { describe, expect, it } from 'vitest'
import { extractFencedDeclaration } from './fenced-declaration.js'

describe('extractFencedDeclaration', () => {
  it('returns null for no output and for a reply carrying no such block', () => {
    // Null is what every caller turns into its own "the agent never answered" state, which must
    // stay distinct from an empty block ("the agent answered: nothing").
    expect(extractFencedDeclaration(undefined, 'binary-outputs')).toBeNull()
    expect(extractFencedDeclaration('I stored three images.', 'binary-outputs')).toBeNull()
    expect(extractFencedDeclaration('```other\nbody\n```', 'binary-outputs')).toBeNull()
  })

  it('reads the block body, trimmed', () => {
    expect(extractFencedDeclaration('before\n```tag\n  body  \n```\nafter', 'tag')).toBe('body')
  })

  it('distinguishes an EMPTY block from an absent one', () => {
    expect(extractFencedDeclaration('```tag\n```', 'tag')).toBe('')
  })

  it('takes the LAST block, so an illustrated example never beats the real answer', () => {
    // The failure this prevents: a model restates the instruction ("I will finish with:") and
    // shows an empty or placeholder block before doing the work. Parsing the first one reports a
    // confident wrong answer — "declared none" — which is strictly worse than no answer.
    const reply = [
      'I will finish with a block like:',
      '```tag',
      'none',
      '```',
      'Now the work is done.',
      '```tag',
      'real-answer',
      '```',
    ].join('\n')
    expect(extractFencedDeclaration(reply, 'tag')).toBe('real-answer')
  })

  it('does not treat a prose mention of the fence as an opening one', () => {
    // The tag must end its line. Without that, "end with a ```tag block, listing ids" opens a
    // fence whose body runs to whatever backticks appear next.
    expect(extractFencedDeclaration('end with a ```tag block listing ids', 'tag')).toBeNull()
  })

  it('tolerates CRLF and trailing spaces on the fence line', () => {
    expect(extractFencedDeclaration('```tag  \r\nbody\r\n```', 'tag')).toBe('body')
  })

  it('matches the tag case-insensitively, as models capitalise', () => {
    expect(extractFencedDeclaration('```TAG\nbody\n```', 'tag')).toBe('body')
  })

  it('escapes regex metacharacters in the tag rather than letting them reshape the pattern', () => {
    // Our own tags are kebab slugs, but this is an exported seam.
    expect(extractFencedDeclaration('```a.c\nbody\n```', 'a.c')).toBe('body')
    expect(extractFencedDeclaration('```abc\nbody\n```', 'a.c')).toBeNull()
  })
})
