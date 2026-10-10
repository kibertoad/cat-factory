import type { AuditEventRecord, AuditEventRepository } from '@cat-factory/kernel'
import { isRetiredAuditValue } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the append-only account audit log. The vocabulary and the write seam
// are runtime-neutral, but each facade persists the log in its own store (D1 on Cloudflare,
// Postgres via Drizzle on Node), and the things most likely to drift are the ones a
// single-runtime test would never catch: the discriminated ACTOR mapped across three columns, the
// `details` fields round-tripping through one TEXT column, how a retired vocabulary member reads
// back, and keyset pagination over an (at, id) tuple whose tie-break decides whether an event is
// served twice or skipped. All are driven here through whichever real repository a runtime hands
// over.

function event(overrides: Partial<AuditEventRecord> & Pick<AuditEventRecord, 'id'>) {
  return {
    accountId: 'acc-1',
    workspaceId: null,
    actor: { kind: 'user' as const, userId: 'usr-1' },
    action: 'account.member_added' as const,
    targetType: 'user' as const,
    targetId: 'usr-2',
    details: { roles: 'developer' },
    at: 1_000,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link AuditEventRepository} behaves identically to the others. `makeRepo`
 * returns a repo over the runtime's real store; account ids are unique per case so the shared
 * database stays isolated between them.
 */
export function defineAuditEventSuite(name: string, makeRepo: () => AuditEventRepository): void {
  describe(`[${name}] audit-event repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { acc: `acc-${tag}`, ws: `ws-${tag}` }
    }

    it('round-trips every field, including a null workspace', async () => {
      const repo = makeRepo()
      const { acc } = ids()
      await repo.append(event({ id: `aud-${acc}-1`, accountId: acc }))

      const page = await repo.listByAccount(acc)
      expect(page.nextCursor).toBeNull()
      expect(page.events).toHaveLength(1)
      expect(page.events[0]).toEqual({
        id: `aud-${acc}-1`,
        accountId: acc,
        workspaceId: null,
        actor: { kind: 'user', userId: 'usr-1' },
        action: 'account.member_added',
        targetType: 'user',
        targetId: 'usr-2',
        details: { roles: 'developer' },
        at: 1_000,
      })
    })

    it('round-trips every detail VALUE shape through the one text column', async () => {
      // `details` is a JSON blob in a TEXT column on both stores, so the types a writer states
      // have to survive the trip: a cleared budget must not come back as the string "null", and a
      // number must not come back as a string the viewer then renders with quotes.
      const repo = makeRepo()
      const { acc } = ids()
      await repo.append(
        event({
          id: `aud-${acc}-1`,
          accountId: acc,
          action: 'account.budget_changed',
          targetType: 'account',
          details: { limit: null },
        }),
      )
      await repo.append(
        event({
          id: `aud-${acc}-2`,
          accountId: acc,
          at: 2_000,
          action: 'account.budget_changed',
          targetType: 'account',
          details: { limit: 250, note: 'raised', urgent: true },
        }),
      )

      const page = await repo.listByAccount(acc)
      expect(page.events.map((e) => e.details)).toEqual([
        { limit: 250, note: 'raised', urgent: true },
        { limit: null },
      ])
    })

    it('maps each actor kind back to the principal it was written as', async () => {
      // The three actor kinds share two nullable columns, so a mapping that reached for the wrong
      // one would still round-trip a `user` event and silently turn an `apiKey` into a `system`.
      const repo = makeRepo()
      const { acc, ws } = ids()
      await repo.append(
        event({
          id: `aud-${acc}-user`,
          accountId: acc,
          workspaceId: ws,
          at: 3_000,
          actor: { kind: 'user', userId: 'usr-actor' },
        }),
      )
      await repo.append(
        event({
          id: `aud-${acc}-key`,
          accountId: acc,
          at: 2_000,
          actor: { kind: 'apiKey', apiKeyId: 'pak-1' },
        }),
      )
      await repo.append(
        event({ id: `aud-${acc}-sys`, accountId: acc, at: 1_000, actor: { kind: 'system' } }),
      )

      const page = await repo.listByAccount(acc)
      expect(page.events.map((e) => e.actor)).toEqual([
        { kind: 'user', userId: 'usr-actor' },
        { kind: 'apiKey', apiKeyId: 'pak-1' },
        { kind: 'system' },
      ])
      // The board-scoped event keeps its workspace; the account-scoped ones stay null.
      expect(page.events.map((e) => e.workspaceId)).toEqual([ws, null, null])
    })

    it('reads a RETIRED action / target type back named, never dropped or guessed', async () => {
      // `action` and `targetType` are closed vocabularies that are also persisted, so a member
      // retired from the type goes on existing in rows written before it was. The cast is the
      // point: no current build can write these, and every future one has to read them. A dropped
      // row is the one failure an audit log must not have.
      const repo = makeRepo()
      const { acc } = ids()
      await repo.append(
        event({
          id: `aud-${acc}-1`,
          accountId: acc,
          action: 'account.seat_reassigned' as AuditEventRecord['action'],
          targetType: 'apiKey' as AuditEventRecord['targetType'],
        }),
      )

      const page = await repo.listByAccount(acc)
      expect(page.events).toHaveLength(1)
      expect(page.events[0]?.action).toEqual({ retired: 'account.seat_reassigned' })
      expect(page.events[0]?.targetType).toEqual({ retired: 'apiKey' })
      // …and the guard both facades and the viewer narrow with agrees.
      const action = page.events[0]!.action
      expect(isRetiredAuditValue(action) ? action.retired : 'not-retired').toBe(
        'account.seat_reassigned',
      )
      // Everything else on the row still reads normally: the retirement costs the label, not the
      // record of who did it.
      expect(page.events[0]?.actor).toEqual({ kind: 'user', userId: 'usr-1' })
    })

    it('scopes reads to one account', async () => {
      const repo = makeRepo()
      const { acc } = ids()
      const other = `${acc}-other`
      await repo.append(event({ id: `aud-${acc}-mine`, accountId: acc }))
      await repo.append(event({ id: `aud-${acc}-theirs`, accountId: other }))

      expect((await repo.listByAccount(acc)).events.map((e) => e.id)).toEqual([`aud-${acc}-mine`])
      expect((await repo.listByAccount(other)).events.map((e) => e.id)).toEqual([
        `aud-${acc}-theirs`,
      ])
    })

    it('pages newest-first and hands back a cursor that continues exactly where it stopped', async () => {
      const repo = makeRepo()
      const { acc } = ids()
      for (const at of [1_000, 2_000, 3_000, 4_000, 5_000]) {
        await repo.append(event({ id: `aud-${acc}-${at}`, accountId: acc, at }))
      }

      const first = await repo.listByAccount(acc, { limit: 2 })
      expect(first.events.map((e) => e.at)).toEqual([5_000, 4_000])
      expect(first.nextCursor).not.toBeNull()

      const second = await repo.listByAccount(acc, { limit: 2, cursor: first.nextCursor })
      expect(second.events.map((e) => e.at)).toEqual([3_000, 2_000])

      const third = await repo.listByAccount(acc, { limit: 2, cursor: second.nextCursor })
      expect(third.events.map((e) => e.at)).toEqual([1_000])
      // The last page must say it is the last one: a non-null cursor here would make a client
      // poll forever.
      expect(third.nextCursor).toBeNull()
    })

    it('does not serve an event twice or skip one when timestamps collide across a page boundary', async () => {
      // The regression this exists for: paginating on `at` alone. Three events share a
      // millisecond, so a cursor that carries only the timestamp either re-serves the whole
      // group or steps past the two it did not return.
      const repo = makeRepo()
      const { acc } = ids()
      for (const suffix of ['a', 'b', 'c']) {
        await repo.append(event({ id: `aud-${acc}-${suffix}`, accountId: acc, at: 7_000 }))
      }

      const seen: string[] = []
      let cursor: string | null | undefined
      for (let guard = 0; guard < 5; guard += 1) {
        const page = await repo.listByAccount(acc, { limit: 2, cursor })
        seen.push(...page.events.map((e) => e.id))
        cursor = page.nextCursor
        if (!cursor) break
      }

      expect(seen).toHaveLength(3)
      expect(new Set(seen).size).toBe(3)
    })

    it('clamps a page limit and defaults an absent one', async () => {
      const repo = makeRepo()
      const { acc } = ids()
      for (const at of [1_000, 2_000, 3_000]) {
        await repo.append(event({ id: `aud-${acc}-${at}`, accountId: acc, at }))
      }

      // Above the ceiling: served, not refused, and bounded by what exists.
      expect((await repo.listByAccount(acc, { limit: 10_000 })).events).toHaveLength(3)
      // Absent limit ⇒ the default page size, which is larger than this fixture.
      expect((await repo.listByAccount(acc)).events).toHaveLength(3)
    })

    // The retention sweep is the ONE delete on an append-only table, and the pair below pins what
    // it must NOT do as much as what it does.
    //
    // Note what these assert and what they deliberately do not. The prune takes a cutoff and
    // nothing else — no account predicate — so its RETURNED COUNT spans rows every other case in
    // this file seeded, which no case owns. Asserting an exact number there would be asserting a
    // fact about a population the test did not make, and it would break on any addition to this
    // suite. So the counts are asserted as RELATIONS and the exact outcomes are asserted per
    // account, over rows these cases created themselves. The timestamps are large and per-case so
    // the two cutoffs cannot reach each other's fixtures.
    it('prunes strictly by age and across every account, reporting what it reclaimed', async () => {
      const repo = makeRepo()
      const { acc } = ids()
      const other = `${acc}-other`
      await repo.append(event({ id: `aud-${acc}-old`, accountId: acc, at: 1_000_000 }))
      await repo.append(event({ id: `aud-${acc}-old2`, accountId: other, at: 1_500_000 }))
      await repo.append(event({ id: `aud-${acc}-new`, accountId: acc, at: 9_000_000 }))

      const removed = await repo.deleteOlderThan(2_000_000)

      // A count, not a boolean: the sweeper reports what it reclaimed, so "pruned nothing" and
      // "pruned the table" must be distinguishable. At least the two seeded here went.
      expect(removed).toBeGreaterThanOrEqual(2)
      // Both accounts pruned by the one cutoff — the property that says there is no account
      // predicate hiding in the implementation.
      expect((await repo.listByAccount(acc)).events.map((e) => e.id)).toEqual([`aud-${acc}-new`])
      expect((await repo.listByAccount(other)).events).toEqual([])
    })

    it('keeps a row exactly ON the cutoff (the boundary is strict)', async () => {
      // `at < cutoff`, not `<=`. Retention is expressed as "keep the last N days", and an
      // off-by-one here silently shortens every deployment's window by a tick.
      const repo = makeRepo()
      const { acc } = ids()
      await repo.append(event({ id: `aud-${acc}-on`, accountId: acc, at: 5_000_000 }))
      await repo.append(event({ id: `aud-${acc}-under`, accountId: acc, at: 4_999_999 }))

      await repo.deleteOlderThan(5_000_000)

      // The row one tick under the cutoff went; the one exactly on it stayed.
      expect((await repo.listByAccount(acc)).events.map((e) => e.id)).toEqual([`aud-${acc}-on`])
    })

    it('reads an unknown account and an unreadable cursor as the start of an empty log', async () => {
      const repo = makeRepo()
      const { acc } = ids()
      expect(await repo.listByAccount(acc)).toEqual({ events: [], nextCursor: null })

      await repo.append(event({ id: `aud-${acc}-1`, accountId: acc }))
      // A truncated cursor costs a page position, never a throw: cursors round-trip through a URL.
      expect((await repo.listByAccount(acc, { cursor: 'nonsense' })).events).toHaveLength(1)
    })
  })
}
