import { test, expect } from './fixtures'
import {
  GITHUB_REVIEWED_PR,
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  addServiceFromRepo,
  createTask,
  seedOwnRepo,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// DEEP PR REVIEW: the reviewer's findings, curated by a human, published on the real pull request.
//
// A `review` task runs a read-only reviewer over an EXISTING PR and then stops: the findings are a
// proposal, and what reaches the pull request is what a human selected. That curation step is the
// whole feature, and it exists only in this window — the engine has no opinion about which findings
// matter, and nothing else in the SPA renders a review. Two things can therefore only break here:
// the SELECTION (what the human unchecked must not be posted) and the REPORT (what actually landed
// on the PR, which is the only feedback that the write half worked).
//
// The backend dispositions are covered port-by-port in conformance (`execution-pr-review.ts`). What
// that suite cannot see is the human's side of the loop, so this drives it: dismiss a false
// positive, deselect a finding not worth posting, publish the rest, and read back what posted.
//
// Mocks: the reviewer's structured findings come over the fake-profile channel (`customResult`),
// and the review WRITE goes through the fake GitHub client's `createReview` (see
// `src/fakeGitHub.ts`) — so the run takes the production `resolveRunRepoContext` → `repoFiles` →
// `createReview` path, with no network. The task is created under a repo-LINKED service frame
// because that link is how the engine resolves which repository the PR lives in.
test.describe('deep PR review (curate the findings, publish to the PR)', () => {
  test.slow()

  /** The reviewer's structured output: two anchored findings plus one with no line to anchor to. */
  const reviewerOutput = {
    summary: 'Mostly solid; one correctness concern.',
    slices: [{ title: 'Auth', rationale: 'auth + its test', paths: ['src/auth.ts'] }],
    findings: [
      {
        path: 'src/auth.ts',
        // Inside the faked PR's diff (see GITHUB_REVIEWED_PR), so this one can post INLINE.
        line: 12,
        side: 'RIGHT',
        severity: 'blocker',
        category: 'correctness',
        title: 'Missing null guard',
        detail: 'The token may be undefined here.',
        suggestedFix: 'Guard before dereferencing.',
      },
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

    // A repo-linked service frame: the engine resolves the reviewed PR's repository by walking the
    // task's ancestry to its service frame, so a task under an unlinked frame could never post. The
    // repo is this workspace's own — importing the SHARED one would mount another spec's frame (see
    // `seedOwnRepo`).
    const repo = await seedOwnRepo(request, workspaceId)
    const frame = await addServiceFromRepo(request, workspaceId, repo.githubId)
    const task = await createTask(request, workspaceId, frame.id, 'Review PR #42', {
      taskType: 'review',
      taskTypeFields: { prNumber: GITHUB_REVIEWED_PR.number, prUrl: GITHUB_REVIEWED_PR.url },
    })

    const card = taskCard(page, task.id)
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })
    // `pl_review` is the built-in review pipeline every workspace is seeded with: one read-only
    // pr-reviewer step, which is exactly what a review task runs.
    await startRun(request, workspaceId, task.id, 'pl_review')

    // The reviewer reports and the run PARKS — a review never completes on its own, because the
    // findings are a proposal awaiting a human.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })

    // LIVE: a `pr_review_ready` card lands in the inbox; opening it reveals the review window.
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
    //    feature turns on — an unchecked finding must not reach the pull request.
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
    // Per-finding: the published one is badged, the deselected one is not — the window's own
    // record of what is now on the PR.
    await expect(
      findings.filter({ hasText: 'Missing null guard' }).getByTestId('pr-review-finding-posted'),
    ).toBeVisible()
    await expect(
      findings
        .filter({ hasText: 'Extract the token read' })
        .getByTestId('pr-review-finding-posted'),
    ).toHaveCount(0)

    // A fully successful post SETTLES the review: the window stays open on the completed record
    // and stops offering a disposition, because there is nothing left to decide.
    await expect(window.getByTestId('pr-review-post')).toBeHidden({
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    await expect(window.getByTestId('pr-review-finish')).toBeHidden()
    // And the run reached its terminal: a `done` task renders no card at all (a finished unit of
    // work leaves the board's work list — see the suite README on surfaces the product
    // deliberately un-renders), so the card that was asserted visible above is now gone.
    await expect(card).toHaveCount(0, { timeout: RUN_TERMINAL_TIMEOUT })
  })
})
