import { test, expect } from './fixtures'
import {
  addServiceFromRepo,
  createSeededWorkspace,
  createTask,
  GITHUB_REPO,
  LIVE_TIMEOUT,
  openBoard,
  pinWorkspace,
  seedGitHub,
  taskCard,
} from './helpers'

// GitHub App integration coverage against the assembled product. The e2e backend fakes GitHub
// ON with NO real credentials (see src/fakeGitHub.ts): the module is wired through
// `buildNodeContainer` overrides, the read endpoints serve from real Postgres projections, and
// `seedGitHub` connects a workspace with the deterministic `octo/demo` repo + branches. This
// exercises what only the assembled product can show — a repo becoming a live board service,
// and the repo/branch projection surfacing in the task inspector — which the pure conformance
// suite (port-by-port) can't.
//
// Each test seeds its OWN workspace and connects GitHub BEFORE opening the board, so the SPA
// loads the connected state on first paint (the seed→open pattern the `seededBoard` fixture
// uses, extended with a GitHub-connection seed). No live-push races, no reloads.
test.describe('GitHub integration (faked App, real projections)', () => {
  test('import a repo as a board service → the frame appears live on the board', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    const ws = snapshot.workspace.id
    await seedGitHub(request, ws)
    await pinWorkspace(page, ws)
    await openBoard(page)

    // Import the connected repo as a service frame over REST — the endpoint the add-service
    // modal posts to. The backend pushes the new frame onto the board live (a `board` event).
    const frame = await addServiceFromRepo(request, ws, GITHUB_REPO.githubId)
    await expect(taskCard(page, frame.id)).toBeVisible({ timeout: LIVE_TIMEOUT })
  })

  test('a task under an imported-repo frame offers its branches as apriori branches', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    const ws = snapshot.workspace.id
    await seedGitHub(request, ws)
    // A repo-linked service frame + a task under it, seeded over REST before the board opens.
    const frame = await addServiceFromRepo(request, ws, GITHUB_REPO.githubId)
    const task = await createTask(request, ws, frame.id, 'Apriori branches task')
    await pinWorkspace(page, ws)
    await openBoard(page)

    // Open the task's inspector (selecting the node) and expand its collapsed "Run settings".
    await taskCard(page, task.id).click()
    const inspector = page.getByTestId('inspector-panel')
    await expect(inspector).toBeVisible({ timeout: LIVE_TIMEOUT })
    const runSettings = inspector
      .getByTestId('inspector-section')
      .filter({ hasText: 'Run settings' })
    await runSettings.getByTestId('inspector-section-toggle').click()

    // The apriori-branches picker renders ONLY once the task's service frame resolves to a
    // linked repo (this is the slice-4 surface, and the exact state that was unreachable while
    // the e2e backend ran with GitHub off). Its branch picker is enabled because the workspace
    // is connected — assert both.
    const apriori = inspector.getByTestId('apriori-branches')
    await expect(apriori).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(apriori.getByTestId('apriori-branch-search')).toBeVisible()
  })
})
