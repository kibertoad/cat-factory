import { describe, expect, it, vi } from 'vitest'
import type {
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
  createdAt: 0,
  deletedAt: null,
}

/** A GitHubClient that pre-flights cleanly except for the bits a test overrides. */
function fakeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const base = {
    getRepo: vi.fn(async () => ({ defaultBranch: 'main' })),
    canPush: vi.fn(async () => true),
    listRootEntries: vi.fn(async () => []),
    ...overrides,
  }
  return base as unknown as GitHubClient
}

function makeBootstrapper(
  client: GitHubClient,
  transport: RunnerTransport,
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
  })
}

const REQUEST = {
  workspaceId: 'ws_1',
  jobId: 'boot_1',
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
    expect(handle).toEqual({ workspaceId: 'ws_1', jobId: 'boot_1' })
    expect(client.canPush).toHaveBeenCalledWith(99, {
      owner: 'kibertoad',
      repo: 'simpler-service3',
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('ContainerRepoBootstrapper.pollBootstrap', () => {
  it('classifies eviction from the STRUCTURED field (no string sentinel needed)', async () => {
    // A newer transport reports the eviction verdict as a field; the error text carries no
    // `(container evicted or crashed)` sentinel, so this proves the structured field is
    // load-bearing and not merely the regex fallback firing on the message.
    const poll = vi.fn(
      async (): Promise<RunnerJobView> => ({
        state: 'failed',
        error: 'the runner container was reaped',
        evicted: 'crash',
      }),
    )
    const bootstrapper = makeBootstrapper(fakeClient(), { poll } as unknown as RunnerTransport)

    const update = await bootstrapper.pollBootstrap({ workspaceId: 'ws_1', jobId: 'boot_1' })
    expect(update.state).toBe('failed')
    expect(update).toMatchObject({ failureKind: 'evicted' })
  })
})
