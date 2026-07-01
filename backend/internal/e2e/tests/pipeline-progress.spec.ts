import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The POLLED async-job path (the durable `awaiting_job` loop the container agents run through),
// which `run.spec` — an inline decision-gate run — never touches. An agent kind driven as an
// async job reports `running` polls carrying live subtask counts, which the engine folds onto
// the step and pushes to the SPA. This spec proves that loop drives the UI live: the run's
// step surfaces a subtask bar while it works, then reaches a terminal state.
//
// The coder is made async PER WORKSPACE via the fake-profile control channel
// (`asyncKinds: ['coder']`, several polls), so it doesn't affect any other spec; the default
// step-0 decision is disabled so the run flows straight into the polled coder step.
test.describe('pipeline progress (async job)', () => {
  test.slow()

  test('a polled async step surfaces live subtasks in the inspector and reaches terminal', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder'],
      asyncPolls: 6,
    })
    const pipeline = await createSimplePipeline(request, workspaceId)

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // The run goes live; open the inspector so its run panel (which lists the steps + live
    // subtask counts) is mounted while the coder is still polling.
    await expect(card).toHaveAttribute('data-status', 'in_progress', { timeout: LIVE_TIMEOUT })
    await card.click()

    // LIVE: the coder step is listed and its subtask count is pushed in while it polls.
    const coderStep = page.locator('[data-testid="run-step"][data-step-kind="coder"]')
    await expect(coderStep).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(coderStep.getByTestId('run-subtasks')).toBeVisible({ timeout: LIVE_TIMEOUT })

    // The polled job completes → the coder step reaches `done` and the task reaches a terminal
    // status, all pushed over the WebSocket with no reload.
    await expect(coderStep).toHaveAttribute('data-step-state', 'done', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })
})
