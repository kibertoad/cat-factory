import { test, expect } from './fixtures'
import { createSeededWorkspace, openBoard, pinWorkspace, useAdvancedInterfaceMode } from './helpers'

// The basic/advanced interface separation as the assembled product shows it. Three things
// only the real shell can prove: the SHIPPED DEFAULT is basic (the unit specs assert the
// resolver, not what a freshly-opened board renders), the switch re-gates the live nav with
// no reload (it rides the same reactive slot filter as an RBAC flip), and the collapsed rail
// is lg-only so the compact drawer is never railed.
//
// `nav-build-pipeline` is the probe for the advanced tier and `nav-workspace-settings` for
// the basic one: both are dev-open-visible in this deployment, so the only thing that moves
// them is the tier.
test.describe('interface mode (basic / advanced)', () => {
  test('a board opens in basic mode: rail collapsed, advanced destinations hidden', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard

    // Basic is the default with no env pin and nothing stored, and it starts collapsed.
    const sidebar = page.getByTestId('sidebar')
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
    // Railed, so the labels are gone (the icons and their tooltips remain).
    await expect(sidebar.getByText('Workspace settings')).toHaveCount(0)
    await expect(page.getByTestId('nav-workspace-settings')).toBeVisible()
    // The advanced half is absent from the DOM, not merely disabled.
    await expect(page.getByTestId('nav-build-pipeline')).toHaveCount(0)
    await expect(page.getByTestId('nav-fragments')).toHaveCount(0)
    await expect(page.getByTestId('nav-sandbox')).toHaveCount(0)
  })

  test('the rail toggle expands and re-collapses the navbar', async ({ page, seededBoard }) => {
    void seededBoard

    const sidebar = page.getByTestId('sidebar')
    const toggle = page.getByTestId('sidebar-collapse-toggle')
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')

    // Expanding restores the labels without changing which destinations exist (still basic).
    await toggle.click()
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    await expect(sidebar.getByText('Workspace settings')).toBeVisible()
    await expect(page.getByTestId('nav-build-pipeline')).toHaveCount(0)

    await toggle.click()
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
  })

  test('switching to advanced reveals the advanced destinations live and expands the rail', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard

    await page.getByTestId('ui-mode-switcher').click()
    await page.getByRole('menuitem', { name: 'Advanced' }).click()

    // No reload: the nav re-gates through the same reactive slot filter a permission flip uses.
    await expect(page.getByTestId('nav-build-pipeline')).toBeVisible()
    await expect(page.getByTestId('nav-sandbox')).toBeVisible()
    // Advanced's default is the expanded navbar, so the labels come back too.
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'false')

    // ...and back: switching to basic hides them again, still without a reload.
    await page.getByTestId('ui-mode-switcher').click()
    await page.getByRole('menuitem', { name: 'Basic' }).click()
    await expect(page.getByTestId('nav-build-pipeline')).toHaveCount(0)
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true')
  })

  test('a basic-mode rail choice survives a reload', async ({ page, seededBoard }) => {
    void seededBoard
    // The rail preference is per-tier, so basic remembers an expand just as advanced does —
    // `collapsed` is basic's DEFAULT, not a rule that re-asserts itself on every load. Without
    // this the most-repeated interaction in the shipped tier would be the one that never sticks.
    const sidebar = page.getByTestId('sidebar')
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false')

    await page.reload()
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'false')
    // Still basic: remembering the rail must not promote the tier.
    await expect(page.getByTestId('nav-build-pipeline')).toHaveCount(0)
  })

  test('the command palette can reach the tier switch from basic mode', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    // The way BACK out of basic mode. The sidebar switcher is icon-only in the basic rail, so
    // the palette entry is what keeps the advanced half discoverable — it must not be `advanced`.
    // Driven by click rather than ⌘K so the spec doesn't also depend on the shortcut binding.
    await page.getByTestId('command-bar-launcher').click()
    await expect(page.getByTestId('command-bar')).toBeVisible()
    await page.getByTestId('command-ui-mode').click()

    await expect(page.getByTestId('nav-build-pipeline')).toBeVisible()
  })

  test('a stored advanced choice survives a reload', async ({ page, request }) => {
    // Not the `seededBoard` fixture: the tier cookie has to be seeded before the first goto.
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id)
    await useAdvancedInterfaceMode(page)
    await openBoard(page)

    await expect(page.getByTestId('nav-build-pipeline')).toBeVisible()
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'false')
  })

  test('the compact drawer is never railed, even in basic mode', async ({ page, seededBoard }) => {
    void seededBoard
    // Below lg the navbar is an off-canvas drawer; opening it is already a deliberate reveal,
    // so the collapse state must not apply there (see SideBar's `railed`).
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('mobile-nav-toggle').click()
    const sidebar = page.getByTestId('sidebar')
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    await expect(sidebar.getByText('Workspace settings')).toBeVisible()
  })
})
