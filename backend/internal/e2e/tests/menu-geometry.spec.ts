import { test, expect } from './fixtures'
import { addFrame, LIVE_TIMEOUT, taskCard } from './helpers'

// A popover menu must render its options INSIDE the popover it drew.
//
// Nuxt UI names the scroll region of eleven different components `[data-slot='viewport']` — the
// toaster, and the item list of Select, SelectMenu, InputMenu, CommandPalette, DropdownMenu,
// ContextMenu, NavigationMenu, ScrollArea, Carousel and ChatMessages. All the menu ones are
// `position: relative`, so ONE app-level rule written for the toaster and hung on that attribute
// re-offsets every menu in the SPA: a `bottom: 1rem` meant to clear the phone home indicator
// lifted every dropdown's option list a rem out of the top of its own popover, slicing the first
// option in half. That shipped, and nothing caught it — a component unit test renders without the
// app stylesheet and has no layout engine, and the backend cannot see rendered geometry at all.
//
// So this spec is about the app's OWN stylesheet, not about Nuxt UI: it pins that no global rule
// reaches into a shared slot the component library also uses. The subject is a service frame's
// connections picker (the `USelect` the report came in about), which is representative because
// the offset was never per-component.
test.describe('inspector popover menus', () => {
  test('a dropdown draws its options inside its own popover', async ({
    page,
    request,
    seededBoard,
  }) => {
    // The picker offers every OTHER service frame, and the sample board seeds exactly one, so
    // without this the row could not be added at all (the "+" is disabled with no candidate).
    await addFrame(request, seededBoard.workspaceId, 'Billing Service')

    // The frame's TITLE, never the card root: a frame's centre is its task canvas, so a root
    // click lands on whichever child card happens to sit there (here, `task_login`).
    await taskCard(page, 'blk_auth').getByText('Auth Service', { exact: true }).click()
    const inspector = page.getByTestId('inspector-panel')
    await expect(inspector).toBeVisible({ timeout: LIVE_TIMEOUT })

    // One click both expands the collapsed section and lands a connection row (InspectorSection
    // expands on any header action, so a new row is never dropped into a hidden body).
    const add = inspector.getByTestId('service-connection-add')
    await expect(add).toBeEnabled({ timeout: LIVE_TIMEOUT })
    await add.click()

    const picker = inspector.getByTestId('service-connection-target')
    await expect(picker).toBeVisible({ timeout: LIVE_TIMEOUT })
    await picker.click()

    // The options are portalled to `body`, so reach them from the item side and ask which
    // popover they belong to, rather than guessing at a selector for the popover itself.
    const clipped = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-slot="item"]')]
      const popover = items[0]?.closest('[data-slot="content"]')
      if (!popover) return ['no popover rendered']
      const box = popover.getBoundingClientRect()
      // Only the TOP edge: a long list legitimately scrolls its tail past the bottom one.
      return items
        .filter((item) => item.getBoundingClientRect().top < box.top - 0.5)
        .map((item) => item.textContent?.trim() ?? '')
    })
    // Named rather than counted, so a failure says WHICH option was sliced off.
    expect(clipped).toEqual([])
  })
})
