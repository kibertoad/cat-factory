import { describe, expect, it } from 'vitest'
import { ValidationError } from '@cat-factory/kernel'
import type {
  DeployProvisionJob,
  EnvironmentProvider,
  EnvironmentRecord,
  EnvironmentRegistryRepository,
  ProvisionEnvironmentRequest,
  ProvisionedEnvironment,
  RepoValidationResult,
  ResolveRunRepoContext,
  RunnerJobRef,
  RunnerJobView,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import {
  type DeployJobClient,
  EnvironmentProvisioningService,
} from './EnvironmentProvisioningService.js'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'

// EnvironmentProvisioningService is the seam an in-house adapter (e.g. a PR-environment
// platform) plugs into: it receives the typed provisionContext + the flattened inputs and
// owns the returned `fields`. These tests assert that contract + the returned-URL policy,
// independent of any HTTP provider.

const MANIFEST = {
  providerId: 'acme',
  label: 'Acme',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'none' as const },
  provision: { method: 'POST' as const, pathTemplate: '/envs' },
  response: {},
}

/** A passthrough cipher: persistence round-trips JSON without real crypto. */
const fakeCipher: SecretCipher = {
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (cipher: string) => cipher.replace(/^enc:/, ''),
}

/** In-memory registry repo capturing inserts. */
function fakeRegistry(): EnvironmentRegistryRepository & { records: EnvironmentRecord[] } {
  const records: EnvironmentRecord[] = []
  return {
    records,
    async insert(record) {
      records.push(record)
    },
    async update(workspaceId, id, patch) {
      const i = records.findIndex((r) => r.id === id)
      if (i >= 0) records[i] = { ...records[i]!, ...patch }
    },
    async get(_workspaceId, id) {
      return records.find((r) => r.id === id) ?? null
    },
    async getByBlock(_workspaceId, blockId) {
      return records.find((r) => r.blockId === blockId && !r.deletedAt) ?? null
    },
    async getByBlockAndFrame(_workspaceId, blockId, frameId) {
      return (
        records.find((r) => r.blockId === blockId && r.frameId === frameId && !r.deletedAt) ?? null
      )
    },
    async getFramelessByBlock(_workspaceId, blockId) {
      return (
        [...records]
          .reverse()
          .find((r) => r.blockId === blockId && r.frameId == null && !r.deletedAt) ?? null
      )
    },
    async listByWorkspace() {
      return records
    },
    async listExpired() {
      return []
    },
    async softDelete(_workspaceId, id, at) {
      const r = records.find((x) => x.id === id)
      if (r) r.deletedAt = at
    },
  }
}

/** A recording provider returning a fixed environment; captures the request it saw. */
function recordingProvider(
  returns: ProvisionedEnvironment,
): EnvironmentProvider & { lastProvision?: ProvisionEnvironmentRequest } {
  const provider: EnvironmentProvider & { lastProvision?: ProvisionEnvironmentRequest } = {
    async provision(req) {
      provider.lastProvision = req
      return returns
    },
    async status() {
      return returns
    },
    async teardown() {
      return { status: 'torn_down' }
    },
  }
  return provider
}

function makeService(
  provider: EnvironmentProvider,
  registry: EnvironmentRegistryRepository,
  urlPolicy?: UrlSafetyPolicy,
) {
  const connectionService = {
    resolveProvider: async () => ({ provider, manifest: MANIFEST }),
    resolveSecrets: async () => () => undefined,
  } as unknown as EnvironmentConnectionService
  let n = 0
  return new EnvironmentProvisioningService({
    connectionService,
    environmentRegistryRepository: registry,
    secretCipher: fakeCipher,
    idGenerator: { next: (prefix: string) => `${prefix}_${++n}` },
    clock: { now: () => 1_700_000_000_000 },
    ...(urlPolicy ? { urlPolicy } : {}),
  })
}

const READY: ProvisionedEnvironment = {
  externalId: 'env-123',
  url: 'https://app.public.example/preview',
  status: 'ready',
  expiresAt: null,
  access: null,
  fields: { externalId: 'env-123', ref: 'feat/login' },
}

describe('EnvironmentProvisioningService — provision context', () => {
  it('passes the typed provisionContext to the provider and flattens it into inputs', async () => {
    const provider = recordingProvider(READY)
    const service = makeService(provider, fakeRegistry())

    await service.provision({
      workspaceId: 'ws1',
      blockId: 'blk1',
      context: {
        blockId: 'blk1',
        branch: 'feat/login',
        pullNumber: 42,
        pullUrl: 'https://github.com/acme/web/pull/42',
        repoOwner: 'acme',
        repoName: 'web',
      },
    })

    const req = provider.lastProvision!
    // Typed context reaches a code adapter verbatim.
    expect(req.provisionContext?.branch).toBe('feat/login')
    expect(req.provisionContext?.repoOwner).toBe('acme')
    expect(req.provisionContext?.pullNumber).toBe(42)
    // ...and is flattened to `{{input.*}}` strings for the manifest path.
    expect(req.inputs.branch).toBe('feat/login')
    expect(req.inputs.repoOwner).toBe('acme')
    expect(req.inputs.pullNumber).toBe('42')
    expect(req.inputs.blockId).toBe('blk1')
  })

  it('lets explicit inputs win over the derived context', async () => {
    const provider = recordingProvider(READY)
    const service = makeService(provider, fakeRegistry())

    await service.provision({
      workspaceId: 'ws1',
      blockId: 'blk1',
      inputs: { branch: 'override-branch' },
      context: { branch: 'feat/login' },
    })

    expect(provider.lastProvision!.inputs.branch).toBe('override-branch')
  })

  it('persists the provider-owned fields for later status/teardown', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(READY), registry)
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    // The provider's arbitrary `fields` (here a Kargo-style ref) round-trip encrypted.
    expect(registry.records[0]!.provisionFieldsCipher).toBe(`enc:${JSON.stringify(READY.fields)}`)
  })
})

describe('EnvironmentProvisioningService — repo-config pre-flight gate', () => {
  // A run-repo resolver that always binds to an empty fake repo (the validateRepo fake
  // here ignores the bytes — it returns whatever `result` we pass).
  function gateResolver(): ResolveRunRepoContext {
    return async () => ({
      repo: {
        getFile: async () => null,
        listDirectory: async () => [],
        headSha: async () => 'sha',
        createBranch: async () => {},
        commitFiles: async () => ({ sha: 'c' }),
        openPullRequest: async () => ({ number: 1 }) as never,
      },
      baseBranch: 'main',
    })
  }

  function gatedProvider(
    result: RepoValidationResult,
  ): EnvironmentProvider & { provisionCalled: boolean } {
    const provider: EnvironmentProvider & { provisionCalled: boolean } = {
      provisionCalled: false,
      async validateRepo() {
        return result
      },
      async provision(_req) {
        provider.provisionCalled = true
        return READY
      },
      async status() {
        return READY
      },
      async teardown() {
        return { status: 'torn_down' }
      },
    }
    return provider
  }

  function makeGatedService(
    provider: EnvironmentProvider,
    registry: EnvironmentRegistryRepository,
    resolveRunRepoContext?: ResolveRunRepoContext,
  ) {
    const connectionService = {
      resolveProvider: async () => ({ provider, manifest: MANIFEST }),
      resolveSecrets: async () => () => undefined,
    } as unknown as EnvironmentConnectionService
    let n = 0
    return new EnvironmentProvisioningService({
      connectionService,
      environmentRegistryRepository: registry,
      secretCipher: fakeCipher,
      idGenerator: { next: (prefix: string) => `${prefix}_${++n}` },
      clock: { now: () => 1_700_000_000_000 },
      ...(resolveRunRepoContext ? { resolveRunRepoContext } : {}),
    })
  }

  it('throws ValidationError BEFORE calling provider.provision when validation fails', async () => {
    const provider = gatedProvider({
      ok: false,
      issues: [{ severity: 'error', message: 'no jobs', path: '.kargo.yml' }],
    })
    const service = makeGatedService(provider, fakeRegistry(), gateResolver())

    await expect(service.provision({ workspaceId: 'ws1', blockId: 'blk1' })).rejects.toThrow(
      /Repo validation failed/,
    )
    expect(provider.provisionCalled).toBe(false)
  })

  it('proceeds to provision when validation passes', async () => {
    const provider = gatedProvider({ ok: true, issues: [] })
    const registry = fakeRegistry()
    const service = makeGatedService(provider, registry, gateResolver())

    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    expect(provider.provisionCalled).toBe(true)
    expect(registry.records).toHaveLength(1)
  })

  it('skips the gate for a block-less manual provision', async () => {
    const provider = gatedProvider({ ok: false, issues: [{ severity: 'error', message: 'x' }] })
    const service = makeGatedService(provider, fakeRegistry(), gateResolver())

    // No blockId ⇒ no run-repo binding ⇒ gate skipped, provision proceeds.
    await service.provision({ workspaceId: 'ws1' })
    expect(provider.provisionCalled).toBe(true)
  })

  it('skips the gate when no run-repo resolver is wired', async () => {
    const provider = gatedProvider({ ok: false, issues: [{ severity: 'error', message: 'x' }] })
    const service = makeGatedService(provider, fakeRegistry())

    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    expect(provider.provisionCalled).toBe(true)
  })
})

describe('EnvironmentProvisioningService — frame-keyed reads with manual-env fallback', () => {
  it('a frame-keyed read falls back to a FRAME-LESS (manual) env on the block', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(READY), registry)
    // A manual / human-test provision carries no frameId, so it is stored with frame_id = NULL.
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    expect(registry.records[0]!.frameId).toBeNull()
    // A later frame-keyed read (the agent-context path always resolves the own frame) must still
    // surface that manual env rather than missing it because of the exact-frame match.
    const resolved = await service.resolveForBlock('ws1', 'blk1', 'frame_own')
    expect(resolved?.url).toBe(READY.url)
    const handle = await service.getHandleForBlock('ws1', 'blk1', 'frame_own')
    expect(handle?.url).toBe(READY.url)
  })

  it('a frame-keyed read does NOT leak a SIBLING frame’s env as the asked-for frame’s', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(READY), registry)
    // Only a sibling frame's env exists (a peer provisioned under the same block, different frame).
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1', frameId: 'frame_peer' })
    // Resolving a DIFFERENT frame's env returns nothing — the sibling is not this frame's, and the
    // manual-env fallback only accepts a frame-less row (this one has a non-null frame_id).
    expect(await service.resolveForBlock('ws1', 'blk1', 'frame_own')).toBeNull()
    expect(await service.getHandleForBlock('ws1', 'blk1', 'frame_own')).toBeNull()
    // The peer's own frame still resolves it.
    expect((await service.resolveForBlock('ws1', 'blk1', 'frame_peer'))?.url).toBe(READY.url)
  })

  it('resolves the FRAME-LESS manual env even when a NEWER sibling-frame env exists', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(READY), registry)
    // The manual/human-test env (frame_id = NULL) is provisioned FIRST, then a fan-out peer env
    // under the same block but a different frame is provisioned LATER (so it is the newest row).
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1', frameId: 'frame_peer' })
    // Resolving the OWN frame's env must still surface the manual env: the fallback reads the
    // frame-less row directly, so the newer sibling can't shadow it (a plain block newest-wins read
    // would have returned the sibling and dropped the manual env entirely).
    expect((await service.resolveForBlock('ws1', 'blk1', 'frame_own'))?.url).toBe(READY.url)
    expect(
      (await service.getHandleForBlock('ws1', 'blk1', 'frame_own'))?.frameId ?? null,
    ).toBeNull()
  })

  it('a manual re-provision supersedes the frame-less env, NOT a newer sibling frame’s env', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(READY), registry)
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' }) // frame-less manual
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1', frameId: 'frame_peer' }) // sibling
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' }) // manual re-provision
    // Only the prior FRAME-LESS row is tombstoned; the sibling frame's env stays live.
    const live = registry.records.filter((r) => !r.deletedAt)
    expect(live.filter((r) => r.frameId === null)).toHaveLength(1)
    expect(live.filter((r) => r.frameId === 'frame_peer')).toHaveLength(1)
  })
})

describe('EnvironmentProvisioningService — failed provisioning is stored', () => {
  it('persists a `failed` record carrying the provider error when the provider throws', async () => {
    const provider: EnvironmentProvider = {
      async provision() {
        throw new Error('Cannot reach env API: ECONNREFUSED')
      },
      async status() {
        return READY
      },
      async teardown() {
        return { status: 'torn_down' }
      },
    }
    const registry = fakeRegistry()
    const service = makeService(provider, registry)

    // The original provider error still propagates to the caller...
    await expect(
      service.provision({ workspaceId: 'ws1', blockId: 'blk1', frameId: 'frame1' }),
    ).rejects.toThrow(/ECONNREFUSED/)
    // ...AND a failed environment record is left behind so the deployer step can show it.
    expect(registry.records).toHaveLength(1)
    const rec = registry.records[0]!
    expect(rec.status).toBe('failed')
    expect(rec.blockId).toBe('blk1')
    // The service frame the deployer belonged to is recorded even on the failed path, so a
    // cross-frame consumer keys off the FRAME id, not the task the deployer ran on.
    expect(rec.frameId).toBe('frame1')
    expect(rec.lastError).toMatch(/ECONNREFUSED/)
  })

  it('persists the provider VERBATIM error when it RETURNS status:failed (no throw)', async () => {
    // A provider that maps a real upstream error onto `status:'failed'` (rather than throwing)
    // carries the reason on `provisioned.error` — it must surface verbatim, not collapse to a
    // generic "Provisioning failed", so the deployer step's Environment panel shows the cause.
    const failed: ProvisionedEnvironment = {
      ...READY,
      status: 'failed',
      url: null,
      error: 'quota exceeded: no free preview slots',
    }
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(failed), registry)

    const handle = await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    expect(handle.status).toBe('failed')
    expect(registry.records).toHaveLength(1)
    expect(registry.records[0]!.status).toBe('failed')
    expect(registry.records[0]!.lastError).toBe('quota exceeded: no free preview slots')
  })

  it('falls back to a generic message when a returned-`failed` provider gives no error', async () => {
    const failed: ProvisionedEnvironment = { ...READY, status: 'failed', url: null }
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(failed), registry)

    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    expect(registry.records[0]!.lastError).toBe('Provisioning failed')
  })
})

describe('EnvironmentProvisioningService — per-type provisioning records type + engine', () => {
  /** A service whose `connectionService.resolveProviderForType` returns a fixed engine, capturing the user overrides it saw. */
  function makeTypeService(
    provider: EnvironmentProvider,
    registry: EnvironmentRegistryRepository,
    opts: {
      engine?: string
      resolveUserHandlerOverrides?: (userId: string, workspaceId: string) => Promise<unknown[]>
    } = {},
  ) {
    const seen: { userOverrides?: unknown[] } = {}
    const connectionService = {
      // The per-type path: returns provider + manifest + the resolved type/engine.
      resolveProviderForType: async (
        _ws: string,
        service: { type: string },
        userOverrides: unknown[],
      ) => {
        seen.userOverrides = userOverrides
        return {
          provider,
          manifest: MANIFEST,
          provisionType: service.type,
          engine: opts.engine ?? 'remote-custom',
          resolveSecret: () => undefined,
        }
      },
    } as unknown as EnvironmentConnectionService
    let n = 0
    const service = new EnvironmentProvisioningService({
      connectionService,
      environmentRegistryRepository: registry,
      secretCipher: fakeCipher,
      idGenerator: { next: (prefix: string) => `${prefix}_${++n}` },
      clock: { now: () => 1_700_000_000_000 },
      ...(opts.resolveUserHandlerOverrides
        ? { resolveUserHandlerOverrides: opts.resolveUserHandlerOverrides as never }
        : {}),
    })
    return { service, seen }
  }

  it('records the resolved provisionType + engine on the success record', async () => {
    const registry = fakeRegistry()
    const { service } = makeTypeService(recordingProvider(READY), registry, {
      engine: 'remote-kubernetes',
    })
    const handle = await service.provision({
      workspaceId: 'ws1',
      blockId: 'blk1',
      serviceProvisioning: { type: 'kubernetes' },
    })
    expect(handle.provisionType).toBe('kubernetes')
    expect(handle.engine).toBe('remote-kubernetes')
    expect(registry.records[0]!.provisionType).toBe('kubernetes')
    expect(registry.records[0]!.engine).toBe('remote-kubernetes')
  })

  it('records the resolved provisionType + engine on a failed record (provider throws)', async () => {
    const provider: EnvironmentProvider = {
      async provision() {
        throw new Error('apiserver unreachable')
      },
      async status() {
        return READY
      },
      async teardown() {
        return { status: 'torn_down' }
      },
    }
    const registry = fakeRegistry()
    const { service } = makeTypeService(provider, registry, { engine: 'local-k3s' })
    await expect(
      service.provision({
        workspaceId: 'ws1',
        blockId: 'blk1',
        serviceProvisioning: { type: 'kubernetes' },
      }),
    ).rejects.toThrow(/apiserver unreachable/)
    expect(registry.records[0]!.status).toBe('failed')
    expect(registry.records[0]!.provisionType).toBe('kubernetes')
    expect(registry.records[0]!.engine).toBe('local-k3s')
  })

  it('rejects an infraless service (it provisions nothing)', async () => {
    const { service } = makeTypeService(recordingProvider(READY), fakeRegistry())
    await expect(
      service.provision({
        workspaceId: 'ws1',
        blockId: 'blk1',
        serviceProvisioning: { type: 'infraless' },
      }),
    ).rejects.toThrow(/infraless/)
  })

  it('loads the run initiator overrides and passes them to the resolver', async () => {
    const overrides = [{ provisionType: 'kubernetes' }]
    const { service, seen } = makeTypeService(recordingProvider(READY), fakeRegistry(), {
      resolveUserHandlerOverrides: async (userId, ws) => {
        expect(userId).toBe('user-7')
        expect(ws).toBe('ws1')
        return overrides
      },
    })
    await service.provision({
      workspaceId: 'ws1',
      blockId: 'blk1',
      serviceProvisioning: { type: 'kubernetes' },
      initiatedBy: 'user-7',
    })
    expect(seen.userOverrides).toEqual(overrides)
  })

  it('passes no overrides when the initiator override seam is unwired', async () => {
    const { service, seen } = makeTypeService(recordingProvider(READY), fakeRegistry())
    await service.provision({
      workspaceId: 'ws1',
      blockId: 'blk1',
      serviceProvisioning: { type: 'kubernetes' },
      initiatedBy: 'user-7',
    })
    expect(seen.userOverrides).toEqual([])
  })
})

describe('EnvironmentProvisioningService — supersedeForBlock (infraless flip)', () => {
  it('tombstones a prior live environment for the block', async () => {
    const registry = fakeRegistry()
    registry.records.push({
      id: 'env_old',
      workspaceId: 'ws1',
      blockId: 'blk1',
      frameId: null,
      executionId: null,
      providerId: 'p',
      externalId: 'x',
      url: 'https://old.example',
      status: 'ready',
      accessCipher: null,
      provisionFieldsCipher: null,
      createdAt: 1,
      expiresAt: null,
      lastError: null,
      provisionType: 'kubernetes',
      engine: 'remote-kubernetes',
      deletedAt: null,
    })
    const service = makeService(recordingProvider(READY), registry)
    await service.supersedeForBlock('ws1', 'blk1')
    expect(registry.records[0]!.deletedAt).toBe(1_700_000_000_000)
    expect(await registry.getByBlock('ws1', 'blk1')).toBeNull()
  })

  it('is a no-op when the block has no live environment or no block id', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(READY), registry)
    await service.supersedeForBlock('ws1', 'blk1')
    await service.supersedeForBlock('ws1', null)
    expect(registry.records).toHaveLength(0)
  })
})

describe('EnvironmentProvisioningService — returned URL policy', () => {
  const internalEnv: ProvisionedEnvironment = { ...READY, url: 'https://prenv.kargo.internal' }

  it('rejects an internal returned URL under the strict default', async () => {
    const service = makeService(recordingProvider(internalEnv), fakeRegistry())
    await expect(service.provision({ workspaceId: 'ws1', blockId: 'blk1' })).rejects.toThrow(
      ValidationError,
    )
  })

  it('accepts an internal returned URL when the policy exempts the host', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(internalEnv), registry, {
      schemes: ['https'],
      allowHosts: ['.internal'],
    })
    const handle = await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    expect(handle.url).toBe('https://prenv.kargo.internal')
    expect(registry.records).toHaveLength(1)
  })
})

describe('EnvironmentProvisioningService — async container-backed deploy lifecycle', () => {
  const CLONE = { cloneUrl: 'https://github.com/acme/web.git', ref: 'feat/x', token: 'gh-tok' }
  const REF: RunnerJobRef = { runId: 'exec1', jobId: 'deploy_1' }

  /** A provider that renders in a container: builds a deploy job + maps its terminal view. */
  function asyncProvider(): EnvironmentProvider & { lastBuild?: ProvisionEnvironmentRequest } {
    const provider: EnvironmentProvider & { lastBuild?: ProvisionEnvironmentRequest } = {
      // The synchronous REST path is never taken by this provider in the async tests.
      async provision() {
        throw new Error('should not call provision() on the async path')
      },
      async status() {
        return READY
      },
      async teardown() {
        return { status: 'torn_down' }
      },
      asyncProvision: {
        buildProvisionJob(req): DeployProvisionJob {
          provider.lastBuild = req
          return {
            ref: req.deploy!.ref,
            spec: { jobId: req.deploy!.ref.jobId, cloneUrl: req.deploy!.clone.cloneUrl },
            kind: 'deploy',
            options: { image: 'deploy' },
          }
        },
        finalizeProvision(view): ProvisionedEnvironment {
          const outcome = view.result?.custom as { namespace?: string; url?: string } | undefined
          if (view.state === 'failed' || !outcome?.namespace) {
            return {
              externalId: null,
              url: null,
              status: 'failed',
              expiresAt: null,
              access: null,
              fields: {},
              error: view.error ?? 'deploy failed',
            }
          }
          return {
            externalId: outcome.namespace,
            url: outcome.url ?? null,
            status: 'ready',
            expiresAt: null,
            access: null,
            fields: { namespace: outcome.namespace },
          }
        },
      },
    }
    return provider
  }

  /** A fake deploy job client recording dispatch/release + returning a queued poll view. */
  function fakeJobClient(view: RunnerJobView): DeployJobClient & {
    dispatched: { ref: RunnerJobRef; spec: Record<string, unknown>; kind: string }[]
    released: RunnerJobRef[]
  } {
    const dispatched: { ref: RunnerJobRef; spec: Record<string, unknown>; kind: string }[] = []
    const released: RunnerJobRef[] = []
    return {
      dispatched,
      released,
      async dispatch(_ws, ref, spec, kind) {
        dispatched.push({ ref, spec, kind })
      },
      async poll() {
        return view
      },
      async release(_ws, ref) {
        released.push(ref)
      },
    }
  }

  function makeAsyncService(
    provider: EnvironmentProvider,
    registry: EnvironmentRegistryRepository,
    opts: {
      deployJobClient?: DeployJobClient
      cloneTarget?: typeof CLONE | null
    } = {},
  ) {
    const connectionService = {
      resolveProvider: async () => ({ provider, manifest: MANIFEST }),
      resolveSecrets: async () => () => undefined,
    } as unknown as EnvironmentConnectionService
    let n = 0
    return new EnvironmentProvisioningService({
      connectionService,
      environmentRegistryRepository: registry,
      secretCipher: fakeCipher,
      idGenerator: { next: (prefix: string) => `${prefix}_${++n}` },
      clock: { now: () => 1_700_000_000_000 },
      ...(opts.deployJobClient ? { deployJobClient: opts.deployJobClient } : {}),
      ...(opts.cloneTarget !== null
        ? { resolveDeployCloneTarget: async () => opts.cloneTarget ?? CLONE }
        : {}),
    })
  }

  it('dispatches a deploy job + persists a provisioning record, then parks', async () => {
    const provider = asyncProvider()
    const registry = fakeRegistry()
    const client = fakeJobClient({ state: 'running' })
    const service = makeAsyncService(provider, registry, { deployJobClient: client })

    const result = await service.startProvision({ workspaceId: 'ws1', blockId: 'blk1' }, REF)

    expect(result.kind).toBe('dispatched')
    if (result.kind === 'dispatched') expect(result.ref).toEqual(REF)
    // The job carried the resolved clone target into the build request.
    expect(provider.lastBuild?.deploy?.clone.cloneUrl).toBe(CLONE.cloneUrl)
    expect(client.dispatched).toHaveLength(1)
    expect(client.dispatched[0]!.kind).toBe('deploy')
    // A `provisioning` record is left behind so the run details show the env spinning up.
    expect(registry.records).toHaveLength(1)
    expect(registry.records[0]!.status).toBe('provisioning')
    expect(registry.records[0]!.blockId).toBe('blk1')
  })

  it('finalizes a done deploy view into a ready environment record', async () => {
    const provider = asyncProvider()
    const registry = fakeRegistry()
    const service = makeAsyncService(provider, registry, {
      deployJobClient: fakeJobClient({ state: 'running' }),
    })
    await service.startProvision({ workspaceId: 'ws1', blockId: 'blk1' }, REF)

    const view: RunnerJobView = {
      state: 'done',
      result: { custom: { namespace: 'pr-blk1', url: 'https://pr-blk1.example' } },
    }
    const handle = await service.finalizeProvision({ workspaceId: 'ws1', blockId: 'blk1' }, view)

    expect(handle.status).toBe('ready')
    expect(handle.url).toBe('https://pr-blk1.example')
    expect(handle.externalId).toBe('pr-blk1')
    // The prior `provisioning` record is superseded; the ready one is the live record.
    const live = registry.records.find((r) => r.blockId === 'blk1' && !r.deletedAt)
    expect(live!.status).toBe('ready')
  })

  it('finalizes a failed deploy view into a failed environment carrying the error', async () => {
    const provider = asyncProvider()
    const registry = fakeRegistry()
    const service = makeAsyncService(provider, registry, {
      deployJobClient: fakeJobClient({ state: 'running' }),
    })

    const view: RunnerJobView = { state: 'failed', error: 'helm release failed' }
    const handle = await service.finalizeProvision({ workspaceId: 'ws1', blockId: 'blk1' }, view)

    expect(handle.status).toBe('failed')
    expect(handle.lastError).toBe('helm release failed')
  })

  it('pollProvisionJob returns the transport view', async () => {
    const client = fakeJobClient({ state: 'running', phase: 'apply' })
    const service = makeAsyncService(asyncProvider(), fakeRegistry(), { deployJobClient: client })
    const view = await service.pollProvisionJob('ws1', REF)
    expect(view.phase).toBe('apply')
  })

  it('throws + persists a failed env when render is needed but no transport is wired', async () => {
    const provider = asyncProvider()
    const registry = fakeRegistry()
    // No deployJobClient: buildProvisionJob returns a job (render needed) but nothing can run it.
    const service = makeAsyncService(provider, registry, {})

    await expect(
      service.startProvision({ workspaceId: 'ws1', blockId: 'blk1' }, REF),
    ).rejects.toThrow(/no deploy runner wired/i)
    expect(registry.records).toHaveLength(1)
    expect(registry.records[0]!.status).toBe('failed')
  })

  it('falls back to the synchronous path when the provider builds no deploy job', async () => {
    // A provider whose buildProvisionJob returns null (raw manifests) provisions synchronously.
    const provider = asyncProvider()
    provider.asyncProvision!.buildProvisionJob = () => null
    provider.provision = async () => READY
    const registry = fakeRegistry()
    const service = makeAsyncService(provider, registry, {
      deployJobClient: fakeJobClient({ state: 'running' }),
    })

    const result = await service.startProvision({ workspaceId: 'ws1', blockId: 'blk1' }, REF)
    expect(result.kind).toBe('completed')
    if (result.kind === 'completed') expect(result.handle.status).toBe('ready')
    expect(registry.records[0]!.status).toBe('ready')
  })

  it('still parks when the provisioning-record write fails after dispatch (best-effort)', async () => {
    const provider = asyncProvider()
    // A registry whose insert throws AFTER the deploy job is dispatched: the run must still PARK on
    // the live container, not fail (a failed startProvision is turned into a terminal, non-retried
    // provisioning failure that would strand the dispatched container). The `provisioning` row is a
    // display-only nicety — `finalizeProvision` writes the real record when the job settles.
    const registry = {
      ...fakeRegistry(),
      async insert() {
        throw new Error('registry write failed')
      },
    }
    const client = fakeJobClient({ state: 'running' })
    const service = makeAsyncService(provider, registry, { deployJobClient: client })

    const result = await service.startProvision({ workspaceId: 'ws1', blockId: 'blk1' }, REF)

    expect(result.kind).toBe('dispatched')
    expect(client.dispatched).toHaveLength(1)
  })
})
