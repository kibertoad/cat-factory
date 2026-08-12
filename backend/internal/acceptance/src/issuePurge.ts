// Closing the issues a pass filed as the REPORTER, which nothing else can close.
//
// Spec 04's premise is that a stranger opens an issue, so it is filed with a credential of its own
// and the platform's job is to deliver and close it. An interrupted pass therefore leaves a real open
// issue that belongs to nobody the platform can act for: `reset` has always had to state it as a
// leftover ("close it with the account that filed it"), because it holds only a board key.
//
// **Two questions, and the second is why this is not a loop over the ledgers.** A ledger records the
// issue its pass filed, so the passes being removed name theirs exactly. But an issue whose ledger is
// already gone (a cleared state directory, another machine, an earlier `--all`) is named by nothing,
// and that is the common case precisely because it is the one an operator hits after resetting once
// already. So a second pass over the two repositories DISCOVERS them.
//
// **Discovery is narrow on purpose, and both halves of the test matter.** An issue qualifies when the
// REPORTER credential authored it AND its title is one this suite files. Author alone would close a
// human's issue that happens to be on a fixture repository; title alone would close somebody else's
// issue that quotes the suite's (a maintainer filing "we hit `GET /items silently ignores…` too").
// Neither is sufficient, and the pair is a fingerprint no accident leaves. Anything failing either
// test is REPORTED as skipped rather than passed over silently, because "we saw it and left it" and
// "we never looked" are different facts about a board an operator is about to re-run against.

import { describeThrown } from './operatorText.ts'
import { type IssueApi, type IssueTarget, slug } from './vcsIssues.ts'

/** One issue this purge would close, with what made it a candidate. */
export type PurgeableIssue = {
  target: IssueTarget
  number: number
  title: string
  url: string
  /** Ledger-named, or discovered by author-and-title. Both are printed. */
  found: 'named-by-pass' | 'discovered'
  /** The pass whose ledger named it, when that is how it was found. */
  runId?: string
}

/** An open issue this purge deliberately left alone, and why. */
export type SkippedIssue = {
  target: IssueTarget
  number: number
  title: string
  reason: string
}

export type IssuePurgePlan = {
  close: readonly PurgeableIssue[]
  skipped: readonly SkippedIssue[]
  /**
   * Why discovery could not run, when it could not.
   *
   * A read that FAILED and a repository with no matching issues are opposite facts, and only the
   * first one means an operator still has issues to close by hand. Never inferred from an empty
   * candidate list.
   */
  problems: readonly string[]
}

/** An issue a ledger names, as the pass recorded it. */
export type LedgerIssue = {
  runId: string
  target: IssueTarget
  number: number
  url: string
}

export type IssuePurgeInput = {
  /** The two repositories a pass files against, which bounds discovery. */
  targets: readonly IssueTarget[]
  /** Issues the passes being removed recorded. */
  ledgerIssues: readonly LedgerIssue[]
  /**
   * Titles this suite files, from `instructions.ts`.
   *
   * Passed in rather than imported, so the one place a title is authored stays the one place it is
   * known, and a test can drive discovery without depending on today's issue text.
   */
  knownTitles: readonly string[]
}

/**
 * Which issues a purge would close, from the ledgers plus one read per repository.
 *
 * The viewer login is read ONCE: it is a property of the credential, not of a repository, and asking
 * per repository would be two calls for one answer. An unreadable one disables the author half of the
 * test rather than being guessed, which means discovery reports a problem and closes nothing it
 * discovered; the ledger-named issues are unaffected, because a ledger is evidence of authorship on
 * its own.
 */
export async function planIssuePurge(
  api: IssueApi,
  input: IssuePurgeInput,
): Promise<IssuePurgePlan> {
  const problems: string[] = []
  const close: PurgeableIssue[] = []
  const skipped: SkippedIssue[] = []

  for (const issue of input.ledgerIssues) {
    close.push({
      target: issue.target,
      number: issue.number,
      title: '(from the ledger)',
      url: issue.url,
      found: 'named-by-pass',
      runId: issue.runId,
    })
  }

  let viewer: string | null = null
  try {
    viewer = await api.viewer()
  } catch (error) {
    problems.push(
      `could not read which account the reporter credential belongs to, so no issue was ` +
        `discovered by author (the ones a ledger names are unaffected): ${describeThrown(error)}`,
    )
  }

  const named = new Set(input.ledgerIssues.map((issue) => key(issue.target, issue.number)))
  for (const target of input.targets) {
    let open: Awaited<ReturnType<IssueApi['listOpen']>>
    try {
      open = await api.listOpen(target)
    } catch (error) {
      problems.push(
        `could not list the open issues on ${slug(target)}, so any this pass filed there are ` +
          `still open: ${describeThrown(error)}`,
      )
      continue
    }
    for (const issue of open) {
      if (named.has(key(target, issue.number))) continue
      const titleMatches = input.knownTitles.includes(issue.title)
      // The viewer being unknown is not "not the author": with the author half unavailable the
      // pair test cannot be met at all, so the issue is skipped and said to be skipped.
      const authored = viewer !== null && issue.authorLogin === viewer
      if (titleMatches && authored) {
        close.push({
          target,
          number: issue.number,
          title: issue.title,
          url: issue.url,
          found: 'discovered',
        })
        continue
      }
      skipped.push({
        target,
        number: issue.number,
        title: issue.title,
        reason: skipReason({ titleMatches, authored, viewer, author: issue.authorLogin }),
      })
    }
  }

  return { close, skipped, problems }
}

/** Why one open issue was left alone, in the terms an operator can act on. */
function skipReason(input: {
  titleMatches: boolean
  authored: boolean
  viewer: string | null
  author: string | null
}): string {
  if (input.viewer === null) {
    return `the reporter account could not be read, so authorship could not be confirmed`
  }
  if (!input.titleMatches && !input.authored) {
    return `neither filed by ${input.viewer} nor titled like an issue this suite files`
  }
  if (!input.titleMatches) {
    return `filed by ${input.viewer}, but its title is not one this suite files, so it is somebody's real issue`
  }
  return `titled like an issue this suite files, but filed by ${input.author ?? '(unknown)'} rather than ${input.viewer}`
}

export type IssuePurgeReport = {
  closed: readonly PurgeableIssue[]
  /** Already closed, or gone: both are the state this purge wanted. */
  alreadySettled: readonly PurgeableIssue[]
  failed: readonly { issue: PurgeableIssue; detail: string }[]
  skipped: readonly SkippedIssue[]
  problems: readonly string[]
}

/**
 * Close them, collecting every failure.
 *
 * An issue that is already closed or already gone counts as settled rather than failed: the purge
 * wanted it not-open, a resumed attempt or the platform's own writeback may have got there first, and
 * reporting that as an error would have an operator chasing a state that is correct.
 */
export async function applyIssuePurge(
  api: IssueApi,
  plan: IssuePurgePlan,
): Promise<IssuePurgeReport> {
  const closed: PurgeableIssue[] = []
  const alreadySettled: PurgeableIssue[] = []
  const failed: { issue: PurgeableIssue; detail: string }[] = []

  for (const issue of plan.close) {
    try {
      const state = await api.read(issue.target, issue.number)
      // Null is "the provider no longer has it" (deleted, transferred), which is settled.
      if (state === null || state.closed) {
        alreadySettled.push(issue)
        continue
      }
      await api.close(issue.target, issue.number)
      closed.push(issue)
    } catch (error) {
      failed.push({ issue, detail: describeThrown(error) })
    }
  }

  return { closed, alreadySettled, failed, skipped: plan.skipped, problems: plan.problems }
}

export function issuePurgeSucceeded(report: IssuePurgeReport): boolean {
  return report.failed.length === 0 && report.problems.length === 0
}

function key(target: IssueTarget, number: number): string {
  return `${slug(target)}#${number}`
}
