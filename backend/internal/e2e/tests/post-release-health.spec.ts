import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  connectObservability,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The flagship operational scenario the new mocks unlock end-to-end: the post-release-health gate
// escalating to the on-call agent. After a release actually MERGES (the merger auto-merges at high
// confidence → the task is `done`), the `post-release-health` gate watches the team's observability
// signals through a wired provider. On a regression it escalates the `on-call` agent — which
// INVESTIGATES (it reverts nothing) and returns a structured assessment — then raises a
// `release_regression` notification for a human to act on. This spec proves the whole path drives
// the live UI: the task reaches `done`, then the regression notification is pushed into the inbox.
//
// The per-workspace release-health script (`releaseHealth: ['regressed']`), the async on-call kind,
// and the on-call assessment are requested over the fake-profile control channel; `confidence: 1`
// makes the merger auto-merge (the precondition the gate requires — an unmerged PR has nothing to
// watch), and the default step-0 decision is disabled so the run flows straight through.
test.describe('post-release-health gate (on-call escalation)', () => {
  test.slow()

  test('a regressed release escalates on-call and raises a live release_regression notification', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      confidence: 1,
      asyncKinds: ['on-call'],
      releaseHealth: ['regressed'],
      onCallAssessment: {
        culpritConfidence: 0.9,
        recommendation: 'revert',
        rationale: 'e2e: the login 500s correlate with the released change',
        evidence: ['HTTP 500s on /login x12'],
      },
      pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
    })
    // The post-release-health step is observability-gated — connect a provider so the pipeline
    // carrying it can be created (the gate's runtime verdict still comes from the fake provider).
    await connectObservability(request, workspaceId)
    const pipeline = await createSimplePipeline(request, workspaceId, [
      'coder',
      'merger',
      'post-release-health',
    ])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // The merger auto-merges (confidence 1) → the released task reaches `done` live.
    await expect(card).toHaveAttribute('data-status', 'done', { timeout: RUN_TERMINAL_TIMEOUT })

    // LIVE: the gate probed `regressed` → escalated the on-call agent → the investigation raised a
    // `release_regression` notification, pushed into the inbox with no reload.
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="release_regression"]',
    )
    await expect(item).toBeVisible()

    // Dismiss: the bell clears; the released task stays `done` (the on-call agent reverted nothing).
    await item.getByTestId('notification-dismiss').click()
    await expect(bell).toBeHidden({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'done')
  })
})
