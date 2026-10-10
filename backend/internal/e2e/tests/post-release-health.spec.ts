import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  connectObservability,
  createSimplePipeline,
  setFakeProfile,
  startRun,
} from './helpers'

// The flagship operational scenario the new mocks unlock end-to-end: the post-release-health gate
// escalating to the on-call agent. After a release actually MERGES (the merger auto-merges at high
// confidence → the task is `done`), the `post-release-health` gate watches the team's observability
// signals through a wired provider. On a regression it escalates the `on-call` agent — which
// INVESTIGATES (it reverts nothing) and returns a structured assessment — then raises a
// `release_regression` notification for a human to act on.
//
// We assert the whole path through the LIVE `release_regression` notification, NOT the task card's
// status. That is deliberate and it is the reparent-robust signal: the gate's `probe` escalates
// on-call ONLY once `block.status === 'done'` (there is nothing to watch before the release ships),
// so the notification landing in the inbox is itself proof that the merger auto-merged, the gate
// probed `regressed`, and the investigation ran. The task card is intentionally not asserted on
// because a real auto-merge RELOCATES the task: `task_login` carries a `moduleName`, so
// `applyModuleAssignment` reparents it out of the service frame and into its `mod_sessions` module
// as part of finalising the merge — the top-level card legitimately moves, which is orthogonal to
// what this scenario verifies.
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

    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the merger auto-merges (the released task reaches `done`) → the gate probes `regressed`
    // → escalates the on-call agent → the investigation raises a `release_regression` notification,
    // pushed into the inbox with no reload. Its arrival is proof of the whole merge → done → gate →
    // regression path, since the gate escalates only once the release has actually merged. The bell
    // waits the full run-terminal budget because it appears only after the async on-call step lands.
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="release_regression"]',
    )
    await expect(item).toBeVisible()

    // Dismiss: the bell clears (the on-call agent reverted nothing — a human acts out-of-band).
    await item.getByTestId('notification-dismiss').click()
    await expect(bell).toBeHidden({ timeout: LIVE_TIMEOUT })
  })
})
