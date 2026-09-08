import { describe, expect, it, vi } from 'vitest'
import type {
  Block,
  BlockRepository,
  EnvironmentProbeRequest,
  GitHubInstallation,
  GitHubInstallationRepository,
  HarnessKind,
  RepoProjectionRepository,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { ALL_SUBSCRIPTION_VENDORS, resolveModelRef } from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { ContainerEnvironmentProbeAgent } from '../src/agents/ContainerEnvironmentProbeAgent.js'
import { ContainerJobAuthResolver } from '../src/agents/containerJobAuth.js'
import { buildSingleKindModelResolver } from '../src/agents/singleKindModel.js'
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

/**
 * The deployment's env routing: what the prober used to be pinned to at WIRING time, and what it
 * must now only fall back to. Deliberately a model no test expects to see dispatched, so a
 * resolution that quietly skipped the workspace's preset shows up as this string.
 */
const ENV_ROUTING: AgentRouting = {
  default: { ref: { provider: 'qwen', model: 'qwen3-max' } },
  byKind: {},
}

/** A frame with no model pin, which is what makes the workspace's preset the deciding tier. */
const FRAME = { id: 'frame_1', type: 'backend' } as unknown as Block

/**
 * The prober's collaborators, as the facades compose them: the real single-job model resolution
 * (frame pin > the workspace preset for the prober's kind > env routing) over the real model
 * catalog, and the real per-job auth resolver.
 *
 * Real rather than stubbed, because the defect these cover is a WIRING one. A fake `resolveModel`
 * returning whatever a test asked for would have passed against the version that read the env
 * routing at wiring and never consulted a preset at all.
 */
function makeAgent(
  transport: RunnerTransport,
  over: {
    mint?: MintInstallationToken
    resolveTestSecrets?: (
      workspaceId: string,
      blockId: string,
    ) => Promise<{ key: string; description: string; value: string }[]>
    /** The preset in force, as `overrides[kind] ?? baseModelId` already resolved it. */
    presetModelForKind?: (agentKind: string) => string | undefined
    /** What the FRAME pins, which outranks the preset. */
    frame?: Block | null
    /** Vendors the run initiator holds their own personal subscription for. */
    personalVendors?: SubscriptionVendor[]
    leasePersonal?: (
      executionId: string,
      userId: string,
      vendor: SubscriptionVendor,
    ) => Promise<{ secret: string }>
    leasePooled?: (
      workspaceId: string,
      vendor: SubscriptionVendor,
    ) => Promise<{ tokenId: string; secret: string }>
    nativeAmbientAuth?: (harness: HarnessKind, vendor: SubscriptionVendor | undefined) => boolean
    /** No runner backend resolves for this workspace at all. */
    unresolvableTransport?: boolean
  } = {},
): ContainerEnvironmentProbeAgent {
  const personal = new Set(over.personalVendors ?? [])
  return new ContainerEnvironmentProbeAgent({
    resolveTransport: async () => {
      if (over.unresolvableTransport) {
        throw new Error('no runner backend is available for this workspace')
      }
      return transport
    },
    installationRepository: {
      getByWorkspace: vi.fn(async () => INSTALLATION),
    } as unknown as GitHubInstallationRepository,
    repoRepository: { list: async () => PROJECTED_REPOS },
    mintInstallationToken: over.mint ?? (async () => 'gh-token'),
    resolveModel: buildSingleKindModelResolver({
      agentRouting: ENV_ROUTING,
      // The deployment catalog resolution the facades pass, with every subscription vendor
      // available (which is what a deployment holding an ENCRYPTION_KEY reports).
      resolveBlockModel: (modelId) =>
        resolveModelRef(modelId, {
          directProviders: new Set(),
          subscriptionVendors: new Set(ALL_SUBSCRIPTION_VENDORS),
          cloudflareEnabled: true,
        }),
      blockRepository: {
        get: async () => (over.frame === undefined ? FRAME : over.frame),
      } as unknown as Pick<BlockRepository, 'get'>,
      ...(over.presetModelForKind
        ? {
            resolveWorkspaceModelDefault: async (_ws: string, agentKind: string) =>
              over.presetModelForKind!(agentKind),
          }
        : {}),
      hasPersonalSubscription: async (_userId: string, vendor: SubscriptionVendor) =>
        personal.has(vendor),
    }),
    auth: new ContainerJobAuthResolver({
      sessionService: {
        mint: vi.fn(async () => 'session-token'),
      } as unknown as ContainerSessionService,
      proxyBaseUrl: 'https://proxy.example/v1',
      ...(over.leasePersonal ? { leasePersonalSubscriptionToken: over.leasePersonal } : {}),
      ...(over.leasePooled ? { leaseSubscriptionToken: over.leasePooled } : {}),
      ...(over.nativeAmbientAuth ? { nativeAmbientAuth: over.nativeAmbientAuth } : {}),
    }),
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
    expect(handle).toEqual({
      workspaceId: 'ws_1',
      jobId: 'envtest_1',
      surface: 'api',
      // The FRAME rides along, because the poll has to resolve the model that produced the report
      // and there is no dispatch-time memory left by then: the durable driver polls from a fresh
      // process.
      blockId: 'frame_1',
      initiatedBy: 'usr_1',
    })

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

  it('runs the model the WORKSPACE preset names, not the deployment env routing', async () => {
    // The regression this exists for. The model used to be read off the env routing once, at
    // wiring: a workspace running everything on its Claude preset had its dry run dispatched at
    // the deployment default (Qwen on the Node family), which the LLM proxy then refused for
    // having no key configured, after the run had already stood a real environment up.
    const { transport, calls } = recordingTransport()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'kimi-k2.7',
      // `qwen3-max` is the env routing, and it must lose.
    })
    await agent.start(request())
    expect(calls.dispatch[0]!.spec.model).not.toBe('qwen3-max')
    expect(calls.dispatch[0]!.spec.model).toContain('kimi')
  })

  it('falls back to the env routing only when no preset resolves a model', async () => {
    const { transport, calls } = recordingTransport()
    await makeAgent(transport, { presetModelForKind: () => undefined }).start(request())
    expect(calls.dispatch[0]!.spec.model).toBe('qwen3-max')
  })

  it("lets the FRAME's own pin outrank the preset, as it does for a pipeline step", async () => {
    const { transport, calls } = recordingTransport()
    const agent = makeAgent(transport, {
      frame: { id: 'frame_1', type: 'backend', modelId: 'kimi-k2.7' } as never,
      presetModelForKind: () => 'glm',
    })
    await agent.start(request())
    expect(calls.dispatch[0]!.spec.model).toContain('kimi')
  })

  it('routes each surface to its OWN model, so a browser job cannot inherit the HTTP one', async () => {
    // The two probers do different work (one reads screenshots and drives a page, the other
    // reads a schema and calls it), so each asks the preset under its own agent kind. One
    // shared ref would send a cheap text model at a Playwright job with nothing able to fix it.
    const presetModelForKind = (kind: string) =>
      kind === 'environment-prober-ui' ? 'gemini-3.8-flash' : 'kimi-k2.7'

    const api = recordingTransport()
    await makeAgent(api.transport, { presetModelForKind }).start(request({ surface: 'api' }))
    expect(api.calls.dispatch[0]!.spec.model).toContain('kimi')

    const ui = recordingTransport()
    await makeAgent(ui.transport, { presetModelForKind }).start(request({ surface: 'ui' }))
    expect(ui.calls.dispatch[0]!.spec.model).toContain('gemini')
  })

  it('refuses a resolved model the LLM proxy cannot serve, at the dispatch', async () => {
    // Asked per dispatch now, because the answer is per workspace. The wiring-time version of
    // this check disabled the prober for the whole DEPLOYMENT on the strength of a routing entry
    // no workspace had chosen.
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, { presetModelForKind: () => 'claude-opus-4-8' })
    await expect(agent.start(request())).rejects.toThrow(/the LLM proxy can serve/)
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
    expect(update).toEqual({ state: 'done', report: raw, model: 'qwen:qwen3-max' })
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
    // Resolved on the terminal branch from the handle's own frame, under the surface's kind: a
    // browser prober's report must not be attributed to whatever the HTTP one runs.
    const { transport } = recordingTransport({
      state: 'done',
      result: { custom: { summary: 'ok' } },
    } as unknown as RunnerJobView)
    const agent = makeAgent(transport, {
      presetModelForKind: (kind) =>
        kind === 'environment-prober-ui' ? 'gemini-3.8-flash' : 'kimi-k2.7',
    })
    const update = await agent.poll(await agent.start(request({ surface: 'ui' })))
    expect(update.state).toBe('done')
    expect((update as { model?: string }).model).toContain('gemini')
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
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, { unresolvableTransport: true })
    expect(await agent.supports('ws_1', 'api')).toBe(false)
  })
})

describe('ContainerEnvironmentProbeAgent: the credential the prober runs on', () => {
  it("leases the INITIATOR's own personal subscription for an individual-usage model", async () => {
    // The half of the defect that was invisible: a workspace on the Claude preset never had its
    // subscription asked for, because this flow served only the LLM-proxy branch and a
    // subscription model was refused at WIRING. The lease is keyed on the self-test run id,
    // which is the id the start gate minted the activation against.
    const { transport, calls } = recordingTransport()
    const leasePersonal = vi.fn(async () => ({ secret: 'oauth-token' }))
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'claude-opus',
      personalVendors: ['claude'],
      leasePersonal,
    })
    await agent.start(request())
    expect(leasePersonal).toHaveBeenCalledWith('envtest_1', 'usr_1', 'claude')
    const spec = calls.dispatch[0]!.spec
    expect(spec).toMatchObject({
      harness: 'claude-code',
      subscriptionToken: 'oauth-token',
      model: 'claude-opus-5',
    })
    // A subscription harness talks to the vendor directly, so it carries no proxy session token:
    // handing it one would meter the run twice and lock it to a model the proxy would serve.
    expect(spec.sessionToken).toBeUndefined()
    expect(spec.proxyBaseUrl).toBeUndefined()
  })

  it('surfaces the unlock refusal instead of dispatching, when nothing was activated', async () => {
    // What the caller sees when the start gate was skipped, or the activation lapsed: the refusal
    // the lease raises, propagated so the run fails at the probing stage naming the credential
    // rather than the container.
    const { transport, calls } = recordingTransport()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'claude-opus',
      personalVendors: ['claude'],
      leasePersonal: async () => {
        throw new Error('no live activation for this run')
      },
    })
    await expect(agent.start(request())).rejects.toThrow(/no live activation/)
    expect(calls.dispatch).toHaveLength(0)
  })

  it('refuses an individual-usage model with no signed-in initiator to lease for', async () => {
    // Such a credential belongs to one person; a system-started run has nobody to resolve.
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'claude-opus',
      leasePersonal: async () => ({ secret: 'oauth-token' }),
    })
    await expect(agent.start(request({ initiatedBy: null }))).rejects.toThrow(
      /requires a signed-in user/,
    )
  })

  it('says the personal store is unwired rather than dispatching without a credential', async () => {
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'claude-opus',
      personalVendors: ['claude'],
    })
    await expect(agent.start(request())).rejects.toThrow(/not configured on this deployment/)
  })

  it("runs the developer's own CLI in native local mode, leasing nothing", async () => {
    const { transport, calls } = recordingTransport()
    const leasePersonal = vi.fn(async () => ({ secret: 'oauth-token' }))
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'claude-opus',
      personalVendors: ['claude'],
      leasePersonal,
      nativeAmbientAuth: () => true,
    })
    await agent.start(request())
    expect(leasePersonal).not.toHaveBeenCalled()
    expect(calls.dispatch[0]!.spec).toMatchObject({ harness: 'claude-code', ambientAuth: true })
    expect(calls.dispatch[0]!.spec.subscriptionToken).toBeUndefined()
  })

  it('carries the model-locked proxy session token for a Pi model, as before', async () => {
    const { transport, calls } = recordingTransport()
    await makeAgent(transport, { presetModelForKind: () => 'kimi-k2.7' }).start(request())
    expect(calls.dispatch[0]!.spec).toMatchObject({
      harness: 'pi',
      sessionToken: 'session-token',
      proxyBaseUrl: 'https://proxy.example/v1',
      proxyPhasePath: true,
    })
    expect(calls.dispatch[0]!.spec.subscriptionToken).toBeUndefined()
  })
})
