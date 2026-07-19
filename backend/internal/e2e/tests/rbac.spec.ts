import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, openBoard, pinAuthedWorkspace, seedRbacScenario, taskCard } from './helpers'

// Workspace RBAC (the workspace-rbac initiative, ADR 0025) as the assembled product shows
// it: the SAME restricted board, opened by two different authenticated users, degrades
// differently in the real SPA. This is behaviour ONLY the assembled product exposes — the
// backend attaches the caller's resolved `{ role, permissions }` to the board snapshot and
// the SPA hides/disables affordances from it. The port-level RBAC (404 for a non-member,
// list filtering, the viewer write floor's 403s) is asserted exhaustively by the
// cross-runtime `defineWorkspaceRbacSuite`; here we prove the UI round-trip.
//
// The shared e2e backend runs auth-enabled-for-signed-tokens (an anonymous request stays
// dev-open, so every other spec is unchanged), and `seedRbacScenario` mints a real session
// per principal. `pinAuthedWorkspace` injects one into the SPA's persisted `auth` store, so
// the board boots AS that user with the workspace-RBAC gate enforcing.
test.describe('workspace RBAC — viewer read-only vs admin escape hatch', () => {
  test('a viewer opens a restricted board read-only (no authoring, run locked)', async ({
    page,
    request,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const scenario = await seedRbacScenario(request, tag)

    // Boot the board AS the viewer (an account member scoped to this restricted board with
    // the `viewer` role). A viewer CAN read, so the board paints and the stream connects.
    await pinAuthedWorkspace(
      page,
      scenario.workspaceId,
      scenario.viewerToken,
      scenario.viewerUserId,
    )
    await openBoard(page)

    // Board-authoring affordances (`board.write`) are hidden entirely for a viewer: the
    // per-frame add-task buttons and the SideBar "Build pipeline" entry are absent from the
    // DOM (the nav slot filters gated-out items out, not merely disables them).
    await expect(page.getByTestId('frame-add-task')).toHaveCount(0)
    await expect(page.getByTestId('frame-add-task-empty')).toHaveCount(0)
    await expect(page.getByTestId('nav-build-pipeline')).toHaveCount(0)
    // Admin-tier nav (`settings.manage`) is hidden for a viewer too.
    await expect(page.getByTestId('nav-workspace-settings')).toHaveCount(0)

    // A viewer can still INSPECT a task, but the Run trigger is locked with the read-only
    // reason — the run panel stays visible (a viewer sees runs), the control is just disabled.
    await taskCard(page, 'task_login').click()
    await expect(page.getByTestId('run-start')).toBeVisible()
    await expect(page.getByTestId('run-start')).toBeDisabled()
    await expect(page.getByTestId('run-blocked-reason')).toBeVisible()
  })

  test('an account admin opens the same restricted board with full controls', async ({
    page,
    request,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const scenario = await seedRbacScenario(request, tag)

    // Boot AS the account admin, who holds NO workspace_members row on this board — their
    // full access comes purely from the account-admin escape hatch (account admin ⇒ workspace
    // admin), the mirror of the viewer case above on an identically-restricted board.
    await pinAuthedWorkspace(page, scenario.workspaceId, scenario.adminToken, scenario.adminUserId)
    await openBoard(page)

    // Board-authoring + admin-tier affordances are present for an admin (the same ids the
    // viewer case asserts absent). They may render in more than one surface (SideBar +
    // toolbar), so assert the first is visible rather than an exact count.
    await expect(page.getByTestId('frame-add-task').first()).toBeVisible()
    await expect(page.getByTestId('nav-build-pipeline').first()).toBeVisible()
    await expect(page.getByTestId('nav-workspace-settings').first()).toBeVisible()

    // The Run trigger is live for an admin: no read-only lock, and the control is enabled
    // (the seeded `task_login` is runnable with no unmet dependencies).
    await taskCard(page, 'task_login').click()
    await expect(page.getByTestId('run-start')).toBeVisible()
    await expect(page.getByTestId('run-start')).toBeEnabled({ timeout: LIVE_TIMEOUT })
    await expect(page.getByTestId('run-blocked-reason')).toBeHidden()
  })
})
