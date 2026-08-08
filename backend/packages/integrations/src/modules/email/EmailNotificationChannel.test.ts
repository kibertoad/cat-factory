import type {
  EmailMessage,
  EmailSender,
  Membership,
  Notification,
  UserRecord,
  WorkspaceAccessRow,
  WorkspaceMemberRecord,
} from '@cat-factory/kernel'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_DELIVERY_REASONS, isAlertingDelivery } from '@cat-factory/kernel'
import { EmailNotificationChannel } from './EmailNotificationChannel.js'
import type { EmailNotificationChannelDependencies } from './EmailNotificationChannel.js'

// The channel's contract: it mails the people the BOARD would show the card to, never more;
// an unconfigured account is silent rather than failing; and one bad address costs only that
// address. Rendering is asserted in `emailNotification.logic.test.ts`.

const NOTIFICATION: Notification = {
  id: 'ntf-1',
  type: 'merge_review',
  status: 'open',
  severity: 'normal',
  blockId: 'blk-1',
  executionId: 'exec-1',
  title: 'Ready to merge: add rate limiting',
  body: 'The merger scored this outside the auto-merge thresholds.',
  payload: { prUrl: 'https://example.test/pr/7' },
  createdAt: 1_000,
  resolvedAt: null,
}

interface Harness {
  channel: EmailNotificationChannel
  sent: EmailMessage[]
  errors: unknown[]
  sender: EmailSender | null
}

function harness(over: Partial<EmailNotificationChannelDependencies> = {}): Harness {
  const sent: EmailMessage[] = []
  const errors: unknown[] = []
  const sender: EmailSender = {
    send: async (message) => {
      sent.push(message)
    },
  }
  const accessRow: WorkspaceAccessRow = {
    accountId: 'acc-1',
    ownerUserId: null,
    accessMode: 'account',
  }
  const memberships: Membership[] = [
    { accountId: 'acc-1', userId: 'usr-1', roles: ['admin'], createdAt: 0 },
    { accountId: 'acc-1', userId: 'usr-2', roles: ['developer'], createdAt: 0 },
  ]
  const roster: WorkspaceMemberRecord[] = []
  const users: UserRecord[] = [
    { id: 'usr-1', name: 'Ada', email: 'ada@example.test', avatarUrl: null, createdAt: 0 },
    { id: 'usr-2', name: 'Bo', email: 'bo@example.test', avatarUrl: null, createdAt: 0 },
  ]
  const deps: EmailNotificationChannelDependencies = {
    workspaceRepository: { accessRowOf: async () => accessRow } as never,
    membershipRepository: { listByAccount: async () => memberships } as never,
    workspaceMemberRepository: { listByWorkspace: async () => roster } as never,
    userRepository: {
      listByIds: async (ids: string[]) => users.filter((u) => ids.includes(u.id)),
    } as never,
    resolveSender: async () => sender,
    appBaseUrl: 'https://app.example.test',
    onError: (error) => errors.push(error),
    ...over,
  }
  return { channel: new EmailNotificationChannel(deps), sent, errors, sender }
}

describe('EmailNotificationChannel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('mails every member of an account-mode board once, with a deep link', async () => {
    const h = harness()
    await h.channel.deliver('ws-1', NOTIFICATION, 'raised')

    expect(h.sent.map((m) => m.to).sort()).toEqual(['ada@example.test', 'bo@example.test'])
    expect(h.sent[0]!.subject).toContain('Merge review')
    expect(h.sent[0]!.text).toContain('https://app.example.test/?ws=ws-1&block=blk-1&run=exec-1')
    expect(h.errors).toEqual([])
  })

  it('sends nothing when the account has no email sender connected', async () => {
    const h = harness({ resolveSender: async () => null })
    await h.channel.deliver('ws-1', NOTIFICATION, 'raised')

    // Opt-in pass-through: no attempts AND no warnings — an unconfigured integration is
    // not a failure to report.
    expect(h.sent).toEqual([])
    expect(h.errors).toEqual([])
  })

  it('does not mail an account member who is off a restricted board', async () => {
    const h = harness({
      workspaceRepository: {
        accessRowOf: async () => ({
          accountId: 'acc-1',
          ownerUserId: null,
          accessMode: 'restricted',
        }),
      } as never,
      workspaceMemberRepository: {
        listByWorkspace: async () => [
          {
            workspaceId: 'ws-1',
            userId: 'usr-2',
            role: 'member',
            createdAt: 0,
            addedByUserId: null,
          },
        ],
      } as never,
    })
    await h.channel.deliver('ws-1', NOTIFICATION, 'raised')

    // usr-1 is an account ADMIN, so they keep access (and the mail); a developer with no
    // roster row does not — the same answer `resolveWorkspaceAccess` gives.
    expect(h.sent.map((m) => m.to).sort()).toEqual(['ada@example.test', 'bo@example.test'])
  })

  it('skips a user with no email address instead of failing the delivery', async () => {
    const h = harness({
      userRepository: {
        listByIds: async () => [
          { id: 'usr-1', name: 'Ada', email: null, avatarUrl: null, createdAt: 0 },
          { id: 'usr-2', name: 'Bo', email: 'bo@example.test', avatarUrl: null, createdAt: 0 },
        ],
      } as never,
    })
    await h.channel.deliver('ws-1', NOTIFICATION, 'raised')

    expect(h.sent.map((m) => m.to)).toEqual(['bo@example.test'])
    expect(h.errors).toEqual([])
  })

  it('isolates one failing recipient from the rest', async () => {
    const sent: string[] = []
    const errors: unknown[] = []
    const h = harness({
      resolveSender: async () => ({
        send: async (message: EmailMessage) => {
          if (message.to === 'ada@example.test') throw new Error('550 mailbox unavailable')
          sent.push(message.to)
        },
      }),
      onError: (error) => errors.push(error),
    })
    await h.channel.deliver('ws-1', NOTIFICATION, 'raised')

    expect(sent).toEqual(['bo@example.test'])
    expect(errors).toHaveLength(1)
  })

  it('reports a provider outage through onError without throwing at the caller', async () => {
    const h = harness({
      membershipRepository: {
        listByAccount: async () => {
          throw new Error('db unavailable')
        },
      } as never,
    })

    await expect(h.channel.deliver('ws-1', NOTIFICATION, 'raised')).resolves.toBeUndefined()
    expect(h.errors).toHaveLength(1)
  })

  it('sends nothing for a legacy board with no owning account', async () => {
    const h = harness({
      workspaceRepository: {
        accessRowOf: async () => ({
          accountId: null,
          ownerUserId: 'usr-1',
          accessMode: 'account',
        }),
      } as never,
    })
    await h.channel.deliver('ws-1', NOTIFICATION, 'raised')

    expect(h.sent).toEqual([])
    expect(h.errors).toEqual([])
  })

  // The lifecycle re-delivers a card on every transition it makes (resolve, dismissal, the
  // auto-clear when a run advances past its gate, the escalation sweep). A mailbox cannot render
  // a correction, so a second "Decision needed: …" arriving after the decision was made is simply
  // false. Only the RAISED edge is an alert.
  it.each(NOTIFICATION_DELIVERY_REASONS.filter((r) => !isAlertingDelivery(r)))(
    'mails nothing on a %s delivery, and reads nothing to decide that',
    async (reason) => {
      let reads = 0
      const h = harness({
        workspaceRepository: {
          accessRowOf: async () => {
            reads++
            return { accountId: 'acc-1', ownerUserId: null, accessMode: 'account' }
          },
        } as never,
      })

      await h.channel.deliver('ws-1', { ...NOTIFICATION, status: 'dismissed' }, reason)

      expect(h.sent).toEqual([])
      expect(h.errors).toEqual([])
      // Not merely silent: the escalation sweep re-delivers every overdue card in a workspace in
      // one loop, so a channel that resolved the audience before deciding would be four reads per
      // card, and a mothership round trip each.
      expect(reads).toBe(0)
    },
  )
})
