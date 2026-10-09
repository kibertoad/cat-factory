import type { DirectoryChange, DirectoryChangePage } from '@cat-factory/contracts'
import {
  ConflictError,
  type DirectoryFeedReader,
  type DirectoryWebhookRecord,
  type DirectoryWebhookRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { DirectoryWebhookService } from './DirectoryWebhookService.js'

// The delivery sweep's claim protocol, over in-memory fakes. What matters is that a page is
// claimed BEFORE it is sent, released when the send fails (so it is offered again), never sent
// twice by two sweepers, and that an endpoint which fell out of the feed's retention is told so.

const cipher = {
  encrypt: async (plaintext: string) => `sealed:${plaintext}`,
  decrypt: async (envelope: string) => envelope.replace(/^sealed:/, ''),
}
const clock = { now: () => 1_700_000_000_000 }

class MemoryRepo implements DirectoryWebhookRepository {
  rows = new Map<string, DirectoryWebhookRecord>()
  private key = (accountId: string, id: string) => `${accountId}/${id}`
  async list(accountId: string) {
    return [...this.rows.values()].filter((r) => r.accountId === accountId)
  }
  async get(accountId: string, id: string) {
    return this.rows.get(this.key(accountId, id)) ?? null
  }
  async put(record: DirectoryWebhookRecord, limit: number) {
    const existing = this.rows.get(this.key(record.accountId, record.id))
    if (!existing && (await this.list(record.accountId)).length >= limit) {
      return 'limit_reached' as const
    }
    this.rows.set(this.key(record.accountId, record.id), {
      ...record,
      deliveredSeq: existing?.deliveredSeq ?? record.deliveredSeq,
    })
    return 'stored' as const
  }
  async delete(accountId: string, id: string) {
    this.rows.delete(this.key(accountId, id))
  }
  async listEnabled() {
    return [...this.rows.values()].filter((r) => r.enabled)
  }
  async advance(accountId: string, id: string, fromSeq: number, toSeq: number) {
    const row = this.rows.get(this.key(accountId, id))
    if (!row || row.deliveredSeq !== fromSeq) return false
    row.deliveredSeq = toSeq
    return true
  }
}

function change(seq: number): DirectoryChange {
  return {
    seq,
    at: 1,
    workspaceId: 'ws',
    entityId: 'ws',
    entityType: 'workspace',
    entity: { id: 'ws', name: 'Board', description: null, accessMode: 'account' },
  }
}

function feed(head: number, options: { expired?: boolean } = {}): DirectoryFeedReader {
  return {
    headSeq: async () => head,
    changes: async (_reader, after): Promise<DirectoryChangePage> => {
      if (options.expired) throw new ConflictError('gone', 'cursor_expired')
      const changes = Array.from({ length: head - after }, (_, i) => change(after + i + 1))
      return { changes, nextAfter: head, headSeq: head }
    },
  }
}

function build(head: number, status = 200, options: { expired?: boolean } = {}) {
  const repo = new MemoryRepo()
  const sent: { url: string; body: unknown; signature: string | null }[] = []
  const service = new DirectoryWebhookService({
    repository: repo,
    feed: feed(head, options),
    secretCipher: cipher,
    clock,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      sent.push({
        url,
        body: JSON.parse(String(init.body)),
        signature: headers.get('x-cat-factory-signature'),
      })
      return new Response(null, { status })
    }) as unknown as typeof fetch,
  })
  return { repo, sent, service }
}

describe('DirectoryWebhookService', () => {
  it('starts a new endpoint at the feed head and seals its secret', async () => {
    const { repo, service } = build(7)
    const created = await service.put('acc', 'mirror', {
      url: 'https://hooks.example.com/dir',
      secret: 'a-signing-secret-long-enough',
    })
    expect(created).toMatchObject({ deliveredSeq: 7, hasSecret: true, enabled: true })
    expect(repo.rows.get('acc/mirror')?.secretSealed).toBe('sealed:a-signing-secret-long-enough')
    expect(JSON.stringify(created)).not.toContain('a-signing-secret')
  })

  it('refuses a new endpoint with no url, and an eleventh one', async () => {
    const { service } = build(0)
    await expect(service.put('acc', 'x', {})).rejects.toMatchObject({
      details: { reason: 'webhook_url_required' },
    })
    for (let i = 0; i < 10; i++)
      await service.put('acc', `h${i}`, { url: 'https://h.example.com/' })
    await expect(
      service.put('acc', 'h10', { url: 'https://h.example.com/' }),
    ).rejects.toMatchObject({ details: { reason: 'webhook_limit_reached' } })
  })

  it('pushes the pending changes signed, and advances past them', async () => {
    const { repo, sent, service } = build(3)
    repo.rows.set('acc/m', {
      accountId: 'acc',
      id: 'm',
      url: 'https://h.example.com/',
      enabled: true,
      secretSealed: 'sealed:a-signing-secret-long-enough',
      deliveredSeq: 1,
      updatedAt: 1,
    })
    expect(await service.deliverPending()).toEqual({ pushed: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.signature).toMatch(/^v1=[0-9a-f]{64}$/)
    expect(sent[0]!.body).toMatchObject({
      deliveryId: 'm:1-3',
      accountId: 'acc',
      event: 'directory.changed',
      nextAfter: 3,
    })
    expect((sent[0]!.body as { changes: { seq: number }[] }).changes.map((c) => c.seq)).toEqual([
      2, 3,
    ])
    expect(repo.rows.get('acc/m')?.deliveredSeq).toBe(3)

    // Caught up: the next sweep sends nothing.
    expect(await service.deliverPending()).toEqual({ pushed: 0, failed: 0 })
  })

  it('releases the claim when the push fails, so the same page is offered again', async () => {
    const { repo, sent, service } = build(3, 500)
    repo.rows.set('acc/m', {
      accountId: 'acc',
      id: 'm',
      url: 'https://h.example.com/',
      enabled: true,
      secretSealed: null,
      deliveredSeq: 1,
      updatedAt: 1,
    })
    const result = await service.deliverPending()
    expect(result.failed).toBe(1)
    expect(sent.length).toBeGreaterThan(0)
    expect(repo.rows.get('acc/m')?.deliveredSeq).toBe(1)
  })

  it('never sends a page another sweeper already claimed', async () => {
    const { repo, sent, service } = build(3)
    repo.rows.set('acc/m', {
      accountId: 'acc',
      id: 'm',
      url: 'https://h.example.com/',
      enabled: true,
      secretSealed: null,
      deliveredSeq: 1,
      updatedAt: 1,
    })
    await Promise.all([service.deliverPending(), service.deliverPending()])
    expect(sent).toHaveLength(1)
  })

  it('tells an endpoint that fell out of the feed to resynchronize, and resumes at the head', async () => {
    const { repo, sent, service } = build(50, 200, { expired: true })
    repo.rows.set('acc/m', {
      accountId: 'acc',
      id: 'm',
      url: 'https://h.example.com/',
      enabled: true,
      secretSealed: null,
      deliveredSeq: 1,
      updatedAt: 1,
    })
    await service.deliverPending()
    expect(sent[0]!.body).toMatchObject({ event: 'directory.resync_required', headSeq: 50 })
    expect(repo.rows.get('acc/m')?.deliveredSeq).toBe(50)
  })
})
