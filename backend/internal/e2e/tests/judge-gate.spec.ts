import { test, expect } from './fixtures'
// The judge kind, from the package that DEFINES it — the same import the e2e backend registers
// through (`src/fakeJudge.ts`), so the pipeline this spec builds can never name a stale slug.
import { SCOPE_JUDGE_KIND } from '@cat-factory/example-custom-agent'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  openAttention,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// JUDGES: the fourth step-taxonomy bucket (`docs/initiatives/judge-registry.md`), and the only
// one with no e2e coverage. A judge scores the work against a rubric, the engine compares it to
// the task's threshold, and then disposes: advance, BOUNCE the producing step with the findings as
// its rework brief, park for a human, or fail.
//
// Two things make this worth driving through the assembled product rather than leaving it to the
// conformance suite. First, a registered judge is only reachable at all because the workspace
// capability manifest carries it with `resultView: 'judge'` — no frontend code names
// `scope-adherence`, so the palette merge + result-view dispatch are the product behaviour under
// test. Second, the park's decision (proceed / bounce / stop) is answered FROM that window.
//
// The judge under test is the SHIPPED example (`@cat-factory/example-custom-agent`'s
// `scope-adherence`), registered on the e2e backend through the same public seam a deployment
// uses, with its own valibot verdict parser. Its verdicts come from the per-workspace
// `judgeScores` script (`src/fakeJudge.ts`); the default preset's threshold is 0.7 with a bounce
// budget of 1, so `[0.4, 0.9]` is one bounce then a pass and `[0.4, 0.4]` spends the budget and
// parks.
test.describe('registered judge (rubric verdict gate)', () => {
  test.slow()

  const judgeStep = (page: import('@playwright/test').Page) =>
    page.locator(`[data-testid="run-step"][data-step-kind="${SCOPE_JUDGE_KIND}"]`)

  test('a failing verdict bounces the coder, and the re-judged work passes live', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      // Async so the bounce actually re-dispatches a polled job (the shape a real rework round
      // takes) rather than resolving inline inside one advance.
      asyncKinds: ['coder'],
      pooledContainer: true,
      judgeScores: [0.4, 0.9],
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', SCOPE_JUDGE_KIND])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(card).toHaveAttribute('data-status', 'in_progress', { timeout: LIVE_TIMEOUT })
    await card.click()

    // LIVE: the judge step is listed (proof the manifest-registered kind reached the SPA at all)
    // and reaches `done`.
    await expect(judgeStep(page)).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(judgeStep(page)).toHaveAttribute('data-step-state', 'done', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    // …and the bounce is asserted on the ENGINE'S OWN RECORD of it, not inferred from the run
    // having finished. `done` alone does not distinguish "failed, bounced, then passed" from
    // "passed on the first look": the verdict script is a queue read once per assessment, so any
    // extra or retried assessment shifts it, and a run that never bounced would reach exactly this
    // state. The round history is the fact that separates them, and it outlives the run, so this
    // reads it after the terminal rather than racing a transient step state.
    await judgeStep(page).getByTestId('run-step-open').click()
    const dialog = page.getByTestId('result-window')
    await expect(dialog.getByTestId('judge-round')).toHaveCount(2)
    await expect(dialog.getByTestId('judge-round').first()).toHaveAttribute(
      'data-round-disposition',
      'pass',
    )
    await expect(dialog.getByTestId('judge-round').last()).toHaveAttribute(
      'data-round-disposition',
      'bounce',
    )
  })

  test('a spent bounce budget parks for a human; the judge window shows the verdict and Proceed advances the run', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder'],
      pooledContainer: true,
      // Fails both rounds: bounce once, then the budget is spent — which must PARK, never
      // silently advance (a judge that gave up has to say so to a human).
      judgeScores: [0.4, 0.4],
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', SCOPE_JUDGE_KIND])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the run parks on the verdict. The park rides `step.approval`, so the card offers its
    // generic attention affordance — which must route to the JUDGE window, because the generic
    // approve path cannot answer this park.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })
    const dialog = page.getByTestId('result-window')
    await openAttention(card, dialog)

    // The window renders the verdict the assessor produced: the score line, the rubric findings,
    // and the decision rail (which is shown ONLY while the run is actually parked on it).
    await expect(dialog.getByTestId('judge-status')).toBeVisible()
    await expect(dialog.getByTestId('judge-score')).toContainText('40')
    await expect(dialog.getByTestId('judge-finding')).toContainText('Out-of-scope change')
    await expect(dialog.getByTestId('judge-decision')).toBeVisible()

    // Proceed anyway: the human overrules the rubric and the run carries on.
    await dialog.getByTestId('judge-proceed').click()
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
  })
})
