import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, createSimplePipeline, startRun, taskCard } from './helpers'

// A card's action buttons must not move when the pointer arrives on them (UXA-01).
//
// Hovering a card with a run expands its pipeline steps (`TaskPipelineMini`), and the hover grant
// lands on the next animation frame after the pointer moves. When the steps rendered ABOVE the
// action row, that expansion pushed Resolve / Approve / Outcome down between `pointerdown` and
// `pointerup`: the two events landed on different elements, the browser fired `click` on their
// common ancestor (the card root, whose handler selects the task), and the first click on every
// card action selected the task instead of acting. The second click worked, which is why nobody
// filed it as broken.
//
// A component test cannot see this: it needs the board's hover driver and a layout engine. So the
// spec pins both halves in the real SPA: the geometric invariant (hovering expands the steps and
// the button's box does not move), and the behaviour a user sees (ONE click opens the decision).
// The single click is the point, so it is deliberately not wrapped in `openAttention`'s retry: the
// card is parked on a decision, so nothing remounts the row while the spec acts.
test.describe('card action row', () => {
  test('hovering expands the steps without moving the action row; one click acts', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const pipeline = await createSimplePipeline(request, workspaceId, ['architect', 'coder'])
    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // Parked on the fake agent's one-shot decision: the row is settled and nothing advances.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })
    const resolve = card.getByTestId('task-resolve')
    await expect(resolve).toBeVisible({ timeout: LIVE_TIMEOUT })

    // Start from a collapsed card: the pointer is off it, so no hover grant holds.
    await page.mouse.move(0, 0)
    const steps = card.getByTestId('task-pipeline-mini')
    await expect(steps).toBeHidden()
    const before = await resolve.boundingBox()
    expect(before).not.toBeNull()

    // Arrive on the button. The steps expand, and the button stays where the pointer found it.
    await resolve.hover()
    await expect(steps).toBeVisible()
    expect(await resolve.boundingBox()).toEqual(before)

    // From a collapsed card again, one click acts: the decision opens and the task is not merely
    // selected.
    await page.mouse.move(0, 0)
    await expect(steps).toBeHidden()
    await resolve.click()
    await expect(page.getByTestId('decision-modal')).toBeVisible()
  })
})
