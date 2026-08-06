import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  readBlockStatus,
  startRun,
  taskCard,
} from './helpers'

// A service frame lays its tasks out in status swimlanes, and the lane a card sits in is derived
// from live run state rather than from anything a user placed. That derivation is only observable
// in the assembled product: the classification reads the block, its run and its open gates, and
// the card MOVES between columns on a WebSocket push with no reload. Exactly the round trip e2e
// exists for — the pure lane rules themselves are unit-tested in `utils/swimlanes.spec.ts`.

/** The lane a card is currently rendered in, by walking up to the nearest lane container. */
function laneOf(page: import('@playwright/test').Page, blockId: string) {
  return taskCard(page, blockId).locator('xpath=ancestor::*[@data-lane][1]')
}

test.describe('task swimlanes', () => {
  test('a card starts in Not started and MOVES to In progress when its run begins', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard

    // Seeded, never run: the classification has no run to consult, so the task's own status is
    // what places it.
    const card = taskCard(page, 'task_login')
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(laneOf(page, 'task_login')).toHaveAttribute('data-lane', 'not_started')

    // A coder-only pipeline so the run stays live rather than racing to a merge.
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder'])
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the same card, in a different column, with no reload. This is the assertion the whole
    // feature rests on — the lane is a claim the board re-derives from pushed run state.
    await expect(laneOf(page, 'task_login')).toHaveAttribute('data-lane', 'in_progress', {
      timeout: LIVE_TIMEOUT,
    })
  })

  test('a parked run moves the card into Needs you, and the lane counts follow', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard

    const notStartedCount = taskCard(page, 'blk_auth').getByTestId('lane-count-not_started')
    await expect(notStartedCount).toBeVisible({ timeout: LIVE_TIMEOUT })
    const before = Number(await notStartedCount.innerText())

    // The default backend profile parks the fake agent's first step on a human decision
    // (`E2E_DECISION_ON_STEPS=0`), which is the canonical "needs a human" state.
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder'])
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    await expect(laneOf(page, 'task_login')).toHaveAttribute('data-lane', 'needs_you', {
      timeout: LIVE_TIMEOUT,
    })
    // The header count is what a reader scanning a collapsed board sees, so it has to track the
    // same derivation the cards do rather than being a second, independently-computed number.
    await expect(notStartedCount).toHaveText(String(before - 1), { timeout: LIVE_TIMEOUT })
    await expect(taskCard(page, 'blk_auth').getByTestId('lane-count-needs_you')).toHaveText('1', {
      timeout: LIVE_TIMEOUT,
    })
  })

  test('a merged task leaves the live lanes for the collapsed Done lane, which states the total', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard

    const card = taskCard(page, 'task_login')
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })

    // A merger ends the pipeline, and the seeded fakes report high confidence, so the task
    // auto-merges and lands `done`.
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'merger'])
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the card leaves the board. The Done lane is collapsed by default, so a merged task's
    // card is genuinely not in the DOM — asserting the absence is sound because the card was
    // asserted PRESENT above, making this a transition rather than a never-rendered node.
    await expect(card).toBeHidden({ timeout: RUN_TERMINAL_TIMEOUT })
    // Corroboration over REST for WHICH terminal state that absence is: the absence alone cannot
    // tell `done` from the `pr_ready` a merge refusal would have left.
    expect(await readBlockStatus(request, workspaceId, 'task_login')).toBe('done')

    // The strip's own count is the fact it exists to carry: finished work is not invisible, it is
    // COLLAPSED. This is the regression the Done lane was added for — a merged task used to leave
    // the board with nothing left to say the service had ever completed anything.
    const frame = taskCard(page, 'blk_auth')
    await expect(frame.getByTestId('lane-count-done')).toHaveText('1', { timeout: LIVE_TIMEOUT })

    // Opening it brings the card back, in the Done lane this time.
    await frame.getByTestId('done-lane-toggle').click()
    await expect(frame.getByTestId('lane-done')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })
  })

  test('an empty lane says so rather than rendering blank', async ({ page, seededBoard }) => {
    void seededBoard
    // "Nothing is waiting on you" is the answer a reader scanning that column wants, and it is
    // the one an empty box cannot distinguish from a lane that failed to render.
    const needsYou = taskCard(page, 'blk_auth').getByTestId('lane-needs_you')
    await expect(needsYou).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(needsYou).not.toBeEmpty()
  })
})
