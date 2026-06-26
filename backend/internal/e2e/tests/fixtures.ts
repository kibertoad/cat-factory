import { test as base, expect } from '@playwright/test'
import { type WorkspaceSnapshot, createSeededWorkspace, openBoard, pinWorkspace } from './helpers'

// Shared Playwright fixtures for the suite. Two things every spec wants:
//
//   - `pageErrors`  — an AUTO fixture (runs for every test, used or not) that fails the
//     test if the SPA threw any uncaught exception. A live-pushed event that breaks a
//     component would otherwise pass silently as long as the asserted status text still
//     settled, so this guard is non-negotiable — promoting it to an auto fixture means a
//     new spec can't forget it.
//   - `seededBoard` — seed a fresh workspace (sample architecture), pin it client-side,
//     and open the board, returning the ids a spec needs to drive REST + assert on the UI.
//     Replaces the copy-pasted seed→pin→open preamble in every spec.
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
})

export { expect }
