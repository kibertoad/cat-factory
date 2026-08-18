import { test, expect } from './fixtures'
import {
  createSeededWorkspace,
  createSimplePipeline,
  findRiskPolicyByName,
  LIVE_TIMEOUT,
  openBoard,
  pinWorkspace,
  readBlockStatus,
  RUN_TERMINAL_TIMEOUT,
  selectTask,
  setFakeProfile,
  startRun,
  taskCard,
  type RiskPolicyShape,
  useAdvancedInterfaceMode,
} from './helpers'

// THE MERGE POLICY A HUMAN AUTHORS IS THE POLICY THE MERGER APPLIES.
//
// The auto-merge ceilings are the one setting in the product that decides, unattended, whether an
// agent's work LANDS on the default branch. Two surfaces own that decision and nothing covered
// either: the merge-threshold library in Workspace Settings (`RiskPolicyPanel`, full CRUD) and the
// per-task picker in the inspector that pins one (`RiskPolicyPicker` → `Block.riskPolicyId`).
// `merge-review.spec` already proves a SEVERE assessment is refused, but it gets there by making
// the agent report a bad diff, and nothing there depends on the policy at all, so a settings panel
// that dropped a field, wrote percentages as fractions, or a picker whose selection never reached
// the block would leave that spec green while quietly auto-merging what an operator had forbidden.
//
// So both tests here hand the merger the SAME assessment (`ASSESSMENT`, comfortably inside the
// shipped `Balanced` ceilings of 50/40/50) and change only the POLICY:
//
//   1. under the workspace default it auto-merges, and
//   2. under a stricter preset typed into the settings panel and pinned on the task, the identical
//      assessment is refused and raises `merge_review`.
//
// Test 1 is what makes test 2 mean anything: on its own, a refusal could be any of a dozen
// unrelated things going wrong, and the pair is the only way to show the ceilings decided it.
const ASSESSMENT = {
  complexity: 0.3,
  risk: 0.3,
  impact: 0.3,
  // Non-empty by necessity, not decoration: the engine's credibility backstop refuses to
  // auto-merge an assessment that explains nothing, whatever its scores (`MergeResolver`).
  rationale: 'e2e: three files touched behind an existing flag, covered by tests',
} as const

/** The strict preset this spec authors: every ceiling below the assessment's scores. */
const STRICT = { name: 'E2E strict landing policy', ceiling: 10 } as const

test.describe('merge policy (authored in the UI, applied by the merger)', () => {
  test.slow()

  test('the workspace default preset auto-merges a within-threshold assessment', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      mergeAssessment: ASSESSMENT,
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'merger'])

    const card = taskCard(page, 'task_login')
    await expect(card).toHaveAttribute('data-status', 'planned')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the merge actually lands, and the board says so by moving the task out of its three
    // live swimlanes: a merged task stops being a unit of work and joins the frame's Done lane,
    // which is COLLAPSED by default, so no card for it is in the DOM. Asserting the absence is
    // only sound because the card was asserted PRESENT above, so this is a transition rather
    // than a never-rendered node.
    await expect(card).toBeHidden({ timeout: RUN_TERMINAL_TIMEOUT })
    // Corroboration over REST for WHICH terminal state that absence is: `done` (merged), not the
    // `pr_ready` a refusal would have left behind. The absence alone cannot tell those apart.
    expect(await readBlockStatus(request, workspaceId, 'task_login')).toBe('done')
    // And no review was ever asked for: with the merge landed there is nothing for a human to do.
    await expect(page.getByTestId('notifications-bell')).toBeHidden()
  })

  test('a preset authored in Workspace Settings and pinned on the task refuses the same assessment', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    const workspaceId = snapshot.workspace.id
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      mergeAssessment: ASSESSMENT,
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'merger'])
    // The per-task merge-policy picker is an OVERRIDE control, so basic mode hides it until one is
    // already set (`showOverrideField`); the palette entry that opens the library is `advanced`
    // too. Both halves of this spec's subject therefore live in the advanced tier.
    await useAdvancedInterfaceMode(page)
    await pinWorkspace(page, workspaceId)
    await openBoard(page)

    // 1) AUTHOR the policy. The merge-threshold library is reached through the command palette,
    // which deep-links Workspace Settings straight to its Merge tab.
    await page.getByTestId('command-bar-launcher').click()
    await expect(page.getByTestId('command-bar')).toBeVisible()
    await page.getByTestId('command-merge-thresholds').click()
    const panel = page.getByTestId('risk-policy-panel')
    await expect(panel).toBeVisible({ timeout: LIVE_TIMEOUT })

    await panel.getByTestId('risk-policy-create-name').fill(STRICT.name)
    for (const axis of ['complexity', 'risk', 'impact'] as const) {
      await panel.getByTestId(`risk-policy-create-${axis}`).fill(String(STRICT.ceiling))
    }
    await panel.getByTestId('risk-policy-create-submit').click()

    // The panel reloads the library from the backend after a create, so the stored preset and the
    // rendered row are two halves of the same round trip: poll for the row server-side, then
    // assert the panel is rendering THAT id rather than an optimistic local copy.
    let created: RiskPolicyShape | null = null
    await expect
      .poll(
        async () => {
          created = await findRiskPolicyByName(request, workspaceId, STRICT.name)
          return created?.id ?? null
        },
        { timeout: LIVE_TIMEOUT },
      )
      .not.toBeNull()
    const preset = created as unknown as RiskPolicyShape
    await expect(
      panel.locator(`[data-testid="risk-policy-row"][data-policy-id="${preset.id}"]`),
    ).toBeVisible()
    // The numbers the form TYPED are the numbers the merger will judge with: percentages in the
    // editor, fractions on the wire. A panel that shipped 10 as `10` (or 0.1 as `0.001`) would
    // still create a preset and still refuse this assessment, so the stored value is asserted
    // rather than inferred from the refusal below.
    expect(preset).toMatchObject({
      maxComplexity: STRICT.ceiling / 100,
      maxRisk: STRICT.ceiling / 100,
      maxImpact: STRICT.ceiling / 100,
      autoMergeEnabled: true,
      isDefault: false,
    })
    // Leave the settings modal the way a user does, so the board underneath is actionable again.
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()

    // 2) PIN it on the task, through the inspector's own picker (the popover is teleported out of
    // the inspector, so the panel is located off the page).
    const card = taskCard(page, 'task_login')
    await selectTask(card)
    const inspector = page.getByTestId('inspector-panel')
    await expect(inspector).toBeVisible({ timeout: LIVE_TIMEOUT })
    await inspector
      .getByTestId('inspector-section')
      .filter({ hasText: 'Run settings' })
      .getByTestId('inspector-section-toggle')
      .click()
    await page.getByTestId('risk-policy-picker-trigger').click()
    const picker = page.getByTestId('risk-policy-picker-panel')
    await expect(picker).toBeVisible()
    await picker.getByTestId(`risk-policy-option-${preset.id}`).click()
    // The inspector summarises the RESOLVED policy for the block, so its name appearing there is
    // the selection having round-tripped through `PATCH /blocks/:id` and back onto the board store.
    await expect(inspector).toContainText(STRICT.name, { timeout: LIVE_TIMEOUT })

    // 3) RUN it. Same assessment as the auto-merging test above; only the policy changed.
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the merger declines, so the task survives at `pr_ready` (it did NOT land) and the
    // review lands in the inbox for a human.
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    await expect(
      page.locator('[data-testid="notification-item"][data-notification-type="merge_review"]'),
    ).toBeVisible()
  })
})
