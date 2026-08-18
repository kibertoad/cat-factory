import { test, expect } from './fixtures'
import {
  createSeededWorkspace,
  createSimplePipeline,
  LIVE_TIMEOUT,
  openBoard,
  pinWorkspace,
  RUN_TERMINAL_TIMEOUT,
  selectTask,
  setFakeProfile,
  taskCard,
} from './helpers'

// The everyday delivery loop, driven entirely by hand: author a task, choose the pipeline it
// should run, START it from its card, and STOP it from the inspector.
//
// Every other spec starts runs over REST, because a REST trigger is the deterministic way to reach
// the state a spec is really about. That left the two controls a human actually uses uncovered:
// the card's Start button (which runs the task's PINNED pipeline, so the pin has to have
// round-tripped) and the inspector's Stop (confirm-gated, and distinct from Reset — a stop KEEPS
// the run, so the block lands `blocked` with the run still readable rather than back at `planned`).
//
// The task is created through the real add-task modal, which is also where a human picks the
// pipeline: in basic mode the pipeline picker is the only run option the form still shows, so this
// is the one surface where that choice is made.
test.describe('run controls (start from the board, stop from the inspector)', () => {
  test.slow()

  // This spec seeds its own board instead of taking the `seededBoard` fixture, because the ORDER
  // matters here and nowhere else: the SPA loads the pipeline catalog with the board snapshot, and
  // a pipeline created afterwards is not pushed live — so a spec that needs the PICKER to offer it
  // has to create it before opening the board. Every other spec only ever passes a pipeline id to
  // a REST call, where the SPA never has to know about it.
  test('create a task with a chosen pipeline → Start from its card → Stop from the inspector', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    const workspaceId = snapshot.workspace.id
    // A polled coder with a long job: the run has to STAY in flight long enough to be stopped by
    // hand. An inline fake settles in milliseconds, which would make "stop a running run"
    // unobservable in principle rather than merely flaky. The default step-0 decision is off so
    // the only thing holding the run is the job itself.
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder'],
      asyncPolls: 60,
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder'])
    await pinWorkspace(page, workspaceId)
    await openBoard(page)
    const title = 'E2E hand-driven task'

    // 1) Author the task on the Auth Service frame.
    await taskCard(page, 'blk_auth').getByTestId('frame-add-task').first().click()
    const modal = page.getByTestId('add-task-modal')
    await expect(modal).toBeVisible()
    await modal.getByTestId('add-task-title').fill(title)
    // A description is not decoration here: with none, the pre-dispatch input gate would park the
    // run before its first dispatch (that park is `input-gate.spec`'s subject).
    await modal
      .getByTestId('add-task-description')
      .fill('Add a password reset flow with an emailed one-time link and an expiry window.')

    // 2) Choose the pipeline this task runs — the picker's own popover, by pipeline id. The
    // popover content is teleported out of the modal, so it is located off the page.
    await modal.getByTestId('pipeline-picker-trigger').click()
    const picker = page.getByTestId('pipeline-picker-panel')
    await expect(picker).toBeVisible()
    await picker.getByTestId(`pipeline-option-${pipeline.id}`).click()
    await page.getByTestId('add-task-submit').click()
    await expect(modal).toBeHidden({ timeout: LIVE_TIMEOUT })

    const card = taskCard(page, 'blk_auth').getByTestId('task-card').filter({ hasText: title })
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'planned')

    // 3) Start it from the card. The button runs the task's pinned pipeline, so the run appearing
    // at all is also the proof the pipeline chosen above was recorded on the block.
    await card.getByTestId('task-start').click()
    await expect(card).toHaveAttribute('data-status', 'in_progress', { timeout: LIVE_TIMEOUT })

    // 4) Stop it from the inspector's run panel. Killing a running job discards in-flight work, so
    // the control is confirm-gated exactly like Reset.
    await selectTask(card)
    await page.getByTestId('run-stop').click()
    await page.getByTestId('confirm-accept').click()

    // LIVE: the run is recorded as a retryable failure and the block lands `blocked` — NOT back at
    // `planned`, which is what Reset does (`reset-run.spec`). The distinction is the point: the
    // stopped run is still on the task, which is why the failure surface renders with it.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })
    await expect(card.getByTestId('agent-failure-banner')).toBeVisible({ timeout: LIVE_TIMEOUT })
  })
})
