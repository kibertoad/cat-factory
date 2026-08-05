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
      listByAccount: vi.fn((): Promise<AuditEventPage> =>
        Promise.resolve({ events: [], nextCursor: null }),
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
  targetType: 'user' as const,
  targetId: 'usr-2',
  details: { roles: 'developer' },
}

describe('AuditService', () => {
  it('stamps the id and the commit time, leaving the caller’s fields alone', async () => {
    const { appended, repo } = fakeRepo()
    const { svc } = service(repo)

    await svc.record(event)

    expect(appended).toEqual([{ ...event, id: 'aud_1', at: 1_700_000_000_000 }])
  })

  it('resolves only once the append has settled, so the row cannot be dropped', async () => {
    // The regression this pins: a fire-and-forget append is discarded on the Worker when the
    // isolate freezes after the response (see `http/waitUntil.ts`), so the row would be missing in
    // production while a fake recorder went on passing. `record` must not resolve early.
    let release: (() => void) | undefined
    let landed = false
    const { repo } = fakeRepo({
      append: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = () => {
              landed = true
              resolve()
            }
          }),
      ),
    })
    const { svc } = service(repo)

    const settled = svc.record(event).then(() => landed)
    expect(landed).toBe(false)
    release?.()

    await expect(settled).resolves.toBe(true)
  })

  it('swallows a failing append and WARNS, naming the action and account', async () => {
    // The property that matters: a broken audit store costs the row, never the membership change
    // the operator asked for. Silence would make a permanently broken store invisible.
    const { repo } = fakeRepo({
      append: vi.fn(() => Promise.reject(new Error('audit store unreachable'))),
    })
    const { svc, logger } = service(repo)

    await expect(svc.record(event)).resolves.toBeUndefined()

    const warns = logger.lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.fields).toMatchObject({
      accountId: 'acc-1',
      action: 'account.member_added',
      actorKind: 'user',
    })
  })

  it('assigns a distinct id per event', async () => {
    const { appended, repo } = fakeRepo()
    const { svc } = service(repo)

    await svc.record(event)
    await svc.record({ ...event, action: 'account.member_roles_changed' })

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
