import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// Slice 5 of the modular-vue adoption (docs/initiatives/modular-vue-slice5-progress.md):
// every agent-run result window now renders inside the shared `ResultWindowShell`, which
// centralises the modal chrome AND owns the modal *behaviour* via the upstream
// `useModalBehavior` — focus-trap, body-scroll lock, and a shared overlay stack so Escape
// closes the top overlay. Before slice 5 each of the ~18 windows hand-rolled this, and only
// 2 trapped focus / each registered its own Escape listener.
//
// This drives the pilot window (`MergerResultView`) through the REAL SPA to assert the shell
// renders and closes on all three paths the shell now owns — the close button, Escape, and a
// backdrop click. The merger step is reached with a low-confidence merger (no auto-merge, so
// the step settles with a verdict to inspect), the same setup as `merge-review.spec`.
test.describe('result-window shell (merger)', () => {
  test.slow()

  test('opens the merger window in the shared shell; closes on button / Escape / backdrop', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // Low confidence ⇒ the merger declines to auto-merge and leaves a verdict on the step;
    // the default step-0 decision is disabled so the run flows straight to the merger.
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [], confidence: 0.2 })
    const pipeline = await createSimplePipeline(request, workspaceId, [
      'architect',
      'coder',
      'merger',
    ])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    // The run drives through the merger and settles at `pr_ready` (pushed live).
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    // Clicking the task card opens the full-screen focus view (`ui.focus`), which lists the
    // run's steps (`PipelineProgress`). Clicking the completed merger step there routes to its
    // dedicated result window (`dispatchStepView`) — rendered in the shell, teleported above
    // the focus view.
    await card.click()
    const mergerStep = page.locator('[data-testid="pipeline-step"][data-step-kind="merger"]')
    await expect(mergerStep).toBeVisible({ timeout: LIVE_TIMEOUT })

    const dialog = page.getByTestId('result-window')
    const backdrop = page.getByTestId('result-window-backdrop')

    async function openWindow(): Promise<void> {
      await mergerStep.click()
      await expect(dialog).toBeVisible()
      // The shell hosts the merger verdict body (the decision banner) — proves the window's
      // own content renders inside the shared chrome, not just an empty shell.
      await expect(dialog.getByTestId('merger-decision')).toBeVisible()
    }

    // 1) The shell's standard close button.
    await openWindow()
    await dialog.getByTestId('result-window-close').click()
    await expect(dialog).toBeHidden()

    // 2) A click on the backdrop itself (top-left corner, outside the centered panel).
    await openWindow()
    await backdrop.click({ position: { x: 5, y: 5 } })
    await expect(dialog).toBeHidden()

    // 3) Escape — now owned by the shell's `useModalBehavior` (the shared overlay stack), not
    //    the window's old per-window listener. This is the behaviour slice 5 centralised. Done
    //    LAST: the focus view underneath also closes on Escape, so this can't strand a reopen.
    await openWindow()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

// A SECOND converted window — the CI `gate` (docs/initiatives/modular-vue-slice5-progress.md,
// window #4) — through the same shared shell, so the coverage isn't pilot-only. Unlike the
// merger, the gate contributes a status badge to the shell's `#header-extras` slot and passes
// `manageEscape: false`, so this proves both the extras slot and the Escape handoff generalise
// to a non-pilot window. Drive a real ci-fixer loop to a finished, green gate (as `ci-gate.spec`
// does), then open its window from the run's step list and close it on Escape.
test.describe('result-window shell (gate)', () => {
  test.slow()

  test('opens the ci gate window in the shared shell with its header-extras badge; closes on Escape', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder', 'ci-fixer'],
      pooledContainer: true,
      ciStatus: [false, true],
      pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'ci'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // The gate probes red → runs the fixer → re-probes green → the ci step reaches `done` live.
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    // Open the run's step list (the focus view) and route to the finished ci gate's window.
    await card.click()
    const ciStep = page.locator('[data-testid="pipeline-step"][data-step-kind="ci"]')
    await expect(ciStep).toBeVisible({ timeout: LIVE_TIMEOUT })

    const dialog = page.getByTestId('result-window')
    await ciStep.click()
    await expect(dialog).toBeVisible()
    // The gate contributes its status badge to the shell's `#header-extras` slot.
    await expect(dialog.getByTestId('gate-status')).toBeVisible()

    // Escape is owned by the shell's `useModalBehavior`, not a per-window listener — the
    // `manageEscape: false` handoff the conversion relies on.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

// A THIRD converted window — the tester report (`TestReportWindow`, window #3) — exercises the
// one behaviour slice 5 could NOT reconcile at the shell alone: a NESTED overlay. This window
// embeds the shared `ArtifactLightbox`, which now rides the SAME `useModalBehavior` overlay
// stack as its owning window (replacing the old `active: open && !lightboxOpen` focus-trap guard
// + the lightbox's bespoke capture-phase Escape). The load-bearing claim is that when the
// lightbox is open it becomes the TOP overlay, so Escape closes the LIGHTBOX first and the owning
// window's trap goes inert until it closes — a two-overlay ordering neither the merger nor the
// gate window can cover. This drives it live: reach a greenlit tester report carrying a
// screenshot, open its window, open the lightbox from a screenshot thumbnail, and assert the
// stacked-Escape ordering (lightbox closes, window survives; a second Escape then closes the
// re-topped window). The screenshot bytes are never served in e2e (artifact storage is off), but
// the lightbox opens as a real stacked overlay regardless — it is the modal STACKING under test,
// not the image, and `useArtifactBlobs` swallows the unresolved blob into a load/error state.
test.describe('result-window shell (nested lightbox)', () => {
  test.slow()

  test('the tester window layers the ArtifactLightbox on the shared stack; Escape closes the lightbox first, then the window', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // A single greenlit report carrying one screenshot grouped under the tested scenario (its
    // `view` matches a `tested` area, so it renders as a thumbnail in that scenario's node).
    const greenWithShot = {
      greenlight: true,
      summary: 'all good',
      tested: ['login'],
      outcomes: [{ name: 'login', status: 'passed' }],
      concerns: [],
      screenshots: [{ view: 'login', artifactId: 'shot_login' }],
    }
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      testReports: [greenWithShot],
      pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'tester-api'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // The greenlit tester step settles and the merger-less pipeline leaves the task `pr_ready`.
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    // Open the run's step list (the focus view) and route to the finished tester step's window.
    await card.click()
    const testerStep = page.locator('[data-testid="pipeline-step"][data-step-kind="tester-api"]')
    await expect(testerStep).toBeVisible({ timeout: LIVE_TIMEOUT })
    await testerStep.click()

    const dialog = page.getByTestId('tester-report-window')
    const lightbox = page.getByTestId('artifact-lightbox')
    await expect(dialog).toBeVisible()

    // Open the lightbox from the screenshot thumbnail — it teleports to body as a sibling overlay
    // and pushes onto the shared stack, becoming the top overlay above the tester window.
    await dialog.getByTestId('tester-screenshot').first().click()
    await expect(lightbox).toBeVisible()

    // THE reconciliation: Escape is owned by `useModalBehavior`, gated on `isTop()`. The lightbox
    // is top, so it closes FIRST and the owning window survives (its trap was inert while nested).
    await page.keyboard.press('Escape')
    await expect(lightbox).toBeHidden()
    await expect(dialog).toBeVisible()

    // With the lightbox popped, the tester window is top again, so a second Escape closes it —
    // proving the owner's behaviour re-activates once the nested overlay releases the stack.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})
