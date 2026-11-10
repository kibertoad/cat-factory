import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, createSimplePipeline, createTask, startRun, taskCard } from './helpers'

// A card's action buttons must not move under the pointer (UXA-01).
//
// A `click` goes to the element that received BOTH `pointerdown` and `pointerup`. Hovering a card
// with a run used to expand its pipeline steps, and a lane card is an in-flow item, so the
// expansion moved the card's own buttons and pushed every card below it down. Moving from one
// card onto the next collapsed the first and lifted the second, so its button moved as the
// pointer arrived, and a press that started there resolved to the card root (whose handler
// selects the task) instead of acting. The second click worked, which is why nobody filed it.
//
// Hovering now expands nothing: the step a run is on is always on the card, in its progress row,
// and the step list appears only past the `steps` zoom band. So the spec pins that the pointer
// changes no card's box, then presses the lower card's button straight after the upper card was
// hovered, the exact path that lost the click.
//
// The press is `mouse.down()`, a human-scale pause, then `mouse.up()`. `locator.click()` presses
// and releases back to back, before a layout change on the next frame could land, so it passes on
// a layout that moves. It is not retried the way `openAttention` retries: both cards are parked on
// a decision, so nothing remounts their rows while the spec acts, and a retry would hide exactly
// the lost click this spec is for.

/** Long enough for a frame and the re-render after it, as a person's press is. */
const HUMAN_PRESS_MS = 300

/** Point at the zoom readout: on screen and outside every card. */
async function pointAway(page: Page): Promise<void> {
  await page.getByTestId('board-zoom-reset').hover()
}

/** Press and release at the CENTRE of where `target` is now, with a pause in between. */
async function pressAt(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error('pressAt: the target has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(HUMAN_PRESS_MS)
  await page.mouse.up()
}

/**
 * Rest the pointer on `target` as a person does before they press. A layout change the pointer
 * caused lands on a later frame, so the boxes are read after the dwell, not on arrival.
 */
async function dwellOn(page: Page, target: Locator): Promise<void> {
  await target.hover()
  await page.waitForTimeout(HUMAN_PRESS_MS)
}

/** Every given locator's box, in order. */
function boxes(locators: Locator[]) {
  return Promise.all(locators.map((l) => l.boundingBox()))
}

test.describe('card action row', () => {
  test('the pointer moves no card, and a press on the next card acts', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const pipeline = await createSimplePipeline(request, workspaceId)
    const second = await createTask(request, workspaceId, 'blk_auth', 'Second parked task')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await startRun(request, workspaceId, second.id, pipeline.id)

    // Both park on the fake agent's decision, so both sit in the same status lane.
    const login = taskCard(page, 'task_login')
    const parked = taskCard(page, second.id)
    const cards = [login, parked]
    for (const card of cards) {
      await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })
      await expect(card.getByTestId('task-resolve')).toBeVisible({ timeout: LIVE_TIMEOUT })
      await expect(card.getByTestId('task-progress-row')).toBeVisible()
    }
    // Past the `steps` band every on-screen card expands by zoom, which is not the subject here.
    await expect(page.getByTestId('board-zoom-reset')).toHaveAttribute(
      'data-lod',
      /^(far|mid|close)$/,
    )

    await pointAway(page)
    const [first, next] = await boxes(cards)
    if (!first || !next) throw new Error('both cards must be on screen')
    expect(Math.abs(first.x - next.x), 'the two cards share a lane column').toBeLessThan(2)
    const [above, below] = first.y < next.y ? [login, parked] : [parked, login]
    const watched = [
      above,
      below,
      above.getByTestId('task-resolve'),
      below.getByTestId('task-resolve'),
    ]
    const before = await boxes(watched)

    // Rest on the upper card, then arrive on the lower card's button: nothing moves either time,
    // and neither card opens its step list.
    await dwellOn(page, above.getByTestId('task-title'))
    expect(await boxes(watched)).toEqual(before)
    await dwellOn(page, below.getByTestId('task-resolve'))
    expect(await boxes(watched)).toEqual(before)
    for (const card of cards) await expect(card.getByTestId('task-pipeline-mini')).toBeHidden()

    // Back on the upper card, then one press on the lower card's Resolve opens the decision.
    await dwellOn(page, above.getByTestId('task-title'))
    await pressAt(page, below.getByTestId('task-resolve'))
    await expect(page.getByTestId('decision-modal')).toBeVisible()
  })
})
