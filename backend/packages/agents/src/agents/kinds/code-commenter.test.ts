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
  it('registers as a container-coding, pr-or-work kind in the docs category', () => {
    // `pr-or-work` ⇒ amend the block's PR in place when one exists (BAU pipeline step), else branch
    // off base and open a PR (standalone / initiative sweep). Its no-op is a clean non-event.
    expect(registry.agentStep(CODE_COMMENTER_KIND)?.surface).toBe('container-coding')
    expect(registry.agentStep(CODE_COMMENTER_KIND)?.clone?.branch).toBe('pr-or-work')
    expect(registry.agentStep(CODE_COMMENTER_KIND)?.noChangesTolerated).toBe(true)
    // Container-coding kinds route to the container executor.
    expect(registry.requiresContainer(CODE_COMMENTER_KIND)).toBe(true)
    // A first-class palette block in the docs category, with a human-readable description.
    expect(registry.presentation(CODE_COMMENTER_KIND)?.category).toBe('docs')
    expect(registry.presentation(CODE_COMMENTER_KIND)?.label).toBe('Code Commenter')
    expect(registry.presentation(CODE_COMMENTER_KIND)?.description).toBeTruthy()
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

  it('actively maintains comments: updates drifted ones and removes noise', () => {
    const prompt = systemPromptFor(CODE_COMMENTER_KIND, registry)
    expect(prompt).toContain('Update comments that have drifted')
    expect(prompt).toContain('DELETE noise comments that merely restate what the code already says')
  })

  it("surfaces the spawn's targetPath as the code area, and scopes to the PR when one is open", () => {
    const scoped = userPromptFor(
      ctx({ block: { ...ctx().block, taskTypeFields: { targetPath: 'packages/billing' } } }),
      registry,
      { materialized: true },
    )
    expect(scoped).toContain('Comment the code under: `packages/billing`.')

    // BAU pipeline step: a PR is already open, so the pass is scoped to the PR's changed files.
    const onPr = userPromptFor(
      ctx({
        block: { ...ctx().block, pullRequest: { number: 7, url: 'x', branch: 'cat-factory/b1' } },
      }),
      registry,
      { materialized: true },
    )
    expect(onPr).toContain('Focus on the files this pull request changes')

    // Standalone with neither a target path nor a PR: infer scope from the brief.
    const standalone = userPromptFor(ctx(), registry, { materialized: true })
    expect(standalone).not.toContain('Comment the code under:')
    expect(standalone).not.toContain('Focus on the files this pull request changes')
    expect(standalone).toContain('Task: Billing Service')
    expect(standalone).toContain('Clarify the trickiest billing code.')
  })
})
