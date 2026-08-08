import type {
  Block,
  ExecutionInstance,
  GateAttempt,
  GateStepState,
  RiskPolicy,
  PipelineStep,
} from './types.js'
import type { DescriptorField, DescriptorFieldValues } from '@cat-factory/contracts'
import type { AgentRunResult } from '../ports/agent-executor.js'
import type { RaiseNotificationInput } from '../ports/notification-channel.js'
import type { Clock } from '../ports/runtime.js'
import type { RunInitiatorScope } from '../ports/user-secret-repositories.js'
import {
  defaultProviderRegistry,
  type ProviderRegistry,
  type ProviderToken,
} from './provider-registry.js'

// The polling-gate abstraction. A "gate" step (today `ci`, `conflicts`,
// `post-release-health`) is NOT a container/inline LLM agent: it runs a programmatic
// precheck against a provider and only escalates to a helper container agent
// (`ci-fixer` / `conflict-resolver` / `on-call`) on a negative verdict, looping until
// the precheck passes or an attempt budget is spent.
//
// The engine (ExecutionService) owns the shared state machine — re-attach on replay,
// pass-through when unwired, init/persist `step.gate`, dispatch the helper, count
// attempts, emit. A concrete gate is just a `GateDefinition` describing its
// differentiators, registered by `agentKind`. Adding a gate is a new entry, not a new
// copy of the machinery. See `ExecutionService.evaluateGate` / `pollGate`.
//
// This abstraction lives in kernel (alongside the pipeline registry) so a deployment
// package can register its OWN gate as a startup import side effect (see
// registering it on the app-owned {@link GateRegistry}) without depending on the heavy
// orchestration package — the same app-owned-registry seam as agent kinds and pipelines.

/** The outcome of a single gate precheck against its provider. */
export interface GateProbe {
  /**
   *  - `pass`    — the precheck is satisfied; the step finishes and the run advances
   *                (the "skip the agent" path — nothing was spun up).
   *  - `pending` — the provider is still computing; keep polling.
   *  - `fail`    — the precheck failed; escalate to the helper agent (or give up once
   *                the attempt budget is spent).
   */
  status: 'pass' | 'pending' | 'fail'
  /** The PR head commit the precheck ran against, or null when there is no open PR. */
  headSha: string | null
  /**
   * Per-PR head commits for a MULTI-REPO block (own-service + peer repos), keyed by
   * repo full name (owner/name). Present only when the block has peer PRs; a single-repo
   * block leaves it undefined and callers read the scalar {@link headSha}. Persisted onto
   * `step.gate.headShas` so the run-detail UI can show which repo each check belongs to.
   */
  headShas?: Record<string, string>
  /**
   * For the conflicts gate on a `fail`: which of the block's repos conflicted (own-service
   * or a peer), so the engine dispatches the single-repo conflict-resolver at that repo.
   * Absent ⇒ the block's own-service repo. The CI gate leaves it undefined (its fixer runs
   * across all repos).
   */
  conflictTarget?: { repo: string; frameId?: string; branch?: string }
  /**
   * Whether a `fail` verdict may escalate to the helper agent. Defaults to `true` (the
   * usual "dispatch the fixer / resolver" path). A gate sets it to `false` when the helper
   * it has cannot fix this particular failure — e.g. the conflicts gate detects the conflict
   * on a PEER repo but only has the single-repo (own-repo) conflict-resolver, so escalating
   * would burn the whole attempt budget on a container that can't touch the conflicted repo.
   * The engine then skips the dispatch and goes straight to {@link GateDefinition.onExhausted}.
   */
  escalatable?: boolean
  /** Step output recorded on `pass` (a short human-readable reason). */
  passOutput?: string
  /** A summary of what failed on `fail` — fed to the helper agent and the give-up error. */
  failureSummary?: string
  /**
   * Structured failing checks behind {@link failureSummary} (the CI gate populates
   * this from the red check runs; the conflicts gate leaves it undefined). Persisted
   * onto `step.gate` so the run-detail UI can list each failing check.
   */
  failingChecks?: { name: string; conclusion: string | null; url?: string | null; repo?: string }[]
}

/** The relevant outcome of a finished gate-helper job, for recording an attempt. */
export type GateHelperOutcome =
  | { state: 'done'; output: string | null }
  | { state: 'failed'; error: string | null }

/**
 * Build the record of a just-finished gate-helper attempt (a ci-fixer / conflict-resolver
 * run) for {@link GateStepState.attemptLog}. It captures BOTH sides of the round so the run
 * detail can show it in full (the gate analogue of the Tester attempt's `concerns` + `summary`):
 *   - `instructions` / `failingChecks` — what the round was ASKED to fix, carried from the
 *     dispatch-time `lastDispatchedInstructions` + `failingChecks` stash on the gate state.
 *   - `summary` — the helper's OWN account: its output on completion (which the conflict-resolver
 *     fills with the files it left conflicting), or the error on failure.
 * Tagged with the current attempt number + the gated head sha. The gate's next precheck remains
 * the source of truth for pass/fail; this is purely the per-attempt history the UI shows so a
 * looping gate isn't a black box.
 */
export function recordGateAttempt(
  gate: Pick<
    GateStepState,
    'attempts' | 'headSha' | 'lastDispatchedInstructions' | 'failingChecks'
  >,
  outcome: GateHelperOutcome,
  at: number,
): GateAttempt {
  return {
    attempt: gate.attempts,
    at,
    outcome: outcome.state === 'done' ? 'completed' : 'failed',
    headSha: gate.headSha ?? null,
    ...(gate.lastDispatchedInstructions ? { instructions: gate.lastDispatchedInstructions } : {}),
    ...(gate.failingChecks && gate.failingChecks.length
      ? { failingChecks: gate.failingChecks }
      : {}),
    summary:
      outcome.state === 'done'
        ? outcome.output
        : (outcome.error ?? 'The helper agent failed without finishing.'),
  }
}

/**
 * The settled outcome of a gate-helper job, handed to {@link GateDefinition.resolveHelperCompletion}.
 * Carries the FULL agent result on success (an investigate-don't-fix helper like `on-call`
 * needs its structured assessment, not just the output string).
 */
export type GateHelperJobResult =
  | { state: 'done'; result: AgentRunResult }
  | { state: 'failed'; error: string | null }

/** Inputs to a gate's helper-completion hook ({@link GateDefinition.resolveHelperCompletion}). */
export interface GateHelperCompletionArgs {
  workspaceId: string
  instance: ExecutionInstance
  block: Block
  step: PipelineStep
  /** The helper job's settled outcome (done with its result, or failed). */
  result: GateHelperJobResult
}

/** Inputs to a gate's exhaustion handler (budget spent / no executor to escalate to). */
export interface GateExhaustedArgs {
  workspaceId: string
  instance: ExecutionInstance
  block: Block
  step: PipelineStep
  summary?: string
}

/**
 * The per-gate differentiators the engine's generic gate machine needs. Everything
 * shared (the state machine, persistence, dispatch, budget) lives in ExecutionService.
 */
export interface GateDefinition {
  /** Matches the step's `agentKind` (e.g. `ci`, `conflicts`). */
  kind: string
  /** The container agent kind dispatched on a failed precheck (e.g. `ci-fixer`). */
  helperKind: string
  /** Whether the gate's provider is wired. When false the gate is a pass-through. */
  wired(): boolean
  /** Step output recorded when the gate passes through (no provider configured). */
  unwiredOutput: string
  /**
   * Run the precheck against the provider and classify it. Receives the live gate
   * state so a time-windowed gate (post-release-health) can read its `watchSince`.
   */
  probe(workspaceId: string, blockId: string, gateState: GateStepState): Promise<GateProbe>
  /**
   * Optional: the attempt budget for this gate, resolved from the task's merge preset and the
   * STEP's own gate config (`stepOptions.gateConfig.fields`, already validated against
   * {@link GateRegistration.configSchema}). Defaults to `ciMaxAttempts` when omitted (the
   * CI/conflicts gates use that).
   *
   * The per-step override is resolved BY THE GATE rather than by the engine on purpose: the
   * engine has no business knowing that this gate calls its budget `maxAttempts` and the next
   * one does not, which is the hard-coding the config schema exists to stop.
   */
  attemptBudget?(
    preset: Pick<RiskPolicy, 'ciMaxAttempts' | 'releaseMaxAttempts'>,
    config: GateConfigFields,
  ): number
  /**
   * Optional extra context handed to the helper agent on escalation (the CI gate
   * passes the failing-check summary; the conflicts gate passes nothing).
   */
  helperPriorOutput?(summary: string): { agentKind: string; output: string } | undefined
  /**
   * Optional async builder for richer helper context (gathered at dispatch time), used
   * when a gate's helper needs more than the precheck summary — e.g. the on-call agent
   * gets the full Datadog evidence bundle. Returns prior-output entries appended after
   * the base context's. Takes precedence over {@link helperPriorOutput} when present.
   */
  gatherHelperPriorOutputs?(
    workspaceId: string,
    blockId: string,
    gateState: GateStepState,
  ): Promise<{ agentKind: string; output: string }[]>
  /**
   * Called when the attempt budget is spent (or there is no async executor to escalate
   * to). May raise a notification; returns the message used to fail the run.
   */
  onExhausted(args: GateExhaustedArgs): Promise<{ error: string }>
  /**
   * Optional: handle this gate's helper job FINISHING (or failing) instead of the default
   * "re-probe the precheck" behaviour. Most helpers FIX the gated condition (ci-fixer
   * pushes a fix; conflict-resolver re-merges), so the engine re-runs the precheck after
   * they finish — the gate's verdict stays the source of truth. But an INVESTIGATE-don't-fix
   * helper (`on-call`) changes nothing the precheck would observe: re-probing would just
   * regress again and burn the budget. When this hook is present the engine, on the helper's
   * completion, calls it (instead of re-probing) and finishes the gate step with the returned
   * output — letting the gate raise a notification / enrich an incident and let the run
   * complete for a human to act out-of-band. Absent → the default re-probe loop.
   */
  resolveHelperCompletion?(args: GateHelperCompletionArgs): Promise<{ output: string }>
  /**
   * Optional SIDE-EFFECT hook run when this gate's helper job finishes, BEFORE the default
   * re-probe — distinct from {@link resolveHelperCompletion} (which replaces the re-probe and
   * finishes the step). Use it when the helper's deterministic GitHub-side bookkeeping must
   * land before the next precheck reads it: the `human-review` gate uses it to post a reply and
   * RESOLVE on GitHub each review thread it handed the `fixer`, so the immediately-following
   * re-probe sees those threads resolved (advance) vs. still open (keep waiting). The engine
   * still re-probes after this returns. Absent → straight to the default re-probe.
   */
  onHelperComplete?(args: GateHelperCompletionArgs): Promise<void>
}

/**
 * The shared engine seams a registered (custom) gate legitimately needs, handed to its
 * factory at registry-build time. Deliberately minimal + runtime-neutral: the engine
 * keeps owning dispatch, budget resolution, persistence and the state machine. A custom
 * gate reaches its OWN provider (the source for `wired()`/`probe()`) through the typed
 * provider registry via {@link GateContext.getProvider} / {@link GateContext.requireProvider} —
 * the facade wires the impl against a {@link ProviderToken} at startup, so the gate no
 * longer closes over a hand-authored module-level handle.
 */
export interface GateContext {
  /** The engine clock (monotonic-ish ms), for time-windowed gates. */
  clock: Clock
  /** Read a block, e.g. to gate only a release that actually shipped. */
  getBlock(workspaceId: string, blockId: string): Promise<Block | null>
  /** Run a function under the run initiator's ambient context (per-user credentials). */
  runInitiatorScope: RunInitiatorScope
  /** Raise (or re-raise) a human-actionable notification, e.g. from `onExhausted`. */
  raiseNotification(workspaceId: string, input: RaiseNotificationInput): Promise<void>
  /** The wired impl for a provider token, or `undefined` (drives a gate's `wired()`). */
  getProvider<T>(token: ProviderToken<T>): T | undefined
  /**
   * The wired impl for a provider token, or throw. SAFE inside `probe()` — the engine only
   * probes a gate whose `wired()` returned true, and a gate's `wired()` should be
   * `ctx.isProviderWired(token)` — so this replaces the old `getFoo()!` assertion with a guard.
   */
  requireProvider<T>(token: ProviderToken<T>): T
  /**
   * Whether an impl is wired for a provider token — the canonical source for a gate's `wired()`
   * (reads the app-owned {@link ProviderRegistry} the engine threads in, not a module global).
   */
  isProviderWired<T>(token: ProviderToken<T>): boolean
}

/**
 * A registered gate is a factory the engine invokes ONCE at registry-build time with a
 * {@link GateContext}. A factory (rather than a static {@link GateDefinition}) lets the
 * gate's `probe`/`onExhausted` close over the engine seams + the registrant's own
 * provider, which a static object built at import time could not reach.
 */
export type GateFactory = (ctx: GateContext) => GateDefinition

/**
 * App-owned registry of polling gates, mirroring the agent-kind registry
 * ({@link AgentKindRegistry}) and the backend-registries pilot. The composition root news
 * ONE instance (`defaultGateRegistry()`), threads it through `CoreDependencies`, and the
 * engine reads it from there when it lazily builds its per-kind gate map — so there is no
 * module-global `Map`, no `clear*()` test cruft, and no external-adapter module-identity
 * gotcha: a deployment registers extra gates by reference (`registry.register(kind, factory)`)
 * on the instance the facade injects.
 *
 * Unlike {@link AgentKindRegistry}, the built-in gates are NOT pre-loaded by
 * `defaultGateRegistry()` — they live in `@cat-factory/gates` (which depends on kernel, not
 * the reverse), so a facade populates them explicitly via that package's
 * `registerBuiltinGates(registry)`. A fresh registry is therefore empty; that is the whole
 * dogfood — the platform's own gates register through the same public seam as anyone's.
 */
export class GateRegistry {
  private readonly registry = new Map<string, GateRegistration>()

  /**
   * Register a polling gate, keyed by the step `agentKind` it gates. A later registration of
   * the same kind replaces the earlier one (so a deployment can override a built-in). The
   * `kind` is passed explicitly because the factory's result isn't built until the engine
   * invokes it.
   *
   * `options.configFields` declares the gate's own per-step parameters and
   * `options.pollExhaustion` what running out of polls MEANS for this gate (see
   * {@link GateRegistration}). Both sit on the REGISTRATION rather than on the
   * {@link GateDefinition} because the boundaries that need them most have no
   * {@link GateContext} to build a definition with: pipeline save, which must refuse a bad
   * pipeline at authoring time, and public-API admission, which must decide at HTTP request
   * time whether a start can park the run on a person.
   */
  register(
    kind: string,
    factory: GateFactory,
    options: {
      configFields?: readonly DescriptorField[]
      pollExhaustion?: GatePollExhaustion
    } = {},
  ): void {
    this.registry.set(kind, { factory, ...options })
  }

  /** The registered gates (registration order). */
  factories(): { kind: string; factory: GateFactory }[] {
    return [...this.registry].map(([kind, { factory }]) => ({ kind, factory }))
  }

  /** Whether a gate is registered for this step kind — the "may this step carry gate config" test. */
  has(kind: string): boolean {
    return this.registry.has(kind)
  }

  /**
   * What running out of polls MEANS for this gate, as it declared at registration, or
   * `undefined` when the kind is not registered here at all.
   *
   * `undefined` is therefore a THIRD answer and never "the default": a registered gate that
   * declared nothing answers `'fail'`, the disposition the engine applies to it, while an
   * unregistered kind answers `undefined` because there is nothing to ask. Two readers depend on
   * the distinction. The engine resolves the disposition of a spent poll budget; the public API
   * decides at request time whether a start can park the run on a person forever, and reporting
   * an unregistered kind as a bounded gate would be a guess about a gate this process cannot see.
   */
  pollExhaustion(kind: string): GatePollExhaustion | undefined {
    const registration = this.registry.get(kind)
    if (!registration) return undefined
    return registration.pollExhaustion ?? 'fail'
  }

  /**
   * The per-step parameters a gate declared, or `undefined` when it declared none. A gate with no
   * declaration accepts NO per-step fields: an undeclared field is indistinguishable from a
   * typo'd one, and both read to whoever typed them as configuration that took effect.
   */
  configFields(kind: string): readonly DescriptorField[] | undefined {
    return this.registry.get(kind)?.configFields
  }

  /** Every gate that declares an authoring form, for the snapshot projection the builder renders. */
  configForms(): { kind: string; fields: readonly DescriptorField[] }[] {
    return [...this.registry].flatMap(([kind, { configFields }]) =>
      configFields?.length ? [{ kind, fields: configFields }] : [],
    )
  }
}

/**
 * A gate's per-step parameters, as filled by a pipeline author and validated against its
 * {@link GateRegistration.configFields}. The repo's shared descriptor-form value bag, not a
 * gate-specific one: a gate config form is collected, validated, frozen and rendered by the same
 * machinery as an initiative preset's form.
 */
export type GateConfigFields = DescriptorFieldValues

/**
 * What running out of the durable driver's gate-poll budget (ciMaxPolls × ciPollInterval) MEANS,
 * while the gate is still `pending`. Distinct from the attempt budget (helper dispatches), which
 * {@link GateDefinition.onExhausted} handles:
 *
 *   - `fail` (the default when a registration declares none): the precheck never settled, which
 *     is a failure for the CI / conflicts gates (CI never went green / the PR never became
 *     mergeable).
 *   - `pass`: for a time-windowed watch gate (post-release-health), running out of polls just
 *     means the watch window outlasted the budget with NO regression seen, which is a healthy
 *     pass rather than a timeout failure.
 *   - `rearm`: for an unbounded human-wait gate (`human-review`), there is no deadline for a
 *     human reviewer, so running out of polls is NOT a verdict. Always re-arm another poll cycle
 *     (never pass, never fail); the waiting is surfaced via the gate's notification (which the
 *     severity sweep escalates), not by killing the run.
 *
 * Resolved by `ExecutionService.resolveGatePollExhaustion`, and read at HTTP request time by
 * public-API admission, for which `rearm` IS the definition of a gate that parks on a person.
 */
export type GatePollExhaustion = 'pass' | 'fail' | 'rearm'

/** What a {@link GateRegistry} stores per kind: the factory, plus what the gate declares about itself. */
export interface GateRegistration {
  factory: GateFactory
  /**
   * What a spent poll budget means for this gate ({@link GatePollExhaustion}); absent ⇒ `fail`.
   *
   * On the REGISTRATION rather than on the {@link GateDefinition} the factory builds, because the
   * two readers that most need it hold no {@link GateContext}: standing a fake one up per HTTP
   * request to interrogate a static declaration would be a shortcut, not a design. That is why
   * this used to be mirrored by a hand-kept constant in `@cat-factory/contracts` naming the
   * shipped human-wait gates, with a drift guard to keep the copy honest, and why a gate a
   * DEPLOYMENT registered was invisible to the rule, so a plain `write` key could start a
   * pipeline that then parked on it forever. Declared here, every gate answers for itself and
   * there is no copy to drift.
   */
  pollExhaustion?: GatePollExhaustion
  /**
   * The gate's own per-step parameters, declared as descriptor fields so ONE declaration drives
   * validation at pipeline save, re-validation at run start, and the authoring form the SPA
   * renders (projected onto the workspace snapshot). Absent ⇒ the gate takes no per-step
   * configuration.
   *
   * A `password` field has no place here: these values live in the pipeline row and are copied
   * onto the run's step, so a secret belongs in the per-workspace capability-credential store.
   */
  configFields?: readonly DescriptorField[]
}

/**
 * A fresh gate registry. Empty by design — the built-in gate suite lives in
 * `@cat-factory/gates` and is installed by a facade via `registerBuiltinGates(registry)`,
 * since kernel cannot depend on the gate package. A deployment registers its own gates by
 * reference on the instance the composition root injects.
 */
export function defaultGateRegistry(): GateRegistry {
  return new GateRegistry()
}

/**
 * A minimal {@link GateContext} for tests that invoke a gate factory in isolation (the
 * real one is built by `ExecutionService.makeGateContext`). Defaults to harmless no-ops;
 * pass `providerRegistry` to have the provider seams read a specific registry (a gate test
 * wires its provider on it), and `overrides` to assert against a specific seam. Centralised
 * here so a new required `GateContext` field is filled in ONE place instead of every gate test.
 */
export function stubGateContext(
  overrides: Partial<GateContext> = {},
  providerRegistry: ProviderRegistry = defaultProviderRegistry(),
): GateContext {
  return {
    clock: { now: () => 0 },
    getBlock: async () => null,
    runInitiatorScope: (_initiatedBy, fn) => fn(),
    raiseNotification: async () => {},
    // Read the provider seams off the given registry (a fresh empty one by default), so a gate
    // test that wires a provider on it sees it and `requireProvider` on an unwired token throws
    // exactly as it would in prod.
    getProvider: (token) => providerRegistry.get(token),
    requireProvider: (token) => providerRegistry.require(token),
    isProviderWired: (token) => providerRegistry.isWired(token),
    ...overrides,
  }
}
