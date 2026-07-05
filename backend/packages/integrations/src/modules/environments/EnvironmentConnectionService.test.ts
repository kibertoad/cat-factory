import { describe, expect, it } from 'vitest'
import type {
  Clock,
  EnvironmentBackendConfig,
  EnvironmentConnectionRecord,
  EnvironmentConnectionRepository,
  EnvironmentConnectionTestRequest,
  EnvironmentManifest,
  EnvironmentProvider,
  ProviderConfigField,
  RepoValidationRequest,
  RepoFiles,
  RunRepoContext,
  SecretCipher,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { EnvironmentConnectionService } from './EnvironmentConnectionService.js'
import {
  type EnvironmentBackendProvider,
  EnvironmentBackendRegistry,
  defaultEnvironmentBackendRegistry,
} from './environment-backends.js'

// The app-owned backend registry every service instance resolves a stored `kind` through.
const registry = defaultEnvironmentBackendRegistry()

// The manifest's `providerConfig` bag is the per-workspace config carrier for a NATIVE
// injected adapter (e.g. Kargo's project). It rides inside the `manifestJson` JSON column
// verbatim on both runtimes, so these tests pin that it round-trips through register →
// requireConnection unchanged — proving native adapters get their per-workspace config back.

const fakeCipher: SecretCipher = {
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (cipher: string) => cipher.replace(/^enc:/, ''),
}

function fakeConnections(): EnvironmentConnectionRepository & {
  records: Map<string, EnvironmentConnectionRecord>
} {
  const key = (ws: string, type: string, manifestId: string | null) =>
    `${ws}|${type}|${manifestId ?? ''}`
  const records = new Map<string, EnvironmentConnectionRecord>()
  return {
    records,
    async listByWorkspace(workspaceId) {
      return [...records.values()].filter((r) => r.workspaceId === workspaceId && !r.deletedAt)
    },
    async getByWorkspaceAndType(workspaceId, provisionType, manifestId) {
      const r = records.get(key(workspaceId, provisionType, manifestId))
      return r && !r.deletedAt ? r : null
    },
    async upsert(record) {
      records.set(key(record.workspaceId, record.provisionType, record.manifestId), record)
    },
    async softDelete(workspaceId, provisionType, manifestId, at) {
      const r = records.get(key(workspaceId, provisionType, manifestId))
      if (r) r.deletedAt = at
    },
  }
}

const fakeWorkspaces = {
  async get(id: string): Promise<Workspace | null> {
    return { id, name: 'ws', createdAt: 0 } as unknown as Workspace
  },
} as unknown as WorkspaceRepository

const clock: Clock = { now: () => 1_700_000_000_000 }

function makeService(repo: EnvironmentConnectionRepository) {
  return new EnvironmentConnectionService({
    environmentConnectionRepository: repo,
    workspaceRepository: fakeWorkspaces,
    secretCipher: fakeCipher,
    clock,
    environmentBackendRegistry: registry,
  })
}

const baseManifest: EnvironmentManifest = {
  providerId: 'kargo',
  label: 'Kargo',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'none' },
  provision: { method: 'POST', pathTemplate: '/prenvs' },
  response: {},
}

describe('EnvironmentConnectionService — providerConfig round-trip', () => {
  it('preserves a native adapter providerConfig bag through register → requireConnection', async () => {
    const repo = fakeConnections()
    const service = makeService(repo)
    const manifest: EnvironmentManifest = {
      ...baseManifest,
      providerConfig: { project: 'acme-web', linkKey: 'app', statusMap: { online: 'ready' } },
    }

    await service.register('ws1', { config: { kind: 'manifest', manifest }, secrets: {} })

    const { manifest: resolved } = await service.requireConnection('ws1')
    expect(resolved.providerConfig).toEqual({
      project: 'acme-web',
      linkKey: 'app',
      statusMap: { online: 'ready' },
    })
  })

  it('leaves providerConfig undefined when the manifest omits it', async () => {
    const repo = fakeConnections()
    const service = makeService(repo)

    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    const { manifest: resolved } = await service.requireConnection('ws1')
    expect(resolved.providerConfig).toBeUndefined()
  })

  it('preserves a deeply-nested providerConfig bag verbatim through the JSON column', async () => {
    const repo = fakeConnections()
    const service = makeService(repo)
    const manifest: EnvironmentManifest = {
      ...baseManifest,
      providerConfig: { project: 'acme-web', nested: { a: [1, 2], b: true } },
    }

    await service.register('ws1', { config: { kind: 'manifest', manifest }, secrets: {} })

    const { manifest: resolved } = await service.requireConnection('ws1')
    expect(resolved.providerConfig).toEqual({ project: 'acme-web', nested: { a: [1, 2], b: true } })
  })
})

// The per-provision-type handler API (the final design): register handlers keyed by type,
// list them, and resolve the live provider for a service by matching its declared type to a
// handler and merging the service-owned manifestSource (the "what/where ÷ how" split).
describe('EnvironmentConnectionService — per-type handlers', () => {
  const composeManifest: EnvironmentManifest = {
    providerId: 'kargo',
    label: 'Bespoke Envs',
    baseUrl: 'https://envs.test/api',
    auth: { type: 'none' },
    provision: { method: 'POST', pathTemplate: '/envs' },
    response: {},
  }

  it('registers a handler and lists it back with safe metadata + config (no secrets)', async () => {
    const service = makeService(fakeConnections())
    const view = await service.registerHandler('ws1', {
      provisionType: 'custom',
      manifestId: 'kargo',
      config: { engine: 'remote-custom', manifest: composeManifest, acceptsManifestId: 'kargo' },
      secrets: { TOKEN: 'tok' },
    })
    expect(view.provisionType).toBe('custom')
    expect(view.manifestId).toBe('kargo')
    expect(view.engine).toBe('remote-custom')
    expect(view.acceptsManifestId).toBe('kargo')

    const list = await service.listHandlers('ws1')
    expect(list).toHaveLength(1)
    expect(list[0]!.engine).toBe('remote-custom')
    expect(JSON.stringify(list)).not.toContain('tok')
  })

  it('resolves the provider for a service type and exposes the stored secret', async () => {
    const service = makeService(fakeConnections())
    await service.registerHandler('ws1', {
      provisionType: 'custom',
      manifestId: 'kargo',
      config: { engine: 'remote-custom', manifest: composeManifest, acceptsManifestId: 'kargo' },
      secrets: { TOKEN: 'tok' },
    })
    const resolved = await service.resolveProviderForType('ws1', {
      type: 'custom',
      manifestId: 'kargo',
    })
    expect(resolved.engine).toBe('remote-custom')
    expect(resolved.provisionType).toBe('custom')
    expect(resolved.manifest.providerId).toBe('kargo')
    expect(resolved.resolveSecret('TOKEN')).toBe('tok')
  })

  it('throws provision_type_unhandled when no handler serves the service type', async () => {
    const service = makeService(fakeConnections())
    await expect(service.resolveProviderForType('ws1', { type: 'kubernetes' })).rejects.toThrow(
      /no handler/i,
    )
  })

  it('merges the service manifestSource into a kube handler at resolve time', async () => {
    const service = makeService(fakeConnections())
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: {
        engine: 'remote-kubernetes',
        kubernetes: {
          label: 'Cluster',
          apiServerUrl: 'https://cluster.example.test:6443',
          url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.example.test' },
        },
      },
      secrets: { apiToken: 'k8s-tok' },
    })
    // The service supplies the manifests to apply (the "what/where"); the handler the engine.
    const resolved = await service.resolveProviderForType('ws1', {
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/k8s' },
    })
    expect(resolved.engine).toBe('remote-kubernetes')
    // The merged manifestSource rides the built manifest's providerConfig.
    expect(JSON.stringify(resolved.manifest)).toContain('deploy/k8s')
  })

  it('merges shared + per-env helm releases by name (service overrides, no double install)', async () => {
    const service = makeService(fakeConnections())
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: {
        engine: 'remote-kubernetes',
        kubernetes: {
          label: 'Cluster',
          apiServerUrl: 'https://cluster.example.test:6443',
          url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.example.test' },
          helmReleases: [
            { name: 'gateway', chart: 'oci://x/gateway', version: '1.0.0', scope: 'shared' },
          ],
        },
      },
      secrets: { apiToken: 'k8s-tok' },
    })
    const resolved = await service.resolveProviderForType('ws1', {
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/k8s' },
      helmReleases: [
        // Same name as the engine's shared release ⇒ overrides it (not installed twice).
        { name: 'gateway', chart: 'oci://x/gateway', version: '2.0.0', scope: 'shared' },
        { name: 'app', chart: 'oci://x/app', version: '0.1.0' },
      ],
    })
    const providerConfig = resolved.manifest.providerConfig as { helmReleases?: unknown }
    expect(providerConfig.helmReleases).toEqual([
      { name: 'gateway', chart: 'oci://x/gateway', version: '2.0.0', scope: 'shared' },
      { name: 'app', chart: 'oci://x/app', version: '0.1.0' },
    ])
  })
})

// The legacy single-connection surface (register/getConnection/unregister/...) is a compat
// bridge over the per-type handler table: it must keep behaving as one connection per workspace
// even though rows are now keyed by (workspace, provisionType, manifestId).
describe('EnvironmentConnectionService — compat bridge', () => {
  const kubeConfig = (manifestSource: {
    type: 'separate'
    repo: string
    ref?: string
    path: string
  }) =>
    ({
      kind: 'kubernetes',
      kubernetes: {
        label: 'Cluster',
        apiServerUrl: 'https://cluster.example.test:6443',
        manifestSource,
        url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.example.test' },
      },
    }) as const

  it('switching provider kind replaces the connection (no stale primary handler)', async () => {
    const repo = fakeConnections()
    const service = makeService(repo)
    // First connect a generic manifest provider, then "switch" to a kubernetes one. These land
    // on different composite keys, so without the single-row sweep the manifest row would survive
    // and remain the (oldest) primary.
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })
    await service.register('ws1', {
      config: kubeConfig({ type: 'separate', repo: 'org/manifests', path: 'k8s/' }),
      secrets: { apiToken: 'k8s-tok' },
    })

    const connection = await service.getConnection('ws1')
    expect(connection?.kind).toBe('kubernetes')
    // Exactly one live handler remains — the switch fully replaced the prior connection.
    expect((await repo.listByWorkspace('ws1')).length).toBe(1)
  })

  it('preserves a kube manifestSource through register → getConnection (no placeholder)', async () => {
    const repo = fakeConnections()
    const service = makeService(repo)
    const source = { type: 'separate', repo: 'org/manifests', ref: 'main', path: 'k8s/' } as const
    await service.register('ws1', {
      config: kubeConfig(source),
      secrets: { apiToken: 'k8s-tok' },
    })

    const connection = await service.getConnection('ws1')
    const config = connection?.config as { kubernetes?: { manifestSource?: unknown } } | undefined
    // The operator's source must round-trip — a dropped source would surface as the placeholder
    // { type: 'colocated', path: '.' } and silently provision from the repo root.
    expect(config?.kubernetes?.manifestSource).toEqual(source)
  })
})

// describeProvider.missingRequired drives the unconfigured-provider banner: a `required`
// field with no `default` and no stored value is "missing". A secret is satisfied by the
// secret bundle; a non-secret native field by the manifest providerConfig bag; a defaulted
// field is never missing.
describe('EnvironmentConnectionService — describeProvider.missingRequired', () => {
  const NATIVE_FIELDS: ProviderConfigField[] = [
    { key: 'apiToken', label: 'API token', secret: true, required: true },
    { key: 'project', label: 'Project', required: true },
    { key: 'region', label: 'Region', required: true, default: 'us-east' },
    { key: 'note', label: 'Note' },
  ]
  const nativeProvider = {
    describeConfig: () => NATIVE_FIELDS,
  } as unknown as EnvironmentProvider

  function nativeService(repo: EnvironmentConnectionRepository) {
    return new EnvironmentConnectionService({
      environmentConnectionRepository: repo,
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: registry,
      environmentProvider: nativeProvider,
    })
  }

  it('reports every required-without-default field when nothing is registered', async () => {
    const descriptor = await nativeService(fakeConnections()).describeProvider('ws1')
    expect(descriptor.missingRequired).toEqual(['apiToken', 'project'])
  })

  it('clears fields satisfied by the secret bundle and the providerConfig bag', async () => {
    const repo = fakeConnections()
    const service = nativeService(repo)
    await service.register('ws1', {
      config: {
        kind: 'manifest',
        manifest: { ...baseManifest, providerConfig: { project: 'acme-web' } },
      },
      secrets: { apiToken: 'tok' },
    })

    const descriptor = await service.describeProvider('ws1')
    expect(descriptor.missingRequired).toEqual([])
  })

  it('still flags a required field left unsupplied after registration', async () => {
    const repo = fakeConnections()
    const service = nativeService(repo)
    await service.register('ws1', {
      config: {
        kind: 'manifest',
        manifest: { ...baseManifest, providerConfig: { project: 'acme-web' } },
      },
      secrets: {},
    })

    const descriptor = await service.describeProvider('ws1')
    expect(descriptor.missingRequired).toEqual(['apiToken'])
  })

  // A `baseUrl` field is persisted onto the manifest's `baseUrl` (not providerConfig / the
  // secret bundle), so the missingRequired read path must count it — otherwise a required
  // baseUrl field would stay "missing" forever and the banner could never clear.
  it('clears a required `baseUrl` field once the manifest carries a baseUrl', async () => {
    const repo = fakeConnections()
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: repo,
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: registry,
      environmentProvider: {
        describeConfig: () => [{ key: 'baseUrl', label: 'Base URL', required: true }],
      } as unknown as EnvironmentProvider,
    })

    expect((await service.describeProvider('ws1')).missingRequired).toEqual(['baseUrl'])

    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })
    expect((await service.describeProvider('ws1')).missingRequired).toEqual([])
  })

  // The descriptor exposes the saved manifest so the connect form can overlay edits onto it
  // (preserving stored providerConfig) — but it must never leak a secret VALUE.
  it('exposes the saved manifest without any secret value', async () => {
    const repo = fakeConnections()
    const service = nativeService(repo)
    await service.register('ws1', {
      config: {
        kind: 'manifest',
        manifest: {
          ...baseManifest,
          providerConfig: { project: 'acme-web', nested: { a: [1, 2] } },
        },
      },
      secrets: { apiToken: 'super-secret-token' },
    })

    const descriptor = await service.describeProvider('ws1')
    expect((descriptor.savedManifest as { providerConfig: unknown }).providerConfig).toEqual({
      project: 'acme-web',
      nested: { a: [1, 2] },
    })
    expect(JSON.stringify(descriptor)).not.toContain('super-secret-token')
  })
})

// ---------------------------------------------------------------------------
// Repo lifecycle: validateRepo + bootstrapRepo. The provider supplies the
// expectations / generation; the engine supplies a VCS-neutral RepoFiles reader
// (here a fake backed by an in-memory path → content map).
// ---------------------------------------------------------------------------

function fakeRepoFiles(seed: Record<string, string> = {}): RepoFiles & {
  store: Map<string, string>
  commits: { branch: string; files: { path: string; content: string }[] }[]
  prs: number
} {
  const store = new Map(Object.entries(seed))
  const commits: { branch: string; files: { path: string; content: string }[] }[] = []
  // Model branch existence faithfully: the default branch exists, an unknown branch has
  // no head (null) until created. The PR-mode bootstrap keys idempotency off this, so a
  // fake that pretended every branch existed would hide the duplicate-PR regression.
  const branches = new Set(['main'])
  let prs = 0
  return {
    store,
    commits,
    get prs() {
      return prs
    },
    async getFile(path) {
      const content = store.get(path)
      return content != null ? { content, sha: `sha:${path}` } : null
    },
    async listDirectory() {
      return []
    },
    async headSha(branch) {
      return branches.has(branch) ? `head:${branch}` : null
    },
    async createBranch(branch) {
      branches.add(branch)
    },
    async commitFiles(input) {
      commits.push({ branch: input.branch, files: input.files })
      for (const f of input.files) store.set(f.path, f.content)
      return { sha: 'commit-sha' }
    },
    async openPullRequest() {
      prs += 1
      return { number: prs } as never
    },
  }
}

function repoCtx(repo: RepoFiles, baseBranch = 'main'): RunRepoContext {
  return { repo, baseBranch }
}

describe('EnvironmentConnectionService — validateRepo', () => {
  it('returns ok with no issues when the provider has no validateRepo', async () => {
    const service = makeService(fakeConnections())
    const result = await service.validateRepo('ws1', { owner: 'o', repo: 'r' })
    expect(result).toEqual({ ok: true, issues: [] })
  })

  it('reports an error when no VCS connection resolves the repo', async () => {
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: fakeConnections(),
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: registry,
      environmentProvider: {
        validateRepo: async () => ({ ok: true, issues: [] }),
      } as unknown as EnvironmentProvider,
      resolveRepoFilesForWorkspace: async () => null,
    })
    const result = await service.validateRepo('ws1', { owner: 'o', repo: 'r' })
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.message).toMatch(/no vcs connection/i)
  })

  it('validates without throwing when no environment connection is registered', async () => {
    // The on-demand route is documented to never throw to the client. With a provider +
    // VCS resolver wired but NO connection registered yet, it must still delegate (config
    // simply absent), not surface the requireConnection 409.
    const repo = fakeRepoFiles({ '.kargo.yml': 'name: x\njobs: [a]\n' })
    let captured: RepoValidationRequest | undefined
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: fakeConnections(),
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: registry,
      environmentProvider: {
        validateRepo: async (req: RepoValidationRequest) => {
          captured = req
          return { ok: true, issues: [] }
        },
      } as unknown as EnvironmentProvider,
      resolveRepoFilesForWorkspace: async () => repoCtx(repo),
    })

    const result = await service.validateRepo('ws1', { owner: 'o', repo: 'r' })
    expect(result).toEqual({ ok: true, issues: [] })
    expect(captured?.config).toBeUndefined()
  })

  it('delegates to the provider with a VCS-neutral reader, forwarding providerConfig + gitRef', async () => {
    const repo = fakeRepoFiles({ '.kargo.yml': 'name: x\njobs: [a]\n' })
    let captured: RepoValidationRequest | undefined
    const repoConn = fakeConnections()
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: repoConn,
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: registry,
      environmentProvider: {
        validateRepo: async (req: RepoValidationRequest) => {
          captured = req
          const file = await req.readRepoFile('.kargo.yml')
          return file
            ? { ok: true, issues: [] }
            : { ok: false, issues: [{ severity: 'error', message: 'missing', path: '.kargo.yml' }] }
        },
      } as unknown as EnvironmentProvider,
      resolveRepoFilesForWorkspace: async () => repoCtx(repo),
    })
    await service.register('ws1', {
      config: {
        kind: 'manifest',
        manifest: { ...baseManifest, providerConfig: { project: 'acme' } },
      },
      secrets: {},
    })

    const result = await service.validateRepo('ws1', { owner: 'o', repo: 'r', gitRef: 'feat/x' })
    expect(result.ok).toBe(true)
    expect(captured?.config).toEqual({ project: 'acme' })
    expect(captured?.defaultGitRef).toBe('feat/x')
    expect(captured?.repoOwner).toBe('o')
  })

  it('passes provider issues through when the repo is invalid', async () => {
    const repo = fakeRepoFiles() // no .kargo.yml
    const repoConn = fakeConnections()
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: repoConn,
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: registry,
      environmentProvider: {
        validateRepo: async (req: RepoValidationRequest) => {
          const file = await req.readRepoFile('.kargo.yml')
          return file
            ? { ok: true, issues: [] }
            : { ok: false, issues: [{ severity: 'error', message: 'missing', path: '.kargo.yml' }] }
        },
      } as unknown as EnvironmentProvider,
      resolveRepoFilesForWorkspace: async () => repoCtx(repo),
    })
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    const result = await service.validateRepo('ws1', { owner: 'o', repo: 'r' })
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([{ severity: 'error', message: 'missing', path: '.kargo.yml' }])
  })
})

describe('EnvironmentConnectionService — detect read faults', () => {
  // A RepoFiles whose reads all THROW (a non-404 from the real client: auth/permission/rate-limit).
  const throwingRepo = (): RepoFiles =>
    ({
      async getFile() {
        throw new Error('GitHub GET /repos/o/r/contents/ → 403: forbidden')
      },
      async listDirectory() {
        throw new Error('GitHub GET /repos/o/r/contents/ → 403: forbidden')
      },
    }) as unknown as RepoFiles

  function detectService() {
    return new EnvironmentConnectionService({
      environmentConnectionRepository: fakeConnections(),
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: registry,
      resolveRepoFilesForWorkspace: async () => repoCtx(throwingRepo()),
    })
  }

  it('maps an unreadable repo to an actionable validation error (service provisioning)', async () => {
    const service = detectService()
    await expect(
      service.detectServiceProvisioning('ws1', { owner: 'o', repo: 'r' }),
    ).rejects.toMatchObject({ code: 'validation' })
    // A GitHub-pinned input gets the GitHub-specific "Contents: read" guidance.
    await expect(
      service.detectServiceProvisioning('ws1', {
        owner: 'o',
        repo: 'r',
        directory: 'services/api',
        provider: 'github',
      }),
    ).rejects.toThrow(/Contents: read/)
  })

  it('tailors the read-fault guidance to the pinned VCS provider (never hardcodes GitHub)', async () => {
    const service = detectService()
    // GitLab-pinned ⇒ GitLab-specific guidance, NOT a "GitHub App"/"Contents: read" instruction
    // the user has no equivalent for.
    await expect(
      service.detectServiceProvisioning('ws1', { owner: 'o', repo: 'r', provider: 'gitlab' }),
    ).rejects.toThrow(/read_repository/)
    await expect(
      service.detectServiceProvisioning('ws1', { owner: 'o', repo: 'r', provider: 'gitlab' }),
    ).rejects.not.toThrow(/GitHub App/)
    // No provider pinned (⇒ the workspace's connected provider) stays neutral — no GitHub-only term.
    await expect(
      service.detectServiceProvisioning('ws1', { owner: 'o', repo: 'r' }),
    ).rejects.not.toThrow(/GitHub App|Contents: read/)
  })

  it('maps an unreadable repo to an actionable validation error (frontend config)', async () => {
    const service = detectService()
    await expect(
      service.detectFrontendConfig('ws1', { owner: 'o', repo: 'r' }),
    ).rejects.toMatchObject({ code: 'validation' })
  })
})

describe('EnvironmentConnectionService — bootstrapRepo', () => {
  const VALID = 'name: x\njobs: [a]\n'

  // A provider that writes `.kargo.yml` and validates it exists.
  function bootstrapProvider(over: Partial<EnvironmentProvider> = {}): EnvironmentProvider {
    return {
      validateRepo: async (req: RepoValidationRequest) => {
        const file = await req.readRepoFile('.kargo.yml')
        const ok = !!file && file.content.includes('jobs')
        return ok
          ? { ok: true, issues: [] }
          : {
              ok: false,
              issues: [
                { severity: 'error', message: file ? 'invalid' : 'missing', path: '.kargo.yml' },
              ],
            }
      },
      bootstrapProviderConfiguration: async () => ({
        files: [{ path: '.kargo.yml', content: VALID }],
        commitMessage: 'add kargo config',
      }),
      ...over,
    } as unknown as EnvironmentProvider
  }

  function serviceWith(
    provider: EnvironmentProvider,
    repo: RepoFiles,
    extra: Partial<ConstructorParameters<typeof EnvironmentConnectionService>[0]> = {},
  ) {
    return new EnvironmentConnectionService({
      environmentConnectionRepository: fakeConnections(),
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: registry,
      environmentProvider: provider,
      resolveRepoFilesForWorkspace: async () => repoCtx(repo),
      ...extra,
    })
  }

  it('fails when the provider does not support bootstrap', async () => {
    const service = serviceWith(
      { validateRepo: async () => ({ ok: true, issues: [] }) } as unknown as EnvironmentProvider,
      fakeRepoFiles(),
    )
    const result = await service.bootstrapRepo('ws1', { owner: 'o', repo: 'r', inputs: {} })
    expect(result.ok).toBe(false)
    expect(result.committed).toBe(false)
  })

  it('mechanically commits the generated config and re-validates ok', async () => {
    const repo = fakeRepoFiles()
    const service = serviceWith(bootstrapProvider(), repo)
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    const result = await service.bootstrapRepo('ws1', {
      owner: 'o',
      repo: 'r',
      inputs: { name: 'x' },
    })
    expect(result.ok).toBe(true)
    expect(result.committed).toBe(true)
    expect(repo.store.get('.kargo.yml')).toBe(VALID)
    expect(repo.commits).toHaveLength(1)
    expect(repo.commits[0]?.branch).toBe('main')
  })

  it('is idempotent: skips committing when the file already matches', async () => {
    const repo = fakeRepoFiles({ '.kargo.yml': VALID })
    const service = serviceWith(bootstrapProvider(), repo)
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    const result = await service.bootstrapRepo('ws1', { owner: 'o', repo: 'r', inputs: {} })
    expect(result.ok).toBe(true)
    expect(result.committed).toBe(false)
    expect(repo.commits).toHaveLength(0)
  })

  it('opens a PR onto the target branch when openPr is set', async () => {
    const repo = fakeRepoFiles()
    const service = serviceWith(bootstrapProvider(), repo)
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    const result = await service.bootstrapRepo('ws1', {
      owner: 'o',
      repo: 'r',
      inputs: {},
      openPr: true,
    })
    expect(result.committed).toBe(true)
    expect(result.branch).toBe('cat-factory/env-config')
    expect(repo.prs).toBe(1)
  })

  it('openPr re-run is idempotent: no duplicate commit or PR when content is unchanged', async () => {
    const repo = fakeRepoFiles()
    const service = serviceWith(bootstrapProvider(), repo)
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    const first = await service.bootstrapRepo('ws1', {
      owner: 'o',
      repo: 'r',
      inputs: {},
      openPr: true,
    })
    expect(first.committed).toBe(true)
    expect(repo.prs).toBe(1)

    // Re-running with identical generated content must compare against the (already
    // populated) PR branch — not the still-unmerged target — so nothing is re-committed
    // and no second PR is opened against the same head.
    const second = await service.bootstrapRepo('ws1', {
      owner: 'o',
      repo: 'r',
      inputs: {},
      openPr: true,
    })
    expect(second.committed).toBe(false)
    expect(repo.commits).toHaveLength(1)
    expect(repo.prs).toBe(1)
  })

  it('starts an async repair run (returns repairJobId, ok pending) when generation needs an agent and the caller allows it', async () => {
    const repo = fakeRepoFiles({ '.kargo.yml': 'broken: [' })
    let dispatchedRef: { owner: string; repo: string; gitRef: string } | null = null
    const service = serviceWith(
      bootstrapProvider({
        bootstrapProviderConfiguration: async () => ({
          files: [],
          needsAgent: true,
          issues: [{ severity: 'error', message: 'cannot merge existing config' }],
        }),
        describeRepairAgent: () => ({ prompt: 'fix the kargo config' }),
      }),
      repo,
      {
        // The dispatcher now only STARTS the durable repair run and returns its jobId — it
        // does NOT await the agent and the service does NOT re-validate inline.
        dispatchConfigRepair: async (input) => {
          dispatchedRef = { owner: input.owner, repo: input.repo, gitRef: input.gitRef }
          return { jobId: 'envfix_1' }
        },
      },
    )
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    const result = await service.bootstrapRepo('ws1', {
      owner: 'o',
      repo: 'r',
      inputs: {},
      allowAgentFallback: true,
    })
    expect(dispatchedRef).toEqual({ owner: 'o', repo: 'r', gitRef: 'main' })
    expect(result.usedAgent).toBe(true)
    expect(result.repairJobId).toBe('envfix_1')
    // ok is PENDING (false) — the repair run re-validates later via revalidate().
    expect(result.ok).toBe(false)
  })

  it('revalidate re-runs the provider validation at a ref (the repair run completion callback)', async () => {
    const repo = fakeRepoFiles({ '.kargo.yml': 'broken: [' })
    const service = serviceWith(
      bootstrapProvider({ describeRepairAgent: () => ({ prompt: 'fix' }) }),
      repo,
    )
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    // Still invalid → ok:false.
    const before = await service.revalidate({
      workspaceId: 'ws1',
      owner: 'o',
      repo: 'r',
      gitRef: 'main',
    })
    expect(before.ok).toBe(false)

    // The agent's fix landed → ok:true on re-validation.
    repo.store.set('.kargo.yml', VALID)
    const after = await service.revalidate({
      workspaceId: 'ws1',
      owner: 'o',
      repo: 'r',
      gitRef: 'main',
    })
    expect(after.ok).toBe(true)
  })

  it('does not dispatch the agent when needsAgent but the caller did not opt in', async () => {
    const repo = fakeRepoFiles({ '.kargo.yml': 'broken: [' })
    let dispatched = false
    const service = serviceWith(
      bootstrapProvider({
        bootstrapProviderConfiguration: async () => ({ files: [], needsAgent: true, issues: [] }),
        describeRepairAgent: () => ({ prompt: 'fix' }),
      }),
      repo,
      {
        dispatchConfigRepair: async () => {
          dispatched = true
          return { jobId: 'envfix_x' }
        },
      },
    )
    await service.register('ws1', {
      config: { kind: 'manifest', manifest: baseManifest },
      secrets: {},
    })

    const result = await service.bootstrapRepo('ws1', { owner: 'o', repo: 'r', inputs: {} })
    expect(dispatched).toBe(false)
    expect(result.usedAgent).toBeUndefined()
    expect(result.repairJobId).toBeUndefined()
  })
})

describe('EnvironmentConnectionService — testHandler (per-type handler probe)', () => {
  // A backend that records the probe it received, so the test asserts testHandler resolves the
  // engine to this backend, lowers the kube engine config (apiServerUrl → the probed manifest's
  // baseUrl), and resolves the supplied (unsaved) secret — all without a real apiserver call.
  function recordingKubeBackend() {
    const calls: { token: string | undefined; baseUrl: string }[] = []
    const backend: EnvironmentBackendProvider = {
      kind: 'kubernetes',
      engines: () => ['local-k3s', 'remote-kubernetes'],
      referencedSecretKeys: () => ['apiToken'],
      connectionMeta: () => ({ providerId: 'kubernetes', label: 'k', baseUrl: 'b' }),
      assertConfigSafe: () => {},
      toManifest: (config) => {
        if (!('kubernetes' in config)) throw new Error('expected a kubernetes config')
        return {
          providerId: 'kubernetes',
          label: config.kubernetes.label,
          baseUrl: config.kubernetes.apiServerUrl,
          auth: { type: 'none' },
          provision: { method: 'POST', pathTemplate: '/' },
          response: {},
        } as EnvironmentManifest
      },
      fromManifest: () => ({ kind: 'kubernetes' }) as unknown as EnvironmentBackendConfig,
      buildProvider: () =>
        ({
          testConnection: async (req: EnvironmentConnectionTestRequest) => {
            calls.push({
              token: req.resolveSecret('apiToken'),
              baseUrl: (req.manifest as { baseUrl: string }).baseUrl,
            })
            return { ok: true, message: 'reached' }
          },
        }) as unknown as EnvironmentProvider,
    }
    return { backend, calls }
  }

  it('lowers a kube engine config + resolves the unsaved token, then probes the backend', async () => {
    const { backend, calls } = recordingKubeBackend()
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: fakeConnections(),
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: new EnvironmentBackendRegistry().register(backend),
    })

    const result = await service.testHandler('ws1', {
      config: {
        engine: 'remote-kubernetes',
        kubernetes: {
          label: 'Cluster',
          apiServerUrl: 'https://cluster.test:6443',
          url: { source: 'ingressStatus' },
        },
      },
      secrets: { apiToken: 'sa-token' },
    })

    expect(result).toEqual({ ok: true, message: 'reached' })
    expect(calls).toEqual([{ token: 'sa-token', baseUrl: 'https://cluster.test:6443' }])
  })

  it('rejects an SSRF-unsafe apiserver before any network call', async () => {
    const service = makeService(fakeConnections())
    await expect(
      service.testHandler('ws1', {
        config: {
          engine: 'remote-kubernetes',
          kubernetes: {
            label: 'Cluster',
            apiServerUrl: 'https://169.254.169.254',
            url: { source: 'ingressStatus' },
          },
        },
        secrets: { apiToken: 't' },
      }),
    ).rejects.toThrow()
  })

  const kubeCandidate = {
    engine: 'remote-kubernetes',
    kubernetes: {
      label: 'Cluster',
      apiServerUrl: 'https://cluster.test:6443',
      url: { source: 'ingressStatus' },
    },
  } as const

  it('falls back to the SAVED token when the probe omits it (test an existing connection)', async () => {
    const { backend, calls } = recordingKubeBackend()
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: fakeConnections(),
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: new EnvironmentBackendRegistry().register(backend),
    })
    // Save a handler with a token the edit form will never surface again.
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: kubeCandidate,
      secrets: { apiToken: 'stored-sa-token' },
    })

    // Retest with NO secrets (as the edit form does — the token field is blank) → the stored
    // token must reach the provider, so the probe authenticates.
    const result = await service.testHandler('ws1', { config: kubeCandidate })
    expect(result.ok).toBe(true)
    expect(calls.at(-1)?.token).toBe('stored-sa-token')
  })

  it('prefers a freshly-supplied token over the stored one when re-testing', async () => {
    const { backend, calls } = recordingKubeBackend()
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: fakeConnections(),
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentBackendRegistry: new EnvironmentBackendRegistry().register(backend),
    })
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: kubeCandidate,
      secrets: { apiToken: 'stored-sa-token' },
    })

    const result = await service.testHandler('ws1', {
      config: kubeCandidate,
      secrets: { apiToken: 'freshly-typed' },
    })
    expect(result.ok).toBe(true)
    expect(calls.at(-1)?.token).toBe('freshly-typed')
  })
})

// Editing a saved handler must PRESERVE its write-only token when the operator leaves the
// secret field blank (the edit form omits it), and REPLACE it only when a new value is typed.
describe('EnvironmentConnectionService — registerHandler secret preservation', () => {
  const kubeConfig = {
    engine: 'remote-kubernetes',
    kubernetes: {
      label: 'Cluster',
      apiServerUrl: 'https://cluster.example.test:6443',
      url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.example.test' },
    },
  } as const

  it('keeps the stored token when re-registered with no secrets (non-secret edit)', async () => {
    const service = makeService(fakeConnections())
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: kubeConfig,
      secrets: { apiToken: 'original-token' },
    })

    // Re-save with a changed label and NO secrets — must not wipe the token (would 422 on the
    // missing referenced key if it weren't preserved), and must still report the key as set.
    const view = await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: {
        engine: 'remote-kubernetes',
        kubernetes: { ...kubeConfig.kubernetes, label: 'Renamed cluster' },
      },
      secrets: {},
    })
    expect(view.label).toBe('Renamed cluster')
    expect(view.secretKeys).toContain('apiToken')

    const resolved = await service.resolveProviderForType('ws1', {
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/k8s' },
    })
    expect(resolved.resolveSecret('apiToken')).toBe('original-token')
  })

  it('replaces the stored token when a new value is supplied', async () => {
    const service = makeService(fakeConnections())
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: kubeConfig,
      secrets: { apiToken: 'original-token' },
    })
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: kubeConfig,
      secrets: { apiToken: 'rotated-token' },
    })

    const resolved = await service.resolveProviderForType('ws1', {
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/k8s' },
    })
    expect(resolved.resolveSecret('apiToken')).toBe('rotated-token')
  })

  it('treats a blank secret value as "keep the stored token" (not a wipe)', async () => {
    const service = makeService(fakeConnections())
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: kubeConfig,
      secrets: { apiToken: 'original-token' },
    })
    await service.registerHandler('ws1', {
      provisionType: 'kubernetes',
      config: kubeConfig,
      secrets: { apiToken: '   ' },
    })

    const resolved = await service.resolveProviderForType('ws1', {
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/k8s' },
    })
    expect(resolved.resolveSecret('apiToken')).toBe('original-token')
  })
})
