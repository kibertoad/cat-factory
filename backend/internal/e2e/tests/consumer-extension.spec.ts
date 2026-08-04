import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  createTask,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// Slice A of the frontend-extension-mechanism initiative
// (docs/initiatives/frontend-extension-mechanism.md): the DOGFOOD proof that a consumer
// deployment can extend the SPA through `registerAppModule` alone — no host edits, no fork.
//
// The example consumer module ships in the very deployment this suite serves
// (`deploy/frontend/app/`, the `acme:security` module — the frontend analogue of the backend
// `@cat-factory/example-custom-agent`). It contributes to every landed consumer seam:
//   - `nav`             → a sidebar destination (`nav-acme-security`);
//   - `inspectorPanels` → an extra inspector body panel for task blocks (`acme-incident-panel`);
//   - `resultViews` + `agentKinds` → a bespoke run-detail window (`acme-security-report-window`)
//     for the `security-auditor` kind, reusing the layer's shared `ResultWindowShell` +
//     `StepRunMeta` chrome.
//
// This drives all three through the REAL assembled product (the built `deploy/frontend` SPA
// against the real Node backend), so a regression in the consumer seams — or in a shared
// building block a consumer window composes — fails here.
test.describe('consumer extension (dogfood)', () => {
  test('a consumer nav entry and inspector panel render from a registered module', async ({
    page,
    seededBoard,
  }) => {
    // `seededBoard` opened a fresh board (its fixture is the precondition these assertions run
    // against); a truthy workspace id is the sanity check that the seed landed.
    expect(seededBoard.workspaceId, 'board seeded').toBeTruthy()

    // The consumer nav item is contributed to the `nav` slot; the sidebar renders it with no
    // shell edit. Its label comes from the deployment's own i18n catalog (`acme.*`).
    await expect(page.getByTestId('nav-acme-security')).toBeVisible({ timeout: LIVE_TIMEOUT })

    // Selecting a task block opens the inspector, whose body is the `inspectorPanels` panel
    // group (`<PanelsOutlet>`). The consumer panel's `when(block)` matches task-level blocks,
    // so it renders for the seeded `task_login` alongside the built-in panels — zero host edit.
    await taskCard(page, 'task_login').click()
    await expect(page.getByTestId('inspector-panel')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(page.getByTestId('acme-incident-panel')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(page.getByTestId('acme-incident-status')).toBeVisible()

    // Prove the panel actually reuses the shared `<InspectorSection>` chrome — not just that
    // its own body markup rendered. A consumer SFC that referenced the layer component by a
    // bare tag would silently render it as an unknown element (its children leak, but its
    // `inspector-section` chrome never mounts); asserting the acme panel is wrapped in a
    // resolved `inspector-section` with its collapse toggle is what catches that regression.
    const acmeSection = page
      .getByTestId('inspector-section')
      .filter({ has: page.getByTestId('acme-incident-panel') })
    await expect(acmeSection).toBeVisible()
    await expect(acmeSection.getByTestId('inspector-section-toggle')).toBeVisible()
  })

  // Slice D (overlays): the consumer nav item's `run` closure opens a CODE-shipped top-level
  // overlay (`appOverlays` slot → `AcmeSecurityDashboard`) via `useAppOverlays()`. Before slice
  // D a consumer nav item had no host surface to open — this proves the `appOverlays` slot →
  // `<AppOverlayHost>` path end-to-end through the assembled product, including that the overlay
  // inherits the shared shell's Escape (owned by `useModalBehavior`).
  test('a consumer nav entry opens a registered top-level overlay', async ({
    page,
    seededBoard,
  }) => {
    expect(seededBoard.workspaceId, 'board seeded').toBeTruthy()

    // The overlay is not mounted until opened — `<AppOverlayHost>` renders nothing at rest.
    const overlay = page.getByTestId('acme-security-dashboard-window')
    await expect(overlay).toBeHidden()

    // Click the consumer sidebar item; its `run` calls `useAppOverlays().open(...)`, and the
    // layer's single `<AppOverlayHost>` resolves the `appOverlays` slot and mounts the paired
    // consumer component — zero host edit.
    await page.getByTestId('nav-acme-security').click()
    await expect(overlay).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(overlay.getByTestId('acme-security-dashboard-body')).toBeVisible()

    // Escape is owned by the shared `ResultWindowShell`'s `useModalBehavior`, which the consumer
    // overlay composes for its chrome — so the consumer inherits it and the overlay closes.
    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()
  })

  test('a security-auditor step opens the consumer result window', async ({
    page,
    request,
    seededBoard,
  }) => {
    test.slow()
    const { workspaceId } = seededBoard
    // Straight run to terminal: disable the default step-0 decision so it flows through the
    // coder (which opens the default PR) into the consumer `security-auditor` step. The kind is
    // not a backend built-in, so the deterministic fake runs it inline and returns prose — the
    // window renders that; a deployment shipping `@cat-factory/example-custom-agent` on the
    // backend would additionally get the structured assessment on `step.custom`.
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [] })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'security-auditor'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    // The merger-less pipeline settles the task at `pr_ready` (pushed live).
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    // Open the run's step list and route the completed `security-auditor` step to its dedicated
    // window. The kind resolves its `resultView` (`acme:security-report`) through the merged
    // agent catalog (the consumer `agentKinds` slot), and `StepResultViewHost` mounts the
    // paired consumer component.
    await card.click()
    const auditorStep = page.locator(
      '[data-testid="pipeline-step"][data-step-kind="security-auditor"]',
    )
    await expect(auditorStep).toBeVisible({ timeout: LIVE_TIMEOUT })
    await auditorStep.click()

    // The bespoke consumer window renders inside the shared `ResultWindowShell` chrome with its
    // own body — proving the pairing + the shared-building-block reuse end to end.
    const dialog = page.getByTestId('acme-security-report-window')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('acme-security-body')).toBeVisible()

    // Escape is owned by the shared shell's `useModalBehavior` — the consumer window inherits it.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  // Slice B (custom task types): the consumer module contributes a CODE-shipped `acme:incident`
  // task type via the `taskTypes` slot. A task created with that namespaced type (accepted by the
  // widened `taskType` contract) reaches the board LIVE and its card renders the type BADGE — its
  // icon/label/color resolved through the merged task-type catalog + the `taskTypeMeta` read-model,
  // proving the code-shipped slot → catalog → card path end-to-end through the assembled product.
  // A run isn't needed: this is a create + live-push + read-model render, not an execution.
  test('a custom-typed task renders its card badge from a registered taskTypes slot', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // Create an `acme:incident` task under `blk_auth` (the seeded module that homes `task_login`,
    // so its sibling renders at the same default zoom). The backend accepts the namespaced type
    // (widened contract) and stores the descriptor value in `taskTypeFields.custom` — no backend
    // registration needed; the presentation is the deployment's code-shipped slot.
    const task = await createTask(request, workspaceId, 'blk_auth', 'DB outage', {
      taskType: 'acme:incident',
      taskTypeFields: { custom: { severity: 'sev1' } },
    })

    // The new card is pushed onto the board live (a coarse `board` event → refresh).
    const card = taskCard(page, task.id)
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })

    // Its type badge renders the consumer type's presentation: the label as the hover title and
    // the raw type on `data-task-type-badge`. A built-in `feature` sibling shows no badge, so a
    // visible badge here is proof the custom type resolved through the merged catalog.
    const badge = card.getByTestId('task-type-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-task-type-badge', 'acme:incident')
    await expect(badge).toHaveAttribute('title', 'Incident')
  })

  // Reusable-operations slice 3: the create-task picker GROUPS the deployment's registered types
  // under their declared `presentation.category` instead of flattening them into the built-in row.
  // The layout rule itself is unit-tested (`utils/taskTypePicker.spec.ts`); what only the assembled
  // product can show is that the rendered picker actually nests — a template regression that put
  // every choice back in one row, or dropped the caption, would leave those unit tests green.
  test('the create-task picker groups a registered type under its category caption', async ({
    page,
    seededBoard,
  }) => {
    expect(seededBoard.workspaceId, 'board seeded').toBeTruthy()

    // Open the modal from the Auth Service frame's header button (the create-task.spec path).
    await taskCard(page, 'blk_auth').getByTestId('frame-add-task').first().click()
    const modal = page.getByTestId('add-task-modal')
    await expect(modal).toBeVisible({ timeout: LIVE_TIMEOUT })

    // The consumer type's button sits in a row of its OWN, captioned with the category the module
    // declared. Asserting through the row (rather than on the caption testid, which repeats per
    // row) is what proves the nesting: a flattened picker puts this button in the built-in row,
    // which has no caption at all.
    const incidentRow = modal
      .getByTestId('task-type-row')
      .filter({ has: modal.getByTestId('task-type-acme:incident') })
    await expect(incidentRow).toHaveAttribute('data-task-type-row', 'category:incident response')
    await expect(incidentRow.getByTestId('task-type-category')).toHaveText('Incident response')

    // The built-in choices stay first and stay uncaptioned: the everyday loop is where it was.
    const builtInRow = modal.locator('[data-task-type-row="built-in"]')
    await expect(builtInRow.getByTestId('task-type-feature')).toBeVisible()
    await expect(builtInRow.getByTestId('task-type-category')).toHaveCount(0)

    // Picking the type renders its `presentation.description` verbatim, in the field's help slot:
    // the half a touch device can reach (the per-button `title` covers the hover half).
    await expect(modal.getByTestId('task-type-description')).toHaveCount(0)
    await modal.getByTestId('task-type-acme:incident').click()
    await expect(modal.getByTestId('task-type-description')).toHaveText(
      'A production incident to triage and resolve.',
    )
  })
})
