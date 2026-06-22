import type { AgentRunContext } from '@cat-factory/kernel'
import {
  MOCK_AGENT_KIND,
  composeSystemPrompt,
  isMockKind,
  mockSystemPrompt,
  phaseForKind,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import { FRAGMENTS } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'

// The mock-builder agent (`mocker`) is a built-out kind that stands up WireMock
// mocks for a block's external service dependencies and wires them into local /
// CI runs. It sits alongside the standard solution phases and the
// acceptance-testing track.

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: MOCK_AGENT_KIND,
    pipelineName: 'Mock external deps',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      title: 'Checkout',
      type: 'service',
      description: 'Takes payment and emails a receipt',
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('mock-builder agent prompt', () => {
  it('recognises the mock kind and nothing else', () => {
    expect(MOCK_AGENT_KIND).toBe('mocker')
    expect(isMockKind('mocker')).toBe(true)
    expect(isMockKind('coder')).toBe(false)
    // The mock builder is not a standard solution phase.
    expect(phaseForKind('mocker')).toBeUndefined()
  })

  describe('system prompt', () => {
    it('serves the built-out role prompt for the mock kind', () => {
      // `mocker` is spec-aware, so its system prompt is the mock role prompt with the
      // spec-aware guidance appended; the role prompt is still its foundation.
      expect(systemPromptFor('mocker')).toContain(mockSystemPrompt('mocker')!)
    })

    it('returns undefined for other kinds so callers fall through', () => {
      expect(mockSystemPrompt('coder')).toBeUndefined()
      expect(mockSystemPrompt('whatever')).toBeUndefined()
    })

    it('directs the agent to use WireMock and its best practices', () => {
      const prompt = systemPromptFor('mocker')
      expect(prompt).toContain('WireMock')
      expect(prompt).toMatch(/best practices/i)
    })

    it('mocks external services but not owned infrastructure', () => {
      const prompt = systemPromptFor('mocker')
      expect(prompt).toMatch(/external services/i)
      expect(prompt).toMatch(/do not mock owned infrastructure/i)
    })

    it('is incremental — only adds stubs for not-yet-mocked calls', () => {
      const prompt = systemPromptFor('mocker')
      expect(prompt).toMatch(/only for calls that are not mocked yet/i)
      expect(prompt).toMatch(/never duplicate, rewrite or delete an existing mapping/i)
    })

    it('wires the mocks up for local and CI (Playwright on GHA)', () => {
      const prompt = systemPromptFor('mocker')
      expect(prompt).toMatch(/local dev and CI/i)
      expect(prompt).toMatch(/Playwright/i)
      expect(prompt).toMatch(/GitHub Actions|GHA/i)
    })

    it('defers to the appended best-practice standards', () => {
      expect(systemPromptFor('mocker')).toContain('best-practice standard')
    })

    it('composes selected fragments onto the role prompt', () => {
      const fragment = FRAGMENTS[0]!
      const composed = composeSystemPrompt(systemPromptFor('mocker'), [fragment.id])
      expect(composed).toContain(mockSystemPrompt('mocker')!)
      expect(composed).toContain(fragment.body)
    })
  })

  describe('user prompt', () => {
    it('folds the prior agents’ work (where external deps surface) into the prompt', () => {
      const prompt = userPromptFor(
        ctx({
          priorOutputs: [
            {
              agentKind: 'coder',
              output: 'Calls Stripe POST /v1/charges and SendGrid /v3/mail/send',
            },
          ],
        }),
      )
      expect(prompt).toContain('### coder')
      expect(prompt).toContain('Stripe')
      expect(prompt).toContain('SendGrid')
    })
  })
})
