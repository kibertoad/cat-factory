import { describe, expect, it } from 'vitest'
import type { AccountRole, WorkspaceRole } from './types.js'
import {
  type WorkspaceAccessRow,
  resolveWorkspaceAccess,
  workspaceRoleAtLeast,
} from './workspace-access.js'

const USER = 'user_1'

function row(overrides: Partial<WorkspaceAccessRow> = {}): WorkspaceAccessRow {
  return {
    accountId: 'acc_1',
    ownerUserId: null,
    accessMode: 'account',
    ...overrides,
  }
}

function resolve(input: {
  workspace?: Partial<WorkspaceAccessRow>
  accountRoles?: AccountRole[]
  memberRole?: WorkspaceRole | null
  userId?: string
}) {
  return resolveWorkspaceAccess({
    userId: input.userId ?? USER,
    workspace: row(input.workspace),
    accountRoles: input.accountRoles ?? [],
    memberRole: input.memberRole ?? null,
  })
}

describe('workspaceRoleAtLeast', () => {
  it('orders viewer < member < admin', () => {
    expect(workspaceRoleAtLeast('admin', 'member')).toBe(true)
    expect(workspaceRoleAtLeast('member', 'member')).toBe(true)
    expect(workspaceRoleAtLeast('viewer', 'member')).toBe(false)
    expect(workspaceRoleAtLeast('viewer', 'viewer')).toBe(true)
    expect(workspaceRoleAtLeast('member', 'admin')).toBe(false)
  })
})

describe('resolveWorkspaceAccess', () => {
  describe('legacy / unscoped board', () => {
    it('grants the owner admin', () => {
      const access = resolve({ workspace: { accountId: null, ownerUserId: USER } })
      expect(access).toEqual({ allowed: true, role: 'admin', permissions: expect.any(Set) })
    })

    it('denies a non-owner (even with account roles / a member row)', () => {
      expect(
        resolve({
          workspace: { accountId: null, ownerUserId: 'someone_else' },
          accountRoles: ['admin'],
          memberRole: 'admin',
        }),
      ).toEqual({ allowed: false })
    })

    it('denies an owner-less legacy board', () => {
      expect(resolve({ workspace: { accountId: null, ownerUserId: null } })).toEqual({
        allowed: false,
      })
    })
  })

  describe('account membership is a prerequisite', () => {
    it('denies a non-account-member even with a stale workspace_members row', () => {
      expect(
        resolve({ accountRoles: [], memberRole: 'admin', workspace: { accessMode: 'restricted' } }),
      ).toEqual({ allowed: false })
    })
  })

  describe('account admin escape hatch', () => {
    it('grants admin regardless of access mode or a member row', () => {
      expect(
        resolve({ accountRoles: ['admin'], workspace: { accessMode: 'restricted' } }).allowed,
      ).toBe(true)
      const a = resolve({ accountRoles: ['admin'], workspace: { accessMode: 'restricted' } })
      expect(a.allowed && a.role).toBe('admin')
    })

    it('grants admin in account mode without any member row', () => {
      const a = resolve({ accountRoles: ['admin', 'product'] })
      expect(a.allowed && a.role).toBe('admin')
    })
  })

  describe('account mode (upgrade-only overlay)', () => {
    it('grants a plain account member the member role', () => {
      const a = resolve({ accountRoles: ['developer'] })
      expect(a.allowed && a.role).toBe('member')
    })

    it('ignores a viewer member row (no demotion in account mode)', () => {
      const a = resolve({ accountRoles: ['developer'], memberRole: 'viewer' })
      expect(a.allowed && a.role).toBe('member')
    })

    it('upgrades to admin when a member row grants it', () => {
      const a = resolve({ accountRoles: ['developer'], memberRole: 'admin' })
      expect(a.allowed && a.role).toBe('admin')
    })
  })

  describe('restricted mode', () => {
    it('grants exactly the member row role', () => {
      const a = resolve({
        accountRoles: ['developer'],
        memberRole: 'viewer',
        workspace: { accessMode: 'restricted' },
      })
      expect(a.allowed && a.role).toBe('viewer')
    })

    it('denies an account member with no member row', () => {
      expect(
        resolve({ accountRoles: ['developer'], workspace: { accessMode: 'restricted' } }),
      ).toEqual({ allowed: false })
    })
  })
})
