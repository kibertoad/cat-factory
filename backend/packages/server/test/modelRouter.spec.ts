import type { AgentRunContext, ModelRef } from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { ModelRouter, type ModelRouterDependencies } from '../src/agents/ModelRouter.js'

// ModelRouter owns the one canonical step-model precedence (block pin > workspace
// per-kind default > env routing) plus the "subscriptions always win" override. These
// tests pin both, exercising real catalog model ids (kimi = dual-mode poolable,
// glm = dual-mode individual, claude-opus = subscription-only) through a fake
// `resolveBlockModel` that mimics what each facade supplies.

const ENV_DEFAULT: ModelRef = { provider: 'workers-ai', model: '@cf/env/default' }

// Mimics the facade's catalog-id → ref resolution for the ids these tests pin.
const REFS: Record<string, ModelRef> = {
  kimi: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6' },
  glm: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' },
  'claude-opus': { provider: 'anthropic', model: 'claude-opus-4-8', harness: 'claude-code' },
  'qwen-plain': { provider: 'qwen', model: 'qwen-max' },
}

function makeRouter(overrides: Partial<ModelRouterDependencies> = {}): ModelRouter {
  const routing: AgentRouting = { default: { ref: ENV_DEFAULT }, byKind: {} }
  return new ModelRouter({
    agentRouting: routing,
    resolveBlockModel: (id) => (id ? REFS[id] : undefined),
    ...overrides,
  })
}

function context(
  overrides: { modelId?: string; workspaceId?: string; initiatedByUserId?: string } = {},
): AgentRunContext {
  return {
    agentKind: 'coder',
    pipelineName: 'p',
    workspaceId: overrides.workspaceId ?? 'ws_1',
    initiatedByUserId: overrides.initiatedByUserId,
    stepIndex: 0,
    isFinalStep: false,
    block: {
      id: 'blk_1',
      title: 't',
      type: 'feature',
      description: 'd',
      modelId: overrides.modelId,
    },
    priorOutputs: [],
    decisions: [],
  }
}

describe('ModelRouter.resolveRef (step precedence)', () => {
  it('prefers the block pin', async () => {
    const ref = await makeRouter().resolveRef(context({ modelId: 'qwen-plain' }))
    expect(ref).toEqual(REFS['qwen-plain'])
  })

  it('falls back to the workspace per-kind default when no block pin', async () => {
    const ref = await makeRouter({
      resolveWorkspaceModelDefault: async () => 'qwen-plain',
    }).resolveRef(context())
    expect(ref).toEqual(REFS['qwen-plain'])
  })

  it('falls back to the env routing default when nothing else resolves', async () => {
    const ref = await makeRouter().resolveRef(context())
    expect(ref).toEqual(ENV_DEFAULT)
  })
})

describe('ModelRouter.resolveEffectiveRef (subscriptions always win)', () => {
  it('a non-subscription model resolves with no vendor', async () => {
    const out = await makeRouter().resolveEffectiveRef(context({ modelId: 'qwen-plain' }), 'ws_1')
    expect(out).toEqual({ ref: REFS['qwen-plain'] })
  })

  it('a subscription-only model carries its vendor (harness already set)', async () => {
    const out = await makeRouter().resolveEffectiveRef(context({ modelId: 'claude-opus' }), 'ws_1')
    expect(out.ref).toEqual(REFS['claude-opus'])
    expect(out.subscriptionVendor).toBe('claude')
  })

  it('a dual-mode POOLABLE model switches to its subscription flavour when the workspace has a token', async () => {
    const out = await makeRouter({
      hasSubscriptionToken: async (_ws, vendor) => vendor === 'kimi',
    }).resolveEffectiveRef(context({ modelId: 'kimi' }), 'ws_1')
    expect(out.ref.harness).toBe('claude-code')
    expect(out.subscriptionVendor).toBe('kimi')
  })

  it('a dual-mode POOLABLE model stays on its Cloudflare base when the workspace has no token', async () => {
    const out = await makeRouter({
      hasSubscriptionToken: async () => false,
    }).resolveEffectiveRef(context({ modelId: 'kimi' }), 'ws_1')
    expect(out.ref).toEqual(REFS.kimi)
    expect(out.subscriptionVendor).toBeUndefined()
  })

  it('a dual-mode INDIVIDUAL model switches to the initiator personal subscription when they have one', async () => {
    const out = await makeRouter({
      hasPersonalSubscription: async (userId, vendor) => userId === 'usr_1' && vendor === 'glm',
    }).resolveEffectiveRef(context({ modelId: 'glm', initiatedByUserId: 'usr_1' }), 'ws_1')
    expect(out.ref.harness).toBe('claude-code')
    expect(out.subscriptionVendor).toBe('glm')
  })

  it('a dual-mode INDIVIDUAL model stays on Cloudflare base when the initiator has no personal subscription', async () => {
    const out = await makeRouter({
      hasPersonalSubscription: async () => false,
    }).resolveEffectiveRef(context({ modelId: 'glm', initiatedByUserId: 'usr_1' }), 'ws_1')
    expect(out.ref).toEqual(REFS.glm)
    expect(out.subscriptionVendor).toBeUndefined()
  })

  it('a dual-mode INDIVIDUAL model stays on Cloudflare base when there is no identified initiator', async () => {
    const out = await makeRouter({
      hasPersonalSubscription: async () => true,
    }).resolveEffectiveRef(context({ modelId: 'glm' }), 'ws_1')
    expect(out.ref).toEqual(REFS.glm)
    expect(out.subscriptionVendor).toBeUndefined()
  })
})
