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
})
