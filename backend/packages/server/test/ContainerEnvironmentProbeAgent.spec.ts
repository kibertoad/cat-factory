import { describe, expect, it, vi } from 'vitest'
import type {
  EnvironmentProbeRequest,
  GitHubInstallation,
  GitHubInstallationRepository,
  ModelRef,
  RepoProjectionRepository,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { ContainerEnvironmentProbeAgent } from '../src/agents/ContainerEnvironmentProbeAgent.js'
import type { MintInstallationToken } from '../src/agents/repoTargeting.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The AGENT DRY RUN's dispatcher. What these tests pin is the three details the class notes call
// load-bearing, each of which is invisible in a passing container run and fatal in a real one:
//
//   - the dispatch DECLARES its environment through `RunnerDispatchOptions.environments`, which is
//     what feeds the container's hosts entry. Omitted, every operation the prober attempts fails
//     as `unreachable` on a local backend and the report blames the service;
//   - the IMAGE is pinned per surface and rides the job REF on the poll and the release too, so a
//     browser prober's container is the one that is polled and reclaimed;
//   - the job is READ-ONLY: `mode: 'explore'`, no `pr`, no push branch, no bootstrap block. A dry
//     run that could push would be a diagnostic with write access to the repository it is reading.

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

const PROJECTED_REPOS = [{ githubId: 501, owner: 'kibertoad', name: 'acme' }] as unknown as Awaited<
  ReturnType<RepoProjectionRepository['list']>
>

function makeAgent(
  transport: RunnerTransport,
  over: {
    mint?: MintInstallationToken
    resolveTestSecrets?: (
      workspaceId: string,
      blockId: string,
    ) => Promise<{ key: string; description: string; value: string }[]>
    models?: Record<'api' | 'ui', ModelRef>
  } = {},
): ContainerEnvironmentProbeAgent {
  return new ContainerEnvironmentProbeAgent({
    resolveTransport: async () => transport,
    installationRepository: {
      getByWorkspace: vi.fn(async () => INSTALLATION),
    } as unknown as GitHubInstallationRepository,
    repoRepository: { list: async () => PROJECTED_REPOS },
    mintInstallationToken: over.mint ?? (async () => 'gh-token'),
    sessionService: {
      mint: vi.fn(async () => 'session-token'),
    } as unknown as ContainerSessionService,
    models: over.models ?? {
      api: { provider: 'workers-ai', model: '@cf/test' },
      ui: { provider: 'workers-ai', model: '@cf/test-vision' },
    },
    proxyBaseUrl: 'https://proxy.example/v1',
    ...(over.resolveTestSecrets ? { resolveTestSecrets: over.resolveTestSecrets } : {}),
  })
}

function request(over: Partial<EnvironmentProbeRequest> = {}): EnvironmentProbeRequest {
  return {
    workspaceId: 'ws_1',
    jobId: 'envtest_1',
    blockId: 'frame_1',
    surface: 'api',
    repo: { owner: 'kibertoad', name: 'acme', branch: 'cat-factory/env-test/envtest_1' },
    environment: {
      url: 'https://pr-1.acme.test',
      status: 'ready',
      access: { scheme: 'bearer', token: 'env-token' },
    },
    service: { title: 'Grass API', description: 'Serves grass.' },
    initiatedBy: 'usr_1',
    ...over,
  }
}

/** A transport that records every dispatch/poll/release call, with its ref and its options. */
function recordingTransport(view: RunnerJobView = { state: 'running' }) {
  const calls = {
    dispatch: [] as {
      ref: RunnerJobRef
      spec: Record<string, unknown>
      options?: RunnerDispatchOptions
    }[],
    poll: [] as RunnerJobRef[],
    release: [] as RunnerJobRef[],
  }
  const transport = {
    dispatch: async (
      ref: RunnerJobRef,
      spec: Record<string, unknown>,
      _kind: unknown,
      options?: RunnerDispatchOptions,
    ) => {
      calls.dispatch.push({ ref, spec, ...(options ? { options } : {}) })
      return undefined
    },
    poll: async (ref: RunnerJobRef) => {
      calls.poll.push(ref)
      return view
    },
    release: async (ref: RunnerJobRef) => {
      calls.release.push(ref)
    },
  } as unknown as RunnerTransport
  return { transport, calls }
}

describe('ContainerEnvironmentProbeAgent: the dispatch', () => {
  it('dispatches a read-only explore job with a structured output and no write surface', async () => {
    const { transport, calls } = recordingTransport()
    const handle = await makeAgent(transport).start(request())
    expect(handle).toEqual({ workspaceId: 'ws_1', jobId: 'envtest_1', surface: 'api' })

    const spec = calls.dispatch[0]!.spec
    expect(spec.mode).toBe('explore')
    expect(spec.output).toMatchObject({ kind: 'structured', repair: true })
    // A dry run reads; it must have no way to write. Any of these would give a diagnostic push
    // access to the repository it was only supposed to study.
    expect(spec.pr).toBeUndefined()
    expect(spec.pushBranch).toBeUndefined()
    expect(spec.newBranch).toBeUndefined()
    expect(spec.bootstrap).toBeUndefined()
    expect(spec.commitMessage).toBeUndefined()
    // It reads the THROWAWAY branch: the tree this environment was actually built from.
    expect(spec.branch).toBe('cat-factory/env-test/envtest_1')
    expect(spec.repo).toMatchObject({ baseBranch: 'cat-factory/env-test/envtest_1' })
  })

  it('stands nothing up and hands the environment URL to the harness', async () => {
    const { transport, calls } = recordingTransport()
    await makeAgent(transport).start(request())
    expect(calls.dispatch[0]!.spec.infra).toEqual({
      kind: 'service',
      environment: 'ephemeral',
      environmentUrl: 'https://pr-1.acme.test',
    })
  })

  it('DECLARES the environment (and its proved address) as a dispatch option', async () => {
    // The transport is documented never to read an environment back out of the body, so a
    // dispatch that does not declare one gets no hosts entry, and a prober whose environment
    // name resolves nowhere inside the container reports the service as unreachable.
    const { transport, calls } = recordingTransport()
    await makeAgent(transport).start(
      request({
        environment: {
          url: 'https://pr-1.acme.test',
          status: 'ready',
          reachability: { state: 'reached', address: '10.1.2.3' },
        },
      }),
    )
    expect(calls.dispatch[0]!.options?.environments).toEqual([
      { url: 'https://pr-1.acme.test', address: '10.1.2.3' },
    ])
  })

  it('runs the API prober on the default image and the UI prober on the browser image', async () => {
    const api = recordingTransport()
    await makeAgent(api.transport).start(request({ surface: 'api' }))
    expect(api.calls.dispatch[0]!.options?.image).toBeUndefined()
    expect(api.calls.dispatch[0]!.ref.image).toBeUndefined()

    const ui = recordingTransport()
    await makeAgent(ui.transport).start(request({ surface: 'ui' }))
    expect(ui.calls.dispatch[0]!.options?.image).toBe('ui')
    expect(ui.calls.dispatch[0]!.ref.image).toBe('ui')
  })

  it('routes each surface to its OWN model, so a browser job cannot inherit the HTTP one', async () => {
    // One shared ref sends whatever `tester-api` resolved to at a Playwright job, with no setting
    // anywhere able to change it.
    const api = recordingTransport()
    await makeAgent(api.transport).start(request({ surface: 'api' }))
    expect(api.calls.dispatch[0]!.spec.model).toBe('@cf/test')

    const ui = recordingTransport()
    await makeAgent(ui.transport).start(request({ surface: 'ui' }))
    expect(ui.calls.dispatch[0]!.spec.model).toBe('@cf/test-vision')
  })

  it('refuses the surface whose OWN model the proxy cannot serve, and only that one', async () => {
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, {
      models: {
        api: { provider: 'workers-ai', model: '@cf/test' },
        ui: { provider: 'anthropic-subscription', model: 'sonnet' } as unknown as ModelRef,
      },
    })
    await expect(agent.start(request({ surface: 'ui' }))).rejects.toThrow(/'ui' prober is routed/)
    await expect(agent.start(request({ surface: 'api' }))).resolves.toBeTruthy()
  })

  it('addresses the SAME container on the poll and the release as on the dispatch', async () => {
    // A per-run container backend puts a differently-imaged job in its own container: a poll that
    // dropped the variant would poll a container that never started, and a release that dropped it
    // would leave a browser container running for its full lifetime beside a dead environment.
    const { transport, calls } = recordingTransport()
    const agent = makeAgent(transport)
    const handle = await agent.start(request({ surface: 'ui' }))
    await agent.poll(handle)
    await agent.stop(handle)
    expect(calls.poll).toEqual([{ runId: 'envtest_1', jobId: 'envtest_1', image: 'ui' }])
    expect(calls.release).toEqual([{ runId: 'envtest_1', jobId: 'envtest_1', image: 'ui' }])
  })

  it('scopes the clone token to the one repo the prober reads, on the initiator behalf', async () => {
    const { transport } = recordingTransport()
    const mint = vi.fn(async () => 'gh-token')
    await makeAgent(transport, { mint }).start(request())
    expect(mint).toHaveBeenCalledWith(99, {
      executionId: 'envtest_1',
      workspaceId: 'ws_1',
      repoIds: ['501'],
      initiatedBy: 'usr_1',
    })
  })

  it('injects the test-secret VALUES and advertises exactly those keys in the prompt', async () => {
    // ONE resolution feeds both halves, so the prompt cannot name a variable the container does
    // not carry. The values must never appear in the prompt.
    const { transport, calls } = recordingTransport()
    await makeAgent(transport, {
      resolveTestSecrets: async () => [
        { key: 'API_TOKEN', description: 'read-write token for the test tenant', value: 's3cret' },
      ],
    }).start(request())
    const spec = calls.dispatch[0]!.spec
    expect(spec.testSecrets).toEqual([{ key: 'API_TOKEN', value: 's3cret' }])
    expect(String(spec.userPrompt)).toContain('API_TOKEN')
    expect(String(spec.userPrompt)).toContain('read-write token for the test tenant')
    expect(String(spec.userPrompt)).not.toContain('s3cret')
  })

  it('states an UNCONFIGURED secret store in the prompt rather than omitting it', async () => {
    // A prober that cannot tell "no credentials are configured" from "credentials exist and I was
    // not shown them" files the platform's gap as its own ignorance.
    const { transport, calls } = recordingTransport()
    await makeAgent(transport).start(request())
    const prompt = String(calls.dispatch[0]!.spec.userPrompt)
    expect(prompt).toContain('NONE')
    expect(prompt).toContain('auth_missing')
  })

  it('refuses to dispatch when the environment exposed no URL', async () => {
    const { transport, calls } = recordingTransport()
    await expect(
      makeAgent(transport).start(request({ environment: { url: null, status: 'ready' } })),
    ).rejects.toThrow(/no URL/i)
    expect(calls.dispatch).toEqual([])
  })
})

describe('ContainerEnvironmentProbeAgent: the poll', () => {
  it('reports progress while the prober is still working', async () => {
    const { transport } = recordingTransport({
      state: 'running',
      progress: { completed: 1, inProgress: 1, total: 4 },
    } as RunnerJobView)
    const agent = makeAgent(transport)
    const update = await agent.poll(await agent.start(request()))
    expect(update).toEqual({
      state: 'running',
      subtasks: { completed: 1, inProgress: 1, total: 4 },
    })
  })

  it('returns the RAW report for the caller to coerce', async () => {
    const raw = { summary: 'ok', operations: [] }
    const { transport } = recordingTransport({
      state: 'done',
      result: { custom: raw },
    } as unknown as RunnerJobView)
    const agent = makeAgent(transport)
    const update = await agent.poll(await agent.start(request()))
    expect(update).toEqual({ state: 'done', report: raw, model: 'workers-ai:@cf/test' })
  })

  it.each([
    ['nothing at all', {}],
    ['a top-level array', { custom: [{ name: 'list projects' }] }],
    ['a bare string', { custom: 'I could not reach it' }],
  ])('reports a job that returned %s as a FAILED dry run', async (_label, result) => {
    // Every one of these coerces to an EMPTY report, which the platform grades `inoperable` and
    // the SPA renders as "an agent could not operate this service": a finding about the service,
    // invented out of a reply that established nothing. The shape question has to be asked with
    // the same predicate the coercion applies, before the shape is flattened.
    const { transport } = recordingTransport({ state: 'done', result } as RunnerJobView)
    const agent = makeAgent(transport)
    const update = await agent.poll(await agent.start(request()))
    expect(update.state).toBe('failed')
    expect(update).toMatchObject({
      error: expect.stringContaining('without returning a usable report'),
    })
  })

  it('files the reply under the model of the surface that produced it', async () => {
    const { transport } = recordingTransport({
      state: 'done',
      result: { custom: { summary: 'ok' } },
    } as unknown as RunnerJobView)
    const agent = makeAgent(transport)
    const update = await agent.poll(await agent.start(request({ surface: 'ui' })))
    expect(update).toMatchObject({ model: 'workers-ai:@cf/test-vision' })
  })

  it('maps an eviction to the evicted failure kind', async () => {
    const { transport } = recordingTransport({
      state: 'failed',
      evicted: 'transient',
      error: 'container evicted',
    } as unknown as RunnerJobView)
    const agent = makeAgent(transport)
    const update = await agent.poll(await agent.start(request()))
    expect(update).toMatchObject({ state: 'failed', failureKind: 'evicted' })
  })
})

describe('ContainerEnvironmentProbeAgent: what it tells the prober about credentials', () => {
  it('says the PLATFORM failed when the sealed store would not open', async () => {
    // The collapse this guards is silent and expensive: a store that throws produced the same
    // prompt as a service with nothing configured, so the report told an operator to configure
    // credentials that were already there.
    const { transport, calls } = recordingTransport()
    await makeAgent(transport, {
      resolveTestSecrets: async () => {
        throw new Error('ENCRYPTION_KEY is not set')
      },
    }).start(request())
    const prompt = String(calls.dispatch[0]!.spec.userPrompt)
    expect(prompt).toContain('may well have test credentials configured')
    expect(prompt).toContain('Do NOT tell a human to configure credentials for this service')
    // The dry run still RUNS: a report naming what was missing beats a refused stage.
    expect(calls.dispatch).toHaveLength(1)
    expect(calls.dispatch[0]!.spec.testSecrets).toBeUndefined()
  })

  it('says the DEPLOYMENT has no store when none is wired, which is a different fix', async () => {
    const { transport, calls } = recordingTransport()
    await makeAgent(transport).start(request())
    expect(String(calls.dispatch[0]!.spec.userPrompt)).toContain('no sealed credential store wired')
  })
})

describe('ContainerEnvironmentProbeAgent: the admission capability question', () => {
  it('reports a surface whose image the backend does not serve as unsupported', async () => {
    const { transport } = recordingTransport()
    const agent = makeAgent({
      ...transport,
      supportsImage: (variant?: string) => variant !== 'ui',
    } as unknown as RunnerTransport)
    expect(await agent.supports('ws_1', 'api')).toBe(true)
    expect(await agent.supports('ws_1', 'ui')).toBe(false)
  })

  it('treats a backend that cannot answer as a yes, never as a refusal', async () => {
    // A self-hosted pool resolves images on its own side. Reading its silence as "unsupported"
    // would refuse every dry run on every pooled deployment.
    const { transport } = recordingTransport()
    const agent = makeAgent(transport)
    expect(await agent.supports('ws_1', 'ui')).toBe(true)
  })

  it('reports no runner at all as unsupported', async () => {
    const agent = new ContainerEnvironmentProbeAgent({
      resolveTransport: async () => {
        throw new Error('no runner backend is available for this workspace')
      },
      installationRepository: {
        getByWorkspace: vi.fn(async () => INSTALLATION),
      } as unknown as GitHubInstallationRepository,
      repoRepository: { list: async () => PROJECTED_REPOS },
      mintInstallationToken: async () => 'gh-token',
      sessionService: { mint: vi.fn(async () => 'tok') } as unknown as ContainerSessionService,
      models: {
        api: { provider: 'workers-ai', model: '@cf/test' },
        ui: { provider: 'workers-ai', model: '@cf/test' },
      },
      proxyBaseUrl: 'https://proxy.example/v1',
    })
    expect(await agent.supports('ws_1', 'api')).toBe(false)
  })
})
