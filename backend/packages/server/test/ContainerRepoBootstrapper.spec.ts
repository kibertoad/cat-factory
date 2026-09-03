import { describe, expect, it, vi } from 'vitest'
import { VcsApiError } from '@cat-factory/kernel'
import type {
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { ContainerRepoBootstrapper } from '../src/agents/ContainerRepoBootstrapper.js'
import type { MintInstallationToken } from '../src/agents/repoTargeting.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The bootstrap pre-flight gates a force-push run: the target must exist, be empty,
// AND be *writable* by the installation. The write check is the one tested here — a
// public target the App can read but is not granted (not in the App's selected-repos
// list) passes existence/emptiness but would 403 on the container's push, so it must
// fail fast before any board frame is created. The integration/conformance suites run
// bootstrap through a FakeRepoBootstrapper (no GitHub), so this exercises the real
// bootstrapper's pre-flight directly against a faked GitHubClient.

const INSTALLATION: GitHubInstallation = {
  installationId: 99,
  workspaceId: 'ws_1',
  accountId: 'acc_1',
  accountLogin: 'kibertoad',
  targetType: 'User',
  provider: 'github',
  appId: 'app-default',
  cachedToken: null,
  tokenExpiresAt: null,
  accessToken: null,
  createdAt: 0,
  deletedAt: null,
}

/** A GitHubClient that pre-flights cleanly except for the bits a test overrides. */
function fakeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const base = {
    getRepo: vi.fn(async () => ({ defaultBranch: 'main', githubId: 1 })),
    canPush: vi.fn(async () => true),
    listRootEntries: vi.fn(async () => []),
    listDirectory: vi.fn(async () => []),
    ...overrides,
  }
  return base as unknown as GitHubClient
}

/** The dispatch-token mint, so a test can read the `repoIds` a run was scoped to. */
type MintSpy = ReturnType<typeof makeMint>
function makeMint() {
  return vi.fn<MintInstallationToken>(async () => 'gh-token')
}

function makeBootstrapper(
  client: GitHubClient,
  transport: RunnerTransport,
  mint: MintSpy = makeMint(),
): ContainerRepoBootstrapper {
  const installationRepository = {
    getByWorkspace: vi.fn(async () => INSTALLATION),
  } as unknown as GitHubInstallationRepository
  const sessionService = {
    mint: vi.fn(async () => 'session-token'),
  } as unknown as ContainerSessionService
  return new ContainerRepoBootstrapper({
    resolveTransport: async () => transport,
    installationRepository,
    bootstrapJobRepository: {} as never,
    repoRepository: {} as never,
    githubClient: client,
    mintInstallationToken: mint,
    sessionService,
    model: { provider: 'workers-ai', model: '@cf/test' },
    proxyBaseUrl: 'https://proxy.example/v1',
  })
}

const REQUEST = {
  workspaceId: 'ws_1',
  jobId: 'boot_1',
  // A new-repo run is one drive, so the container job id is the run id.
  containerJobId: 'boot_1',
  target: { name: 'simpler-service3', description: '', private: false },
  instructions: 'Scaffold a service.',
}

describe('ContainerRepoBootstrapper pre-flight', () => {
  it('rejects before dispatch when the App can read but cannot push to the target', async () => {
    const dispatch = vi.fn(async () => undefined)
    const client = fakeClient({ canPush: vi.fn(async () => false) })
    const bootstrapper = makeBootstrapper(client, { dispatch } as unknown as RunnerTransport)

    await expect(bootstrapper.startBootstrap(REQUEST)).rejects.toThrow(
      /does not have write access/i,
    )
    // The container is never dispatched on a write-access pre-flight failure.
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches the container when the App has write access', async () => {
    const dispatch = vi.fn(async () => undefined)
    const client = fakeClient()
    const bootstrapper = makeBootstrapper(client, { dispatch } as unknown as RunnerTransport)

    const handle = await bootstrapper.startBootstrap(REQUEST)
    expect(handle).toEqual({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1',
    })
    expect(client.canPush).toHaveBeenCalledWith(99, {
      owner: 'kibertoad',
      repo: 'simpler-service3',
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    // A bootstrap is a first-class agent run (same `agent_runs` table, same retry surface), so
    // its job body carries the same correlation ids an execution step's does — without them the
    // container's own log lines join to nothing. No separate execution row: the job id IS the
    // run id, which is what the session token is minted against.
    const [, spec] = dispatch.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(spec.workspaceId).toBe('ws_1')
    expect(spec.executionId).toBe('boot_1')
  })
})

describe('ContainerRepoBootstrapper.pollBootstrap', () => {
  it('classifies eviction from the STRUCTURED field (no string sentinel needed)', async () => {
    // A newer transport reports the eviction verdict as a field; the error text carries no
    // `(container evicted or crashed)` sentinel, so this proves the structured field is
    // load-bearing and not merely the regex fallback firing on the message.
    const poll = vi.fn(async (): Promise<RunnerJobView> => ({
      state: 'failed',
      error: 'the runner container was reaped',
      evicted: 'crash',
    }))
    const bootstrapper = makeBootstrapper(fakeClient(), { poll } as unknown as RunnerTransport)

    const update = await bootstrapper.pollBootstrap({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1',
    })
    expect(update.state).toBe('failed')
    expect(update).toMatchObject({ failureKind: 'evicted' })
  })
})

/** The monorepo leg a two-phase run's apply dispatches with. */
const MONOREPO_LEG = {
  repoGithubId: 777,
  owner: 'acme',
  name: 'platform',
  directory: 'services/payments',
  branch: 'cat-factory/bootstrap-boot_1',
  pr: { title: 'Bootstrap payments at services/payments', body: 'the settled decisions' },
}

const MONOREPO_REQUEST = {
  ...REQUEST,
  containerJobId: 'boot_1:apply',
  referenceRepo: { owner: 'acme', name: 'service-template' },
  monorepo: MONOREPO_LEG,
}

describe('ContainerRepoBootstrapper monorepo dispatch', () => {
  /** The dispatched job body, so each assertion below reads one fact off it. */
  async function dispatchMonorepo(client: GitHubClient = fakeClient()) {
    const dispatch = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(client, { dispatch } as unknown as RunnerTransport)
    const handle = await bootstrapper.startBootstrap(MONOREPO_REQUEST)
    const [, body] = dispatch.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    return { handle, body, dispatch }
  }

  it('dispatches a work-branch-and-pull-request coding job, never a force-push', async () => {
    // The single most important property of this path. The new-repo flow reinitialises history
    // and force-pushes; doing that to a monorepo would destroy every other service in it, so the
    // dispatch must carry NO bootstrap spec and must name a work branch off the default one.
    const { body } = await dispatchMonorepo()
    expect(body.bootstrap).toBeUndefined()
    expect(body.branch).toBe('main')
    expect(body.newBranch).toBe(MONOREPO_LEG.branch)
    expect(body.pr).toEqual(MONOREPO_LEG.pr)
  })

  it('scopes the agent to the new subdirectory through the same field every monorepo run uses', async () => {
    const { body } = await dispatchMonorepo()
    expect(body.repo).toMatchObject({
      owner: 'acme',
      name: 'platform',
      serviceDirectory: 'services/payments',
    })
  })

  it('checks out the reference template as a READ-ONLY sibling', async () => {
    // `referenceRepos` carries no branch or PR fields at all, so the run is structurally
    // incapable of pushing to the template it is copying from.
    const { body } = await dispatchMonorepo()
    const references = body.referenceRepos as { repo: Record<string, string> }[]
    expect(references).toHaveLength(1)
    expect(references[0]?.repo).toMatchObject({ owner: 'acme', name: 'service-template' })
    expect(references[0]).not.toHaveProperty('newBranch')
    expect(references[0]).not.toHaveProperty('pr')
  })

  it('dispatches and polls under the APPLY drive id, not the run id', async () => {
    // The survey drive already used the run id, so reusing it would attach this dispatch to a
    // container inventory entry and a durable instance that have both gone terminal.
    const { handle, body, dispatch } = await dispatchMonorepo()
    expect(handle).toEqual({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1:apply',
    })
    expect(body.jobId).toBe('boot_1:apply')
    const [, ref] = dispatch.mock.calls[0] as unknown as [string, unknown]
    expect(body.executionId).toBe('boot_1:apply')
    expect(ref).toBeDefined()
  })

  it('refuses before dispatch when the App cannot write to the monorepo', async () => {
    const dispatch = vi.fn(async () => undefined)
    const client = fakeClient({ canPush: vi.fn(async () => false) })
    const bootstrapper = makeBootstrapper(client, { dispatch } as unknown as RunnerTransport)
    await expect(bootstrapper.startBootstrap(MONOREPO_REQUEST)).rejects.toThrow(
      /does not have write access/i,
    )
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses before dispatch when the target directory appeared since the review started', async () => {
    // The orchestration pre-flighted an empty directory before the survey, and a review can be
    // settled days later. Writing over whatever landed in between is the one outcome a bootstrap
    // must never produce.
    const dispatch = vi.fn(async () => undefined)
    const client = fakeClient({
      listDirectory: vi.fn(async () => [
        { path: 'services/payments/index.ts', name: 'index.ts', type: 'file', sha: 'x' },
      ]),
    } as unknown as Partial<GitHubClient>)
    const bootstrapper = makeBootstrapper(client, { dispatch } as unknown as RunnerTransport)
    await expect(bootstrapper.startBootstrap(MONOREPO_REQUEST)).rejects.toThrow(/already exists/i)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reports the pull request a completed apply opened', async () => {
    const poll = vi.fn(async (): Promise<RunnerJobView> => ({
      state: 'done',
      result: { prUrl: 'https://github.com/acme/platform/pull/7', branch: MONOREPO_LEG.branch },
    }))
    const bootstrapper = makeBootstrapper(fakeClient(), { poll } as unknown as RunnerTransport)
    const update = await bootstrapper.pollBootstrap({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1:apply',
    })
    expect(update.state).toBe('done')
    expect(update.prUrl).toBe('https://github.com/acme/platform/pull/7')
  })
})

// The reference template is reached through the workspace's INSTALLATION, not through its repo
// projection. That is the pair the apply phase's clone actually depends on, and resolving it
// anywhere else is what let a survey report "nobody looked at the template" for a repository the
// container then cloned without trouble.
describe('ContainerRepoBootstrapper.resolveReferenceRepo', () => {
  const TEMPLATE = { owner: 'acme', name: 'service-template' }

  it('binds checkout-free reads at the template’s OWN default branch', async () => {
    const client = fakeClient({
      getRepo: vi.fn(async () => ({ defaultBranch: 'trunk', githubId: 55 })),
      getFileContent: vi.fn(async () => ({ content: 'module.exports = {}', sha: 'abc' })),
    } as unknown as Partial<GitHubClient>)
    const bootstrapper = makeBootstrapper(client, {} as RunnerTransport)

    const access = await bootstrapper.resolveReferenceRepo('ws_1', TEMPLATE)
    expect(access.status).toBe('reachable')
    if (access.status !== 'reachable') return
    // Not `main`: a template whose default branch is anything else was read at a branch that
    // does not exist, which the contents API answers as "absent" for every file in it.
    expect(access.defaultBranch).toBe('trunk')
    await access.files.getFile('jest.config.js', access.defaultBranch)
    expect(client.getFileContent).toHaveBeenCalledWith(
      99,
      { owner: 'acme', repo: 'service-template' },
      'jest.config.js',
      'trunk',
    )
  })

  it('reports a 404 as NOT FOUND and any other failure as UNREADABLE', async () => {
    // The distinction the caller turns into two different refusals: one says the entry is wrong,
    // the other says the provider is down. Collapsing them tells an operator to go and fix a
    // configuration that is already correct.
    const missing = makeBootstrapper(
      fakeClient({
        getRepo: vi.fn(async () => {
          throw new VcsApiError('github', 404, 'GitHub GET /repos/acme/service-template → 404')
        }),
      } as unknown as Partial<GitHubClient>),
      {} as RunnerTransport,
    )
    expect(await missing.resolveReferenceRepo('ws_1', TEMPLATE)).toEqual({ status: 'not_found' })

    const down = makeBootstrapper(
      fakeClient({
        getRepo: vi.fn(async () => {
          throw new VcsApiError('github', 500, 'GitHub GET /repos/acme/service-template → 500')
        }),
      } as unknown as Partial<GitHubClient>),
      {} as RunnerTransport,
    )
    const outage = await down.resolveReferenceRepo('ws_1', TEMPLATE)
    expect(outage.status).toBe('unreadable')
  })
})

describe('ContainerRepoBootstrapper reference-template dispatch', () => {
  const REFERENCE_REQUEST = {
    ...REQUEST,
    referenceRepo: { owner: 'acme', name: 'service-template' },
  }

  it('scopes the new-repo job’s token to the template it clones, at the template’s branch', async () => {
    // Without the template in `repoIds` the minted token cannot read it, so a PRIVATE template
    // was uncloneable and the run reported a bare git failure; without its own default branch a
    // template on anything but `main` was cloned at a ref that does not exist.
    const mint = makeMint()
    const dispatch = vi.fn(async () => undefined)
    const client = fakeClient({
      getRepo: vi.fn(async (_id: number, ref: { repo: string }) =>
        ref.repo === 'service-template'
          ? { defaultBranch: 'trunk', githubId: 55 }
          : { defaultBranch: 'main', githubId: 1 },
      ),
    } as unknown as Partial<GitHubClient>)
    const bootstrapper = makeBootstrapper(client, { dispatch } as unknown as RunnerTransport, mint)

    await bootstrapper.startBootstrap(REFERENCE_REQUEST)
    expect(mint.mock.calls[0]?.[1]?.repoIds).toEqual(['1', '55'])
    const [, body] = dispatch.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(body.repo).toMatchObject({ name: 'service-template', baseBranch: 'trunk' })
  })

  it('refuses before dispatch when the template cannot be read, naming it', async () => {
    // The run is pre-flighted at start, but an apply dispatch can be days later. A swallowed
    // failure here scoped the token to the monorepo alone and left the harness reporting a bare
    // clone error about a sibling checkout nobody had named.
    const dispatch = vi.fn(async () => undefined)
    const client = fakeClient({
      getRepo: vi.fn(async (_id: number, ref: { repo: string }) => {
        if (ref.repo === 'service-template') {
          throw new VcsApiError('github', 404, 'GitHub GET /repos/acme/service-template → 404')
        }
        return { defaultBranch: 'main', githubId: 1 }
      }),
    } as unknown as Partial<GitHubClient>)
    const bootstrapper = makeBootstrapper(client, { dispatch } as unknown as RunnerTransport)

    await expect(bootstrapper.startBootstrap(MONOREPO_REQUEST)).rejects.toThrow(
      /reference template acme\/service-template cannot be read/i,
    )
    expect(dispatch).not.toHaveBeenCalled()
  })
})
