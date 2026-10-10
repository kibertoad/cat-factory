import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceAccess } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'
import { useWorkspaceAccess } from '~/composables/useWorkspaceAccess'

// `useWorkspaceAccess` reads the active board's resolved `{ role, permissions }` off the
// workspace store and answers "can the caller do X here". The store is real (a fresh Pinia
// per test via test/setup.ts); the composable calls it through the Nuxt auto-import, so
// expose it as a global. No API/i18n is touched by the composable.
beforeEach(() => {
  vi.stubGlobal('useWorkspaceStore', useWorkspaceStore)
})

/** Set the active board's access on the store, then build the composable over it. */
function withAccess(access: WorkspaceAccess | null) {
  useWorkspaceStore().access = access
  return useWorkspaceAccess()
}

describe('useWorkspaceAccess', () => {
  it('dev-open (no access resolved) allows everything — backend parity', () => {
    const a = withAccess(null)
    expect(a.role.value).toBeNull()
    expect(a.permissions.value).toBeNull()
    expect(a.can('board.write')).toBe(true)
    expect(a.can('members.manage')).toBe(true)
    expect(a.canWriteBoard.value).toBe(true)
    expect(a.canExecuteRuns.value).toBe(true)
    expect(a.canManageSettings.value).toBe(true)
    // dev-open is NOT a viewer — it sees all, so isViewer is false and isMember/isAdmin true.
    expect(a.isViewer.value).toBe(false)
    expect(a.isMember.value).toBe(true)
    expect(a.isAdmin.value).toBe(true)
  })

  it('viewer can only read', () => {
    const a = withAccess({ role: 'viewer', permissions: ['workspace.read'] })
    expect(a.role.value).toBe('viewer')
    expect(a.can('workspace.read')).toBe(true)
    expect(a.can('board.write')).toBe(false)
    expect(a.can('runs.execute')).toBe(false)
    expect(a.canWriteBoard.value).toBe(false)
    expect(a.canExecuteRuns.value).toBe(false)
    expect(a.isViewer.value).toBe(true)
    expect(a.isMember.value).toBe(false)
    expect(a.isAdmin.value).toBe(false)
  })

  it('member can write the board and execute runs but not manage', () => {
    const a = withAccess({
      role: 'member',
      permissions: ['workspace.read', 'board.write', 'runs.execute'],
    })
    expect(a.canWriteBoard.value).toBe(true)
    expect(a.canExecuteRuns.value).toBe(true)
    expect(a.canManageSettings.value).toBe(false)
    expect(a.canManageIntegrations.value).toBe(false)
    expect(a.canManageSecrets.value).toBe(false)
    expect(a.canManageMembers.value).toBe(false)
    expect(a.isViewer.value).toBe(false)
    expect(a.isMember.value).toBe(true)
    expect(a.isAdmin.value).toBe(false)
  })

  it('admin holds every permission', () => {
    const a = withAccess({
      role: 'admin',
      permissions: [
        'workspace.read',
        'board.write',
        'runs.execute',
        'settings.manage',
        'integrations.manage',
        'secrets.manage',
        'members.manage',
      ],
    })
    expect(a.canManageSettings.value).toBe(true)
    expect(a.canManageIntegrations.value).toBe(true)
    expect(a.canManageSecrets.value).toBe(true)
    expect(a.canManageMembers.value).toBe(true)
    expect(a.isAdmin.value).toBe(true)
  })

  it('can() reads the granted permission SET, not the role name', () => {
    // A future upgrade-overlay/custom grant could carry a permission beyond the role's
    // default set; `can()` must honour the array the backend actually sent.
    const a = withAccess({ role: 'member', permissions: ['workspace.read', 'runs.execute'] })
    expect(a.can('board.write')).toBe(false)
    expect(a.can('runs.execute')).toBe(true)
  })

  it('reacts to a live access change (board switch / snapshot refresh)', () => {
    const a = withAccess({ role: 'viewer', permissions: ['workspace.read'] })
    expect(a.canWriteBoard.value).toBe(false)
    useWorkspaceStore().access = {
      role: 'member',
      permissions: ['workspace.read', 'board.write', 'runs.execute'],
    }
    expect(a.canWriteBoard.value).toBe(true)
  })
})
