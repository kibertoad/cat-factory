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
import type { ContainerJobAccountingDeps } from '../src/agents/containerJobAccounting.js'
import type { HarnessCallsRecordInput } from '@cat-factory/orchestration'
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
    /** Vendors the WORKSPACE holds a pooled token for; absent ⇒ the pool is not asked. */
    pooledVendors?: SubscriptionVendor[]
    /** Where a settled job's tokens land, so the recording can be asserted. */
    accounting?: ContainerJobAccountingDeps
    /** No runner backend resolves for this workspace at all. */
    unresolvableTransport?: boolean
  } = {},
): ContainerEnvironmentProbeAgent {
  const personal = new Set(over.personalVendors ?? [])
  const pooled = over.pooledVendors ? new Set(over.pooledVendors) : undefined
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
      ...(pooled
        ? {
            hasSubscriptionToken: async (_ws: string, vendor: SubscriptionVendor) =>
              pooled.has(vendor),
          }
        : {}),
    }),
    auth: new ContainerJobAuthResolver({
      sessionService: {
        mint: vi.fn(async () => 'session-token'),
      } as unknown as ContainerSessionService,
      proxyBaseUrl: 'https://proxy.example/v1',
      ...(over.leasePersonal ? { leasePersonalSubscriptionToken: over.leasePersonal } : {}),
      ...(over.leasePooled ? { leaseSubscriptionToken: over.leasePooled } : {}),
      ...(over.nativeAmbientAuth ? { nativeAmbientAuth: over.nativeAmbientAuth } : {}),
      hasPersonalSubscription: async (_userId: string, vendor: SubscriptionVendor) =>
        personal.has(vendor),
      ...(pooled
        ? {
            hasSubscriptionToken: async (_ws: string, vendor: SubscriptionVendor) =>
              pooled.has(vendor),
          }
        : {}),
    }),
    ...(over.accounting ? { accounting: over.accounting } : {}),
    ...(over.resolveTestSecrets ? { resolveTestSecrets: over.resolveTestSecrets } : {}),
  })
}

/** Recording recorders, so what a settled dry run files is observable rather than inferred. */
function recordingAccounting() {
  const filed = {
    calls: [] as HarnessCallsRecordInput[],
    pooled: [] as { workspaceId: string; tokenId: string; inputTokens: number }[],
    quota: [] as { scope: string; scopeId: string; vendor: string }[],
  }
  const deps: ContainerJobAccountingDeps = {
    recordHarnessCalls: async (input) => {
      filed.calls.push(input)
    },
    recordSubscriptionUsage: async (workspaceId, tokenId, usage) => {
      filed.pooled.push({ workspaceId, tokenId, inputTokens: usage.inputTokens })
    },
    recordSubscriptionQuotaUsage: async (target) => {
      filed.quota.push({ scope: target.scope, scopeId: target.scopeId, vendor: target.vendor })
    },
  }
  return { deps, filed }
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
      // The FRAME rides along because the run is ABOUT it, and the reclaim addresses a container
      // its type selected.
      blockId: 'frame_1',
      initiatedBy: 'usr_1',
      // What only the DISPATCH knows, handed back for the caller to persist. Re-derived at poll
      // time this would answer about the frame and preset as they are THEN, and the leased token
      // id has no second source at all. A Pi job leases none, so only the model is here.
      dispatch: { model: 'qwen:qwen3-max' },
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
    // Recorded at DISPATCH, under the surface's own kind: a browser prober's report must not be
    // attributed to whatever the HTTP one runs.
    const { transport } = recordingTransport({
      state: 'done',
      result: { custom: { summary: 'ok' } },
    } as unknown as RunnerJobView)
    const agent = makeAgent(transport, {
      presetModelForKind: (kind) =>
        kind === 'environment-prober-ui' ? 'gemini-3.8-flash' : 'kimi-k2.7',
    })
    const handle = await agent.start(request({ surface: 'ui' }))
    const update = await agent.poll(handle)
    expect(update.state).toBe('done')
    expect((update as { model?: string }).model).toContain('gemini')
  })

  it('reports the model the dispatch RAN, never the one the frame would resolve to now', async () => {
    // The defect this pins: the poll runs in a fresh process, and re-resolving there answers about
    // the frame and preset AS THEY ARE THEN. Clear the pin (or switch the preset) while the
    // container works and the settled report gets stamped with a model nobody ran, which is the
    // one label an operator weighs the verdict by.
    const { transport } = recordingTransport({
      state: 'done',
      result: { custom: { summary: 'ok' } },
    } as unknown as RunnerJobView)
    let presetModel: string | undefined = 'kimi-k2.7'
    const agent = makeAgent(transport, { presetModelForKind: () => presetModel })
    const handle = await agent.start(request())
    expect(handle.dispatch?.model).toContain('kimi')
    // The workspace switches its preset mid-run; the poll must not notice.
    presetModel = 'gemini-3.8-flash'
    const update = await agent.poll(handle)
    expect((update as { model?: string }).model).toContain('kimi')
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

// ---------------------------------------------------------------------------
// What a SETTLED dry run owes the ledger. This is the half the LLM proxy cannot cover: a
// subscription-routed prober talks to the vendor direct, so if this dispatcher files nothing the
// run's whole burn is absent from `llm_call_metrics`, from the leased token's usage-aware rotation
// and from the modeled quota cycle. Free and invisible, on the one flow whose own admission gate
// is a budget.
// ---------------------------------------------------------------------------
describe('ContainerEnvironmentProbeAgent: what a settled dry run records', () => {
  const SETTLED = {
    state: 'done',
    callMetrics: [{ seq: 1, inputTokens: 100, outputTokens: 20 }],
    result: {
      custom: { summary: 'ok' },
      usage: { inputTokens: 100, outputTokens: 20 },
      callMetrics: [{ seq: 1, inputTokens: 100, outputTokens: 20 }],
    },
  } as unknown as RunnerJobView

  it('files a POOLED subscription job: its calls, its token usage and its quota', async () => {
    const { transport } = recordingTransport(SETTLED)
    const { deps, filed } = recordingAccounting()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'kimi',
      pooledVendors: ['kimi'],
      leasePooled: async () => ({ tokenId: 'tok-pool-1', secret: 'pool-secret' }),
      accounting: deps,
    })
    const update = await agent.poll(await agent.start(request()))
    expect(update.state).toBe('done')
    // The per-call rows, under the RUN this dry run IS (a single-job flow: run id == job id) and
    // the prober's own kind, so they join to the self-test the SPA renders.
    expect(filed.calls[0]).toMatchObject({
      workspaceId: 'ws_1',
      executionId: 'envtest_1',
      jobId: 'envtest_1',
      agentKind: 'environment-prober-api',
    })
    // The leased pool row, which is what usage-aware rotation reads. Its id cannot be re-derived
    // at poll time, so this passes only because the dispatch carried it back.
    expect(filed.pooled).toEqual([{ workspaceId: 'ws_1', tokenId: 'tok-pool-1', inputTokens: 100 }])
    // Keyed on the VENDOR, not the model's provider: Kimi's ref says `moonshot`, and a fold that
    // took the provider counted this cycle as nothing at all.
    expect(filed.quota).toEqual([{ scope: 'pooled', scopeId: 'tok-pool-1', vendor: 'kimi' }])
  })

  it('counts a PERSONAL subscription job against the initiator, which leases no token', async () => {
    const { transport } = recordingTransport(SETTLED)
    const { deps, filed } = recordingAccounting()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'claude-opus',
      personalVendors: ['claude'],
      leasePersonal: async () => ({ secret: 'oauth-token' }),
      accounting: deps,
    })
    const handle = await agent.start(request())
    // No pooled id for an individual-usage credential, which is exactly why the quota fold is not
    // gated on one.
    expect(handle.dispatch?.subscriptionTokenId).toBeUndefined()
    await agent.poll(handle)
    expect(filed.pooled).toEqual([])
    expect(filed.quota).toEqual([{ scope: 'user', scopeId: 'usr_1', vendor: 'claude' }])
  })

  it('records the spend of a dry run that spent tokens and then FAILED', async () => {
    // The run an operator most needs the numbers for. Returning early on the failure branch is
    // what drops them.
    const { transport } = recordingTransport({
      state: 'done',
      result: {
        error: 'the agent gave up',
        usage: { inputTokens: 100, outputTokens: 20 },
        callMetrics: [{ seq: 1, inputTokens: 100, outputTokens: 20 }],
      },
    } as unknown as RunnerJobView)
    const { deps, filed } = recordingAccounting()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'kimi',
      pooledVendors: ['kimi'],
      leasePooled: async () => ({ tokenId: 'tok-pool-1', secret: 'pool-secret' }),
      accounting: deps,
    })
    const update = await agent.poll(await agent.start(request()))
    expect(update.state).toBe('failed')
    expect(filed.calls).toHaveLength(1)
    expect(filed.pooled).toHaveLength(1)
  })

  it('folds no pooled or quota usage for a Pi job, whose metering point is the proxy', async () => {
    const { transport } = recordingTransport(SETTLED)
    const { deps, filed } = recordingAccounting()
    const agent = makeAgent(transport, { presetModelForKind: () => 'qwen3-max', accounting: deps })
    await agent.poll(await agent.start(request()))
    // A proxied job leases no token and its provider is no subscription vendor, so both folds stay
    // silent rather than inventing a scope to attribute it to.
    expect(filed.pooled).toEqual([])
    expect(filed.quota).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The ADMISSION question about the MODEL, asked before a branch exists. Each case here, left to the
// dispatch, fails the run at `probing` after a throwaway branch, a full provision and a teardown,
// to report something the workspace's own preset already said.
// ---------------------------------------------------------------------------
describe('ContainerEnvironmentProbeAgent: whether the resolved model can be dispatched', () => {
  const subject = {
    workspaceId: 'ws_1',
    blockId: 'frame_1',
    surface: 'api' as const,
    initiatedBy: 'usr_1',
  }

  it('admits a proxyable model and names it', async () => {
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, { presetModelForKind: () => 'kimi-k2.7' })
    const check = await agent.checkDispatchable(subject)
    expect(check).toMatchObject({ ok: true, model: expect.stringContaining('kimi') })
  })

  it('refuses a provider the proxy cannot serve, in the words the dispatch would have thrown', async () => {
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, { presetModelForKind: () => 'claude-opus-4-8' })
    const check = await agent.checkDispatchable(subject)
    expect(check).toMatchObject({
      ok: false,
      detail: expect.stringContaining('the LLM proxy can serve'),
    })
    // And the same input still throws at the dispatch, so admission is an EARLIER no, not the
    // only one: a token revoked between the two must still stop the job.
    await expect(agent.start(request())).rejects.toThrow(/the LLM proxy can serve/)
  })

  it('refuses a subscription-only model whose credential nobody connected', async () => {
    // The case no ROUTING can notice: a subscription-only model carries its harness whatever any
    // pool holds, so `resolveDispatchRef` is perfectly happy and the missing credential surfaces
    // only as a throw from the lease, at the dispatch, after the environment is up.
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'claude-opus',
      leasePersonal: async () => ({ secret: 'oauth-token' }),
    })
    const check = await agent.checkDispatchable(subject)
    expect(check).toMatchObject({ ok: false, detail: expect.stringContaining('subscription') })
  })

  it('admits that same model once the initiator has the subscription', async () => {
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'claude-opus',
      personalVendors: ['claude'],
      leasePersonal: async () => ({ secret: 'oauth-token' }),
    })
    expect((await agent.checkDispatchable(subject)).ok).toBe(true)
  })

  it('refuses a POOLED harness this deployment cannot lease for at all', async () => {
    // A dual-mode model routed to its subscription flavour (the workspace holds a token) on a
    // deployment that wired no pooled lease: the routing picked a harness nothing here can open.
    const { transport } = recordingTransport()
    const agent = makeAgent(transport, {
      presetModelForKind: () => 'kimi',
      pooledVendors: ['kimi'],
    })
    const check = await agent.checkDispatchable(subject)
    expect(check).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not configured on this deployment'),
    })
  })
})
