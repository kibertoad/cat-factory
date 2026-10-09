import type { DirectoryChangeRecord, DirectoryRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { DirectoryService } from './DirectoryService.js'

// The cursor arithmetic a sync client depends on and the conformance suite cannot reach without a
// prune: where a cursor expires, where a page leaves it, and what a snapshot walk carries.

function change(seq: number): DirectoryChangeRecord {
  return {
    accountId: 'acc',
    seq,
    entityType: 'workspace',
    workspaceId: 'ws',
    entityId: 'ws',
    at: 1,
  }
}

function service(feed: { head: number; oldest: number | null; rows?: DirectoryChangeRecord[] }) {
  const calls: { listChanges: unknown[][]; listWorkspaces: unknown[][] } = {
    listChanges: [],
    listWorkspaces: [],
  }
  const repo = {
    headSeq: async () => feed.head,
    oldestSeq: async () => feed.oldest,
    listChanges: async (...args: unknown[]) => {
      calls.listChanges.push(args)
      return feed.rows ?? []
    },
    listWorkspaces: async (...args: unknown[]) => {
      calls.listWorkspaces.push(args)
      return [{ id: 'ws_a', name: 'A', description: null, accessMode: 'account' as const }]
    },
    getWorkspaces: async () => [],
    getUsers: async () => [],
    getAccountMemberships: async () => [],
    getWorkspaceMemberships: async () => [],
    getRepos: async () => [],
  } as unknown as DirectoryRepository
  return { directory: new DirectoryService({ directoryRepository: repo }), calls }
}

const reader = { accountId: 'acc', workspaceIds: null }

describe('DirectoryService.changes', () => {
  it('accepts a cursor right before the oldest retained change, and expires one further back', async () => {
    const { directory } = service({ head: 20, oldest: 11 })
    await expect(directory.changes(reader, 10)).resolves.toBeDefined()
    await expect(directory.changes(reader, 9)).rejects.toMatchObject({
      details: { reason: 'cursor_expired' },
    })
  })

  it('expires a cursor ahead of the feed, which is a cursor from somewhere else', async () => {
    const { directory } = service({ head: 5, oldest: 1 })
    await expect(directory.changes(reader, 6)).rejects.toMatchObject({
      details: { reason: 'cursor_expired' },
    })
  })

  it('reads up to the head it saw first, and advances a short page to that head', async () => {
    const { directory, calls } = service({ head: 9, oldest: 1, rows: [change(4)] })
    const page = await directory.changes(reader, 3, 10)
    expect(calls.listChanges[0]).toEqual(['acc', 3, 9, 10, null])
    expect(page).toMatchObject({ nextAfter: 9, headSeq: 9 })
    // The entity is gone, so the change is served as a deletion rather than dropped.
    expect(page.changes).toEqual([
      { seq: 4, at: 1, workspaceId: 'ws', entityId: 'ws', entityType: 'workspace', entity: null },
    ])
  })

  it('leaves a full page at its last change, since more may follow it', async () => {
    const { directory } = service({ head: 9, oldest: 1, rows: [change(4), change(5)] })
    expect((await directory.changes(reader, 3, 2)).nextAfter).toBe(5)
  })
})

describe('DirectoryService snapshots', () => {
  it('carries the first page’s watermark through the cursor', async () => {
    const first = service({ head: 7, oldest: 1 })
    const page = await first.directory.workspaces(reader, undefined, 1)
    expect(page.asOfSeq).toBe(7)

    // The feed moved on, but a walk already under way keeps reporting where it started.
    const later = service({ head: 12, oldest: 1 })
    const next = await later.directory.workspaces(reader, page.nextCursor!, 1)
    expect(next.asOfSeq).toBe(7)
    expect(later.calls.listWorkspaces[0]).toEqual(['acc', 'ws_a', 1, null])
  })

  it('refuses users and account memberships to a key limited to some workspaces', async () => {
    const { directory } = service({ head: 1, oldest: 1 })
    const restricted = { accountId: 'acc', workspaceIds: ['ws'] }
    expect(() => directory.users(restricted, undefined)).toThrow(/account-wide/)
    expect(() => directory.accountMemberships(restricted, undefined)).toThrow(/account-wide/)
  })
})
