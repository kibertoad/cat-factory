import type { AgentRunContext } from '@cat-factory/kernel'
import {
  ACCEPTANCE_AGENT_KINDS,
  acceptanceSystemPrompt,
  composeSystemPrompt,
  isAcceptanceKind,
  phaseForKind,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import { FRAGMENTS } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'

// The acceptance-testing track now has a single built-out agent kind — `playwright`
// (runnable tests from the spec's derived Gherkin scenarios) — that sits alongside the
// standard solution phases. The structured acceptance SCENARIOS are authored in the
// service spec (by the `spec-writer`, reviewed there); the runnable-tests step uses
// Playwright only for user-facing blocks and the project's own test framework for
// backend blocks.

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'playwright',
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
  it('recognises the acceptance track kind and nothing else', () => {
    expect([...ACCEPTANCE_AGENT_KINDS]).toEqual(['playwright'])
    expect(isAcceptanceKind('playwright')).toBe(true)
    expect(isAcceptanceKind('coder')).toBe(false)
    // The track kind is not a standard solution phase.
    expect(phaseForKind('playwright')).toBeUndefined()
  })

  describe('system prompts', () => {
    it('serves the built-out role prompt for the track kind', () => {
      expect(systemPromptFor('playwright')).toBe(acceptanceSystemPrompt('playwright'))
      expect(systemPromptFor('playwright')).toContain('Playwright')
    })

    it('returns undefined for non-track kinds so callers fall through', () => {
      expect(acceptanceSystemPrompt('coder')).toBeUndefined()
      expect(acceptanceSystemPrompt('whatever')).toBeUndefined()
    })

    it('tells the playwright agent to add only missing tests (idempotent)', () => {
      expect(systemPromptFor('playwright')).toMatch(/only create tests for scenarios that do not/i)
    })

    it('tells the runnable-tests agent to use Playwright only for UI and the project framework for backend', () => {
      const prompt = systemPromptFor('playwright')
      expect(prompt).toMatch(/Frontend \/ user-facing UI: write Playwright/i)
      expect(prompt).toMatch(/project's EXISTING test framework/i)
      expect(prompt).toMatch(/Do not pull in Playwright or a browser for behaviour that has no UI/i)
    })

    it('points the playwright agent at the spec-derived Gherkin scenarios', () => {
      expect(systemPromptFor('playwright')).toContain('spec/features/*.feature')
    })

    it('defers to the appended best-practice standards', () => {
      for (const kind of ACCEPTANCE_AGENT_KINDS) {
        expect(systemPromptFor(kind)).toContain('best-practice standard')
      }
    })

    it('makes the runnable-tests agent wire its tests into the CI config before it is done', () => {
      const prompt = systemPromptFor('playwright')
      expect(prompt).toMatch(/hooked into the project CI workflow/i)
      expect(prompt).toMatch(/add or update the CI configuration if it does not yet run them/i)
    })

    it('defines e2e "done" as tests wired into CI config and passing locally', () => {
      const prompt = systemPromptFor('playwright')
      expect(prompt).toMatch(
        /the acceptance tests are written, wired into the project CI configuration, and pass when you run them locally/i,
      )
      // The agent edits CI config but never pushes or runs CI itself.
      expect(prompt).toMatch(/running CI is not — the platform does that/i)
      expect(prompt).toMatch(/Do NOT run `git push`/i)
    })

    it('bounds the e2e effort so building it out cannot spin forever', () => {
      const prompt = systemPromptFor('playwright')
      expect(prompt).toMatch(/This work MUST terminate/i)
      expect(prompt).toMatch(/number of attempts/i)
      expect(prompt).toMatch(/time or token budget/i)
      expect(prompt).toMatch(/STOP iterating/i)
      expect(prompt).toMatch(/hand off for human review/i)
    })

    it('composes the acceptance fragments onto the role prompt', () => {
      const fragment = FRAGMENTS.find((f) => f.id === 'playwright.e2e')!
      const composed = composeSystemPrompt(systemPromptFor('playwright'), ['playwright.e2e'])
      expect(composed).toContain(acceptanceSystemPrompt('playwright')!)
      expect(composed).toContain(fragment.body)
    })
  })

  describe('user prompts', () => {
    it('folds linked requirement documents into the playwright prompt', () => {
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

    it('passes upstream scenarios to the playwright agent as prior output', () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: 'playwright',
          priorOutputs: [{ agentKind: 'spec-writer', output: 'Scenario: Successful login' }],
        }),
      )
      expect(prompt).toContain('### spec-writer')
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

    it('tells the runnable-tests agent to use Playwright for a frontend block', () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: 'playwright',
          block: { title: 'Login', type: 'frontend', description: 'Auth' },
        }),
      )
      expect(prompt).toContain('Test approach for this block: Playwright end-to-end tests.')
      expect(prompt).toContain('getByRole')
    })

    it("tells the runnable-tests agent to use the project's framework (not Playwright) for a backend block", () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: 'playwright',
          block: { title: 'Login endpoint', type: 'api', description: 'Auth API' },
        }),
      )
      expect(prompt).toMatch(/project's existing test framework \(do NOT use Playwright\)/i)
      expect(prompt).toMatch(/do not add Playwright or a browser/i)
      expect(prompt).not.toContain('Playwright end-to-end tests.')
    })

    it('omits the test-approach section for a non-track kind', () => {
      const prompt = userPromptFor(
        ctx({
          agentKind: 'documenter',
          block: { title: 'Login', type: 'frontend', description: 'Auth' },
        }),
      )
      expect(prompt).not.toContain('Test approach for this block')
    })
  })

  describe('best-practice fragments', () => {
    it('offers a Playwright fragment for user-facing blocks only', () => {
      const fragment = FRAGMENTS.find((f) => f.id === 'playwright.e2e')!
      expect(fragment.appliesTo?.blockTypes).toEqual(['frontend', 'environment'])
      expect(fragment.appliesTo?.agentKinds).toEqual(['playwright'])
    })

    it('offers a backend acceptance-test fragment for backend blocks only', () => {
      const fragment = FRAGMENTS.find((f) => f.id === 'acceptance.backend-tests')!
      expect(fragment).toBeDefined()
      expect(fragment.appliesTo?.blockTypes).not.toContain('frontend')
      expect(fragment.appliesTo?.blockTypes).toContain('api')
      expect(fragment.appliesTo?.agentKinds).toEqual(['playwright'])
      expect(fragment.body).toMatch(/existing test framework/i)
    })
  })
})
