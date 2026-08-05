import type { Block, JudgeModelPin, JudgeVerdict, PipelineStep, RiskPolicy } from './types.js'
import type { RaiseNotificationInput } from '../ports/notification-channel.js'
import type { Clock } from '../ports/runtime.js'
import type { RunInitiatorScope } from '../ports/user-secret-repositories.js'
import {
  defaultProviderRegistry,
  type ProviderRegistry,
  type ProviderToken,
} from './provider-registry.js'

// ---------------------------------------------------------------------------
// The JUDGE abstraction — the FOURTH bucket of the step taxonomy (agents / polling gates /
// one-shot engine steps / JUDGES; see `CLAUDE.md`).
//
// A judge step runs an LLM assessment of the run's work against a RUBRIC, producing a
// structured verdict. The engine compares the verdict's score to a PER-TASK threshold (a
// merge-preset knob) and disposes: advance, park for a human, BOUNCE the preceding producing
// step with the findings as rework feedback, or fail the run.
//
// This promotes a shape three engine paths already had — the requirements auto-pass
// (`disposeReview` vs `maxRequirementConcernAllowed`), the `merger` (`MergeResolver` vs the
// merge preset) and `on-call` (`resolveOnCallStep` vs its confidence handling) — into a seam a
// DEPLOYMENT can extend. The engine (`JudgeStepController`) owns the whole shared state
// machine: pass-through when unwired, rubric resolution, init/persist `step.judge`, the
// threshold comparison, the park/bounce/fail disposition, the bounce budget, and emission. A
// concrete judge is just a {@link JudgeDefinition} describing its differentiators.
//
// Deliberately NOT expressed as a gate: a gate's `probe()` is a cheap programmatic precheck
// whose entire point is to spin nothing up when it passes, with a `pending` state to poll and
// a helper CONTAINER to escalate to. A judge always costs a model call, has no pending state,
// and yields a score rather than a tri-state. And deliberately NOT a `StepCompletionResolver`:
// a resolver returns a `StepResolution` (reshape output / own terminal status) and cannot park
// or loop the run — which is exactly the ceiling deployments hit today.
//
// Lives in kernel (alongside the gate + pipeline registries) so a deployment package can
// register its OWN judge without depending on the heavy orchestration package.
//
// See `docs/initiatives/judge-registry.md`.
// ---------------------------------------------------------------------------

/**
 * The rubric a judge assesses against. `body` is the DEFAULT the registration ships; a
 * workspace overrides it by authoring a prompt-library fragment whose id is
 * {@link JudgeRubric.fragmentId} (resolved through the engine's existing `fragmentResolver`,
 * i.e. the merged tenant catalog of managed + document-backed fragments). That is why this
 * initiative adds no rubric table: the fragment library already owns rubric-shaped text, with
 * its CRUD, tenancy and runtime symmetry.
 */
export interface JudgeRubric {
  /** Stable id, recorded on the step + the PR report (e.g. `rubric_scope_adherence`). */
  id: string
  /** Human name, shown in the judge window and the PR verification report. */
  name: string
  /** The default rubric body folded into the assessment prompt. */
  body: string
  /**
   * Optional prompt-library fragment id whose body OVERRIDES {@link body} for a workspace
   * that authored it. Absent ⇒ the default body is always used.
   */
  fragmentId?: string
}

/** What the assessment is given about the run it is judging. */
export interface JudgeSubject {
  workspaceId: string
  block: Block
  /** The judge step itself (so a registration can read `stepOptions` / prior state). */
  step: PipelineStep
  /** The rubric body actually in force (default, or the workspace's fragment override). */
  rubric: string
  /** The rubric's name, for the prompt's framing. */
  rubricName: string
  /** The preceding steps' outputs, oldest first — the work under review. */
  priorOutputs: { agentKind: string; output: string }[]
  /** The rework feedback from an earlier bounce round, when this is a re-judgement. */
  previousFindings?: JudgeVerdict | null
  /**
   * The catalog model id the registration pinned for this rubric ({@link JudgeDefinition.modelId}),
   * passed through so the assessor resolves it under the deployment's own catalog and route
   * order. Absent ⇒ the judge named no model.
   */
  modelId?: string
}

/**
 * The seam that actually produces a verdict. The engine's default implementation is an
 * INLINE LLM call (orchestration's `JudgeService`, built from the model-provider dependencies
 * every facade already wires — so no facade needs judge-specific wiring, and the runtimes
 * cannot drift). A test/conformance harness injects a deterministic fake through the SAME
 * seam, which is what makes evaluate / park / bounce assertable on both runtimes with no model.
 *
 * `enabled === false` ⇒ every judge step is a PASS-THROUGH (`status: 'skipped'`), so existing
 * pipelines and the e2e suite behave exactly as they did before judges existed.
 */
export interface JudgeAssessor {
  /** Whether an assessment can run at all (a model provider + routing default are wired). */
  readonly enabled: boolean
  /**
   * Produce ONE verdict. Returns the RAW value plus the model that produced it; the engine
   * parses it against the registration's schema (so a registration owns its own shape) and
   * treats a parse failure as a failing verdict rather than a crashed run.
   *
   * `modelPin` reports what became of {@link JudgeSubject.modelId}: applied, overridden by a
   * more specific choice, or unresolvable in this deployment. The engine records it on the step
   * verbatim; an assessor that resolves no model of its own (a test fake) simply omits it.
   */
  assess(
    subject: JudgeSubject,
  ): Promise<{ verdict: unknown; model: string; modelPin?: JudgeModelPin }>
}

/**
 * The per-judge differentiators the engine's generic judge machine needs. Everything shared
 * (the state machine, rubric resolution, persistence, threshold comparison, disposition,
 * budget, emission) lives in the engine.
 */
export interface JudgeDefinition {
  /** Matches the step's `agentKind` (e.g. `scope-adherence`). */
  kind: string
  /** The rubric this judge assesses against. */
  rubric: JudgeRubric
  /**
   * The CATALOG MODEL ID this rubric was authored for (e.g. `claude-opus`), when the judgement
   * needs a particular model rather than whatever the workspace runs its ordinary steps on. A
   * doc-completeness rubric and a security rubric are not the same ask, and a registration is
   * the only thing that knows which of the two it is.
   *
   * A catalog id rather than a `ModelRef`, deliberately: an id is resolved through the
   * deployment's own catalog under the ROUTE ORDER the task's preset states, so a pinned judge
   * still honours a residency-constrained preset. A `provider:model` pair would bypass both.
   *
   * It is a DEFAULT, not an override. The model resolves in this order, most specific first:
   *
   *   1. the task's own pinned model (`Block.modelId`);
   *   2. a workspace preset override NAMING this judge's kind (`overrides['scope-adherence']`);
   *   3. this pin;
   *   4. the preset's base model, then the deployment's routing default.
   *
   * It sits above the preset BASE model on purpose: a base is a blanket statement about every
   * kind, so a pin placed under it could never be reached. It sits below an override that names
   * the kind for the same reason the threshold lives on the merge preset rather than here: a
   * deployment-global constant no workspace could relax is not a policy, and the model-defaults
   * panel already lists every registered judge as its own row.
   *
   * An id this deployment cannot serve is NOT a silent fallback: the assessment runs on the
   * default and `step.judge.modelPin` records `unavailable`, because a rubric scored by a model
   * its author rejected otherwise reads exactly like one it approved.
   */
  modelId?: string
  /**
   * Parse the raw assessment into a verdict. Defaults to the contract's `judgeVerdictSchema`
   * (via `parseJudgeVerdict`) when omitted; a registration with a richer rubric shape passes
   * its OWN valibot schema's parser — e.g. `defineStructuredOutput(mySchema).parse` from
   * `@cat-factory/agents`, or a bare `(value) => v.parse(mySchema, value)`.
   *
   * It is a PARSER rather than the schema object because kernel deliberately carries no
   * valibot dependency (the wire schemas live one layer below, in `@cat-factory/contracts`).
   * Throwing is the correct failure mode: the engine catches it and records a failing verdict
   * rather than crashing the run, so an unparseable assessment is a rubric FAILURE, never a
   * silent advance.
   *
   * Whatever it returns MUST expose a `score` — that is the number the per-task threshold
   * compares, and what the shared judge window + PR report render for every judge without
   * knowing its rubric.
   */
  parseVerdict?(value: unknown): JudgeVerdict
  /**
   * The minimum score the verdict must reach, resolved from the task's merge preset. Defaults
   * to `preset.judgeMinScore` when omitted.
   */
  threshold?(preset: Pick<RiskPolicy, 'judgeMinScore' | 'judgeMaxBounces'>): number
  /**
   * The bounce budget, resolved from the task's merge preset. Defaults to
   * `preset.judgeMaxBounces` when omitted.
   */
  attemptBudget?(preset: Pick<RiskPolicy, 'judgeMinScore' | 'judgeMaxBounces'>): number
  /**
   * What to do with a verdict BELOW the threshold:
   *  - `park`   — park the run on a human decision + raise a `judge_review` notification;
   *  - `bounce` — re-arm the nearest preceding producing step (see {@link bounceTargets}) with
   *               the findings as rework feedback and re-run through this judge, until the
   *               budget is spent (then it parks — never a silent advance);
   *  - `fail`   — fail the run with the verdict summary.
   */
  onFail: 'park' | 'bounce' | 'fail'
  /**
   * The agent kinds this judge grades, searched BACKWARD from the judge step to find the step
   * a `bounce` re-arms. Omitted ⇒ the immediately preceding step. When nothing matches, a
   * `bounce` degrades to `park` and the step records why (a rubric gate must never advance
   * silently because it had nowhere to send the work back to).
   */
  bounceTargets?: string[]
  /**
   * Whether this judge can run at all beyond the assessor being wired — e.g. a judge that
   * needs its own provider. False ⇒ pass-through with {@link unwiredOutput}. Defaults to true.
   */
  wired?(): boolean
  /** Step output recorded when the judge passes through unwired. */
  unwiredOutput?: string
  /**
   * Display metadata, so a registered judge becomes a first-class palette block and opens the
   * shared `judge` result window. Omitted ⇒ the kind is not a palette block (it can still be
   * placed by a registered pipeline).
   */
  presentation?: {
    label: string
    icon: string
    color: string
    description: string
    category?: 'review' | 'design' | 'build' | 'test' | 'docs' | 'gates'
    /** Defaults to the built-in `judge` window; a deployment may name its own namespaced view. */
    resultView?: string
  }
}

/**
 * The shared engine seams a registered judge legitimately needs, handed to its factory at
 * registry-build time. Deliberately minimal + runtime-neutral, mirroring {@link GateContext}:
 * the engine keeps owning the assessment dispatch, threshold resolution, persistence and the
 * state machine.
 */
export interface JudgeContext {
  /** The engine clock (monotonic-ish ms). */
  clock: Clock
  /** Read a block, e.g. to scope a rubric to a service. */
  getBlock(workspaceId: string, blockId: string): Promise<Block | null>
  /** Run a function under the run initiator's ambient context (per-user credentials). */
  runInitiatorScope: RunInitiatorScope
  /** Raise (or re-raise) a human-actionable notification. */
  raiseNotification(workspaceId: string, input: RaiseNotificationInput): Promise<void>
  /** The wired impl for a provider token, or `undefined` (drives a judge's `wired()`). */
  getProvider<T>(token: ProviderToken<T>): T | undefined
  /** The wired impl for a provider token, or throw. */
  requireProvider<T>(token: ProviderToken<T>): T
  /** Whether an impl is wired for a provider token — the canonical source for `wired()`. */
  isProviderWired<T>(token: ProviderToken<T>): boolean
}

/**
 * A registered judge is a factory the engine invokes ONCE at registry-build time with a
 * {@link JudgeContext}, mirroring {@link GateFactory}. A factory (rather than a static
 * definition) lets a judge's hooks close over the engine seams + the registrant's own
 * provider, which a static object built at import time could not reach.
 */
export type JudgeFactory = (ctx: JudgeContext) => JudgeDefinition

/**
 * App-owned registry of judges, mirroring {@link GateRegistry} / {@link StepResolverRegistry}.
 * The composition root news ONE instance (`defaultJudgeRegistry()`), threads it through
 * `CoreDependencies`, and the engine reads it from there when it lazily builds its per-kind
 * judge map — so there is no module-global `Map`, no `clear*()` test cruft, and no
 * external-adapter module-identity gotcha: a deployment registers its judges by reference
 * (`registry.register(kind, factory)`) on the instance the facade injects.
 *
 * Empty by default: the platform ships NO built-in judges today (the merger stays a
 * privileged built-in — see the tracker's D7), so every entry is a deployment's own.
 */
export class JudgeRegistry {
  private readonly registry = new Map<string, JudgeFactory>()

  /**
   * Register a judge, keyed by the step `agentKind` it judges. A later registration of the
   * same kind replaces the earlier one (so a deployment can override an earlier entry). The
   * `kind` is passed explicitly because the factory's result isn't built until the engine
   * invokes it.
   */
  register(kind: string, factory: JudgeFactory): void {
    this.registry.set(kind, factory)
  }

  /** The registered judges (registration order). */
  factories(): { kind: string; factory: JudgeFactory }[] {
    return [...this.registry].map(([kind, factory]) => ({ kind, factory }))
  }
}

/** A fresh, empty judge registry. A deployment registers its own judges by reference on it. */
export function defaultJudgeRegistry(): JudgeRegistry {
  return new JudgeRegistry()
}

/**
 * A minimal {@link JudgeContext} for tests that invoke a judge factory in isolation (the real
 * one is built by the engine's `JudgeStepController`). Defaults to harmless no-ops; pass
 * `providerRegistry` to have the provider seams read a specific registry, and `overrides` to
 * assert against a specific seam. Centralised here so a new required field is filled in ONE
 * place instead of every judge test — the {@link stubGateContext} precedent.
 */
export function stubJudgeContext(
  overrides: Partial<JudgeContext> = {},
  providerRegistry: ProviderRegistry = defaultProviderRegistry(),
): JudgeContext {
  return {
    clock: { now: () => 0 },
    getBlock: async () => null,
    runInitiatorScope: (_initiatedBy, fn) => fn(),
    raiseNotification: async () => {},
    getProvider: (token) => providerRegistry.get(token),
    requireProvider: (token) => providerRegistry.require(token),
    isProviderWired: (token) => providerRegistry.isWired(token),
    ...overrides,
  }
}
