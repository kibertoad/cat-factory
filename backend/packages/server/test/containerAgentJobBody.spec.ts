import type {
  AgentRunContext,
  ModelRef,
  RecordAgentContextInput,
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerJobResult,
  RunnerTransport,
} from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// Characterization snapshot of the harness job body `buildJobBody` produces for each
// agent kind. `buildJobBody` is private, so we drive it through `startJob` and capture
// what reaches the runner transport's `dispatch(ref, spec, kind)`. The Phase-3 refactor
// (ModelRouter + a common-body + per-kind delta table) is behaviour-preserving, so these
// snapshots must be byte-identical before and after — they are the diff-the-bodies guard
// the plan calls for.

const PI_REF: ModelRef = { provider: 'workers-ai', model: '@cf/test/model' }

const routing: AgentRouting = {
  default: { ref: PI_REF },
  byKind: {},
}

interface Captured {
  ref: RunnerJobRef
  spec: Record<string, unknown>
  kind: RunnerDispatchKind | undefined
}

function makeExecutor(depsOverride: Partial<ContainerAgentExecutorDependencies> = {}): {
  executor: ContainerAgentExecutor
  captured: Captured[]
} {
  const captured: Captured[] = []
  const transport: RunnerTransport = {
    async dispatch(ref, spec, kind) {
      captured.push({ ref, spec, kind })
    },
    async poll() {
      return { state: 'running' }
    },
  }
  const sessionService = {
    async mint() {
      return 'SESSION-TOKEN'
    },
  } as unknown as ContainerSessionService

  const deps: ContainerAgentExecutorDependencies = {
    resolveTransport: async () => transport,
    agentRouting: routing,
    resolveBlockModel: () => undefined,
    resolveRepoTarget: async () => ({
      installationId: 7,
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
    }),
    mintInstallationToken: async () => 'GH-TOKEN',
    sessionService,
    proxyBaseUrl: 'https://proxy.test/v1',
    githubApiBase: 'https://api.github.com',
    resolveWebSearchAvailability: async () => ({ available: true, provider: 'searxng' as const }),
    // Read-only agents only probe the work branch; return true so the read-only body
    // resolves to the shared work branch (the more interesting path).
    ensureWorkBranch: async () => true,
    ...depsOverride,
  }
  return { executor: new ContainerAgentExecutor(deps), captured }
}

function context(
  agentKind: string,
  overrides: Partial<AgentRunContext['block']> = {},
  service?: AgentRunContext['service'],
  extra: Partial<AgentRunContext> = {},
): AgentRunContext {
  return {
    agentKind: agentKind as AgentRunContext['agentKind'],
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      id: 'blk_1',
      title: 'Add widget',
      type: 'service',
      description: 'Implement the widget feature.',
      ...overrides,
    },
    ...(service ? { service } : {}),
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
    ...extra,
  }
}

const PR = { url: 'https://github.com/acme/widgets/pull/9', number: 9, branch: 'cat-factory/blk_1' }

describe('ContainerAgentExecutor.buildJobBody (per-kind body shapes)', () => {
  let executor: ContainerAgentExecutor
  let captured: Captured[]

  beforeEach(() => {
    const made = makeExecutor()
    executor = made.executor
    captured = made.captured
  })

  it('blueprints', async () => {
    await executor.startJob(context('blueprints'))
    expect(captured[0]).toMatchSnapshot()
  })

  it('spec-writer', async () => {
    await executor.startJob(context('spec-writer'))
    expect(captured[0]).toMatchSnapshot()
  })

  it('ci-fixer', async () => {
    await executor.startJob(context('ci-fixer', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('conflict-resolver', async () => {
    await executor.startJob(context('conflict-resolver', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('merger', async () => {
    await executor.startJob(context('merger', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('on-call', async () => {
    // Escalated after merge: clones the base branch and carries the (now-historical)
    // head branch + PR number so the agent can locate the merged commit.
    await executor.startJob(context('on-call', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('tester (docker-compose service)', async () => {
    await executor.startJob(
      context(
        'tester-api',
        { pullRequest: PR },
        { provisioning: { type: 'docker-compose', composePath: 'docker-compose.yml' } },
      ),
    )
    expect(captured[0]).toMatchSnapshot()
  })

  it('tester (infraless service) gets the no-dependencies run-mode guidance', async () => {
    // A service declared `infraless` must be told nothing was stood up — not the default
    // "your infra has been stood up on localhost" line (which would send the agent hunting
    // for services that never started).
    await executor.startJob(
      context('tester-api', { pullRequest: PR }, { provisioning: { type: 'infraless' } }),
    )
    const userPrompt = captured[0]!.spec.userPrompt as string
    expect(userPrompt).toContain('Run mode: no infra dependencies')
    expect(userPrompt).not.toContain('have been stood up on localhost')
    // The infra spec still flags it so the harness spins nothing up.
    expect(captured[0]!.spec.infra).toMatchObject({
      environment: 'local',
      noInfraDependencies: true,
    })
  })

  it('fixer', async () => {
    await executor.startJob(context('fixer', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('read-only (architect)', async () => {
    await executor.startJob(context('architect'))
    expect(captured[0]).toMatchSnapshot()
  })

  it('default (coder)', async () => {
    await executor.startJob(context('coder'))
    expect(captured[0]).toMatchSnapshot()
  })

  // The `code-commenter` kind clones `pr-or-work`: it AMENDS the coder's PR in place when one
  // exists (the BAU pipeline step), and OPENS its own PR when there is none (a standalone /
  // initiative sweep). One kind, two behaviours resolved from the block's PR at dispatch.
  it('code-commenter amends the coder PR in place when one exists (BAU pipeline step)', async () => {
    await executor.startJob(context('code-commenter', { pullRequest: PR }))
    const spec = captured[0]!.spec
    expect(spec.mode).toBe('coding')
    expect(spec.branch).toBe('cat-factory/blk_1') // clones the PR head
    expect(spec.pushBranch).toBe('cat-factory/blk_1') // pushes comment-only edits back onto it
    expect(spec.newBranch).toBeUndefined() // no new branch — edits in place
    expect(spec.pr).toBeUndefined() // opens no new PR
    expect(spec.noChangesIsError).toBe(false) // "comments already fine" is a clean non-event
  })

  it('code-commenter opens its own PR when the block has none (standalone / initiative sweep)', async () => {
    await executor.startJob(context('code-commenter'))
    const spec = captured[0]!.spec
    expect(spec.mode).toBe('coding')
    expect(spec.branch).toBe('main') // branches off base
    expect(spec.newBranch).toBe('cat-factory/blk_1') // onto a fresh work branch
    expect(spec.pushBranch).toBe('cat-factory/blk_1')
    expect(spec.pr).toBeDefined() // and opens a PR
    expect(spec.noChangesIsError).toBe(false)
  })

  // Read-only reference repos (doc-writer): a doc task with reference repos attached dispatches a
  // MULTI-REPO coding body carrying each reference as a READ-ONLY spec (repo only — no newBranch/pr)
  // plus a "Reference repositories" system-prompt section naming the sibling directories.
  const REFERENCE_REPOS: NonNullable<AgentRunContext['referenceRepos']> = [
    { repoId: 111, owner: 'acme', name: 'design-system', defaultBranch: 'trunk' },
  ]

  it('doc-writer emits read-only referenceRepos + a reference section', async () => {
    await executor.startJob({ ...context('doc-writer'), referenceRepos: REFERENCE_REPOS })
    const spec = captured[0]!.spec
    expect(spec.mode).toBe('coding')
    expect(spec.referenceRepos).toEqual([
      {
        repo: {
          owner: 'acme',
          name: 'design-system',
          baseBranch: 'trunk',
          cloneUrl: 'https://github.com/acme/design-system.git',
          provider: 'github',
        },
      },
    ])
    // Structurally unpushable: the reference leg carries no branch or PR.
    expect(spec.referenceRepos).not.toMatchObject([{ newBranch: expect.anything() }])
    expect(spec.referenceRepos).not.toMatchObject([{ pr: expect.anything() }])
    const systemPrompt = spec.systemPrompt as string
    expect(systemPrompt).toContain('## Reference repositories')
    expect(systemPrompt).toContain('acme__design-system/')
  })

  it('doc-writer with NO reference repos emits no referenceRepos field', async () => {
    await executor.startJob(context('doc-writer'))
    expect(captured[0]!.spec.referenceRepos).toBeUndefined()
    expect(captured[0]!.spec.systemPrompt).not.toContain('## Reference repositories')
  })

  it('a non-reference kind (coder) ignores referenceRepos on the context (kind gate)', async () => {
    await executor.startJob({ ...context('coder'), referenceRepos: REFERENCE_REPOS })
    expect(captured[0]!.spec.referenceRepos).toBeUndefined()
  })

  it('drops a reference that collides with the primary or another reference (sibling-dir dedup)', async () => {
    // The primary repo is `acme/widgets`. A reference pointing at it — or a duplicate reference —
    // would claim the same `owner__name` sibling directory as an existing leg, so the second clone
    // would fail into a non-empty dir. The executor dedups by that key, keeping only `design-system`.
    await executor.startJob({
      ...context('doc-writer'),
      referenceRepos: [
        { repoId: 999, owner: 'ACME', name: 'Widgets', defaultBranch: 'main' }, // == primary, dropped
        { repoId: 111, owner: 'acme', name: 'design-system', defaultBranch: 'trunk' },
        { repoId: 112, owner: 'acme', name: 'design-system', defaultBranch: 'trunk' }, // dup, dropped
      ],
    })
    const spec = captured[0]!.spec
    expect(spec.referenceRepos).toEqual([
      {
        repo: {
          owner: 'acme',
          name: 'design-system',
          baseBranch: 'trunk',
          cloneUrl: 'https://github.com/acme/design-system.git',
          provider: 'github',
        },
      },
    ])
  })

  it('folds a tuned kind’s loosen-only guard overrides into the job body', async () => {
    // conflict-resolver carries a built-in tuning entry (more error headroom). The body
    // must carry it so the harness loosens the guard for that kind.
    await executor.startJob(context('conflict-resolver', { pullRequest: PR }))
    expect(captured[0]!.spec.guardLimits).toEqual({ maxConsecutiveErrors: 20 })
  })

  it('omits guardLimits for an un-tuned kind (the harness keeps its defaults)', async () => {
    await executor.startJob(context('coder'))
    expect(captured[0]!.spec.guardLimits).toBeUndefined()
  })

  it('omits packageRegistries when no resolver is wired', async () => {
    await executor.startJob(context('coder'))
    expect(captured[0]!.spec.packageRegistries).toBeUndefined()
  })
})

// Apriori WORKING branch: a task names an existing branch as the run's starting point, so the
// executor swaps it in for the deterministic `cat-factory/<blockId>` work branch. The branch
// must pre-exist (probe-only, never created); a missing one — or one equal to base — fails the
// dispatch loudly.
describe('ContainerAgentExecutor apriori working branch', () => {
  const WORKING: NonNullable<AgentRunContext['aprioriBranches']> = [
    { name: 'feature/spike', mode: 'working' },
  ]

  it('coder builds inside the apriori working branch (newBranch/pushBranch swapped, PR head = it)', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob({ ...context('coder'), aprioriBranches: WORKING })
    const spec = captured[0]!.spec
    expect(spec.mode).toBe('coding')
    expect(spec.branch).toBe('main') // still branches off base…
    expect(spec.newBranch).toBe('feature/spike') // …onto the user's branch, not cat-factory/*
    expect(spec.pushBranch).toBe('feature/spike')
    expect(spec.pr).toBeDefined() // opens the PR from the apriori branch
  })

  it('a read-only agent explores the apriori working branch (probe reports it ready)', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob({ ...context('architect'), aprioriBranches: WORKING })
    expect(captured[0]!.spec.branch).toBe('feature/spike')
  })

  it('probes the apriori branch (create: false), never creating it', async () => {
    const calls: { branch: string; create: boolean }[] = []
    const { executor } = makeExecutor({
      ensureWorkBranch: async (_repo, branch, options) => {
        calls.push({ branch, create: options.create })
        return true
      },
    })
    await executor.startJob({ ...context('coder'), aprioriBranches: WORKING })
    expect(calls).toEqual([{ branch: 'feature/spike', create: false }])
  })

  it('fails the dispatch loudly when the apriori working branch does not exist', async () => {
    const { executor } = makeExecutor({ ensureWorkBranch: async () => false })
    await expect(
      executor.startJob({ ...context('coder'), aprioriBranches: WORKING }),
    ).rejects.toThrow(/feature\/spike.*does not exist/s)
  })

  it('rejects an apriori working branch equal to the repo base branch', async () => {
    const { executor } = makeExecutor()
    await expect(
      executor.startJob({
        ...context('coder'),
        aprioriBranches: [{ name: 'main', mode: 'working' }],
      }),
    ).rejects.toThrow(/base branch/)
  })

  it('takes the ready path (no probe) once a PR is open on the apriori branch', async () => {
    let probed = false
    const { executor, captured } = makeExecutor({
      ensureWorkBranch: async () => {
        probed = true
        return true
      },
    })
    await executor.startJob({
      ...context('coder', {
        pullRequest: { url: 'https://gh/pr/5', number: 5, branch: 'feature/spike' },
      }),
      aprioriBranches: WORKING,
    })
    expect(probed).toBe(false) // the recorded PR head IS the work branch → skip the round-trip
    // The work branch stays the apriori branch (a coder branches off base onto it).
    expect(captured[0]!.spec.newBranch).toBe('feature/spike')
    expect(captured[0]!.spec.pushBranch).toBe('feature/spike')
  })

  it('a reference-only apriori entry leaves the work branch as the platform default', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob({
      ...context('coder'),
      aprioriBranches: [{ name: 'spike/prior-art', mode: 'reference' }],
    })
    expect(captured[0]!.spec.newBranch).toBe('cat-factory/blk_1')
  })
})

describe('ContainerAgentExecutor multi-repo gate/merge targeting', () => {
  // Service-connections phase 4 follow-ups: the conflict-resolver is dispatched AT a conflicted
  // PEER repo, and the merger scores the COMBINED diff across every PR's repo. Both need the plural
  // repo resolver wired so the executor can resolve a connected service's repo target.
  const OWN_TARGET = { installationId: 7, owner: 'acme', name: 'widgets', baseBranch: 'main' }
  const PEER_TARGET = { installationId: 7, owner: 'acme', name: 'billing', baseBranch: 'develop' }

  // A plural resolver that returns the own service (primary) plus one peer resolved from
  // `frm_peer`. It only returns the peer when that frame is among the requested involved ids,
  // mirroring the real resolver (which resolves exactly the frames it is asked about).
  const resolveRepoTargets = async (
    _ws: string,
    _blk: string,
    frameIds: string[],
    primary: typeof OWN_TARGET = OWN_TARGET,
  ) => ({
    checkouts: [
      { target: primary, primary: true, involved: [] },
      ...(frameIds.includes('frm_peer')
        ? [{ target: PEER_TARGET, primary: false, involved: [{ frameId: 'frm_peer' }] }]
        : []),
    ],
  })

  it('conflict-resolver targets the conflicted PEER repo when the gate hands a conflictTarget', async () => {
    const { executor, captured } = makeExecutor({ resolveRepoTargets })
    await executor.startJob(
      context('conflict-resolver', { pullRequest: PR }, undefined, {
        conflictTarget: { repo: 'acme/billing', frameId: 'frm_peer' },
      }),
    )
    const spec = captured[0]!.spec
    // The harness clones the PEER repo (not the own `widgets`)…
    expect(spec.repo).toMatchObject({ owner: 'acme', name: 'billing' })
    // …merges the PEER's base in to surface its conflicts…
    expect(spec.mergeBase).toBe('develop')
    // …and resolves on the shared per-task work branch every repo's PR rides.
    expect(spec.branch).toBe('cat-factory/blk_1')
    expect(spec.pushBranch).toBe('cat-factory/blk_1')
  })

  it('conflict-resolver stays on the OWN repo when the conflictTarget has no frameId', async () => {
    const { executor, captured } = makeExecutor({ resolveRepoTargets })
    await executor.startJob(
      context('conflict-resolver', { pullRequest: PR }, undefined, {
        // An own-repo conflict carries no frameId (single-repo, implicit own target).
        conflictTarget: { repo: 'acme/widgets' } as never,
      }),
    )
    const spec = captured[0]!.spec
    expect(spec.repo).toMatchObject({ owner: 'acme', name: 'widgets' })
    expect(spec.mergeBase).toBe('main')
  })

  it('conflict-resolver resolves on the shared work branch when the OWN service has no PR (peer-only conflict)', async () => {
    // Peer-only conflict: the own service was unchanged (no own `pullRequest`), only the connected
    // peer conflicts. `prBranch` is therefore undefined, so the resolve branch must fall back to the
    // shared per-task work branch (`cat-factory/<blockId>`) every repo's PR rides — otherwise the
    // generic `pr`-clone path would clone the peer at its base branch (the wrong ref).
    const { executor, captured } = makeExecutor({ resolveRepoTargets })
    await executor.startJob(
      context('conflict-resolver', {}, undefined, {
        conflictTarget: { repo: 'acme/billing', frameId: 'frm_peer' },
      }),
    )
    const spec = captured[0]!.spec
    expect(spec.repo).toMatchObject({ owner: 'acme', name: 'billing' })
    expect(spec.mergeBase).toBe('develop')
    // The fallback (`prBranch ?? parts.workBranch`) pins clone/push to the shared work branch.
    expect(spec.branch).toBe('cat-factory/blk_1')
    expect(spec.pushBranch).toBe('cat-factory/blk_1')
  })

  it('conflict-resolver fails fast when the tagged peer repo cannot be resolved', async () => {
    // A stale/missing repo projection row for the conflicted frame must NOT silently fall through
    // to the own repo (which has no conflict) — that would loop the resolver until the whole attempt
    // budget is spent on the wrong repo. Dispatch throws loudly instead.
    const { executor } = makeExecutor({ resolveRepoTargets })
    await expect(
      executor.startJob(
        context('conflict-resolver', { pullRequest: PR }, undefined, {
          conflictTarget: { repo: 'acme/ghost', frameId: 'frm_missing' },
        }),
      ),
    ).rejects.toThrow(/could not resolve the conflicted peer repo/)
  })

  const PEER_PR = {
    repo: 'acme/billing',
    frameId: 'frm_peer',
    ref: { url: 'https://github.com/acme/billing/pull/3', number: 3, branch: 'cat-factory/blk_1' },
  }

  it('merger scores the COMBINED diff: peers cloned read-only (full) at their PR branch + a multi-repo section', async () => {
    const { executor, captured } = makeExecutor({ resolveRepoTargets })
    await executor.startJob(context('merger', { pullRequest: PR, peerPullRequests: [PEER_PR] }))
    const spec = captured[0]!.spec
    // Read-only explore, full clone (so `git diff origin/<base>...HEAD` has the merge base).
    expect(spec.mode).toBe('explore')
    expect(spec.full).toBe(true)
    // The peer PR's repo is a read-only sibling checked out at ITS PR branch (no newBranch/pr).
    expect(spec.peerRepos).toEqual([
      {
        repo: {
          owner: 'acme',
          name: 'billing',
          baseBranch: 'develop',
          cloneUrl: 'https://github.com/acme/billing.git',
          provider: 'github',
        },
        frameId: 'frm_peer',
        cloneBranch: 'cat-factory/blk_1',
      },
    ])
    expect(spec.peerRepos).not.toMatchObject([{ newBranch: expect.anything() }])
    expect(spec.peerRepos).not.toMatchObject([{ pr: expect.anything() }])
    // The system prompt names both sibling checkouts + their per-repo diff commands…
    const systemPrompt = spec.systemPrompt as string
    expect(systemPrompt).toContain('## Multi-repo pull request')
    expect(systemPrompt).toContain('acme__widgets/')
    expect(systemPrompt).toContain('acme__billing/')
    expect(systemPrompt).toContain('git diff origin/develop...HEAD')
    // …and the user prompt is the combined-diff variant (ONE assessment across repos).
    const userPrompt = spec.userPrompt as string
    expect(userPrompt).toContain('spans MULTIPLE repositories')
    expect(userPrompt).toContain('SINGLE')
  })

  it('merger stays single-repo when the task opened no peer PRs', async () => {
    const { executor, captured } = makeExecutor({ resolveRepoTargets })
    await executor.startJob(context('merger', { pullRequest: PR }))
    const spec = captured[0]!.spec
    expect(spec.peerRepos).toBeUndefined()
    expect(spec.systemPrompt).not.toContain('## Multi-repo pull request')
    // The single-repo prompt still names the own diff.
    expect(spec.userPrompt as string).toContain('git diff origin/main...HEAD')
  })
})

describe('ContainerAgentExecutor private package registries', () => {
  const REGISTRIES = [
    {
      ecosystem: 'npm' as const,
      host: 'registry.npmjs.org',
      scopes: ['@acme'],
      token: 'npm_private_registry_token',
    },
  ]

  function makeExecutorWithRegistries(recorded: RecordAgentContextInput[]): {
    executor: ContainerAgentExecutor
    captured: Captured[]
  } {
    const captured: Captured[] = []
    const transport: RunnerTransport = {
      async dispatch(ref, spec, kind) {
        captured.push({ ref, spec, kind })
      },
      async poll() {
        return { state: 'running' }
      },
    }
    const executor = new ContainerAgentExecutor({
      resolveTransport: async () => transport,
      agentRouting: routing,
      resolveBlockModel: () => undefined,
      resolveRepoTarget: async () => ({
        installationId: 7,
        owner: 'acme',
        name: 'widgets',
        baseBranch: 'main',
      }),
      mintInstallationToken: async () => 'GH-TOKEN',
      sessionService: {
        async mint() {
          return 'SESSION-TOKEN'
        },
      } as unknown as ContainerSessionService,
      proxyBaseUrl: 'https://proxy.test/v1',
      githubApiBase: 'https://api.github.com',
      ensureWorkBranch: async () => true,
      resolvePackageRegistries: async () => REGISTRIES,
      agentContextObservability: {
        async record(input) {
          recorded.push(input)
        },
      },
    })
    return { executor, captured }
  }

  it('forwards the resolved entries on a coding kind and an explore kind alike', async () => {
    const { executor, captured } = makeExecutorWithRegistries([])
    await executor.startJob(context('coder'))
    await executor.startJob(context('architect'))
    expect(captured[0]!.spec.packageRegistries).toEqual(REGISTRIES)
    expect(captured[1]!.spec.packageRegistries).toEqual(REGISTRIES)
  })

  it('never leaks the registry token into the agent-context snapshot (allow-list projection)', async () => {
    const recorded: RecordAgentContextInput[] = []
    const { executor } = makeExecutorWithRegistries(recorded)
    await executor.startJob(context('coder'))
    expect(recorded).toHaveLength(1)
    const serialized = JSON.stringify(recorded[0])
    expect(serialized).not.toContain('npm_private_registry_token')
    expect(serialized).not.toContain('packageRegistries')
  })

  it('propagates a resolution failure (a configured workspace must not run without auth)', async () => {
    const transport: RunnerTransport = {
      async dispatch() {},
      async poll() {
        return { state: 'running' }
      },
    }
    const executor = new ContainerAgentExecutor({
      resolveTransport: async () => transport,
      agentRouting: routing,
      resolveBlockModel: () => undefined,
      resolveRepoTarget: async () => ({
        installationId: 7,
        owner: 'acme',
        name: 'widgets',
        baseBranch: 'main',
      }),
      mintInstallationToken: async () => 'GH-TOKEN',
      sessionService: {
        async mint() {
          return 'SESSION-TOKEN'
        },
      } as unknown as ContainerSessionService,
      proxyBaseUrl: 'https://proxy.test/v1',
      resolvePackageRegistries: async () => {
        throw new Error('decrypt failed')
      },
    })
    await expect(executor.startJob(context('coder'))).rejects.toThrow('decrypt failed')
  })
})

// The migrated merger/on-call dispatch the generic `agent` kind and return their JSON as
// `result.custom`; `toRunResult` maps it KIND-AWARE into `mergeAssessment`/`onCallAssessment`
// using the handle's `agentKind`. These tests pin that mapping (the poll site must supply
// `agentKind`, else the coercion silently no-ops and the merge gate sees no assessment) plus
// the conservative-on-garbage defaults that replace the harness's old `diffExaminable` guard.
function makeExecutorReturning(result: RunnerJobResult): ContainerAgentExecutor {
  const transport: RunnerTransport = {
    async dispatch() {},
    async poll() {
      return { state: 'done', result }
    },
  }
  const sessionService = {
    async mint() {
      return 'SESSION-TOKEN'
    },
  } as unknown as ContainerSessionService
  const deps: ContainerAgentExecutorDependencies = {
    resolveTransport: async () => transport,
    agentRouting: routing,
    resolveBlockModel: () => undefined,
    resolveRepoTarget: async () => ({
      installationId: 7,
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
    }),
    mintInstallationToken: async () => 'GH-TOKEN',
    sessionService,
    proxyBaseUrl: 'https://proxy.test/v1',
    githubApiBase: 'https://api.github.com',
    resolveWebSearchAvailability: async () => ({ available: true, provider: 'searxng' as const }),
    ensureWorkBranch: async () => true,
  }
  return new ContainerAgentExecutor(deps)
}

const handle = (agentKind?: string) => ({
  jobId: 'ex_1-step',
  runId: 'ex_1',
  workspaceId: 'ws_1',
  ...(agentKind ? { agentKind } : {}),
})

describe('ContainerAgentExecutor.pollJob (kind-aware result coercion)', () => {
  it('maps a merger custom result into mergeAssessment', async () => {
    const executor = makeExecutorReturning({
      summary: 'Looks routine.',
      custom: { complexity: 0.2, risk: 0.3, impact: 0.4, rationale: 'small, isolated change' },
    })
    const update = await executor.pollJob(handle('merger'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Looks routine.',
        mergeAssessment: {
          complexity: 0.2,
          risk: 0.3,
          impact: 0.4,
          rationale: 'small, isolated change',
        },
      },
    })
  })

  it('maps an on-call custom result into onCallAssessment', async () => {
    const executor = makeExecutorReturning({
      summary: 'Likely unrelated.',
      custom: {
        culpritConfidence: 0.1,
        recommendation: 'monitor',
        rationale: 'no correlation with the diff',
        evidence: ['latency flat', 42],
      },
    })
    const update = await executor.pollJob(handle('on-call'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Likely unrelated.',
        onCallAssessment: {
          culpritConfidence: 0.1,
          recommendation: 'monitor',
          rationale: 'no correlation with the diff',
          evidence: ['latency flat'],
        },
      },
    })
  })

  it('garbage/null merger scores default to 1 (severe → human review), not 0', async () => {
    const executor = makeExecutorReturning({
      summary: 'fallback summary',
      // null / empty-string / boolean must NOT coerce to a finite 0.
      custom: { complexity: null, risk: '', impact: false, rationale: '' },
    })
    const update = await executor.pollJob(handle('merger'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'fallback summary',
        mergeAssessment: { complexity: 1, risk: 1, impact: 1, rationale: 'fallback summary' },
      },
    })
  })

  it('maps a tester custom result into a coerced testReport (greenlight withheld on a blocker)', async () => {
    const executor = makeExecutorReturning({
      summary: 'Ran the suite.',
      custom: {
        // greenlight:true with an open high-severity concern must NOT auto-pass.
        greenlight: true,
        summary: 'Two flows broke.',
        tested: ['login', 42],
        outcomes: [
          { name: 'login', status: 'failed', detail: '500 on submit' },
          { name: 'mystery', status: 'banana' },
        ],
        concerns: [{ title: 'Login 500', detail: 'crashes', severity: 'high' }],
        environment: 'local',
      },
    })
    const update = await executor.pollJob(handle('tester-api'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Ran the suite.',
        testReport: {
          greenlight: false,
          summary: 'Two flows broke.',
          tested: ['login'],
          outcomes: [
            { name: 'login', status: 'failed', detail: '500 on submit' },
            { name: 'mystery', status: 'skipped' },
          ],
          concerns: [{ title: 'Login 500', detail: 'crashes', severity: 'high' }],
          environment: 'local',
        },
      },
    })
  })

  it('garbage tester JSON coerces to a safe, no-greenlight report', async () => {
    const executor = makeExecutorReturning({ summary: 'nothing usable', custom: { junk: true } })
    const update = await executor.pollJob(handle('tester-api'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'nothing usable',
        testReport: {
          greenlight: false,
          summary: 'nothing usable',
          tested: [],
          outcomes: [],
          concerns: [],
        },
      },
    })
  })

  it('maps a blueprints custom result into a coerced blueprintService', async () => {
    const executor = makeExecutorReturning({
      summary: 'Mapped the service.',
      custom: {
        name: 'Widgets',
        summary: 'A widget service',
        // `references` malformed (number dropped), an unknown type falls back to 'service'.
        type: 'banana',
        references: ['src/index.ts', 7],
        modules: [{ name: 'Billing', summary: 'Invoices', references: [] }],
      },
    })
    const update = await executor.pollJob(handle('blueprints'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Mapped the service.',
        blueprintService: {
          type: 'service',
          name: 'Widgets',
          summary: 'A widget service',
          references: ['src/index.ts'],
          modules: [{ name: 'Billing', summary: 'Invoices', references: [] }],
        },
      },
    })
  })

  it('a nameless blueprints tree coerces away (no blueprintService), leaving plain output', async () => {
    const executor = makeExecutorReturning({ summary: 'nothing usable', custom: { modules: [] } })
    const update = await executor.pollJob(handle('blueprints'))
    expect(update).toEqual({ state: 'done', result: { output: 'nothing usable' } })
  })

  it('maps a spec-writer custom result into a coerced spec doc', async () => {
    const executor = makeExecutorReturning({
      summary: 'Wrote the spec.',
      custom: {
        service: 'Widgets',
        summary: 'A widget service',
        modules: [
          {
            name: 'Auth',
            summary: 'Authentication',
            groups: [
              {
                name: 'Login',
                summary: 'Signing in',
                requirements: [
                  {
                    id: 'req-login',
                    title: 'Password login',
                    statement: 'The system SHALL authenticate by password.',
                    kind: 'functional',
                    priority: 'must',
                    sourceBlockIds: [],
                    acceptance: [
                      {
                        id: 'ac-1',
                        given: 'a user',
                        when: 'they sign in',
                        outcome: 'a session opens',
                      },
                    ],
                  },
                ],
                rules: [],
              },
            ],
          },
        ],
      },
    })
    const update = await executor.pollJob(handle('spec-writer'))
    expect(update.state).toBe('done')
    // The custom doc is coerced into the `spec` channel the engine strict-validates +
    // the specPostOp shards/commits from (no raw `custom` left behind).
    const result = update.state === 'done' ? update.result : undefined
    expect(result?.output).toBe('Wrote the spec.')
    expect(result && 'custom' in result).toBe(false)
    expect(result?.spec).toMatchObject({
      service: 'Widgets',
      modules: [{ name: 'Auth', groups: [{ name: 'Login' }] }],
    })
  })

  it('a nameless spec-writer doc coerces away (no spec), leaving plain output', async () => {
    const executor = makeExecutorReturning({ summary: 'nothing usable', custom: { modules: [] } })
    const update = await executor.pollJob(handle('spec-writer'))
    expect(update).toEqual({ state: 'done', result: { output: 'nothing usable' } })
  })

  it('surfaces the PR for a coding result that reports BOTH pushed and prUrl', async () => {
    // The generic coding flow returns `pushed:true` AND `prUrl` (the coder). `prUrl` must
    // win over the in-place-fixer `pushed` branch, else the structured PR is silently lost.
    const executor = makeExecutorReturning({
      summary: 'Implemented the widget.',
      pushed: true,
      prUrl: 'https://github.com/acme/widgets/pull/9',
      branch: 'cat-factory/blk_1',
    })
    const update = await executor.pollJob(handle('coder'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Implemented the widget.\n\nPR: https://github.com/acme/widgets/pull/9',
        pullRequest: {
          url: 'https://github.com/acme/widgets/pull/9',
          number: 9,
          branch: 'cat-factory/blk_1',
        },
      },
    })
  })

  it('maps an in-place fixer result (pushed, no prUrl) to a plain pushed output', async () => {
    const executor = makeExecutorReturning({ summary: 'Fixed the failing build.', pushed: true })
    const update = await executor.pollJob(handle('ci-fixer'))
    expect(update).toEqual({
      state: 'done',
      result: { output: 'Fixed the failing build.' },
    })
  })

  it('without agentKind the coercion no-ops and the raw custom is surfaced', async () => {
    const executor = makeExecutorReturning({
      summary: 's',
      custom: { complexity: 0.2, risk: 0.3, impact: 0.4 },
    })
    const update = await executor.pollJob(handle())
    expect(update).toEqual({
      state: 'done',
      result: { output: 's', custom: { complexity: 0.2, risk: 0.3, impact: 0.4 } },
    })
  })
})
