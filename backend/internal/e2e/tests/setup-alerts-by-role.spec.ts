import { INFRA_SETUP_DISMISSED_STORAGE_KEY } from '@cat-factory/contracts'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { answerRolePrompt, openBoard, pinAuthedWorkspace, seedTeamScenario } from './helpers'

// WHO a setup advisory is for. The e2e backend is a stock Node deployment with no runner pool, so
// every board here has a real "agent executor not configured" gap. The infra-setup cards used to
// render for every caller; now each card is kept to the people who can act on it (by the owner the
// server reports beside the status), and everyone else gets one line naming who can.
//
// Only observable assembled: the decision reads the server's `infraSetupOwners`, the caller's
// board permissions from the RBAC gate, and the role they picked in the browser. So each case is a
// separate signed-in session on the SAME board, and the proof is what that session renders.
test.describe('setup advisories by role', () => {
  test.slow()

  /** Boot `principal` on the scenario board with the infra advisories left in place. */
  async function openAs(
    page: Page,
    scenario: { workspaceId: string; accountId: string },
    principal: { token: string; userId: string },
    role: 'engineer' | 'designer' = 'engineer',
  ): Promise<void> {
    await pinAuthedWorkspace(
      page,
      scenario.workspaceId,
      principal.token,
      principal.userId,
      scenario.accountId,
    )
    if (role !== 'engineer') await answerRolePrompt(page, role)
    // `pinAuthedWorkspace` permanently dismisses the advisories so they stay out of every other
    // spec's way. They are this spec's subject, so put them back before the first navigation.
    await page.addInitScript(
      (key) => window.localStorage.removeItem(key),
      INFRA_SETUP_DISMISSED_STORAGE_KEY,
    )
    await openBoard(page)
  }

  test('an admin gets the actionable card, and members and viewers get one line naming the admin', async ({
    page,
    request,
    newSession,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const scenario = await seedTeamScenario(request, {
      tag,
      principals: [
        { key: 'member', role: 'member', name: 'Mia Member' },
        { key: 'viewer', role: 'viewer', name: 'Vic Viewer' },
      ],
    })
    const { member, viewer } = scenario.principals
    if (!member || !viewer) throw new Error('the member and viewer principals were not seeded')

    // The account owner holds `integrations.manage`, so the runner-pool gap is theirs to close.
    await openAs(page, scenario, { token: scenario.ownerToken, userId: scenario.ownerUserId })
    await expect(page.getByTestId('infra-setup-banner-agentExecutor')).toBeVisible()
    await expect(page.getByTestId('infra-setup-configure-agentExecutor')).toBeVisible()
    await expect(page.getByTestId('infra-setup-notice-agentExecutor')).toHaveCount(0)

    // A member and a viewer cannot save a runner pool, so neither gets a card or its button. The
    // gap still stops every run they would start, so each is told once, and told who can fix it.
    for (const principal of [member, viewer]) {
      const session = await newSession()
      await openAs(session, scenario, principal)
      const notice = session.getByTestId('infra-setup-notice-agentExecutor')
      await expect(notice).toBeVisible()
      await expect(notice).toHaveAttribute('data-infra-owner', 'workspace_admin')
      await expect(session.locator('[data-testid^="infra-setup-banner-"]')).toHaveCount(0)
    }
  })

  test('on an unconnected board, a member is told to ask a board admin and can switch boards', async ({
    page,
    request,
    newSession,
  }) => {
    const scenario = await seedTeamScenario(request, {
      tag: Math.random().toString(36).slice(2, 8),
      githubConnected: false,
      principals: [{ key: 'member', role: 'member', name: 'Mia Member' }],
    })
    const member = scenario.principals.member
    if (!member) throw new Error('the member principal was not seeded')

    // The gate replaces the whole board, so `openBoard` (which waits for the canvas) cannot be used.
    async function openGate(session: Page, principal: { token: string; userId: string }) {
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
    await openGate(page, { token: scenario.ownerToken, userId: scenario.ownerUserId })
    await expect(page.getByTestId('vcs-connect-admin-required')).toHaveCount(0)

    // The member's connect-options read is refused, which used to render as "this deployment has
    // nothing configured, ask an operator". It is a permission, and a board admin can fix it.
    const session = await newSession()
    await openGate(session, member)
    await expect(session.getByTestId('vcs-connect-admin-required')).toBeVisible()
  })

  test('the designer surface gets the line even when the caller is an admin', async ({
    page,
    request,
  }) => {
    const scenario = await seedTeamScenario(request, {
      tag: Math.random().toString(36).slice(2, 8),
    })
    // The intake surface never configures the platform, so the cards stay off it regardless of
    // the grant. The line is still owed: a designer's task will not run either.
    await openAs(
      page,
      scenario,
      { token: scenario.ownerToken, userId: scenario.ownerUserId },
      'designer',
    )
    await expect(page.getByTestId('infra-setup-notice-agentExecutor')).toBeVisible()
    await expect(page.locator('[data-testid^="infra-setup-banner-"]')).toHaveCount(0)

    // Closing it keeps it closed for the session, like the card it stands in for.
    await page.getByTestId('infra-setup-notice-dismiss-agentExecutor').click()
    await expect(page.getByTestId('infra-setup-notice-agentExecutor')).toHaveCount(0)
  })
})
