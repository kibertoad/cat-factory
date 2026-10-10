// Scenario 04's two halves that are not a pipeline run: getting the reporter's issue filed exactly once
// across attempts, and grading what the platform did to it afterwards.
//
// It sits beside the kit's `resume.ts` and `evidence.ts` on purpose, and copies their rules rather than
// inventing its own:
//
//   - **Filing is recorded the moment it happens** (the kit's `resume.ts` rule), because an issue is the one
//     thing this suite creates that no `/api/v1` read can hand back. A crash between the POST and
//     the ledger write leaves an open issue on somebody's repository that the next attempt cannot
//     find, so it files a second one and delivers that: two pull requests, and the first issue left
//     open forever with the platform's own comments on it.
//   - **What is asserted is what the PLATFORM did**, not what an agent wrote (the kit's `evidence.ts` rule).
//     The evidence here is the issue's own state and comment list, read from the provider, which is
//     as far from agent prose as this suite gets: the reporter's credential and the platform's are
//     different credentials, so nothing the run says about itself can produce it.

import type { PrReportRunProvider } from '@cat-factory/sdk'
import {
  type Check,
  check,
  describeThrown,
  type Journal,
  waitFor,
} from '@cat-factory/acceptance-kit'
import type { IssueApi, IssueState, IssueTarget } from './vcsIssues.ts'
import { slug } from './vcsIssues.ts'
import type { IssueRecord } from './world.ts'

export type FileIssueOptions = {
  api: IssueApi
  provider: PrReportRunProvider
  target: IssueTarget
  issue: { title: string; body: string }
  /** What a previous attempt at this run id recorded, if anything. */
  existing: IssueRecord | null
  journal: Journal
  /** Persist the record. Called the moment the issue exists, and expected to write through. */
  onRecord: (record: IssueRecord) => void
}

/**
 * File the reporter's issue, or adopt the one a previous attempt already filed.
 *
 * Three states a resumed pass can find, and the middle one is why this re-READS rather than trusting
 * the ledger:
 *
 *   1. **Nothing recorded.** File it, record it, return it.
 *   2. **An issue recorded that the provider still has.** Adopt it. This is the case the whole
 *      function exists for: the issue is what the task's ticket link points at, so re-filing would
 *      strand the delivery this pass may already have paid for.
 *   3. **An issue recorded that the provider no longer has** (deleted, or transferred away). File
 *      again, saying so, since a `ticket` naming a missing issue refuses the task creation outright.
 *
 * A record from a DIFFERENT provider or repository is treated as case 3 as well, and says which:
 * a `.env` re-pointed mid-pass is the same situation as a deleted issue, and silently reading a
 * GitHub issue number against another host is how a pass ends up asserting about a stranger's issue.
 */
export async function fileReporterIssue(options: FileIssueOptions): Promise<IssueRecord> {
  const { api, provider, target, existing, journal, onRecord } = options
  const mismatch = existing ? describeMismatch(existing, provider, target) : null
  if (existing && !mismatch) {
    const state = await api.read(target, existing.number)
    if (state) {
      journal.say(
        'milestone',
        `adopting the issue a previous attempt filed: ${existing.url} (state=${state.state}, ` +
          `${state.comments.length} comment(s))`,
      )
      return existing
    }
    // Printed, not merely recorded. Re-filing is the most surprising thing this function does, and
    // it is the branch whose CAUSE is somebody else's action minutes ago (a deleted issue, a
    // re-pointed `.env`). An operator watching a resume needs to see it while they can still
    // connect it to what they did, not find it in the journal afterwards.
    journal.say(
      'milestone',
      `the ledger names ${existing.url} but the provider no longer has it; filing again`,
    )
  } else if (existing && mismatch) {
    journal.say('milestone', `${mismatch}; filing a fresh issue`)
  }

  const filed = await api.file(target, options.issue)
  const record: IssueRecord = {
    provider,
    owner: target.owner,
    repo: target.repo,
    number: filed.number,
    url: filed.url,
  }
  // Recorded BEFORE anything else happens to it, for the reason in this file's header.
  onRecord(record)
  journal.say('milestone', `filed ${slug(target)}#${filed.number} as the reporter: ${filed.url}`)
  return record
}

function describeMismatch(
  existing: IssueRecord,
  provider: PrReportRunProvider,
  target: IssueTarget,
): string | null {
  if (existing.provider !== provider) {
    return (
      `the ledger's issue was filed on '${existing.provider}' but this workspace is connected to ` +
      `'${provider}'`
    )
  }
  if (existing.owner !== target.owner || existing.repo !== target.repo) {
    return (
      `the ledger's issue is on ${existing.owner}/${existing.repo} but this pass targets ` +
      `${slug(target)}`
    )
  }
  return null
}

/**
 * An issue that stopped existing while the pass was watching it.
 *
 * Its own type because it is the ONE outcome of this wait that must not be graded: every other way
 * the wait can end hands the issue's last observed state to {@link checkIssueWriteback}, which says
 * precisely what the platform did or did not do, and there is no such state for an issue that a
 * person deleted out from under the pass.
 */
export class IssueGoneError extends Error {}

/**
 * Wait until the platform has finished with the issue, then hand back what it last saw.
 *
 * A budget of its own rather than the run budget, and a short one, because this is not a pipeline
 * step. The writeback fires from the merge hook as a best-effort side effect, so by the time the run
 * reports `done` it has usually already landed; what is being waited out is a provider round trip
 * and, at worst, one retry. A long budget here would only make a genuinely broken writeback take an
 * extra half hour to report.
 *
 * **It waits for everything {@link checkIssueWriteback} asserts, not just the close**, and that is
 * the whole point of the pairing. A provider can close an issue on its own the moment a merged pull
 * request's text carries a closing keyword, and the merge-edge comment is a separate best-effort
 * call that can land a beat later or after one retry. A wait that returned on `closed` alone would
 * therefore hand the grader a half-written issue and fail a writeback that was working, which is
 * the opposite of the determinism the pair exists for.
 *
 * **Expiry RETURNS rather than throws**, which is where this departs from the kit's `deadline.ts` rule that
 * a wait states what it last saw. The rule is honoured, by the grader: it renders each claim with
 * its own detail (`state=open, 1 comment(s)`, `1 distinct comment(s) name <pr>`), which is strictly
 * more than the one-line last observation an expiry could carry. Giving up is not a verdict here,
 * it is the end of the patience, and the verdict belongs to the checks.
 */
export async function waitForIssueSettled(options: {
  api: IssueApi
  target: IssueTarget
  number: number
  journal: Journal
  budgetMs: number
  /** The pull request the delivery run opened, which the comment claim is read against. */
  pullRequestUrl: string | null
  /** Injected so `test/issueIntake.test.ts` can drive several polls without sleeping through them. */
  intervalMs?: number
}): Promise<IssueState> {
  const { api, target, number, journal, budgetMs, pullRequestUrl } = options
  let last: IssueState | null = null
  try {
    return await waitFor({
      label: `the platform to close ${slug(target)}#${number} through its tracker writeback`,
      budgetMs,
      intervalMs: options.intervalMs ?? 10_000,
      probe: async () => {
        const observed = await observeIssue(api, target, number)
        if (!observed.state) return { done: false, state: observed.description }
        last = observed.state
        return isSettled(last, pullRequestUrl)
          ? { done: true, value: last }
          : { done: false, state: observed.description }
      },
      onProgress: (state, elapsedMs) => {
        journal.say('observation', `[${Math.round(elapsedMs / 1000)}s] issue #${number} ${state}`)
      },
    })
  } catch (error) {
    if (error instanceof IssueGoneError || !last) throw error
    journal.say(
      'observation',
      `the writeback budget is spent and ${slug(target)}#${number} has not settled; grading what ` +
        `it shows now`,
    )
    return last
  }
}

/**
 * One poll: the issue's state, or why this poll could not read it.
 *
 * A provider that answers 502 or rate-limits one call in a three-minute poll is not evidence about
 * the writeback, so it costs the observation and not the pass. It cannot be swallowed forever
 * either: an unreadable poll is reported like any other observation, so a credential revoked
 * mid-pass spends the budget and then reads back as exactly what it was on every line.
 *
 * A 404 is the one answer that is NOT retried. Nothing the platform does deletes an issue, so it is
 * a person, and polling on would report it as a writeback that never fired.
 */
async function observeIssue(
  api: IssueApi,
  target: IssueTarget,
  number: number,
): Promise<{ state: IssueState | null; description: string }> {
  let state: IssueState | null
  try {
    state = await api.read(target, number)
  } catch (error) {
    return { state: null, description: `could not be read: ${describeThrown(error)}` }
  }
  if (!state) {
    throw new IssueGoneError(
      `${slug(target)}#${number} no longer exists on the provider, so what the platform did ` +
        `to it can no longer be read. It was deleted or transferred while the pass was running.`,
    )
  }
  return { state, description: `${state.state}, ${state.comments.length} comment(s)` }
}

/**
 * Whether there is anything left to wait for.
 *
 * With no pull request recorded the comment claim can never come true, so waiting on it would burn
 * the whole budget to reach a verdict the ledger already determined. That gap is the grader's to
 * report, and it says so in those words rather than as a failed writeback.
 */
function isSettled(state: IssueState, pullRequestUrl: string | null): boolean {
  if (!pullRequestUrl) return state.closed
  return checkIssueWriteback({ state, pullRequestUrl }).every((claim) => claim.ok)
}

/**
 * The claims about what the platform did to the reporter's issue.
 *
 * Two of them, and the pair is the point.
 *
 * **Closed** is what the user of this product cares about: the issue somebody filed is shut, without
 * anyone going and shutting it.
 *
 * **Two distinct comments naming the run's pull request** is what makes the first claim MEAN the
 * writeback did it. A provider closes an issue by itself when a merged pull request's body or a
 * commit message carries a closing keyword (`Closes #12`), and that path posts no comment at all, so
 * a closed issue on its own does not distinguish "the platform wrote back" from "the host noticed a
 * keyword in text an agent wrote". The writeback posts at BOTH edges of the pull request's life,
 * once when it opens and once when it merges, which is a fingerprint no keyword can leave. Both
 * edges are on by default (`DEFAULT_TRACKER_WRITEBACK`) and the `tracker-writeback` prerequisite
 * refuses a pass whose workspace has turned either off, so the count is deterministic rather than
 * hopeful.
 *
 * Distinctness is over the comment BODY rather than over any wording this suite knows: the two
 * comments differ because they say different things, and asserting a phrase would make a copy edit
 * in `IssueWritebackService` look like a broken writeback.
 */
export function checkIssueWriteback(input: {
  state: IssueState
  /** The pull request the delivery run opened, as the platform recorded it. */
  pullRequestUrl: string | null
}): Check[] {
  const { state, pullRequestUrl } = input
  const naming = pullRequestUrl
    ? [...new Set(state.comments.filter((body) => body.includes(pullRequestUrl)))]
    : []
  return [
    check(
      'the platform closed the reporter’s issue',
      state.closed,
      `state=${state.state}, ${state.comments.length} comment(s)`,
    ),
    check(
      'the platform wrote to the issue at both edges of its pull request’s life',
      naming.length >= 2,
      pullRequestUrl
        ? `${naming.length} distinct comment(s) name ${pullRequestUrl}` +
            (naming.length > 0 ? `: ${naming.map(firstLine).join(' | ')}` : '')
        : 'the ledger recorded no pull request for the delivery run, so no comment can be tied to ' +
            'it; that is a gap in what was observed rather than evidence the writeback failed',
    ),
  ]
}

/** A comment's first line, which is where both writeback bodies say what they are. */
function firstLine(body: string): string {
  return (body.split('\n')[0] ?? '').trim().slice(0, 120)
}
