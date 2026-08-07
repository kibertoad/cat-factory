import type { NotificationWebhookRecord, NotificationWebhookRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the outbound notification-webhook store — the endpoints a HEADLESS
// integration registers so a parked run reaches it by push instead of polling. Each facade
// persists them in its own store (D1 on Cloudflare, Postgres on Node), both keyed by
// (workspace, endpoint id), and both encode the `types` / `run_events` / `alert_events` filters as
// JSON columns and `enabled` as an integer. This suite drives the SAME put → get → list →
// overwrite → delete assertions through whichever real repository a runtime hands it, so a column
// mapped differently (an unparsed filter, a boolean stored as text) fails a test instead of
// shipping a webhook that silently delivers the wrong set — or nothing.
//
// The composite key gets its own cases because it is the one thing the two stores express
// DIFFERENTLY: a rebuilt SQLite table with a two-column PRIMARY KEY on one side, a dropped and
// re-added Postgres constraint on the other. A `put` that still keyed on the workspace alone would
// pass every single-endpoint assertion above while silently overwriting a sibling integration's
// registration, which is precisely the bug this whole shape exists to prevent.
//
// See docs/initiatives/headless-clarification-loop.md (D3) and
// docs/initiatives/cloudflare-os-gatekeeper.md (slice 2).

/** A complete record, so each case states only the fields it is about. */
function record(overrides: Partial<NotificationWebhookRecord> = {}): NotificationWebhookRecord {
  return {
    workspaceId: 'ws',
    id: 'default',
    name: 'Default',
    url: 'https://example.test/hook',
    types: [],
    runEvents: [],
    alertEvents: [],
    enabled: true,
    secretSealed: null,
    updatedAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link NotificationWebhookRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; workspace ids are unique per run so a
 * shared database stays isolated between cases.
 */
export function defineNotificationWebhookSuite(
  name: string,
  makeRepo: () => NotificationWebhookRepository,
): void {
  describe(`[${name}] notification webhook repository parity`, () => {
    let seq = 0
    const nextWorkspace = () => {
      seq += 1
      return `ws-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    it('round-trips an endpoint with both filters, the enabled flag and a sealed secret', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      await repo.put(
        record({
          workspaceId: ws,
          id: 'gatekeeper',
          name: 'Cloudflare OS gatekeeper',
          url: 'https://example.test/hooks/cat-factory',
          types: ['requirement_review', 'fork_decision_pending'],
          runEvents: ['run.completed', 'run.failed'],
          alertEvents: ['platform_health.firing', 'platform_health.resolved'],
          secretSealed: 'sealed-blob',
          updatedAt: 42,
        }),
      )

      const stored = await repo.get(ws, 'gatekeeper')
      expect(stored).toEqual({
        workspaceId: ws,
        id: 'gatekeeper',
        name: 'Cloudflare OS gatekeeper',
        url: 'https://example.test/hooks/cat-factory',
        types: ['requirement_review', 'fork_decision_pending'],
        runEvents: ['run.completed', 'run.failed'],
        alertEvents: ['platform_health.firing', 'platform_health.resolved'],
        enabled: true,
        secretSealed: 'sealed-blob',
        updatedAt: 42,
      })
    })

    it('stores an empty filter and a disabled, secret-less endpoint faithfully', async () => {
      // An EMPTY filter is meaningful, and means OPPOSITE things per column: the channel reads an
      // empty `types` as "the default types", while both event families read theirs as "none". So
      // each must survive the round-trip as an empty array rather than collapsing to
      // null/undefined — on one of the three that would start a firehose, and on the other two it
      // would page somebody. A disabled endpoint with no signing secret is the other end of the
      // shape space.
      const repo = makeRepo()
      const ws = nextWorkspace()
      await repo.put(
        record({
          workspaceId: ws,
          url: 'https://example.test/quiet',
          enabled: false,
          updatedAt: 7,
        }),
      )

      const stored = await repo.get(ws, 'default')
      expect(stored?.types).toEqual([])
      expect(stored?.runEvents).toEqual([])
      expect(stored?.alertEvents).toEqual([])
      expect(stored?.enabled).toBe(false)
      expect(stored?.secretSealed).toBeNull()
    })

    it('replaces the row on a second put to the SAME id', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      await repo.put(
        record({
          workspaceId: ws,
          id: 'ci',
          url: 'https://old.test/hook',
          types: ['ci_failed'],
          runEvents: ['run.started'],
          alertEvents: ['platform_health.firing'],
          secretSealed: 'old',
          updatedAt: 1,
        }),
      )
      await repo.put(
        record({
          workspaceId: ws,
          id: 'ci',
          name: 'Renamed',
          url: 'https://new.test/hook',
          types: ['merge_review'],
          enabled: false,
          secretSealed: 'new',
          updatedAt: 2,
        }),
      )

      const stored = await repo.get(ws, 'ci')
      expect(stored?.name).toBe('Renamed')
      expect(stored?.url).toBe('https://new.test/hook')
      expect(stored?.types).toEqual(['merge_review'])
      // Both event subscriptions are REPLACED, not merged: dropping every event must actually
      // silence the endpoint rather than leaving the prior `run.started` (or a live alert
      // subscription somebody has just turned off) behind.
      expect(stored?.runEvents).toEqual([])
      expect(stored?.alertEvents).toEqual([])
      expect(stored?.enabled).toBe(false)
      expect(stored?.secretSealed).toBe('new')
      expect(stored?.updatedAt).toBe(2)
      // And it stayed ONE row: an upsert keyed wrongly would leave the old one beside the new.
      expect(await repo.list(ws)).toHaveLength(1)
    })

    it('keeps endpoints under different ids apart, and lists them ordered by id', async () => {
      // The composite key, asserted where it can actually fail. `put` targeting the workspace
      // alone would collapse these three into one and pass every case above.
      const repo = makeRepo()
      const ws = nextWorkspace()
      await repo.put(record({ workspaceId: ws, id: 'gatekeeper', url: 'https://gate.test/hook' }))
      await repo.put(record({ workspaceId: ws, id: 'ci', url: 'https://ci.test/hook' }))
      await repo.put(record({ workspaceId: ws, id: 'default', url: 'https://default.test/hook' }))

      const listed = await repo.list(ws)
      // Ordered by id on both stores, so two reads of an unchanged workspace agree and a client
      // rendering the list does not see it shuffle.
      expect(listed.map((entry) => entry.id)).toEqual(['ci', 'default', 'gatekeeper'])
      expect(listed.map((entry) => entry.url)).toEqual([
        'https://ci.test/hook',
        'https://default.test/hook',
        'https://gate.test/hook',
      ])
    })

    it('scopes list and delete to one workspace and one id', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      const other = nextWorkspace()
      await repo.put(record({ workspaceId: ws, id: 'ci' }))
      await repo.put(record({ workspaceId: ws, id: 'gatekeeper' }))
      await repo.put(record({ workspaceId: other, id: 'ci' }))

      expect(await repo.list(other)).toHaveLength(1)

      // Deleting one endpoint must not take a sibling integration's registration with it, nor
      // reach into a second workspace that happened to choose the same id.
      await repo.delete(ws, 'ci')
      expect(await repo.get(ws, 'ci')).toBeNull()
      expect(await repo.get(ws, 'gatekeeper')).not.toBeNull()
      expect(await repo.get(other, 'ci')).not.toBeNull()
    })

    it('returns null for an unregistered id and deletes idempotently', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      expect(await repo.get(ws, 'default')).toBeNull()
      expect(await repo.list(ws)).toEqual([])

      // Deleting an absent row is a no-op, not an error — the management route is idempotent.
      await repo.delete(ws, 'default')

      await repo.put(record({ workspaceId: ws }))
      expect(await repo.get(ws, 'default')).not.toBeNull()
      await repo.delete(ws, 'default')
      expect(await repo.get(ws, 'default')).toBeNull()
    })
  })
}
