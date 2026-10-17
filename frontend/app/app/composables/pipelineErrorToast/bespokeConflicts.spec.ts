import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedConflict } from '~/composables/usePipelineErrorToast'
import type { InfraSetupArea, InfraSetupOwners } from '~/types/domain'
import type { SetupActor } from '~/utils/setupAudience'
import { createBespokeConflictToasts } from './bespokeConflicts'

/**
 * Who gets the fix button on a run-start setup conflict. The rule is the setup cards' rule
 * (`utils/setupAudience.ts`): a caller who can act gets the action, everyone else gets the toast
 * with one sentence naming who can fix it, and no button that opens a screen their save is refused
 * on. `t` echoes the key, so the assertions name keys, never English.
 */

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

const owners: InfraSetupOwners = {
  agentExecutor: 'workspace_admin',
  ephemeralEnvironments: 'workspace_admin',
  binaryStorage: 'account_admin',
}

let add: ReturnType<typeof vi.fn>
function fakeRemedies() {
  return {
    openInfraArea: vi.fn<(area: InfraSetupArea) => void>(),
    openModelSetup: vi.fn<() => void>(),
    openServiceEnvironment: vi.fn<(frameId?: string, provisionType?: string) => void>(),
  }
}
let remedies: ReturnType<typeof fakeRemedies>

beforeEach(() => {
  add = vi.fn()
  remedies = fakeRemedies()
})

function present(
  actor: SetupActor,
  reason: string,
  details: Record<string, unknown> = {},
  setupOwners: InfraSetupOwners | null = owners,
) {
  const presentBespoke = createBespokeConflictToasts({
    toast: { add } as unknown as ReturnType<typeof useToast>,
    t: ((key: string) => key) as ReturnType<typeof useI18n>['t'],
    te: (() => true) as ReturnType<typeof useI18n>['te'],
    audience: () => ({ actor, owners: setupOwners }),
    remedies: () => remedies,
  })
  const conflict: ParsedConflict = { reason, details: { reason, ...details } }
  const handled = presentBespoke(conflict)
  return { handled, toast: add.mock.calls[0]?.[0] }
}

describe('bespoke setup conflict toasts', () => {
  it('gives a board admin the AI setup fix for providers_unconfigured', () => {
    const { handled, toast } = present(admin, 'providers_unconfigured', { models: ['gpt-x'] })
    expect(handled).toBe(true)
    expect(toast.description).toBe('errors.conflict.providersUnconfigured.body')
    expect(toast.actions).toHaveLength(1)
    toast.actions[0].onClick()
    expect(remedies.openModelSetup).toHaveBeenCalledOnce()
  })

  it('gives a member no fix and names the board admin', () => {
    const { toast } = present(member, 'providers_unconfigured', { models: ['gpt-x'] })
    expect(toast.actions).toEqual([])
    expect(toast.description).toBe(
      'errors.conflict.providersUnconfigured.body layout.infraSetupNotice.owner.workspace_admin',
    )
    // Still sticky: the line naming who can fix it is the thing to read.
    expect(toast.duration).toBe(0)
  })

  it('gives a viewer the same named owner, never the fix', () => {
    const { toast } = present(viewer, 'provision_type_unhandled', { provisionType: 'kubernetes' })
    expect(toast.actions).toEqual([])
    expect(toast.description).toContain('layout.infraSetupNotice.owner.workspace_admin')
  })

  it('tells an admin on the designer surface to switch surface instead of finding an admin', () => {
    const { toast } = present(designerAdmin, 'deployer_connection_test_failed', { detail: 'x' })
    expect(toast.actions).toEqual([])
    expect(toast.description).toContain('layout.infraSetupNotice.fullSurface')
  })

  it('follows the reported owner: account-owned storage is not the board admin to fix', () => {
    const asBoardAdmin = present(admin, 'binary_storage_unconfigured').toast
    expect(asBoardAdmin.actions).toEqual([])
    expect(asBoardAdmin.description).toContain('layout.infraSetupNotice.owner.account_admin')

    add.mockClear()
    const asAccountAdmin = present(
      { ...member, isAccountAdmin: true },
      'binary_storage_unconfigured',
    ).toast
    expect(asAccountAdmin.actions).toHaveLength(1)
    asAccountAdmin.actions[0].onClick()
    expect(remedies.openInfraArea).toHaveBeenCalledWith('binaryStorage')
  })

  it('names the operator, and offers nobody the fix, for an operator-owned environment gap', () => {
    const { toast } = present(
      admin,
      'provision_type_unhandled',
      {},
      {
        ...owners,
        ephemeralEnvironments: 'operator',
      },
    )
    expect(toast.actions).toEqual([])
    expect(toast.description).toContain('layout.infraSetupNotice.owner.operator')
  })

  it('treats an older backend that reports no owners as the board admin', () => {
    expect(present(member, 'provision_type_unhandled', {}, null).toast.description).toContain(
      'layout.infraSetupNotice.owner.workspace_admin',
    )
    add.mockClear()
    const { toast } = present(admin, 'provision_type_unhandled', {}, null)
    toast.actions[0].onClick()
    expect(remedies.openInfraArea).toHaveBeenCalledWith('ephemeralEnvironments')
  })

  it('opens the service environment config through the remedies for a board admin', () => {
    const { toast } = present(admin, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'docker-compose',
      missing: ['recipe'],
    })
    toast.actions[0].onClick()
    expect(remedies.openServiceEnvironment).toHaveBeenCalledWith('frame-1', 'docker-compose')
  })

  it('gives a member the fix for a non-compose service, which the inspector saves', () => {
    const { toast } = present(member, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'kubernetes',
      missing: ['namespace'],
    })
    expect(toast.description).toBe('errors.conflict.deployerServiceConfig.body')
    expect(toast.actions).toHaveLength(1)
    toast.actions[0].onClick()
    expect(remedies.openServiceEnvironment).toHaveBeenCalledWith('frame-1', 'kubernetes')
  })

  it('tells the designer surface to switch for a non-compose service', () => {
    const { toast } = present(designerAdmin, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'kubernetes',
    })
    expect(toast.actions).toEqual([])
    expect(toast.description).toContain('layout.infraSetupNotice.fullSurface')
  })

  it('keeps the docker-compose fix from a member: the wizard registers a workspace handler', () => {
    const { toast } = present(member, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'docker-compose',
    })
    expect(toast.actions).toEqual([])
    expect(toast.description).toContain('layout.infraSetupNotice.owner.workspace_admin')
  })

  it('names the operator for a service config with no frame and operator-owned environments', () => {
    const { toast } = present(
      admin,
      'deployer_service_provisioning_incomplete',
      { provisionType: 'kubernetes' },
      { ...owners, ephemeralEnvironments: 'operator' },
    )
    expect(toast.actions).toEqual([])
    expect(toast.description).toContain('layout.infraSetupNotice.owner.operator')
  })

  it('leaves a reason that is not a setup gap to the generic map', () => {
    expect(present(admin, 'dependencies_unmet').handled).toBe(false)
    expect(add).not.toHaveBeenCalled()
  })
})
