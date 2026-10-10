import { INFRA_SETUP_DISMISSED_STORAGE_KEY } from '@cat-factory/contracts'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { answerRolePrompt, openBoard, pinAuthedWorkspace, seedTeamScenario } from './helpers'

// WHO a setup advisory is for. The e2e backend is a stock Node deployment with no runner pool, so
// every board here has a real "agent executor not configured" gap. The infra-setup cards used to
// render for every caller; now each card is kept to the people who can act on it (by the owner the
// server reports beside the status), and a caller whose runs the gap stops gets one line saying how
// it gets fixed.
//
// Only observable assembled: the decision reads the server's `infraSetupOwners`, the caller's
// board permissions from the RBAC gate, and the role they picked in the browser. So each case is a
// separate signed-in session on the SAME board, and the proof is what that session renders.
test.describe('setup advisories by role', () => {
  test.slow()

  type Principal = { token: string; userId: string }
  type Scenario = { workspaceId: string; accountId: string }

  /**
   * Boot `principal` on the scenario board. The advisories are left in place unless `dismissed`:
   * `pinAuthedWorkspace` records a permanent dismissal of every area, which is what every other spec
   * relies on to keep them out of the way, so a case about the advisories removes it.
   */
  async function openAs(
    page: Page,
    scenario: Scenario,
    principal: Principal,
    {
      role = 'engineer',
      dismissed = false,
    }: { role?: 'engineer' | 'designer'; dismissed?: boolean } = {},
  ): Promise<void> {
    await pinAuthedWorkspace(
      page,
      scenario.workspaceId,
      principal.token,
      principal.userId,
      scenario.accountId,
    )
    if (role !== 'engineer') await answerRolePrompt(page, role)
    if (!dismissed) {
      await page.addInitScript(
        (key) => window.localStorage.removeItem(key),
        INFRA_SETUP_DISMISSED_STORAGE_KEY,
      )
    }
    await openBoard(page)
  }

  const owner = (s: { ownerToken: string; ownerUserId: string }): Principal => ({
    token: s.ownerToken,
    userId: s.ownerUserId,
  })

  test('an admin gets the actionable card, a member one line naming the admin, a viewer nothing', async ({
    page,
    request,
    newSession,
  }) => {
    // Restricted, or the roster row is not what decides: on a board open to the whole account every
    // account member resolves as a member, the "viewer" included (ADR 0025).
    const scenario = await seedTeamScenario(request, {
      tag: Math.random().toString(36).slice(2, 8),
      restricted: true,
      principals: [
        { key: 'member', role: 'member', name: 'Mia Member' },
        { key: 'viewer', role: 'viewer', name: 'Vic Viewer' },
      ],
    })
    const { member, viewer } = scenario.principals
    if (!member || !viewer) throw new Error('the member and viewer principals were not seeded')

    // The account owner holds `integrations.manage`, so the runner-pool gap is theirs to close.
    await openAs(page, scenario, owner(scenario))
    await expect(page.getByTestId('infra-setup-banner-agentExecutor')).toBeVisible()
    await expect(page.getByTestId('infra-setup-configure-agentExecutor')).toBeVisible()
    await expect(page.getByTestId('infra-setup-notice-agentExecutor')).toHaveCount(0)

    // A member cannot save a runner pool, so gets no card or button. The gap still stops every run
    // they would start, so they are told once, and told who can fix it.
    const memberSession = await newSession()
    await openAs(memberSession, scenario, member)
    const notice = memberSession.getByTestId('infra-setup-notice-agentExecutor')
    await expect(notice).toBeVisible()
    await expect(notice).toHaveAttribute('data-infra-remedy', 'workspace_admin')
    await expect(memberSession.locator('[data-testid^="infra-setup-banner-"]')).toHaveCount(0)

    // A viewer cannot start a run, so the gap stops nothing they do: no card and no line.
    const viewerSession = await newSession()
    await openAs(viewerSession, scenario, viewer)
    await expect(viewerSession.getByTestId('board-canvas')).toBeVisible()
    await expect(viewerSession.locator('[data-testid^="infra-setup-"]')).toHaveCount(0)
  })

  test('a permanent dismissal of the card also keeps the line away', async ({ page, request }) => {
    const scenario = await seedTeamScenario(request, {
      tag: Math.random().toString(36).slice(2, 8),
      principals: [{ key: 'member', role: 'member', name: 'Mia Member' }],
    })
    const member = scenario.principals.member
    if (!member) throw new Error('the member principal was not seeded')

    // The same claim, so the same "don't notify me again". This is also the state every other
    // spec's member session boots in, which is why the line must honour it.
    await openAs(page, scenario, member, { dismissed: true })
    await expect(page.getByTestId('board-canvas')).toBeVisible()
    await expect(page.getByTestId('infra-setup-notice-agentExecutor')).toHaveCount(0)
  })

  test('on an unconnected board, a member is told to ask a board admin and can switch boards', async ({
    page,
    request,
    newSession,
  }) => {
    const scenario = await seedTeamScenario(request, {
      tag: Math.random().toString(36).slice(2, 8),
      seed: false,
      githubConnected: false,
      principals: [{ key: 'member', role: 'member', name: 'Mia Member' }],
    })
    const member = scenario.principals.member
    if (!member) throw new Error('the member principal was not seeded')

    // The gate replaces the whole board, so `openBoard` (which waits for the canvas) cannot be used.
    async function openGate(session: Page, principal: Principal) {
      await pinAuthedWorkspace(
        session,
        scenario.workspaceId,
        principal.token,
        principal.userId,
        scenario.accountId,
      )
      await session.goto('/')
      await expect(session.getByTestId('vcs-onboarding-switch-board')).toBeVisible()
    }

    // The admin gets the connect surfaces, not the message.
    await openGate(page, owner(scenario))
    await expect(page.getByTestId('vcs-connect-admin-required')).toHaveCount(0)

    // The gate's switcher only switches and creates. Deleting a board confirms through a dialog
    // the gate does not mount, so offering it there would do nothing, then fire on the next board.
    await page.getByTestId('board-switcher').click()
    await expect(page.getByTestId('board-new')).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Delete board' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // The member's connect-options read is refused, which used to render as "this deployment has
    // nothing configured, ask an operator". It is a permission, and a board admin can fix it.
    const session = await newSession()
    await openGate(session, member)
    await expect(session.getByTestId('vcs-connect-admin-required')).toBeVisible()
  })

  test('an admin on the designer surface is told to switch surface, not to find an admin', async ({
    page,
    request,
  }) => {
    const scenario = await seedTeamScenario(request, {
      tag: Math.random().toString(36).slice(2, 8),
    })
    // The intake surface never configures the platform, so the cards stay off it regardless of
    // the grant. This caller holds the grant, so the line points them at their own role switch.
    await openAs(page, scenario, owner(scenario), { role: 'designer' })
    const notice = page.getByTestId('infra-setup-notice-agentExecutor')
    await expect(notice).toBeVisible()
    await expect(notice).toHaveAttribute('data-infra-remedy', 'full_surface')
    await expect(page.locator('[data-testid^="infra-setup-banner-"]')).toHaveCount(0)

    // Closing it offers the card's own choice; the session dismissal keeps it closed.
    await page.getByTestId('infra-setup-notice-dismiss-agentExecutor').click()
    await page.getByRole('menuitem', { name: 'Dismiss for this session' }).click()
    await expect(notice).toHaveCount(0)
  })
})
