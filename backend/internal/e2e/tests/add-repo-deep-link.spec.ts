import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  AUTH_FRONTEND_URL,
  BOOT_TIMEOUT,
  createSeededWorkspace,
  GITHUB_REPO,
  LIVE_TIMEOUT,
  pinBoardForUser,
  pinWorkspace,
  seedGitHub,
  seedPasswordUser,
} from './helpers'

// The add-repository deep link (`?addRepo=<owner>/<name>&provider=github`), the way an integration
// sends a person to add a service for a repository it found no service for. The link is only worth
// anything if the person lands on the window with THAT repository picked, so every case asserts the
// one state that proves it: the window's submit is enabled, which it is only once a repository is
// selected.

function addRepoLink(repo: { owner: string; name: string }): string {
  return `/?addRepo=${encodeURIComponent(`${repo.owner}/${repo.name}`)}&provider=github`
}

async function expectWindowOn(page: Page, repo: string): Promise<void> {
  const search = page.getByTestId('add-service-repo-search')
  await expect(search).toBeVisible({ timeout: BOOT_TIMEOUT })
  await expect(search.locator('input')).toHaveValue(new RegExp(`^${repo}`), {
    timeout: LIVE_TIMEOUT,
  })
  await expect(page.getByTestId('add-service-submit')).toBeEnabled({ timeout: LIVE_TIMEOUT })
}

test.describe('add-repository deep link', () => {
  test('a signed-in person lands on the add-service window with the repository selected', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    const ws = snapshot.workspace.id
    // The shared repository, which is the one the faked connection's search answers. A fresh board
    // mounts no service for it, so it lists as addable.
    await seedGitHub(request, ws)
    await pinWorkspace(page, ws)

    await page.goto(addRepoLink(GITHUB_REPO))

    await expectWindowOn(page, `${GITHUB_REPO.owner}/${GITHUB_REPO.name}`)
  })

  test.describe('signed out (the real login gate)', () => {
    test.use({ baseURL: AUTH_FRONTEND_URL })
    test.slow()

    const PASSWORD = 'e2e-add-repo-link-password'

    test('signing in from the link keeps it, and lands on the window with the repository selected', async ({
      page,
      request,
    }) => {
      const tag = Math.random().toString(36).slice(2, 8)
      // A fresh account whose board is connected to the same shared repository.
      const user = await seedPasswordUser(request, { tag, password: PASSWORD })
      await pinBoardForUser(page, {
        workspaceId: user.workspaceId,
        accountId: user.accountId,
        userId: user.userId,
      })

      await page.goto(addRepoLink(GITHUB_REPO))
      const login = page.getByTestId('login-screen')
      await expect(login).toBeVisible({ timeout: BOOT_TIMEOUT })
      await login.getByTestId('login-email').fill(user.email)
      await login.getByTestId('login-password').fill(PASSWORD)
      await login.getByTestId('login-submit').click()

      await expectWindowOn(page, `${GITHUB_REPO.owner}/${GITHUB_REPO.name}`)
    })
  })
})
