import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  BOOT_TIMEOUT,
  createSeededWorkspace,
  createSimplePipeline,
  findRunOf,
  LIVE_TIMEOUT,
  pinWorkspace,
  startRun,
} from './helpers'

// The run deep link (`?ws=…&block=…&run=…[&view=…]`), the way an integration that filed a task
// (sainte-beuve, filing an AI review) sends a person to the run. Selecting the task alone left them
// on the board's default camera, often nowhere near it, so the link has to bring the task into view
// and open its running pipeline: the focus view a double-click on the task opens.

const TASK = 'task_login'

/** The camera's zoom, read off the transform Vue Flow puts on the board's pane. */
async function viewportZoom(page: Page): Promise<number> {
  return page
    .getByTestId('board-canvas')
    .locator('.vue-flow__transformationpane')
    .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)
}

/**
 * Whether the task's card sits inside the canvas, and how far its centre is from the canvas's, in
 * screen pixels. The card is read inside its frame's node, as the board draws it.
 */
async function taskPlacement(
  page: Page,
  frameId: string,
): Promise<{ inside: boolean; offCentre: number }> {
  const canvas = await page.getByTestId('board-canvas').boundingBox()
  const card = await page
    .locator(`.vue-flow__node[data-id="${frameId}"] [data-block-id="${TASK}"]`)
    .boundingBox()
  if (!canvas || !card) return { inside: false, offCentre: Number.POSITIVE_INFINITY }
  const inside =
    card.x >= canvas.x &&
    card.y >= canvas.y &&
    card.x + card.width <= canvas.x + canvas.width &&
    card.y + card.height <= canvas.y + canvas.height
  const dx = card.x + card.width / 2 - (canvas.x + canvas.width / 2)
  const dy = card.y + card.height / 2 - (canvas.y + canvas.height / 2)
  return { inside, offCentre: Math.hypot(dx, dy) }
}

/** The zoom where the board renders a task's pipeline steps (`LOD_MIN_ZOOM.steps` in the SPA). */
const STEPS_ZOOM = 1.8
/** The board's `default-viewport` zoom, which a fresh load starts from. */
const DEFAULT_ZOOM = 0.85

test.describe('run deep link', () => {
  test.slow()

  test('opens the task with its running pipeline, zoomed in on its card', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    const workspaceId = snapshot.workspace.id
    const pipeline = await createSimplePipeline(request, workspaceId)
    await startRun(request, workspaceId, TASK, pipeline.id)
    await expect
      .poll(() => findRunOf(request, workspaceId, TASK), { timeout: LIVE_TIMEOUT })
      .not.toBeNull()
    const runId = (await findRunOf(request, workspaceId, TASK)) as string
    const frameId = serviceFrameOf(snapshot.blocks, TASK)

    await pinWorkspace(page, workspaceId)
    await page.goto(`/?ws=${workspaceId}&block=${TASK}&run=${runId}`)

    const focus = page.getByTestId('block-focus-view')
    await expect(focus).toBeVisible({ timeout: BOOT_TIMEOUT })
    await expect(focus).toHaveAttribute('data-focus-block', TASK)
    await expect(focus.getByTestId('pipeline-step').first()).toBeVisible({ timeout: LIVE_TIMEOUT })

    // The camera zoomed in past the board's default to where a task's steps render, with the
    // task's card inside the canvas and centred on it.
    expect(STEPS_ZOOM).toBeGreaterThan(DEFAULT_ZOOM)
    await expect
      .poll(() => viewportZoom(page), { timeout: LIVE_TIMEOUT })
      .toBeGreaterThanOrEqual(STEPS_ZOOM)
    await expect
      .poll(() => taskPlacement(page, frameId), { timeout: LIVE_TIMEOUT })
      .toMatchObject({ inside: true })
    expect((await taskPlacement(page, frameId)).offCentre).toBeLessThan(40)
    // The link's own parameters are consumed, so a reload does not reopen it.
    expect(new URL(page.url()).searchParams.get('run')).toBeNull()
  })

  test('view=observability still opens that window, with the task brought into view', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    const workspaceId = snapshot.workspace.id
    const pipeline = await createSimplePipeline(request, workspaceId)
    await startRun(request, workspaceId, TASK, pipeline.id)
    await expect
      .poll(() => findRunOf(request, workspaceId, TASK), { timeout: LIVE_TIMEOUT })
      .not.toBeNull()
    const runId = (await findRunOf(request, workspaceId, TASK)) as string

    await pinWorkspace(page, workspaceId)
    await page.goto(`/?ws=${workspaceId}&block=${TASK}&run=${runId}&view=observability`)

    await expect(page.getByTestId('observability-panel')).toBeVisible({ timeout: BOOT_TIMEOUT })
    await expect(page.getByTestId('block-focus-view')).toHaveCount(0)
    await expect
      .poll(() => viewportZoom(page), { timeout: LIVE_TIMEOUT })
      .toBeGreaterThanOrEqual(STEPS_ZOOM)
    await expect
      .poll(() => taskPlacement(page, serviceFrameOf(snapshot.blocks, TASK)), {
        timeout: LIVE_TIMEOUT,
      })
      .toMatchObject({ inside: true })
  })
})

/** The top-level service frame a task sits in, walking up its parents. */
function serviceFrameOf(
  blocks: readonly { id: string; parentId?: string | null }[],
  id: string,
): string {
  const byId = new Map(blocks.map((block) => [block.id, block]))
  let current = byId.get(id)
  while (current?.parentId) {
    const parent = byId.get(current.parentId)
    if (!parent) break
    current = parent
  }
  return current?.id ?? id
}
