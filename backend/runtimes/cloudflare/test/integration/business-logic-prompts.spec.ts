import type { AgentRunContext } from '@cat-factory/kernel'
import {
  BUSINESS_DOCUMENTER_KIND,
  BUSINESS_LOGIC_AGENT_KINDS,
  BUSINESS_LOGIC_DOCS_DIR,
  BUSINESS_REVIEWER_KIND,
  businessLogicSystemPrompt,
  composeSystemPrompt,
  isBusinessLogicKind,
  phaseForKind,
  systemPromptFor as _systemPromptFor,
  defaultAgentKindRegistry,
  userPromptFor as _userPromptFor,
} from '@cat-factory/agents'

// App-owned DI: a fresh registry (built-ins pre-loaded) injected into the prompt fns so
// every existing call site keeps its original arity.
const _agentKindRegistry = defaultAgentKindRegistry()
const systemPromptFor = (kind: string) => _systemPromptFor(kind, _agentKindRegistry)
const userPromptFor = (ctx: AgentRunContext, opts?: { materialized?: boolean }) =>
  _userPromptFor(ctx, _agentKindRegistry, opts)
import { FRAGMENTS } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'

// The business-logic / domain-rules track is two built-out kinds:
//   - `business-documenter` reads the implementation and commits durable
//     domain-rule documentation to the repo (a repo-operating, container kind).
//   - `business-reviewer` reviews a change against that documentation and reports
//     violations / undocumented / unexpected changes (an inline kind whose report
//     is its output, shown in the UI).
// They sit alongside the standard solution phases, the acceptance track and the
// mock builder.

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: BUSINESS_REVIEWER_KIND,
    pipelineName: 'Guard domain rules',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      title: 'Auth Service',
      type: 'service',
      description: 'Issues and validates sessions and access tokens',
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('business-logic agent prompts', () => {
  it('recognises both kinds and nothing else', () => {
    expect(BUSINESS_LOGIC_AGENT_KINDS).toEqual(['business-documenter', 'business-reviewer'])
    expect(isBusinessLogicKind('business-documenter')).toBe(true)
    expect(isBusinessLogicKind('business-reviewer')).toBe(true)
    expect(isBusinessLogicKind('coder')).toBe(false)
    expect(isBusinessLogicKind('documenter')).toBe(false)
    // Neither is a standard solution phase.
    expect(phaseForKind('business-documenter')).toBeUndefined()
    expect(phaseForKind('business-reviewer')).toBeUndefined()
  })

  describe('system prompts', () => {
    it('serves the built-out role prompt for each kind', () => {
      // Both kinds are spec-aware, so their system prompts carry the spec-aware guidance
      // appended after the built-out role prompt (their foundation).
      expect(systemPromptFor('business-documenter')).toContain(
        businessLogicSystemPrompt('business-documenter')!,
      )
      expect(systemPromptFor('business-reviewer')).toContain(
        businessLogicSystemPrompt('business-reviewer')!,
      )
    })

    it('returns undefined for other kinds so callers fall through', () => {
      expect(businessLogicSystemPrompt('coder')).toBeUndefined()
      expect(businessLogicSystemPrompt('whatever')).toBeUndefined()
    })

    it('directs the documenter to ground rules in the implementation, not invent them', () => {
      const prompt = systemPromptFor(BUSINESS_DOCUMENTER_KIND)
      expect(prompt).toMatch(/domain[- ]rules/i)
      expect(prompt).toMatch(/never invent rules/i)
      expect(prompt).toMatch(/traceable to a concrete source location/i)
    })

    it('tells the documenter to use linked context docs and flag doc/code mismatches', () => {
      const prompt = systemPromptFor(BUSINESS_DOCUMENTER_KIND)
      expect(prompt).toMatch(/linked context documents/i)
      expect(prompt).toMatch(/doc\/code mismatch/i)
    })

    it('points the documenter at the in-repo docs home and asks for stable rule ids', () => {
      const prompt = systemPromptFor(BUSINESS_DOCUMENTER_KIND)
      expect(prompt).toContain(BUSINESS_LOGIC_DOCS_DIR)
      expect(prompt).toMatch(/stable[, ].*id/i)
    })

    it('tells the documenter the platform delivers and bounds its effort', () => {
      const prompt = systemPromptFor(BUSINESS_DOCUMENTER_KIND)
      expect(prompt).toMatch(/consistent with the code it describes/i)
      expect(prompt).toMatch(/you commit, the platform delivers/i)
      expect(prompt).toMatch(/Do NOT run `git push`/i)
      expect(prompt).toMatch(/This work MUST terminate/i)
      expect(prompt).toMatch(/number of attempts/i)
      expect(prompt).toMatch(/time or token budget/i)
      expect(prompt).toMatch(/STOP iterating/i)
      expect(prompt).toMatch(/hand off for human review/i)
    })

    it('has the reviewer classify findings into violations, undocumented and drift', () => {
      const prompt = systemPromptFor(BUSINESS_REVIEWER_KIND)
      expect(prompt).toMatch(/VIOLATION/)
      expect(prompt).toMatch(/UNDOCUMENTED CHANGE/)
      expect(prompt).toMatch(/UNEXPECTED \/ SILENT DRIFT/)
      expect(prompt).toMatch(/do not invent violations/i)
    })

    it('has the reviewer produce a report (its UI-visible output) against the documented baseline', () => {
      const prompt = systemPromptFor(BUSINESS_REVIEWER_KIND)
      expect(prompt).toMatch(/structured Markdown report/i)
      expect(prompt).toContain(BUSINESS_LOGIC_DOCS_DIR)
      expect(prompt).toMatch(/no business-logic documentation is available/i)
    })

    it('both defer to the appended best-practice standards', () => {
      expect(systemPromptFor(BUSINESS_DOCUMENTER_KIND)).toContain('best-practice standard')
      expect(systemPromptFor(BUSINESS_REVIEWER_KIND)).toContain('best-practice standard')
    })

    it('composes selected fragments onto the role prompt', () => {
      const fragment = FRAGMENTS[0]!
      const composed = composeSystemPrompt(systemPromptFor(BUSINESS_DOCUMENTER_KIND), [fragment.id])
      expect(composed).toContain(businessLogicSystemPrompt(BUSINESS_DOCUMENTER_KIND)!)
      expect(composed).toContain(fragment.body)
    })
  })

  describe('user prompt', () => {
    it('folds linked context documents (the "extra context" docs) into the prompt', () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: BUSINESS_DOCUMENTER_KIND,
          block: {
            title: 'Auth Service',
            type: 'service',
            description: 'Issues and validates sessions',
            contextDocs: [
              {
                title: 'Auth PRD',
                url: 'https://example.test/prd',
                excerpt: 'Sessions expire after 30 minutes of inactivity.',
                summary: 'Sessions expire after 30 minutes of inactivity.',
                body: 'Sessions expire after 30 minutes of inactivity.',
              },
            ],
          },
        }),
      )
      expect(prompt).toContain('Linked context documents')
      expect(prompt).toContain('Auth PRD')
      expect(prompt).toContain('Sessions expire after 30 minutes')
    })

    it('folds the documented rules handed off by an earlier step into the reviewer prompt', () => {
      const prompt = userPromptFor(
        ctx({
          priorOutputs: [
            {
              agentKind: 'business-documenter',
              output: 'AUTH-01 — a session is issued only on valid credentials.',
            },
          ],
        }),
      )
      expect(prompt).toContain('### business-documenter')
      expect(prompt).toContain('AUTH-01')
    })
  })
})
