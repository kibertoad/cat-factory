import { describe, expect, it, vi } from 'vitest'
import type {
  EnvironmentProvider,
  GitHubInstallation,
  GitHubInstallationRepository,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { ContainerEnvConfigRepairer } from '../src/agents/ContainerEnvConfigRepairer.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The env-config REPAIR agent (PR #416 increment 2). It is NOT the repo bootstrapper:
// these tests pin that it dispatches an ORDINARY coding job (clone gitRef → edit → push
// gitRef) with NO `bootstrap`/`mergeBase` block and NO PR, then awaits it. Conflating
// the two would force-push a reinitialised history over the target repo, so the "no
// bootstrap block" assertion is the load-bearing guard here.

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
    idGenerator: { next: () => 'job_1' },
    environmentProvider: provider,
    model: { provider: 'workers-ai', model: '@cf/test' },
    proxyBaseUrl: 'https://proxy.example/v1',
    pollIntervalMs: 0,
  })
}

const INPUT = {
  workspaceId: 'ws_1',
  owner: 'kibertoad',
  repo: 'acme',
  gitRef: 'feature/x',
  issues: [{ severity: 'error' as const, message: 'missing jobs', path: '.kargo.yml' }],
  inputs: { name: 'acme' },
}

describe('ContainerEnvConfigRepairer', () => {
  it('dispatches an ordinary coding job (no bootstrap block, no PR) and awaits completion', async () => {
    const dispatch = vi.fn(async () => undefined)
    const poll = vi.fn(async (): Promise<RunnerJobView> => ({ state: 'done', result: {} }))
    const release = vi.fn(async () => undefined)
    const repairer = makeRepairer({ dispatch, poll, release } as unknown as RunnerTransport)

    await repairer.repair(INPUT)

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
    // The per-run container is reclaimed after completion.
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('polls until the job leaves the running state', async () => {
    const dispatch = vi.fn(async () => undefined)
    const views: RunnerJobView[] = [{ state: 'running' }, { state: 'done', result: {} }]
    const poll = vi.fn(async (): Promise<RunnerJobView> => views.shift()!)
    const repairer = makeRepairer({
      dispatch,
      poll,
      release: vi.fn(),
    } as unknown as RunnerTransport)

    await repairer.repair(INPUT)
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('throws when the job fails', async () => {
    const dispatch = vi.fn(async () => undefined)
    const poll = vi.fn(
      async (): Promise<RunnerJobView> => ({ state: 'failed', error: 'container evicted' }),
    )
    const release = vi.fn(async () => undefined)
    const repairer = makeRepairer({ dispatch, poll, release } as unknown as RunnerTransport)

    await expect(repairer.repair(INPUT)).rejects.toThrow(/container evicted/i)
    // The container is still reclaimed on the failure path.
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('throws when a completed job carries a structured error', async () => {
    const dispatch = vi.fn(async () => undefined)
    const poll = vi.fn(
      async (): Promise<RunnerJobView> => ({ state: 'done', result: { error: 'push rejected' } }),
    )
    const repairer = makeRepairer({
      dispatch,
      poll,
      release: vi.fn(),
    } as unknown as RunnerTransport)

    await expect(repairer.repair(INPUT)).rejects.toThrow(/push rejected/i)
  })

  it('throws (without dispatching) when the provider has no repair support', async () => {
    const dispatch = vi.fn(async () => undefined)
    const repairer = makeRepairer(
      { dispatch, poll: vi.fn(), release: vi.fn() } as unknown as RunnerTransport,
      {} as unknown as EnvironmentProvider,
    )

    await expect(repairer.repair(INPUT)).rejects.toThrow(
      /does not support agent-based config repair/i,
    )
    expect(dispatch).not.toHaveBeenCalled()
  })
})
