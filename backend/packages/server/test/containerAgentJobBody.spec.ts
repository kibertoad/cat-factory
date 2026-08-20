import type {
  AgentRunContext,
  ModelRef,
  RecordAgentContextInput,
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerJobResult,
  RunnerTransport,
} from '@cat-factory/kernel'
import {
  CONTEXT_DOCUMENTS_OVER_BUDGET,
  FOUNDATIONAL_CATALOG_FILE,
  ValidationError,
} from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import {
  EFFORT_REPORT_FILE,
  EFFORT_REPORT_GUIDANCE,
  EXECUTION_SANDBOX_GUIDANCE,
  READ_ONLY_GUARDRAIL,
} from '@cat-factory/agents'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'
// Derived rather than spelled out: what these specs are about is that the prompt names the
// sibling checkout for each repo, not what that name looks like. The NAME's shape is pinned
// where it matters, against the harness that creates the directory, by the executor-harness's
// `harness-contract.conformity.test.ts`. Hard-coding it here would put a third copy of the rule
// in a spec that has no way to tell the harness it moved.
import { siblingCheckoutDir } from '../src/agents/harnessContract.js'

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
      repoId: '1001',
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

  // Trait guidance that NAMES an injected `.cat-context/` file is gated on that file arriving, and
  // the snapshots above are dispatches that inject none: neither the architect nor the coder now
  // carries the foundational reuse mandate there. Both directions have to be pinned, because a
  // regression in either is silent — the gate stuck shut is a design that never hears about the
  // shared services it should be reusing, and the gate stuck open is the ~200 words of dangling
  // pointer this replaced.
  it('gates the foundational guidance on the catalog file this dispatch actually injected', async () => {
    await executor.startJob(context('architect'))
    expect(captured[0]!.spec.systemPrompt as string).not.toContain(FOUNDATIONAL_CATALOG_FILE)

    await executor.startJob(
      context('architect', {}, undefined, {
        injectedContextFiles: [{ path: FOUNDATIONAL_CATALOG_FILE, content: '# services' }],
      }),
    )
    const withCatalog = captured[1]!.spec.systemPrompt as string
    expect(withCatalog).toContain(FOUNDATIONAL_CATALOG_FILE)
    expect(withCatalog).toContain('Prefer an existing foundational service')
  })

  // The two directives below are only ever composed TOGETHER here, at the container-dispatch
  // chokepoint: the guardrail rides `systemPromptFor` and the effort report is appended by
  // `buildKindBody`, so neither package can assert the pair on its own.
  it('reconciles the read-only guardrail with the effort report it is handed', async () => {
    await executor.startJob(context('architect'))
    const systemPrompt = captured[0]!.spec.systemPrompt as string
    expect(systemPrompt).toContain(READ_ONLY_GUARDRAIL)
    expect(systemPrompt).toContain(EFFORT_REPORT_GUIDANCE)
    // One instruction forbids creating files and the other orders one written, so the CARVE-OUT
    // rides the effort report: it is the half that reaches every kind the other half can
    // contradict. Without it an agent either disobeyed one of them or spent a turn asking which
    // won, on every read-only run.
    expect(EFFORT_REPORT_GUIDANCE).toContain(EFFORT_REPORT_FILE)
    expect(EFFORT_REPORT_GUIDANCE).toMatch(/forbid you to create, modify or commit/)
    // And the effort report no longer times itself off a commit the agent may not make.
    expect(EFFORT_REPORT_GUIDANCE).not.toContain('after any commit/push')
    // The guardrail claims nothing about the sentinel, so it needs no position relative to the
    // report and stays true on the inline surfaces that also receive it.
    expect(READ_ONLY_GUARDRAIL).not.toContain(EFFORT_REPORT_FILE)
    expect(READ_ONLY_GUARDRAIL).not.toMatch(/instructions below/)
  })

  // The kinds whose write prohibition is written into a BESPOKE prompt rather than appended by
  // `applySurfaceDirectives`. `composedSystemPromptFor` short-circuits for them, so a carve-out
  // scoped off the surface never reaches them — which is why it lives on the effort report, the
  // one text this chokepoint hands to every container kind whatever its prompt came from.
  it('reconciles the pair for a bespoke container kind too, not only a surface-directed one', async () => {
    for (const kind of ['on-call', 'merger']) {
      const { executor: exec, captured: seen } = makeExecutor()
      await exec.startJob(context(kind))
      const systemPrompt = seen[0]!.spec.systemPrompt as string
      expect(systemPrompt).toContain(EFFORT_REPORT_GUIDANCE)
      // `on-call` is the case that bites: its own directives forbid every write, and nothing in
      // its composition path can see the effort report it is about to be handed.
      expect(systemPrompt).toMatch(/forbid you to create, modify or commit/)
    }
    // `on-call` is the case that bites: its own directives forbid every write, so without the
    // carve-out riding the effort report it is handed an unsatisfiable pair on every dispatch.
    const { executor: onCallExec, captured: onCallSeen } = makeExecutor()
    await onCallExec.startJob(context('on-call'))
    expect(onCallSeen[0]!.spec.systemPrompt as string).toContain(
      'MUST NOT modify, commit or revert anything',
    )
  })

  it('states the execution sandbox contract to every container kind, not just one', async () => {
    // Platform facts no agent can derive from the checkout (every tool probed rather than assumed,
    // no cluster or registry credentials, toolchain versions that are the environment's), plus the
    // rule that an artifact this environment cannot execute is not incomplete for that reason.
    // Absent, a coder and its reviewer each rediscovered that the Dockerfile they were asked for
    // could not be built here.
    for (const kind of ['coder', 'architect', 'reviewer', 'tester-api', 'merger']) {
      const { executor: exec, captured: seen } = makeExecutor()
      await exec.startJob(context(kind))
      expect(seen[0]!.spec.systemPrompt as string).toContain(EXECUTION_SANDBOX_GUIDANCE)
    }
    // `reviewer` is in that list, which is what bounds how far the rule may go: unverifiable is
    // not the same as correct, so the paragraph may not call the artifact correct nor tell the
    // reviewer to withhold a defect it can actually see. Only the LIMIT is not a finding.
    expect(EXECUTION_SANDBOX_GUIDANCE).not.toMatch(/complete and correct deliverable/)
    expect(EXECUTION_SANDBOX_GUIDANCE).toMatch(/not raise the limit itself as a finding/)
    expect(EXECUTION_SANDBOX_GUIDANCE).toMatch(/a defect you can actually see in the artifact/)
    // And it describes the environment without naming one: the same body serves the harness image
    // and, under `LOCAL_NATIVE_AGENTS`, the developer's own machine as a host process, where
    // "an ephemeral Linux container" and "there is no Kubernetes tooling" are both false.
    expect(EXECUTION_SANDBOX_GUIDANCE).toMatch(/a disposable working environment/)
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

  // The reviewer-briefing (PR description) sentinel guidance rides ONLY a dispatch that opens a
  // PR: the coder gets it; an in-place fixer (amends a PR whose description it doesn't own) and
  // a code-commenter amend run do not.
  it('asks a PR-opening coder for the reviewer briefing', async () => {
    await executor.startJob(context('coder'))
    expect(captured[0]!.spec.systemPrompt as string).toContain('PULL REQUEST DESCRIPTION')
  })

  it('does not ask an in-place fixer for the reviewer briefing', async () => {
    await executor.startJob(context('fixer', { pullRequest: PR }))
    expect(captured[0]!.spec.systemPrompt as string).not.toContain('PULL REQUEST DESCRIPTION')
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
    expect(systemPrompt).toContain(`${siblingCheckoutDir('acme', 'design-system')}/`)
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

  it('refuses the dispatch when the linked context overflows the byte budget', async () => {
    // The unit test on `buildContextFiles` proves the throw; this proves it survives `startJob`
    // — nothing reaches the transport, and the throw is a `DomainError` carrying the cause code,
    // which is what makes `classifyDispatchFailure` file it as a `preflight` rejection rather
    // than "the container failed to start".
    const error = await executor
      .startJob(
        context('coder', {
          contextDocs: [
            {
              title: 'Platform PRD',
              url: 'https://wiki.test/prd',
              origin: 'confluence' as const,
              excerpt: 'x',
              summary: 'x',
              body: 'x'.repeat(300_000),
            },
          ],
        }),
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details?.reason).toBe(CONTEXT_DOCUMENTS_OVER_BUDGET)
    expect((error as ValidationError).message).toContain('"Platform PRD"')
    // No partial corpus was shipped: the agent never got a half-context it could not detect.
    expect(captured).toEqual([])
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

// Apriori REFERENCE branches: a task names existing branches of its OWN repo as read-only
// prior-art. The consumer kinds (coder / spec-writer / doc-writer / architect / analysis) receive
// them as a `referenceBranches` job field (fetched into `origin/<b>` by the harness) + a "Reference
// branches" system-prompt section; a missing one is DROPPED at dispatch (probe-only, asymmetric
// with a missing WORKING branch, which fails loudly).
describe('ContainerAgentExecutor apriori reference branches', () => {
  const REFS: NonNullable<AgentRunContext['aprioriBranches']> = [
    { name: 'spike/prior-art', mode: 'reference' },
    { name: 'proto/v2', mode: 'reference' },
  ]

  it('coder (coding body) carries referenceBranches + a section, never a branch/PR for them', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob({ ...context('coder'), aprioriBranches: REFS })
    const spec = captured[0]!.spec
    expect(spec.mode).toBe('coding')
    expect(spec.referenceBranches).toEqual(['spike/prior-art', 'proto/v2'])
    // The work branch is unchanged — reference branches never become the run's HEAD.
    expect(spec.newBranch).toBe('cat-factory/blk_1')
    expect(spec.pushBranch).toBe('cat-factory/blk_1')
    const systemPrompt = spec.systemPrompt as string
    expect(systemPrompt).toContain('## Reference branches')
    expect(systemPrompt).toContain('origin/spike/prior-art')
    expect(systemPrompt).toContain('origin/proto/v2')
  })

  it('architect (explore body) carries referenceBranches + a section', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob({ ...context('architect'), aprioriBranches: REFS })
    const spec = captured[0]!.spec
    expect(spec.mode).toBe('explore')
    expect(spec.referenceBranches).toEqual(['spike/prior-art', 'proto/v2'])
    expect(spec.systemPrompt as string).toContain('## Reference branches')
  })

  it('spec-writer (structured explore) carries referenceBranches', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob({ ...context('spec-writer'), aprioriBranches: REFS })
    expect(captured[0]!.spec.referenceBranches).toEqual(['spike/prior-art', 'proto/v2'])
  })

  it('a non-consumer kind (merger) ignores reference branches (kind gate)', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob({
      ...context('merger', { pullRequest: PR }),
      aprioriBranches: REFS,
    })
    expect(captured[0]!.spec.referenceBranches).toBeUndefined()
    expect(captured[0]!.spec.systemPrompt as string).not.toContain('## Reference branches')
  })

  it('drops a reference branch that no longer exists (probe reports it missing)', async () => {
    const { executor, captured } = makeExecutor({
      ensureWorkBranch: async (_repo, branch) => branch !== 'proto/v2',
    })
    await executor.startJob({ ...context('coder'), aprioriBranches: REFS })
    expect(captured[0]!.spec.referenceBranches).toEqual(['spike/prior-art'])
  })

  it('emits no referenceBranches field when all named branches are missing', async () => {
    const { executor, captured } = makeExecutor({ ensureWorkBranch: async () => false })
    await executor.startJob({ ...context('coder'), aprioriBranches: REFS })
    expect(captured[0]!.spec.referenceBranches).toBeUndefined()
    expect(captured[0]!.spec.systemPrompt as string).not.toContain('## Reference branches')
  })

  it('never fetches the working branch as a reference (dedup vs the resolved work branch)', async () => {
    // A working + reference pair where the reference happens to equal the resolved work branch is
    // excluded from the fetch list (the agent already builds ON that branch).
    const { executor, captured } = makeExecutor()
    await executor.startJob({
      ...context('coder'),
      aprioriBranches: [
        { name: 'feature/spike', mode: 'working' },
        { name: 'feature/spike', mode: 'reference' },
        { name: 'proto/v2', mode: 'reference' },
      ],
    })
    const spec = captured[0]!.spec
    expect(spec.newBranch).toBe('feature/spike')
    expect(spec.referenceBranches).toEqual(['proto/v2'])
  })

  it('forwards named branches unprobed when ensureWorkBranch is unwired (tests / no GitHub)', async () => {
    const { executor, captured } = makeExecutor({ ensureWorkBranch: undefined })
    await executor.startJob({ ...context('coder'), aprioriBranches: REFS })
    expect(captured[0]!.spec.referenceBranches).toEqual(['spike/prior-art', 'proto/v2'])
  })
})

// The pr-reviewer (`clone.prHead`) reviews an EXISTING PR: the engine resolves that PR's number
// from the review task's fields (`prNumber`/`prUrl`, the same source the diff pre-op uses) into the
// job's `reviewPrNumber`, so the harness can prefetch `pull/<n>/head` into `origin/pr-head`. A kind
// without `clone.prHead` never carries it, and an unresolvable number degrades to no prefetch.
describe('ContainerAgentExecutor pr-reviewer PR-head prefetch (reviewPrNumber)', () => {
  it('carries reviewPrNumber resolved from the review task prNumber field', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(context('pr-reviewer', { taskTypeFields: { prNumber: 4558 } }))
    const spec = captured[0]!.spec
    expect(spec.mode).toBe('explore')
    expect(spec.reviewPrNumber).toBe(4558)
  })

  it('resolves reviewPrNumber from a prUrl when prNumber is absent', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(
      context('pr-reviewer', {
        taskTypeFields: { prUrl: 'https://github.com/acme/widgets/pull/321' },
      }),
    )
    expect(captured[0]!.spec.reviewPrNumber).toBe(321)
  })

  it('omits reviewPrNumber when the review task carries no PR reference (degrades cleanly)', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(context('pr-reviewer'))
    expect(captured[0]!.spec.reviewPrNumber).toBeUndefined()
  })

  it('never carries reviewPrNumber for a kind without clone.prHead (architect), even with PR fields', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(context('architect', { taskTypeFields: { prNumber: 4558 } }))
    expect(captured[0]!.spec.reviewPrNumber).toBeUndefined()
  })
})

describe('ContainerAgentExecutor job-token scope', () => {
  // The job token is narrowed to the repos ONE dispatch resolved, so a fully compromised run
  // reaches the repos the run was about rather than every repo the installation covers
  // (`backend/docs/security-model.md`, Layer 3). What the executor owes is the SCOPE; turning
  // it into GitHub's `repository_ids` is the facade's job (`buildDispatchTokenMint`).

  const OWN = {
    installationId: 7,
    repoId: '1001',
    owner: 'acme',
    name: 'widgets',
    baseBranch: 'main',
  }
  const PEER = {
    installationId: 7,
    repoId: '2002',
    owner: 'acme',
    name: 'billing',
    baseBranch: 'develop',
  }
  // A peer the workspace reaches through a DIFFERENT installation: one job carries one token, so
  // this repo is unreachable with or without scoping and naming it would only make GitHub reject
  // the mint.
  const FOREIGN = {
    installationId: 99,
    repoId: '3003',
    owner: 'other',
    name: 'shared',
    baseBranch: 'main',
  }

  function captureScope(depsOverride: Partial<ContainerAgentExecutorDependencies> = {}) {
    const scopes: (string[] | undefined)[] = []
    const made = makeExecutor({
      resolveRepoTarget: async () => OWN,
      mintInstallationToken: async (_id, ctx) => {
        scopes.push(ctx?.repoIds)
        return 'GH-TOKEN'
      },
      ...depsOverride,
    })
    return { ...made, scopes }
  }

  it('scopes a single-repo dispatch to the primary repo alone', async () => {
    const { executor, scopes } = captureScope()
    await executor.startJob(context('coder'))
    expect(scopes).toEqual([['1001']])
  })

  it('scopes a multi-repo fan-out to the primary plus every peer checkout', async () => {
    const { executor, scopes } = captureScope({
      resolveRepoTargets: async (_ws, _blk, frameIds) => ({
        checkouts: [
          { target: OWN, primary: true, involved: [] },
          ...(frameIds.includes('frm_peer')
            ? [{ target: PEER, primary: false, involved: [{ frameId: 'frm_peer' }] }]
            : []),
        ],
      }),
    })
    await executor.startJob(
      context('coder', {}, undefined, {
        involvedServices: [{ frameId: 'frm_peer', name: 'billing' }],
      } as never),
    )
    // The primary is FIRST and always present: a scope missing it would mint a token that cannot
    // clone the repo the run is about.
    expect(scopes).toEqual([['1001', '2002']])
  })

  it('drops a leg on another installation rather than asking for a token that cannot cover it', async () => {
    const { executor, scopes } = captureScope({
      resolveRepoTargets: async (_ws, _blk, frameIds) => ({
        checkouts: [
          { target: OWN, primary: true, involved: [] },
          ...(frameIds.includes('frm_peer')
            ? [{ target: FOREIGN, primary: false, involved: [{ frameId: 'frm_peer' }] }]
            : []),
        ],
      }),
    })
    await executor.startJob(
      context('coder', {}, undefined, {
        involvedServices: [{ frameId: 'frm_peer', name: 'shared' }],
      } as never),
    )
    expect(scopes).toEqual([['1001']])
  })

  it('scopes the merger to every peer PR repo it clones as a sibling', async () => {
    const { executor, captured, scopes } = captureScope({
      resolveRepoTargets: async (_ws, _blk, frameIds) => ({
        checkouts: [
          { target: OWN, primary: true, involved: [] },
          ...(frameIds.includes('frm_peer')
            ? [{ target: PEER, primary: false, involved: [{ frameId: 'frm_peer' }] }]
            : []),
        ],
      }),
    })
    await executor.startJob(
      context('merger', {
        pullRequest: PR,
        peerPullRequests: [
          {
            repo: 'acme/billing',
            frameIds: ['frm_peer'],
            ref: {
              url: 'https://github.com/acme/billing/pull/3',
              number: 3,
              branch: 'cat-factory/blk_1',
            },
          },
        ],
      }),
    )
    // Every repo the body tells the harness to clone is in the scope: a leg dropped from the
    // scope is a clone the harness cannot make. (The converse does NOT hold, deliberately: the
    // merger REPLACES the fan-out's peers in the body while their ids stay in the scope, so the
    // scope is a superset. Widening beyond what the body names costs nothing; narrowing below it
    // breaks the clone.)
    expect(captured[0]!.spec.peerRepos).toMatchObject([{ repo: { name: 'billing' } }])
    expect(scopes).toEqual([['1001', '2002']])
  })

  it('scopes the conflict-resolver to the peer repo it is retargeted onto', async () => {
    const { executor, captured, scopes } = captureScope({
      resolveRepoTargets: async (_ws, _blk, frameIds) => ({
        checkouts: [
          { target: OWN, primary: true, involved: [] },
          ...(frameIds.includes('frm_peer')
            ? [{ target: PEER, primary: false, involved: [{ frameId: 'frm_peer' }] }]
            : []),
        ],
      }),
    })
    await executor.startJob(
      context('conflict-resolver', { pullRequest: PR }, undefined, {
        conflictTarget: { repo: 'acme/billing', frameId: 'frm_peer' },
      } as never),
    )
    // The resolver clones the PEER, not the primary. The primary stays in the scope anyway
    // (`jobTokenRepoIds` always yields it), which is a token slightly wider than this one job
    // needs and never one that cannot clone what the body names.
    expect(captured[0]!.spec.repo).toMatchObject({ name: 'billing' })
    expect(scopes).toEqual([['1001', '2002']])
  })

  it('scopes a read-only reference repo the same as a writable leg', async () => {
    const { executor, captured, scopes } = captureScope()
    await executor.startJob({
      ...context('doc-writer'),
      referenceRepos: [{ repoId: 2002, owner: 'acme', name: 'billing', defaultBranch: 'develop' }],
    } as never)
    // A reference repo is cloned read-only, but a token that cannot READ it fails the clone
    // exactly as one that cannot write does, so it belongs in the scope.
    expect(captured[0]!.spec.referenceRepos).toMatchObject([{ repo: { name: 'billing' } }])
    expect(scopes).toEqual([['1001', '2002']])
  })
})

describe('ContainerAgentExecutor pre-PR validation checks (job-body gating)', () => {
  // The commands ride the JOB BODY (containers have no DB access), and only for a dispatch that
  // actually OPENS a pull request — that is what "pre-PR" means. An in-place fixer pushing onto
  // an EXISTING PR head is deliberately excluded: the `ci` gate is already the loop there, so
  // forwarding checks would run a second, redundant repair loop inside the fixer.
  const validationChecks = {
    checks: [{ label: 'lint', command: 'pnpm lint' }],
    maxAttempts: 2,
  }

  it('forwards the service’s checks on a PR-opening coding dispatch', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(context('coder', {}, undefined, { validationChecks }))
    expect(captured[0]!.spec.validationChecks).toEqual(validationChecks)
  })

  it('omits them for an in-place fixer, which pushes onto an existing PR head', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(
      context('ci-fixer', { pullRequest: PR }, undefined, { validationChecks }),
    )
    expect(captured[0]!.spec.validationChecks).toBeUndefined()
  })

  it('omits them when the service configured none (the unconfigured path is unchanged)', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(context('coder'))
    expect(captured[0]!.spec.validationChecks).toBeUndefined()
  })
})

describe('ContainerAgentExecutor dependency prepopulation (job-body gating)', () => {
  // The install rides the BASE job body, under a deliberately WIDER rule than the pre-PR checks
  // above: every dispatch that gets a checkout, not only one that opens a pull request. These
  // tests exist to pin that difference — folding the install in beside `validationChecks` would
  // typecheck, pass every harness test, and silently leave every read-only agent (the ones whose
  // complaint motivated the feature) reasoning about a manifest instead of the packages.
  const dependencyInstall = 'pnpm install --frozen-lockfile'

  it('forwards the install on a PR-opening coding dispatch', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(context('coder', {}, undefined, { dependencyInstall }))
    expect(captured[0]!.spec.dependencyInstall).toEqual({ command: dependencyInstall })
  })

  it('forwards it on a read-only EXPLORE dispatch, which opens no PR', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(context('architect', {}, undefined, { dependencyInstall }))
    expect(captured[0]!.spec.dependencyInstall).toEqual({ command: dependencyInstall })
  })

  it('forwards it to an in-place fixer, which the pre-PR checks deliberately skip', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(
      context('ci-fixer', { pullRequest: PR }, undefined, { dependencyInstall }),
    )
    expect(captured[0]!.spec.dependencyInstall).toEqual({ command: dependencyInstall })
    // The two gates are independent, and this is the case that proves it.
    expect(captured[0]!.spec.validationChecks).toBeUndefined()
  })

  it('omits it when the service declared none (the unconfigured path is unchanged)', async () => {
    const { executor, captured } = makeExecutor()
    await executor.startJob(context('coder'))
    // Absent, never an empty object: the harness keys the whole phase off the field's presence.
    expect(captured[0]!.spec.dependencyInstall).toBeUndefined()
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
      resolvePackageRegistries: async () => {
        throw new Error('decrypt failed')
      },
    })
    await expect(executor.startJob(context('coder'))).rejects.toThrow('decrypt failed')
  })
})

describe('ContainerAgentExecutor dispatch I/O parallelism', () => {
  // The independent dispatch resolutions (work-branch ensure, the auxiliary-checkout resolution,
  // auth, package registries, tester secrets, web-search availability) are fanned
  // out in one wave once the repo target is resolved (audit item 4). This pins that they overlap
  // rather than running one-after-another, and that a failing context-observability record still
  // never breaks a dispatch.
  //
  // The installation-token mint is deliberately NOT in the wave: it is narrowed to the repos the
  // auxiliary resolution produces, so it cannot start until the wave settles. That ordering is
  // the security property (`jobTokenRepoIds`), so it is pinned here as its own assertion rather
  // than left to be re-parallelised by a later latency pass.

  // A deferred promise whose resolution we drive from the test, so we can observe which
  // resolvers have STARTED before any of them finishes.
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  it('starts the independent dispatch resolvers concurrently, and mints the token after them', async () => {
    const started = { token: false, branch: false, registries: false, search: false }
    const gates = {
      token: deferred<string>(),
      branch: deferred<boolean>(),
      registries: deferred<never[]>(),
      search: deferred<{ available: boolean; provider: null }>(),
    }
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
        repoId: '1001',
        owner: 'acme',
        name: 'widgets',
        baseBranch: 'main',
      }),
      mintInstallationToken: () => {
        started.token = true
        return gates.token.promise
      },
      ensureWorkBranch: () => {
        started.branch = true
        return gates.branch.promise
      },
      resolvePackageRegistries: () => {
        started.registries = true
        return gates.registries.promise
      },
      resolveWebSearchAvailability: () => {
        started.search = true
        return gates.search.promise
      },
      sessionService: {
        async mint() {
          return 'SESSION-TOKEN'
        },
      } as unknown as ContainerSessionService,
      proxyBaseUrl: 'https://proxy.test/v1',
    })

    const job = executor.startJob(context('coder'))
    // Let the pending microtasks + a macrotask boundary drain so every resolver has been kicked
    // off (the repo-target/model resolutions precede the wave). None has RESOLVED, so if the
    // executor were serialising it would be parked on the first resolver only. The token mint is
    // absent for the opposite reason: it is downstream of the whole wave by design.
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual({ token: false, branch: true, registries: true, search: true })

    gates.branch.resolve(true)
    gates.registries.resolve([])
    gates.search.resolve({ available: false, provider: null })
    await new Promise((r) => setTimeout(r, 0))
    // Only once the wave has settled, which is when the token's repo scope is known.
    expect(started.token).toBe(true)

    gates.token.resolve('GH-TOKEN')
    await job
  })

  it('awaits the context-observability record but swallows a recorder failure', async () => {
    let recordStarted = false
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
        repoId: '1001',
        owner: 'acme',
        name: 'widgets',
        baseBranch: 'main',
      }),
      mintInstallationToken: async () => 'GH-TOKEN',
      ensureWorkBranch: async () => true,
      sessionService: {
        async mint() {
          return 'SESSION-TOKEN'
        },
      } as unknown as ContainerSessionService,
      proxyBaseUrl: 'https://proxy.test/v1',
      agentContextObservability: {
        // Reject: the record is best-effort. It is AWAITED (a bare `void` would be dropped on
        // the Worker once the isolate hibernates on the next durable sleep), so the swallowing
        // catch is what guarantees a recorder failure still never breaks the dispatch.
        async record() {
          recordStarted = true
          throw new Error('telemetry DB down')
        },
      },
    })

    // Resolves with a handle despite the recorder throwing — the failure is swallowed.
    const handle = await executor.startJob(context('coder'))
    expect(handle.jobId).toBeDefined()
    expect(recordStarted).toBe(true)
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
      repoId: '1001',
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
