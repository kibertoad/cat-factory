import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  findPipelineByName,
  openAttention,
  setFakeProfile,
  taskCard,
} from './helpers'

// The AUTHORING half of the delivery loop: a pipeline drawn by hand in the real builder, then run.
//
// A pipeline is the platform's central object — every run is one — and every other spec creates
// them over REST (`createSimplePipeline`), which is exactly the layer that cannot fail the way this
// surface does. The builder holds a DRAFT in a store (an ordered kind list plus a set of parallel
// per-step flag arrays), assembles a wire payload from it on save, and the engine then reads those
// arrays back to decide what to dispatch and where to stop. Nothing in between checks that the
// three agree: a draft flag written at the wrong index, dropped from the payload, or realigned by
// the companion/enabled bookkeeping produces a pipeline that saves cleanly, looks right in the
// list, and runs differently from the picture the human drew.
//
// So the assertion is not that the builder saved something — it is that the ONE step the human
// gated is the step the run stops on. The gate is what makes that observable at all: it is a
// human checkpoint at a named position, so a draft/payload misalignment surfaces as the run
// parking on the wrong step (or not parking), rather than as a silently different chain.
test.describe('pipeline builder (author a pipeline by hand, then run it)', () => {
  // Authors a pipeline, then drives a full two-step run through a human gate.
  test.slow()

  test('draw architect → coder with a gate on the architect → the run stops exactly there', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // Only the AUTHORED gate should hold this run: the e2e backend's default one-shot decision on
    // step 0 would park the architect first for an unrelated reason, and then "the run stopped at
    // the architect" would no longer be evidence the drawn gate exists at all.
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [] })
    const name = 'E2E hand-drawn pipeline'

    // 1) Open the builder from the sidebar (a basic-mode destination — authoring a flow is part of
    //    the everyday loop, so it is NOT behind the advanced tier).
    await page.getByTestId('nav-build-pipeline').click()
    const palette = page.getByTestId('pipeline-builder-palette')
    await expect(palette).toBeVisible({ timeout: LIVE_TIMEOUT })
    await page.getByTestId('pipeline-builder-name').fill(name)

    // 2) Add the two steps, in order, from the agent palette. Both are `basic`-tier kinds, so they
    //    are offered at the palette's default tier without widening it.
    await palette.getByTestId('palette-agent-architect').click()
    await palette.getByTestId('palette-agent-coder').click()
    const draft = page.getByTestId('pipeline-builder-draft')
    const steps = draft.getByTestId('pipeline-draft-step')
    await expect(steps).toHaveCount(2)
    // The drawn ORDER is what the engine dispatches in, so it is asserted here rather than
    // inferred from the run: a reversed chain would still park at a gate, just the wrong one.
    await expect(steps.nth(0)).toHaveAttribute('data-agent-kind', 'architect')
    await expect(steps.nth(1)).toHaveAttribute('data-agent-kind', 'coder')

    // 3) Put a human approval gate on the FIRST step only.
    await steps.nth(0).getByTestId('pipeline-step-gate').click()
    await expect(steps.nth(0)).toHaveAttribute('data-gated', 'true')
    await expect(steps.nth(1)).toHaveAttribute('data-gated', 'false')

    await page.getByTestId('pipeline-builder-save').click()
    // Saving closes the builder — the one signal the save resolved rather than toasted an error.
    await expect(palette).toBeHidden({ timeout: LIVE_TIMEOUT })

    // 4) The persisted wire shape carries the drawing: the ordered kinds and the gate on index 0.
    //    Read back over REST because the id is minted backend-side and never rendered, and the
    //    task's pipeline picker addresses its options BY id.
    const saved = await findPipelineByName(request, workspaceId, name)
    expect(saved).not.toBeNull()
    expect(saved!.agentKinds).toEqual(['architect', 'coder'])
    expect(saved!.gates?.[0]).toBe(true)
    expect(saved!.gates?.[1]).not.toBe(true)

    // 5) Author a task that runs it. The picker offers the just-saved pipeline with no reload
    //    (the builder upserts it into the same store the picker reads), which is itself the proof
    //    a human can use a flow the moment they finish drawing it.
    await taskCard(page, 'blk_auth').getByTestId('frame-add-task').first().click()
    const modal = page.getByTestId('add-task-modal')
    await expect(modal).toBeVisible()
    await modal.getByTestId('add-task-title').fill('E2E task on the hand-drawn pipeline')
    // Without a description the pre-dispatch input gate parks the run before its first dispatch
    // (that park is `input-gate.spec`'s subject), and this run would never reach the architect.
    await modal
      .getByTestId('add-task-description')
      .fill('Add a password reset flow with an emailed one-time link and an expiry window.')
    await modal.getByTestId('pipeline-picker-trigger').click()
    const picker = page.getByTestId('pipeline-picker-panel')
    await expect(picker).toBeVisible()
    await picker.getByTestId(`pipeline-option-${saved!.id}`).click()
    await page.getByTestId('add-task-submit').click()
    await expect(modal).toBeHidden({ timeout: LIVE_TIMEOUT })

    const card = taskCard(page, 'blk_auth')
      .getByTestId('task-card')
      .filter({ hasText: 'E2E task on the hand-drawn pipeline' })
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })

    // 6) Start it from the card and let it reach the gate.
    await card.getByTestId('task-start').click()

    // LIVE: the run parks for APPROVAL (not a decision) — the card's attention affordance reads
    // "Approve", which is the drawn gate arriving in the browser.
    await expect(card.getByTestId('task-resolve')).toHaveText(/approve/i, {
      timeout: RUN_TERMINAL_TIMEOUT,
    })

    // 7) The park is on the ARCHITECT, the step that was gated. Asserted on the step rail the
    //    affordance opens, so a gate that landed on the coder instead (the misalignment this spec
    //    exists for) fails here rather than passing as "a run that parked somewhere".
    // The rail is scoped to ONE step and names it in its heading, so this reads the parked step
    // itself rather than any prose that happens to mention an architect.
    const detail = page.getByTestId('step-detail')
    await openAttention(card, detail)
    await expect(detail.getByTestId('step-detail-agent')).toHaveText(/architect/i)

    await detail.getByTestId('step-approve').click()

    // LIVE: the gate clears and the rest of the chain (the ungated coder) carries the run to a
    // terminal state — so the drawn pipeline ran to the end, not just up to its checkpoint.
    await expect
      .poll(async () => await card.getAttribute('data-status'), { timeout: RUN_TERMINAL_TIMEOUT })
      .toMatch(/^(pr_ready|done)$/)
  })
})
