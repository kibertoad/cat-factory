import { describe, it, expect } from 'vitest'
import type { ModelRef } from '@cat-factory/kernel'
import { type AgentRouting, resolveStepModelRef } from '@cat-factory/agents'

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
