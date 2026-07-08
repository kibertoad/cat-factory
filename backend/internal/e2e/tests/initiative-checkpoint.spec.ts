import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  approveStep,
  createInitiative,
  createSimplePipeline,
  findParkedApproval,
  getInitiative,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// Slice 3 of custom-initiative-definitions (D2): the assembled-product proof of a phase CHECKPOINT.
// A planner-authored `checkpoint: true` phase PAUSES the initiative once all its items settle,
// before the next phase spawns; a human reviews the phase output in the tracker window, then resumes
// (GO) to let the next phase proceed — or cancels (NO_GO). Asserted only on live, WebSocket-pushed
// UI, per the e2e spec shape. See docs/initiatives/custom-initiative-definitions.md.
//
// Reuses the existing seams (no new ones): the `FakeProfile.initiativePlan` planner seam, the
// built-in `preset_generic` full-interview planning path (the converging fake inline interviewer +
// a planner human gate approved over REST, exactly like the tech-migration preset e2e), and a
// merger-tailed WORKSPACE pipeline so each spawned item reaches `done` — the terminal state that
// fires the checkpoint (a merger with no PR merger wired degrades to a board-only flip to `done`).

// The plan the fake `initiative-planner` returns: two phases, phase one flagged `checkpoint: true`.
// `preset_generic` declares no phase template, so the planner's phases pass through the ingest
// normalizer unchanged and the checkpoint flag is honored generically (no preset needed). Each item
// routes to the merger-tailed pipeline via `policy.defaultPipelineId` (its id is only known at
// runtime, so the plan is built after the pipeline is created).
function checkpointPlan(pipelineId: string) {
  return {
    goal: 'A two-phase initiative with a human review checkpoint after phase one.',
    analysisSummary: 'Phase one produces output to review before phase two is allowed to proceed.',
    phases: [
      { id: 'phase-one', title: 'Phase one', checkpoint: true },
      { id: 'phase-two', title: 'Phase two' },
    ],
    items: [
      {
        id: 'itm_p1',
        phaseId: 'phase-one',
        title: 'Complete the phase-one work',
        description: 'The first phase of the initiative — its output gates the checkpoint.',
      },
      {
        id: 'itm_p2',
        phaseId: 'phase-two',
        title: 'Complete the phase-two work',
        description: 'The second phase — must not spawn until the checkpoint is cleared.',
      },
    ],
    policy: { maxConcurrent: 2, defaultPipelineId: pipelineId, rules: [] },
  }
}

/**
 * Drive the shared setup both specs need: plan a two-phase checkpoint initiative on a merger-tailed
 * pipeline, run the full generic planning flow, approve the planner gate, and wait for phase one to
 * settle so the checkpoint PAUSES the initiative. Returns the anchor block + its board card, left at
 * the paused checkpoint with phase two NOT yet spawned (the gate proven off the live snapshot).
 */
async function driveToCheckpointPause(page: Page, request: APIRequestContext, workspaceId: string) {
  // A merger-tailed pipeline so a spawned item reaches `done` (confidence 1 ⇒ auto-merge → `done`).
  const pipeline = await createSimplePipeline(request, workspaceId, [
    'architect',
    'coder',
    'merger',
  ])

  // Disable the default one-shot agent decision gate (so spawned items don't park), report high
  // confidence (auto-merge), and feed the planner the two-phase checkpoint plan. Set BEFORE the run.
  await setFakeProfile(request, workspaceId, {
    decisionOnSteps: [],
    confidence: 1,
    initiativePlan: checkpointPlan(pipeline.id),
  })

  // Create the initiative from the built-in generic preset (no fields). Its anchor card arrives
  // on the board live via `initiative-added`.
  const { block } = await createInitiative(request, workspaceId, 'blk_auth', 'preset_generic')
  const card = page.getByTestId('initiative-card')
  await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })

  // Start the generic full-interview planning pipeline. The fake inline interviewer converges on
  // its first pass → analyst → planner returns the plan → the run PARKS at the planner human gate.
  await startRun(request, workspaceId, block.id, 'pl_initiative')

  // Approve the parked planner gate over REST (no SPA affordance exposes it for an initiative block).
  let approval: Awaited<ReturnType<typeof findParkedApproval>> = null
  await expect
    .poll(
      async () => {
        approval = await findParkedApproval(request, workspaceId, block.id, 'initiative-planner')
        return approval !== null
      },
      { timeout: RUN_TERMINAL_TIMEOUT },
    )
    .toBe(true)
  await approveStep(request, workspaceId, approval!)

  // The committer flips the initiative to `executing`; the loop spawns phase one's item, which runs
  // architect → coder → merger → `done`. That settles the checkpoint phase, so the loop PAUSES the
  // initiative for review — pushed live to the anchor card's status.
  await expect(card).toHaveAttribute('data-status', 'paused', { timeout: RUN_TERMINAL_TIMEOUT })

  // The checkpoint genuinely GATED phase two: the initiative is paused and phase two's item has not
  // spawned (no block yet). Asserted off the same snapshot the SPA hydrates from.
  const paused = await getInitiative(request, workspaceId, block.id)
  expect(paused?.status).toBe('paused')
  expect(paused?.items.find((i) => i.phaseId === 'phase-two')?.blockId ?? null).toBeNull()

  return { block, card }
}

test.describe('initiative phase checkpoint', () => {
  // Each spec drives a full planning run (interviewer → analyst → planner → gate → committer) then a
  // loop wave to the pause — many durable pg-boss steps — so give it the slow budget.
  test.slow()

  test('a checkpoint phase pauses the initiative; resume spawns the next phase', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const { block, card } = await driveToCheckpointPause(page, request, workspaceId)

    // Open the tracker: the checkpoint pause banner explains the wait, and the phase-one header shows
    // the "awaiting review" checkpoint badge — the review surface the human acts from.
    await card.getByTestId('initiative-open-tracker').click()
    await expect(page.getByTestId('initiative-tracker-window')).toBeVisible({
      timeout: LIVE_TIMEOUT,
    })
    await expect(page.getByTestId('initiative-checkpoint-pause')).toBeVisible()
    await expect(page.getByTestId('initiative-phase-checkpoint-phase-one')).toBeVisible()

    // Resume (GO) from the banner. The loop clears the checkpoint and advances to phase two.
    await page.getByTestId('initiative-checkpoint-resume').click()

    // LIVE: phase two's item spawns (its block id appears on the snapshot), and its task card lands
    // on the board — the proof that resume let the gated next phase proceed.
    let phaseTwoBlockId: string | null = null
    await expect
      .poll(
        async () => {
          const ini = await getInitiative(request, workspaceId, block.id)
          phaseTwoBlockId = ini?.items.find((i) => i.phaseId === 'phase-two')?.blockId ?? null
          return phaseTwoBlockId
        },
        { timeout: RUN_TERMINAL_TIMEOUT },
      )
      .not.toBeNull()
    await expect(taskCard(page, phaseTwoBlockId!)).toBeVisible({ timeout: LIVE_TIMEOUT })
  })

  test('cancel from the checkpoint stops the initiative; the next phase never spawns', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const { block, card } = await driveToCheckpointPause(page, request, workspaceId)

    // Open the tracker and act on the NO_GO path: Cancel from the same checkpoint pause banner.
    await card.getByTestId('initiative-open-tracker').click()
    await expect(page.getByTestId('initiative-tracker-window')).toBeVisible({
      timeout: LIVE_TIMEOUT,
    })
    await expect(page.getByTestId('initiative-checkpoint-pause')).toBeVisible()
    await page.getByTestId('initiative-checkpoint-cancel').click()

    // LIVE: cancel is terminal — the anchor card flips to `cancelled` over the WebSocket.
    await expect(card).toHaveAttribute('data-status', 'cancelled', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })

    // The gated phase two never spawned: cancel STOPS the initiative, it does not defer to a resume.
    const cancelled = await getInitiative(request, workspaceId, block.id)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.items.find((i) => i.phaseId === 'phase-two')?.blockId ?? null).toBeNull()
  })
})
