import { ValidationError, type IssueIntakeConfig } from '@cat-factory/kernel'

// Pure shape rules for a schedule's issue-intake configuration, above all the two DISPATCH modes
// (`docs/initiatives/tracker-webhook-intake.md`). Kept out of `RecurringPipelineService` so the
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
      { reason: 'per_ticket_requires_on_demand' },
    )
  }

  // Per-ticket dispatch has ALREADY chosen the ticket. A `bug-intake` step would then run its own
  // board search and adopt a DIFFERENT issue onto the block created for this one, so the run would
  // work a ticket nobody pushed while the pushed one sat linked to it. The two are alternative
  // ways to pick work, and a pipeline may only use one.
  if (input.hasBugIntakeStep) {
    throw new ValidationError(
      "A per-ticket issue-intake schedule cannot run a 'bug-intake' pipeline: the pushed ticket is already the work, so the intake step would pick a different one.",
      { reason: 'per_ticket_conflicts_with_bug_intake' },
    )
  }
}
