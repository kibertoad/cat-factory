import { test, expect } from './fixtures'
import {
  createSimplePipeline,
  createTask,
  LIVE_TIMEOUT,
  openAttention,
  RUN_TERMINAL_TIMEOUT,
  selectTask,
  setFakeProfile,
  startRun,
  taskCard,
  updateTask,
} from './helpers'

// The PRE-DISPATCH INPUT GATE: the very first thing every run does, and the platform's cheapest
// refusal. A task whose authored input states nothing an agent could act on parks the run BEFORE
// the first dispatch, having spent nothing, and names which field is missing
// (`docs/initiatives/pre-dispatch-input-gate.md`).
//
// It is the one park that turns on the shape of the TASK rather than the pipeline, so no other
// spec reaches it: every REST-seeded fixture task carries a description precisely so it doesn't
// (see `createTask`). Both exits are driven here, because a gate whose only exit is "ignore me"
// is a gate that cannot be satisfied:
//
//   - `proceed` WAIVES the findings — and the waiver stays on the run, which is why the notice
//     re-renders as `waived` rather than disappearing.
//   - `recheck` RE-EVALUATES the task as it now stands, so the run is released only because the
//     description was actually filled in.
//
// Both assert on the verdict the run PERSISTED (the notice's `data-tone` + the finding's
// `data-issue-code`), never on an in-flight button state.
test.describe('pre-dispatch input gate', () => {
  test.slow()

  /**
   * Seed a task with NO description, start a run against it, and return the card once the gate
   * has parked it. `decisionOnSteps: []` disables the fake agent's default step-0 decision, so
   * `blocked` here can only be the gate: the run never reaches a dispatch.
   */
  async function parkOnGate(
    page: import('@playwright/test').Page,
    request: import('@playwright/test').APIRequestContext,
    workspaceId: string,
    title: string,
  ) {
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [] })
    const pipeline = await createSimplePipeline(request, workspaceId)
    const task = await createTask(request, workspaceId, 'blk_auth', title, { description: '' })
    const card = taskCard(page, task.id)
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })

    await startRun(request, workspaceId, task.id, pipeline.id)
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })

    // The notice lives on the inspector's run panel, above the step list: the remedy for this
    // park is to go and edit the task, which is a board action, so it is a plain notice rather
    // than an overlay. Scoped to the inspector because the SAME notice also renders in the
    // step-detail rail (the third test opens both at once).
    await selectTask(card)
    const notice = page.getByTestId('inspector-panel').getByTestId('input-gate-notice')
    await expect(notice).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(notice).toHaveAttribute('data-tone', 'blocked')
    // The finding NAMES the missing input — the whole point of a deterministic gate over a
    // reviewer that would have spent a model call to say the same thing.
    await expect(
      notice.locator('[data-testid="input-gate-issue"][data-issue-code="description_missing"]'),
    ).toHaveAttribute('data-issue-severity', 'blocking')
    return { card, taskId: task.id, notice }
  }

  test('an empty task parks the run before its first dispatch; Proceed waives it and the run advances', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const { card, notice } = await parkOnGate(page, request, workspaceId, 'E2E gate: waive')

    await notice.getByTestId('input-gate-proceed').click()

    // LIVE: the verdict flips to `overridden`, which the notice renders as `waived` — the run
    // KEEPS what was waived, because it is part of what explains the output. Asserting the tone
    // (not the button, which unmounts) is what proves the click was recorded.
    await expect(notice).toHaveAttribute('data-tone', 'waived', { timeout: LIVE_TIMEOUT })
    // …and the run it was holding actually runs: the task settles on its merger-less terminal.
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })

  test('Recheck releases the run once the task states something to act on', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const { card, taskId, notice } = await parkOnGate(page, request, workspaceId, 'E2E gate: fix')

    // Fix the task the way a human would, then ask the gate to look again. The description is
    // deliberately more than five words: a shorter one is an ADVISORY `description_thin` finding,
    // which releases the run but keeps a notice up — a different (and correct) outcome that would
    // make the assertion below ambiguous.
    await updateTask(request, workspaceId, taskId, {
      description: 'Add a password reset flow with an emailed one-time link and an expiry window.',
    })
    await notice.getByTestId('input-gate-recheck').click()

    // LIVE: re-evaluating the edited task finds nothing, and a clean `passed` verdict has nothing
    // to tell a human — so the notice goes away entirely rather than lingering as a record.
    await expect(notice).toBeHidden({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })

  test('the park opens the step RAIL, never a result window: the gate judges work that has not run', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const { card } = await parkOnGate(page, request, workspaceId, 'E2E gate: routing')

    // The park rides `step.approval`, so it reaches the SAME generic affordance every approval
    // gate uses — and that affordance dispatches on the step. This is the one dedicated park with
    // no window of its own: routing it to its step's usual result view would open a window about
    // work that has not happened yet, which is why `dispatchStepView` special-cases it.
    const rail = page.getByTestId('step-detail')
    await openAttention(card, rail)
    await expect(rail.getByTestId('input-gate-notice')).toBeVisible()
    await expect(page.getByTestId('result-window')).toBeHidden()
  })
})
