import type { RunnerPoolManifest, RunnerPoolProvider } from '@cat-factory/kernel'
import type { AppConfig } from '@cat-factory/server'
import { describe, expect, it } from 'vitest'
import { buildNodeResolveTransport } from '../src/container.js'

// The native runner-adapter seam: `buildNodeResolveTransport` must drive the actual
// dispatch through an INJECTED `runnerPoolProvider` (e.g. a Kargo adapter) when one is
// supplied, falling back to the generic HTTP provider otherwise — symmetric with the
// `environmentProvider` seam. A pure unit test (no DB): the connection repo is faked and
// the manifest carries no secret refs, so `resolve()` needs no decryption.

const manifest: RunnerPoolManifest = {
  providerId: 'kargo',
  label: 'Kargo',
  baseUrl: 'https://kargo.test/api',
  auth: { type: 'none' },
  dispatch: { method: 'POST', pathTemplate: '/jobs', bodyTemplate: '{}' },
  poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
  response: {
    statusPath: 'state',
    statusMap: [{ from: 'succeeded', to: 'done' }],
  },
}

// A 32-byte base64 key — never actually used (the manifest has no secret refs), but the
// service constructs a cipher with it at build time.
const encryptionKey = Buffer.alloc(32, 1).toString('base64')

const config = {
  runners: { enabled: true, encryptionKey, allowUrlHosts: [], allowHttpUrls: false },
} as unknown as AppConfig

// A connection repo that always returns one workspace's pool, with NO sealed secrets
// (so resolve() decrypts nothing).
const connectionRepo = {
  getByWorkspace: () =>
    Promise.resolve({
      workspaceId: 'ws-1',
      kind: 'manifest',
      providerId: manifest.providerId,
      label: manifest.label,
      baseUrl: manifest.baseUrl,
      // The discriminated runner-backend config blob (manifest member).
      configJson: JSON.stringify({ kind: 'manifest', manifest }),
      secretsCipher: null,
      createdAt: 0,
      deletedAt: null,
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

// resolve() never calls requireWorkspace, so a bare stub suffices.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workspaceRepo = {} as any
const clock = { now: () => 0 }

function fakeProvider() {
  const dispatched: { jobId: string }[] = []
  const provider: RunnerPoolProvider = {
    dispatch: (req) => {
      dispatched.push({ jobId: req.jobId })
      return Promise.resolve()
    },
    poll: () => Promise.resolve({ state: 'running' as const }),
    release: () => Promise.resolve(),
  }
  return { provider, dispatched }
}

describe('buildNodeResolveTransport native runner-adapter seam', () => {
  it('returns null when runner pools are disabled', () => {
    const resolve = buildNodeResolveTransport(
      { runners: { enabled: false } } as unknown as AppConfig,
      connectionRepo,
      workspaceRepo,
      clock,
    )
    expect(resolve).toBeNull()
  })

  it('drives dispatch through an injected runnerPoolProvider', async () => {
    const { provider, dispatched } = fakeProvider()
    const resolve = buildNodeResolveTransport(
      config,
      connectionRepo,
      workspaceRepo,
      clock,
      provider,
    )
    expect(resolve).not.toBeNull()
    const transport = await resolve!('ws-1')
    await transport.dispatch({ runId: 'run-1', jobId: 'run-1-coder' }, { model: 'qwen' }, 'agent')
    // The injected adapter — not the default HTTP provider — received the dispatch.
    expect(dispatched).toEqual([{ jobId: 'run-1-coder' }])
  })

  it('throws the clean "register a pool" error when the workspace has none', async () => {
    const emptyRepo = {
      getByWorkspace: () => Promise.resolve(null),
    } as unknown as typeof connectionRepo
    const resolve = buildNodeResolveTransport(config, emptyRepo, workspaceRepo, clock)
    await expect(resolve!('ws-1')).rejects.toThrow(/No runner backend available/)
  })
})
