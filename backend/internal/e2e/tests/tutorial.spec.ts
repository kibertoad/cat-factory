import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, createSeededWorkspace, openBoard, pinWorkspace } from './helpers'

// The in-app tutorial is the one surface whose whole subject is the FIRST launch, so it is
// also the one spec that must NOT use the `seededBoard` fixture: that fixture pre-answers the
// launch prompt (as every other spec needs — a first-run modal would make their clicks
// unactionable), which is precisely the thing under test here. So each test below runs the
// seed → pin → open preamble itself, opting into `tutorial: 'unanswered'`.
//
// What only the assembled product can show, and what these assert:
//  - the launch prompt really auto-opens for a user who has never answered;
//  - a tour anchors its highlight to the REAL control by `data-testid` and tracks it;
//  - the decision really persists, so a reload does not re-ask.
test.describe('in-app tutorial', () => {
  test('offers a tour on first launch, and runs one anchored to the real board', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id, { tutorial: 'unanswered' })
    await openBoard(page)

    // The prompt auto-opens on its own once the board is up — no interaction to get here.
    const prompt = page.getByTestId('tutorial-prompt')
    await expect(prompt).toBeVisible({ timeout: LIVE_TIMEOUT })

    await prompt.getByTestId('tutorial-start-board-basics').click()
    await expect(prompt).toBeHidden({ timeout: LIVE_TIMEOUT })

    // Step 1 is the untargeted welcome card; Next moves onto the board canvas, whose
    // highlight ring proves the overlay resolved a real `data-testid` and measured it.
    const tooltip = page.getByTestId('tutorial-tooltip')
    await expect(tooltip).toBeVisible({ timeout: LIVE_TIMEOUT })
    await tooltip.getByTestId('tutorial-next').click()
    await expect(page.getByTestId('tutorial-highlight')).toBeVisible({ timeout: LIVE_TIMEOUT })

    // Ending the tour tears the overlay down entirely (it is mounted only while touring).
    await tooltip.getByTestId('tutorial-skip').click()
    await expect(page.getByTestId('tutorial-overlay')).toBeHidden({ timeout: LIVE_TIMEOUT })
  })

  test('remembers "no thanks" across a reload', async ({ page, request }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id, { tutorial: 'unanswered' })
    await openBoard(page)

    const prompt = page.getByTestId('tutorial-prompt')
    await expect(prompt).toBeVisible({ timeout: LIVE_TIMEOUT })
    // Page-scoped, NOT scoped under `prompt`: `tutorial-prompt` marks the modal's BODY, and
    // the decline/close buttons live in the footer slot — a sibling of it, not a descendant.
    await page.getByTestId('tutorial-decline').click()
    await expect(prompt).toBeHidden({ timeout: LIVE_TIMEOUT })

    // The decision is persisted, so the next launch opens straight onto the board. This is
    // the assertion that would catch the prompt returning on every visit.
    await openBoard(page)
    await expect(page.getByTestId('tutorial-prompt')).toBeHidden()
  })

  test('does not interrupt a returning user', async ({ page, request }) => {
    // The state every other spec runs in — worth pinning explicitly, because it is what
    // keeps the rest of the suite actionable.
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id)
    await openBoard(page)
    await expect(page.getByTestId('tutorial-prompt')).toBeHidden()
  })
})
