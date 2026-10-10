import { describe, expect, it } from 'vitest'
import type { InfraSetup, InfraSetupOwners } from '~/types/domain'
import { blockingSetupNotice, canActOnSetup, type SetupActor } from './setupAudience'

const admin: SetupActor = {
  fullSurface: true,
  canManageIntegrations: true,
  canExecuteRuns: true,
  isAccountAdmin: false,
  accountsEnabled: true,
}
const member: SetupActor = { ...admin, canManageIntegrations: false }
const viewer: SetupActor = { ...member, canExecuteRuns: false }
const designerAdmin: SetupActor = { ...admin, fullSurface: false }
const designerMember: SetupActor = { ...member, fullSurface: false }

const owners: InfraSetupOwners = {
  agentExecutor: 'workspace_admin',
  ephemeralEnvironments: 'workspace_admin',
  binaryStorage: 'account_admin',
}

function status(patch: Partial<InfraSetup>): InfraSetup {
  return {
    agentExecutor: 'configured',
    ephemeralEnvironments: 'configured',
    binaryStorage: 'configured',
    ...patch,
  }
}

const noRunner = status({ agentExecutor: 'not_defined' })

describe('canActOnSetup', () => {
  it('lets a workspace admin act on the workspace areas, and not a member', () => {
    expect(canActOnSetup('workspace_admin', admin)).toBe(true)
    expect(canActOnSetup('workspace_admin', member)).toBe(false)
  })

  it('keeps every prompt off the designer surface, whatever the permissions', () => {
    expect(canActOnSetup('workspace_admin', designerAdmin)).toBe(false)
    expect(canActOnSetup('account_admin', { ...designerAdmin, isAccountAdmin: true })).toBe(false)
  })

  it('gives an account-owned gap to the account admin, not to a workspace admin', () => {
    expect(canActOnSetup('account_admin', admin)).toBe(false)
    expect(canActOnSetup('account_admin', { ...member, isAccountAdmin: true })).toBe(true)
  })

  it('lets the single user act on an account-owned gap when there are no accounts', () => {
    expect(canActOnSetup('account_admin', { ...admin, accountsEnabled: false })).toBe(true)
  })

  it('lets nobody act on an operator-owned gap', () => {
    expect(canActOnSetup('operator', { ...admin, isAccountAdmin: true })).toBe(false)
  })

  it('falls back to the workspace admin for an absent owner or one this build does not know', () => {
    // An older backend sends nothing; a newer one may send a value past the compiled union. Both
    // read as the workspace admin, and neither throws inside the banner's render.
    for (const owner of [undefined, 'board_owner']) {
      expect(canActOnSetup(owner, admin)).toBe(true)
      expect(canActOnSetup(owner, member)).toBe(false)
    }
  })
})

describe('blockingSetupNotice', () => {
  it('tells a member that agents cannot run, and who can fix it', () => {
    expect(blockingSetupNotice(noRunner, owners, member)).toEqual({
      area: 'agentExecutor',
      kind: 'setup',
      remedy: 'workspace_admin',
    })
  })

  it('reports an executor outage as an outage', () => {
    expect(
      blockingSetupNotice(status({ agentExecutor: 'unreachable' }), owners, member)?.kind,
    ).toBe('outage')
  })

  it('says nothing to the admin, who gets the full card instead', () => {
    expect(blockingSetupNotice(noRunner, owners, admin)).toBeNull()
  })

  it('says nothing to a viewer, whose work the gap does not stop', () => {
    expect(blockingSetupNotice(noRunner, owners, viewer)).toBeNull()
  })

  it('tells an admin on the designer surface to switch surface, not to find an admin', () => {
    expect(blockingSetupNotice(noRunner, owners, designerAdmin)?.remedy).toBe('full_surface')
    // A designer without the grant is still pointed at the owner.
    expect(blockingSetupNotice(noRunner, owners, designerMember)?.remedy).toBe('workspace_admin')
  })

  it('says nothing about gaps that only degrade some runs', () => {
    const optional = status({ ephemeralEnvironments: 'not_defined', binaryStorage: 'not_defined' })
    expect(blockingSetupNotice(optional, owners, member)).toBeNull()
  })

  it('says nothing when the executor is configured or not used here', () => {
    expect(blockingSetupNotice(status({}), owners, member)).toBeNull()
    expect(
      blockingSetupNotice(status({ agentExecutor: 'not_applicable' }), owners, member),
    ).toBeNull()
    expect(blockingSetupNotice(null, owners, member)).toBeNull()
  })

  it('names the workspace admin when the backend reports no owner, or one it does not know', () => {
    expect(blockingSetupNotice(noRunner, null, member)?.remedy).toBe('workspace_admin')
    const unknown = { ...owners, agentExecutor: 'board_owner' } as unknown as InfraSetupOwners
    expect(blockingSetupNotice(noRunner, unknown, member)?.remedy).toBe('workspace_admin')
  })
})
