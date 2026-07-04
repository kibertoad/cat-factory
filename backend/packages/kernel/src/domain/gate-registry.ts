import type {
  Block,
  ExecutionInstance,
  GateAttempt,
  GateStepState,
  MergeThresholdPreset,
  PipelineStep,
} from './types.js'
import type { AgentRunResult } from '../ports/agent-executor.js'
import type { RaiseNotificationInput } from '../ports/notification-channel.js'
import type { Clock } from '../ports/runtime.js'
import type { RunInitiatorScope } from '../ports/user-secret-repositories.js'
import {
  getProvider as registryGetProvider,
  requireProvider as registryRequireProvider,
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
// {@link registerGate}) without depending on the heavy orchestration package — exactly
// the way `registerAgentKind` / `registerPipeline` already work.

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
   * What to do when the durable driver's poll budget (ciMaxPolls × ciPollInterval) is
   * spent while the gate is still `pending` — distinct from the attempt budget (helper
   * dispatches) handled by {@link onExhausted}:
   *   - `fail` (default) — the precheck never settled, which is a failure for the CI /
   *     conflicts gates (CI never went green / the PR never became mergeable).
   *   - `pass` — for a time-windowed watch gate (post-release-health), running out of
   *     polls just means the watch window outlasted the budget with NO regression seen,
   *     which is a healthy pass — not a timeout failure.
   *   - `rearm` — for an unbounded human-wait gate (`human-review`): there is no deadline
   *     for a human reviewer, so running out of polls is NOT a verdict. Always re-arm
   *     another poll cycle (never pass, never fail); the waiting is surfaced via the gate's
   *     notification (which the severity sweep escalates), not by killing the run.
   * Resolved by {@link ExecutionService.resolveGatePollExhaustion}.
   */
  pollExhaustion?: 'pass' | 'fail' | 'rearm'
  /**
   * Run the precheck against the provider and classify it. Receives the live gate
   * state so a time-windowed gate (post-release-health) can read its `watchSince`.
   */
  probe(workspaceId: string, blockId: string, gateState: GateStepState): Promise<GateProbe>
  /**
   * Optional: the attempt budget for this gate, resolved from the task's merge preset.
   * Defaults to `ciMaxAttempts` when omitted (the CI/conflicts gates use that).
   */
  attemptBudget?(preset: Pick<MergeThresholdPreset, 'ciMaxAttempts' | 'releaseMaxAttempts'>): number
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
   * `isProviderWired(token)` — so this replaces the old `getFoo()!` assertion with a guard.
   */
  requireProvider<T>(token: ProviderToken<T>): T
}

/**
 * A registered gate is a factory the engine invokes ONCE at registry-build time with a
 * {@link GateContext}. A factory (rather than a static {@link GateDefinition}) lets the
 * gate's `probe`/`onExhausted` close over the engine seams + the registrant's own
 * provider, which a static object built at import time could not reach.
 */
export type GateFactory = (ctx: GateContext) => GateDefinition

// Process-wide registry, mirroring the agent-kind / pipeline registry seams. Registration
// is a startup import side effect, read once when an ExecutionService lazily builds its
// gate registry on first use. A gate registered AFTER an ExecutionService has already
// built its registry is invisible to that instance — register at startup, before serving.
const registry = new Map<string, GateFactory>()

/**
 * Register a custom polling gate, keyed by the step `agentKind` it gates. A later
 * registration of the same kind replaces the earlier one, and a registered gate replaces
 * a built-in of the same kind — so a deployment can both add new gates and customize the
 * built-in catalog. The `kind` is passed explicitly because the factory's result isn't
 * built until the engine invokes it.
 */
export function registerGate(kind: string, factory: GateFactory): void {
  registry.set(kind, factory)
}

/** The registered custom gates (registration order). */
export function registeredGateFactories(): { kind: string; factory: GateFactory }[] {
  return [...registry].map(([kind, factory]) => ({ kind, factory }))
}

/** Drop all registered gates. Intended for tests that exercise registration. */
export function clearRegisteredGates(): void {
  registry.clear()
}

/**
 * A minimal {@link GateContext} for tests that invoke a gate factory in isolation (the
 * real one is built by `ExecutionService.makeGateContext`). Defaults to harmless no-ops;
 * pass `overrides` to assert against a specific seam. Centralised here so a new required
 * `GateContext` field is filled in ONE place instead of every gate test.
 */
export function stubGateContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    clock: { now: () => 0 },
    getBlock: async () => null,
    runInitiatorScope: (_initiatedBy, fn) => fn(),
    raiseNotification: async () => {},
    // Default to the real process-wide registry so a gate test that wires a provider sees
    // it, and `requireProvider` on an unwired token throws exactly as it would in prod.
    getProvider: registryGetProvider,
    requireProvider: registryRequireProvider,
    ...overrides,
  }
}
