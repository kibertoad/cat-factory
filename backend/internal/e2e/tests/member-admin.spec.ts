import { test, expect } from './fixtures'
import {
  BOOT_TIMEOUT,
  LIVE_TIMEOUT,
  openBoard,
  pinAuthedWorkspace,
  seedTeamScenario,
  selectTask,
  taskCard,
  useAdvancedInterfaceMode,
} from './helpers'
import type { Page } from '@playwright/test'

// WORKSPACE ACCESS ADMINISTRATION: the surface an admin uses to decide who may touch a board.
//
// `rbac.spec` proves the two ENDS of that decision render differently (a viewer's board is
// read-only, an account admin's is not), but it seeds both roles directly into the database. What
// nothing covered is the act itself: the Members tab of Workspace Settings, where a role is changed
// and a member is removed. That is the highest-consequence admin surface in the product (a role
// select that posts the wrong role, or a remove that resolves against the wrong row, hands out or
// takes away write access to a repository), and it is only observable assembled, because the proof
// is what a DIFFERENT signed-in user's browser then renders.
//
// So each test here spends two browser contexts: one authenticated as the admin who makes the
// change, one authenticated as the member it was made about, booted AFTER the change so the second
// session is a fresh resolution through the real RBAC gate rather than a reloaded stale one.
test.describe('workspace access administration (the members roster)', () => {
  test.slow()

  /**
   * Boot a second, independent browser session as `principal` on `workspaceId`.
   *
   * Through the `newSession` fixture, so this session's uncaught SPA exceptions fail the test and its
   * context is closed even when an assertion below throws first (see `fixtures.ts`).
   */
  async function openBoardAs(
    newSession: () => Promise<Page>,
    workspaceId: string,
    accountId: string,
    principal: { token: string; userId: string },
  ): Promise<Page> {
    const page = await newSession()
    await pinAuthedWorkspace(page, workspaceId, principal.token, principal.userId, accountId)
    await useAdvancedInterfaceMode(page)
    return page
  }

  test('promoting a viewer to member in the roster gives that user an authoring board', async ({
    page,
    request,
    newSession,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const scenario = await seedTeamScenario(request, {
      tag,
      restricted: true,
      principals: [{ key: 'contributor', role: 'viewer', name: 'Rosa Contributor' }],
    })
    const contributor = scenario.principals.contributor
    if (!contributor) throw new Error('the contributor principal was not seeded')

    // The admin's session. Advanced mode because `nav-workspace-settings` is where the tab lives
    // and the affordances the promoted user is checked for below are advanced-tier too, so both
    // sessions must be on the same tier or the comparison is about the tier instead of the role.
    await pinAuthedWorkspace(
      page,
      scenario.workspaceId,
      scenario.ownerToken,
      scenario.ownerUserId,
      scenario.accountId,
    )
    await useAdvancedInterfaceMode(page)
    await openBoard(page)

    await page.getByTestId('nav-workspace-settings').click()
    await page.getByTestId('workspace-settings-tab-members').click()
    const roster = page.getByTestId('workspace-members-settings')
    await expect(roster).toBeVisible({ timeout: LIVE_TIMEOUT })
    // The board was seeded restricted, so the toggle reflects the stored access mode rather than a
    // default, so the roster below is the list actually being enforced.
    await expect(roster.getByTestId('workspace-restrict-toggle')).toBeChecked()

    const row = roster.locator(
      `[data-testid="workspace-member-row"][data-user-id="${contributor.userId}"]`,
    )
    await expect(row).toBeVisible({ timeout: LIVE_TIMEOUT })
    // PROMOTE. The role select is the whole subject: it patches one member's role in place, and
    // the roster reloads from the server afterwards, so the select reading `member` on the way out
    // is the persisted role rather than the local pick.
    await row.getByTestId('workspace-member-role').click()
    await page.getByRole('option', { name: 'Member', exact: true }).click()
    await expect(row.getByTestId('workspace-member-role')).toContainText('Member', {
      timeout: LIVE_TIMEOUT,
    })

    // The promoted user's OWN session, booted fresh: their access is resolved by the real gate from
    // the row just written. A `member` may author, which is exactly what a `viewer` may not (the
    // read-only half of that pair is `rbac.spec`).
    const theirs = await openBoardAs(
      newSession,
      scenario.workspaceId,
      scenario.accountId,
      contributor,
    )
    await openBoard(theirs)
    await expect(theirs.getByTestId('frame-add-task').first()).toBeVisible({
      timeout: LIVE_TIMEOUT,
    })
    await selectTask(taskCard(theirs, 'task_login'))
    const run = theirs.getByTestId('run-start')
    await expect(run).toBeVisible()
    await expect(run).toBeEnabled()
    // The refusal a viewer's board carries is absent. Sound as an absence because the enabled
    // `run-start` above is the same render pass that would have carried it.
    await expect(theirs.getByTestId('run-blocked-reason')).toHaveCount(0)
  })

  test('removing a member from a restricted board takes that board out of their reach', async ({
    page,
    request,
    newSession,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const scenario = await seedTeamScenario(request, {
      tag,
      restricted: true,
      principals: [{ key: 'leaver', role: 'member', name: 'Sam Leaver' }],
      // Somewhere definite for their session to land once the restricted board is out of reach.
      spareBoard: true,
    })
    const leaver = scenario.principals.leaver
    if (!leaver) throw new Error('the leaver principal was not seeded')
    if (!scenario.spareWorkspaceId) throw new Error('the spare board was not seeded')

    await pinAuthedWorkspace(
      page,
      scenario.workspaceId,
      scenario.ownerToken,
      scenario.ownerUserId,
      scenario.accountId,
    )
    await useAdvancedInterfaceMode(page)
    await openBoard(page)

    await page.getByTestId('nav-workspace-settings').click()
    await page.getByTestId('workspace-settings-tab-members').click()
    const roster = page.getByTestId('workspace-members-settings')
    const row = roster.locator(
      `[data-testid="workspace-member-row"][data-user-id="${leaver.userId}"]`,
    )
    await expect(row).toBeVisible({ timeout: LIVE_TIMEOUT })

    // REVOKE. Losing access is destructive, so it is confirm-gated like every other such control.
    await row.getByTestId('workspace-member-remove').click()
    await page.getByTestId('confirm-accept').click()
    await expect(row).toHaveCount(0, { timeout: LIVE_TIMEOUT })

    // Their session, booted after the revoke, still PINNED to the revoked board. A board they may
    // not read is filtered out of their workspace list, so the SPA's own resolution discards the
    // pin and opens the one board they can still reach. That landing is the positive fact this
    // rests on: without it, "the seeded task is absent" would also pass on a board that simply had
    // not painted yet.
    const theirs = await openBoardAs(newSession, scenario.workspaceId, scenario.accountId, leaver)
    await theirs.goto('/')
    await expect(theirs.getByTestId('board-canvas')).toBeVisible({ timeout: BOOT_TIMEOUT })
    const switcher = theirs.getByTestId('board-switcher')
    await expect(switcher).toHaveAttribute('data-board-id', scenario.spareWorkspaceId, {
      timeout: BOOT_TIMEOUT,
    })
    // ...and the revoked board is not on offer to switch BACK to, which is the list filtering the
    // gate applies (a board they cannot read is not merely unopened, it is unlisted).
    //
    // In that order for the same reason `board-switch.spec` orders its pair: the menu's rows mount a
    // tick after the click, so the spare board's row appearing is what makes the revoked one's
    // absence a rendered LIST rather than a menu that had not opened yet. `toHaveCount(0)` passes on
    // its first poll, so on its own it is an assertion that cannot fail.
    await switcher.click()
    await expect(theirs.getByTestId(`board-option-${scenario.spareWorkspaceId}`)).toBeVisible({
      timeout: LIVE_TIMEOUT,
    })
    await expect(theirs.getByTestId(`board-option-${scenario.workspaceId}`)).toHaveCount(0)
    await expect(taskCard(theirs, 'task_login')).toHaveCount(0)
  })
})
