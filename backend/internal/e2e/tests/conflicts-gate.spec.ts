import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The conflicts gate → conflict-resolver loop. Like the CI gate, the `conflicts` step reads each
// PR's mergeability through a wired provider; a `conflicted` verdict dispatches the
// `conflict-resolver` container agent and re-probes on its completion. This spec drives the loop
// live: a conflicted PR → the resolver round runs → the re-probe merges cleanly → the step
// finishes and the task settles, all over the WebSocket.
//
// The per-workspace mergeability script (`mergeability: ['conflicted','mergeable']`) and the async
// conflict-resolver kind are requested over the fake-profile control channel; the default step-0
// decision is disabled so the run flows straight to the gate.
test.describe('conflicts gate (conflict-resolver loop)', () => {
  test.slow()

  test('a conflicted PR escalates the conflict-resolver, then the conflicts step clears live and the task settles', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder', 'conflict-resolver'],
      pooledContainer: true,
      mergeability: ['conflicted', 'mergeable'],
      pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'conflicts'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    await expect(card).toHaveAttribute('data-status', 'in_progress', { timeout: LIVE_TIMEOUT })
    await card.click()

    // LIVE: the conflicts gate probes `conflicted` → dispatches the resolver → re-probes
    // `mergeable`, so reaching `done` proves the resolver round ran and the re-probe cleared.
    const conflictsStep = page.locator('[data-testid="run-step"][data-step-kind="conflicts"]')
    await expect(conflictsStep).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(conflictsStep).toHaveAttribute('data-step-state', 'done', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })

    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })
})
