import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, RUN_TERMINAL_TIMEOUT, setFakeProfile, startBootstrap } from './helpers'

// The repo-bootstrap flow — the largest live-pushed flow the suite didn't cover. A "bootstrap
// repo" run materialises a PROVISIONAL service frame on the board immediately and streams its
// progress (clone → adapt → push) as subtask counts, then either finishes or faults onto the
// shared `<AgentFailureCard>` (banner + retry) — the SAME failure surface a task run uses.
//
// The fake bootstrapper's scripted lifecycle (a progress script, or a poll-time failure) is
// requested PER WORKSPACE via the fake-profile control channel, so neither test affects any
// other spec. We trigger over REST (the same endpoint the launch modal posts) and assert only
// on the live board reaction, per the suite's seed/trigger-over-REST-then-assert-live contract.
test.describe('bootstrap repo (live board)', () => {
  test.slow()

  test('a bootstrap run shows the provisional frame + live progress badge, then clears it', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // Several running polls give the "bootstrapping…" badge a comfortable live window.
    await setFakeProfile(request, workspaceId, {
      bootstrapProgress: [
        { completed: 1, inProgress: 1, total: 4 },
        { completed: 2, inProgress: 1, total: 4 },
        { completed: 3, inProgress: 1, total: 4 },
      ],
    })
    const job = await startBootstrap(request, workspaceId, 'demo-service')
    expect(job.blockId).toBeTruthy()
    const frame = page.locator(`[data-block-id="${job.blockId}"]`)

    // LIVE: the provisional service frame appears on the board with its bootstrap progress
    // badge, pushed over the WebSocket with no reload.
    await expect(frame).toBeVisible({ timeout: LIVE_TIMEOUT })
    const progress = frame.getByTestId('bootstrap-progress')
    await expect(progress).toBeVisible({ timeout: LIVE_TIMEOUT })

    // The run finishes → the bootstrapping badge clears (the frame is no longer in-progress).
    await expect(progress).toBeHidden({ timeout: RUN_TERMINAL_TIMEOUT })
  })

  test('a failed bootstrap surfaces the shared failure banner + retry on the frame', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      bootstrapFailWith: 'bootstrap agent could not push the repository',
    })
    const job = await startBootstrap(request, workspaceId, 'doomed-service')
    expect(job.blockId).toBeTruthy()
    const frame = page.locator(`[data-block-id="${job.blockId}"]`)
    await expect(frame).toBeVisible({ timeout: LIVE_TIMEOUT })

    // LIVE: the run faults → the shared failure banner + retry render on the frame, tagged as a
    // `bootstrap` run (the SAME component a failed task execution shows).
    const banner = frame.getByTestId('agent-failure-banner')
    await expect(banner).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })
    await expect(banner).toHaveAttribute('data-run-kind', 'bootstrap')
    await expect(banner.getByTestId('agent-failure-retry')).toBeEnabled()
  })
})
