import { describe, expect, it } from 'vitest'
import { notificationAudienceUserIds } from './notification-audience.js'
import type { NotificationAudienceInput } from './notification-audience.js'

// The audience must not be wider than `resolveWorkspaceAccess` would allow for the same
// people: a notification body carries a task's title and context, so anyone it names is
// someone the board itself would show it to.

const audience = (over: Partial<NotificationAudienceInput> = {}): string[] =>
  notificationAudienceUserIds({
    workspace: { accountId: 'acc-1', ownerUserId: null, accessMode: 'account' },
    accountMembers: [
      { userId: 'usr-admin', roles: ['admin'] },
      { userId: 'usr-dev', roles: ['developer'] },
    ],
    workspaceMemberUserIds: [],
    ...over,
  })

describe('notificationAudienceUserIds', () => {
  it('is the owner alone on a legacy (unscoped) board', () => {
    expect(
      audience({
        workspace: { accountId: null, ownerUserId: 'usr-owner', accessMode: 'account' },
        accountMembers: [{ userId: 'usr-other', roles: ['admin'] }],
      }),
    ).toEqual(['usr-owner'])
  })

  it('is empty for a legacy board with no owner', () => {
    expect(
      audience({
        workspace: { accountId: null, ownerUserId: null, accessMode: 'account' },
      }),
    ).toEqual([])
  })

  it('is the whole account roster in account mode, member rows adding nobody', () => {
    expect(audience({ workspaceMemberUserIds: ['usr-dev'] })).toEqual(['usr-admin', 'usr-dev'])
  })

  it('is the rostered members plus account admins on a restricted board', () => {
    expect(
      audience({
        workspace: { accountId: 'acc-1', ownerUserId: null, accessMode: 'restricted' },
        workspaceMemberUserIds: ['usr-dev'],
      }),
    ).toEqual(['usr-admin', 'usr-dev'])
  })

  it('excludes an account member with no member row on a restricted board', () => {
    expect(
      audience({
        workspace: { accountId: 'acc-1', ownerUserId: null, accessMode: 'restricted' },
        accountMembers: [
          { userId: 'usr-dev', roles: ['developer'] },
          { userId: 'usr-product', roles: ['product'] },
        ],
        workspaceMemberUserIds: ['usr-dev'],
      }),
    ).toEqual(['usr-dev'])
  })

  it('ignores a member row whose account membership is gone (fail-closed, as access is)', () => {
    expect(
      audience({
        workspace: { accountId: 'acc-1', ownerUserId: null, accessMode: 'restricted' },
        accountMembers: [{ userId: 'usr-dev', roles: ['developer'] }],
        workspaceMemberUserIds: ['usr-dev', 'usr-offboarded'],
      }),
    ).toEqual(['usr-dev'])
  })

  it('de-duplicates a user who is both an admin and rostered', () => {
    expect(
      audience({
        workspace: { accountId: 'acc-1', ownerUserId: null, accessMode: 'restricted' },
        workspaceMemberUserIds: ['usr-admin'],
      }),
    ).toEqual(['usr-admin'])
  })
})
