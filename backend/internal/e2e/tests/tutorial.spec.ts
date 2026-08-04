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

    // It asks about the delivery arc only. The platform tours are startable on this board (they
    // need a permission, not board state), so their absence here is the offer/library split
    // doing its job rather than a gate — see the catalogue test below, which starts one.
    await expect(prompt.getByTestId('tutorial-start-board-basics')).toBeVisible()
    await expect(prompt.getByTestId('tutorial-start-design-pipeline')).toBeHidden()

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
    // The other half of the split the launch prompt asserts: a tour kept out of that one-question
    // offer is fully present HERE, listed and startable, not merely gated away somewhere.
    await expect(catalogue.getByTestId('tutorial-catalogue-start-design-pipeline')).toBeEnabled()
    await expect(
      catalogue.getByTestId('tutorial-catalogue-requirements-review-merge'),
    ).toBeVisible()

    // Reset is offered to THIS user, who has completed nothing and paused nothing — the saved
    // "no thanks" is itself the thing standing between them and the first-launch experience, and
    // it is the state a demo machine is in. Keying the control on the tour rows alone hid it from
    // exactly the person who came to clear it. (Page-scoped rather than `catalogue`-scoped: the
    // control sits in the modal's FOOTER, while `tutorial-catalogue` is the body holding the list.)
    await expect(page.getByTestId('tutorial-catalogue-reset')).toBeVisible()
  })

  test('stands the coach marks down while it is open, and steps back into the tour', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard

    await page.getByTestId('nav-tutorial').click()
    await page.getByTestId('tutorial-catalogue-start-board-basics').click()
    // Asserted on the TOOLTIP, not the `tutorial-overlay` wrapper: every mark inside it is
    // `position: fixed`, so the wrapper's own box is empty and Playwright reads a rendered
    // overlay as hidden. The tooltip is also the thing that would actually be floating over the
    // catalogue, so it is what this test is about.
    const tooltip = page.getByTestId('tutorial-tooltip')
    await expect(tooltip).toBeVisible({ timeout: LIVE_TIMEOUT })
    await tooltip.getByTestId('tutorial-next').click()

    // The catalogue is reachable mid-tour (nothing about the overlay blocks the sidebar). The
    // marks sit at z-[70] so a step can point INTO an app modal, so without standing them down
    // they would float a ring and a tooltip over the window the user just opened — only the
    // assembled product can show that they don't.
    await page.getByTestId('nav-tutorial').click()
    await expect(page.getByTestId('tutorial-catalogue')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(tooltip).toBeHidden()
    await expect(page.getByTestId('tutorial-overlay')).toBeHidden()

    // The running tour is offered back, not restarted — and stepping into it restores the marks
    // where they were, which is what proves the overlay was suppressed rather than torn down.
    await page.getByTestId('tutorial-catalogue-start-board-basics').click()
    await expect(page.getByTestId('tutorial-catalogue')).toBeHidden()
    await expect(tooltip).toBeVisible({ timeout: LIVE_TIMEOUT })
    // Still on step 2, where Next left it: `continue` steps out of the way, and a plain start
    // would have put the cursor back to step 1.
    await expect(tooltip).toContainText('Step 2 of')
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
    // reason a stray Esc is survivable. The badge must read PAUSED specifically: a mere
    // "a badge is present" assertion passes for `completed` too, and the difference between
    // those two is exactly what decides whether the row offers Resume or Repeat.
    await page.getByTestId('nav-tutorial').click()
    await expect(page.getByTestId('tutorial-catalogue-status-board-basics')).toHaveText(/paused/i, {
      timeout: LIVE_TIMEOUT,
    })

    // ...and Reset really clears it, which is what makes this demoable to the next person.
    await page.getByTestId('tutorial-catalogue-reset').click()
    await expect(page.getByTestId('tutorial-catalogue-status-board-basics')).toBeHidden()
    await expect(page.getByTestId('tutorial-catalogue-reset')).toBeHidden()
  })
})

// The two surfaces that BRING a walkthrough up rather than waiting to be opened. Both are only
// assertable assembled: the handoff resolves the next candidate against the LIVE gates at the moment
// a completion lands, and the contextual offer fires on a gate transition the unit tests can only
// simulate with a fixture object.
test.describe('tutorial offers that come to the user', () => {
  test('hands off to the next walkthrough from the finish card', async ({ page, seededBoard }) => {
    // Driven from the catalogue rather than the launch prompt so this reads as the RETURNING user
    // it is about: the prompt is already answered on this fixture, which is exactly the state that
    // makes the handoff the only thing left that can offer a tour.
    void seededBoard
    await page.getByTestId('nav-tutorial').click()
    await expect(page.getByTestId('tutorial-catalogue')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await page.getByTestId('tutorial-catalogue-start-board-basics').click()

    const tooltip = page.getByTestId('tutorial-tooltip')
    await expect(tooltip).toBeVisible({ timeout: LIVE_TIMEOUT })

    // Walk to the last step. Bounded, and it asserts it ARRIVED rather than trusting the count:
    // an anchor-skip can move the cursor more than one step at a time, so a fixed number of clicks
    // is not the same as reaching the end.
    const handoff = page.getByTestId('tutorial-next-tour')
    for (let i = 0; i < 12 && !(await handoff.isVisible()); i++) {
      await tooltip.getByTestId('tutorial-next').click()
    }
    await expect(handoff).toBeVisible({ timeout: LIVE_TIMEOUT })

    // Taking the offer completes THIS tour and opens the next one in a single tick. Two things are
    // asserted about the result, and the second is the one a unit test cannot reach: the overlay
    // stayed mounted across the swap, so the finished tour's skipped steps must not be counted
    // against the new one — an abridged notice here would be a false claim about a fresh tour.
    await handoff.getByTestId('tutorial-next-tour-start').click()
    await expect(tooltip).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(page.getByTestId('tutorial-next-tour')).toBeHidden()
    await expect(page.getByTestId('tutorial-abridged')).toBeHidden()

    // And the finished tour is recorded as COMPLETED, which is what makes the handoff a course
    // rather than a loop: taking the offer had to write the completion before launching the next.
    await tooltip.getByTestId('tutorial-skip').click()
    await page.getByTestId('nav-tutorial').click()
    await expect(page.getByTestId('tutorial-catalogue')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(page.getByTestId('tutorial-catalogue-status-board-basics')).toHaveText(
      /completed/i,
      { timeout: LIVE_TIMEOUT },
    )
  })

  test('raises the contextual offer when a run parks, with no reload', async ({
    page,
    request,
  }) => {
    test.slow()
    // NOT the `seededBoard` fixture: it pre-answers the launch prompt with "no thanks", and a
    // decline is the one state in which this mechanism deliberately says nothing at all ("no
    // thanks" answered the question about guided tours, not about when it was asked). So this
    // spec seeds its own board as a user who ACCEPTED, which is the returning user the
    // contextual offer exists for.
    const snapshot = await createSeededWorkspace(request)
    const workspaceId = snapshot.workspace.id
    await pinWorkspace(page, workspaceId, { tutorial: 'accepted' })
    await openBoard(page)
    const pipeline = await createSimplePipeline(request, workspaceId)

    // Nothing is waiting, so nothing has become newly takeable: the offer fires on a TRANSITION
    // off a baseline seeded once the board is up, and this asserts that arriving on a board which
    // already satisfies most of the catalog is not itself treated as a transition.
    await expect(page.getByTestId('tutorial-nudge')).toBeHidden()

    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(page.getByTestId('decision-badge')).toBeVisible({ timeout: LIVE_TIMEOUT })

    // LIVE: the park flipped `answer-park` from blocked to ready, and the offer names it — the whole
    // point of the mechanism, since this is the tour whose window is transient and whose cost
    // (a run parked indefinitely) is the one the tutorial exists to prevent. The TITLE is asserted,
    // not just the card: an offer raised for whichever tour happened to be next would be the
    // mechanism firing on a board load rather than on the moment.
    const nudge = page.getByTestId('tutorial-nudge')
    await expect(nudge).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(nudge).toContainText('Answer a waiting run')
    await nudge.getByTestId('tutorial-nudge-start').click()
    await expect(page.getByTestId('tutorial-tooltip')).toBeVisible({ timeout: LIVE_TIMEOUT })
    // Suppressed while a tour runs: the card would compete with the coach mark for the same
    // attention, and it is already spent, so it does not come back after the tour ends either.
    await expect(nudge).toBeHidden()
    await page.getByTestId('tutorial-tooltip').getByTestId('tutorial-skip').click()
    await expect(page.getByTestId('tutorial-nudge')).toBeHidden()
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
