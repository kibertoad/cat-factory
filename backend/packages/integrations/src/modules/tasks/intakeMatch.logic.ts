import type { IssueIntakeConfig, TaskSourceProvider, TrackerIssueEvent } from '@cat-factory/kernel'

// Does a pushed tracker issue event qualify for a given schedule's intake configuration?
//
// This is the ONLY decision the push path makes before a schedule acts (see D3 of
// `backend/docs/adr/0032-tracker-webhook-intake.md`). It is deliberately a CHEAP, LOCAL evaluation
// against the delivery, never a vendor call: a delivery about an unrelated issue on an unrelated
// board must cost nothing.
//
// It therefore reports a VERDICT rather than a boolean, and the distinction that verdict draws is
// the whole design. A local evaluation has three outcomes, not two: the event satisfies a
// predicate, it violates one, or it cannot ANSWER one because the vendor left the field out of
// this payload shape. Collapsing the third into either of the others is a guess, and the two
// dispatch modes want that guess resolved in OPPOSITE directions:
//
//  - Under `queue` the fired run's `searchIssues` is the authority on what is picked up, so an
//    unconfirmed predicate costs at worst one no-op run completing with "No matching open issues
//    to pick up", the same outcome an idle cadence fire has always had. Firing is right.
//  - Under `per-ticket` there is NO downstream authority: this verdict is the last thing standing
//    between a delivery and a real block plus a real agent run on that ticket. An unconfirmed
//    predicate must not dispatch.
//
// So this module states FACTS and `dispatchAdmits` (orchestration's `issueIntake.logic.ts`, which
// owns the mode vocabulary) picks the disposition. Keeping the two apart is what stopped the
// fail-open rule, correct for the queue it was written for, from silently governing a mode whose
// false positives cost real work.

/** The intake configuration a schedule carries (`PipelineSchedule.issueIntake`). */
type IntakeConfig = Pick<IssueIntakeConfig, 'source' | 'board' | 'predicates'>

/** The predicates an event is judged against, named so a verdict can say which one it was. */
export type IntakePredicateName = 'board' | 'labels' | 'titleFragment' | 'issueType'

/**
 * What a schedule's intake configuration makes of one pushed event.
 *
 *  - `match`: every configured predicate is satisfied by the delivery.
 *  - `miss`: a configured predicate is definitively violated (or the event is for another source
 *    or a closed issue). No mode acts on it.
 *  - `unconfirmed`: nothing is violated, but the delivery does not carry the field(s) named in
 *    `predicates`, so the configuration's question is unanswered. Never conflated with `match`.
 */
export type IntakeMatchVerdict =
  | { outcome: 'match' }
  | { outcome: 'miss'; predicate: IntakePredicateName | 'source' | 'closed' }
  | { outcome: 'unconfirmed'; predicates: IntakePredicateName[] }

/**
 * Judge a pushed issue event against a schedule's intake configuration.
 *
 * Rules, mirroring what `searchIssues` pushes into the vendor query:
 *
 * - **source** must be the schedule's source (always evaluable; a mismatch is a `miss`).
 * - **board** must equal the configured scope for that source. The event carries it in exactly
 *   the shape the configured field does, so no per-vendor knowledge is needed here beyond the
 *   EQUALITY rule, which the source owns (see {@link foldedBoardEquality}) and `provider` supplies.
 *   A `null` board on the event is `unconfirmed`, never a match: a schedule scoped to one project
 *   must not be assumed to cover a delivery that never named one.
 * - **labels**: every configured label must be present, case-insensitively (the vendor queries
 *   are `AND`-semantics; GitHub and Jira both match labels case-insensitively). An event carrying
 *   no labels at all cannot answer a label predicate, so it is `unconfirmed`.
 * - **titleFragment**: a case-insensitive substring of the issue title; an empty title is
 *   `unconfirmed`.
 * - **issueType**: case-insensitive equality. A source with no issue-type notion (Linear) sends
 *   `null`, which is `unconfirmed` rather than a miss, so the predicate does not exclude the whole
 *   source.
 *
 * A `closed` event never qualifies: intake picks up OPEN issues, and acting on a close would spend
 * a run to discover the issue is gone.
 */
export function judgeIssueEventForIntake(
  config: IntakeConfig,
  event: TrackerIssueEvent,
  provider?: Pick<TaskSourceProvider, 'sameBoard'>,
): IntakeMatchVerdict {
  if (event.source !== config.source) return { outcome: 'miss', predicate: 'source' }
  if (event.action === 'closed') return { outcome: 'miss', predicate: 'closed' }

  const unconfirmed: IntakePredicateName[] = []

  const scope = configuredBoard(config)
  if (scope) {
    // Read for EMPTINESS, not `=== null`. The typed null is one way a delivery says nothing; an
    // adapter that omits the field, or a vendor that sent a blank string, say the same thing, and
    // an absent value that fell through to the comparison would read as a definite miss and
    // silently suppress a schedule rather than reporting that it could not be checked.
    if (!event.board?.trim()) unconfirmed.push('board')
    else if (!(provider?.sameBoard ?? foldedBoardEquality)(event.board, scope)) {
      return { outcome: 'miss', predicate: 'board' }
    }
  }

  const labels = config.predicates.labels ?? []
  if (labels.length > 0) {
    if (event.labels.length === 0) unconfirmed.push('labels')
    else {
      const present = new Set(event.labels.map((l) => l.toLowerCase()))
      if (!labels.every((label) => present.has(label.toLowerCase()))) {
        return { outcome: 'miss', predicate: 'labels' }
      }
    }
  }

  const fragment = config.predicates.titleFragment?.trim()
  if (fragment) {
    if (!event.title) unconfirmed.push('titleFragment')
    else if (!event.title.toLowerCase().includes(fragment.toLowerCase())) {
      return { outcome: 'miss', predicate: 'titleFragment' }
    }
  }

  const issueType = config.predicates.issueType?.trim()
  if (issueType) {
    if (!event.issueType) unconfirmed.push('issueType')
    else if (event.issueType.toLowerCase() !== issueType.toLowerCase()) {
      return { outcome: 'miss', predicate: 'issueType' }
    }
  }

  return unconfirmed.length > 0
    ? { outcome: 'unconfirmed', predicates: unconfirmed }
    : { outcome: 'match' }
}

/**
 * The one board scope a configuration carries, whichever leg holds it.
 *
 * Read as "the first leg that is set" rather than by switching on the source: the legs are
 * mutually exclusive by construction (a built-in source fills its own, a registered one fills
 * `boardId`), and switching here would need a per-source map that a deployment-registered source
 * is by definition absent from, the exact shape `boardScopeFor` had to stop using.
 */
function configuredBoard(config: IntakeConfig): string | undefined {
  const board = config.board
  return (
    board.jiraProjectKey?.trim() ||
    board.linearTeamId?.trim() ||
    board.githubRepo?.trim() ||
    board.gitlabProject?.trim() ||
    board.boardId?.trim() ||
    undefined
  )
}

/**
 * The DEFAULT board comparison: case-insensitive, because the two sides are typed by different
 * hands. A Jira project key and a GitHub `owner/repo` are both case-insensitive at the vendor, the
 * operator typed one of them into a form, and folding case leaves a Linear team UUID unaffected.
 *
 * It is a default rather than the rule, because it is WRONG for GitLab, whose project paths the
 * vendor treats as case-SENSITIVE: folding them would admit a delivery from `Acme/web` to a
 * schedule scoped to `acme/web`, two different projects, and under `per-ticket` dispatch that is a
 * real block and a real agent run on a stranger's issue. So a source that knows better declares
 * `TaskSourceProvider.sameBoard` and the caller passes its provider in, the same asymmetry
 * `repoScope` already states about external ids. A source that does not declare one keeps this
 * fold, so no existing behaviour moves.
 */
function foldedBoardEquality(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
