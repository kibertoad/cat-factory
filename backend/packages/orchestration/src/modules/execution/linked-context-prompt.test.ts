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
})
