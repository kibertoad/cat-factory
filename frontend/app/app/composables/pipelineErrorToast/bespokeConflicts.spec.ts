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
  canWriteBoard: true,
  isAccountAdmin: false,
  accountsEnabled: true,
}
const member: SetupActor = { ...admin, canManageIntegrations: false }
const viewer: SetupActor = { ...member, canExecuteRuns: false, canWriteBoard: false }
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
    openModelConfig: vi.fn<() => void>(),
    openSourceControl: vi.fn<() => void>(),
    openServiceEnvironment:
      vi.fn<(frameId: string | undefined, type: string | undefined, wizard: boolean) => void>(),
  }
}
let remedies: ReturnType<typeof fakeRemedies>
const copied: string[] = []
const COPY = 'common.copyDetails'

beforeEach(() => {
  add = vi.fn()
  remedies = fakeRemedies()
  copied.length = 0
})

/** The action labels, so a test reads "fix plus copy" or "copy alone". */
function labels(toast: { actions: { label: string }[] }): string[] {
  return toast.actions.map((action) => action.label)
}

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
    copyAction: (text: string) => ({
      label: COPY,
      icon: 'i-lucide-clipboard',
      onClick: () => void copied.push(text),
    }),
    report: (_conflict, title, description) => `${title}\n${description}\nreq-1`,
  })
  const conflict: ParsedConflict = { reason, requestId: 'req-1', details: { reason, ...details } }
  const handled = presentBespoke(conflict)
  return { handled, toast: add.mock.calls[0]?.[0] }
}

describe('bespoke setup conflict toasts', () => {
  it('gives a board admin the AI setup fix for providers_unconfigured', () => {
    const { handled, toast } = present(admin, 'providers_unconfigured', { models: ['gpt-x'] })
    expect(handled).toBe(true)
    expect(toast.description).toBe('errors.conflict.providersUnconfigured.body')
    expect(labels(toast)).toHaveLength(2)
    toast.actions[0].onClick()
    expect(remedies.openModelSetup).toHaveBeenCalledOnce()
  })

  it('gives a member no fix and names the board admin', () => {
    const { toast } = present(member, 'providers_unconfigured', { models: ['gpt-x'] })
    expect(labels(toast)).toEqual([COPY])
    expect(toast.description).toBe(
      'errors.conflict.providersUnconfigured.body layout.infraSetupNotice.owner.workspace_admin',
    )
    // Still sticky: the line naming who can fix it is the thing to read.
    expect(toast.duration).toBe(0)
    // And copyable, with the request id, so the member can hand it to that admin.
    toast.actions[0].onClick()
    expect(copied.at(-1)).toContain('layout.infraSetupNotice.owner.workspace_admin')
    expect(copied.at(-1)).toContain('req-1')
  })

  it('gives a viewer the same named owner, never the fix', () => {
    const { toast } = present(viewer, 'provision_type_unhandled', { provisionType: 'kubernetes' })
    expect(labels(toast)).toEqual([COPY])
    expect(toast.description).toContain('layout.infraSetupNotice.owner.workspace_admin')
  })

  it('tells an admin on the designer surface to switch surface instead of finding an admin', () => {
    const { toast } = present(designerAdmin, 'deployer_connection_test_failed', { detail: 'x' })
    expect(labels(toast)).toEqual([COPY])
    expect(toast.description).toContain('layout.infraSetupNotice.fullSurface')
  })

  it('follows the reported owner: account-owned storage is not the board admin to fix', () => {
    const asBoardAdmin = present(admin, 'binary_storage_unconfigured').toast
    expect(labels(asBoardAdmin)).toEqual([COPY])
    expect(asBoardAdmin.description).toContain('layout.infraSetupNotice.owner.account_admin')

    add.mockClear()
    const asAccountAdmin = present(
      { ...member, isAccountAdmin: true },
      'binary_storage_unconfigured',
    ).toast
    expect(labels(asAccountAdmin)).toHaveLength(2)
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
    expect(labels(toast)).toEqual([COPY])
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

  it('opens the compose wizard for a board admin', () => {
    const { toast } = present(admin, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'docker-compose',
      missing: ['composePath'],
    })
    toast.actions[0].onClick()
    expect(remedies.openServiceEnvironment).toHaveBeenCalledWith('frame-1', 'docker-compose', true)
  })

  it('gives a member the inspector fix for a docker-compose service, a block edit', () => {
    const { toast } = present(member, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'docker-compose',
      missing: ['composePath'],
    })
    expect(toast.description).toBe('errors.conflict.deployerServiceConfig.body')
    expect(labels(toast)).toHaveLength(2)
    toast.actions[0].onClick()
    expect(remedies.openServiceEnvironment).toHaveBeenCalledWith('frame-1', 'docker-compose', false)
  })

  it('gives a member the inspector fix for a non-compose service', () => {
    const { toast } = present(member, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'kubernetes',
      missing: ['namespace'],
    })
    toast.actions[0].onClick()
    expect(remedies.openServiceEnvironment).toHaveBeenCalledWith('frame-1', 'kubernetes', false)
  })

  it('names the board admin to a viewer, who cannot save a block edit', () => {
    const { toast } = present(viewer, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'kubernetes',
    })
    expect(labels(toast)).toEqual([COPY])
    expect(toast.description).toContain('layout.infraSetupNotice.owner.workspace_admin')
  })

  it('tells the designer surface to switch for a service config gap', () => {
    const { toast } = present(designerAdmin, 'deployer_service_provisioning_incomplete', {
      frameId: 'frame-1',
      provisionType: 'kubernetes',
    })
    expect(labels(toast)).toEqual([COPY])
    expect(toast.description).toContain('layout.infraSetupNotice.fullSurface')
  })

  it('keeps a service config gap with no frame on the board admin, whatever owns environments', () => {
    const operatorEnvironments = { ...owners, ephemeralEnvironments: 'operator' as const }
    const asMember = present(
      member,
      'deployer_service_provisioning_incomplete',
      { provisionType: 'kubernetes' },
      operatorEnvironments,
    ).toast
    expect(labels(asMember)).toEqual([COPY])
    expect(asMember.description).toContain('layout.infraSetupNotice.owner.workspace_admin')

    add.mockClear()
    const asAdmin = present(
      admin,
      'deployer_service_provisioning_incomplete',
      { provisionType: 'kubernetes' },
      operatorEnvironments,
    ).toast
    asAdmin.actions[0].onClick()
    expect(remedies.openServiceEnvironment).toHaveBeenCalledWith(undefined, 'kubernetes', true)
  })

  it('leaves a reason that is not a setup gap to the generic map', () => {
    expect(present(admin, 'dependencies_unmet').handled).toBe(false)
    expect(add).not.toHaveBeenCalled()
  })
})
