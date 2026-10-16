import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  AUTH_FRONTEND_URL,
  BOOT_TIMEOUT,
  createSeededWorkspace,
  LIVE_TIMEOUT,
  pinBoardForUser,
  pinWorkspace,
  seedPasswordUser,
} from './helpers'

// The new-API-key deep link (`?newApiKey=1&label=…&scope=…&runsAsSelf=1`), the way an integration
// sends a person to mint a key bound to them. The link is worth something only if the person lands
// on the API tokens window with the form filled in AND nothing minted yet: they review and create.

const LINK = '/?newApiKey=1&label=sainte-beuve&scope=decide&runsAsSelf=1'

async function expectPrefilledForm(page: Page): Promise<void> {
  const panel = page.getByTestId('api-tokens-panel')
  await expect(panel).toBeVisible({ timeout: BOOT_TIMEOUT })
  await expect(panel.getByTestId('api-token-label')).toHaveValue('sainte-beuve', {
    timeout: LIVE_TIMEOUT,
  })
  await expect(panel.getByTestId('api-token-scope')).toContainText('Decide')
  // Nothing was minted on the person's behalf: no key is listed until they click create.
  await expect(panel.getByTestId(/^api-token-revoke-/)).toHaveCount(0)
  await expect(panel.getByTestId('api-token-secret')).toHaveCount(0)
}

test.describe('new-API-key deep link', () => {
  test('opens the API tokens window with the label and scope filled in, minting nothing', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id)

    await page.goto(LINK)

    await expectPrefilledForm(page)
    // A dev-open board has nobody to bind a key to, so the runs-as choice is withheld.
    await expect(page.getByTestId('api-token-identity')).toHaveCount(0)
  })

  test.describe('signed out (the real login gate)', () => {
    test.use({ baseURL: AUTH_FRONTEND_URL })
    test.slow()

    const PASSWORD = 'e2e-new-api-key-link-password'

    test('signing in from the link keeps it, and the key is set to run as the person', async ({
      page,
      request,
    }) => {
      const tag = Math.random().toString(36).slice(2, 8)
      const user = await seedPasswordUser(request, { tag, password: PASSWORD })
      await pinBoardForUser(page, {
        workspaceId: user.workspaceId,
        accountId: user.accountId,
        userId: user.userId,
      })

      await page.goto(LINK)
      const login = page.getByTestId('login-screen')
      await expect(login).toBeVisible({ timeout: BOOT_TIMEOUT })
      await login.getByTestId('login-email').fill(user.email)
      await login.getByTestId('login-password').fill(PASSWORD)
      await login.getByTestId('login-submit').click()

      await expectPrefilledForm(page)
      await expect(page.getByTestId('api-token-identity')).toContainText('Me (personal token)')
    })
  })
})
