import type { AgentRunContext } from '@cat-factory/kernel'
import {
  composeSystemPrompt,
  phaseForKind,
  READ_ONLY_GUARDRAIL,
  renderStandardUserPrompt,
  STANDARD_PHASE_BY_KIND,
  standardSystemPrompt,
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
  it('maps the standard agent kinds to phases', () => {
    expect(STANDARD_PHASE_BY_KIND).toMatchObject({
      architect: 'design',
      coder: 'build',
      reviewer: 'review',
    })
    expect(phaseForKind('architect')).toBe('design')
    // `tester` is no longer a one-shot phase: it routes through its own Tester/Fixer
    // prompt (it runs the tests and returns a structured report), so it maps to no
    // standard phase.
    expect(phaseForKind('tester-api')).toBeUndefined()
    expect(phaseForKind('documenter')).toBeUndefined()
    expect(phaseForKind('my-custom-agent')).toBeUndefined()
  })

  describe('system prompts', () => {
    it('routes the standard kinds through the built-out phase prompts', () => {
      // `coder` carries the `code-aware` + `spec-aware` traits, so its system prompt is
      // the build phase prompt with the spec-aware guidance appended (like the read-only
      // guardrail on the architect). The phase prompt is still its foundation.
      expect(systemPromptFor('coder')).toContain(standardSystemPrompt('build'))
      // `tester` no longer routes through the generic `test` phase — it has its own
      // built-out Tester prompt (run the suite, return a structured report).
      expect(systemPromptFor('tester-api')).not.toBe(standardSystemPrompt('test'))
      expect(systemPromptFor('tester-api')).toContain('test engineer')
    })

    it('builds the architect on the design phase prompt plus the read-only guardrail', () => {
      // `architect` now runs read-only in a container (it explores before proposing),
      // so its system prompt is the design phase prompt with the shared read-only
      // guardrail appended (no edits / commits / PR).
      const prompt = systemPromptFor('architect')
      expect(prompt).toContain(standardSystemPrompt('design'))
      expect(prompt).toContain(READ_ONLY_GUARDRAIL)
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
