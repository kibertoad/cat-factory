import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { systemPromptFor, userPromptFor } from '../catalog.js'
import { CODE_COMMENTER_KIND } from './code-commenter.js'
import { defaultAgentKindRegistry } from './registry.js'
import { DOC_AWARE_TRAIT, hasTrait } from './traits.js'

// `defaultAgentKindRegistry()` pre-loads the code-commenter kind, so a fresh instance exposes it
// (no module-global side effect).
const registry = defaultAgentKindRegistry()

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: CODE_COMMENTER_KIND,
    pipelineName: 'Improve code comments',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      title: 'Billing Service',
      type: 'service',
      description: 'Clarify the trickiest billing code.',
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('code-commenter agent kind', () => {
  it('registers as a container-coding, work-branch, PR-opening kind in the docs category', () => {
    // A `work` clone ⇒ branch off base, push the work branch and open a PR (coder-like).
    expect(registry.agentStep(CODE_COMMENTER_KIND)?.surface).toBe('container-coding')
    expect(registry.agentStep(CODE_COMMENTER_KIND)?.clone?.branch).toBe('work')
    // Container-coding kinds route to the container executor.
    expect(registry.requiresContainer(CODE_COMMENTER_KIND)).toBe(true)
    // A first-class palette block in the docs category.
    expect(registry.presentation(CODE_COMMENTER_KIND)?.category).toBe('docs')
  })

  it('is doc-aware so the engine folds the writing-style fragments into its prompt', () => {
    // `doc-aware` is what makes the engine fold the block's writing-style fragments (anti-LLM-isms,
    // concise & actionable) — comments are writing, so the style guidance applies.
    expect(hasTrait(CODE_COMMENTER_KIND, DOC_AWARE_TRAIT, registry)).toBe(true)
  })

  it('is NOT told to put its answer in the reply (its product is a pushed commit)', () => {
    // FINAL_ANSWER_IN_REPLY is for inline/explore deliverable-is-the-reply kinds; this commits,
    // so — like the coder / doc-writer — it must not get that directive. It DOES carry the platform
    // delivery contract (commit yourself; the platform pushes + opens the PR).
    const prompt = systemPromptFor(CODE_COMMENTER_KIND, registry)
    expect(prompt).not.toContain('Your deliverable is the text of your FINAL reply')
    expect(prompt).toContain('How your work ships')
  })

  it('forbids any behaviour change and leans on CI to verify a comment-only diff', () => {
    const prompt = systemPromptFor(CODE_COMMENTER_KIND, registry)
    expect(prompt).toContain('NO behaviour change')
    expect(prompt).toContain('Touch ONLY comments and docstrings')
    expect(prompt).toContain('CI step verifies')
  })

  it("surfaces the spawn's targetPath as the code area to comment, and omits it when unset", () => {
    const scoped = userPromptFor(
      ctx({ block: { ...ctx().block, taskTypeFields: { targetPath: 'packages/billing' } } }),
      registry,
      { materialized: true },
    )
    expect(scoped).toContain('Comment the code under: `packages/billing`.')

    const standalone = userPromptFor(ctx(), registry, { materialized: true })
    expect(standalone).not.toContain('Comment the code under:')
    // The brief still carries the task title + description.
    expect(standalone).toContain('Task: Billing Service')
    expect(standalone).toContain('Clarify the trickiest billing code.')
  })
})
