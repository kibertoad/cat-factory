import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import {
  AUTH_FRONTEND_URL,
  BOOT_TIMEOUT,
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSeededWorkspace,
  createSimplePipeline,
  openBoard,
  openTaskFocusView,
  pinWorkspace,
  seedPasswordUser,
  setFakeProfile,
  startRun,
  taskCard,
  useAdvancedInterfaceMode,
} from './helpers'

// LOCAL ONLY, never committed: captures the before/after evidence for issue #2249
// (Nuxt UI primitives replace raw HTML). Run once on the base branch and once on the
// converted branch with a different SHOT_DIR, then diff the pairs.
const DIR = process.env.SHOT_DIR ?? '/tmp/shots'
mkdirSync(DIR, { recursive: true })

async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  // Give fonts/transitions a beat so the two runs are comparable.
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(DIR, `${name}.png`), fullPage: false })
}

test.use({ viewport: { width: 1440, height: 900 } })

test.describe('#2249 evidence', () => {
  test.slow()

  test('board, sidebar, command bar, add-task modal', async ({ page, seededBoard }) => {
    void seededBoard
    await shot(page, '01-board')

    await page.getByTestId('command-bar-launcher').click()
    await expect(page.getByTestId('command-bar')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await shot(page, '02-command-bar')
    await page.keyboard.press('Escape')

    await taskCard(page, 'blk_auth').getByTestId('frame-add-task').first().click()
    await expect(page.getByTestId('add-task-modal')).toBeVisible()
    await shot(page, '03-add-task-modal')
    await page.keyboard.press('Escape')
  })

  test('advanced destinations: pipeline builder, settings, kaizen, sandbox, providers', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id)
    await useAdvancedInterfaceMode(page)
    await openBoard(page)

    const destinations: Array<[string, string]> = [
      ['nav-build-pipeline', '04-pipeline-builder'],
      ['nav-workspace-settings', '05-workspace-settings'],
      ['nav-kaizen', '06-kaizen'],
      ['nav-sandbox', '07-sandbox'],
      ['nav-model-providers', '08-model-providers'],
      ['nav-integrations', '09-integrations'],
    ]
    for (const [testid, name] of destinations) {
      const nav = page.getByTestId(testid)
      if ((await nav.count()) === 0) {
        console.log(`skip ${name}: ${testid} not present`)
        continue
      }
      await nav.click()
      await page.waitForTimeout(800)
      await shot(page, name)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
  })

  test('result window shell (merger): close button and disclosures', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [], confidence: 0.2 })
    const pipeline = await createSimplePipeline(request, workspaceId, [
      'architect',
      'coder',
      'merger',
    ])
    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    await openTaskFocusView(card)
    await shot(page, '10-focus-view')

    const mergerStep = page.locator('[data-testid="pipeline-step"][data-step-kind="merger"]')
    await expect(mergerStep).toBeVisible({ timeout: LIVE_TIMEOUT })
    await mergerStep.click()
    await expect(page.getByTestId('result-window')).toBeVisible()
    await shot(page, '11-result-window')
  })

  test('login screen', async ({ page, request }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    await seedPasswordUser(request, { tag, password: 'e2e-correct-horse-battery-staple' })
    await page.goto(`${AUTH_FRONTEND_URL}/`)
    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: BOOT_TIMEOUT })
    await shot(page, '12-login')
  })
})
