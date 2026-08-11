import type { LocalRunner } from '@cat-factory/contracts'
import type {
  LocalModelEndpointRecord,
  LocalModelEndpointRepository,
  SecretCipher,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { LocalModelEndpointService } from './LocalModelEndpointService.js'

// SEC-3: the service applies the deployment's runner-host policy (loopback-only by
// default, LAN on operator opt-in) at the write boundary, on the probe, and on the
// run-time transport (`fetchRunner`), so a persisted LAN row is refused at fetch time
// after the operator narrows the policy rather than silently honoured.

function fakeRepo(): LocalModelEndpointRepository {
  const rows = new Map<string, LocalModelEndpointRecord>()
  const key = (userId: string, provider: string) => `${userId}:${provider}`
  return {
    listByUser: async (userId) => [...rows.values()].filter((r) => r.userId === userId),
    getByUserProvider: async (userId, provider) => rows.get(key(userId, provider)) ?? null,
    upsert: async (record) => {
      rows.set(key(record.userId, record.provider), record)
    },
    remove: async (userId, provider) => {
      rows.delete(key(userId, provider))
    },
  }
}

const plainCipher: SecretCipher = {
  encrypt: async (plaintext) => `enc:${plaintext}`,
  decrypt: async (envelope) => envelope.replace(/^enc:/, ''),
}

function makeService(opts: { allowPrivateLanHosts?: boolean; fetch?: typeof fetch } = {}) {
  return new LocalModelEndpointService({
    localModelEndpointRepository: fakeRepo(),
    secretCipher: plainCipher,
    clock: { now: () => 1_700_000_000_000 },
    ...opts,
  })
}

const lanInput = {
  provider: 'ollama' as LocalRunner,
  baseUrl: 'http://192.168.1.50:11434/v1',
  models: [{ id: 'qwen3' }],
}

describe('LocalModelEndpointService host policy (SEC-3)', () => {
  it('refuses a private-LAN base URL at the write boundary by default', async () => {
    await expect(makeService().upsert('usr_1', lanInput)).rejects.toThrow(
      /disabled on this deployment/,
    )
  })

  it('accepts a private-LAN base URL when the operator opted into LAN access', async () => {
    const svc = makeService({ allowPrivateLanHosts: true })
    const created = await svc.upsert('usr_1', lanInput)
    expect(created.baseUrl).toBe(lanInput.baseUrl)
  })

  it('accepts a loopback base URL under both policies', async () => {
    const input = { ...lanInput, baseUrl: 'http://127.0.0.1:11434/v1' }
    await expect(makeService().upsert('usr_1', input)).resolves.toMatchObject({
      baseUrl: input.baseUrl,
    })
    await expect(
      makeService({ allowPrivateLanHosts: true }).upsert('usr_1', input),
    ).resolves.toMatchObject({ baseUrl: input.baseUrl })
  })

  it('reports (never throws) the policy refusal from the connection probe', async () => {
    const doFetch = vi.fn()
    const result = await makeService({ fetch: doFetch as typeof fetch }).testConnection({
      provider: 'ollama',
      baseUrl: lanInput.baseUrl,
    })
    expect(result.reachable).toBe(false)
    expect(result.error).toMatch(/disabled on this deployment/)
    // The denied target is never fetched.
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('names the machine-readable reason on the probe refusal', async () => {
    const result = await makeService({ fetch: vi.fn() as unknown as typeof fetch }).testConnection({
      provider: 'ollama',
      baseUrl: lanInput.baseUrl,
    })
    // A policy refusal and an unreachable runner need different fixes, so only the former
    // carries a reason the SPA can translate.
    expect(result.errorReason).toBe('host_not_loopback')
  })

  it('refuses a probe whose base URL would discard the /models suffix', async () => {
    // The stored prefix must not be able to choose the request path: `…?q=x#` + `/models`
    // would have requested `/_search?q=x` on a loopback service.
    const doFetch = vi.fn()
    const result = await makeService({ fetch: doFetch as typeof fetch }).testConnection({
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:9200/_search?q=x#',
    })
    expect(result.reachable).toBe(false)
    expect(result.errorReason).toBe('query_or_fragment_not_allowed')
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('composes the probe URL by appending the endpoint path', async () => {
    const doFetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'qwen3' }] }))
    const result = await makeService({ fetch: doFetch as typeof fetch }).testConnection({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1/',
    })
    expect(result).toMatchObject({ reachable: true, models: ['qwen3'] })
    expect(doFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/v1/models')
  })

  it('reports a stored row the CURRENT policy denies, and withholds its models', async () => {
    // A row written while LAN access was on must not keep reading as healthy after an
    // operator narrows the policy: admission would price its models as free, dispatch a
    // container, and only then die at the first forward.
    const repo = fakeRepo()
    const shared = {
      localModelEndpointRepository: repo,
      secretCipher: plainCipher,
      clock: { now: () => 1_700_000_000_000 },
    }
    const permissive = new LocalModelEndpointService({ ...shared, allowPrivateLanHosts: true })
    await permissive.upsert('usr_1', lanInput)
    expect(await permissive.list('usr_1')).toMatchObject([{ urlBlockedReason: null }])
    expect(await permissive.capabilitiesFor('usr_1')).toHaveLength(1)

    const narrowed = new LocalModelEndpointService({ ...shared, allowPrivateLanHosts: false })
    expect(await narrowed.list('usr_1')).toMatchObject([{ urlBlockedReason: 'host_not_loopback' }])
    expect(await narrowed.capabilitiesFor('usr_1')).toEqual([])
  })

  it('fetchRunner blocks a LAN URL by default and forwards it under the opt-in', async () => {
    const doFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    await expect(
      makeService({ fetch: doFetch as typeof fetch }).fetchRunner(lanInput.baseUrl, {}),
    ).rejects.toThrow(/Blocked local-runner request/)
    expect(doFetch).not.toHaveBeenCalled()

    const res = await makeService({
      allowPrivateLanHosts: true,
      fetch: doFetch as typeof fetch,
    }).fetchRunner(lanInput.baseUrl, {})
    expect(res.status).toBe(200)
  })
})

describe('LocalModelEndpointService model declarations', () => {
  const input = (models: { id: string; acceptsImages?: boolean }[]) => ({
    provider: 'ollama' as LocalRunner,
    baseUrl: 'http://127.0.0.1:11434/v1',
    models,
  })

  it('stores the declaration and serves it to both readers', async () => {
    const svc = makeService()
    const declared = [{ id: 'muse-glimmer:30b', acceptsImages: true }, { id: 'gemma3' }]
    const created = await svc.upsert('usr_1', input(declared))
    expect(created.models).toEqual(declared)
    expect(await svc.list('usr_1')).toMatchObject([{ models: declared }])
    // The per-user catalog input, which is what puts the modality on the picker's ref.
    expect(await svc.capabilitiesFor('usr_1')).toEqual([
      { provider: 'ollama', label: 'Ollama', models: declared },
    ])
  })

  it('keeps ONE entry per model id, taking the last declaration for a repeat', async () => {
    // The panel sends one entry per ticked model, so a repeat is a client bug; taking the later
    // one means what the user set most recently is what is stored.
    const created = await makeService().upsert(
      'usr_1',
      input([
        { id: 'gemma3', acceptsImages: false },
        { id: 'qwen3' },
        { id: 'gemma3', acceptsImages: true },
      ]),
    )
    expect(created.models).toEqual([{ id: 'gemma3', acceptsImages: true }, { id: 'qwen3' }])
  })

  it('drops a blank id rather than storing an unaddressable model', async () => {
    const created = await makeService().upsert('usr_1', input([{ id: '  ' }, { id: ' qwen3 ' }]))
    expect(created.models).toEqual([{ id: 'qwen3' }])
  })

  it('carries a store-reported DISCARD onto the wire, and clears it on the write that fixes it', async () => {
    // A row written before declarations existed held bare strings, which the stores refuse rather
    // than coerce. The shortened list alone reads exactly like a runner nobody enabled a model on,
    // so the flag is the only thing that can send the user back to re-tick.
    const repo = fakeRepo()
    await repo.upsert({
      userId: 'usr_1',
      provider: 'ollama',
      label: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyCipher: null,
      models: [],
      unreadableModels: true,
      createdAt: 1,
      updatedAt: 1,
    })
    const svc = new LocalModelEndpointService({
      localModelEndpointRepository: repo,
      secretCipher: plainCipher,
      clock: { now: () => 1_700_000_000_000 },
    })
    expect(await svc.list('usr_1')).toMatchObject([{ models: [], unreadableModels: true }])
    await expect(svc.upsert('usr_1', input([{ id: 'qwen3' }]))).resolves.toMatchObject({
      unreadableModels: false,
    })
    expect(await svc.list('usr_1')).toMatchObject([{ unreadableModels: false }])
  })
})
