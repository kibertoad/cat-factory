import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// "READ THE RESULT": the outcome card every finished run lands on, and the only surface that
// answers "what did this change, and what backs that up" without reading a diff.
//
// It is a REDUCTION over state other producers recorded — the tester's report, its per-requirement
// verdicts, the run's checks, the PR on the block — and it is the highest-traffic result surface in
// the product: in basic mode it is what the card's one result affordance opens. That makes it the
// one window where a producer whose output stopped arriving is INVISIBLE: a section with nothing to
// show still renders, and the whole design point (`runOutcome.ts` rule 2) is that "absent" and
// "clean" must not look alike. The pure reduction is unit-tested; what only the assembled product
// shows is whether the run's REAL recorded state reaches it at all — that the ids the tester wrote,
// the verdicts it ruled, the concern it raised and the PR it opened arrive in the right sections
// rather than in a section reading empty because nothing was joined to it.
//
// The tester's report (including its requirement verdicts) is scripted over the fake-profile
// channel; the pipeline deliberately has no merger, so the task settles at `pr_ready` and its card
// survives to be clicked (a `done` task renders no card — see the suite README).
test.describe('run outcome summary (read the result)', () => {
  test.slow()

  test('a finished run reads back as its outcome: verdicts, tests, concern and the PR', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // A report that CLEARS the change and is still not uniformly clean: everything it ran passed,
    // but one requirement went unchecked and one advisory concern stands. That combination is the
    // interesting one, and it has to be built deliberately: the engine re-derives the greenlight
    // (`TesterController`), so a failed outcome or a high concern would withhold it and route the
    // run into the fixer loop instead of settling — a different flow, covered by `tester-fixer.spec`.
    // A `low` concern and a `not_covered` verdict are advisory and leave the greenlight standing.
    const report = {
      greenlight: true,
      summary: 'Login works end to end; the lockout path is not implemented yet.',
      tested: ['login', 'lockout'],
      outcomes: [{ name: 'login', status: 'passed' }],
      concerns: [
        {
          title: 'Lockout unimplemented',
          detail: 'Repeated failures are not throttled.',
          severity: 'low',
        },
      ],
      requirementVerdicts: [
        {
          requirementId: 'req-login-happy-path',
          status: 'met',
          detail: 'Signed in with a valid password.',
        },
        {
          requirementId: 'req-login-lockout',
          status: 'not_covered',
          detail: 'Not exercised: there is no lockout to test yet.',
        },
      ],
    }
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder', 'tester-api'],
      asyncPolls: 1,
      testReports: [report],
      pullRequest: { url: 'https://github.com/o/r/pull/7', number: 7, branch: 'feat/login' },
    })
    // No merger: the run settles at `pr_ready` with the PR open, which is the state a human
    // actually reads a result in (a merged task has left the board).
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'tester-api'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    // The card offers the result to READ — the basic-mode route to a finished run, offered because
    // the run actually recorded something to show.
    await card.getByTestId('task-open-outcome').click()
    const body = page.getByTestId('outcome-body')
    await expect(body).toBeVisible({ timeout: LIVE_TIMEOUT })

    // Where the work stands, and the way to the code: a run whose PR is open but unmerged.
    await expect(body.getByTestId('outcome-disposition')).toHaveText(/waiting to be merged/i)
    await expect(body.getByTestId('outcome-pr-link')).toContainText('7')
    // What was ASKED is the task's own description (here the seeded `task_login`'s), so the reader
    // sees the request beside the result rather than having to hold it in their head.
    await expect(body.getByTestId('outcome-ask')).toContainText(
      'Issue a session on valid credentials.',
    )

    // REQUIREMENT COVERAGE: one row per verdict the tester returned, each carrying what was
    // observed. This is the section that would read as a clean pass if the verdicts never arrived.
    const requirements = body.getByTestId('outcome-requirements')
    const rows = requirements.getByTestId('outcome-requirement')
    await expect(rows).toHaveCount(2)
    // A verified requirement sorts ahead of an unchecked one, and each row carries what the tester
    // observed — the UNCHECKED one included, which is the row a clean-looking report hides.
    await expect(rows.nth(0)).toContainText('req-login-happy-path')
    await expect(rows.nth(1)).toContainText('req-login-lockout')
    await expect(rows.nth(1)).toContainText('Not exercised: there is no lockout to test yet.')
    await expect(requirements).toContainText('Met: 1')
    await expect(requirements).toContainText('Not checked: 1')
    // The ids are all this card has: the service's `spec/` was never read, so the section SAYS so
    // rather than letting a slug read as the name someone gave a requirement. Nor is this a
    // REGRESSION: a regression is an `established` requirement observed to fail, and without the
    // spec there is no established state to have broken — so the badge must be absent, not assumed.
    await expect(requirements.getByTestId('outcome-spec-note')).toBeVisible()
    await expect(requirements.getByTestId('outcome-requirement-regression')).toHaveCount(0)
    await expect(body.getByTestId('outcome-regressions')).toHaveCount(0)

    // HOW IT WAS TESTED: the tester's own verdict, plus the advisory concern that stands despite
    // the greenlight. A card that showed only the verdict would report this run as unqualified.
    const tests = body.getByTestId('outcome-tests')
    await expect(tests.getByTestId('outcome-tests-verdict')).toBeVisible()
    await expect(tests).toContainText('lockout path is not implemented')
    const concerns = tests.getByTestId('outcome-concern')
    await expect(concerns).toHaveCount(1)
    await expect(concerns.first()).toContainText('Lockout unimplemented')
  })
})
