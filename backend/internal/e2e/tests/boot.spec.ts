import { test, expect } from './fixtures'
import { taskCard } from './helpers'

// The most basic e2e: the assembled product boots. The real SPA renders a real board
// hydrated from a real backend snapshot (real Postgres), with the auth gate open (no
// login screen). Proves the frontend + backend wiring and the snapshot round-trip.
//
// The `seededBoard` fixture seeds + pins + opens the board (and already asserts the
// seeded `task_login` rendered); the `pageErrors` auto fixture fails the test on any
// uncaught SPA exception. So this spec only adds the boot-specific assertions.
test.describe('board boot', () => {
  test('renders a seeded board from the real backend', async ({ page, seededBoard }) => {
    void seededBoard

    // No login screen — the dev-open gate let us straight in.
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0)

    // The seeded sample architecture rendered: the Auth Service frame and its runnable task.
    await expect(taskCard(page, 'blk_auth')).toBeVisible()
    await expect(taskCard(page, 'task_login')).toHaveAttribute('data-status', 'planned')
  })
})
