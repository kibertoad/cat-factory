import { describe, expect, it, vi } from 'vitest'
import type {
  GroupCacheHandle,
  LocalModelDeclarationsCacheValue,
  LocalModelEndpointRecord,
  LocalModelEndpointRepository,
} from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { resolveDispatchLocalModelDeclarations } from './dispatchPromptSettings.js'

// The ENGINE half of how a locally-run model's declared modality reaches a run: what the initiator
// said about their own runners, resolved once per dispatch and carried on the context for every
// executor to fold onto its resolved ref. The other half is the fold itself (agents'
// `step-model-local-declarations`); wiring only one is silent, leaving either a declaration nothing
// reads or a dispatch that resolves a local model and can never learn what it accepts.

const record = (over: Partial<LocalModelEndpointRecord> = {}): LocalModelEndpointRecord => ({
  userId: 'usr_1',
  provider: 'ollama',
  label: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKeyCipher: null,
  models: [{ id: 'muse-glimmer:30b', acceptsImages: true }],
  unreadableModels: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

function repo(rows: LocalModelEndpointRecord[]) {
  const listByUser = vi.fn().mockResolvedValue(rows)
  return { listByUser } as unknown as LocalModelEndpointRepository & {
    listByUser: typeof listByUser
  }
}

const deps = (localModelEndpoints?: LocalModelEndpointRepository) => ({
  agentKindRegistry: defaultAgentKindRegistry(),
  ...(localModelEndpoints ? { localModelEndpoints } : {}),
})

describe('resolveDispatchLocalModelDeclarations', () => {
  it('resolves the RUN INITIATOR’s declarations, keyed on the user', async () => {
    const endpoints = repo([record()])
    expect(await resolveDispatchLocalModelDeclarations(deps(endpoints), 'usr_7')).toEqual({
      localModelDeclarations: [
        { provider: 'ollama', models: [{ id: 'muse-glimmer:30b', acceptsImages: true }] },
      ],
    })
    // Keyed on the USER, not the workspace: a runner lives on one person's machine, so this is the
    // same key the personal-subscription check and the proxy's endpoint resolution use.
    expect(endpoints.listByUser).toHaveBeenCalledWith('usr_7')
  })

  it('carries one entry per runner, so two runners serving one model id stay distinct', async () => {
    const endpoints = repo([
      record(),
      record({ provider: 'lmstudio', models: [{ id: 'muse-glimmer:30b' }] }),
    ])
    const { localModelDeclarations } = await resolveDispatchLocalModelDeclarations(
      deps(endpoints),
      'usr_1',
    )
    expect(localModelDeclarations?.map((d) => d.provider)).toEqual(['ollama', 'lmstudio'])
  })

  it('returns an EMPTY SLICE for a run with no initiator', async () => {
    // A schedule or a system sweep has nobody to ask, and must never inherit another user's
    // endpoints. An empty slice (not an empty array) keeps "nothing to declare" distinguishable
    // from "declarations were never resolved" at every reader downstream.
    const endpoints = repo([record()])
    expect(await resolveDispatchLocalModelDeclarations(deps(endpoints), null)).toEqual({})
    expect(await resolveDispatchLocalModelDeclarations(deps(endpoints), undefined)).toEqual({})
    expect(endpoints.listByUser).not.toHaveBeenCalled()
  })

  it('returns an empty slice for a runner with nothing enabled, and with no store wired', async () => {
    expect(
      await resolveDispatchLocalModelDeclarations(deps(repo([record({ models: [] })])), 'usr_1'),
    ).toEqual({})
    expect(await resolveDispatchLocalModelDeclarations(deps(), 'usr_1')).toEqual({})
  })

  it('reads through the declarations cache, grouped AND keyed by the user', async () => {
    // Every dispatch resolves this, on every deployment including the ones that wired no runner at
    // all, so it goes through the app cache seam exactly as the block's model preset does.
    const endpoints = repo([record()])
    const get = vi.fn(async (_key: string, _group: string, load: () => Promise<unknown>) => load())
    const cache = { get } as unknown as GroupCacheHandle<LocalModelDeclarationsCacheValue>
    const withCache = { ...deps(endpoints), localModelDeclarationsCache: cache }
    await resolveDispatchLocalModelDeclarations(withCache, 'usr_7')
    expect(get).toHaveBeenCalledWith('usr_7', 'usr_7', expect.any(Function))
    expect(endpoints.listByUser).toHaveBeenCalledTimes(1)
  })

  it('serves a cached answer without touching the store', async () => {
    const endpoints = repo([record()])
    const cache = {
      get: async () => ({ runners: [{ provider: 'lmstudio', models: [{ id: 'llava' }] }] }),
    } as unknown as GroupCacheHandle<LocalModelDeclarationsCacheValue>
    expect(
      await resolveDispatchLocalModelDeclarations(
        { ...deps(endpoints), localModelDeclarationsCache: cache },
        'usr_1',
      ),
    ).toEqual({ localModelDeclarations: [{ provider: 'lmstudio', models: [{ id: 'llava' }] }] })
    expect(endpoints.listByUser).not.toHaveBeenCalled()
  })
})
