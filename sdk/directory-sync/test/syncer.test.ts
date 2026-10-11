import {
  CatFactoryConflictError,
  CatFactoryForbiddenError,
  type DirectoryChange,
  type DirectoryUser,
  type DirectoryWorkspace,
} from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import { DirectorySyncer } from '../src/syncer.ts'
import { MemoryDirectoryStore } from '../src/store.ts'
import type { DirectoryClient } from '../src/syncer.ts'

// The syncer against a fake directory: one account whose workspaces and users a test edits, and a
// feed it appends to. The properties pinned are the ones a consumer cannot see from the types:
// that a reconciliation replays from its EARLIEST watermark, deletes what the source dropped, falls
// back from an expired cursor, mirrors what a restricted key can reach, and that a push is
// verified before anything is written.

const SECRET = 'directory-webhook-secret-0123456789'
const NOW = 1_800_000_000_000

const workspace = (id: string, name = id): DirectoryWorkspace => ({
  id,
  name,
  description: null,
  accessMode: 'account',
})
const user = (id: string): DirectoryUser => ({ id, name: id, email: null, avatarUrl: null })

function fakeDirectory(options: { restricted?: boolean; reach?: string[] } = {}) {
  const state = {
    workspaces: new Map<string, DirectoryWorkspace>(),
    users: new Map<string, DirectoryUser>(),
    feed: [] as DirectoryChange[],
    oldest: 1,
  }
  const head = () => state.feed.at(-1)?.seq ?? 0
  const page = <T>(items: T[]) => ({ items, nextCursor: null, asOfSeq: head() })
  const forbidden = () =>
    new CatFactoryForbiddenError({
      status: 403,
      code: 'forbidden',
      message: 'account-wide',
      details: { reason: 'account_scope_required' },
      requestId: null,
      body: null,
    })
  const client = {
    me: {
      get: async () => ({ workspaceIds: options.restricted ? (options.reach ?? []) : null }),
    },
    directory: {
      listChanges: async ({ after = 0, limit = 100 }: { after?: number; limit?: number }) => {
        if (after < state.oldest - 1 || after > head()) {
          throw new CatFactoryConflictError({
            status: 409,
            code: 'conflict',
            message: 'expired',
            details: { reason: 'cursor_expired' },
            requestId: null,
            body: null,
          })
        }
        const changes = state.feed.filter((c) => c.seq > after).slice(0, limit)
        return {
          changes,
          nextAfter: changes.length === limit ? changes.at(-1)!.seq : head(),
          headSeq: head(),
        }
      },
      listWorkspaces: async () => page([...state.workspaces.values()]),
      listUsers: async () => {
        if (options.restricted) throw forbidden()
        return page([...state.users.values()])
      },
      listAccountMemberships: async () => {
        if (options.restricted) throw forbidden()
        return page([])
      },
      listWorkspaceMemberships: async () => page([]),
      listRepos: async () => page([]),
    },
  } as unknown as DirectoryClient

  /** Rename (or create) a workspace and record the change on the feed. */
  const putWorkspace = (id: string, name: string) => {
    state.workspaces.set(id, workspace(id, name))
    state.feed.push({
      seq: head() + 1,
      at: 1,
      workspaceId: id,
      entityId: id,
      entityType: 'workspace',
      entity: workspace(id, name),
    })
  }
  const deleteWorkspace = (id: string) => {
    state.workspaces.delete(id)
    state.feed.push({
      seq: head() + 1,
      at: 1,
      workspaceId: id,
      entityId: id,
      entityType: 'workspace',
      entity: null,
    })
  }
  return { state, client, putWorkspace, deleteWorkspace, head }
}

async function sign(body: string, timestamp = NOW): Promise<Headers> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)),
  )
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  return new Headers({
    'x-cat-factory-timestamp': String(timestamp),
    'x-cat-factory-signature': `v1=${hex}`,
  })
}

describe('DirectorySyncer', () => {
  it('bootstraps from the snapshots on first use, then follows the feed', async () => {
    const dir = fakeDirectory()
    dir.putWorkspace('ws_a', 'Alpha')
    dir.state.users.set('usr_1', user('usr_1'))
    const store = new MemoryDirectoryStore()
    const syncer = new DirectorySyncer({ client: dir.client, store })

    const first = await syncer.catchUp()
    expect(first.reconciled).toBe(true)
    expect([...store.entities('workspace').values()]).toEqual([workspace('ws_a', 'Alpha')])
    expect([...store.entities('user').keys()]).toEqual(['usr_1'])
    expect(await store.getCursor()).toBe(dir.head())

    dir.putWorkspace('ws_a', 'Renamed')
    dir.putWorkspace('ws_b', 'Beta')
    const next = await syncer.catchUp()
    expect(next).toMatchObject({ reconciled: false, cursor: dir.head() })
    expect(store.entities('workspace').get('ws_a')?.name).toBe('Renamed')
    expect(store.entities('workspace').has('ws_b')).toBe(true)
  })

  it('reconciles away what the source dropped, and keeps a tombstone against stale replays', async () => {
    const dir = fakeDirectory()
    dir.putWorkspace('ws_a', 'Alpha')
    const store = new MemoryDirectoryStore()
    const syncer = new DirectorySyncer({ client: dir.client, store })
    await syncer.catchUp()

    // Deleted behind the feed's back: only a reconciliation can notice.
    dir.state.workspaces.delete('ws_a')
    await syncer.reconcile()
    expect(store.entities('workspace').size).toBe(0)

    // A late copy of the entity from an older position cannot resurrect it.
    await store.apply({ entityType: 'workspace', key: 'ws_a', seq: 0, entity: workspace('ws_a') })
    expect(store.entities('workspace').size).toBe(0)
  })

  it('falls back to a reconciliation when its cursor is older than the feed keeps', async () => {
    const dir = fakeDirectory()
    dir.putWorkspace('ws_a', 'Alpha')
    const store = new MemoryDirectoryStore()
    await store.setCursor(0)
    dir.state.oldest = 5
    for (let i = 0; i < 5; i++) dir.putWorkspace('ws_a', `v${i}`)

    const result = await new DirectorySyncer({ client: dir.client, store }).catchUp()
    expect(result.reconciled).toBe(true)
    expect(store.entities('workspace').get('ws_a')?.name).toBe('v4')
  })

  it('mirrors what a key limited to some workspaces can reach, without failing', async () => {
    const dir = fakeDirectory({ restricted: true })
    dir.putWorkspace('ws_a', 'Alpha')
    const store = new MemoryDirectoryStore()
    const result = await new DirectorySyncer({ client: dir.client, store }).reconcile()
    expect(result.reconciled).toBe(true)
    expect(store.entities('workspace').size).toBe(1)
    expect(store.entities('user').size).toBe(0)
  })

  it('verifies a push before writing it, then catches up', async () => {
    const dir = fakeDirectory()
    const store = new MemoryDirectoryStore()
    const syncer = new DirectorySyncer({
      client: dir.client,
      store,
      webhookSecret: SECRET,
      now: () => NOW,
    })
    await syncer.catchUp()
    dir.putWorkspace('ws_a', 'Alpha')
    const body = JSON.stringify({
      deliveryId: 'mirror:0-1',
      sentAt: NOW,
      accountId: 'acc',
      event: 'directory.changed',
      changes: dir.state.feed,
      nextAfter: 1,
      headSeq: 1,
    })

    const forged = await syncer.handleDelivery(await sign('{"tampered":true}'), body)
    expect(forged).toEqual({ ok: false, reason: 'bad_signature' })
    expect(store.entities('workspace').size).toBe(0)

    const accepted = await syncer.handleDelivery(await sign(body), body)
    expect(accepted).toMatchObject({ ok: true, event: 'directory.changed' })
    expect(store.entities('workspace').get('ws_a')?.name).toBe('Alpha')
    expect(await store.getCursor()).toBe(1)
  })

  it('keeps only what a restricted key can reach from an account-wide push', async () => {
    const dir = fakeDirectory({ restricted: true, reach: ['ws_a'] })
    const store = new MemoryDirectoryStore()
    const syncer = new DirectorySyncer({
      client: dir.client,
      store,
      webhookSecret: SECRET,
      now: () => NOW,
    })
    await syncer.catchUp()
    await store.apply({
      entityType: 'workspace',
      key: 'ws_gone',
      seq: 0,
      entity: workspace('ws_gone'),
    })
    const change = (seq: number, entityType: string, entityId: string, entity: unknown) => ({
      seq,
      at: 1,
      workspaceId: entityType === 'user' ? null : entityId,
      entityId,
      entityType,
      entity,
    })
    // The changes ride the push alone, so the catch-up after it has nothing to add.
    const body = JSON.stringify({
      deliveryId: 'mirror:0-4',
      sentAt: NOW,
      accountId: 'acc',
      event: 'directory.changed',
      changes: [
        change(1, 'workspace', 'ws_a', workspace('ws_a')),
        change(2, 'workspace', 'ws_b', workspace('ws_b')),
        change(3, 'user', 'usr_1', user('usr_1')),
        change(4, 'workspace', 'ws_gone', null),
      ],
      nextAfter: 4,
      headSeq: 4,
    })

    expect(await syncer.handleDelivery(await sign(body), body)).toMatchObject({ ok: true })
    expect([...store.entities('workspace').keys()]).toEqual(['ws_a'])
    expect(store.entities('user').size).toBe(0)
  })

  it('removes the memberships and repositories of a deleted workspace from the feed alone', async () => {
    const dir = fakeDirectory({ restricted: true })
    dir.putWorkspace('ws_a', 'Alpha')
    dir.putWorkspace('ws_b', 'Beta')
    const store = new MemoryDirectoryStore()
    const syncer = new DirectorySyncer({ client: dir.client, store })
    await syncer.catchUp()
    const membership = (workspaceId: string) => ({
      workspaceId,
      userId: 'usr_1',
      role: 'member' as const,
      createdAt: 1,
    })
    await store.apply({
      entityType: 'workspace_membership',
      key: 'ws_a/usr_1',
      seq: 1,
      entity: membership('ws_a'),
    })
    await store.apply({
      entityType: 'workspace_membership',
      key: 'ws_b/usr_1',
      seq: 2,
      entity: membership('ws_b'),
    })

    // A restricted key sees only the workspace deletion, never the rows under it.
    dir.deleteWorkspace('ws_a')
    await syncer.catchUp()
    expect([...store.entities('workspace_membership').keys()]).toEqual(['ws_b/usr_1'])
  })

  it('reads an API refusal by its reason, whichever copy of the SDK threw it', async () => {
    const dir = fakeDirectory()
    dir.putWorkspace('ws_a', 'Alpha')
    const store = new MemoryDirectoryStore()
    await store.setCursor(0)
    // What the integrator's own copy of `@cat-factory/sdk` throws: the same shape, another class.
    const listChanges = dir.client.directory.listChanges.bind(dir.client.directory)
    let refused = false
    dir.client.directory.listChanges = (async (query) => {
      if (!refused) {
        refused = true
        throw Object.assign(new Error('409 conflict'), {
          status: 409,
          details: { reason: 'cursor_expired' },
        })
      }
      return listChanges(query)
    }) as typeof listChanges

    const result = await new DirectorySyncer({ client: dir.client, store }).catchUp()
    expect(result.reconciled).toBe(true)
    expect(store.entities('workspace').has('ws_a')).toBe(true)
  })

  it('answers a push of an event it does not know with a catch-up', async () => {
    const dir = fakeDirectory()
    const store = new MemoryDirectoryStore()
    const syncer = new DirectorySyncer({
      client: dir.client,
      store,
      webhookSecret: SECRET,
      now: () => NOW,
    })
    await syncer.catchUp()
    dir.putWorkspace('ws_a', 'Alpha')
    const body = JSON.stringify({
      deliveryId: 'mirror:future',
      sentAt: NOW,
      accountId: 'acc',
      event: 'directory.some_future_event',
    })
    const result = await syncer.handleDelivery(await sign(body), body)
    expect(result).toMatchObject({ ok: true, event: 'directory.some_future_event' })
    expect(store.entities('workspace').has('ws_a')).toBe(true)
  })

  it('answers a push request with 204, and 401 for a bad signature', async () => {
    const dir = fakeDirectory()
    const syncer = new DirectorySyncer({
      client: dir.client,
      store: new MemoryDirectoryStore(),
      webhookSecret: SECRET,
      now: () => NOW,
    })
    const body = JSON.stringify({
      deliveryId: 'mirror:0-0:resync',
      sentAt: NOW,
      accountId: 'acc',
      event: 'directory.resync_required',
      headSeq: 0,
    })
    const ok = await syncer.handleRequest(
      new Request('https://receiver.example.com/', {
        method: 'POST',
        body,
        headers: await sign(body),
      }),
    )
    expect(ok.status).toBe(204)
    const bad = await syncer.handleRequest(
      new Request('https://receiver.example.com/', {
        method: 'POST',
        body,
        headers: await sign('x'),
      }),
    )
    expect(bad.status).toBe(401)
  })
})
