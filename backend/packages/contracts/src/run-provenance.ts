import * as v from 'valibot'

// A run's PROVENANCE: how it entered the system, whether it may land its work, and where it
// actually executed. Three small vocabularies that answer questions about the run rather than
// about the work, all of them riding the run's `detail` JSON rather than a column, and all read
// by policy (admission, the merge decision, the clarification writeback) or by an investigator
// after the fact. Split out of `execution.ts`, which describes the STEPS.

/**
 * How a run entered the system. See `ExecutionInstance.intakeOrigin`.
 *
 * - `ui`: someone started it in the app, on their own board. The read-time default, and what
 *   every legacy run is.
 * - `public-api`: started headlessly through the `/api/v1` surface.
 * - `tracker`: dispatched from a pushed ticket by a per-ticket issue-intake schedule.
 * - `schedule`: a recurring schedule fired it, either on its cadence or because a tracker push
 *   drained its queue early. Both are the same run against the same reused block (ADR 0032), so
 *   they deliberately share one origin; what differs is only what made the tick happen.
 *
 * `ui` is the DEFAULT, which makes it a positive claim that a human is watching in the app, not
 * a catch-all for "nothing said". Every UNATTENDED start path names itself, so a path that
 * states nothing is the app: the one caller allowed to rely on the default. That rule exists
 * because the opposite reading is silent, and it already cost one bug (a webhook-dispatched run
 * defaulted into `ui` and its parked review's questions never reached the requester's ticket).
 */
export const intakeOriginSchema = v.picklist(['ui', 'public-api', 'tracker', 'schedule'])
export type IntakeOrigin = v.InferOutput<typeof intakeOriginSchema>

/**
 * Whether an intake origin means the run's questions have to be pushed back OUT to where it came
 * from, because there is no human overseer in the app to answer them (the parked requirements
 * review's questions, above all).
 *
 * A `Record` rather than a `!== 'ui'` test on purpose: this is the classification the whole
 * clarification writeback keys off, and a new intake surface must state which side of it falls
 * on rather than inheriting an answer by being new. Adding a member to the picklist above fails
 * to compile until it is answered here.
 *
 * `schedule` is the entry worth explaining, because "unattended" would predict `true` and the
 * answer is `false`. A cadence fire runs against the schedule's REUSED block, and in queue mode
 * `BugIntakeService` REPLACE-links each pick onto it: the block's linked ticket is dropped and
 * re-pointed on the next fire, by design, so the block never accumulates stale context. Posting
 * questions there would open a conversation on a channel that closes underneath it, since a
 * reply arriving after the link moved resolves to no block and is dropped. What the writeback
 * needs is not "was anyone present" but "is there a STABLE place to hold a conversation", and a
 * reused block does not have one. Per-ticket dispatch does, which is why it is `true`: one
 * permanent block per ticket. Giving queue mode the same treatment is a change to the LINKAGE
 * (a per-run link, or a block per pick), never a flip of this flag.
 */
const HEADLESS_INTAKE: Record<IntakeOrigin, boolean> = {
  ui: false,
  'public-api': true,
  tracker: true,
  schedule: false,
}

/**
 * Whether a run entered headlessly ({@link HEADLESS_INTAKE}). `undefined` is every legacy run
 * and degrades to `ui`, the safe reading: no outbound writeback for a run whose intake cannot
 * be proven headless.
 *
 * `=== true` rather than the bare lookup, which the type says is already a `boolean`. The value
 * reaches here off a run's persisted `detail` JSON, and the picklist is a CLOSED vocabulary whose
 * members outlive their retirement in stored rows: a run written under a member later dropped
 * from the type indexes to `undefined` at runtime, and the declared `boolean` would be a lie the
 * caller reads as "not headless" anyway. Saying so explicitly makes unrecognised and absent one
 * answer on purpose rather than by luck.
 */
export function isHeadlessIntake(origin: IntakeOrigin | undefined): boolean {
  return origin != null && HEADLESS_INTAKE[origin] === true
}

/**
 * WHICH of a workspace's two defaults a run resolves when its task pinned none.
 *
 * `interactive` is a run somebody started in the app and is watching; `unattended` is one nothing
 * is watching, whatever surface dispatched it. TWO libraries are scoped by it and both read the
 * one {@link runDefaultScopeFor} below: the risk policies (`isDefault` / `isUnattendedDefault`,
 * ADR 0053) and the pipelines. Named for the RUN rather than for either of them, because a second
 * consumer arriving is what proved the question is about the run: "is anyone watching this" is not
 * a fact about a policy row.
 */
export const runDefaultScopeSchema = v.picklist(['interactive', 'unattended'])
export type RunDefaultScope = v.InferOutput<typeof runDefaultScopeSchema>

/**
 * Every scope, for the readers that must answer about ALL of them (the board's policy-selection
 * guard judges a move against each, because a task can be started either way).
 *
 * Read off the picklist's OWN options rather than restated, so a third scope cannot appear in one
 * place and be missed in the other.
 */
export const RUN_DEFAULT_SCOPES: readonly RunDefaultScope[] = runDefaultScopeSchema.options

/**
 * Which of the workspace's two defaults a run of this intake resolves when its task
 * pinned none (see {@link runDefaultScopeSchema}).
 *
 * A SECOND `Record` over the same picklist, deliberately not derived from {@link HEADLESS_INTAKE},
 * because the two answer different questions and disagree on `schedule`. That one is not headless
 * (its reused block has no stable place to hold a clarification conversation) and yet nobody is
 * watching it run, so it takes the unattended policy: a cadence fire that parks on a companion cap
 * waits until somebody happens to open the board, which is the failure this scope exists to stop.
 *
 * Only `ui` is `interactive`, and it is the same positive claim the default `ui` intake makes: a
 * human is in the app. A new intake surface fails to compile until it says which it is.
 */
const DEFAULT_POLICY_SCOPE: Record<IntakeOrigin, RunDefaultScope> = {
  ui: 'interactive',
  'public-api': 'unattended',
  tracker: 'unattended',
  schedule: 'unattended',
}

/**
 * The default-resolution scope for a run's intake. `undefined` is every run persisted before
 * `intakeOrigin` existed and degrades to `interactive`, matching how such a run already degrades
 * to `ui` everywhere else: a run that cannot be PROVEN unattended is not granted the unattended
 * policy's licence to answer its own caps.
 *
 * The lookup is guarded rather than bare for the reason {@link isHeadlessIntake}'s is: the
 * picklist is a CLOSED vocabulary whose members outlive their retirement in stored rows, and a
 * run written under a member later dropped indexes to `undefined` at runtime while the declared
 * type says otherwise.
 */
export function runDefaultScopeFor(origin: IntakeOrigin | undefined): RunDefaultScope {
  return (origin != null ? DEFAULT_POLICY_SCOPE[origin] : undefined) ?? 'interactive'
}

/**
 * Whether a run may LAND its work. `live` (the default, and every run before this existed) is the
 * historical behaviour. `dry_run` is the sandboxed mode: the pipeline runs in full and opens its
 * pull request, so the human sees a real diff on a real branch, but nothing merges: neither the
 * `merger` step's auto-merge nor the manual merge endpoint.
 *
 * The PR is deliberately still opened. The deliverable a non-developer initiator needs to SEE is the diff,
 * and withholding the push would leave them reading prose about work they cannot inspect; what
 * makes the mode a sandbox is that the change cannot reach the default branch, not that it stays
 * invisible.
 *
 * Requested per run at start, and FORCED for the roles a task's merge preset lists in
 * `dryRunRoles`. The two compose one way only: a live request from a sandboxed role is a dry run,
 * and there is no way to ask out of it, or the setting would be advisory.
 */
export const runModeSchema = v.picklist(['live', 'dry_run'])
export type RunMode = v.InferOutput<typeof runModeSchema>

/**
 * Whether a run is sandboxed. A helper rather than `=== 'dry_run'` scattered across the merge path
 * and the SPA, so every place that must refuse to land work (or must say that a run will never
 * land any) reads the mode the same way, and so a run persisted before the mode existed
 * (absent ⇒ `live`) can never be mistaken for one.
 */
export function isDryRun(mode: RunMode | null | undefined): boolean {
  return mode === 'dry_run'
}

/**
 * Per-run diagnostic context captured for AFTER-THE-FACT investigation of a run (esp. a
 * failure): the "where/what did this run actually execute on" facts that were previously
 * spread across the DB (repo↔service↔installation joins), the harness transcript (model), or
 * lost entirely (which backend a step ran on). Stamped by the engine BEFORE the dispatch and
 * refined by what the dispatch returned and by the first poll; it reflects the MOST RECENT
 * dispatch (the step most likely relevant to a failure), not a per-step history. Rides in the
 * run's `detail` JSON (no dedicated column), like `ExecutionInstance.notes`/`frontendBindings`.
 * Absent on legacy runs. NEVER carries a token or secret.
 *
 * Stamped BEFORE the dispatch on purpose: it used to be written from the job handle, which
 * only exists once the container has accepted the job, so the failures where "which model,
 * which repo, which backend" matters most (a container that never started, a preflight
 * rejection) were the exact ones that recorded nothing.
 */
export const runDiagnosticsSchema = v.object({
  /** Context of the most recent container-step dispatch. */
  lastDispatch: v.optional(
    v.object({
      /** Index of the dispatched step within the pipeline. */
      stepIndex: v.number(),
      /** The step's agent kind (`coder`, `merger`, a custom kind, …). */
      agentKind: v.string(),
      /** Resolved model ref `provider:model` (e.g. `anthropic:claude-opus-4-8`); null if unresolved. */
      model: v.optional(v.nullable(v.string())),
      /**
       * Which runner backend the step actually ran on, the datum that distinguishes a native
       * host-process run from a sandboxed container: `local-native` | `local-container` |
       * `runner-pool` | `cloudflare-container`, plus `inline` for a step the engine answered
       * with an LLM call of its own rather than dispatching anywhere. Filled on the first poll
       * for a container step (the transport reports it) and at dispatch for an inline one;
       * absent until then or on an older runtime.
       */
      executionBackend: v.optional(v.string()),
      /**
       * How the dispatch itself ended, when it did not reach a running job. PRESENCE is the
       * signal (a dispatch that was accepted, or is still in flight, carries none), so there
       * is no "succeeded" member to keep in step with anything.
       *
       * This is the half the block was missing: the model/repo/backend facts describe where a
       * step ran, and a run that died before any of that says which of them never happened
       * and why. `kind` is the engine's own dispatch failure taxonomy and `reason` the
       * machine-readable cause when the throw carried one (a preflight `DomainError`), so an
       * investigation reads the same vocabulary the run's failure card renders.
       */
      failure: v.optional(
        v.object({
          /** `preflight` | `evicted` | `dispatch`: the engine's dispatch failure taxonomy. */
          kind: v.string(),
          /** Machine-readable cause (e.g. `github_not_connected`), when the throw carried one. */
          reason: v.optional(v.string()),
          /** Epoch ms the dispatch failed. */
          at: v.number(),
        }),
      ),
      /** The repo the step operated on. */
      repo: v.optional(
        v.object({
          owner: v.string(),
          name: v.string(),
          /** The base branch the work branched from. */
          baseBranch: v.optional(v.string()),
          /** VCS provider (`github` | `gitlab`), resolved from the run's repo origin. */
          provider: v.optional(v.string()),
        }),
      ),
      /** Epoch ms the dispatch was recorded. */
      at: v.number(),
    }),
  ),
  /**
   * The control-plane (orchestrator) host running the engine, NOT necessarily where the agent
   * ran (a container step runs elsewhere; see `lastDispatch.executionBackend`). `platform` is the
   * orchestrator's `process.platform` (e.g. `win32` pins a Windows local deployment, the class
   * of host that surfaced the native-Windows git-auth break). Best-effort.
   */
  host: v.optional(
    v.object({
      platform: v.optional(v.string()),
    }),
  ),
})
export type RunDiagnostics = v.InferOutput<typeof runDiagnosticsSchema>
