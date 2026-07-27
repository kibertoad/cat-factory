import type { IssueIntakeConfig, TrackerIssueEvent } from '@cat-factory/kernel'

// Does a pushed tracker issue event qualify for a given schedule's intake configuration?
//
// This is the ONLY new decision the push path makes. Everything after it — dedup, import,
// replace-link, the pickup mark, the block seeding, the pipeline run — is the existing
// `BugIntakeService` + engine path, reached by FIRING the schedule (see D3 of
// `docs/initiatives/tracker-webhook-intake.md`). The predicate exists purely so a delivery does
// not fire every intake schedule in the workspace: an unrelated issue on an unrelated board must
// cost nothing.
//
// It is deliberately a CHEAP, LOCAL approximation of the vendor query `searchIssues` runs, not a
// re-implementation of it. The authority on what gets picked up stays the vendor search inside the
// fired run — so a predicate this cannot evaluate (the board scope, "open", oldest-first ordering)
// is simply not evaluated here. The consequences of the two directions are asymmetric and that
// asymmetry is the whole design:
//
//  - A FALSE POSITIVE (we fire, the search finds nothing new) costs one no-op run that completes
//    immediately with "No matching open issues to pick up." — the same outcome an idle cadence
//    fire has always had.
//  - A FALSE NEGATIVE (we don't fire) costs INTAKE LATENCY, silently, until the next cadence pass.
//
// So every predicate below fails OPEN: an event that does not carry the field being matched is
// treated as a match rather than a miss.

/** The intake configuration a schedule carries (`PipelineSchedule.issueIntake`). */
type IntakeConfig = Pick<IssueIntakeConfig, 'source' | 'predicates'>

/**
 * Whether a pushed issue event plausibly matches a schedule's intake predicates.
 *
 * Matching rules, mirroring what `searchIssues` pushes into the vendor query:
 *
 * - **source** must be the schedule's source (an exact requirement, always evaluable).
 * - **labels** — every configured label must be present on the issue, case-insensitively (the
 *   vendor queries are `AND`-semantics; GitHub and Jira both match labels case-insensitively).
 * - **titleFragment** — case-insensitive substring of the issue title.
 * - **issueType** — case-insensitive equality; a source with no issue-type notion (Linear) sends
 *   `null`, which matches by the fail-open rule above rather than excluding the whole source.
 *
 * A `closed` event never qualifies: intake picks up OPEN issues, and firing on a close would spend
 * a run to discover the issue is gone.
 */
export function issueEventMatchesIntake(config: IntakeConfig, event: TrackerIssueEvent): boolean {
  if (event.source !== config.source) return false
  if (event.action === 'closed') return false

  const predicates = config.predicates
  const labels = predicates.labels ?? []
  if (labels.length > 0) {
    // An event with NO labels array at all is indistinguishable from one whose labels the vendor
    // omitted from this payload shape, so an empty set fails open — the fired run's vendor search
    // is the authority either way.
    if (event.labels.length > 0) {
      const present = new Set(event.labels.map((l) => l.toLowerCase()))
      if (!labels.every((label) => present.has(label.toLowerCase()))) return false
    }
  }

  const fragment = predicates.titleFragment?.trim()
  if (fragment && event.title && !event.title.toLowerCase().includes(fragment.toLowerCase())) {
    return false
  }

  const issueType = predicates.issueType?.trim()
  if (issueType && event.issueType && event.issueType.toLowerCase() !== issueType.toLowerCase()) {
    return false
  }

  return true
}
