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
  models: ['qwen3'],
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
