import { describe, expect, it, vi } from 'vitest'
import type { ModelFlavor, ModelRef } from '@cat-factory/kernel'
import { resolveInlineBlockModelRef, type InlineBlockModelDeps } from './inlineBlockModel.js'

// The ONE precedence every inline LLM caller shares (the judge, the fork chat, the iterative
// reviewers, the doc/initiative interviewers, the tester QC companion, the bug-hunt assessor and
// the Kaizen grader). It replaced eight hand-rolled copies, so it is the single place a regression
// in "which model, on which route" can hide — and both failure modes are SILENT: the run works, on
// the wrong provider, or on the right provider by accident.

const QWEN: ModelRef = { provider: 'qwen', model: 'qwen-coder' } // the routing default
const OPENAI: ModelRef = { provider: 'openai', model: 'gpt' }
const CLAUDE_SUB: ModelRef = { provider: 'anthropic', model: 'claude', harness: 'claude-code' }

const CATALOG: Record<string, ModelRef> = {
  'openai-direct': OPENAI,
  'claude-subscription': CLAUDE_SUB,
}

/** Records the route order every id resolution was asked to walk. */
function catalogResolver() {
  const seen: (readonly ModelFlavor[] | undefined)[] = []
  const resolve = (id: string | undefined, preference?: readonly ModelFlavor[]) => {
    seen.push(preference)
    return id ? CATALOG[id] : undefined
  }
  return { seen, resolve }
}

const deps = (over: Partial<InlineBlockModelDeps> = {}): InlineBlockModelDeps => ({
  modelRef: QWEN,
  resolveBlockModel: catalogResolver().resolve,
  ...over,
})

describe('resolveInlineBlockModelRef', () => {
  it('prefers the subject pin over the preset default', async () => {
    const ref = await resolveInlineBlockModelRef(
      deps({ resolvePresetRouting: async () => ({ modelId: 'claude-subscription' }) }),
      'ws',
      'judge',
      { modelId: 'openai-direct' },
    )
    expect(ref).toEqual(OPENAI)
  })

  it('falls through a stale pin to the preset default', async () => {
    const ref = await resolveInlineBlockModelRef(
      deps({ resolvePresetRouting: async () => ({ modelId: 'openai-direct' }) }),
      'ws',
      'judge',
      { modelId: 'gone-stale' },
    )
    expect(ref).toEqual(OPENAI)
  })

  it('falls back to the routing default when nothing resolves', async () => {
    const ref = await resolveInlineBlockModelRef(
      deps({ resolvePresetRouting: async () => ({ modelId: 'also-gone' }) }),
      'ws',
      'judge',
      {},
    )
    expect(ref).toEqual(QWEN)
  })

  it('is undefined only when nothing resolved AND no routing default is wired', async () => {
    const ref = await resolveInlineBlockModelRef(deps({ modelRef: undefined }), 'ws', 'judge', {})
    expect(ref).toBeUndefined()
  })

  it('degrades a container-only subscription ref this deployment cannot drive inline', async () => {
    const ref = await resolveInlineBlockModelRef(deps(), 'ws', 'judge', {
      modelId: 'claude-subscription',
    })
    expect(ref).toEqual(QWEN)
  })

  it('keeps the subscription ref when the deployment runs the harness inline (local ambient)', async () => {
    const ref = await resolveInlineBlockModelRef(
      deps({ runsInline: (r) => r.harness === 'claude-code' }),
      'ws',
      'judge',
      { modelId: 'claude-subscription' },
    )
    expect(ref).toEqual(CLAUDE_SUB)
  })

  describe('the preset ROUTE ORDER', () => {
    it('is walked for a SUBJECT-PINNED model, not only the preset default', async () => {
      // The pinned model still has to resolve onto the preset's routes — a compliance preset that
      // only reordered the DEFAULT model's routes would leave every pinned task on the deployment
      // order, which is the wrong provider with nothing failing.
      const catalog = catalogResolver()
      await resolveInlineBlockModelRef(
        deps({
          resolveBlockModel: catalog.resolve,
          resolvePresetRouting: async () => ({
            modelId: 'unused',
            providerPreference: ['bedrock'],
          }),
        }),
        'ws',
        'judge',
        { modelId: 'openai-direct' },
      )
      expect(catalog.seen).toEqual([['bedrock']])
    })

    it('is walked for the preset-default model too', async () => {
      const catalog = catalogResolver()
      await resolveInlineBlockModelRef(
        deps({
          resolveBlockModel: catalog.resolve,
          resolvePresetRouting: async () => ({
            modelId: 'openai-direct',
            providerPreference: ['cloudflare'],
          }),
        }),
        'ws',
        'judge',
        {},
      )
      expect(catalog.seen.at(-1)).toEqual(['cloudflare'])
    })

    it('reads the preset EXACTLY ONCE per call, pin or no pin', async () => {
      // The model and the order are two columns of one row. They arrive as one dependency
      // precisely so a resolution cannot read that row twice — which is what asking two
      // collaborators for them did.
      const resolvePresetRouting = vi.fn().mockResolvedValue({ modelId: 'openai-direct' })
      await resolveInlineBlockModelRef(deps({ resolvePresetRouting }), 'ws', 'judge', {
        modelId: 'openai-direct',
      })
      await resolveInlineBlockModelRef(deps({ resolvePresetRouting }), 'ws', 'judge', {})
      expect(resolvePresetRouting).toHaveBeenCalledTimes(2) // once per call, never twice within one
    })

    it('passes the subject’s SELECTED preset through, so a task’s own preset decides', async () => {
      const resolvePresetRouting = vi.fn().mockResolvedValue({ modelId: 'openai-direct' })
      await resolveInlineBlockModelRef(deps({ resolvePresetRouting }), 'ws', 'judge', {
        modelPresetId: 'mdp_compliance',
      })
      expect(resolvePresetRouting).toHaveBeenCalledWith('ws', 'judge', 'mdp_compliance')
    })

    it('resolves under the WORKSPACE DEFAULT preset when the subject selects none', async () => {
      // The bug-hunt assessor rates a tracker board, not a task, so it passes an empty selection.
      const resolvePresetRouting = vi.fn().mockResolvedValue({ modelId: 'openai-direct' })
      await resolveInlineBlockModelRef(deps({ resolvePresetRouting }), 'ws', 'bug-hunter', {})
      expect(resolvePresetRouting).toHaveBeenCalledWith('ws', 'bug-hunter', undefined)
    })

    it('walks the deployment default order when no preset library is wired', async () => {
      const catalog = catalogResolver()
      const ref = await resolveInlineBlockModelRef(
        deps({ resolveBlockModel: catalog.resolve }),
        'ws',
        'judge',
        { modelId: 'openai-direct' },
      )
      expect(ref).toEqual(OPENAI)
      expect(catalog.seen).toEqual([undefined])
    })
  })
})
