import { test, expect } from './fixtures'
import {
  createSeededWorkspace,
  openBoard,
  pinWorkspace,
  taskCard,
  useAdvancedInterfaceMode,
} from './helpers'

// The basic/advanced interface separation as the assembled product shows it. Three things
// only the real shell can prove: the SHIPPED DEFAULT is basic (the unit specs assert the
// resolver, not what a freshly-opened board renders), the switch re-gates the live nav with
// no reload (it rides the same reactive slot filter as an RBAC flip), and the collapsed rail
// is lg-only so the compact drawer is never railed.
//
// `nav-kaizen` is the probe for the advanced tier and `nav-workspace-settings` for the basic
// one: both are dev-open-visible in this deployment (Kaizen carries no RBAC gate at all), so
// the only thing that moves them is the tier.
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
    await expect(page.getByTestId('nav-kaizen')).toHaveCount(0)
    await expect(page.getByTestId('nav-sandbox')).toHaveCount(0)
    // Including the destinations whose capability basic mode genuinely does without: repo
    // bootstrap is a one-off setup act rather than delivery work. (Its `integrations.manage`
    // gate passes dev-open, so the tier is the only thing that can be hiding it — unlike
    // `nav-reports` / `nav-operator-dashboard`, which also need accounts + an admin role and
    // so prove nothing about the tier on this deployment.)
    await expect(page.getByTestId('nav-bootstrap-repo')).toHaveCount(0)
    // ...while the sole-route destinations stay, however deep they feel: basic hides
    // shortcuts and side surfaces, never the only way to reach a capability. The pipeline
    // builder is the probe (its `board.write` gate passes dev-open, unlike `nav-fragments`,
    // whose availability gate depends on the library integration this server may not wire).
    await expect(page.getByTestId('nav-build-pipeline')).toBeVisible()
  })

  test('the frame header keeps only its basic-tier authoring buttons', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    // The tier reaches the BOARD, not just the nav: a frame's header offers add-task in both
    // tiers (the everyday act) but hides the recurring-schedule and initiative authoring
    // buttons in basic. All three share one `board.write` gate, so a difference between them
    // can only be the tier.
    const frame = taskCard(page, 'blk_auth')
    await expect(frame.getByTestId('frame-add-task').first()).toBeVisible()
    await expect(frame.getByTestId('frame-add-recurring')).toHaveCount(0)
    await expect(frame.getByTestId('frame-add-initiative')).toHaveCount(0)

    // Switching tiers reveals them live, through the same store the nav reads — no reload.
    // Basic starts railed, where the switcher degrades to the one-button toggle.
    await page.getByTestId('ui-mode-toggle').click()
    await expect(frame.getByTestId('frame-add-recurring').first()).toBeVisible()
    await expect(frame.getByTestId('frame-add-initiative').first()).toBeVisible()
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
    await expect(page.getByTestId('nav-kaizen')).toHaveCount(0)

    await toggle.click()
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
  })

  test('switching to advanced reveals the advanced destinations live and expands the rail', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard

    // Basic starts railed, so the switcher is its one-button toggle here.
    await page.getByTestId('ui-mode-toggle').click()

    // No reload: the nav re-gates through the same reactive slot filter a permission flip uses.
    await expect(page.getByTestId('nav-kaizen')).toBeVisible()
    await expect(page.getByTestId('nav-sandbox')).toBeVisible()
    // Advanced's default is the expanded navbar, so the labels come back too.
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'false')

    // ...and back: expanded, the switcher is the segmented control, so both tiers are on screen
    // and returning to basic is one click on the segment that names it.
    await expect(page.getByTestId('ui-mode-switcher')).toBeVisible()
    await page.getByTestId('ui-mode-option-basic').click()
    await expect(page.getByTestId('nav-kaizen')).toHaveCount(0)
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
    await expect(page.getByTestId('nav-kaizen')).toHaveCount(0)
  })

  test('the command palette can reach the tier switch from basic mode', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    // The way BACK out of basic mode. The sidebar switcher is a single toggle in the basic rail,
    // so the palette entry is the searchable second route — it must not be `advanced`.
    // Driven by click rather than ⌘K so the spec doesn't also depend on the shortcut binding.
    await page.getByTestId('command-bar-launcher').click()
    await expect(page.getByTestId('command-bar')).toBeVisible()
    await page.getByTestId('command-ui-mode').click()

    await expect(page.getByTestId('nav-kaizen')).toBeVisible()
  })

  test('a stored advanced choice survives a reload', async ({ page, request }) => {
    // Not the `seededBoard` fixture: the tier cookie has to be seeded before the first goto.
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id)
    await useAdvancedInterfaceMode(page)
    await openBoard(page)

    await expect(page.getByTestId('nav-kaizen')).toBeVisible()
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
