import type { AgentRunContext } from '@cat-factory/core'
import {
  ACCEPTANCE_AGENT_KINDS,
  acceptanceSystemPrompt,
  composeSystemPrompt,
  isAcceptanceKind,
  phaseForKind,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/core'
import { FRAGMENTS } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'

// The acceptance-testing track adds two built-out agent kinds — `acceptance`
// (scenarios from requirements) and `playwright` (e2e tests from scenarios) —
// that sit alongside the four standard solution phases.

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'acceptance',
    pipelineName: 'Acceptance pass',
    stepIndex: 0,
    isFinalStep: false,
    block: { title: 'Login', type: 'frontend', description: 'Authenticate users' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('acceptance-testing agent prompts', () => {
  it('recognises the acceptance track kinds and nothing else', () => {
    expect([...ACCEPTANCE_AGENT_KINDS]).toEqual(['acceptance', 'playwright'])
    expect(isAcceptanceKind('acceptance')).toBe(true)
    expect(isAcceptanceKind('playwright')).toBe(true)
    expect(isAcceptanceKind('coder')).toBe(false)
    // The track kinds are not standard solution phases.
    expect(phaseForKind('acceptance')).toBeUndefined()
    expect(phaseForKind('playwright')).toBeUndefined()
  })

  describe('system prompts', () => {
    it('serves the built-out role prompt for each track kind', () => {
      expect(systemPromptFor('acceptance')).toBe(acceptanceSystemPrompt('acceptance'))
      expect(systemPromptFor('playwright')).toBe(acceptanceSystemPrompt('playwright'))
      expect(systemPromptFor('acceptance')).toContain('Given / When / Then')
      expect(systemPromptFor('playwright')).toContain('Playwright')
    })

    it('returns undefined for non-track kinds so callers fall through', () => {
      expect(acceptanceSystemPrompt('coder')).toBeUndefined()
      expect(acceptanceSystemPrompt('whatever')).toBeUndefined()
    })

    it('tells the playwright agent to add only missing tests (idempotent)', () => {
      expect(systemPromptFor('playwright')).toMatch(/only create tests for scenarios that do not/i)
    })

    it('defers to the appended best-practice standards', () => {
      for (const kind of ACCEPTANCE_AGENT_KINDS) {
        expect(systemPromptFor(kind)).toContain('best-practice standard')
      }
    })

    it('composes the acceptance fragments onto the role prompt', () => {
      const fragment = FRAGMENTS.find((f) => f.id === 'playwright.e2e')!
      const composed = composeSystemPrompt(systemPromptFor('playwright'), ['playwright.e2e'])
      expect(composed).toContain(acceptanceSystemPrompt('playwright')!)
      expect(composed).toContain(fragment.body)
    })
  })

  describe('user prompts', () => {
    it('folds linked requirement documents into the acceptance prompt', () => {
      const prompt = userPromptFor(
        ctx({
          block: {
            title: 'Login',
            type: 'frontend',
            description: 'Authenticate users',
            contextDocs: [
              {
                title: 'Auth PRD',
                url: 'https://example.test/prd',
                excerpt: 'Users sign in with email + password.',
              },
            ],
          },
        }),
      )
      expect(prompt).toContain('Auth PRD')
      expect(prompt).toContain('Users sign in with email + password.')
    })

    it('passes the acceptance scenarios to the playwright agent as prior output', () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: 'playwright',
          priorOutputs: [{ agentKind: 'acceptance', output: 'Scenario: Successful login' }],
        }),
      )
      expect(prompt).toContain('### acceptance')
      expect(prompt).toContain('Scenario: Successful login')
    })

    it('folds the GitHub Actions test target into the prompt', () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: 'playwright',
          block: {
            title: 'Login',
            type: 'frontend',
            description: 'Auth',
            testTarget: 'github_actions',
          },
        }),
      )
      expect(prompt).toContain('GitHub Actions')
      expect(prompt).toMatch(/spin the system under test up inside the same workflow run/i)
    })

    it('folds the ephemeral-environment test target into the prompt', () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: 'playwright',
          block: {
            title: 'Login',
            type: 'frontend',
            description: 'Auth',
            testTarget: 'ephemeral_env',
          },
        }),
      )
      expect(prompt).toMatch(/provisioned ephemeral environment/i)
      expect(prompt).toContain('environment URL from the run context')
    })

    it('omits the test-target section for non-acceptance kinds', () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: 'documenter',
          block: {
            title: 'Login',
            type: 'frontend',
            description: 'Auth',
            testTarget: 'github_actions',
          },
        }),
      )
      expect(prompt).not.toContain('Test execution target')
    })
  })
})
