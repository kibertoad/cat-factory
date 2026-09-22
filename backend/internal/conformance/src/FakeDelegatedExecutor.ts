import {
  defaultDelegatedExecutorRegistry,
  noopLogger,
  type AgentExecutor,
  type DelegatedExecutorDefinition,
  type DelegatedExecutorRegistry,
  type DelegationBrief,
  type DelegationHandle,
  type DelegationUpdate,
  type RepoFiles,
  type ResolveRunRepoContext,
} from '@cat-factory/kernel'
import { defaultAgentKindRegistry, type AgentKindRegistry } from '@cat-factory/agents'
import {
  buildDelegatedAgentExecutor,
  CompositeAgentExecutor,
  githubRepoOrigin,
} from '@cat-factory/server'

// The DELEGATED-EXECUTOR fixture the cross-runtime suite drives.
//
// A delegated step is the one executor class whose state lives ENTIRELY in the step store: no
// container to address, no runner to ask, only what the claim persisted. That makes it exactly the
// shape a facade can get wrong on its own (a column mapped differently, a JSON blob round-tripped
// through a driver that drops a nested array), and exactly what conformance exists to catch.
//
// The executor here is deterministic and does no I/O, so the whole dispatch → poll → settle →
// pull-request-on-the-block path runs against real D1 and real Postgres with no external system.

/** The executor id every conformance fixture registers under. */
export const CONFORMANCE_DELEGATED_EXECUTOR_ID = 'conformance:delegated'

/** The agent kind the suite places in a pipeline to reach that executor. */
export const CONFORMANCE_DELEGATED_KIND = 'conformance-delegated-impl'

/** What the fake did, so the suite can assert the ENGINE's half rather than the fake's. */
export interface FakeDelegationCalls {
  /** Every brief handed to `start`. Length > 1 on a replay is the bug this seam is built around. */
  starts: DelegationBrief[]
  polls: DelegationHandle[]
  cancels: DelegationHandle[]
}

export interface FakeDelegatedExecutorOptions {
  /**
   * What each poll answers, in order; the LAST entry repeats. Defaults to one `running` poll and
   * then a completion carrying a pull request, which is the ordinary delegated producer.
   */
  updates?: DelegationUpdate[]
  /** Whether the executor declares `cancel` at all. Absent ⇒ it does. */
  cancelable?: boolean
  /** Whether it declares its own telemetry. Absent ⇒ `not-reported`, the honest default. */
  telemetry?: DelegatedExecutorDefinition['telemetry']
  /** Who creates the work branch. Absent ⇒ the executor, which is what this fake claims. */
  workBranch?: DelegatedExecutorDefinition['workBranch']
}

const DEFAULT_UPDATES: DelegationUpdate[] = [
  { state: 'running', url: 'https://ci.example/run/1', phase: 'building' },
  {
    state: 'done',
    result: {
      summary: 'Implemented the change on the work branch.',
      pullRequest: {
        url: 'https://github.com/acme/widgets/pull/42',
        number: 42,
        branch: 'cat-factory/task_login',
      },
    },
  },
]

/**
 * A deterministic {@link DelegatedExecutorDefinition} plus the record of what it was asked.
 *
 * The poll window is deliberately SHORT (ten polls). The driver derives its budget from the
 * executor's declared cadence, so a production-shaped three-hour window would have a fixture whose
 * job never settles spend hundreds of instant polls before failing: slow, and it would report a
 * timeout rather than the assertion that actually broke.
 */
export function fakeDelegatedExecutor(options: FakeDelegatedExecutorOptions = {}): {
  definition: DelegatedExecutorDefinition
  calls: FakeDelegationCalls
} {
  const updates = options.updates ?? DEFAULT_UPDATES
  const calls: FakeDelegationCalls = { starts: [], polls: [], cancels: [] }
  let polled = 0
  const definition: DelegatedExecutorDefinition = {
    id: CONFORMANCE_DELEGATED_EXECUTOR_ID,
    presentation: {
      label: 'Conformance executor',
      icon: 'i-lucide-bot',
      description: 'A deterministic external executor for the conformance suite.',
    },
    poll: { intervalMs: 1000, maxDurationMs: 10_000 },
    telemetry: options.telemetry ?? 'not-reported',
    // Absent ⇒ the executor makes its own branch, which is what a fake that pushes nowhere claims.
    // A suite asserting the platform's half passes `'platform-creates'` together with
    // {@link ConformanceAppOptions.delegatedRepoFiles}.
    workBranch: options.workBranch ?? 'executor-creates',
    create: () => ({
      async start(brief) {
        calls.starts.push(brief)
        // Derived from the correlation key rather than a counter, so a REPLAYED start would answer
        // the same id, which is what an idempotent external system does, and what makes
        // "was start called twice" an assertion about the engine rather than about the fake.
        return { externalId: `ext-${brief.correlationKey}`, url: 'https://ci.example/run/1' }
      },
      async poll(handle) {
        calls.polls.push(handle)
        const update = updates[Math.min(polled, updates.length - 1)]!
        polled += 1
        return update
      },
      ...(options.cancelable === false
        ? {}
        : {
            async cancel(handle: DelegationHandle) {
              calls.cancels.push(handle)
            },
          }),
    }),
  }
  return { definition, calls }
}

/** What {@link fakeDelegationRepoFiles} recorded, so a suite asserts the ENGINE's write. */
export interface FakeDelegationRepo {
  repoFiles: RepoFiles
  /** The repository's refs, so a suite states what exists rather than scripting a call order. */
  heads: Record<string, string>
  created: { branch: string; fromSha: string }[]
}

/**
 * A `RepoFiles` over an in-memory ref table: what a `platform-creates` dispatch writes through.
 *
 * In memory rather than against each facade's real VCS adapter because the fact under test is not
 * the adapter: it is that BOTH facades hand the delegated arm a repo binding at all. The Worker
 * threads `late.resolveRunRepoContext` and Node threads `githubGateDeps.resolveRunRepoContext`
 * through two different assemblies, and a facade that simply omitted it would dispatch every
 * `platform-creates` step onto a branch nobody created, which nothing else here would catch.
 */
export function fakeDelegationRepoFiles(heads: Record<string, string> = {}): FakeDelegationRepo {
  const created: { branch: string; fromSha: string }[] = []
  const repoFiles = {
    async headSha(branch: string) {
      return heads[branch] ?? null
    },
    async createBranch(branch: string, fromSha: string) {
      created.push({ branch, fromSha })
      heads[branch] = fromSha
    },
  } as unknown as RepoFiles
  return { repoFiles, heads, created }
}

/** A registry carrying one fake executor, as a facade's composition root would hold it. */
export function fakeDelegatedRegistry(
  definition: DelegatedExecutorDefinition,
): DelegatedExecutorRegistry {
  const registry = defaultDelegatedExecutorRegistry()
  registry.register(definition)
  return registry
}

/**
 * The gate HELPER kind that runs on the fake executor.
 *
 * A helper is an ordinary dispatch of an agent kind, so a deployment whose `ci-fixer` runs on its
 * own external loop reaches the gate's dispatch site rather than the generic one. That path settles
 * its round through the helper router, which is where a delegated record was left reading `running`
 * for ever.
 */
export const CONFORMANCE_DELEGATED_HELPER_KIND = 'conformance-delegated-fixer'

/** An agent-kind registry carrying the two kinds that run on the fake executor. */
export function delegatedKindRegistry(base?: AgentKindRegistry): AgentKindRegistry {
  const registry = base ?? defaultAgentKindRegistry()
  registry.register({
    kind: CONFORMANCE_DELEGATED_HELPER_KIND,
    systemPrompt: 'You fix what the gate reported, in the external system.',
    agent: { surface: 'delegated', executor: CONFORMANCE_DELEGATED_EXECUTOR_ID },
  })
  registry.register({
    kind: CONFORMANCE_DELEGATED_KIND,
    systemPrompt: 'You implement the change in the external system.',
    agent: { surface: 'delegated', executor: CONFORMANCE_DELEGATED_EXECUTOR_ID },
    presentation: {
      label: 'External implementer',
      icon: 'i-lucide-bot',
      color: '#6366f1',
      description: 'Runs on the deployment’s own executor.',
      category: 'build',
    },
  })
  return registry
}

/**
 * Wrap a facade harness's deterministic agent executor so a DELEGATED kind reaches the real
 * `DelegatedAgentExecutor` while everything else stays on the fake.
 *
 * Every harness overrides `agentExecutor` wholesale, which is right for the other three hundred
 * assertions and would make this one vacuous: the fake would answer for a delegated kind too, and
 * the suite would assert nothing about the arm it exists to cover. Composing here, through the
 * SAME `CompositeAgentExecutor` production uses, is what keeps the routing, the claim and the
 * settle under test on every runtime.
 *
 * `resolveRepoTarget` is a fixture: a conformance app has no VCS connection, and the brief needs a
 * repo the way any producer step does.
 */
export function withDelegatedArm(
  fake: AgentExecutor,
  registries: {
    delegatedExecutorRegistry?: DelegatedExecutorRegistry
    agentKindRegistry?: AgentKindRegistry
    /**
     * The repo binding a `platform-creates` dispatch creates its work branch through. Absent ⇒
     * the arm is built with none, which is a deployment that configured no VCS provider and which
     * the suite also asserts (such a dispatch is refused, never silently started).
     */
    delegatedRepoFiles?: RepoFiles
  },
): AgentExecutor {
  // Both or neither. The kind registry is what says which kinds are delegated, so wrapping with
  // only the executor registry would compose a composite that can never route to it: green, and
  // asserting nothing. Every other conformance app is left exactly as it was.
  const { delegatedExecutorRegistry, agentKindRegistry, delegatedRepoFiles } = registries
  if (!delegatedExecutorRegistry || !agentKindRegistry) return fake
  const resolveRunRepoContext: ResolveRunRepoContext | undefined = delegatedRepoFiles
    ? async () => ({ repo: delegatedRepoFiles, baseBranch: 'main', repoId: '1001' })
    : undefined
  const delegated = buildDelegatedAgentExecutor({
    ...(resolveRunRepoContext ? { resolveRunRepoContext } : {}),
    delegatedExecutorRegistry,
    agentKindRegistry,
    resolveRepoTarget: async () => ({
      installationId: 1,
      repoId: '1001',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
    }),
    // Named rather than defaulted, because the host requires an answer: this harness has no VCS
    // configuration of its own, so the brief's clone URLs are GitHub's by decision.
    resolveRepoOrigin: githubRepoOrigin,
    // Answered explicitly, because the host requires an answer: this harness configures no
    // outbound widening, which is the strict public-https default every executor is held to.
    urlSafetyPolicy: undefined,
    logger: noopLogger,
    clock: { now: () => Date.now() },
  })
  return new CompositeAgentExecutor(fake, fake, agentKindRegistry, delegated, noopLogger)
}
