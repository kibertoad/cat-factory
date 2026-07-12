import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from './harness.js'

// Caching-initiative conformance (docs/initiatives/caching-layer.md): app-cache-backed
// reads (the merged prompt-fragment catalog; the per-workspace settings row) are served
// through the app cache bag on every facade — bare in-memory loaders on Node/local (and in
// these harnesses), the pass-through isolate-safe profile on the Worker — so this suite
// asserts the property BOTH configurations must uphold: write-then-read coherence. A write
// is visible on the immediately following read because the owning service invalidates at
// every write site; a facade whose cache wiring misses one (or whose profile wrongly TTLs
// mutable state without an invalidation path) fails here instead of serving stale data to
// agent runs.

export function defineCacheSuite(harness: ConformanceHarness): void {
  describe(`[${harness.name}] cached fragment catalog coherence`, () => {
    it('a fragment write is visible on the immediately following resolved read', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/prompt-fragments`
      const resolved = `${base}/resolved`

      // Warm the cache with the pre-write catalog (built-ins only).
      const initial = await call<{ id: string }[]>('GET', resolved)
      expect(initial.status).toBe(200)
      expect(initial.body.map((f) => f.id)).not.toContain('cache-probe')

      // Create → the very next resolved read sees it (invalidation, not TTL expiry,
      // is the coherence mechanism — a stale cached catalog would still show the
      // warmed pre-write state here).
      const created = await call('POST', base, {
        id: 'cache-probe',
        title: 'Cache probe',
        summary: 'original summary',
        body: 'Probe body.',
      })
      expect(created.status).toBe(201)
      const afterCreate = await call<{ id: string; summary: string }[]>('GET', resolved)
      expect(afterCreate.body.find((f) => f.id === 'cache-probe')?.summary).toBe('original summary')

      // Edit → the next read reflects the patch.
      const patched = await call('PATCH', `${base}/cache-probe`, { summary: 'updated summary' })
      expect(patched.status).toBe(200)
      const afterUpdate = await call<{ id: string; summary: string }[]>('GET', resolved)
      expect(afterUpdate.body.find((f) => f.id === 'cache-probe')?.summary).toBe('updated summary')

      // Remove → the next read drops it.
      const removed = await call('DELETE', `${base}/cache-probe`)
      expect(removed.status).toBe(204)
      const afterDelete = await call<{ id: string }[]>('GET', resolved)
      expect(afterDelete.body.map((f) => f.id)).not.toContain('cache-probe')
    })

    it('one workspace cached catalog never bleeds into another', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const first = (await createWorkspace()).workspace
      const second = (await createWorkspace()).workspace

      // Warm BOTH workspaces' cache groups, then write only to the first.
      await call('GET', `/workspaces/${first.id}/prompt-fragments/resolved`)
      await call('GET', `/workspaces/${second.id}/prompt-fragments/resolved`)
      await call('POST', `/workspaces/${first.id}/prompt-fragments`, {
        id: 'ws-scoped',
        title: 'Scoped',
        summary: 's',
        body: 'b',
      })

      const inFirst = await call<{ id: string }[]>(
        'GET',
        `/workspaces/${first.id}/prompt-fragments/resolved`,
      )
      const inSecond = await call<{ id: string }[]>(
        'GET',
        `/workspaces/${second.id}/prompt-fragments/resolved`,
      )
      expect(inFirst.body.map((f) => f.id)).toContain('ws-scoped')
      expect(inSecond.body.map((f) => f.id)).not.toContain('ws-scoped')
    })

    // The `workspaceSettings` slice (perf-tracker items 7 & 9): a workspace's settings row
    // is read through the same app cache on several hot paths (the per-LLM-call body gate,
    // the task-limit guard, SpendService's pricing overlay). Its sole write path
    // (`WorkspaceSettingsService.update`) must invalidate the slice so a settings edit is
    // visible on the very next read — a facade wiring the cache but missing the invalidation
    // (or a profile TTLing mutable state without an invalidation path) would serve the warmed
    // pre-write value here.
    it('a workspace-settings write is visible on the immediately following read', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const settings = `/workspaces/${workspace.id}/settings`

      // Warm the cache with the pre-write settings.
      const initial = await call<{ waitingEscalationMinutes: number }>('GET', settings)
      expect(initial.status).toBe(200)
      const before = initial.body.waitingEscalationMinutes

      // Update → the next read reflects the new value (invalidation, not TTL expiry).
      const updated = await call('PUT', settings, { waitingEscalationMinutes: before + 17 })
      expect(updated.status).toBe(200)
      const after = await call<{ waitingEscalationMinutes: number }>('GET', settings)
      expect(after.body.waitingEscalationMinutes).toBe(before + 17)
    })
  })
}
