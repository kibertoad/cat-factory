import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The unified agent-run FAILURE + RETRY surface. When a container/runner never accepts an
// agent job, the run faults with `failureKind: 'dispatch'` and the block is left `blocked`
// with the shared `<AgentFailureCard>` (banner + retry) — the SAME surface a failed bootstrap
// uses. Nothing else in the suite exercises a FAILED run through the real SPA, so this proves
// the failure banner is pushed live and the retry control is wired.
//
// The dispatch throw is requested PER WORKSPACE via the fake-profile control channel
// (`dispatchThrowKinds: ['coder']`), so it can't affect any other spec sharing the backend. We
// also disable the default step-0 decision so the run reaches the coder step and faults there.
test.describe('agent run failure + retry', () => {
  test('a dispatch failure surfaces the live failure banner + retry on the card', async ({
    page,
    request,
    seededBoard,
  }) => {
    // The retry re-drives the run through the durable driver a second time, so give the
    // test the same tripled budget the other run-to-terminal specs use.
    test.slow()
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      dispatchThrowKinds: ['coder'],
    })
    const pipeline = await createSimplePipeline(request, workspaceId)

    const card = taskCard(page, 'task_login')
    await expect(card).toHaveAttribute('data-status', 'planned')

    // Kick the run; the coder's container dispatch throws, so the run faults and the block
    // is left `blocked` — pushed live, no reload.
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })

    // LIVE: the shared failure banner + retry render on the card, tagged as an `execution` run
    // (the same component a failed bootstrap shows).
    const banner = card.getByTestId('agent-failure-banner')
    await expect(banner).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(banner).toHaveAttribute('data-run-kind', 'execution')

    // Open the task inspector BEFORE retrying. The run's PRIOR-ATTEMPT error trail renders
    // there, and it is the durable evidence a retry re-drove the run; nothing has been retried
    // yet, so there is no trail (this run's only failure is the live one on the banner above).
    // The panel is a floating right-hand sheet, so the board card stays clickable underneath;
    // the click is aimed at the card's top-left meta row so it can never land on the retry
    // button sitting in the banner below.
    await card.click({ position: { x: 4, y: 4 } })
    const inspector = page.getByTestId('inspector-panel')
    await expect(inspector).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(inspector.getByTestId('agent-failure-history')).toHaveCount(0)

    // The retry control is wired: clicking it re-drives the run. `carryForwardFailures` moves the
    // outgoing attempt's failure onto the run's preserved trail and mints the fresh attempt with
    // `failure` CLEARED, so a trail holding exactly the ONE superseded attempt proves the click
    // was actually HANDLED, not a no-op that leaves the stale banner in place (a bare "banner
    // still visible" would pass even if nothing happened).
    //
    // That trail is PERSISTED run state, which is why it is asserted here instead of the button's
    // in-flight `retrying` (disabled) transient: the retry POST plus its snapshot refresh settle
    // in a few tens of milliseconds, inside a single web-first poll interval, so the disabled
    // state is unobservable in principle and asserting it was a race CI eventually lost.
    const retry = banner.getByTestId('agent-failure-retry')
    await expect(retry).toBeEnabled()
    await retry.click()

    const history = inspector.getByTestId('agent-failure-history')
    await expect(history).toBeVisible({ timeout: LIVE_TIMEOUT })
    // Expand the disclosure (its own `summary` is the first one; each entry nests another for
    // its detail) so the superseded error is genuinely readable, then pin the trail's length:
    // zero would mean nothing re-dispatched, two that the click fired twice.
    await history.locator('summary').first().click()
    const priorErrors = history.getByTestId('agent-failure-history-entry')
    await expect(priorErrors).toHaveCount(1)
    await expect(priorErrors).toBeVisible()

    // The dispatch still throws, so the second attempt faults too: the block settles `blocked`
    // and the banner (unmounted the moment the retry cleared `failure`) is pushed back live.
    // The `pageErrors` fixture proves no SPA exception anywhere along the way.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })
    await expect(banner).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })
  })
})
