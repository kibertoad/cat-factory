import type { AgentRunContext } from '@cat-factory/kernel'
import { CONTEXT_DOCUMENTS_OVER_BUDGET, ValidationError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { buildContextFiles } from './contextFiles.js'

// Coverage for the linked-context materialiser (extracted from ContainerAgentExecutor). The
// load-bearing invariants: every linked item reaches the checkout, filenames never collide, and a
// corpus that overflows the byte budget REFUSES the dispatch naming what didn't fit — rather than
// materialising a prefix and leaving the agent (and the human) unable to tell it was partial.

type ContextDoc = NonNullable<AgentRunContext['block']['contextDocs']>[number]

function doc(over: Partial<ContextDoc> = {}): ContextDoc {
  return {
    title: 'Design Doc',
    url: 'https://docs.example/design',
    origin: 'confluence',
    excerpt: 'excerpt',
    summary: 'summary',
    body: 'the full body',
    ...over,
  }
}

/** A minimal AgentRunContext exposing only what buildContextFiles reads (the block's links). */
function ctx(block: Partial<AgentRunContext['block']>): AgentRunContext {
  return { block } as unknown as AgentRunContext
}

describe('buildContextFiles', () => {
  it('returns empty results when the block has no linked docs or tasks', () => {
    const out = buildContextFiles(ctx({}))
    expect(out.files).toEqual([])
  })

  it('materialises a doc with a title + source header', () => {
    const out = buildContextFiles(ctx({ contextDocs: [doc()] }))
    expect(out.files).toHaveLength(1)
    expect(out.files[0]?.path).toBe('design-doc.md')
    expect(out.files[0]?.content).toBe(
      '# Design Doc\nSource: https://docs.example/design\n\nthe full body',
    )
  })

  it('records the revision a confirmed document was built against', () => {
    const out = buildContextFiles(
      ctx({
        contextDocs: [
          doc({ freshness: { status: 'confirmed', version: '2317456', change: 'reimported' } }),
        ],
      }),
    )

    // Between the origin line and the body, so "which revision of the design did this run read"
    // is answerable from the checkout the agent worked in.
    expect(out.files[0]?.content).toBe(
      '# Design Doc\nSource: https://docs.example/design\nRevision: 2317456\n\nthe full body',
    )
  })

  it('warns in the file itself when the copy could not be confirmed', () => {
    const out = buildContextFiles(
      ctx({
        contextDocs: [doc({ freshness: { status: 'unconfirmed', reason: 'source_unreachable' } })],
      }),
    )

    // An agent handed a design has no other way to learn the copy might trail the live file, and an
    // omitted note reads exactly like a copy that WAS checked.
    expect(out.files[0]?.content).toContain('NOT confirmed against the source')
    expect(out.files[0]?.content).toContain('could not be reached')
  })

  it('is byte-for-byte unchanged for a document with no freshness verdict', () => {
    // The un-wired path: a deployment that does not refresh must not gain a header, and an `upload`
    // (nothing to be stale relative to) must not gain a warning.
    const none = buildContextFiles(ctx({ contextDocs: [doc()] }))
    const notApplicable = buildContextFiles(
      ctx({ contextDocs: [doc({ freshness: { status: 'not-applicable' } })] }),
    )

    expect(notApplicable.files[0]?.content).toBe(none.files[0]?.content)
    expect(none.files[0]?.content).not.toContain('Revision:')
  })

  it('falls back to the excerpt when a doc has no body', () => {
    const out = buildContextFiles(
      ctx({ contextDocs: [doc({ body: '', excerpt: 'only-excerpt' })] }),
    )
    expect(out.files[0]?.content).toContain('only-excerpt')
  })

  it('gives same-titled docs distinct, collision-free filenames', () => {
    const out = buildContextFiles(
      ctx({ contextDocs: [doc({ title: 'Spec' }), doc({ title: 'Spec' })] }),
    )
    expect(out.files.map((f) => f.path)).toEqual(['spec.md', 'spec-2.md'])
  })

  it('refuses the dispatch when the corpus overflows the byte budget, naming what did not fit', () => {
    // 262_144 is the byte budget; a body past it can't fit once the header is added.
    const huge = 'x'.repeat(262_144)
    const build = () =>
      buildContextFiles(
        ctx({
          contextDocs: [doc({ title: 'Small', body: 'tiny' }), doc({ title: 'Huge', body: huge })],
        }),
      )
    // The overflow item is NAMED (a human has to decide what to detach), with a machine-readable
    // cause so the dispatch classifies as a `preflight` rejection rather than a container blip.
    expect(build).toThrow(/"Huge"/)
    expect(build).toThrow(/256 KB/)
    try {
      build()
      expect.unreachable('an over-budget corpus must refuse the dispatch')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).details?.reason).toBe(CONTEXT_DOCUMENTS_OVER_BUDGET)
    }
  })

  it('materialises a corpus that fits, tracker issues included', () => {
    const out = buildContextFiles(
      ctx({
        contextDocs: [doc({ title: 'PRD' })],
        contextTasks: [
          {
            key: 'PROJ-7',
            url: 'https://tracker/PROJ-7',
            title: 'CSV export',
            status: 'Open',
            type: 'Story',
            assignee: null,
            priority: null,
            labels: [],
            description: 'Customers want CSV.',
            comments: [],
            summary: 'Customers want CSV.',
          },
        ],
      }),
    )
    expect(out.files.map((f) => f.path)).toEqual(['prd.md', 'proj-7.md'])
  })
})
