import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  GITHUB_REVIEWED_PR,
  GITHUB_TRANSIENT_POST_FAILURE,
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  addServiceFromRepo,
  createTask,
  readReviewAttempts,
  seedOwnRepo,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// DEEP PR REVIEW: the reviewer's findings, curated by a human, published on the real pull request.
//
// A `review` task runs a read-only reviewer over an EXISTING PR and then stops: the findings are a
// proposal, and what reaches the pull request is what a human selected. That curation step is the
// whole feature, and it exists only in this window: the engine has no opinion about which findings
// matter, and nothing else in the SPA renders a review. Two things can therefore only break here,
// the SELECTION (what the human unchecked must not be posted) and the REPORT (what actually landed
// on the PR, which is the only feedback that the write half worked).
//
// The backend dispositions are covered port-by-port in conformance (`execution-pr-review.ts`). What
// that suite cannot see is the human's side of the loop, so this drives it twice: once for a clean
// publish, and once for a PARTIAL one, where a comment is refused and the run is handed back
// instead of finishing.
//
// Mocks: the reviewer's structured findings come over the fake-profile channel (`customResult`),
// and the review WRITE goes through the fake GitHub client's `createReview` (see
// `src/fakeGitHub.ts`), so the run takes the production `resolveRunRepoContext` → `repoFiles` →
// `createReview` path, with no network. The task is created under a repo-LINKED service frame,
// because that link is how the engine resolves which repository the PR lives in, and it carries
// only the PR NUMBER: the fake answers for that one PR, so creation VALIDATES the reference against
// the provider and canonicalises the stored URL from it, exactly as it does in production.
test.describe('deep PR review (curate the findings, publish to the PR)', () => {
  test.slow()

  /** A finding anchored inside the faked PR's diff, so the engine can post it INLINE. */
  const blocker = {
    path: 'src/auth.ts',
    line: 12,
    side: 'RIGHT',
    severity: 'blocker',
    category: 'correctness',
    title: 'Missing null guard',
    detail: 'The token may be undefined here.',
    suggestedFix: 'Guard before dereferencing.',
  }

  /** The reviewer's structured output: two anchored findings plus one with no line to anchor to. */
  const reviewerOutput = {
    summary: 'Mostly solid; one correctness concern.',
    slices: [{ title: 'Auth', rationale: 'auth + its test', paths: ['src/auth.ts'] }],
    findings: [
      blocker,
      {
        path: 'src/auth.ts',
        line: 11,
        side: 'RIGHT',
        severity: 'medium',
        category: 'maintainability',
        title: 'Extract the token read',
        detail: 'This block now does two things.',
      },
      {
        path: 'README.md',
        severity: 'nit',
        category: 'style',
        title: 'Typo in the readme',
        detail: 'teh → the',
      },
    ],
  }

  /**
   * Two findings, both anchored in the diff, the second on the anchor the fake refuses ONCE. Both
   * are selected by default, so a single attempt carries both and exactly one of them fails.
   */
  const partialPostReviewerOutput = {
    summary: 'Two concerns, one of them in the session bootstrap.',
    slices: [
      { title: 'Auth', rationale: 'auth + session', paths: ['src/auth.ts', 'src/session.ts'] },
    ],
    findings: [
      blocker,
      {
        path: GITHUB_TRANSIENT_POST_FAILURE.path,
        line: GITHUB_TRANSIENT_POST_FAILURE.line,
        side: 'RIGHT',
        severity: 'medium',
        category: 'correctness',
        title: 'Audit call is not awaited',
        detail: 'The session may be returned before the audit lands.',
      },
    ],
  }

  /**
   * Seed a `review` task under a repo-LINKED service frame and start its run.
   *
   * The engine resolves the reviewed PR's repository by walking the task's ancestry to its service
   * frame, so a task under an unlinked frame could never post. The repo is this workspace's own:
   * importing the SHARED one would mount another spec's frame (see `seedOwnRepo`). `pl_review` is
   * the built-in review pipeline every workspace is seeded with, one read-only pr-reviewer step,
   * which is exactly what a review task runs.
   */
  async function startReviewRun(
    request: APIRequestContext,
    workspaceId: string,
    title: string,
  ): Promise<{ id: string }> {
    const repo = await seedOwnRepo(request, workspaceId)
    const frame = await addServiceFromRepo(request, workspaceId, repo.githubId)
    const task = await createTask(request, workspaceId, frame.id, title, {
      taskType: 'review',
      taskTypeFields: { prNumber: GITHUB_REVIEWED_PR.number },
    })
    await startRun(request, workspaceId, task.id, 'pl_review')
    return task
  }

  /** Open the parked review from the inbox card the run raised (`pr_review_ready`). */
  async function openReviewWindow(page: Page): Promise<Locator> {
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="pr_review_ready"]',
    )
    await expect(item).toBeVisible({ timeout: LIVE_TIMEOUT })
    await item.locator('button').first().click()
    const window = page.getByTestId('pr-review-window')
    await expect(window).toBeVisible()
    return window
  }

  test('reviewer parks on its findings → dismiss, deselect, post → the report says what landed', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      customResult: reviewerOutput,
    })

    const task = await startReviewRun(request, workspaceId, 'Review PR #42')
    const card = taskCard(page, task.id)
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })

    // The reviewer reports and the run PARKS: a review never completes on its own, because the
    // findings are a proposal awaiting a human.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })

    // LIVE: a `pr_review_ready` card lands in the inbox; opening it reveals the review window.
    const window = await openReviewWindow(page)
    const findings = window.getByTestId('pr-review-finding')
    await expect(findings).toHaveCount(3)
    // Severity-ordered (blocker → medium → nit), which is the order a reviewer reads them in.
    await expect(findings.nth(0)).toContainText('Missing null guard')
    await expect(findings.nth(1)).toContainText('Extract the token read')
    await expect(findings.nth(2)).toContainText('Typo in the readme')
    // Everything starts selected: the default is "publish the review as written".
    const selectedCount = window.getByTestId('pr-review-selected-count')
    await expect(selectedCount).toContainText('3')

    // 1) DISMISS the nit as a false positive. Dismissal is curation, not a resolution: the finding
    //    leaves the review and the run stays parked, so the human keeps working.
    const nit = findings.filter({ hasText: 'Typo in the readme' })
    await nit.getByTestId('pr-review-finding-dismiss').click()
    await expect(findings).toHaveCount(2, { timeout: LIVE_TIMEOUT })
    await expect(window.getByTestId('pr-review-post')).toBeVisible()

    // 2) DESELECT the medium: real, but not worth a comment on this PR. This is the assertion the
    //    feature turns on, that an unchecked finding must not reach the pull request.
    const medium = findings.filter({ hasText: 'Extract the token read' })
    await medium.getByTestId('pr-review-finding-toggle').click()
    await expect(selectedCount).toContainText('1')

    // 3) POST the remaining blocker to the PR.
    await window.getByTestId('pr-review-post').click()

    // LIVE: the engine posts through the (faked) GitHub review write and the window renders the
    // report it derived from the per-comment outcomes: ONE comment attempted, one posted. The
    // count is what proves the deselected finding was excluded rather than silently included.
    const report = window.getByTestId('pr-review-post-report')
    await expect(report).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })
    // "1 of 1", both halves: ONE comment attempted (the deselected finding was excluded rather
    // than sent) and ONE posted (it landed rather than failing). A looser match would pass on
    // "0 of 1", which is the same report a broken write produces.
    await expect(window.getByTestId('pr-review-post-count')).toHaveText('1 of 1 comments posted')
    await expect(report.getByTestId('pr-review-post-failures')).toHaveCount(0)
    // Per-finding: the published one is badged, the deselected one is not, which is the window's
    // own record of what is on the PR now.
    await expect(
      findings.filter({ hasText: 'Missing null guard' }).getByTestId('pr-review-finding-posted'),
    ).toBeVisible()
    await expect(
      findings
        .filter({ hasText: 'Extract the token read' })
        .getByTestId('pr-review-finding-posted'),
    ).toHaveCount(0)

    // The WIRE, which the report structurally cannot show: exactly one write left the backend,
    // carrying exactly the selected finding's anchor. The report is derived from the outcomes the
    // provider returned for what it was sent, so "1 of 1" would read the same for a write that also
    // carried the finding the human unchecked.
    const attempts = await readReviewAttempts(request, workspaceId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.number).toBe(GITHUB_REVIEWED_PR.number)
    expect(attempts[0]?.comments).toEqual([{ path: 'src/auth.ts', line: 12 }])

    // A fully successful post SETTLES the review: the window stays open on the completed record
    // and stops offering a disposition, because there is nothing left to decide.
    await expect(window.getByTestId('pr-review-post')).toBeHidden({
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    await expect(window.getByTestId('pr-review-finish')).toBeHidden()
    // And the run reached its terminal: a `done` task renders no card at all (a finished unit of
    // work leaves the board's work list, see the suite README on surfaces the product deliberately
    // un-renders), so the card that was asserted visible above is now gone.
    await expect(card).toHaveCount(0, { timeout: RUN_TERMINAL_TIMEOUT })
  })

  // The PARTIAL post: one comment lands and one is refused. That is a disposition of its own, and
  // the opposite of the happy path's, so the human's half of it earns its own coverage: the run is
  // handed BACK (re-parked carrying the report) rather than finished, the window names which finding
  // did not land and why, and a retry sends ONLY that one. The last part is why this test reads the
  // wire. "1 of 1 comments posted" on the retry is exactly what a retry that re-sent the
  // already-published comment would report too, so nothing a human can see would tell them their
  // pull request just collected a duplicate.
  test('a comment is refused → the run is handed back, and the retry posts only what is missing', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      customResult: partialPostReviewerOutput,
    })

    const task = await startReviewRun(request, workspaceId, 'Review PR #42 (partial post)')
    const card = taskCard(page, task.id)
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })

    const window = await openReviewWindow(page)
    const findings = window.getByTestId('pr-review-finding')
    await expect(findings).toHaveCount(2)
    await expect(window.getByTestId('pr-review-selected-count')).toContainText('2')

    // Post both. The fake refuses the session-bootstrap anchor once, as a transient upstream error.
    await window.getByTestId('pr-review-post').click()

    // LIVE: the report arrives and says what happened on both axes. "1 of 2" is the count a human
    // acts on; the failure list is what makes it actionable, naming the anchor and the reason rather
    // than leaving a number that came up short.
    const report = window.getByTestId('pr-review-post-report')
    await expect(report).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })
    await expect(window.getByTestId('pr-review-post-count')).toHaveText('1 of 2 comments posted')
    const failures = report.getByTestId('pr-review-post-failures').locator('li')
    await expect(failures).toHaveCount(1)
    await expect(failures.first()).toContainText(
      `${GITHUB_TRANSIENT_POST_FAILURE.path}:${GITHUB_TRANSIENT_POST_FAILURE.line}`,
    )
    await expect(failures.first()).toContainText('Transient upstream error')

    // Per-finding: the one that landed is badged and the refused one is not. Those two badges are
    // the difference between "the review is on the PR" and "half of it is".
    const landed = findings.filter({ hasText: 'Missing null guard' })
    const refused = findings.filter({ hasText: 'Audit call is not awaited' })
    await expect(landed.getByTestId('pr-review-finding-posted')).toBeVisible()
    await expect(refused.getByTestId('pr-review-finding-posted')).toHaveCount(0)

    // HANDED BACK, not finished: the run is re-parked on the same decision, so the dispositions are
    // on offer again and the human can retry the posting alone. The happy path asserts the exact
    // opposite of both, which is what makes the pair meaningful.
    await expect(window.getByTestId('pr-review-post')).toBeVisible()
    await expect(window.getByTestId('pr-review-finish')).toBeVisible()
    await expect(card).toHaveAttribute('data-status', 'blocked')

    // RETRY: the same affordance, which now reads as a retry because a report exists.
    await window.getByTestId('pr-review-post').click()

    // The retry attempted ONE comment, the one that failed, and it landed, so the review settles:
    // both findings badged, no failures left, no disposition left to make, and the task is done.
    await expect(window.getByTestId('pr-review-post-count')).toHaveText('1 of 1 comments posted', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    await expect(report.getByTestId('pr-review-post-failures')).toHaveCount(0)
    await expect(refused.getByTestId('pr-review-finding-posted')).toBeVisible()
    await expect(window.getByTestId('pr-review-post')).toBeHidden({
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    await expect(card).toHaveCount(0, { timeout: RUN_TERMINAL_TIMEOUT })

    // AT MOST ONCE, on the wire: two attempts, and the second carried only the anchor that had not
    // landed, with no summary comment (it posted on the first attempt and is suppressed after).
    // A retry that re-sent everything would leave a duplicate comment and a duplicate summary on
    // the pull request while reporting itself as a clean success.
    const attempts = await readReviewAttempts(request, workspaceId)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.comments.map((c) => c.path).sort()).toEqual([
      'src/auth.ts',
      GITHUB_TRANSIENT_POST_FAILURE.path,
    ])
    expect(attempts[0]?.hasBody).toBe(true)
    expect(attempts[1]?.comments).toEqual([
      { path: GITHUB_TRANSIENT_POST_FAILURE.path, line: GITHUB_TRANSIENT_POST_FAILURE.line },
    ])
    expect(attempts[1]?.hasBody).toBe(false)
  })
})
