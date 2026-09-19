import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// The Appearance switcher as the assembled product shows it: pick a colour MODE from the sidebar
// menu and assert what only the running app can prove: the two `theme-color` metas follow the
// APP's mode, not the OS scheme, and the pick survives a reload. It escaped the first review
// because nothing drove the menu.

async function pickAppearance(page: Page, item: string): Promise<void> {
  await page.getByTestId('appearance-switcher').click()
  await page.getByRole('menuitemcheckbox', { name: item }).click()
}

/** A CSS colour expression resolved to the browser's computed form. */
async function resolve(page: Page, expr: string): Promise<string> {
  return page.evaluate((value: string) => {
    const el = document.createElement('div')
    el.style.color = value
    document.body.appendChild(el)
    const out = getComputedStyle(el).color
    el.remove()
    return out
  }, expr)
}

async function themeColorMetas(
  page: Page,
): Promise<Array<{ content: string; media: string | null }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => ({
      content: m.content,
      media: m.getAttribute('media'),
    })),
  )
}

test.describe('appearance switcher', () => {
  test('the colour mode follows the app, not the OS', async ({ page, seededBoard }) => {
    void seededBoard
    await page.emulateMedia({ colorScheme: 'dark' })
    await pickAppearance(page, 'Light')
    await expect(page.locator('html')).toHaveClass(/light/)
    // A dark OS, a light app: the chrome shows the LIGHT canvas under both media queries.
    const canvas = await resolve(page, 'var(--app-bg-canvas)')
    await expect
      .poll(async () => (await themeColorMetas(page)).map((m) => m.content))
      .toEqual([canvas, canvas])
    // The pick survives a reload (the colour-mode script in <head> classes <html> before paint).
    await page.reload()
    await expect(page.locator('html')).toHaveClass(/light/)
    await expect(page.getByTestId('appearance-switcher')).toBeVisible()
  })
})
