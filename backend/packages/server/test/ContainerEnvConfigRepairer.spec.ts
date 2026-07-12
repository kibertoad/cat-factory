import { describe, expect, it, vi } from 'vitest'
import type {
  EnvConfigRepairRequest,
  EnvironmentProvider,
  GitHubInstallation,
  GitHubInstallationRepository,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { ContainerEnvConfigRepairer } from '../src/agents/ContainerEnvConfigRepairer.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The env-config REPAIR agent (PR #416 increment 2), reworked into the durable
// EnvConfigRepairer port (startRepair/pollRepair/stopRepair — no in-request poll loop).
// It is NOT the repo bootstrapper: these tests pin that it dispatches an ORDINARY coding
// job (clone gitRef → edit → push gitRef) with NO `bootstrap`/`mergeBase` block and NO PR.
// Conflating the two would force-push a reinitialised history over the target repo, so the
// "no bootstrap block" assertion is the load-bearing guard here. The durable runner drives
// the poll loop; this dispatcher only pushes the fix and reports progress / outcome.

const INSTALLATION: GitHubInstallation = {
  installationId: 99,
  workspaceId: 'ws_1',
  accountId: 'acc_1',
  accountLogin: 'kibertoad',
  targetType: 'User',
  appId: 'app-default',
  cachedToken: null,
  tokenExpiresAt: null,
  createdAt: 0,
  deletedAt: null,
}

function repairProvider(over: Partial<EnvironmentProvider> = {}): EnvironmentProvider {
  return {
    describeRepairAgent: () => ({
      prompt: 'Make .kargo.yml valid: it needs a name and a jobs list.',
    }),
    ...over,
  } as unknown as EnvironmentProvider
}

function makeRepairer(
  transport: RunnerTransport,
  provider: EnvironmentProvider = repairProvider(),
): ContainerEnvConfigRepairer {
  const installationRepository = {
    getByWorkspace: vi.fn(async () => INSTALLATION),
  } as unknown as GitHubInstallationRepository
  const sessionService = {
    mint: vi.fn(async () => 'session-token'),
  } as unknown as ContainerSessionService
  return new ContainerEnvConfigRepairer({
    resolveTransport: async () => transport,
    installationRepository,
    mintInstallationToken: vi.fn(async () => 'gh-token'),
    sessionService,
    environmentProvider: provider,
    model: { provider: 'workers-ai', model: '@cf/test' },
    proxyBaseUrl: 'https://proxy.example/v1',
  })
}

const REQUEST: EnvConfigRepairRequest = {
  workspaceId: 'ws_1',
  jobId: 'job_1',
  owner: 'kibertoad',
  repo: 'acme',
  gitRef: 'feature/x',
  issues: [{ severity: 'error' as const, message: 'missing jobs', path: '.kargo.yml' }],
  inputs: { name: 'acme' },
}

describe('ContainerEnvConfigRepairer', () => {
  it('startRepair dispatches an ordinary coding job (no bootstrap block, no PR) and returns a handle', async () => {
    const dispatch = vi.fn(async () => undefined)
    const repairer = makeRepairer({
      dispatch,
      poll: vi.fn(),
      release: vi.fn(),
    } as unknown as RunnerTransport)

    const handle = await repairer.startRepair(REQUEST)
    expect(handle).toEqual({ workspaceId: 'ws_1', jobId: 'job_1' })

    expect(dispatch).toHaveBeenCalledTimes(1)
    const [ref, spec, kind] = dispatch.mock.calls[0] as unknown as [
      { runId: string; jobId: string },
      Record<string, unknown>,
      string,
    ]
    expect(kind).toBe('agent')
    expect(ref).toEqual({ runId: 'job_1', jobId: 'job_1' })
    // The load-bearing guards that keep this distinct from the repo bootstrapper:
    expect(spec.mode).toBe('coding')
    expect(spec.bootstrap).toBeUndefined()
    expect(spec.mergeBase).toBeUndefined()
    expect(spec.pr).toBeUndefined()
    expect(spec.newBranch).toBeUndefined()
    expect(spec.noChangesIsError).toBe(false)
    // Clones and pushes the SAME ref (no new branch).
    expect(spec.branch).toBe('feature/x')
    expect((spec.repo as { baseBranch: string }).baseBranch).toBe('feature/x')
    expect((spec.repo as { cloneUrl: string }).cloneUrl).toBe(
      'https://github.com/kibertoad/acme.git',
    )
    // The user prompt is the provider's repair prompt.
    expect(spec.userPrompt).toContain('.kargo.yml')
  })

  it('pollRepair maps a running view to a progress update', async () => {
    const repairer = makeRepairer({
      dispatch: vi.fn(),
      poll: vi.fn(
        async (): Promise<RunnerJobView> => ({
          state: 'running',
          progress: { completed: 1, inProgress: 1, total: 3 },
        }),
      ),
      release: vi.fn(),
    } as unknown as RunnerTransport)

    const update = await repairer.pollRepair({ workspaceId: 'ws_1', jobId: 'job_1' })
    expect(update.state).toBe('running')
    expect(update.subtasks).toEqual({ completed: 1, inProgress: 1, total: 3 })
  })

  it('pollRepair maps a done view to a terminal done update', async () => {
    const repairer = makeRepairer({
      dispatch: vi.fn(),
      poll: vi.fn(async (): Promise<RunnerJobView> => ({ state: 'done', result: {} })),
      release: vi.fn(),
    } as unknown as RunnerTransport)

    const update = await repairer.pollRepair({ workspaceId: 'ws_1', jobId: 'job_1' })
    expect(update.state).toBe('done')
  })

  it('pollRepair maps a failed view to a classified failure update', async () => {
    const repairer = makeRepairer({
      dispatch: vi.fn(),
      poll: vi.fn(
        async (): Promise<RunnerJobView> => ({
          state: 'failed',
          error: 'container evicted or crashed',
        }),
      ),
      release: vi.fn(),
    } as unknown as RunnerTransport)

    const update = await repairer.pollRepair({ workspaceId: 'ws_1', jobId: 'job_1' })
    expect(update.state).toBe('failed')
    expect(update.failureKind).toBe('evicted')
    expect(update.error).toMatch(/evicted/i)
  })

  it('pollRepair classifies eviction from the STRUCTURED field (no string sentinel needed)', async () => {
    const repairer = makeRepairer({
      dispatch: vi.fn(),
      poll: vi.fn(
        // A newer transport reports the verdict as a field; the error text carries no sentinel.
        async (): Promise<RunnerJobView> => ({
          state: 'failed',
          error: 'the runner pod was reaped',
          evicted: 'crash',
        }),
      ),
      release: vi.fn(),
    } as unknown as RunnerTransport)

    const update = await repairer.pollRepair({ workspaceId: 'ws_1', jobId: 'job_1' })
    expect(update.state).toBe('failed')
    expect(update.failureKind).toBe('evicted')
  })

  it('pollRepair treats a completed job with a structured error as a failure', async () => {
    const repairer = makeRepairer({
      dispatch: vi.fn(),
      poll: vi.fn(
        async (): Promise<RunnerJobView> => ({ state: 'done', result: { error: 'push rejected' } }),
      ),
      release: vi.fn(),
    } as unknown as RunnerTransport)

    const update = await repairer.pollRepair({ workspaceId: 'ws_1', jobId: 'job_1' })
    expect(update.state).toBe('failed')
    expect(update.failureKind).toBe('agent')
    expect(update.error).toMatch(/push rejected/i)
  })

  it('stopRepair releases the per-run container', async () => {
    const release = vi.fn(async () => undefined)
    const repairer = makeRepairer({
      dispatch: vi.fn(),
      poll: vi.fn(),
      release,
    } as unknown as RunnerTransport)

    await repairer.stopRepair({ workspaceId: 'ws_1', jobId: 'job_1' })
    expect(release).toHaveBeenCalledTimes(1)
    const [ref] = release.mock.calls[0] as unknown as [{ runId: string; jobId: string }]
    expect(ref).toEqual({ runId: 'job_1', jobId: 'job_1' })
  })

  it('startRepair throws (without dispatching) when the provider has no repair support', async () => {
    const dispatch = vi.fn(async () => undefined)
    const repairer = makeRepairer(
      { dispatch, poll: vi.fn(), release: vi.fn() } as unknown as RunnerTransport,
      {} as unknown as EnvironmentProvider,
    )

    await expect(repairer.startRepair(REQUEST)).rejects.toThrow(
      /does not support agent-based config repair/i,
    )
    expect(dispatch).not.toHaveBeenCalled()
  })
})
