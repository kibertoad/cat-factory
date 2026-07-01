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

    // The retry control is wired: clicking it re-drives the run. The handler flips the button
    // into its in-flight `retrying` state (disabled) while the re-dispatch + snapshot refresh
    // round-trip — asserting that transient proves the click was actually HANDLED, not a no-op
    // that leaves the stale banner in place (a bare "banner still visible" would pass even if
    // nothing happened). The dispatch still throws, so the run faults a second time and settles
    // `blocked` with the banner live again; the `pageErrors` fixture proves no SPA exception.
    const retry = banner.getByTestId('agent-failure-retry')
    await expect(retry).toBeEnabled()
    await retry.click()
    await expect(retry).toBeDisabled()
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })
    await expect(banner).toBeVisible()
  })
})
