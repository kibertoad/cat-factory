import { type BrowserContext, type Page, test as base, expect } from '@playwright/test'
import { type WorkspaceSnapshot, createSeededWorkspace, openBoard, pinWorkspace } from './helpers'

// Shared Playwright fixtures for the suite. Three things a spec wants:
//
//   - `pageErrors`  — an AUTO fixture (runs for every test, used or not) that fails the
//     test if the SPA threw any uncaught exception. A live-pushed event that breaks a
//     component would otherwise pass silently as long as the asserted status text still
//     settled, so this guard is non-negotiable — promoting it to an auto fixture means a
//     new spec can't forget it.
//   - `seededBoard` — seed a fresh workspace (sample architecture), pin it client-side,
//     and open the board, returning the ids a spec needs to drive REST + assert on the UI.
//     Replaces the copy-pasted seed→pin→open preamble in every spec.
//   - `newSession` — a SECOND (third, fourth) signed-in browser session, for the specs whose
//     subject is what a DIFFERENT person's browser renders about the same state.
//
// Specs import `test`/`expect` from THIS module instead of `@playwright/test`.

export interface SeededBoard {
  workspaceId: string
  snapshot: WorkspaceSnapshot
}

interface Fixtures {
  /** Uncaught SPA exceptions captured during the test; asserted empty on teardown. */
  pageErrors: string[]
  /** A fresh seeded + pinned + opened board. */
  seededBoard: SeededBoard
  /**
   * Open an INDEPENDENT browser session (its own context: own cookies, own storage, own
   * WebSocket), ready to be pinned as whichever principal the spec wants.
   *
   * It exists so those sessions cannot escape the two guarantees the `page` fixture gives:
   *
   *   - its uncaught exceptions join {@link pageErrors}. A hand-rolled `browser.newContext()`
   *     is outside that auto fixture, so a component that threw while rendering the very rail
   *     the spec is about would leave the assertions to settle from the store and pass.
   *   - the context is CLOSED on teardown, on the failure path too. `browser` is worker-scoped
   *     and Playwright only auto-closes what the `context` fixture made, so an assertion failing
   *     before an explicit `close()` leaks a live subscriber into every later test in the worker,
   *     turning one real failure into a cascade.
   *
   * A spec that wants a session gone earlier may still close it itself; teardown is idempotent.
   */
  newSession: () => Promise<Page>
}

export const test = base.extend<Fixtures>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (err) => errors.push(err.message))
      await use(errors)
      expect(errors, `uncaught page errors:\n${errors.join('\n')}`).toEqual([])
    },
    { auto: true },
  ],

  seededBoard: async ({ page, request }, use) => {
    const snapshot = await createSeededWorkspace(request)
    // Pin BEFORE navigating (pinWorkspace registers an init script), then open.
    await pinWorkspace(page, snapshot.workspace.id)
    await openBoard(page)
    await use({ workspaceId: snapshot.workspace.id, snapshot })
  },

  // Depends on `pageErrors` so the secondary sessions report into the SAME array the auto fixture
  // asserts empty, and so that assertion runs after these contexts are closed (Playwright tears
  // fixtures down in reverse dependency order).
  newSession: async ({ browser, pageErrors }, use) => {
    const contexts: BrowserContext[] = []
    await use(async () => {
      const context = await browser.newContext()
      contexts.push(context)
      const page = await context.newPage()
      page.on('pageerror', (err) => pageErrors.push(err.message))
      return page
    })
    for (const context of contexts) await context.close()
  },
})

export { expect }
