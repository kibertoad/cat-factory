import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubInstallationRepository } from '@cat-factory/kernel'
import { GitHubAppAuth } from '../src/github/GitHubAppAuth.js'
import {
  InstallationTokenCache,
  installationTokenKey,
} from '../src/github/installationTokenCache.js'

// Installation tokens are identified by their SCOPE, not by their installation. That was a
// distinction without a difference until a container dispatch could ask for a token narrowed to
// the repos its own run resolved; from then on an installation-keyed entry serves one run
// another run's scope, and the two obvious ways out are both wrong. Never caching a scoped mint
// puts a JWT signature plus a GitHub round trip on every step dispatch; sharing the entry
// over-grants. Keying by the scope is what makes caching it correct, which is the whole reason
// this seam exists rather than a Map at each of the two mint sites.

describe('installationTokenKey', () => {
  it('separates a scoped mint from the unscoped one for the same installation', () => {
    expect(installationTokenKey(11)).not.toBe(installationTokenKey(11, [101]))
  })

  it('is a function of the SET, so leg resolution order cannot mint twice', () => {
    expect(installationTokenKey(11, [103, 101])).toBe(installationTokenKey(11, [101, 103]))
  })

  it('reads an empty scope as unscoped (nothing to narrow with)', () => {
    expect(installationTokenKey(11, [])).toBe(installationTokenKey(11))
  })

  it('does not collide across installations that share a repo set', () => {
    expect(installationTokenKey(11, [101])).not.toBe(installationTokenKey(12, [101]))
  })
})

describe('InstallationTokenCache', () => {
  it('serves an entry until its freshness deadline and not past it', () => {
    const cache = new InstallationTokenCache<string>()
    cache.set('k', 'TOKEN', 100, 0)
    expect(cache.get('k', 99)).toBe('TOKEN')
    expect(cache.get('k', 100)).toBeUndefined()
  })

  it('evicts lapsed entries so keying by scope cannot grow without bound', () => {
    const cache = new InstallationTokenCache<string>()
    // A long-lived node dispatches over many distinct repo sets. Before eviction this map was
    // bounded by the installation count; keyed by scope it would otherwise accumulate one entry
    // per set for the lifetime of the process.
    for (let i = 0; i < 50; i++) cache.set(`scope-${i}`, 'TOKEN', 100, 0)
    expect(cache.size).toBe(50)
    cache.set('fresh', 'TOKEN', 500, 200)
    expect(cache.size).toBe(1)
  })
})

describe('GitHubAppAuth installation-token caching', () => {
  let mints: { url: string; body: unknown }[]
  let originalFetch: typeof fetch
  let nextInstallationId = 9000

  beforeEach(() => {
    mints = []
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function makeAuth(now = () => 1_000_000): Promise<GitHubAppAuth> {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    const b64 = Buffer.from(pkcs8).toString('base64')
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      mints.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(
        JSON.stringify({
          token: `TOKEN-${mints.length}`,
          // Comfortably past the skew margin, so freshness is decided by the cache, not expiry.
          expires_at: new Date(now() + 60 * 60 * 1000).toISOString(),
          permissions: { contents: 'write' },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    return new GitHubAppAuth({
      appId: 'app_1',
      privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`,
      installationRepository: {} as unknown as GitHubInstallationRepository,
      clock: { now },
      apiBase: 'https://api.github.test',
    })
  }

  it('serves a repeated SCOPED mint from cache instead of re-minting per dispatch', async () => {
    const auth = await makeAuth()
    const id = nextInstallationId++
    const first = await auth.installationToken(id, { repositoryIds: [101, 102] })
    // Same set, opposite order: one dispatch's scope, however its legs resolved.
    const second = await auth.installationToken(id, { repositoryIds: [102, 101] })

    expect(second).toBe(first)
    expect(mints).toHaveLength(1)
    expect(mints[0]!.body).toEqual({ repository_ids: [101, 102] })
  })

  it('never serves a scoped token to an unscoped caller, or the reverse', async () => {
    const auth = await makeAuth()
    const id = nextInstallationId++
    const scoped = await auth.installationToken(id, { repositoryIds: [101] })
    const wide = await auth.installationToken(id)

    // Serving the cached scoped token to the engine would UNDER-grant every gate/merge call;
    // serving the wide one to a dispatch would hand a container the installation. Two mints.
    expect(wide).not.toBe(scoped)
    expect(mints).toHaveLength(2)
    expect(mints[0]!.body).toEqual({ repository_ids: [101] })
    expect(mints[1]!.body).toBeUndefined()

    // And both entries stand on their own afterwards.
    expect(await auth.installationToken(id, { repositoryIds: [101] })).toBe(scoped)
    expect(await auth.installationToken(id)).toBe(wide)
    expect(mints).toHaveLength(2)
  })

  it('honours forceRefresh on the scoped entry without disturbing the unscoped one', async () => {
    const auth = await makeAuth()
    const id = nextInstallationId++
    const wide = await auth.installationToken(id)
    const scoped = await auth.installationToken(id, { repositoryIds: [101] })
    const refreshed = await auth.installationToken(id, {
      repositoryIds: [101],
      forceRefresh: true,
    })

    expect(refreshed).not.toBe(scoped)
    expect(await auth.installationToken(id)).toBe(wide)
    expect(mints).toHaveLength(3)
  })

  it('re-mints a scoped token once it is within the expiry skew margin', async () => {
    let now = 1_000_000
    const auth = await makeAuth(() => now)
    const id = nextInstallationId++
    const first = await auth.installationToken(id, { repositoryIds: [101] })
    // The token is treated as lapsed a few minutes early, so one is never picked up moments
    // before it expires mid-request.
    now += 56 * 60 * 1000
    expect(await auth.installationToken(id, { repositoryIds: [101] })).not.toBe(first)
    expect(mints).toHaveLength(2)
  })
})
