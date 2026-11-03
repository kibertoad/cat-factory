import type { Locator, Page } from '@playwright/test'
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

// The full-bleed takeovers (the step reader, the model configuration takeover, the observability,
// reports, operator dashboard and Kaizen panels, the artifact lightbox) render inside the shared
// `TakeoverShell`, which registers each one on the app's overlay stack through `useModalBehavior`.
// Before the shell, six of them hand-rolled a window Escape listener: Tab walked out to the board
// behind them, and one Escape closed every overlay that listened, so a panel opened over the reader
// took the reader down with it. Tracker: docs/initiatives/overlay-shells.md.
//
// Only a real browser can prove this: the trap and the stack act on real focus and real key events
// across teleported siblings, which a unit test with a stubbed DOM does not have.

/** Whether keyboard focus is on `dialog` or inside it. */
function focusInside(dialog: Locator): Promise<boolean> {
  return dialog.evaluate((el) => el.contains(document.activeElement))
}

/** Press `key` `count` times and assert that focus stays inside `dialog` after every press. */
async function assertFocusStaysInside(
  page: Page,
  dialog: Locator,
  key: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(key)
    expect(await focusInside(dialog), `${key} press ${i + 1} moved focus out`).toBe(true)
  }
}

test.describe('takeover shell', () => {
  test.slow()

  test('the step reader keeps focus inside, and Escape closes the panel over it first', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // No agent decision, and an approval gate on the architect, so the run parks where the card's
    // primary action opens the step reader.
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [] })
    const pipeline = await createSimplePipeline(
      request,
      workspaceId,
      ['architect', 'coder'],
      [true, false],
    )
    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(card.getByTestId('task-resolve')).toHaveText(/approve/i, {
      timeout: RUN_TERMINAL_TIMEOUT,
    })

    const reader = page.getByTestId('step-detail')
    await openAttention(card, reader)

    // Focus moves into the reader on open, and no number of Tab presses in either direction takes
    // it back to the board. 30 is more than the reader has controls, so the trap has to wrap.
    await expect(reader).toBeFocused()
    // The very first Shift+Tab, from the dialog root, must not leave for the board behind.
    await assertFocusStaysInside(page, reader, 'Shift+Tab', 1)
    await assertFocusStaysInside(page, reader, 'Tab', 30)
    await assertFocusStaysInside(page, reader, 'Shift+Tab', 5)

    // A second takeover over the first: the observability panel, opened from the reader.
    const viewAllCalls = reader.getByTestId('step-view-all-calls')
    await viewAllCalls.click()
    const observability = page.getByTestId('observability-panel')
    await expect(observability).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(observability).toBeFocused()
    // The top overlay on the stack is also the top layer on screen.
    expect(
      await observability.evaluate((el) => {
        const { x, y, width, height } = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(x + width / 2, y + height / 2))
      }),
    ).toBe(true)

    // One Escape closes only the top overlay, and focus goes back to the control that opened it.
    await page.keyboard.press('Escape')
    await expect(observability).toBeHidden()
    await expect(reader).toBeVisible()
    await expect(viewAllCalls).toBeFocused()

    // The reader is the top overlay again, so the next Escape closes it.
    await page.keyboard.press('Escape')
    await expect(reader).toBeHidden()
  })

  test('Escape on a dropdown or the confirm dialog over the model configuration closes only that layer', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    await page.getByTestId('nav-model-config').click()
    const panel = page.getByTestId('model-configuration-panel')
    await expect(panel).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(panel).toBeFocused()

    // A Nuxt UI dropdown opened inside the takeover holds a ticket on the shared stack
    // (`utils/foreignLayers.ts`), so Escape closes the dropdown and not the editor under it.
    // Before, the shell took this key press and the draft was lost.
    await panel.getByTestId('model-preset-new').click()
    const name = panel.getByTestId('model-preset-name')
    await name.fill('Escape draft')
    const baseModel = panel.getByTestId('model-preset-base-model')
    await baseModel.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(name).toHaveValue('Escape draft')
    await expect(baseModel).toBeFocused()

    // With no layer over it, the next Escape is the panel's again: back out of the editor.
    await page.keyboard.press('Escape')
    await expect(name).toBeHidden()
    // The focused input left the DOM with the editor, so focus returns to the dialog root.
    await expect(panel).toBeFocused()

    // The default preset cannot be deleted, so pick the first one that can.
    await panel.locator('[data-testid="model-preset-delete"]:not([disabled])').first().click()
    const confirm = page.getByTestId('confirm-dialog')
    await expect(confirm).toBeVisible()

    // The confirm is a Nuxt UI modal, so it holds a ticket on the shared stack like the dropdown
    // above: the panel under it is not the top overlay and must leave this Escape to the dialog.
    await page.keyboard.press('Escape')
    await expect(confirm).toBeHidden()
    await expect(panel).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  })
})
