import { test, expect } from './fixtures'
import {
  AUTH_FRONTEND_URL,
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  findPipelineByName,
  openAttention,
  openBoard,
  pinAuthedWorkspace,
  seedTeamScenario,
  setFakeProfile,
  startRun,
  taskCard,
  useAdvancedInterfaceMode,
  type SeededPrincipal,
} from './helpers'
import type { Browser, Locator, Page } from '@playwright/test'

// A HUMAN CHECKPOINT WITH A POLICY: two named approvers, both required.
//
// `approval-gate.spec` and `pipeline-builder.spec` drive the DEFAULT gate: one approval, from
// anyone entitled to write. The per-step policy on top of it (`StepGateConfig.approvers` +
// `minApprovals`) is the product's answer to "two people must sign off, and only these people
// may", which is the shape a team uses for anything that ships. Nothing covered it, and every
// failure mode is silent in the direction that matters: a quorum that counts one person's two
// clicks, a policy saved against the wrong step index, or a refusal enforced only in the SPA all
// look exactly like a working gate until the day something lands with one signature.
//
// Only the assembled product can show it, because the subject is what THREE different signed-in
// people see about the same parked step: a member who is not a named approver is refused, the
// first named approver's approval is recorded WITHOUT releasing the run, and the second one's
// releases it. So this spec authors the policy in the real builder and then spends one browser
// context per person.
//
// It runs against the AUTH-ENABLED stack (see `AUTH_FRONTEND_URL`) because a policy that names
// people needs a browser that HAS one. Under the primary stack's `TESTING_NO_AUTH` the SPA never
// resolves a signed-in user however good the session token is, so every actor is `unattributed` and
// the rail refuses all three of these people. That is the honest answer for a deployment with auth
// off, and it is no coverage of the policy at all.
test.describe('quorum + named-approver gate', () => {
  test.use({ baseURL: AUTH_FRONTEND_URL })
  test.slow()

  /**
   * Draw a gated `architect → coder` pipeline in the real builder, with a two-person policy naming
   * `approvers`, and save it. The policy controls render only for a GATED step, which is the
   * product's own rule: a policy on an ungated step describes a checkpoint that does not exist (and
   * is refused at save).
   */
  async function drawTwoSignatureGate(
    page: Page,
    name: string,
    approvers: SeededPrincipal[],
  ): Promise<void> {
    await page.getByTestId('nav-build-pipeline').click()
    const palette = page.getByTestId('pipeline-builder-palette')
    await expect(palette).toBeVisible({ timeout: LIVE_TIMEOUT })
    await page.getByTestId('pipeline-builder-name').fill(name)
    await palette.getByTestId('palette-agent-architect').click()
    await palette.getByTestId('palette-agent-coder').click()

    const steps = page.getByTestId('pipeline-builder-draft').getByTestId('pipeline-draft-step')
    await expect(steps).toHaveCount(2)
    await steps.nth(0).getByTestId('pipeline-step-gate').click()
    await expect(steps.nth(0)).toHaveAttribute('data-gated', 'true')

    const gateConfig = steps.nth(0).getByTestId('gate-config')
    await expect(gateConfig).toBeVisible()
    await gateConfig.getByTestId('gate-required-approvals').fill('2')
    await gateConfig.getByTestId('gate-named-approvers').click()
    // The picker's options are the workspace ROSTER, so naming an approver here is only possible for
    // someone actually scoped to the board.
    for (const approver of approvers) {
      await page.getByRole('option', { name: approver.name, exact: true }).click()
    }
    await page.keyboard.press('Escape')
    await page.getByTestId('pipeline-builder-save').click()
    await expect(palette).toBeHidden({ timeout: LIVE_TIMEOUT })
  }

  /**
   * Open the parked step's review rail in an INDEPENDENT browser session authenticated as
   * `principal`, run `body` against it, and close that session.
   *
   * One session per person is the whole method here: what the policy admits is a property of the
   * VIEWER, so each of these has to be a real signed-in browser rather than the same one re-pinned.
   */
  async function inSessionAs(
    browser: Browser,
    scenario: { workspaceId: string; accountId: string },
    principal: SeededPrincipal,
    body: (rail: Locator, card: Locator) => Promise<void>,
  ): Promise<void> {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await pinAuthedWorkspace(
        page,
        scenario.workspaceId,
        principal.token,
        principal.userId,
        scenario.accountId,
      )
      await openBoard(page)
      const card = taskCard(page, 'task_login')
      const rail = page.getByTestId('step-detail')
      await openAttention(card, rail)
      await body(rail, card)
    } finally {
      await context.close()
    }
  }

  test('two named approvers are required: an unnamed member is refused, one approval is not enough', async ({
    page,
    request,
    browser,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const scenario = await seedTeamScenario(request, {
      tag,
      principals: [
        { key: 'alice', role: 'member', name: 'Alice Approver' },
        { key: 'bob', role: 'member', name: 'Bob Approver' },
        // A member with the SAME write access as the two above and no place in the policy: the one
        // principal whose refusal is about the gate rather than about workspace RBAC. (A `viewer`
        // would prove nothing here, since the write floor refuses them before a policy is consulted,
        // and an `admin` is admitted by every policy by design.)
        { key: 'carol', role: 'member', name: 'Carol Bystander' },
      ],
    })
    const { alice, bob, carol } = scenario.principals
    if (!alice || !bob || !carol) throw new Error('the gate principals were not seeded')
    // Only the AUTHORED gate should hold this run, so the backend's default step-0 decision is off.
    await setFakeProfile(request, scenario.workspaceId, { decisionOnSteps: [] })

    // The author's session (the account owner, an admin). The builder itself is basic-tier, but the
    // gate POLICY fields are an override, so they are advanced-only until a step configures one:
    // authoring the first policy therefore happens in the advanced tier. The approvers' sessions
    // below stay on the shipped default, which is the point: a policy authored by one person is
    // enforced for everyone, whatever tier they browse in.
    await pinAuthedWorkspace(
      page,
      scenario.workspaceId,
      scenario.ownerToken,
      scenario.ownerUserId,
      scenario.accountId,
    )
    await useAdvancedInterfaceMode(page)
    await openBoard(page)

    // 1) DRAW the checkpoint: an architect step gated, with a two-person policy naming Alice and Bob.
    const name = `E2E two-signature pipeline ${tag}`
    await drawTwoSignatureGate(page, name, [alice, bob])

    // 2) The persisted wire shape carries the policy ON THE GATED STEP. Read back over REST because
    // a policy saved against the wrong index would still park the run at a gate, just one that
    // anybody could clear.
    const saved = await findPipelineByName(request, scenario.workspaceId, name)
    expect(saved).not.toBeNull()
    expect(saved!.gates?.[0]).toBe(true)
    const config = saved!.stepOptions?.[0]?.gateConfig
    expect(config?.minApprovals).toBe(2)
    expect([...(config?.approvers?.userIds ?? [])].sort()).toEqual(
      [alice.userId, bob.userId].sort(),
    )
    expect(saved!.stepOptions?.[1]?.gateConfig).toBeUndefined()

    // 3) Run it. The architect completes and the gate holds the run for two signatures.
    await startRun(request, scenario.workspaceId, 'task_login', saved!.id)
    const authorCard = taskCard(page, 'task_login')
    await expect(authorCard.getByTestId('task-resolve')).toHaveText(/approve/i, {
      timeout: RUN_TERMINAL_TIMEOUT,
    })

    // 4) CAROL, a member who is not a named approver. She can open the parked step, and the rail
    // states the refusal and disables the approve control rather than offering a button the server
    // answers 403.
    await inSessionAs(browser, scenario, carol, async (rail) => {
      await expect(rail.getByTestId('gate-not-approver')).toBeVisible({ timeout: LIVE_TIMEOUT })
      await expect(rail.getByTestId('step-approve')).toBeDisabled()
    })

    // 5) ALICE, the first named approver. Her approval is RECORDED but does not release the run:
    // the quorum progress is the surface that says so, and the card staying parked is the engine
    // agreeing. This is the assertion a quorum that miscounts fails.
    await inSessionAs(browser, scenario, alice, async (rail, card) => {
      await expect(rail.getByTestId('gate-quorum')).toContainText('0', { timeout: LIVE_TIMEOUT })
      await expect(rail.getByTestId('step-approve')).toBeEnabled()
      await rail.getByTestId('step-approve').click()
      // Re-opened after her approval, the same rail now counts one of the two, and still offers the
      // gate rather than a finished step, so nothing advanced on one signature.
      await openAttention(card, rail)
      await expect(rail.getByTestId('gate-quorum')).toContainText('1', { timeout: LIVE_TIMEOUT })
      await expect(card).toHaveAttribute('data-status', 'blocked')
    })

    // 6) BOB, the second named approver. His approval meets the quorum, the gate clears, and the
    // rest of the chain carries the run to a terminal state, live in the AUTHOR's still-open board.
    await inSessionAs(browser, scenario, bob, async (rail) => {
      await rail.getByTestId('step-approve').click()
    })
    await expect
      .poll(async () => await authorCard.getAttribute('data-status'), {
        timeout: RUN_TERMINAL_TIMEOUT,
      })
      .toMatch(/^(pr_ready|done)$/)
  })
})
