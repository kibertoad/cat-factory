import { describe, expect, it } from 'vitest'
import { WORKSPACE_ROLE_PERMISSIONS, permissionsForRole } from './workspace-members.js'

describe('WORKSPACE_ROLE_PERMISSIONS', () => {
  it('grades the three roles as a strict lattice', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.viewer).toEqual(['workspace.read'])
    expect(WORKSPACE_ROLE_PERMISSIONS.member).toEqual([
      'workspace.read',
      'board.write',
      'runs.execute',
    ])
    // admin is a superset of member is a superset of viewer.
    for (const p of WORKSPACE_ROLE_PERMISSIONS.member) {
      expect(WORKSPACE_ROLE_PERMISSIONS.admin).toContain(p)
    }
    expect(WORKSPACE_ROLE_PERMISSIONS.admin).toContain('members.manage')
  })
})

describe('permissionsForRole', () => {
  it('resolves a role to its permission set', () => {
    const admin = permissionsForRole('admin')
    expect(admin.has('secrets.manage')).toBe(true)
    expect(permissionsForRole('member').has('secrets.manage')).toBe(false)
    expect(permissionsForRole('member').has('runs.execute')).toBe(true)
    expect(permissionsForRole('viewer').has('board.write')).toBe(false)
    expect(permissionsForRole('viewer').has('workspace.read')).toBe(true)
  })
})
