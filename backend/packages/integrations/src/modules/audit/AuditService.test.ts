import { describe, expect, it, vi } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { AuditEventPage, AuditEventRecord, AuditEventRepository } from '@cat-factory/kernel'
import { AuditService } from './AuditService.js'

function fakeRepo(overrides: Partial<AuditEventRepository> = {}) {
  const appended: AuditEventRecord[] = []
  return {
    appended,
    repo: {
      append: vi.fn((event: AuditEventRecord) => {
        appended.push(event)
        return Promise.resolve()
      }),
      listByAccount: vi.fn(
        (): Promise<AuditEventPage> => Promise.resolve({ events: [], nextCursor: null }),
      ),
      ...overrides,
    } satisfies AuditEventRepository,
  }
}

function service(repo: AuditEventRepository, logger = createRecordingLogger()) {
  let seq = 0
  return {
    logger,
    svc: new AuditService({
      auditEventRepository: repo,
      idGenerator: {
        next: (prefix: string) => {
          seq += 1
          return `${prefix}_${seq}`
        },
      },
      clock: { now: () => 1_700_000_000_000 },
      logger,
    }),
  }
}

const event = {
  accountId: 'acc-1',
  actor: { kind: 'user' as const, userId: 'usr-1' },
  action: 'account.member_added' as const,
  targetType: 'user',
  targetId: 'usr-2',
  summary: 'Added to the account with role(s) developer',
}

describe('AuditService', () => {
  it('stamps the id and the commit time, leaving the caller’s fields alone', async () => {
    const { appended, repo } = fakeRepo()
    const { svc } = service(repo)

    svc.record(event)
    // `record` is fire-and-forget, so the append settles on a later microtask.
    await vi.waitFor(() => expect(appended).toHaveLength(1))

    expect(appended[0]).toEqual({ ...event, id: 'aud_1', at: 1_700_000_000_000 })
  })

  it('returns before the append settles, so an audited action never waits on the log', () => {
    let release: (() => void) | undefined
    const { repo } = fakeRepo({
      append: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
    })
    const { svc } = service(repo)

    // A pending store must not block the caller: `record` returns void, synchronously.
    expect(svc.record(event)).toBeUndefined()
    expect(release).toBeDefined()
    release?.()
  })

  it('swallows a failing append and WARNS, naming the action and account', async () => {
    // The property that matters: a broken audit store costs the row, never the membership change
    // the operator asked for. Silence would make a permanently broken store invisible.
    const { repo } = fakeRepo({
      append: vi.fn(() => Promise.reject(new Error('audit store unreachable'))),
    })
    const { svc, logger } = service(repo)

    expect(() => svc.record(event)).not.toThrow()

    await vi.waitFor(() => expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1))
    const warn = logger.lines.find((l) => l.level === 'warn')
    expect(warn?.fields).toMatchObject({
      accountId: 'acc-1',
      action: 'account.member_added',
      actorKind: 'user',
    })
  })

  it('assigns a distinct id per event', async () => {
    const { appended, repo } = fakeRepo()
    const { svc } = service(repo)

    svc.record(event)
    svc.record({ ...event, action: 'account.member_roles_changed' })
    await vi.waitFor(() => expect(appended).toHaveLength(2))

    expect(appended.map((e) => e.id)).toEqual(['aud_1', 'aud_2'])
  })

  it('propagates a failing READ instead of rendering an empty page', async () => {
    // The opposite disposition from `record`, deliberately: a viewer that silently shows nothing
    // when the store is down tells an admin the exact opposite of the truth.
    const { repo } = fakeRepo({
      listByAccount: vi.fn(() => Promise.reject(new Error('audit store unreachable'))),
    })
    const { svc } = service(repo)

    await expect(svc.listByAccount('acc-1')).rejects.toThrow('audit store unreachable')
  })

  it('passes pagination options straight through to the store', async () => {
    const { repo } = fakeRepo()
    const { svc } = service(repo)

    await svc.listByAccount('acc-1', { cursor: '123:aud_9', limit: 10 })

    expect(repo.listByAccount).toHaveBeenCalledWith('acc-1', { cursor: '123:aud_9', limit: 10 })
  })
})
