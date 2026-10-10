import { describe, expect, it } from 'vitest'
import type { InfraSetup, InfraSetupOwners } from '~/types/domain'
import { blockingSetupNotice, canActOnSetup, type SetupActor } from './setupAudience'

const admin: SetupActor = {
  fullSurface: true,
  canManageIntegrations: true,
  isAccountAdmin: false,
  accountsEnabled: true,
}
const member: SetupActor = { ...admin, canManageIntegrations: false }
const designerAdmin: SetupActor = { ...admin, fullSurface: false }

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

  it('falls back to the workspace admin when an older backend reports no owner', () => {
    expect(canActOnSetup(undefined, admin)).toBe(true)
    expect(canActOnSetup(undefined, member)).toBe(false)
  })
})

describe('blockingSetupNotice', () => {
  it('tells a member that agents cannot run, and who can fix it', () => {
    expect(blockingSetupNotice(status({ agentExecutor: 'not_defined' }), owners, member)).toEqual({
      area: 'agentExecutor',
      kind: 'setup',
      owner: 'workspace_admin',
    })
  })

  it('reports an executor outage as an outage', () => {
    expect(
      blockingSetupNotice(status({ agentExecutor: 'unreachable' }), owners, member)?.kind,
    ).toBe('outage')
  })

  it('says nothing to the admin, who gets the full card instead', () => {
    expect(blockingSetupNotice(status({ agentExecutor: 'not_defined' }), owners, admin)).toBeNull()
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

  it('names the workspace admin when an older backend reports no owners', () => {
    expect(blockingSetupNotice(status({ agentExecutor: 'not_defined' }), null, member)?.owner).toBe(
      'workspace_admin',
    )
  })
})
