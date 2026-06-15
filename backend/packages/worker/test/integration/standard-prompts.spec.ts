import type { AgentRunContext } from '@cat-factory/core'
import {
  composeSystemPrompt,
  phaseForKind,
  renderStandardUserPrompt,
  STANDARD_PHASE_BY_KIND,
  standardSystemPrompt,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/core'
import { FRAGMENTS } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'

// Exercising these in the Workers pool also proves the precompiled Handlebars
// templates render in the workerd runtime, which forbids the dynamic codegen
// that Handlebars' normal compile path relies on.

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'architect',
    pipelineName: 'Quick build',
    stepIndex: 0,
    isFinalStep: false,
    block: { title: 'Login', type: 'service', description: 'Authenticate users' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('standard solution-phase prompts', () => {
  it('maps the four standard agent kinds to phases', () => {
    expect(STANDARD_PHASE_BY_KIND).toMatchObject({
      architect: 'design',
      coder: 'build',
      reviewer: 'review',
      tester: 'test',
    })
    expect(phaseForKind('architect')).toBe('design')
    expect(phaseForKind('documenter')).toBeUndefined()
    expect(phaseForKind('my-custom-agent')).toBeUndefined()
  })

  describe('system prompts', () => {
    it('routes the standard kinds through the built-out phase prompts', () => {
      expect(systemPromptFor('coder')).toBe(standardSystemPrompt('build'))
      expect(systemPromptFor('reviewer')).toBe(standardSystemPrompt('review'))
    })

    it('still serves thin roles for non-standard and custom kinds', () => {
      expect(systemPromptFor('documenter')).toContain('technical writer')
      expect(systemPromptFor('whatever')).toContain('"whatever"')
    })

    it('defers to the appended best-practice standards', () => {
      // The hook the fragment system composes onto must be present in each phase.
      for (const phase of ['design', 'build', 'review', 'test'] as const) {
        expect(standardSystemPrompt(phase)).toContain('best-practice standard')
      }
    })

    it('gates the build phase on a green PR before it is done', () => {
      const build = standardSystemPrompt('build')
      expect(build).toMatch(/NOT complete until CI on the pull request is green/i)
      expect(build).toMatch(/push the fix, and wait for CI again/i)
      expect(build).toMatch(/until every required check passes/i)
    })

    it('composes selected fragments onto the phase system prompt', () => {
      const node = FRAGMENTS.find((f) => f.id === 'node.performance')!
      const composed = composeSystemPrompt(systemPromptFor('coder'), ['node.performance'])
      expect(composed).toContain(standardSystemPrompt('build'))
      expect(composed).toContain(node.body)
    })
  })

  describe('user prompts (Handlebars-rendered)', () => {
    it('renders the block context and a design-specific task', () => {
      const prompt = userPromptFor(ctx({ agentKind: 'architect' }))
      expect(prompt).toContain('Pipeline: Quick build')
      expect(prompt).toContain('Block: Login (service)')
      expect(prompt).toContain('Description: Authenticate users')
      expect(prompt).toContain('solution design')
    })

    it('uses a phase-specific task line per kind', () => {
      expect(userPromptFor(ctx({ agentKind: 'coder' }))).toContain('implementation for this block')
      expect(userPromptFor(ctx({ agentKind: 'reviewer' }))).toContain('Review the work above')
      expect(userPromptFor(ctx({ agentKind: 'tester' }))).toContain('test plan')
    })

    it('falls back to (none provided) for an empty description', () => {
      const prompt = renderStandardUserPrompt(
        'design',
        ctx({ block: { title: 'X', type: 'api', description: '' } }),
      )
      expect(prompt).toContain('Description: (none provided)')
    })

    it('omits optional sections when absent', () => {
      const prompt = renderStandardUserPrompt('build', ctx())
      expect(prompt).not.toContain('Target features')
      expect(prompt).not.toContain('Resolved decisions')
      expect(prompt).not.toContain('Work from earlier agents')
      // No stray runs of blank lines left by skipped conditionals.
      expect(prompt).not.toMatch(/\n{3,}/)
    })

    it('includes features, resolved decisions and prior outputs when present', () => {
      const prompt = renderStandardUserPrompt(
        'review',
        ctx({
          block: {
            title: 'Login',
            type: 'service',
            description: 'Auth',
            features: ['oauth', 'mfa'],
          },
          decisions: [{ question: 'DB?', chosen: 'Postgres' }],
          resolvedDecision: { question: 'Cache?', chosen: 'Redis' },
          priorOutputs: [{ agentKind: 'architect', output: 'Use a token service.' }],
        }),
      )
      expect(prompt).toContain('Target features: oauth, mfa')
      expect(prompt).toContain('- DB? → Postgres')
      expect(prompt).toContain('- Cache? → Redis')
      expect(prompt).toContain('### architect')
      expect(prompt).toContain('Use a token service.')
    })
  })
})
