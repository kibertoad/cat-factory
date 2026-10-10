import { test, expect } from './fixtures'
import {
  AUTH_FRONTEND_URL,
  BOOT_TIMEOUT,
  LIVE_TIMEOUT,
  pinBoardForUser,
  seedPasswordUser,
  taskCard,
} from './helpers'

// THE FRONT DOOR: the login screen, a real session, and signing out.
//
// Every other spec runs against the `TESTING_NO_AUTH` backend, where the SPA renders the board
// anonymously, so the one surface EVERY user of a hosted deployment passes through had no coverage
// at all, and its failure mode is the worst one in the product: nobody gets in, and no test says so.
// The pieces are only meaningful assembled, because the question is not "does the endpoint mint a
// token" (conformance covers that) but whether the SPA gates on it, keeps it across a reload, and
// gives it up on sign-out.
//
// This spec therefore drives the AUTH-ENABLED stack: a second HTTP surface over the same backend
// process with `config.auth` on, and a second instance of the same SPA build pointed at it (see
// `AUTH_FRONTEND_URL`). Setup still goes through the anonymous surface, which is the same process.
test.describe('sign-in (password auth, the real login gate)', () => {
  test.use({ baseURL: AUTH_FRONTEND_URL })
  test.slow()

  const PASSWORD = 'e2e-correct-horse-battery-staple'

  test('the login screen gates the board; a wrong password is refused, the right one signs in, the session survives a reload, and sign-out returns to the gate', async ({
    page,
    request,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const user = await seedPasswordUser(request, { tag, password: PASSWORD })
    // Which board opens once they are in is scenery for this spec, but it has to be SAID: a
    // signed-in user's board list is account-filtered, so without a pin the SPA opens the first
    // board of whichever account is active and creates an empty one when that is none, landing the
    // session on the repo-onboarding gate rather than a board. No token here: signing in is the
    // subject, so the session must come from the form.
    await pinBoardForUser(page, {
      workspaceId: user.workspaceId,
      accountId: user.accountId,
      userId: user.userId,
    })

    // 1) GATED. No session, so the board is not served: the SPA resolves the auth handshake and
    // renders the login screen instead. This is the assertion that fails if a deployment ever
    // starts rendering the board to an unauthenticated visitor.
    await page.goto('/')
    const login = page.getByTestId('login-screen')
    await expect(login).toBeVisible({ timeout: BOOT_TIMEOUT })
    await expect(page.getByTestId('board-canvas')).toHaveCount(0)

    // 2) REFUSED. The wrong password is reported on the form and leaves the gate up. The failure
    // has to be visible and non-advancing, since a silent one reads as "nothing happened" and a
    // silent SUCCESS would be the security bug.
    await login.getByTestId('login-email').fill(user.email)
    await login.getByTestId('login-password').fill('not-the-password')
    await login.getByTestId('login-submit').click()
    await expect(login.getByTestId('login-error')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(login).toBeVisible()

    // 3) SIGNED IN. The real credential mints a real session and the board loads AS that user: the
    // sidebar identity is what proves the session resolved to a person rather than the SPA simply
    // dropping the gate, and the seeded task is what proves it resolved to their account's board.
    await login.getByTestId('login-password').fill(PASSWORD)
    await login.getByTestId('login-submit').click()
    await expect(page.getByTestId('board-canvas')).toBeVisible({ timeout: BOOT_TIMEOUT })
    await expect(taskCard(page, 'task_login')).toBeVisible({ timeout: LIVE_TIMEOUT })
    const identity = page.getByTestId('user-menu')
    // By accessible name rather than text: the sidebar rail is collapsed at the shipped default, so
    // the name is the button's `title` there and its text content when expanded. Asserting the
    // accessible name says "the signed-in person is named here" in either state, instead of pinning
    // the tier for a reason that has nothing to do with signing in.
    await expect(identity).toHaveAccessibleName(new RegExp(user.name))
    // The live channel connects for an authenticated session too: the WebSocket upgrade is
    // authorised by a ticket the signed-in caller mints, so this is the one assertion that would
    // catch a session good enough for REST and not for the stream.
    await expect(page.getByTestId('workspace-stream')).toHaveAttribute('data-connected', 'true', {
      timeout: LIVE_TIMEOUT,
    })

    // 4) PERSISTED. A reload is the point here rather than something to avoid: the session lives in
    // a persisted cookie and is re-resolved on boot, so this is the only way to show that a signed-in
    // user is not handed the login screen again on their next visit.
    await page.reload()
    await expect(page.getByTestId('board-canvas')).toBeVisible({ timeout: BOOT_TIMEOUT })
    await expect(page.getByTestId('login-screen')).toHaveCount(0)

    // 5) SIGNED OUT. The menu item is addressed by role because a dropdown item is data rather than
    // markup this layer owns. Sign-out must drop the session, not just navigate: the gate coming
    // back up on a RELOAD is what says the stored token is gone.
    await identity.click()
    await page.getByRole('menuitem', { name: /sign out/i }).click()
    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await page.reload()
    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: BOOT_TIMEOUT })
    await expect(page.getByTestId('board-canvas')).toHaveCount(0)
  })
})
