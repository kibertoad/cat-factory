import { describe, it, expect } from 'vitest'
import type { ModelRef } from '@cat-factory/kernel'
import { inlineModelRef } from '@cat-factory/kernel'
import { type AgentRouting, resolveInlineModelRef, resolveStepModelRef } from '@cat-factory/agents'

// The canonical step-model precedence shared by every executor (inline LLM,
// container, requirements reviewer): block-pinned > workspace per-kind default >
// env routing for the kind. This locks that precedence so a runtime can't drift.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: 'routing-default' } },
  byKind: { coder: { ref: { provider: 'workers-ai', model: 'routing-coder' } } },
}

// A catalog with three known ids; anything else is "unresolvable" (returns undefined).
const catalog: Record<string, ModelRef> = {
  'block-model': { provider: 'openai', model: 'block' },
  'ws-default': { provider: 'openai', model: 'workspace' },
}
const resolveBlockModel = (id: string | undefined): ModelRef | undefined =>
  id ? catalog[id] : undefined

describe('resolveStepModelRef', () => {
  it("uses the block's pinned model when it resolves", async () => {
    const ref = await resolveStepModelRef(
      {
        agentRouting: routing,
        resolveBlockModel,
        resolveWorkspaceModelDefault: async () => 'ws-default',
      },
      { agentKind: 'coder', blockModelId: 'block-model', workspaceId: 'ws1' },
    )
    expect(ref).toEqual(catalog['block-model'])
  })

  it('falls back to the workspace per-kind default when the block pins none', async () => {
    const ref = await resolveStepModelRef(
      {
        agentRouting: routing,
        resolveBlockModel,
        resolveWorkspaceModelDefault: async () => 'ws-default',
      },
      { agentKind: 'coder', blockModelId: undefined, workspaceId: 'ws1' },
    )
    expect(ref).toEqual(catalog['ws-default'])
  })

  it('falls through a stale/unresolvable block pin to the workspace default', async () => {
    const ref = await resolveStepModelRef(
      {
        agentRouting: routing,
        resolveBlockModel,
        resolveWorkspaceModelDefault: async () => 'ws-default',
      },
      { agentKind: 'coder', blockModelId: 'gone-stale', workspaceId: 'ws1' },
    )
    expect(ref).toEqual(catalog['ws-default'])
  })

  it('falls back to the env routing for the kind when nothing else resolves', async () => {
    const ref = await resolveStepModelRef(
      {
        agentRouting: routing,
        resolveBlockModel,
        resolveWorkspaceModelDefault: async () => undefined,
      },
      { agentKind: 'coder', blockModelId: undefined, workspaceId: 'ws1' },
    )
    expect(ref).toEqual(routing.byKind.coder!.ref)
  })

  it('uses the routing default for a kind with no specific entry', async () => {
    const ref = await resolveStepModelRef(
      { agentRouting: routing, resolveBlockModel },
      { agentKind: 'architect', blockModelId: undefined, workspaceId: 'ws1' },
    )
    expect(ref).toEqual(routing.default.ref)
  })

  it('skips the workspace default when no workspaceId is available', async () => {
    let consulted = false
    const ref = await resolveStepModelRef(
      {
        agentRouting: routing,
        resolveBlockModel,
        resolveWorkspaceModelDefault: async () => {
          consulted = true
          return 'ws-default'
        },
      },
      { agentKind: 'coder', blockModelId: undefined },
    )
    expect(consulted).toBe(false)
    expect(ref).toEqual(routing.byKind.coder!.ref)
  })
})

// The single seam every INLINE LLM path (inline agent executor, requirements
// reviewer/rework) routes a block's model through, so a pinned subscription model
// (Claude Code / Codex — container-only, no provider key) degrades to a servable
// model instead of hard-failing the inline step.
describe('inlineModelRef', () => {
  const fallback: ModelRef = { provider: 'workers-ai', model: 'fallback' }

  it('passes through a provider model unchanged', () => {
    const ref: ModelRef = { provider: 'openai', model: 'gpt-4o-mini' }
    expect(inlineModelRef(ref, fallback)).toBe(ref)
  })

  it('passes through an explicit pi harness unchanged', () => {
    const ref: ModelRef = { provider: 'workers-ai', model: 'x', harness: 'pi' }
    expect(inlineModelRef(ref, fallback)).toBe(ref)
  })

  it('degrades a claude-code subscription ref to the fallback', () => {
    const ref: ModelRef = {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      harness: 'claude-code',
    }
    expect(inlineModelRef(ref, fallback)).toBe(fallback)
  })

  it('degrades a codex subscription ref to the fallback', () => {
    const ref: ModelRef = { provider: 'openai', model: 'gpt-5.5-codex', harness: 'codex' }
    expect(inlineModelRef(ref, fallback)).toBe(fallback)
  })
})

describe('resolveInlineModelRef', () => {
  // A block pinned to a subscription-only model resolves to a harness ref for its
  // container steps; the inline resolution must hand back a servable provider model.
  const subCatalog: Record<string, ModelRef> = {
    'claude-opus': { provider: 'anthropic', model: 'claude-opus-4-8', harness: 'claude-code' },
    'block-model': { provider: 'openai', model: 'block' },
  }
  const resolveSub = (id: string | undefined): ModelRef | undefined =>
    id ? subCatalog[id] : undefined

  it('degrades a subscription-pinned block to the env routing default for the kind', async () => {
    const ref = await resolveInlineModelRef(
      { agentRouting: routing, resolveBlockModel: resolveSub },
      { agentKind: 'coder', blockModelId: 'claude-opus', workspaceId: 'ws1' },
    )
    expect(ref).toEqual(routing.byKind.coder!.ref)
  })

  it('leaves a non-subscription pinned block untouched', async () => {
    const ref = await resolveInlineModelRef(
      { agentRouting: routing, resolveBlockModel: resolveSub },
      { agentKind: 'coder', blockModelId: 'block-model', workspaceId: 'ws1' },
    )
    expect(ref).toEqual(subCatalog['block-model'])
  })
})
