import type { AgentRunContext } from '@cat-factory/kernel'
import {
  composeSystemPrompt,
  phaseForKind,
  renderStandardUserPrompt,
  STANDARD_PHASE_BY_KIND,
  standardSystemPrompt,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
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
      expect(systemPromptFor('architect')).toBe(standardSystemPrompt('design'))
      expect(systemPromptFor('tester')).toBe(standardSystemPrompt('test'))
    })

    it('routes `reviewer` through the companion prompt (it is now the coder’s companion)', () => {
      // `reviewer` is a companion, so it grades the coder's output rather than serving
      // the standard `review` phase prompt.
      expect(systemPromptFor('reviewer')).toContain('quality companion')
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

    it('defines build "done" as a complete, locally-passing implementation', () => {
      const build = standardSystemPrompt('build')
      expect(build).toMatch(/a focused, complete implementation that builds and passes/i)
      expect(build).toMatch(/Run the project build, the linters, and the tests/i)
    })

    it('tells the build agent the platform delivers, so it never pushes or chases credentials', () => {
      const build = standardSystemPrompt('build')
      // The agent commits its own work; the platform pushes + opens the PR.
      expect(build).toMatch(/you commit, the platform delivers/i)
      expect(build).toMatch(/Commit your changes yourself/i)
      expect(build).toMatch(/Do NOT run `git push`/i)
      expect(build).toMatch(/do NOT use the `gh` CLI/i)
      // The root-cause guard: do not rabbit-hole on credentials / git remotes.
      expect(build).toMatch(/Do NOT probe the environment for credentials/i)
    })

    it('bounds the build effort so it cannot spin forever', () => {
      const build = standardSystemPrompt('build')
      expect(build).toMatch(/This work MUST terminate/i)
      expect(build).toMatch(/number of attempts/i)
      expect(build).toMatch(/time or token budget/i)
      expect(build).toMatch(/STOP iterating/i)
      expect(build).toMatch(/hand off for human review/i)
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
      expect(prompt).not.toContain('Resolved decisions')
      expect(prompt).not.toContain('Work from earlier agents')
      // No stray runs of blank lines left by skipped conditionals.
      expect(prompt).not.toMatch(/\n{3,}/)
    })

    it('includes resolved decisions and prior outputs when present', () => {
      const prompt = renderStandardUserPrompt(
        'review',
        ctx({
          block: {
            title: 'Login',
            type: 'service',
            description: 'Auth',
          },
          decisions: [{ question: 'DB?', chosen: 'Postgres' }],
          resolvedDecision: { question: 'Cache?', chosen: 'Redis' },
          priorOutputs: [{ agentKind: 'architect', output: 'Use a token service.' }],
        }),
      )
      expect(prompt).toContain('- DB? → Postgres')
      expect(prompt).toContain('- Cache? → Redis')
      expect(prompt).toContain('### architect')
      expect(prompt).toContain('Use a token service.')
    })
  })
})
