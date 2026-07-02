import { describe, expect, it, vi } from 'vitest'
import type { Block, ModelRef } from '@cat-factory/kernel'
import { KaizenService, type KaizenServiceDependencies } from './KaizenService.js'

// Regression coverage for the Kaizen grader's model resolution. The grader is "just another
// inline LLM step", so it must resolve its model through the SAME shared precedence every
// inline agent uses — block pin > workspace per-kind default > routing default — and KEEP a
// subscription (harness) ref the deployment can run inline instead of degrading it. The
// reported bug: a "Claude for everything" preset silently degraded to the env routing
// default (e.g. `qwen`) and failed with "Unsupported model provider". These tests pin that
// behaviour so it can't drift back.

const QWEN: ModelRef = { provider: 'qwen', model: 'qwen-coder' } // the routing default
const CLAUDE_SUB: ModelRef = { provider: 'anthropic', model: 'claude', harness: 'claude-code' }
const OPENAI: ModelRef = { provider: 'openai', model: 'gpt' }

// Catalog the deployment's model-id → ref resolver knows about.
const CATALOG: Record<string, ModelRef> = {
  'claude-subscription': CLAUDE_SUB,
  'openai-direct': OPENAI,
}

function makeService(over: Partial<KaizenServiceDependencies> = {}, block?: Partial<Block>) {
  const deps = {
    blockRepository: {
      get: vi.fn().mockResolvedValue({ id: 'task_login', ...block } as Block),
    },
    modelRef: QWEN,
    resolveBlockModel: (id: string | undefined) => (id ? CATALOG[id] : undefined),
    ...over,
  } as unknown as KaizenServiceDependencies
  const service = new KaizenService(deps)
  return (
    service as unknown as {
      modelFor(workspaceId: string, blockId: string): Promise<ModelRef | undefined>
    }
  ).modelFor('ws', 'task_login')
}

describe('KaizenService model resolution', () => {
  it('KEEPS a subscription preset model when the deployment can run it inline (the qwen-degrade bug)', async () => {
    // The workspace per-kind default (the "Claude for everything" preset) resolves to a
    // container-only subscription harness ref; a local deployment can drive it inline, so
    // `runsInline` returns true → the grader must keep Claude, NOT fall back to qwen.
    const ref = await makeService({
      resolveWorkspaceModelDefault: vi.fn().mockResolvedValue('claude-subscription'),
      runsInline: (r) => r.harness === 'claude-code',
    })
    expect(ref).toEqual(CLAUDE_SUB)
  })

  it('degrades a subscription preset model to the routing default when it cannot run inline', async () => {
    // Node/Worker have no inline harness path (`runsInline` absent) → the harness ref is
    // degraded to the routing default so the inline ModelProvider can serve it.
    const ref = await makeService({
      resolveWorkspaceModelDefault: vi.fn().mockResolvedValue('claude-subscription'),
    })
    expect(ref).toEqual(QWEN)
  })

  it("prefers a block's pinned model over the workspace preset default", async () => {
    const resolveWorkspaceModelDefault = vi.fn().mockResolvedValue('claude-subscription')
    const ref = await makeService({ resolveWorkspaceModelDefault }, { modelId: 'openai-direct' })
    expect(ref).toEqual(OPENAI)
    expect(resolveWorkspaceModelDefault).not.toHaveBeenCalled()
  })

  it('falls through a stale block pin to the workspace preset default', async () => {
    const ref = await makeService(
      { resolveWorkspaceModelDefault: vi.fn().mockResolvedValue('openai-direct') },
      { modelId: 'gone-stale' },
    )
    expect(ref).toEqual(OPENAI)
  })

  it('falls back to the routing default when nothing else resolves', async () => {
    const ref = await makeService({
      resolveWorkspaceModelDefault: vi.fn().mockResolvedValue(undefined),
    })
    expect(ref).toEqual(QWEN)
  })

  it('is disabled (undefined) when no routing default is wired', async () => {
    const ref = await makeService({ modelRef: undefined })
    expect(ref).toBeUndefined()
  })
})
