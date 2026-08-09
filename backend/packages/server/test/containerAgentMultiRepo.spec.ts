import type {
  AgentRunContext,
  ModelRef,
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerTransport,
} from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'
// Derived rather than spelled out: what these specs are about is that the prompt names the
// sibling checkout for each repo, not what that name looks like. The NAME's shape is pinned
// where it matters, against the harness that creates the directory, by the executor-harness's
// `harness-contract.conformity.test.ts`.
import { siblingCheckoutDir } from '../src/agents/harnessContract.js'

// How ONE dispatch is laid out across SEVERAL repos: the conflict-resolver retargeted at a
// conflicted peer, the merger's combined-diff siblings, and the coder's fan-out over a monorepo
// hosting more than one of the run's involved services. Split out of `containerAgentJobBody.spec`
// (which pins the per-kind body SHAPES) when that file hit its size budget: what these assert is
// the multi-repo LAYOUT, and it is the one cluster in there with a subject of its own.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: '@cf/test/model' } as ModelRef },
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
  const deps: ContainerAgentExecutorDependencies = {
    resolveTransport: async () => transport,
    agentRouting: routing,
    resolveBlockModel: () => undefined,
    resolveRepoTarget: async () => ({
      installationId: 7,
      repoId: '1001',
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
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
    ...extra,
  }
}

const PR = { url: 'https://github.com/acme/widgets/pull/9', number: 9, branch: 'cat-factory/blk_1' }

describe('ContainerAgentExecutor multi-repo gate/merge targeting', () => {
  // Service-connections phase 4 follow-ups: the conflict-resolver is dispatched AT a conflicted
  // PEER repo, and the merger scores the COMBINED diff across every PR's repo. Both need the plural
  // repo resolver wired so the executor can resolve a connected service's repo target.
  const OWN_TARGET = {
    installationId: 7,
    repoId: '1001',
    owner: 'acme',
    name: 'widgets',
    baseBranch: 'main',
  }
  const PEER_TARGET = {
    installationId: 7,
    repoId: '1001',
    owner: 'acme',
    name: 'billing',
    baseBranch: 'develop',
  }

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
      context(
        'conflict-resolver',
        { pullRequest: PR },
        {
          conflictTarget: { repo: 'acme/billing', frameId: 'frm_peer' },
        },
      ),
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
      context(
        'conflict-resolver',
        { pullRequest: PR },
        {
          // An own-repo conflict carries no frameId (single-repo, implicit own target).
          conflictTarget: { repo: 'acme/widgets' } as never,
        },
      ),
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
      context(
        'conflict-resolver',
        {},
        {
          conflictTarget: { repo: 'acme/billing', frameId: 'frm_peer' },
        },
      ),
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
        context(
          'conflict-resolver',
          { pullRequest: PR },
          {
            conflictTarget: { repo: 'acme/ghost', frameId: 'frm_missing' },
          },
        ),
      ),
    ).rejects.toThrow(/could not resolve the conflicted peer repo/)
  })

  const PEER_PR = {
    repo: 'acme/billing',
    frameIds: ['frm_peer'],
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
        frameIds: ['frm_peer'],
        cloneBranch: 'cat-factory/blk_1',
      },
    ])
    expect(spec.peerRepos).not.toMatchObject([{ newBranch: expect.anything() }])
    expect(spec.peerRepos).not.toMatchObject([{ pr: expect.anything() }])
    // The system prompt names both sibling checkouts + their per-repo diff commands…
    const systemPrompt = spec.systemPrompt as string
    expect(systemPrompt).toContain('## Multi-repo pull request')
    expect(systemPrompt).toContain(`${siblingCheckoutDir('acme', 'widgets')}/`)
    expect(systemPrompt).toContain(`${siblingCheckoutDir('acme', 'billing')}/`)
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

// The fan-out checks out one repo per REPO, not per frame, so a monorepo hosting several of the
// run's involved services is ONE sibling checkout carrying all of them. These pin what that costs
// the dispatch: the checkout must be whole-repo (nothing scoped to one service's subdirectory, or
// the others are out of reach) and it must name EVERY frame it carries, since the single PR the
// harness opens for it is where all of their changes land.
describe('ContainerAgentExecutor multi-repo fan-out over a shared monorepo', () => {
  const OWN_TARGET = {
    installationId: 7,
    repoId: '1001',
    owner: 'acme',
    name: 'widgets',
    baseBranch: 'main',
  }
  // One peer repo, flagged a monorepo, hosting TWO involved services in different subtrees.
  const MONO_TARGET = {
    installationId: 7,
    repoId: '2002',
    owner: 'acme',
    name: 'platform',
    baseBranch: 'main',
    serviceDirectory: 'services/billing',
  }
  const resolveRepoTargets = async () => ({
    checkouts: [
      { target: OWN_TARGET, primary: true, involved: [] },
      {
        target: MONO_TARGET,
        primary: false,
        involved: [
          { frameId: 'frm_billing', serviceDirectory: 'services/billing' },
          { frameId: 'frm_ledger', serviceDirectory: 'services/ledger' },
        ],
      },
    ],
  })
  const involved = [
    { frameId: 'frm_billing', name: 'billing' },
    { frameId: 'frm_ledger', name: 'ledger' },
  ] as never

  it('clones the monorepo ONCE, at its root, attributing every frame it hosts to that one leg', async () => {
    const { executor, captured } = makeExecutor({ resolveRepoTargets })
    await executor.startJob(context('coder', {}, { involvedServices: involved }))
    const spec = captured[0]!.spec
    const peers = spec.peerRepos as { repo: Record<string, unknown>; frameIds?: string[] }[]

    // ONE checkout for the repo, not one per involved service.
    expect(peers).toHaveLength(1)
    expect(peers[0]!.repo).toMatchObject({ owner: 'acme', name: 'platform' })
    // Whole-repo: scoping it to whichever service resolved first would put the other's subtree
    // out of the agent's reach. The prompt section names each service's subdirectory instead.
    expect(peers[0]!.repo).not.toHaveProperty('serviceDirectory')
    // Both frames ride the one leg, so the peer PR the harness echoes back is recorded against
    // both of them rather than against whichever happened to resolve first.
    expect(peers[0]!.frameIds).toEqual(['frm_billing', 'frm_ledger'])
  })

  it('gives every repo the SAME work branch, so each repo opens exactly one combined PR', async () => {
    const { executor, captured } = makeExecutor({ resolveRepoTargets })
    await executor.startJob(context('coder', {}, { involvedServices: involved }))
    const spec = captured[0]!.spec
    const peers = spec.peerRepos as { newBranch?: string }[]
    expect(spec.newBranch).toBe('cat-factory/blk_1')
    expect(peers.map((p) => p.newBranch)).toEqual(['cat-factory/blk_1'])
  })

  it('names both co-located services in the layout section so the agent edits both subtrees', async () => {
    const { executor, captured } = makeExecutor({ resolveRepoTargets })
    await executor.startJob(context('coder', {}, { involvedServices: involved }))
    const systemPrompt = captured[0]!.spec.systemPrompt as string
    expect(systemPrompt).toContain('## Multi-repo workspace')
    expect(systemPrompt).toContain(`${siblingCheckoutDir('acme', 'platform')}/`)
    expect(systemPrompt).toContain('services/billing/')
    expect(systemPrompt).toContain('services/ledger/')
  })
})
