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

/**
 * Where the camera is relative to the task, read in ONE snapshot. The camera moves in two animated
 * steps (centre at the new zoom, then centre again once the card has grown at that level), so the
 * zoom and the card's placement have to be read together: checked one after the other, either can
 * pass mid-move and the next read land somewhere else.
 */
async function cameraOnTask(
  page: Page,
  frameId: string,
): Promise<{ zoomedIn: boolean; inside: boolean; centred: boolean }> {
  const reading = await page.evaluate(
    ({ frameId, task }) => {
      const canvas = document.querySelector('[data-testid="board-canvas"]')
      // Vue Flow puts the camera's transform on the pane, not on its viewport element.
      const pane = canvas?.querySelector('.vue-flow__transformationpane')
      const card = canvas?.querySelector(
        `.vue-flow__node[data-id="${frameId}"] [data-block-id="${task}"]`,
      )
      if (!canvas || !pane || !card) return null
      const area = canvas.getBoundingClientRect()
      const box = card.getBoundingClientRect()
      return {
        zoom: new DOMMatrixReadOnly(getComputedStyle(pane).transform).a,
        inside:
          box.left >= area.left &&
          box.top >= area.top &&
          box.right <= area.right &&
          box.bottom <= area.bottom,
        offCentre: Math.hypot(
          box.left + box.width / 2 - (area.left + area.width / 2),
          box.top + box.height / 2 - (area.top + area.height / 2),
        ),
      }
    },
    { frameId, task: TASK },
  )
  if (reading === null) return { zoomedIn: false, inside: false, centred: false }
  return {
    zoomedIn: reading.zoom >= STEPS_ZOOM,
    inside: reading.inside,
    centred: reading.offCentre < CENTRED_WITHIN_PX,
  }
}

/** The camera at rest on the task: zoomed in, the card on screen and centred. */
const LANDED = { zoomedIn: true, inside: true, centred: true }

/** How close to the canvas's centre counts as centred, in screen pixels. */
const CENTRED_WITHIN_PX = 40

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
    // task's card inside the canvas and centred on it, once it has finished moving.
    expect(STEPS_ZOOM).toBeGreaterThan(DEFAULT_ZOOM)
    await expect.poll(() => cameraOnTask(page, frameId), { timeout: LIVE_TIMEOUT }).toEqual(LANDED)
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
      .poll(() => cameraOnTask(page, serviceFrameOf(snapshot.blocks, TASK)), {
        timeout: LIVE_TIMEOUT,
      })
      .toEqual(LANDED)
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
