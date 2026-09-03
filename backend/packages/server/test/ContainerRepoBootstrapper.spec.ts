import { describe, expect, it, vi } from 'vitest'
import type {
  BootstrapJobRecord,
  BootstrapJobRepository,
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { ContainerRepoBootstrapper } from '../src/agents/ContainerRepoBootstrapper.js'
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

/**
 * A GitHubClient that pre-flights cleanly except for the bits a test overrides.
 *
 * The target holds a README, which is what a repository created through either the host's
 * new-repo page or the platform's own button looks like: boilerplate the bootstrap tolerates,
 * and the initial commit a pull request is opened against. A test about the EMPTY repository
 * overrides `listRootEntries` to say so.
 */
function fakeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const base = {
    getRepo: vi.fn(async () => ({ defaultBranch: 'main', githubId: 1 })),
    canPush: vi.fn(async () => true),
    listRootEntries: vi.fn(async () => [{ path: 'README.md', type: 'file' }]),
    listDirectory: vi.fn(async () => []),
    ...overrides,
  }
  return base as unknown as GitHubClient
}

/**
 * The stored run a poll reads its target off. Only the fields the poll consults are populated:
 * whether the run has a monorepo (which decides what a completed run can NAME) and the repo
 * name a new-repo outcome is built from.
 */
function fakeJobRepository(record: Partial<BootstrapJobRecord> = {}): BootstrapJobRepository {
  return {
    get: vi.fn(async () => ({
      id: 'boot_1',
      workspaceId: 'ws_1',
      repoName: 'simpler-service3',
      monorepo: null,
      delivery: 'direct_push',
      ...record,
    })),
  } as unknown as BootstrapJobRepository
}

function makeBootstrapper(
  client: GitHubClient,
  transport: RunnerTransport,
  bootstrapJobRepository: BootstrapJobRepository = fakeJobRepository(),
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
    bootstrapJobRepository,
    repoRepository: {} as never,
    githubClient: client,
    mintInstallationToken: vi.fn(async () => 'gh-token'),
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
  delivery: { mode: 'direct_push' } as const,
  instructions: 'Scaffold a service.',
}

/** The same run asked to deliver its scaffold as a pull request instead. */
const PR_REQUEST = {
  ...REQUEST,
  delivery: {
    mode: 'pull_request',
    branch: 'cat-factory/bootstrap-boot_1',
    pr: { title: 'Bootstrap simpler-service3', body: 'the fallback body' },
  } as const,
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
}

/** The delivery a monorepo apply takes by default: a work branch and one pull request. */
const MONOREPO_DELIVERY = {
  mode: 'pull_request',
  branch: 'cat-factory/bootstrap-boot_1',
  pr: { title: 'Bootstrap payments at services/payments', body: 'the settled decisions' },
} as const

/** The resolved monorepo a stored run carries, as the poll reads it back. */
const MONOREPO_REF = {
  repoGithubId: 777,
  directory: 'services/payments',
  repoOwner: 'acme',
  repoName: 'platform',
  branch: MONOREPO_DELIVERY.branch,
}

const MONOREPO_REQUEST = {
  ...REQUEST,
  containerJobId: 'boot_1:apply',
  referenceRepo: { owner: 'acme', name: 'service-template' },
  monorepo: MONOREPO_LEG,
  delivery: MONOREPO_DELIVERY,
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
    expect(body.newBranch).toBe(MONOREPO_DELIVERY.branch)
    expect(body.pr).toEqual(MONOREPO_DELIVERY.pr)
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

  it('reports the pull request a completed apply opened, and NO created repository', async () => {
    const poll = vi.fn(async (): Promise<RunnerJobView> => ({
      state: 'done',
      result: {
        prUrl: 'https://github.com/acme/platform/pull/7',
        branch: MONOREPO_DELIVERY.branch,
      },
    }))
    const bootstrapper = makeBootstrapper(
      fakeClient(),
      { poll } as unknown as RunnerTransport,
      fakeJobRepository({ monorepo: MONOREPO_REF, delivery: 'pull_request' }),
    )
    const update = await bootstrapper.pollBootstrap({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1:apply',
    })
    expect(update.state).toBe('done')
    expect(update.prUrl).toBe('https://github.com/acme/platform/pull/7')
    // The run created no repository, so naming one would name a URL that does not resolve.
    expect(update.outcome).toBeUndefined()
  })

  it('omits the branch and the PR together when the run pushes directly', async () => {
    // The direct-push delivery is the same coding job MINUS the pair: the harness then commits
    // onto `branch`, the monorepo's own default. A body carrying one of the two and not the
    // other is the failure this asserts against.
    const dispatch = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(fakeClient(), {
      dispatch,
    } as unknown as RunnerTransport)
    await bootstrapper.startBootstrap({
      ...MONOREPO_REQUEST,
      delivery: { mode: 'direct_push' } as const,
    })
    const [, body] = dispatch.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(body.branch).toBe('main')
    expect(body.newBranch).toBeUndefined()
    expect(body.pr).toBeUndefined()
    // Still never a force-push: the monorepo holds other people's services either way.
    expect(body.bootstrap).toBeUndefined()
    expect(body.repo).toMatchObject({ serviceDirectory: 'services/payments' })
  })
})

describe('ContainerRepoBootstrapper new-repo pull-request delivery', () => {
  it('dispatches a work-branch coding job against the target, never the force-push spec', async () => {
    // A branch whose history was reinitialised shares no ancestor with the default branch, so a
    // pull request cannot be opened from it. This delivery therefore clones the TARGET and
    // treats the template as a read-only sibling, exactly as the monorepo path does.
    const dispatch = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(fakeClient(), {
      dispatch,
    } as unknown as RunnerTransport)
    await bootstrapper.startBootstrap({
      ...PR_REQUEST,
      referenceRepo: { owner: 'acme', name: 'service-template' },
    })
    const [, body] = dispatch.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(body.bootstrap).toBeUndefined()
    expect(body.repo).toMatchObject({ owner: 'kibertoad', name: 'simpler-service3' })
    // No service directory: the whole checkout IS the new service.
    expect(body.repo).not.toHaveProperty('serviceDirectory')
    expect(body.newBranch).toBe(PR_REQUEST.delivery.branch)
    expect(body.pr).toEqual(PR_REQUEST.delivery.pr)
    const references = body.referenceRepos as { repo: Record<string, string> }[]
    expect(references[0]?.repo).toMatchObject({ owner: 'acme', name: 'service-template' })
  })

  it('refuses a repository with no commits, naming both ways out', async () => {
    // `listRootEntries` answers `[]` for a repository that has never been committed to, and a
    // pull request needs a base commit. Refusing here beats failing deep inside the clone,
    // where the message would read like an outage.
    const dispatch = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(fakeClient({ listRootEntries: vi.fn(async () => []) }), {
      dispatch,
    } as unknown as RunnerTransport)
    await expect(bootstrapper.startBootstrap(PR_REQUEST)).rejects.toThrow(/no commits yet/i)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('accepts the same repository for a direct push, which writes that first commit', async () => {
    // The floor is a PULL-REQUEST rule, not a bootstrap rule: the delivery whose whole job is to
    // create the initial commit must not be refused for the repository not having one.
    const dispatch = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(fakeClient({ listRootEntries: vi.fn(async () => []) }), {
      dispatch,
    } as unknown as RunnerTransport)
    await bootstrapper.startBootstrap(REQUEST)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('reports the created repository AND the pull request when the run completes', async () => {
    // Unlike a monorepo run, this one really did create a repository, so a caller gets both:
    // the repo to link the board frame to, and the pull request to review.
    const poll = vi.fn(async (): Promise<RunnerJobView> => ({
      state: 'done',
      result: { prUrl: 'https://github.com/kibertoad/simpler-service3/pull/1' },
    }))
    const bootstrapper = makeBootstrapper(
      fakeClient(),
      { poll } as unknown as RunnerTransport,
      fakeJobRepository({ delivery: 'pull_request' }),
    )
    const update = await bootstrapper.pollBootstrap({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1',
    })
    expect(update.prUrl).toBe('https://github.com/kibertoad/simpler-service3/pull/1')
    expect(update.outcome).toMatchObject({ owner: 'kibertoad', name: 'simpler-service3' })
  })
})
