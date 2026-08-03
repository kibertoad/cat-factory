import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  createSeededWorkspace,
  createSimplePipeline,
  openBoard,
  pinWorkspace,
  startRun,
  taskCard,
} from './helpers'

// The launch offer is the one surface whose whole subject is the FIRST launch, so this first
// describe must NOT use the `seededBoard` fixture: that fixture pre-answers the launch prompt
// (as every other spec needs — a first-run modal would make their clicks unactionable), which
// is precisely the thing under test here. So each test in it runs the seed → pin → open
// preamble itself, opting into `tutorial: 'unanswered'`. The describes below it are about a
// RETURNING user and take the fixture as-is.
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

// The catalogue is the surface a RETURNING user reaches — the one whose whole point is that
// it is there after the launch prompt has been answered and gone. Everything below is what
// only the assembled product shows: the sidebar entry really opens it, its rows really reflect
// this board's live state, and a tour started from it really runs.
test.describe('the tutorial catalogue', () => {
  test('opens from the sidebar at any time, listing what can and cannot run yet', async ({
    page,
    seededBoard,
  }) => {
    // `seededBoard` pre-answers the launch prompt, which is exactly the state under test: a
    // user who said "no thanks" once must still have a way back to the walkthroughs.
    void seededBoard
    await expect(page.getByTestId('tutorial-prompt')).toBeHidden()

    await page.getByTestId('nav-tutorial').click()
    const catalogue = page.getByTestId('tutorial-catalogue')
    await expect(catalogue).toBeVisible({ timeout: LIVE_TIMEOUT })

    // Every built-in is listed, whether or not this board can run it. A seeded board has a
    // service and tasks, so the run tour is startable; nothing has finished, so the
    // review/merge tour is held back — and SAYS so rather than being missing.
    await expect(catalogue.getByTestId('tutorial-catalogue-entry-board-basics')).toBeVisible()
    await expect(catalogue.getByTestId('tutorial-catalogue-start-run-task')).toBeEnabled()
    await expect(catalogue.getByTestId('tutorial-catalogue-start-review-merge')).toBeDisabled()
    await expect(
      catalogue.getByTestId('tutorial-catalogue-requirements-review-merge'),
    ).toBeVisible()
  })

  test('starts a tour, offers it back where it stopped, and resets that record', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard

    await page.getByTestId('nav-tutorial').click()
    await page.getByTestId('tutorial-catalogue-start-board-basics').click()

    // The catalogue gets out of the way and the real coach mark runs, anchored to the board.
    await expect(page.getByTestId('tutorial-catalogue')).toBeHidden({ timeout: LIVE_TIMEOUT })
    const tooltip = page.getByTestId('tutorial-tooltip')
    await expect(tooltip).toBeVisible({ timeout: LIVE_TIMEOUT })
    await tooltip.getByTestId('tutorial-next').click()
    await expect(page.getByTestId('tutorial-highlight')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await tooltip.getByTestId('tutorial-skip').click()
    await expect(page.getByTestId('tutorial-overlay')).toBeHidden()

    // Broken off past the first step, so the row now offers the position back — the whole
    // reason a stray Esc is survivable.
    await page.getByTestId('nav-tutorial').click()
    await expect(page.getByTestId('tutorial-catalogue-status-board-basics')).toBeVisible({
      timeout: LIVE_TIMEOUT,
    })

    // ...and Reset really clears it, which is what makes this demoable to the next person.
    await page.getByTestId('tutorial-catalogue-reset').click()
    await expect(page.getByTestId('tutorial-catalogue-status-board-basics')).toBeHidden()
    await expect(page.getByTestId('tutorial-catalogue-reset')).toBeHidden()
  })
})

// The tours that key off RUN state are the only ones whose availability the unit tests
// cannot reach: those drive `resolveTourCatalogue` with a fixture gate object, while what
// decides this in production is `createNavGates` reading the live execution store. So the assertion
// that matters is the assembled one — a run really parks, and the tour about answering it
// really appears, with no reload between the two.
test.describe('tutorial tours that follow a live run', () => {
  test.slow()

  test('offers the parked-run tour once a real run parks, anchored to the real control', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const pipeline = await createSimplePipeline(request, workspaceId)
    const card = taskCard(page, 'task_login')

    // Nothing is waiting yet, so the tour has nothing to teach: the catalogue still LISTS it
    // (that is the point of the catalogue) with its button inert and the requirement named.
    await page.getByTestId('command-bar-launcher').click()
    await expect(page.getByTestId('command-bar')).toBeVisible()
    await page.getByTestId('command-tutorial').click()
    await expect(page.getByTestId('tutorial-catalogue')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(page.getByTestId('tutorial-catalogue-start-answer-park')).toBeDisabled()
    await expect(page.getByTestId('tutorial-catalogue-requirements-answer-park')).toBeVisible()
    await page.getByTestId('tutorial-catalogue-close').click()

    // The fake agent parks the first step on a human decision, pushed live.
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(page.getByTestId('decision-badge')).toBeVisible({ timeout: LIVE_TIMEOUT })

    // LIVE: the gate flipped with no reload, so the same catalogue row is now startable and
    // its "available once you have" note is gone.
    await page.getByTestId('command-bar-launcher').click()
    await page.getByTestId('command-tutorial').click()
    const start = page.getByTestId('tutorial-catalogue-start-answer-park')
    await expect(start).toBeEnabled({ timeout: LIVE_TIMEOUT })
    await expect(page.getByTestId('tutorial-catalogue-requirements-answer-park')).toBeHidden()
    await start.click()

    // Step 1 is the untargeted intro; Next moves onto the card's own Resolve affordance,
    // whose highlight proves the tour anchored to the control this park really rendered.
    const tooltip = page.getByTestId('tutorial-tooltip')
    await expect(tooltip).toBeVisible({ timeout: LIVE_TIMEOUT })
    await tooltip.getByTestId('tutorial-next').click()
    await expect(page.getByTestId('tutorial-highlight')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(card.getByTestId('task-resolve')).toBeVisible()

    // Deliberately a single click rather than the `openAttention` retry every other spec
    // uses: that helper re-clicks to survive a card remounting mid-flight, and each click
    // ALSO advances the tour, which would carry it past the step under test. Safe here
    // because a run parked on a decision is quiescent — nothing remounts that button until
    // the decision is answered.
    await card.getByTestId('task-resolve').click()
    const modal = page.getByTestId('decision-modal')
    await expect(modal).toBeVisible({ timeout: LIVE_TIMEOUT })
    const option = modal.getByTestId('decision-option').first()
    await expect(option).toBeVisible()

    // The tour must survive its own SUCCESS. Answering is the thing this tour teaches, and
    // answering clears the very gate that offers it — so a script re-read from the gated slot
    // on every flip vanishes right here, mid-walkthrough, with nothing recorded as completed.
    // This is the one place that wiring is exercised end to end.
    //
    // Answered from the `decide` step (whose tooltip is anchored ABOVE the option), not from
    // the finish card: an untargeted step centers its tooltip, which lands squarely on the
    // open modal and swallows the click.
    await option.click()
    await expect(modal).toBeHidden({ timeout: LIVE_TIMEOUT })
    await expect(page.getByTestId('decision-badge')).toBeHidden({ timeout: LIVE_TIMEOUT })
    await expect(tooltip).toBeVisible()

    // Ends here rather than driving on to the finish card: the `decide` anchor went with the
    // modal, so from this point the tour may sit on it or skip forward on its own wait, and
    // asserting past a step that races itself is how a spec becomes flaky. Which skips the
    // finish card counts as abridged is settled in `unexpectedlySkippedSteps`' unit tests,
    // where it needs no live run at all.
    await tooltip.getByTestId('tutorial-skip').click()
    await expect(page.getByTestId('tutorial-overlay')).toBeHidden()
  })
})
