import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The Tester→Fixer loop, an agent retry loop that existed in the canonical fake but couldn't be
// reached from a spec until the FakeProfile was widened to carry `testReports`. A `tester` step
// returns a structured report; when it withholds its greenlight the engine dispatches the `fixer`
// (a container agent, under the tester step) and re-tests on its completion. This spec drives the
// loop live: a first report that finds a bug → the fixer round → a second, greenlit report → the
// tester step finishes and the task settles.
//
// The report sequence (`testReports: [notGreen, green]`) + the async tester/fixer kinds are
// requested over the fake-profile control channel; a red-first sequence that never recovered would
// exhaust the fixer budget and leave the run stuck, so reaching `pr_ready` proves the loop
// re-tested. The default step-0 decision is disabled so the run flows straight to the tester.
test.describe('Tester→Fixer loop', () => {
  test.slow()

  test('a withheld greenlight loops the fixer, then the second report greenlights live and the task settles', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const notGreen = {
      greenlight: false,
      summary: 'found a bug',
      tested: ['login'],
      outcomes: [{ name: 'login', status: 'failed', detail: 'returns 500' }],
      concerns: [{ title: 'Login 500', detail: 'unhandled error', severity: 'high' }],
    }
    const green = {
      greenlight: true,
      summary: 'all good',
      tested: ['login'],
      outcomes: [{ name: 'login', status: 'passed' }],
      concerns: [],
    }
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder', 'tester-api', 'fixer'],
      asyncPolls: 1,
      // A container-reusing runner (the fixer re-dispatch shape) — mirrors the conformance loop.
      pooledContainer: true,
      testReports: [notGreen, green],
      pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'tester-api'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    await expect(card).toHaveAttribute('data-status', 'in_progress', { timeout: LIVE_TIMEOUT })
    await card.click()

    // LIVE: the tester step is listed; it withholds its greenlight (dispatching the fixer), then the
    // re-test greenlights, so it only reaches `done` if the loop truly re-tested.
    const testerStep = page.locator('[data-testid="run-step"][data-step-kind="tester-api"]')
    await expect(testerStep).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(testerStep).toHaveAttribute('data-step-state', 'done', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })

    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })
})
