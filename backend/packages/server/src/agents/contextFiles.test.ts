import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { buildContextFiles } from './contextFiles.js'

// Coverage for the linked-context materialiser (extracted from ContainerAgentExecutor). The
// load-bearing invariants: the prompt index (`contextDocs`/`contextTasks` returned) stays in
// lock-step with the files actually written, filenames never collide, and the byte budget
// drops overflow items from BOTH the files and the index together.

type ContextDoc = NonNullable<AgentRunContext['block']['contextDocs']>[number]

function doc(over: Partial<ContextDoc> = {}): ContextDoc {
  return {
    title: 'Design Doc',
    url: 'https://docs.example/design',
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
    expect(out.contextDocs).toEqual([])
    expect(out.contextTasks).toEqual([])
  })

  it('materialises a doc with a title + source header and keeps it in the index', () => {
    const out = buildContextFiles(ctx({ contextDocs: [doc()] }))
    expect(out.files).toHaveLength(1)
    expect(out.files[0]?.path).toBe('design-doc.md')
    expect(out.files[0]?.content).toBe(
      '# Design Doc\nSource: https://docs.example/design\n\nthe full body',
    )
    // The prompt index reports exactly the doc that was written.
    expect(out.contextDocs).toHaveLength(1)
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

  it('drops an over-budget doc from BOTH the files and the prompt index (lock-step)', () => {
    // 262_144 is the byte budget; a body past it can't fit once the header is added.
    const huge = 'x'.repeat(262_144)
    const out = buildContextFiles(
      ctx({
        contextDocs: [doc({ title: 'Small', body: 'tiny' }), doc({ title: 'Huge', body: huge })],
      }),
    )
    // Only the small doc is materialised, and the index reports only what's on disk.
    expect(out.files.map((f) => f.path)).toEqual(['small.md'])
    expect(out.contextDocs.map((d) => d.title)).toEqual(['Small'])
  })
})
