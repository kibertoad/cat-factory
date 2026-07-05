import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSchedule,
  createSimplePipeline,
  runScheduleNow,
  setFakeProfile,
  taskCard,
} from './helpers'

// The recurring-pipeline round-trip is the one assembled-product surface no other spec covers:
// creating a schedule materialises a REUSED on-board task that must appear live (the backend's
// `block-added` push, no reload), and firing it via run-now must drive THAT block to a terminal
// status over the WebSocket. Every other spec drives a manually-started run against a pre-seeded
// block; this proves the schedule-created block is both pushed onto the board and advanced live.
// The bug-triage step MECHANICS (intake / investigate / repro / merge) are asserted deterministically
// in the cross-runtime conformance suite — here we only assert the live UI round-trip.
test.describe('recurring pipeline run', () => {
  test.slow()

  test('creating a schedule shows the reused block live, and run-now drives it to terminal', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // No decision park: the run should drive straight through to terminal (the default backend
    // parks step 0, which this spec is not about).
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [] })
    const pipeline = await createSimplePipeline(request, workspaceId)

    // Attach the schedule to the seeded `blk_auth` service frame. Its reused task block is a
    // brand-new block NOT in the initial snapshot — it must arrive via the live `block-added`
    // push (a debounced board refresh), so its card appears with no reload.
    const schedule = await createSchedule(request, workspaceId, 'blk_auth', pipeline.id)
    const card = taskCard(page, schedule.blockId)
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'planned', { timeout: LIVE_TIMEOUT })

    // Fire it now: the reused block's run advances over the same WebSocket transport a manual
    // run uses, flipping the card to a terminal status with no reload.
    await runScheduleNow(request, workspaceId, schedule.id)
    await expect
      .poll(async () => await card.getAttribute('data-status'), { timeout: RUN_TERMINAL_TIMEOUT })
      .toMatch(/^(pr_ready|done)$/)
  })
})
