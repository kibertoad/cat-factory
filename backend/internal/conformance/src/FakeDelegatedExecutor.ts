import {
  defaultDelegatedExecutorRegistry,
  noopLogger,
  type AgentExecutor,
  type DelegatedExecutorDefinition,
  type DelegatedExecutorRegistry,
  type DelegationBrief,
  type DelegationHandle,
  type DelegationUpdate,
} from '@cat-factory/kernel'
import { defaultAgentKindRegistry, type AgentKindRegistry } from '@cat-factory/agents'
import { buildDelegatedAgentExecutor, CompositeAgentExecutor } from '@cat-factory/server'

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

/** A registry carrying one fake executor, as a facade's composition root would hold it. */
export function fakeDelegatedRegistry(
  definition: DelegatedExecutorDefinition,
): DelegatedExecutorRegistry {
  const registry = defaultDelegatedExecutorRegistry()
  registry.register(definition)
  return registry
}

/** An agent-kind registry carrying one kind that runs on the fake executor. */
export function delegatedKindRegistry(base?: AgentKindRegistry): AgentKindRegistry {
  const registry = base ?? defaultAgentKindRegistry()
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
  },
): AgentExecutor {
  // Both or neither. The kind registry is what says which kinds are delegated, so wrapping with
  // only the executor registry would compose a composite that can never route to it: green, and
  // asserting nothing. Every other conformance app is left exactly as it was.
  const { delegatedExecutorRegistry, agentKindRegistry } = registries
  if (!delegatedExecutorRegistry || !agentKindRegistry) return fake
  const delegated = buildDelegatedAgentExecutor({
    delegatedExecutorRegistry,
    agentKindRegistry,
    resolveRepoTarget: async () => ({
      installationId: 1,
      repoId: '1001',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
    }),
    logger: noopLogger,
    clock: { now: () => Date.now() },
  })
  return new CompositeAgentExecutor(fake, fake, agentKindRegistry, delegated)
}
