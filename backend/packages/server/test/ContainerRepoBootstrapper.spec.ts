import { describe, expect, it, vi } from 'vitest'
import type {
  BootstrapJobRecord,
  BootstrapJobRepository,
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  RecordAgentContextInput,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { REPO_BOOTSTRAP_AGENT_KIND } from '@cat-factory/contracts'
import {
  ContainerRepoBootstrapper,
  type ContainerRepoBootstrapperDependencies,
} from '../src/agents/ContainerRepoBootstrapper.js'
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
  overrides: Partial<ContainerRepoBootstrapperDependencies> = {},
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
    bootstrapJobRepository: fakeJobRepository(),
    repoRepository: {} as never,
    githubClient: client,
    mintInstallationToken: vi.fn(async () => 'gh-token'),
    sessionService,
    model: { provider: 'workers-ai', model: '@cf/test' },
    proxyBaseUrl: 'https://proxy.example/v1',
    ...overrides,
  })
}

/**
 * A client that answers a DISTINCT numeric id per repository, so a test can tell the push target
 * and the reference template apart in one token scope, and reports a non-conventional default
 * branch so a hard-coded `main` cannot pass for a read of the real one.
 */
function idPerRepoClient(): GitHubClient {
  return fakeClient({
    getRepo: vi.fn(async (_installationId: number, ref: { owner: string; repo: string }) => ({
      defaultBranch: 'trunk',
      githubId: ref.repo === 'service-template' ? 77 : 1,
    })),
  } as unknown as Partial<GitHubClient>)
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

  it(`records the new-repo dispatch as the run's FIRST step, naming the push target`, async () => {
    // A new-repo run is one step, so its snapshot is step 0 rather than the 2 a monorepo apply
    // files: the numbering comes from the shared step derivation, which is also what the board
    // draws, so a snapshot can never key to a step the run does not show.
    const record = vi.fn(async (_input: RecordAgentContextInput) => undefined)
    const bootstrapper = makeBootstrapper(
      fakeClient(),
      { dispatch: vi.fn(async () => undefined) } as unknown as RunnerTransport,
      { agentContextObservability: { record } },
    )
    await bootstrapper.startBootstrap(REQUEST)
    const snapshot = record.mock.calls[0]?.[0]
    expect(snapshot).toMatchObject({ executionId: 'boot_1', stepIndex: 0 })
    // Where it PUSHES, which the clone-source `repo` field does not answer on a from-scratch run.
    expect(snapshot?.extras).toMatchObject({
      bootstrapTarget: { owner: 'kibertoad', name: 'simpler-service3' },
    })
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
    expect(ref).toBeDefined()
  })

  it('files the apply phase under the RUN, so both phases answer one observability read', async () => {
    // The other half of the id split above, and the one that is NOT the drive: `executionId` is
    // what every run-scoped telemetry read is keyed by, so filing the apply under its drive id
    // put a monorepo run's second (and much more expensive) phase somewhere no reader looks,
    // on a run whose survey rows were right there under the run id.
    const { body } = await dispatchMonorepo()
    expect(body.executionId).toBe('boot_1')
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

  it('mints the proxy session against the RUN, so proxied calls land under it too', async () => {
    // The proxy stamps `llm_call_metrics.executionId` off the SESSION TOKEN, not off the body,
    // so the two have to name the same run or the apply's model calls and its tool calls end up
    // filed under different ids.
    const mint = vi.fn(async () => 'session-token')
    const bootstrapper = makeBootstrapper(
      fakeClient(),
      { dispatch: vi.fn(async () => undefined) } as unknown as RunnerTransport,
      { sessionService: { mint } as unknown as ContainerSessionService },
    )
    await bootstrapper.startBootstrap(MONOREPO_REQUEST)
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'boot_1', agentKind: REPO_BOOTSTRAP_AGENT_KIND }),
    )
  })

  it('records what the dispatch handed the agent, keyed to the run and to its APPLY step', async () => {
    const record = vi.fn(async (_input: RecordAgentContextInput) => undefined)
    const bootstrapper = makeBootstrapper(
      fakeClient(),
      { dispatch: vi.fn(async () => undefined) } as unknown as RunnerTransport,
      { agentContextObservability: { record } },
    )
    await bootstrapper.startBootstrap(MONOREPO_REQUEST)
    expect(record).toHaveBeenCalledTimes(1)
    const snapshot = record.mock.calls[0]?.[0]
    expect(snapshot).toMatchObject({
      workspaceId: 'ws_1',
      executionId: 'boot_1',
      agentKind: REPO_BOOTSTRAP_AGENT_KIND,
      // Third of the run's three steps (survey, review, apply), numbered as the board numbers
      // them rather than as a literal this file would have to keep in step by hand.
      stepIndex: 2,
      // `provider:model`, the format the snapshot contract documents and every other producer
      // writes. A bare model id here is a row a reader cannot recover the provider from.
      model: 'workers-ai:@cf/test',
    })
    expect(snapshot?.systemPrompt).toContain('adding a NEW service to an existing monorepo')
    // The allow-list, asserted where a bootstrap body is most tempting to copy whole: the job
    // carries a GitHub installation token and a proxy session token, and neither may be stored.
    expect(JSON.stringify(snapshot)).not.toContain('gh-token')
    expect(JSON.stringify(snapshot)).not.toContain('session-token')
  })

  it(`drains a poll window's tool calls under the run, grouped by the container job`, async () => {
    // Without this a bootstrap is the one agent run whose trajectory tab is empty however much
    // the agent did, and the trajectory is the half of "why did it produce this" that neither
    // the prompt nor the diff answers.
    const recordToolCalls = vi.fn(async () => undefined)
    const poll = vi.fn(async (): Promise<RunnerJobView> => ({
      state: 'running',
      spans: [
        {
          seq: 1,
          tool: 'bash',
          startedAt: 1,
          endedAt: 2,
          ok: true,
          args: 'ls',
          result: 'ok',
          bodies: 'stored',
        },
      ],
    }))
    const bootstrapper = makeBootstrapper(fakeClient(), { poll } as unknown as RunnerTransport, {
      recordToolCalls,
      toolBodyGate: async () => true,
    })
    await bootstrapper.pollBootstrap({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1:apply',
    })
    expect(recordToolCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_1',
        executionId: 'boot_1',
        jobId: 'boot_1:apply',
        agentKind: REPO_BOOTSTRAP_AGENT_KIND,
      }),
    )
  })

  it('reports the pull request a completed apply opened, and NO created repository', async () => {
    const poll = vi.fn(async (): Promise<RunnerJobView> => ({
      state: 'done',
      result: {
        prUrl: 'https://github.com/acme/platform/pull/7',
        branch: MONOREPO_DELIVERY.branch,
      },
    }))
    const bootstrapper = makeBootstrapper(fakeClient(), { poll } as unknown as RunnerTransport, {
      bootstrapJobRepository: fakeJobRepository({
        monorepo: MONOREPO_REF,
        delivery: 'pull_request',
      }),
    })
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
    const bootstrapper = makeBootstrapper(fakeClient(), { poll } as unknown as RunnerTransport, {
      bootstrapJobRepository: fakeJobRepository({ delivery: 'pull_request' }),
    })
    const update = await bootstrapper.pollBootstrap({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1',
    })
    expect(update.prUrl).toBe('https://github.com/kibertoad/simpler-service3/pull/1')
    expect(update.outcome).toMatchObject({ owner: 'kibertoad', name: 'simpler-service3' })
  })
})

describe('ContainerRepoBootstrapper token scope and reported branch', () => {
  it('scopes the token to the template it CLONES under the force-push delivery too', async () => {
    // That delivery pushes only the target, so the scope read as "just the target" for a long
    // time. But it also CLONES the reference template on the same token, so a scope without the
    // template works for a public reference architecture and 404s on a private one, under one
    // delivery and not the other.
    const mint = vi.fn(async () => 'gh-token')
    const bootstrapper = makeBootstrapper(
      idPerRepoClient(),
      { dispatch: vi.fn(async () => undefined) } as unknown as RunnerTransport,
      { mintInstallationToken: mint },
    )
    await bootstrapper.startBootstrap({
      ...REQUEST,
      referenceRepo: { owner: 'acme', name: 'service-template' },
    })
    expect(mint).toHaveBeenCalledWith(99, expect.objectContaining({ repoIds: ['1', '77'] }))
  })

  it('clones the template at ITS default branch, not an assumed `main`', async () => {
    const dispatch = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(idPerRepoClient(), {
      dispatch,
    } as unknown as RunnerTransport)
    await bootstrapper.startBootstrap({
      ...REQUEST,
      referenceRepo: { owner: 'acme', name: 'service-template' },
    })
    const [, body] = dispatch.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(body.repo).toMatchObject({ name: 'service-template', baseBranch: 'trunk' })
  })

  it('reports the real default branch of the target when the harness reported none', async () => {
    // Only the force-push `bootstrap` spec echoes a branch back (it created the one it pushed).
    // The coding shape a `pull_request` run takes reports none, so the outcome READS it: a
    // repository whose default is `trunk` must not be recorded as `main`, which is a ref that
    // does not exist there.
    const poll = vi.fn(async (): Promise<RunnerJobView> => ({
      state: 'done',
      result: { prUrl: 'https://github.com/kibertoad/simpler-service3/pull/1' },
    }))
    const bootstrapper = makeBootstrapper(
      idPerRepoClient(),
      { poll } as unknown as RunnerTransport,
      { bootstrapJobRepository: fakeJobRepository({ delivery: 'pull_request' }) },
    )
    const update = await bootstrapper.pollBootstrap({
      workspaceId: 'ws_1',
      jobId: 'boot_1',
      containerJobId: 'boot_1',
    })
    expect(update.outcome?.defaultBranch).toBe('trunk')
  })
})

describe('the monorepo role prompt', () => {
  /** The system prompt a monorepo apply dispatches under the given delivery. */
  async function promptFor(mode: 'pull_request' | 'direct_push'): Promise<string> {
    const dispatch = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(fakeClient(), {
      dispatch,
    } as unknown as RunnerTransport)
    await bootstrapper.startBootstrap({
      ...MONOREPO_REQUEST,
      delivery: mode === 'pull_request' ? MONOREPO_DELIVERY : ({ mode: 'direct_push' } as const),
    })
    const [, body] = dispatch.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    return body.systemPrompt as string
  }

  it('tells a direct-push run it is on the SHARED branch, and where a deviation goes', async () => {
    // Both sentences change what the agent does. "Already on a fresh work branch" is the licence
    // to commit loosely, and this delivery checkpoints every commit onto the branch every other
    // service is built from. And a caveat routed to a pull request description is LOST on a run
    // that opens no pull request.
    const prompt = await promptFor('direct_push')
    expect(prompt).toMatch(/OWN DEFAULT BRANCH/)
    expect(prompt).not.toMatch(/fresh work branch/)
    expect(prompt).toMatch(/commit message/)
    expect(prompt).not.toMatch(/pull request description/)
  })

  it('tells a pull-request run it is on a work branch, and to note deviations on the PR', async () => {
    const prompt = await promptFor('pull_request')
    expect(prompt).toMatch(/fresh work branch/)
    expect(prompt).toMatch(/pull request description/)
    expect(prompt).not.toMatch(/DEFAULT BRANCH/)
  })

  it('keeps the rules that are not about delivery under both', async () => {
    // The scoping rules are the point of this prompt and neither delivery relaxes them.
    for (const prompt of [await promptFor('pull_request'), await promptFor('direct_push')]) {
      expect(prompt).toMatch(/READ-ONLY as a sibling directory/)
      expect(prompt).toMatch(/touch NOTHING else in the/)
      expect(prompt).toMatch(/adoption decisions a human has already reviewed/)
    }
  })
})
