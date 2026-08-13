import { test, expect } from './fixtures'
import { createSeededWorkspace, openBoard, pinWorkspace, taskCard } from './helpers'

// The role separation (Engineer / Product manager / Designer) as the assembled product shows it.
// Four things only the real shell can prove: a first-ever launch actually ASKS (the unit specs
// assert the store, not that a freshly-opened board raises the modal), closing the question without
// answering leaves the whole product in place, a designer's board really is narrowed on both the nav
// and the frame header, and the way BACK re-gates the live shell with no reload.
//
// `nav-workspace-settings` is the probe for the platform half and `nav-tutorial` for what every role
// keeps: both are visible in this deployment on the engineer surface (dev-open passes the RBAC
// gates), so the only thing that can move them is the role. `nav-kaizen` doubles as the tier probe,
// since a narrowed role is capped at basic.
test.describe('interface role (engineer / product manager / designer)', () => {
  test('a first-ever launch asks which job you do, and the pick opens the board', async ({
    page,
    request,
  }) => {
    // Not the `seededBoard` fixture: it pre-answers the question (as every other spec wants), and
    // the first launch is this spec's subject.
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id, { role: 'unanswered' })
    await openBoard(page)

    const prompt = page.getByTestId('role-prompt')
    await expect(prompt).toBeVisible()
    // All three are offered with a line each on what they give you: the narrowed one has to be
    // pickable knowingly, or it reads as a demotion the first time the sidebar shrinks.
    await expect(prompt.getByTestId('role-option-engineer')).toBeVisible()
    await expect(prompt.getByTestId('role-option-product-manager')).toBeVisible()
    await expect(prompt.getByTestId('role-option-designer')).toBeVisible()

    await prompt.getByTestId('role-option-engineer').click()
    // Answered, gone, and the board underneath is live again. The modal is a dismissable layer, so
    // a prompt that failed to close would leave every control unclickable rather than merely visible.
    await expect(page.getByTestId('role-prompt')).toHaveCount(0)
    await expect(page.getByTestId('nav-workspace-settings')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('role-prompt')).toHaveCount(0)
  })

  test('closing the question without answering leaves the full product', async ({
    page,
    request,
  }) => {
    // The safe default, and the reason the question can be asked at all: an unanswered role must
    // never take a destination away. (The tour offer is pre-answered by `pinWorkspace`, so the role
    // prompt is the only startup surface here.)
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id, { role: 'unanswered' })
    await openBoard(page)

    await page.getByTestId('role-prompt-close').click()
    await expect(page.getByTestId('role-prompt')).toHaveCount(0)
    await expect(page.getByTestId('nav-workspace-settings')).toBeVisible()
    await expect(page.getByTestId('ui-role-toggle')).toBeVisible()
  })

  test('a designer board keeps intake and the way back, and nothing else', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id, { role: 'designer' })
    await openBoard(page)

    // The platform half is absent from the DOM, not disabled, including the destinations whose
    // RBAC gates pass on this dev-open deployment, so the role is the only thing hiding them.
    await expect(page.getByTestId('nav-workspace-settings')).toHaveCount(0)
    await expect(page.getByTestId('nav-build-pipeline')).toHaveCount(0)
    await expect(page.getByTestId('nav-add-from-repo')).toHaveCount(0)
    await expect(page.getByTestId('nav-model-providers')).toHaveCount(0)
    await expect(page.getByTestId('nav-integrations')).toHaveCount(0)
    // What stays: the walkthroughs, and the switcher out of the role.
    await expect(page.getByTestId('nav-tutorial')).toBeVisible()
    await expect(page.getByTestId('ui-role-toggle')).toBeVisible()
    // The TIER switcher goes with the platform half: a narrowed role is capped at basic, so a
    // control that flipped it would advertise a choice the resolver ignores.
    await expect(page.getByTestId('ui-mode-toggle')).toHaveCount(0)
    await expect(page.getByTestId('ui-mode-switcher')).toHaveCount(0)
  })

  test('a designer frame header keeps adding a task and nothing that plans one', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id, { role: 'designer' })
    await openBoard(page)

    // The role reaches the BOARD, not just the nav. Add-task is the everyday intake act and stays;
    // the recurring-schedule and initiative buttons are advanced-tier authoring, and the tier cap
    // is what keeps them away: all three share one `board.write` gate, so nothing else can.
    const frame = taskCard(page, 'blk_auth')
    await expect(frame.getByTestId('frame-add-task').first()).toBeVisible()
    await expect(frame.getByTestId('frame-add-recurring')).toHaveCount(0)
    await expect(frame.getByTestId('frame-add-initiative')).toHaveCount(0)
  })

  test('leaving the designer role restores the full shell live', async ({ page, request }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id, { role: 'designer' })
    await openBoard(page)
    await expect(page.getByTestId('nav-workspace-settings')).toHaveCount(0)

    // Basic mode starts railed, so the switcher is the rail button; it keeps its menu in both forms
    // because with three roles there is no unambiguous "next one" to toggle to.
    await page.getByTestId('ui-role-toggle').click()
    await page.getByRole('menuitem', { name: 'Engineer', exact: true }).click()

    // No reload: the nav re-gates through the same reactive slot filter a permission flip uses, and
    // the tier switcher comes back with the rest of the platform half.
    await expect(page.getByTestId('nav-workspace-settings')).toBeVisible()
    await expect(page.getByTestId('nav-build-pipeline')).toBeVisible()
    await expect(page.getByTestId('ui-mode-toggle')).toBeVisible()
  })

  test('the command palette can reach the role question from a designer board', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id, { role: 'designer' })
    await openBoard(page)

    // The second route out, and the one a narrowed sidebar makes load-bearing. Driven by click
    // rather than ⌘K so the spec doesn't also depend on the shortcut binding.
    await page.getByTestId('command-bar-launcher').click()
    await expect(page.getByTestId('command-bar')).toBeVisible()
    await page.getByTestId('command-ui-role').click()

    await expect(page.getByTestId('role-prompt')).toBeVisible()
  })
})
