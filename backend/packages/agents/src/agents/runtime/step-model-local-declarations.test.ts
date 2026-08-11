import { describe, expect, it } from 'vitest'
import type { ModelRef } from '@cat-factory/kernel'
import { resolveInlineModelRef, resolveStepModelRef, type AgentRouting } from './routing.js'

// The DISPATCH half of how a locally-run model's modality reaches a run: whatever source wins the
// step's model precedence, a local ref leaves `resolveStepModelRef` carrying what is known about it.
//
// This is the one function the container, inline and consensus paths all resolve through, and the
// fold has to live here rather than at each of them: `resolveBlockModel` is a boot-time closure over
// deployment capabilities, so it cannot know the user, and a local model has no catalog entry for
// the per-flavour facts to come from. Exercised here (agents has the vitest runner) rather than in
// kernel, like its `inline-model-resolution` sibling.

const FALLBACK: ModelRef = { provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8' }
const routing: AgentRouting = { default: { ref: FALLBACK }, byKind: {} }

const DECLARED = [
  {
    provider: 'ollama',
    models: [
      { id: 'muse-glimmer:30b', acceptsImages: true },
      { id: 'my-finetune', acceptsImages: false },
    ],
  },
]

/** Resolvers whose block-pin arm parses a local id the way the real facade closure does. */
const resolvers = {
  agentRouting: routing,
  resolveBlockModel: (id: string | undefined): ModelRef | undefined => {
    if (!id) return undefined
    const idx = id.indexOf(':')
    return idx > 0 ? { provider: id.slice(0, idx), model: id.slice(idx + 1) } : undefined
  },
}

const inputs = (blockModelId: string | undefined) => ({
  agentKind: 'coder',
  blockModelId,
  localModelDeclarations: DECLARED,
})

describe('resolveStepModelRef local-model modality', () => {
  it('folds the initiator DECLARATION onto a pinned local ref', async () => {
    expect(await resolveStepModelRef(resolvers, inputs('ollama:muse-glimmer:30b'))).toEqual({
      provider: 'ollama',
      model: 'muse-glimmer:30b',
      acceptsImages: true,
    })
    expect(await resolveStepModelRef(resolvers, inputs('ollama:my-finetune'))).toEqual({
      provider: 'ollama',
      model: 'my-finetune',
      acceptsImages: false,
    })
  })

  it('falls back to the RECOGNISED family for a model the user enabled without declaring', async () => {
    expect(await resolveStepModelRef(resolvers, inputs('ollama:gemma4:12b'))).toEqual({
      provider: 'ollama',
      model: 'gemma4:12b',
      acceptsImages: true,
    })
  })

  it('leaves the ref undeclared when no declarations ride the dispatch at all', async () => {
    // A system run (no initiator) or a deployment with no local runners: the honest answer is
    // silence, which downstream reports as `unknown_model_image_input` rather than as a refusal.
    // The field is omitted entirely rather than passed as undefined, which is the shape a context
    // with no initiator actually produces.
    const ref = await resolveStepModelRef(resolvers, {
      agentKind: 'coder',
      blockModelId: 'ollama:my-finetune',
    })
    expect(ref).not.toHaveProperty('acceptsImages')
  })

  it('does not touch the routing DEFAULT a step falls through to', async () => {
    expect(await resolveStepModelRef(resolvers, inputs(undefined))).toEqual(FALLBACK)
  })

  it('rides the INLINE resolution too, so both paths agree about one step', async () => {
    // The inline path attaches design images as message parts and the container path as files;
    // resolving the modality in the shared precedence is what stops them disagreeing.
    expect(await resolveInlineModelRef(resolvers, inputs('ollama:muse-glimmer:30b'))).toEqual({
      provider: 'ollama',
      model: 'muse-glimmer:30b',
      acceptsImages: true,
    })
  })
})
