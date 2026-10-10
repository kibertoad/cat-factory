import type { McpOAuthGrantRecord, McpOAuthGrantRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-workspace MCP OAuth grant store. The service that opens the
// sealed blob and refreshes a token is runtime-neutral; the ROW behaviour it depends on is not, and
// the two dependencies that would fail silently are exactly what this suite pins:
//
//   - the composite (workspace, server) key, which decides whether two servers' grants are two rows
//     or one that overwrites itself. A store that keyed on the workspace alone would pass every
//     single-server test and lose a board's second connection.
//   - the REV guard on the refresh path. Two dispatches can find one access token expired at the
//     same instant, and only one of their token sets survives at the vendor when refresh tokens
//     rotate. If a facade's `compareAndSwap` were a blind upsert, both would "succeed" and the
//     board would be left holding a refresh token the server has already invalidated — a failure
//     that appears days later, on the run after the access token expires.
//
// A sequential test cannot see the second one on SQLite (which serialises writers), so the guard is
// asserted through its RESULT (`false` on a stale base) rather than by racing.

export function defineMcpOAuthGrantSuite(name: string, make: () => McpOAuthGrantRepository): void {
  describe(`[${name}] mcp oauth grant store parity`, () => {
    let seq = 0
    const uniq = () => {
      seq += 1
      return `ws-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    const record = (
      workspaceId: string,
      serverId: string,
      overrides: Partial<McpOAuthGrantRecord> = {},
    ): McpOAuthGrantRecord => ({
      workspaceId,
      serverId,
      tokens: `sealed:${serverId}`,
      summary: JSON.stringify({ connectedBy: 'usr_1' }),
      rev: 0,
      createdAt: 1_000,
      updatedAt: 1_000,
      ...overrides,
    })

    it('stores one row per (workspace, server) and reads each back', async () => {
      const repo = make()
      const ws = uniq()
      await repo.upsert(record(ws, 'issues'))
      await repo.upsert(record(ws, 'docs', { tokens: 'sealed:docs' }))

      expect(await repo.get(ws, 'issues')).toMatchObject({
        serverId: 'issues',
        tokens: 'sealed:issues',
      })
      expect(await repo.get(ws, 'docs')).toMatchObject({ serverId: 'docs', tokens: 'sealed:docs' })
      expect(await repo.get(ws, 'absent')).toBeNull()
    })

    it('lists a workspace’s grants and nobody else’s', async () => {
      const repo = make()
      const mine = uniq()
      const theirs = uniq()
      await repo.upsert(record(mine, 'issues'))
      await repo.upsert(record(mine, 'docs'))
      await repo.upsert(record(theirs, 'issues'))

      const listed = await repo.listByWorkspace(mine)
      expect(listed.map((row) => row.serverId).sort()).toEqual(['docs', 'issues'])
      expect(listed.every((row) => row.workspaceId === mine)).toBe(true)
    })

    it('bumps the stored rev on a blind upsert, so a stale compareAndSwap loses', async () => {
      const repo = make()
      const ws = uniq()
      await repo.upsert(record(ws, 'issues'))
      const first = await repo.get(ws, 'issues')
      expect(first?.rev).toBe(0)

      // A human completing a grant: last writer wins, and the rev moves so a refresh that read
      // the row before this write cannot land on top of it.
      await repo.upsert(record(ws, 'issues', { tokens: 'sealed:regranted', updatedAt: 2_000 }))
      const second = await repo.get(ws, 'issues')
      expect(second).toMatchObject({ tokens: 'sealed:regranted', rev: 1, updatedAt: 2_000 })

      const stale = await repo.compareAndSwap(
        record(ws, 'issues', { tokens: 'sealed:stale', rev: 1 }),
        0,
      )
      expect(stale).toBe(false)
      expect(await repo.get(ws, 'issues')).toMatchObject({ tokens: 'sealed:regranted' })
    })

    it('swaps on the expected rev and refuses on any other', async () => {
      const repo = make()
      const ws = uniq()
      await repo.upsert(record(ws, 'issues'))

      const won = await repo.compareAndSwap(
        record(ws, 'issues', { tokens: 'sealed:refreshed', rev: 1, updatedAt: 3_000 }),
        0,
      )
      expect(won).toBe(true)
      expect(await repo.get(ws, 'issues')).toMatchObject({ tokens: 'sealed:refreshed', rev: 1 })

      // The loser of a refresh race: its base is the rev the winner replaced.
      const lost = await repo.compareAndSwap(
        record(ws, 'issues', { tokens: 'sealed:loser', rev: 1 }),
        0,
      )
      expect(lost).toBe(false)
      expect(await repo.get(ws, 'issues')).toMatchObject({ tokens: 'sealed:refreshed' })
    })

    it('inserts with expectedRev null only when no row exists', async () => {
      const repo = make()
      const ws = uniq()
      expect(await repo.compareAndSwap(record(ws, 'issues'), null)).toBe(true)
      // A second "expect no row" write is the client-credentials mint racing itself; the row is
      // already there, so it must lose rather than overwrite a token another dispatch just minted.
      expect(
        await repo.compareAndSwap(record(ws, 'issues', { tokens: 'sealed:racer' }), null),
      ).toBe(false)
      expect(await repo.get(ws, 'issues')).toMatchObject({ tokens: 'sealed:issues' })
    })

    it('deletes one server’s grant and leaves the workspace’s others alone', async () => {
      const repo = make()
      const ws = uniq()
      await repo.upsert(record(ws, 'issues'))
      await repo.upsert(record(ws, 'docs'))

      await repo.delete(ws, 'issues')
      expect(await repo.get(ws, 'issues')).toBeNull()
      expect(await repo.get(ws, 'docs')).not.toBeNull()
      // A disconnect of something already disconnected is a no-op, not a failure: the panel's
      // button and a concurrent redeploy can both reach this.
      await repo.delete(ws, 'issues')
    })
  })
}
