import { MAX_TASK_DESCRIPTION_CHARS, MAX_UPLOADED_DOCUMENT_CHARS } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { briefFields } from './brief.js'

// The branch exists because getting it wrong costs an afternoon of SETUP rather than a test run: a
// scaffold brief goes past the description cap, the route answers 422, and the operator has by then
// minted a key, created a repository and wired a workspace. So what is pinned is that a short brief
// is byte-for-byte the prior behaviour, a long one becomes the attachment the surface documents, and
// nothing is ever silently shortened.

const long = (chars: number) =>
  `${'Ship the thing. '.repeat(Math.ceil(chars / 16))}`.slice(0, chars)

describe('briefFields', () => {
  it('leaves a brief that FITS exactly as it was, with no attachment and no note', () => {
    // The property that makes it safe to put on the shared path: every suite whose briefs are short
    // sees no change at all.
    expect(briefFields({ brief: '  Add a health endpoint.  ', title: 'Health' })).toEqual({
      description: 'Add a health endpoint.',
    })
  })

  it('attaches a brief past the cap and points the description at it', () => {
    const brief = long(MAX_TASK_DESCRIPTION_CHARS + 1)
    const fields = briefFields({ brief, title: 'Stand up the catalog API' })

    expect(fields.documents).toEqual([
      { kind: 'upload', title: 'Stand up the catalog API', content: brief },
    ])
    // The description is what every agent reads first, so it may not stop mid-thought with no
    // pointer: it always ends by naming the attachment.
    expect(fields.description).toContain("attached as 'Stand up the catalog API'")
    expect(fields.description.length).toBeLessThanOrEqual(MAX_TASK_DESCRIPTION_CHARS)
  })

  it('MARKS a derived opening that had to be cut, so it cannot read as the whole ask', () => {
    const brief = `${long(MAX_TASK_DESCRIPTION_CHARS + 500)}`
    const fields = briefFields({ brief, title: 'Scaffold' })
    expect(fields.description).toContain('…')
  })

  it('uses a supplied summary verbatim rather than deriving one', () => {
    const fields = briefFields({
      brief: long(MAX_TASK_DESCRIPTION_CHARS + 1),
      title: 'Scaffold',
      summary: 'Stand up a Fastify glossary API that Kargo can provision.',
    })
    expect(fields.description).toBe(
      "Stand up a Fastify glossary API that Kargo can provision.\n\nThe full brief is attached as 'Scaffold'.",
    )
  })

  it('REFUSES a summary that cannot fit beside the pointer rather than shortening it', () => {
    // A caller's own words are the one thing here that may not be silently rewritten.
    expect(() =>
      briefFields({
        brief: long(MAX_TASK_DESCRIPTION_CHARS + 1),
        title: 'Scaffold',
        summary: long(MAX_TASK_DESCRIPTION_CHARS),
      }),
    ).toThrow(/Shorten it/)
  })

  it('REFUSES a brief past the attachment cap rather than truncating it', () => {
    // A run against a brief missing its tail looks exactly like a run against the whole of it, and
    // no assertion on the result can tell that apart from a model that ignored the tail.
    expect(() =>
      briefFields({ brief: long(MAX_UPLOADED_DOCUMENT_CHARS + 1), title: 'Scaffold' }),
    ).toThrow(/Refusing rather than\s+truncating/)
  })

  it('refuses an empty brief and an untitled attachment', () => {
    expect(() => briefFields({ brief: '   ', title: 'Scaffold' })).toThrow(/describes no work/)
    expect(() => briefFields({ brief: long(MAX_TASK_DESCRIPTION_CHARS + 1), title: '  ' })).toThrow(
      /needs a title/,
    )
  })
})
