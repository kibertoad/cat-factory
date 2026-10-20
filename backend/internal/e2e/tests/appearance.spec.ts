import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// The Appearance switcher as the assembled product shows it: pick a THEME and a colour MODE from the
// sidebar menu and assert what only the running app can prove. The unit specs cover the document
// expansion and the store; the parity spec pins token values after a reload. What neither can see:
//   - the ramps Nuxt UI's colours plugin re-emits when `appConfig.ui.colors` changes at runtime;
//   - the two `theme-color` metas following the APP's mode and theme, not the OS scheme;
//   - the loading-shell cache naming the active theme (a stale entry dressed the shell in the
//     previous theme; a capture that ran before unhead wrote the ramps recorded the old colours).
// Each of the three escaped the first review because nothing drove the menu.

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

async function bootCache(page: Page): Promise<{ theme?: string; light?: unknown; dark?: unknown }> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('cf-boot-palette') ?? '{}'))
}

test.describe('appearance switcher', () => {
  test('picking a theme re-emits the ramps, tints the browser chrome and re-keys the boot cache', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    await pickAppearance(page, 'Dark')
    await expect(page.locator('html')).toHaveClass(/dark/)

    await pickAppearance(page, 'Mono')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'mono')
    // Mono: black as primary (white in dark), a pure grey neutral, a 0.5rem radius. The primary
    // token comes from the theme stylesheet, the neutral ramp from the colours plugin re-running
    // on the changed `appConfig.ui.colors`, the radius from the stylesheet: three seams, one pick.
    await expect.poll(() => resolve(page, 'var(--ui-primary)')).toBe(await resolve(page, 'white'))
    // Tailwind's `neutral-500` (theme.css), the ramp the Mono document maps `neutral` onto.
    expect(await resolve(page, 'var(--ui-color-neutral-500)')).toBe(
      await resolve(page, 'oklch(55.6% 0 none)'),
    )
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--ui-radius').trim(),
      ),
    ).toBe('0.5rem')

    // Both chrome metas carry the live canvas, and there are exactly two (unhead dedupes them by
    // name and media; a keyed or hand-edited tag would have left a duplicate beside them).
    const canvas = await resolve(page, 'var(--app-bg-canvas)')
    await expect
      .poll(async () => (await themeColorMetas(page)).map((m) => m.content))
      .toEqual([canvas, canvas])
    expect((await themeColorMetas(page)).map((m) => m.media)).toEqual([
      '(prefers-color-scheme: dark)',
      '(prefers-color-scheme: light)',
    ])

    // The boot cache names the theme and holds ONLY the mode seen under it.
    await expect.poll(async () => (await bootCache(page)).theme).toBe('mono')
    const cache = await bootCache(page)
    expect(cache.dark).toBeTruthy()
    expect(cache.light).toBeUndefined()

    // Back to the default: the cache re-keys and drops Mono's dark entry.
    await pickAppearance(page, 'Cat Factory')
    await expect.poll(async () => (await bootCache(page)).theme).toBe('cat-factory')
  })

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
