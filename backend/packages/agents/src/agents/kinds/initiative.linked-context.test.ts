import type { AgentRunContext } from '@cat-factory/kernel'
import { INITIATIVE_ANALYST_AGENT_KIND, INITIATIVE_PLANNER_AGENT_KIND } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { userPromptFor } from '../catalog.js'
import { CONTEXT_DIR } from '../prompts/standard.js'
import { INITIATIVE_BREAKDOWN_KIND } from './initiative.js'
import { defaultAgentKindRegistry } from './registry.js'

// An initiative is anchored to an ordinary board block, so the engine has always RESOLVED the
// requirements / RFCs / issues a human attached to it (and the container has always materialised
// them under `.cat-context/`) — but the initiative kinds build their own user prompts, which
// return from `buildBaseUserPrompt` before the generic `linkedContextSection` fold. The agents
// therefore had the files on disk with nothing in the prompt telling them the files existed.
// These pin the fold, and pin that each kind folds in the form matching its SURFACE.

const registry = defaultAgentKindRegistry()

const DOC = {
  title: 'Auth migration PRD',
  url: 'https://example.test/prd',
  origin: 'confluence' as const,
  excerpt: 'Move every service onto the new auth model.',
  summary: 'Move every service onto the new auth model.',
  body: 'The full PRD body: sessions must stay valid across the cutover.',
}

const ISSUE = {
  key: 'ENG-42',
  url: 'https://example.test/ENG-42',
  title: 'Legacy tokens never expire',
  status: 'open',
  type: 'bug',
  assignee: null,
  priority: null,
  labels: [],
  description: 'Tokens minted before the rotation are accepted forever.',
  comments: [],
  summary: 'Tokens minted before the rotation are accepted forever.',
}

function ctx(
  agentKind: string,
  overrides: Partial<AgentRunContext['block']> = {},
): AgentRunContext {
  return {
    agentKind,
    pipelineName: 'Plan initiative',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      title: 'Migrate to the new auth model',
      type: 'service',
      description: 'Retire the legacy session store.',
      ...overrides,
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
  }
}

describe('initiative planning prompts carry the block’s linked context', () => {
  // The analyst and planner run `container-explore`, so they get the cheap INDEX plus a pointer at
  // the on-disk copies — never the bodies, which would pay for every attachment on every dispatch.
  for (const kind of [INITIATIVE_ANALYST_AGENT_KIND, INITIATIVE_PLANNER_AGENT_KIND]) {
    it(`${kind} indexes attachments and points at the materialised files`, () => {
      const prompt = userPromptFor(
        ctx(kind, { contextDocs: [DOC], contextTasks: [ISSUE] }),
        registry,
      )

      expect(prompt).toContain('Auth migration PRD')
      expect(prompt).toContain('[ENG-42] Legacy tokens never expire')
      expect(prompt).toContain(CONTEXT_DIR)
      // The index, not the bodies: a container agent opens the file when it needs the detail.
      expect(prompt).not.toContain('sessions must stay valid across the cutover')
    })

    it(`${kind} is unchanged when nothing is attached`, () => {
      // The builders join their lines verbatim, so an empty section must contribute NOTHING
      // rather than a stray blank line.
      expect(userPromptFor(ctx(kind), registry)).toBe(
        userPromptFor(ctx(kind, { contextDocs: [], contextTasks: [] }), registry),
      )
      expect(userPromptFor(ctx(kind), registry)).not.toContain(CONTEXT_DIR)
    })
  }

  it('initiative-breakdown inlines the bodies, having no checkout to read them from', () => {
    // This kind is INLINE — its system prompt has always told it to "reason purely from the brief
    // and any linked context", which was a promise the user prompt never kept.
    const prompt = userPromptFor(
      ctx(INITIATIVE_BREAKDOWN_KIND, { contextDocs: [DOC], contextTasks: [ISSUE] }),
      registry,
    )

    expect(prompt).toContain('sessions must stay valid across the cutover')
    expect(prompt).toContain('Tokens minted before the rotation are accepted forever.')
    expect(prompt).not.toContain(CONTEXT_DIR)
  })

  it('initiative-breakdown is unchanged when nothing is attached', () => {
    expect(userPromptFor(ctx(INITIATIVE_BREAKDOWN_KIND), registry)).toBe(
      userPromptFor(
        ctx(INITIATIVE_BREAKDOWN_KIND, { contextDocs: [], contextTasks: [] }),
        registry,
      ),
    )
  })
})
