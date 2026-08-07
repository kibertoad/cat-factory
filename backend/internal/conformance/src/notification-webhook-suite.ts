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
 * A limit high enough that no case not ABOUT the cap can trip over it. `put` takes the cap as an
 * argument because it enforces it atomically, so every call site has to state one; the cases that
 * care state their own.
 */
const NO_PRACTICAL_LIMIT = 1000

/** `put` with the roomy default, so a case states a limit only when the limit is the subject. */
function store(
  repo: NotificationWebhookRepository,
  next: NotificationWebhookRecord,
  limit = NO_PRACTICAL_LIMIT,
) {
  return repo.put(next, limit)
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
      await store(
        repo,
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
      await store(
        repo,
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
      await store(
        repo,
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
      await store(
        repo,
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
      await store(
        repo,
        record({ workspaceId: ws, id: 'gatekeeper', url: 'https://gate.test/hook' }),
      )
      await store(repo, record({ workspaceId: ws, id: 'ci', url: 'https://ci.test/hook' }))
      await store(
        repo,
        record({ workspaceId: ws, id: 'default', url: 'https://default.test/hook' }),
      )

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

    it('orders the list in BYTE order, not the store default, across punctuated ids', async () => {
      // The case above cannot see this one: its ids are pure letters, and every collation agrees
      // about those. The port promises byte order, and the two stores disagree about what a bare
      // `ORDER BY id` means the moment an id carries the `-` or `_` its own schema admits. SQLite
      // has only BINARY; Postgres uses the database's locale collation, which sorts as if the
      // punctuation were absent and then breaks the tie some other way. So the ids here are chosen
      // to tell those apart: `-` is 0x2D and `_` is 0x5F, both below `h` (0x68), which puts
      // `webhook` LAST under byte order and not-last under any locale collation that ignores
      // punctuation. Both repositories name their collation explicitly to make this hold.
      const repo = makeRepo()
      const ws = nextWorkspace()
      for (const id of ['webhook', 'web_hook', 'web-hook']) {
        await store(repo, record({ workspaceId: ws, id, url: `https://${id}.test/hook` }))
      }

      const listed = await repo.list(ws)
      expect(listed.map((entry) => entry.id)).toEqual(['web-hook', 'web_hook', 'webhook'])
    })

    it('refuses a CREATE past the limit and still admits a REPLACE at it', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      expect(await store(repo, record({ workspaceId: ws, id: 'a' }), 2)).toBe('stored')
      expect(await store(repo, record({ workspaceId: ws, id: 'b' }), 2)).toBe('stored')

      // A third id has nowhere to go, and the refusal is a RETURN rather than a write nobody
      // asked about: which status a full workspace deserves belongs to the service above.
      expect(await store(repo, record({ workspaceId: ws, id: 'c' }), 2)).toBe('limit_reached')
      expect((await repo.list(ws)).map((entry) => entry.id)).toEqual(['a', 'b'])

      // Editing what is already there is admitted AT the limit, and below it too after a delete.
      // Without this, a full workspace could not disable or re-point the endpoints it has, which
      // are the only edits that get it back under the cap.
      expect(await store(repo, record({ workspaceId: ws, id: 'b', enabled: false }), 2)).toBe(
        'stored',
      )
      expect((await repo.get(ws, 'b'))?.enabled).toBe(false)

      // And a LOWERED cap still lets an operator edit their way out of being over it.
      expect(await store(repo, record({ workspaceId: ws, id: 'a', name: 'Kept' }), 1)).toBe(
        'stored',
      )
      expect((await repo.get(ws, 'a'))?.name).toBe('Kept')
    })

    it('holds the limit against CONCURRENT creates of distinct ids', async () => {
      // The case above passes against a count-then-write `put` on both stores, which is exactly
      // the trap: sequential calls never overlap, so the window is invisible. Here ten distinct
      // ids race for four slots. A read acted on a statement later admits more than four, because
      // neither engine locks a row that does not exist yet: Postgres takes no predicate lock at
      // READ COMMITTED, and SQLite serializes each STATEMENT rather than a read-then-write pair.
      const repo = makeRepo()
      const ws = nextWorkspace()
      const limit = 4
      const ids = Array.from({ length: 10 }, (_, index) => `racer-${index}`)

      const outcomes = await Promise.all(
        ids.map((id) => store(repo, record({ workspaceId: ws, id }), limit)),
      )

      // Assert the RELATION, not a fixed winner: which four ids win is a real race and naming one
      // would be pinning the scheduler. What must hold is that the store admitted exactly as many
      // as it reported, and never more than the cap.
      const admitted = outcomes.filter((outcome) => outcome === 'stored').length
      expect(admitted).toBe(limit)
      expect(await repo.list(ws)).toHaveLength(limit)
    })

    it('scopes list and delete to one workspace and one id', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      const other = nextWorkspace()
      await store(repo, record({ workspaceId: ws, id: 'ci' }))
      await store(repo, record({ workspaceId: ws, id: 'gatekeeper' }))
      await store(repo, record({ workspaceId: other, id: 'ci' }))

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

      await store(repo, record({ workspaceId: ws }))
      expect(await repo.get(ws, 'default')).not.toBeNull()
      await repo.delete(ws, 'default')
      expect(await repo.get(ws, 'default')).toBeNull()
    })
  })
}
