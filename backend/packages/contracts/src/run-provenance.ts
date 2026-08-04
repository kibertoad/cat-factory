import * as v from 'valibot'

// A run's PROVENANCE: how it entered the system, whether it may land its work, and where it
// actually executed. Three small vocabularies that answer questions about the run rather than
// about the work, all of them riding the run's `detail` JSON rather than a column, and all read
// by policy (admission, the merge decision, the clarification writeback) or by an investigator
// after the fact. Split out of `execution.ts`, which describes the STEPS.

/**
 * How a run entered the system. `ui` is every in-app surface (the SPA board, an initiative
 * spawn, a cadence-driven recurring schedule fire) and is the DEFAULT for anything that
 * doesn't say otherwise; `public-api` is a run started headlessly through the `/api/v1`
 * surface; `tracker` is a run a tracker webhook dispatched from a pushed ticket (the
 * per-ticket dispatch mode of an issue-intake schedule). See `ExecutionInstance.intakeOrigin`.
 */
export const intakeOriginSchema = v.picklist(['ui', 'public-api', 'tracker'])
export type IntakeOrigin = v.InferOutput<typeof intakeOriginSchema>

/**
 * Whether an intake origin means there is NO human overseer in the app: the run entered from
 * outside, so anything it needs from a person has to be pushed back out to where it came from
 * (the parked requirements review's questions, above all).
 *
 * A `Record` rather than a `!== 'ui'` test on purpose: this is the classification the whole
 * clarification writeback keys off, and a new intake surface must state which side of it falls
 * on rather than inheriting "headless" by being new. Adding a member to the picklist above
 * fails to compile until it is answered here.
 */
const HEADLESS_INTAKE: Record<IntakeOrigin, boolean> = {
  ui: false,
  'public-api': true,
  tracker: true,
}

/**
 * Whether a run entered headlessly ({@link HEADLESS_INTAKE}). `undefined` is every legacy run
 * and degrades to `ui`, the safe reading: no outbound writeback for a run whose intake cannot
 * be proven headless.
 */
export function isHeadlessIntake(origin: IntakeOrigin | undefined): boolean {
  return origin != null && HEADLESS_INTAKE[origin]
}

/**
 * Whether a run may LAND its work. `live` (the default, and every run before this existed) is the
 * historical behaviour. `dry_run` is the sandboxed mode: the pipeline runs in full and opens its
 * pull request, so the human sees a real diff on a real branch, but nothing merges: neither the
 * `merger` step's auto-merge nor the manual merge endpoint.
 *
 * The PR is deliberately still opened. The deliverable a non-engineer needs to SEE is the diff,
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
 * Per-run diagnostic context captured for AFTER-THE-FACT investigation of a run (esp. a
 * failure): the "where/what did this run actually execute on" facts that were previously
 * spread across the DB (repo↔service↔installation joins), the harness transcript (model), or
 * lost entirely (which backend a step ran on). Stamped by the engine at dispatch and refined
 * on the first poll; it reflects the MOST RECENT container-step dispatch (the step most likely
 * relevant to a failure), not a per-step history. Rides in the run's `detail` JSON (no dedicated
 * column), like `ExecutionInstance.notes`/`frontendBindings`. Absent on legacy runs and on
 * runs with no container step (pure inline/gate pipelines). NEVER carries a token or secret.
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
       * Which runner backend the step actually ran on — the datum that distinguishes a native
       * host-process run from a sandboxed container: `local-native` | `local-container` |
       * `runner-pool` | `cloudflare-container`. Filled on the first poll (the transport reports
       * it); absent until then or on an older runtime.
       */
      executionBackend: v.optional(v.string()),
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
   * The control-plane (orchestrator) host running the engine — NOT necessarily where the agent
   * ran (a container step runs elsewhere; see `lastDispatch.executionBackend`). `platform` is the
   * orchestrator's `process.platform` (e.g. `win32` pins a Windows local deployment — the class
   * of host that surfaced the native-Windows git-auth break). Best-effort.
   */
  host: v.optional(
    v.object({
      platform: v.optional(v.string()),
    }),
  ),
})
export type RunDiagnostics = v.InferOutput<typeof runDiagnosticsSchema>
