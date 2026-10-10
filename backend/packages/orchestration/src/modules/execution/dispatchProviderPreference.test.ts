import { describe, expect, it, vi } from 'vitest'
import type { ModelPreset, ModelPresetRepository } from '@cat-factory/kernel'
import type { Block } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { resolveDispatchProviderPreference } from './dispatchPromptSettings.js'

// The DISPATCH half of how a preset's route order reaches a run. The other half is the start
// guard's capability set; wiring only one of them is silent either way — a run admitted against a
// route it never takes, or every dispatch quietly on the deployment's default order. This pins the
// dispatch half: what the engine resolves ONCE and every executor then reads off the context.

const preset = (over: Partial<ModelPreset> = {}): ModelPreset => ({
  id: 'mdp_default',
  name: 'Default',
  baseModelId: 'kimi-k2.7',
  overrides: {},
  isDefault: true,
  createdAt: 0,
  ...over,
})

function repo(rows: { picked?: ModelPreset | null; fallback?: ModelPreset | null }) {
  const get = vi.fn().mockResolvedValue(rows.picked ?? null)
  const getDefault = vi.fn().mockResolvedValue(rows.fallback ?? null)
  return { get, getDefault } as unknown as ModelPresetRepository & {
    get: typeof get
    getDefault: typeof getDefault
  }
}

const block = (over: Partial<Block> = {}): Block => ({ id: 'task_1', ...over }) as Block
const deps = (modelPresets?: ModelPresetRepository) => ({
  agentKindRegistry: defaultAgentKindRegistry(),
  ...(modelPresets ? { modelPresets } : {}),
})

describe('resolveDispatchProviderPreference', () => {
  it('resolves the order from the block’s SELECTED preset', async () => {
    const presets = repo({ picked: preset({ providerPreference: ['bedrock', 'direct'] }) })
    const settings = await resolveDispatchProviderPreference(
      deps(presets),
      'ws',
      block({ modelPresetId: 'mdp_compliance' }),
    )
    expect(settings).toEqual({ providerPreference: ['bedrock', 'direct'] })
    expect(presets.get).toHaveBeenCalledWith('ws', 'mdp_compliance')
  })

  it('falls back to the WORKSPACE DEFAULT preset when the block selects none', async () => {
    const presets = repo({ fallback: preset({ providerPreference: ['cloudflare'] }) })
    const settings = await resolveDispatchProviderPreference(deps(presets), 'ws', block())
    expect(settings).toEqual({ providerPreference: ['cloudflare'] })
    expect(presets.get).not.toHaveBeenCalled()
  })

  it('falls through a DELETED selected preset to the workspace default', async () => {
    const presets = repo({ picked: null, fallback: preset({ providerPreference: ['openrouter'] }) })
    const settings = await resolveDispatchProviderPreference(
      deps(presets),
      'ws',
      block({ modelPresetId: 'mdp_gone' }),
    )
    expect(settings).toEqual({ providerPreference: ['openrouter'] })
  })

  it('returns an EMPTY slice — not an empty order — when the preset states none', async () => {
    // The slice is spread straight onto the run context, so an empty array here would put
    // `providerPreference: []` on every dispatch and make "states nothing" indistinguishable from
    // "states an order over no routes" at every reader downstream.
    const presets = repo({ fallback: preset() })
    expect(await resolveDispatchProviderPreference(deps(presets), 'ws', block())).toEqual({})
  })

  it('returns an empty slice when a stored order is empty', async () => {
    const presets = repo({ fallback: preset({ providerPreference: [] }) })
    expect(await resolveDispatchProviderPreference(deps(presets), 'ws', block())).toEqual({})
  })

  it('returns an empty slice when the workspace has no preset library yet', async () => {
    const presets = repo({})
    expect(await resolveDispatchProviderPreference(deps(presets), 'ws', block())).toEqual({})
  })

  it('is off entirely when no preset library is wired (the feature is simply not on)', async () => {
    expect(await resolveDispatchProviderPreference(deps(), 'ws', block())).toEqual({})
  })
})
