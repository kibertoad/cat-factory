import type { CloudflareEnvironmentConfig, EnvironmentManifest } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudflareConfigToManifest } from './cloudflare-environment.logic.js'
import {
  CloudflareEnvironmentProvider,
  PREVIEW_WORKFLOW_PATH,
} from './CloudflareEnvironmentProvider.js'

// The provider is thin by design — the interesting decisions live in the pure logic beside it
// — so these cover the three things only the wiring can get wrong: which calls it makes, that
// a refusal is a non-throwing `failed` handle carrying its reason, and that a status read
// targets the repository recorded at PROVISION time rather than a freshly resolved one.

interface Call {
  method: string
  url: string
  body: unknown
}

function stubFetch(handler: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: typeof input === 'string' ? input : input.toString(),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }
    calls.push(call)
    const res = handler(call)
    return new Response(JSON.stringify(res.body ?? {}), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const CONFIG: CloudflareEnvironmentConfig = {
  label: 'Cloudflare Workers preview',
  workersSubdomain: 'my-account',
}
const MANIFEST: EnvironmentManifest = cloudflareConfigToManifest(CONFIG)
const resolveSecret = (key: string) => (key === 'githubToken' ? 'ghp_test' : undefined)
const CTX = {
  pullNumber: 1413,
  repoOwner: 'acme',
  repoName: 'widgets',
  branch: 'feat/preview',
  blockId: 'blk_1',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('provision', () => {
  it('creates a deployment and reports it PROVISIONING with the derived URL', async () => {
    const calls = stubFetch((call) =>
      call.method === 'POST' ? { status: 201, body: { id: 42 } } : { body: [] },
    )
    const provider = new CloudflareEnvironmentProvider()

    const result = await provider.provision({
      manifest: MANIFEST,
      inputs: {},
      provisionContext: CTX,
      resolveSecret,
    })

    expect(result).toMatchObject({
      externalId: '42',
      // Derived, never read back: the Worker name is ours to choose.
      url: 'https://cat-factory-pr-1413.my-account.workers.dev',
      // Honest — the build has not run yet. The manifest backend this replaces could only
      // claim `ready` here.
      status: 'provisioning',
    })
    expect(result.fields).toMatchObject({
      owner: 'acme',
      repo: 'widgets',
      environmentName: 'pr-1413',
    })

    const created = calls.find((c) => c.method === 'POST')
    expect(created?.url).toBe('https://api.github.com/repos/acme/widgets/deployments')
    expect(created?.body).toMatchObject({
      // The BRANCH, so the host resolves it against its own refs and refuses one that is not
      // there — rather than a raw sha, which would deploy any commit in the repository.
      ref: 'feat/preview',
      environment: 'pr-1413',
      transient_environment: true,
    })
  })

  it('re-attaches to a live deployment for the same ref instead of stacking another', async () => {
    const calls = stubFetch((call) => {
      if (call.url.includes('/deployments/7/statuses')) return { body: [{ state: 'success' }] }
      if (call.method === 'GET' && call.url.includes('/deployments?')) return { body: [{ id: 7 }] }
      return { status: 201, body: { id: 99 } }
    })
    const provider = new CloudflareEnvironmentProvider()

    const result = await provider.provision({
      manifest: MANIFEST,
      inputs: {},
      provisionContext: CTX,
      resolveSecret,
    })

    expect(result).toMatchObject({ externalId: '7', status: 'ready' })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('refuses a run with no pull request as a FAILED handle, without throwing or calling out', async () => {
    const calls = stubFetch(() => ({ body: {} }))
    const provider = new CloudflareEnvironmentProvider()

    const result = await provider.provision({
      manifest: MANIFEST,
      inputs: {},
      provisionContext: { repoOwner: 'acme', repoName: 'widgets' },
      resolveSecret,
    })

    // The deployer renders `lastError` verbatim on the board, so the operator gets the reason
    // rather than a stack trace — and nothing was created.
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/pull request/i)
    expect(calls).toHaveLength(0)
  })
})

describe('status', () => {
  it('maps the latest deployment status and targets the repo pinned at provision time', async () => {
    const calls = stubFetch(() => ({ body: [{ state: 'success' }] }))
    const provider = new CloudflareEnvironmentProvider()

    const result = await provider.status({
      manifest: MANIFEST,
      externalId: '42',
      provisionFields: {
        owner: 'pinned-owner',
        repo: 'pinned-repo',
        url: 'https://cat-factory-pr-1413.my-account.workers.dev',
      },
      resolveSecret,
    })

    expect(result.status).toBe('ready')
    expect(result.url).toBe('https://cat-factory-pr-1413.my-account.workers.dev')
    expect(calls[0]?.url).toContain('/repos/pinned-owner/pinned-repo/deployments/42/statuses')
  })

  it('is failed, not silently ready, when the record has no deployment to address', async () => {
    stubFetch(() => ({ body: [] }))
    const provider = new CloudflareEnvironmentProvider()

    const result = await provider.status({
      manifest: MANIFEST,
      externalId: null,
      provisionFields: {},
      resolveSecret,
    })

    expect(result.status).toBe('failed')
  })
})

describe('teardown', () => {
  it('posts an inactive status, which is what fires the workflow teardown', async () => {
    const calls = stubFetch(() => ({ body: {} }))
    const provider = new CloudflareEnvironmentProvider()

    const result = await provider.teardown({
      manifest: MANIFEST,
      externalId: '42',
      provisionFields: { owner: 'acme', repo: 'widgets' },
      resolveSecret,
    })

    expect(result.status).toBe('torn_down')
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/repos/acme/widgets/deployments/42/statuses',
      body: { state: 'inactive' },
    })
  })

  it('succeeds with nothing to address — an un-provisioned record created no resources', async () => {
    const calls = stubFetch(() => ({ body: {} }))
    const provider = new CloudflareEnvironmentProvider()

    const result = await provider.teardown({
      manifest: MANIFEST,
      externalId: null,
      provisionFields: {},
      resolveSecret,
    })

    // Reporting failure here would leave the record stuck `tearing_down` forever.
    expect(result.status).toBe('torn_down')
    expect(calls).toHaveLength(0)
  })

  it('marks a preview inactive whose stored config no longer matches the contract', async () => {
    // Same reason as the case above, from the other direction: a stored `providerConfig` is
    // re-parsed on the way out, and a `workersSubdomain` that stopped validating would otherwise
    // refuse the one call teardown makes — which reads none of it.
    const drifted: EnvironmentManifest = cloudflareConfigToManifest(CONFIG)
    drifted.providerConfig = { cloudflare: { label: 'preview', workersSubdomain: 'NOT VALID' } }
    const calls = stubFetch(() => ({ body: {} }))
    const provider = new CloudflareEnvironmentProvider()

    const result = await provider.teardown({
      manifest: drifted,
      externalId: '42',
      provisionFields: { owner: 'acme', repo: 'widgets' },
      resolveSecret,
    })

    expect(result.status).toBe('torn_down')
    expect(calls[0]).toMatchObject({ method: 'POST', body: { state: 'inactive' } })
  })

  it('still refuses when the API ROOT is what drifted, rather than posting to the public one', async () => {
    // The one field teardown reads, and the one with an unsafe default: falling back to
    // `api.github.com` for a GitHub Enterprise deployment is a wrong-host write.
    const drifted: EnvironmentManifest = cloudflareConfigToManifest(CONFIG)
    drifted.providerConfig = { cloudflare: { ...CONFIG, apiBaseUrl: '' } }
    const calls = stubFetch(() => ({ body: {} }))
    const provider = new CloudflareEnvironmentProvider()

    await expect(
      provider.teardown({
        manifest: drifted,
        externalId: '42',
        provisionFields: { owner: 'acme', repo: 'widgets' },
        resolveSecret,
      }),
    ).rejects.toThrow(/apiBaseUrl/)
    expect(calls).toHaveLength(0)
  })
})

describe('validateRepo', () => {
  it('passes when the target repo carries a preview workflow', async () => {
    const provider = new CloudflareEnvironmentProvider()
    const result = await provider.validateRepo({
      readRepoFile: async (path) =>
        path === PREVIEW_WORKFLOW_PATH ? { content: 'on: deployment', sha: 'sha' } : null,
      resolveSecret,
    })
    expect(result).toEqual({ ok: true, issues: [] })
  })

  it('fails legibly when it does not — a deployment would be created and never built', async () => {
    const provider = new CloudflareEnvironmentProvider()
    const result = await provider.validateRepo({
      readRepoFile: async () => null,
      resolveSecret,
    })
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatchObject({ severity: 'error', path: PREVIEW_WORKFLOW_PATH })
  })
})
