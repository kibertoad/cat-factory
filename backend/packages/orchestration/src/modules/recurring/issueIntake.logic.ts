import type { IssueIntakeRefusalReason } from '@cat-factory/contracts'
import type { IntakeMatchVerdict } from '@cat-factory/integrations'
import { ValidationError, type IssueIntakeConfig } from '@cat-factory/kernel'

// Pure shape rules for a schedule's issue-intake configuration, above all the two DISPATCH modes
// (`backend/docs/adr/0032-tracker-webhook-intake.md`). Kept out of `RecurringPipelineService` so the
// rules are unit-testable without a repository, exactly as `pipelineShape.ts` holds the pipeline's.
//
// The modes are deliberately exclusive rather than a knob, and each rule below exists because the
// combination it rejects is one that would otherwise SILENTLY do something other than what the
// author asked for — never merely because it looks odd.

/** How a pushed issue event is dispatched. Absent on a stored config ⇒ `queue`. */
export type IntakeDispatch = NonNullable<IssueIntakeConfig['dispatch']>

/**
 * The dispatch mode a config asks for, defaulting an absent one to `queue`.
 *
 * Every reader goes through this rather than reading `config.dispatch` directly: the field is
 * optional precisely so pre-existing schedules keep their behaviour, and an `undefined` treated as
 * anything but `queue` would silently re-point every one of them.
 */
export function dispatchOf(config: Pick<IssueIntakeConfig, 'dispatch'>): IntakeDispatch {
  return config.dispatch ?? 'queue'
}

/**
 * Whether a mode acts on a verdict from `judgeIssueEventForIntake`. The matcher states what the
 * delivery does and does not establish; this is where the COST of being wrong picks a side, so the
 * fail-open rule that is right for a queue cannot silently govern per-ticket dispatch.
 *
 *  - A `miss` is never acted on: a predicate is definitively violated.
 *  - A `match` is always acted on.
 *  - An `unconfirmed` verdict (the delivery does not carry a field the configuration asks about)
 *    splits. `queue` fires: the run's `searchIssues` is the authority and re-checks every predicate
 *    against the vendor, so the worst case is one no-op run. `per-ticket` does NOT: this verdict is
 *    the last check before a real block and a real agent run on that ticket, and dispatching an
 *    untriaged or out-of-scope ticket is a worse failure than the latency of waiting for a delivery
 *    that does carry the field (the `updated` event a labelling fires is exactly that delivery).
 *
 * The caller REPORTS a withheld dispatch rather than dropping it: a per-ticket schedule is
 * on-demand, so no cadence sweep will come along later and a silent skip is indistinguishable from
 * a delivery that never arrived.
 */
export function dispatchAdmits(verdict: IntakeMatchVerdict, dispatch: IntakeDispatch): boolean {
  if (verdict.outcome === 'miss') return false
  if (verdict.outcome === 'match') return true
  return dispatch === 'queue'
}

/**
 * Validate an intake config against the schedule and pipeline it is being attached to.
 *
 * `hasBugIntakeStep` is the pipeline's own answer (`pipelineHasEnabledBugIntake`), passed in so
 * this stays pure.
 */
export function assertValidIssueIntake(input: {
  config: IssueIntakeConfig
  onDemand: boolean
  hasBugIntakeStep: boolean
}): void {
  const dispatch = dispatchOf(input.config)
  if (dispatch !== 'per-ticket') return

  // A CADENCE tick carries no triggering ticket, so a per-ticket schedule that could also fire on
  // cadence would quietly fall back to draining the queue onto its reused block: the `queue`
  // behaviour, under a config that says `per-ticket`. Requiring `onDemand` removes the fallback
  // rather than documenting it.
  if (!input.onDemand) {
    throw new ValidationError(
      'A per-ticket issue-intake schedule must be on-demand: it is driven by tracker webhooks, and a cadence tick has no ticket to dispatch.',
      refusal('per_ticket_requires_on_demand'),
    )
  }

  // Per-ticket dispatch has ALREADY chosen the ticket. A `bug-intake` step would then run its own
  // board search and adopt a DIFFERENT issue onto the block created for this one, so the run would
  // work a ticket nobody pushed while the pushed one sat linked to it. The two are alternative
  // ways to pick work, and a pipeline may only use one.
  if (input.hasBugIntakeStep) {
    throw new ValidationError(
      "A per-ticket issue-intake schedule cannot run a 'bug-intake' pipeline: the pushed ticket is already the work, so the intake step would pick a different one.",
      refusal('per_ticket_conflicts_with_bug_intake'),
    )
  }
}

/**
 * The `details` payload of an intake refusal, typed against the contracts union so a reason the SPA
 * has no copy for cannot be invented here.
 */
function refusal(reason: IssueIntakeRefusalReason): { reason: IssueIntakeRefusalReason } {
  return { reason }
}
