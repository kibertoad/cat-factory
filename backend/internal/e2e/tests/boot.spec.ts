import { expect, test } from '@playwright/test'
import { createSeededWorkspace, openBoard, pinWorkspace, taskCard } from './helpers'

// The most basic e2e: the assembled product boots. The real SPA renders a real board
// hydrated from a real backend snapshot (real Postgres), with the auth gate open (no
// login screen). Proves the frontend + backend wiring and the snapshot round-trip.
test.describe('board boot', () => {
  test('renders a seeded board from the real backend', async ({ page, request }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id)

    // Fail on uncaught exceptions in the app (more meaningful than noisy console.error).
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await openBoard(page)

    // No login screen — the dev-open gate let us straight in.
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0)

    // The seeded sample architecture rendered: the Auth Service frame's runnable task.
    await expect(taskCard(page, 'task_login')).toBeVisible()
    await expect(taskCard(page, 'task_login')).toHaveAttribute('data-status', 'planned')

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([])
  })
})
