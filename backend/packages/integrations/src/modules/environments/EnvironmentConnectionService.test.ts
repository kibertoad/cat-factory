import { describe, expect, it } from 'vitest'
import type {
  Clock,
  EnvironmentConnectionRecord,
  EnvironmentConnectionRepository,
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
  const records = new Map<string, EnvironmentConnectionRecord>()
  return {
    records,
    async getByWorkspace(workspaceId) {
      const r = records.get(workspaceId)
      return r && !r.deletedAt ? r : null
    },
    async upsert(record) {
      records.set(record.workspaceId, record)
    },
    async softDelete(workspaceId, at) {
      const r = records.get(workspaceId)
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
