import { describe, expect, it } from 'vitest'
import type { AgentKind, AgentRunContext } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, userPromptFor } from '@cat-factory/agents'

const registry = defaultAgentKindRegistry()

// Regression guard: linked extra-context (documents + tracker issues) must reach
// EVERY agent step's user prompt — not only the generic roles. The four standard
// phases (architect/coder/reviewer/tester) render through a separate templated
// path, which historically dropped this context, so the implementer never saw
// the linked requirements / issues. See standard-prompts.ts#linkedContextSection.

function contextFor(agentKind: AgentKind): AgentRunContext {
  return {
    agentKind,
    pipelineName: 'build',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      id: 'task_1',
      title: 'Add CSV export',
      type: 'service',
      description: 'Let users export their data as CSV.',
      contextDocs: [
        {
          title: 'Export PRD',
          url: 'https://docs/export-prd',
          origin: 'confluence' as const,
          excerpt: 'Export must be UTF-8.',
          summary: 'Export must be UTF-8.',
          body: '# Export PRD\n\nExport must be UTF-8.',
        },
      ],
      contextTasks: [
        {
          key: 'PROJ-42',
          url: 'https://tracker/PROJ-42',
          title: 'Customers ask for CSV export',
          status: 'In Progress',
          type: 'Story',
          assignee: 'Ada',
          priority: 'High',
          labels: ['export'],
          description: 'Several enterprise customers requested CSV export.',
          comments: [{ author: 'Bob', createdAt: '2026-01-02T00:00:00Z', body: 'UTF-8 please.' }],
          summary: 'Several enterprise customers requested CSV export.',
        },
      ],
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
  }
}

describe('linked context in agent prompts', () => {
  // The standard phases are the code-producing ones; they matter most.
  for (const kind of ['architect', 'coder', 'reviewer', 'tester-api'] as AgentKind[]) {
    it(`includes linked docs and issues for the standard "${kind}" phase`, () => {
      const prompt = userPromptFor(contextFor(kind), registry)
      expect(prompt).toContain('Linked context documents')
      expect(prompt).toContain('Export PRD')
      expect(prompt).toContain('Export must be UTF-8.')
      expect(prompt).toContain('Linked tracker issues')
      expect(prompt).toContain('PROJ-42')
      expect(prompt).toContain('Several enterprise customers requested CSV export.')
    })
  }

  it('includes linked docs and issues for a generic agent kind', () => {
    const prompt = userPromptFor(contextFor('documenter' as AgentKind), registry)
    expect(prompt).toContain('Linked context documents')
    expect(prompt).toContain('Export PRD')
    expect(prompt).toContain('Linked tracker issues')
    expect(prompt).toContain('PROJ-42')
  })

  it('omits the sections entirely when nothing is linked', () => {
    const ctx = contextFor('coder' as AgentKind)
    delete ctx.block.contextDocs
    delete ctx.block.contextTasks
    const prompt = userPromptFor(ctx, registry)
    expect(prompt).not.toContain('Linked context documents')
    expect(prompt).not.toContain('Linked tracker issues')
  })

  // Container kinds get a summary index pointing at the on-disk files, NOT the bodies.
  it('renders a summary index pointing at .cat-context when materialized', () => {
    const prompt = userPromptFor(contextFor('coder' as AgentKind), registry, { materialized: true })
    expect(prompt).toContain('.cat-context/')
    expect(prompt).toContain('Export PRD')
    expect(prompt).toContain('[PROJ-42]')
    // The full body is NOT inlined in the materialized prompt (it lives on disk).
    expect(prompt).not.toContain('# Export PRD\n\nExport must be UTF-8.')
  })

  // Both budgets that can leave an item OUT of the prompt have to say so: an unmentioned
  // omission reads as "this is the complete set", which is how an agent works confidently
  // from context it never received.
  it('says how many materialized items the capped index leaves unlisted', () => {
    const ctx = contextFor('coder' as AgentKind)
    const one = ctx.block.contextDocs![0]!
    ctx.block.contextDocs = Array.from({ length: 24 }, (_, i) => ({
      ...one,
      title: `Doc ${i}`,
      url: `https://docs/${i}`,
    }))
    ctx.block.contextTasks = []
    const prompt = userPromptFor(ctx, registry, { materialized: true })
    // 24 items, 20 listed: the other 4 are on disk and the prompt says so.
    expect(prompt).toContain('…and 4 more not listed here')
    expect(prompt).toContain('Doc 19')
    expect(prompt).not.toContain('Doc 23')
  })

  it('names the linked documents an inline prompt had no budget left for', () => {
    const ctx = contextFor('reviewer' as AgentKind)
    const one = ctx.block.contextDocs![0]!
    // The first doc alone spends the whole inline body budget (2500 tokens ≈ 10k chars).
    ctx.block.contextDocs = [
      { ...one, title: 'Huge PRD', body: 'x'.repeat(40_000) },
      { ...one, title: 'Pricing addendum', url: 'https://docs/pricing' },
    ]
    const prompt = userPromptFor(ctx, registry)
    expect(prompt).toContain('did not fit')
    expect(prompt).toContain('Pricing addendum (https://docs/pricing)')
    expect(prompt).toContain('Treat what you were given as incomplete')
  })

  it('bounds the omission notice — it reports an overrun, so it must not cause one', () => {
    const ctx = contextFor('reviewer' as AgentKind)
    const one = ctx.block.contextDocs![0]!
    ctx.block.contextDocs = [
      { ...one, title: 'Huge PRD', body: 'x'.repeat(40_000) },
      ...Array.from({ length: 30 }, (_, i) => ({
        ...one,
        title: `Addendum ${i}`,
        url: `https://docs/addendum-${i}`,
      })),
    ]
    ctx.block.contextTasks = []
    const prompt = userPromptFor(ctx, registry)
    // All 30 are COUNTED, only the first few are named, and the rest are accounted for — naming
    // every one would append 30 titles and URLs to a prompt that just ran out of budget.
    expect(prompt).toContain('30 further linked documents did not fit')
    expect(prompt).toContain('Addendum 0 (https://docs/addendum-0)')
    expect(prompt).toContain('and 25 more')
    expect(prompt).not.toContain('Addendum 29')
  })

  // An INLINE kind has no `.cat-context/` file to read the freshness header from, so whatever the
  // refresh concluded has to travel in the prompt itself. Otherwise a judge, estimator or reviewer
  // receives an unconfirmed body indistinguishable from a checked one and scores against it.
  it('states an UNCONFIRMED verdict to an inline kind, which has no context file', () => {
    const ctx = contextFor('reviewer' as AgentKind)
    ctx.block.contextDocs![0]!.freshness = { status: 'unconfirmed', reason: 'source_unreachable' }

    const prompt = userPromptFor(ctx, registry)

    expect(prompt).toContain('Freshness: NOT confirmed against the source')
    expect(prompt).toContain('the source could not be reached')
  })

  it('states a confirmed revision to an inline kind', () => {
    const ctx = contextFor('reviewer' as AgentKind)
    ctx.block.contextDocs![0]!.freshness = {
      status: 'confirmed',
      version: 'v42',
      reimported: false,
    }

    expect(userPromptFor(ctx, registry)).toContain('Revision: v42')
  })

  it('says NOTHING when there is nothing to state', () => {
    // An `upload` has no source to trail and an unwired deployment never asked, so both must render
    // byte-for-byte the prior prompt rather than a note implying a check happened.
    const ctx = contextFor('reviewer' as AgentKind)
    ctx.block.contextDocs![0]!.freshness = { status: 'not-applicable' }

    expect(userPromptFor(ctx, registry)).not.toContain('Freshness')
    delete ctx.block.contextDocs![0]!.freshness
    expect(userPromptFor(ctx, registry)).not.toContain('Freshness')
  })
})
