import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  createTask,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The implementation-fork decision phase on the Coder step. When the per-task tri-state forces
// it (`coder.forkDecision: always`), a read-only proposer surfaces materially different ways to
// implement the task and the run PARKS for a human to pick one, enter their own approach, or CHAT
// about the forks first. This spec drives that whole live loop through the real SPA: the run
// parks → the fork window shows the surfaced approaches → the human chats (the grounded reply,
// canned here since no model is wired, is pushed live) → the human chooses → the run resumes.
//
// The proposer's structured forks are requested over the fake-profile control channel
// (`customResult`); the default step-0 decision is disabled so the run flows straight into the
// fork phase.
test.describe('implementation-fork decision', () => {
  test.slow()

  test('run parks on the fork phase → chat + choose in the window → run resumes', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      customResult: {
        seamSummary: 'the login mapper seam',
        forks: [
          {
            title: 'Patch the call site',
            summary: 'targeted fix',
            approach: 'edit AuthController directly',
            tradeoffs: ['fast', 'localized'],
            recommended: true,
          },
          {
            title: 'Refactor the seam',
            summary: 'introduce an abstraction',
            approach: 'extract a SessionGateway',
            tradeoffs: ['cleaner', 'wider blast radius'],
          },
        ],
        singlePath: false,
      },
    })

    // A task that always proposes forks, plus a coder-only pipeline.
    const task = await createTask(request, workspaceId, 'blk_auth', 'Fork decision task', {
      agentConfig: { 'coder.forkDecision': 'always' },
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder'])

    const card = taskCard(page, task.id)
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })
    await startRun(request, workspaceId, task.id, pipeline.id)

    // The proposer surfaces two forks → the run parks `blocked`, pushed live.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })

    // LIVE: a `fork_decision_pending` card lands in the inbox; opening it reveals the window.
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="fork_decision_pending"]',
    )
    await expect(item).toBeVisible({ timeout: LIVE_TIMEOUT })
    await item.locator('button').first().click()

    // The fork-decision window shows both surfaced approaches.
    const window = page.getByTestId('fork-decision-window')
    await expect(window).toBeVisible()
    await expect(window.getByTestId('fork-option-card')).toHaveCount(2)

    // Chat about the forks: the human turn appears immediately, and the (canned, no-model) reply
    // is pushed live once the durable driver computes it — proving the chat re-park round-trips.
    await window.getByTestId('fork-chat-input').fill('Which approach is safer?')
    await window.getByTestId('fork-chat-send').click()
    await expect
      .poll(async () => await window.getByTestId('fork-chat-message').count(), {
        timeout: LIVE_TIMEOUT,
      })
      .toBeGreaterThanOrEqual(2)

    // Choose the first surfaced approach; the window flips to its read-only "chosen" record and
    // the Coder (Phase B) runs to a terminal state (the card status is a DOM attribute, readable
    // even while the window overlay is still mounted).
    await window.getByTestId('fork-option-card').first().click()
    await window.getByTestId('fork-option-choose').click()

    await expect
      .poll(async () => await card.getAttribute('data-status'), { timeout: RUN_TERMINAL_TIMEOUT })
      .toMatch(/^(pr_ready|done)$/)
  })
})
