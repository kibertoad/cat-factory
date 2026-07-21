import { describe, expect, it } from 'vitest'
import { composeBlockSystemPrompt } from './fragments.js'

// Best-practice standards are folded into the system prompt as SEPARATE, delimited, title-labelled
// `<best-practice-standard>` blocks (not one `\n\n`-joined blob), so an agent can tell them apart and
// cite one by title — what the code/PR reviewers' adherence report relies on.

describe('composeBlockSystemPrompt', () => {
  it('returns the base prompt unchanged when no fragments are resolved', () => {
    expect(composeBlockSystemPrompt('BASE', { resolvedFragments: [] })).toBe('BASE')
    expect(composeBlockSystemPrompt('BASE', {})).toBe('BASE')
  })

  it('wraps each standard in its own delimited, id + title labelled block', () => {
    const out = composeBlockSystemPrompt('BASE', {
      resolvedFragments: [
        { id: 'be-errors', title: 'Backend error handling', body: 'Wrap errors with context.' },
        { id: 'api-docs', title: 'Concise API docs', body: 'Document every export.' },
      ],
    })
    expect(out).toContain('BASE')
    expect(out).toContain('<best-practice-standard id="be-errors" title="Backend error handling">')
    expect(out).toContain('Wrap errors with context.')
    expect(out).toContain('</best-practice-standard>')
    expect(out).toContain('<best-practice-standard id="api-docs" title="Concise API docs">')
    // Two separate blocks, not a single joined blob.
    expect(out.match(/<best-practice-standard /g)).toHaveLength(2)
    expect(out.match(/<\/best-practice-standard>/g)).toHaveLength(2)
  })

  it('falls back to the id as the label when a fragment has no title', () => {
    const out = composeBlockSystemPrompt('BASE', {
      resolvedFragments: [{ id: 'legacy-frag', body: 'Do the thing.' }],
    })
    expect(out).toContain('<best-practice-standard id="legacy-frag" title="legacy-frag">')
  })

  it('neutralises characters that would break the delimiter tag', () => {
    const out = composeBlockSystemPrompt('BASE', {
      resolvedFragments: [{ id: 'x', title: 'He said "quote" <b> &\nnext line', body: 'body' }],
    })
    // The title's own quotes/angle-brackets are neutralised to apostrophes and the newline is
    // collapsed, so the whole standard opens on a single well-formed tag line.
    const tag = out.split('\n').find((l) => l.startsWith('<best-practice-standard'))!
    expect(tag).toBe(`<best-practice-standard id="x" title="He said 'quote' 'b' & next line">`)
  })
})
