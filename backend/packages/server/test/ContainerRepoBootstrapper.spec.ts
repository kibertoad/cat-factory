import { describe, expect, it, vi } from 'vitest'
import type {
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import {
  ContainerRepoBootstrapper,
  REPO_BOOTSTRAP_AGENT_KIND,
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
    bootstrapJobRepository: {} as never,
    repoRepository: {} as never,
    githubClient: client,
    mintInstallationToken: vi.fn(async () => 'gh-token'),
    sessionService,
    model: { provider: 'workers-ai', model: '@cf/test' },
    proxyBaseUrl: 'https://proxy.example/v1',
    ...overrides,
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

  it(`records the new-repo dispatch as the run's FIRST step, naming the push target`, async () => {
    // A new-repo run is one step, so its snapshot is step 0 rather than the 2 a monorepo apply
    // files: the numbering comes from the shared step derivation, which is also what the board
    // draws, so a snapshot can never key to a step the run does not show.
    const record = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(
      fakeClient(),
      { dispatch: vi.fn(async () => undefined) } as unknown as RunnerTransport,
      { agentContextObservability: { record } },
    )
    await bootstrapper.startBootstrap(REQUEST)
    const snapshot = record.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(snapshot).toMatchObject({ executionId: 'boot_1', stepIndex: 0 })
    // Where it PUSHES, which the clone-source `repo` field does not answer on a from-scratch run.
    expect(snapshot.extras).toMatchObject({
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
    const record = vi.fn(async () => undefined)
    const bootstrapper = makeBootstrapper(
      fakeClient(),
      { dispatch: vi.fn(async () => undefined) } as unknown as RunnerTransport,
      { agentContextObservability: { record } },
    )
    await bootstrapper.startBootstrap(MONOREPO_REQUEST)
    expect(record).toHaveBeenCalledTimes(1)
    const snapshot = record.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(snapshot).toMatchObject({
      workspaceId: 'ws_1',
      executionId: 'boot_1',
      agentKind: REPO_BOOTSTRAP_AGENT_KIND,
      // Third of the run's three steps (survey, review, apply), numbered as the board numbers
      // them rather than as a literal this file would have to keep in step by hand.
      stepIndex: 2,
    })
    expect(snapshot.systemPrompt).toContain('adding a NEW service to an existing monorepo')
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
      spans: [{ seq: 1, tool: 'bash', args: 'ls', result: 'ok', bodies: 'stored' }],
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
