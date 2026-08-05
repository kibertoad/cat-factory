import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  openAttention,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// REQUIREMENTS REVIEW: the first step of the default pipelines, and the platform's main
// human-in-the-loop surface (`backend/docs/requirements-review.md`). The reviewer raises
// severity-tagged findings, the run parks indefinitely by design, and the dedicated window drives
// the iterative loop: answer → incorporate → re-review, which either converges or comes back with
// more.
//
// It had NO e2e coverage because the whole loop runs INLINE through the `ModelProvider` port, not
// the faked agent executor: three separate LLM calls (review, incorporation, re-review) that the
// keyless e2e backend could not make. The prompt-shape-dispatching inline mock is what unlocks it
// (`src/fakeInlineModel.ts`): `reviewFindings` scripts the first pass, the re-review always
// converges, so one park → answer → settle loop is deterministic.
//
// What only the assembled product shows, and what this drives: a parked review is reachable from
// the board card, the window renders the finding, an answer typed into it persists on blur,
// asking to incorporate hands the human back to the board while the driver works, and the
// converged loop releases the run — all live, with no reload.
test.describe('requirements review (the clarification loop)', () => {
  test.slow()

  const FINDING_TITLE = 'Which accounts may reset a password?'

  test('reviewer findings park the run → answer in the window → the loop converges and the run advances', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      // The gate is the subject; the fake agent's default step-0 decision would park the run a
      // second time for an unrelated reason.
      decisionOnSteps: [],
      // One HIGH-severity finding. Severity matters: the default merge preset allows a concern
      // level of `none`, so any finding parks — but a high one also proves the severity survives
      // the round-trip into the window.
      reviewFindings: [
        {
          title: FINDING_TITLE,
          detail:
            'The description does not say whether an admin can trigger a reset for another user.',
          category: 'gap',
          severity: 'high',
        },
      ],
      incorporatedRequirements: [
        '## Goal',
        '',
        'Let a signed-in user reset their own password from an emailed one-time link.',
        '',
        '## Requirements',
        '',
        '- Only the account owner may trigger a reset; admins may not reset on behalf of a user.',
      ].join('\n'),
    })
    const pipeline = await createSimplePipeline(request, workspaceId, [
      'requirements-review',
      'coder',
    ])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the reviewer's findings park the run. The card asks for a human the same way an
    // approval gate does (the park rides `step.approval`), so its attention affordance is the
    // route in — and it routes to the review WINDOW, not the generic step rail, because the kind
    // declares a dedicated result view.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })
    const dialog = page.getByTestId('result-window')
    await openAttention(card, dialog)

    const finding = page.getByTestId('requirements-finding')
    await expect(finding).toHaveAttribute('data-finding-severity', 'high')
    await expect(finding).toContainText(FINDING_TITLE)
    await expect(finding).toHaveAttribute('data-finding-status', 'open')

    // Answer it. There is no save button by design: the textarea persists on BLUR, so the
    // finding flipping to `answered` is what proves the answer actually reached the backend
    // (and it is state the review HOLDS, unlike the in-flight request).
    await finding.getByTestId('requirements-answer').fill('Only the account owner, never an admin.')
    await finding.getByTestId('requirements-answer').blur()
    await expect(finding).toHaveAttribute('data-finding-status', 'answered', {
      timeout: LIVE_TIMEOUT,
    })

    // Ask for the answers to be folded in. Incorporation + the re-review run ASYNCHRONOUSLY in
    // the durable driver, so the window closes and the human is handed back to the board — that
    // hand-off is the product behaviour, not a side effect.
    await page.getByTestId('requirements-incorporate').click()
    await expect(dialog).toBeHidden({ timeout: LIVE_TIMEOUT })

    // Open the inspector's run panel while the cycle is still working (the card is parked, so a
    // body click selects it rather than landing on an action button).
    await card.click()

    // LIVE: the re-review converges (the mock returns no further findings), so the gate step
    // SETTLES rather than re-parking — the one state that distinguishes a closed loop from a
    // review that came back with more findings…
    const reviewStep = page.locator(
      '[data-testid="run-step"][data-step-kind="requirements-review"]',
    )
    await expect(reviewStep).toHaveAttribute('data-step-state', 'done', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    // …and the run it was holding advances through the coder to its merger-less terminal.
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })

  test('a review with nothing to fold in offers Proceed instead, and releases the run', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      reviewFindings: [
        {
          title: 'Should the reset link expire?',
          detail: 'No expiry window is stated.',
          category: 'clarification',
          severity: 'medium',
        },
      ],
    })
    const pipeline = await createSimplePipeline(request, workspaceId, [
      'requirements-review',
      'coder',
    ])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })

    const dialog = page.getByTestId('result-window')
    await openAttention(card, dialog)
    const finding = page.getByTestId('requirements-finding')

    // DISMISS the finding as irrelevant rather than answering it. With every finding dismissed
    // there is nothing to incorporate, so the rail offers the other exit — proceeding on the
    // requirements as they stand. That swap is the window's own rule (`canProceed`), and it is
    // the reason an all-dismissed review does not spend two more model calls folding in nothing.
    await finding.getByTestId('requirements-mode-dismiss').click()
    await expect(finding).toHaveAttribute('data-finding-status', 'dismissed', {
      timeout: LIVE_TIMEOUT,
    })

    const proceed = page.getByTestId('requirements-proceed')
    await expect(proceed).toBeVisible({ timeout: LIVE_TIMEOUT })
    await proceed.click()

    // Proceeding deliberately leaves the window OPEN, so the requirements settling is pushed into
    // the surface the human is still looking at rather than reported by its absence.
    await expect(dialog.getByTestId('requirements-settled')).toBeVisible({ timeout: LIVE_TIMEOUT })

    // LIVE: the gate settles and the run advances to its terminal.
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })
})
