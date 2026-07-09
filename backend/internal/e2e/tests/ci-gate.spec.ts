import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The CI gate → ci-fixer loop, an operational GitHub workflow that e2e couldn't reach before
// the gate providers were faked (GitHub is off, so the gate used to pass through as if green).
// A `ci` step reads the PR head's checks through a wired provider; on a RED verdict it dispatches
// the `ci-fixer` container agent and re-probes on its completion. This spec drives the full loop
// live: red CI → the fixer round runs → the re-probe is green → the ci step finishes and the task
// settles, all pushed over the WebSocket with no reload.
//
// The per-workspace CI verdict script (`ciStatus: [false, true]` — red then green after the fixer)
// and the async ci-fixer kind are requested over the fake-profile control channel, so no other
// spec is affected; the default step-0 decision is disabled so the run flows straight to the gate.
test.describe('CI gate (ci-fixer loop)', () => {
  test.slow()

  test('a red CI check escalates the ci-fixer, then the ci step goes green live and the task settles', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder', 'ci-fixer'],
      // A container-reusing runner (the ci-fixer re-dispatch shape), matching the conformance loop.
      pooledContainer: true,
      ciStatus: [false, true],
      pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'ci'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // The run goes live; open the inspector so the step list (with the ci gate) is mounted while
    // the fixer round is still working.
    await expect(card).toHaveAttribute('data-status', 'in_progress', { timeout: LIVE_TIMEOUT })
    await card.click()

    // LIVE: the ci gate step is listed. It probes red → dispatches the ci-fixer → re-probes green,
    // so a script that only ever went red would exhaust the budget and fail — reaching `done` is
    // proof the fixer round ran and recovered.
    const ciStep = page.locator('[data-testid="run-step"][data-step-kind="ci"]')
    await expect(ciStep).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(ciStep).toHaveAttribute('data-step-state', 'done', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })

    // No merger in the pipeline → the task settles at `pr_ready` (the PR is left for a human).
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })
})
