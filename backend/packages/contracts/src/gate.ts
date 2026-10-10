import * as v from 'valibot'
import { descriptorFieldValuesSchema } from './form-fields.js'
import { releaseSignalSchema } from './release.js'

// ---------------------------------------------------------------------------
// Polling-GATE step state — the live loop state a `ci` / `conflicts` /
// `post-release-health` / `human-review` (or a deployment's own) gate step carries.
//
// Split out of `execution.ts` along a cohesive seam (the file-size ratchet: split, never
// grow), matching how the other per-step-kind state clusters already live in their own
// modules — `forkDecision.ts`, `judge.ts`. `execution.ts` composes it back onto
// `PipelineStep` as the `gate` field.
// ---------------------------------------------------------------------------

/**
 * State a polling **gate** step carries (today `ci` and `conflicts`). A gate is
 * special (like a `deployer` step): it is NOT itself an LLM/container agent. It
 * runs a programmatic precheck against a provider (CI check runs / PR mergeability)
 * for the PR head commit and only escalates to a helper container agent (`ci-fixer`
 * / `conflict-resolver`) on a negative verdict, looping until the precheck passes or
 * the attempt budget is spent. Which gate a step is comes from its `agentKind`, so it
 * is not duplicated here. See the engine's `GateDefinition` registry.
 *   - `phase: 'checking'` — running the precheck / waiting for the provider.
 *   - `phase: 'working'`  — a helper agent is in flight (tracked via the step's
 *                           `jobId`); on completion the gate returns to `checking`.
 */
/** One failing check the CI gate's precheck saw, flattened for display. */
export const gateFailingCheckSchema = v.object({
  name: v.string(),
  /** GitHub conclusion (e.g. `failure`, `timed_out`), or null when not reported. */
  conclusion: v.nullable(v.string()),
  /**
   * The check run's GitHub web URL (`html_url`), so the UI can link straight to the
   * failed run's logs. Null when GitHub didn't report one.
   */
  url: v.optional(v.nullable(v.string())),
  /**
   * The repo (owner/name) this check belongs to, on a MULTI-REPO block — so the UI can group
   * failing checks by service. Absent on a single-repo block (there is only the own repo).
   */
  repo: v.optional(v.string()),
})
export type GateFailingCheck = v.InferOutput<typeof gateFailingCheckSchema>

/**
 * One helper-agent attempt the gate dispatched (a ci-fixer / conflict-resolver run),
 * recorded when the job finishes so the UI can show what each attempt tried and how it
 * ended — detail that used to be discarded the moment the gate re-probed.
 */
export const gateAttemptSchema = v.object({
  /** 1-based attempt number (matches `attempts` at the time the helper was dispatched). */
  attempt: v.number(),
  /** Epoch ms when the helper job finished. */
  at: v.number(),
  /**
   * How the helper job ended:
   *   - `completed` — the container finished (it may or may not have fully fixed the
   *     issue; the gate's next precheck is the source of truth, and `summary` carries
   *     the agent's own account, e.g. which files it left conflicting).
   *   - `failed`    — the job errored / was evicted without finishing.
   */
  outcome: v.picklist(['completed', 'failed']),
  /** The PR head commit the helper worked against, when known. */
  headSha: v.optional(v.nullable(v.string())),
  /**
   * The fixing instructions handed to the helper for this round — the failing-check
   * summary the CI gate fed the `ci-fixer`, the conflict reason / human-review comments
   * the other gates fed their fixer. Stashed at dispatch and recorded with the attempt so
   * the run-detail UI can show WHAT each round was asked to fix (not only that a round
   * happened) — the gate analogue of the Tester attempt's `concerns`. Null when the gate
   * hands its fixer no textual instructions (the conflicts gate: GitHub reports mergeability
   * as a single bit and the harness leaves the conflict markers for the resolver).
   */
  instructions: v.optional(v.nullable(v.string())),
  /**
   * Structured failing checks handed to this attempt's helper (the CI gate's red check runs
   * behind {@link instructions}), snapshotted at dispatch so each attempt shows the checks it
   * set out to fix. Absent for the conflicts gate (no file-level detail) and when the round
   * carried no structured checks.
   */
  failingChecks: v.optional(v.nullable(v.array(gateFailingCheckSchema))),
  /** The helper's own summary (or the failure reason), naming what it did / what remains. */
  summary: v.optional(v.nullable(v.string())),
})
export type GateAttempt = v.InferOutput<typeof gateAttemptSchema>

export const gateStepStateSchema = v.object({
  phase: v.picklist(['checking', 'working']),
  /** How many helper-agent attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on attempts, resolved from the task's merge preset at step start. */
  maxAttempts: v.number(),
  /** The PR head commit being gated, once resolved (the own-service PR on a multi-repo block). */
  headSha: v.optional(v.nullable(v.string())),
  /**
   * Per-PR head commits for a MULTI-REPO block (service-connections phase 4), keyed by repo
   * full name (owner/name) — own-service PR plus each peer-service PR. Set by the CI /
   * conflicts gates whose precheck aggregates across every PR the task opened. Absent for a
   * single-repo block (the scalar {@link headSha} is the only head).
   */
  headShas: v.optional(v.nullable(v.record(v.string(), v.string()))),
  /**
   * The repo the conflicts gate's most recent `fail` verdict found conflicted, so the
   * single-repo conflict-resolver is dispatched at THAT repo (own-service or a peer) rather
   * than always the own-service one. Absent ⇒ the own-service repo. Only the conflicts gate
   * sets it (the CI-fixer runs across all repos, so the CI gate leaves it undefined).
   */
  conflictTarget: v.optional(
    v.nullable(
      v.object({
        repo: v.string(),
        frameId: v.optional(v.string()),
        branch: v.optional(v.string()),
      }),
    ),
  ),
  /**
   * The most recent precheck verdict, so the UI can show why the gate is looping
   * (failing → a helper is fixing) vs idle-passing. Set on every probe.
   */
  lastVerdict: v.optional(v.nullable(v.picklist(['pass', 'pending', 'fail']))),
  /**
   * The step's own parameters for this gate (`stepOptions.gateConfig.fields`), copied onto the
   * gate state ONCE on first entry alongside `maxAttempts` and validated, before it got here,
   * against the descriptor fields the gate registered. This is how a gate reads a knob off the
   * STEP rather than off the engine or the workspace-wide merge preset: `probe` receives the live
   * gate state, so a registered gate reads `gateState.config` with no new plumbing per parameter.
   *
   * Absent ⇒ the gate's shipped defaults (which for the built-ins means the preset's values).
   */
  config: v.optional(v.nullable(descriptorFieldValuesSchema)),
  /**
   * Human-readable summary of the latest failing precheck (the failing CI checks /
   * the conflict reason) — the conclusion detail that used to be fed only to the
   * helper agent and then discarded. Carried across the helper dispatch so the
   * window keeps showing what is being fixed. Null when the last probe passed.
   */
  lastFailureSummary: v.optional(v.nullable(v.string())),
  /**
   * Structured failing checks behind {@link lastFailureSummary} for the CI gate, so
   * the UI can list each red check by name + conclusion. Absent for the conflicts
   * gate (GitHub reports no file-level detail) and when the last probe passed.
   */
  failingChecks: v.optional(v.nullable(v.array(gateFailingCheckSchema))),
  /**
   * The fixing instructions handed to the most-recently dispatched helper (the failing-check
   * summary / conflict reason / human fix prompt), stashed at dispatch so the attempt recorded
   * when that helper's job settles can carry WHAT the round was asked to fix onto its
   * {@link gateAttemptSchema} entry. Transient bookkeeping — the durable per-round history lives
   * on {@link attemptLog}. Null when the gate hands its fixer no textual instructions.
   */
  lastDispatchedInstructions: v.optional(v.nullable(v.string())),
  /**
   * Epoch ms of the release marker for a time-windowed gate (post-release-health) — the
   * moment it began watching the deployed release. The gate keeps polling `pending`
   * until this + the preset's watch window has elapsed (then a clean run passes) or a
   * monitor/SLO regresses (then it escalates to the on-call agent). Absent for the
   * CI/conflicts gates.
   */
  watchSince: v.optional(v.nullable(v.number())),
  /**
   * The watch-window length (minutes) for a time-windowed gate (post-release-health),
   * resolved from the task's merge preset ONCE on first entry (alongside `maxAttempts`)
   * so the probe doesn't re-load the block + re-resolve the preset on every poll. Absent
   * for the CI/conflicts gates.
   */
  watchWindowMinutes: v.optional(v.nullable(v.number())),
  /**
   * The regressed signals captured when the post-release-health gate escalated to the
   * on-call agent, so the agent's completion handler can build the `release_regression`
   * notification + incident enrichment from the SAME evidence the agent investigated
   * — rather than re-reading Datadog (a third round-trip that could also disagree with
   * what the agent saw if the window moved). Absent for the CI/conflicts gates.
   */
  regressedSignals: v.optional(v.nullable(v.array(releaseSignalSchema))),
  /**
   * Append-only history of the helper-agent attempts this gate dispatched (ci-fixer /
   * conflict-resolver runs), each recorded when its job finished. Lets the UI show what
   * every attempt tried and how it ended, instead of only a bare `attempts` count.
   * Absent for the post-release-health gate (its on-call helper is resolved specially).
   */
  attemptLog: v.optional(v.nullable(v.array(gateAttemptSchema))),
  // ---- human-review gate only (absent for the CI/conflicts/post-release-health gates) ----
  /**
   * The number of approving reviews the PR had at the last probe, so the UI can show
   * "1 / N approvals". The "required" side is derived from {@link requiredApprovingReviewCount}
   * via the same `max(1, …)` floor the gate applies (see review.logic.ts) rather than persisted
   * a second time. Absent for the other gates.
   */
  lastApprovals: v.optional(v.nullable(v.number())),
  /**
   * The raw branch-protection required-approving-review count, cached after the FIRST probe
   * resolves it so subsequent polls skip the static protection read (branch protection is repo
   * config, not PR activity — re-reading it every poll over a multi-day review only burns GitHub
   * rate budget). The UI's displayed "required" count is `max(1, this)` (the gate's effective
   * floor). Absent for the other gates.
   */
  requiredApprovingReviewCount: v.optional(v.nullable(v.number())),
  /**
   * The GraphQL ids of the review threads the gate just handed the `fixer`, stashed at
   * dispatch so the helper-completion hook can post a reply + RESOLVE exactly those threads
   * on GitHub before the next probe reads them. Absent for the other gates.
   */
  pendingThreadIds: v.optional(v.nullable(v.array(v.string()))),
  /**
   * Epoch ms of the newest plain PR comment the gate has already handed the `fixer`. Plain
   * conversation comments (unlike review threads) can't be "resolved" on GitHub, so they are
   * tracked by timestamp: a comment newer than this is outstanding; the dispatch advances it to
   * the batch max. A reviewer's later comment (newer timestamp) re-opens the work. Absent for
   * the other gates.
   */
  lastAddressedCommentAt: v.optional(v.nullable(v.number())),
  /**
   * The grace window (minutes) the human-review gate waits after the latest review comment
   * before dispatching the fixer, resolved from the task's merge preset ONCE on first entry
   * (alongside `maxAttempts`) so the probe doesn't re-resolve the preset every poll. Absent
   * for the other gates.
   */
  humanReviewGraceMinutes: v.optional(v.nullable(v.number())),
  /**
   * A human-initiated freeform fix request parked on the gate (an in-app prompt). Consumed at
   * the top of the next `evaluateGate` pass, which dispatches the fixer with these instructions
   * folded in — bypassing the grace window. Absent for the other gates.
   */
  pendingFix: v.optional(
    v.nullable(
      v.object({
        instructions: v.string(),
        at: v.number(),
      }),
    ),
  ),
})
export type GateStepState = v.InferOutput<typeof gateStepStateSchema>
