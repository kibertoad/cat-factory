import { describe, expect, it } from 'vitest'
import type { InfraSetup } from '@cat-factory/contracts'
import { deriveSetupChecklist, type SetupProbeInput } from '~/utils/setupChecklist'
import type { SetupActor } from '~/utils/setupAudience'

// The checklist adds no probe of its own; what it owes is to state each probe's answer without
// changing its meaning. Three rules matter most: an unanswered probe is never "missing" or
// "done", a broken setup is never "missing" (that would send the reader to create a second one),
// and a row only offers its action to someone whose save would land.

const ALL_CONFIGURED: InfraSetup = {
  agentExecutor: 'configured',
  ephemeralEnvironments: 'configured',
  binaryStorage: 'configured',
}

const ADMIN: SetupActor = {
  fullSurface: true,
  canManageIntegrations: true,
  canExecuteRuns: true,
  canWriteBoard: true,
  isAccountAdmin: true,
  accountsEnabled: true,
}

const SOURCE_OK: SetupProbeInput['sourceControl'] = {
  available: true,
  unavailableCause: null,
  connected: true,
  patMissing: false,
  patProblem: null,
}

function input(overrides: Partial<SetupProbeInput> = {}): SetupProbeInput {
  return {
    model: { loaded: true, loadFailed: false, usable: true, presetBroken: false },
    sourceControl: SOURCE_OK,
    infra: ALL_CONFIGURED,
    workspaceLoaded: true,
    infraOwners: null,
    providers: { loaded: true, needingConfig: [] },
    actor: ADMIN,
    ...overrides,
  }
}

function row(i: SetupProbeInput, id: string) {
  const found = deriveSetupChecklist(i).rows.find((r) => r.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

describe('deriveSetupChecklist', () => {
  it('reports a fully set-up workspace as done, with nothing left checking', () => {
    const c = deriveSetupChecklist(input())
    expect(c.done).toBe(c.total)
    expect(c.checking).toBe(false)
  })

  it('reports an unanswered probe as checking, never as missing or done', () => {
    const c = deriveSetupChecklist(
      input({
        model: { loaded: false, loadFailed: false, usable: false, presetBroken: false },
        sourceControl: { ...SOURCE_OK, available: null, connected: false },
        infra: null,
        workspaceLoaded: false,
      }),
    )
    expect(c.rows.every((r) => r.status === 'checking')).toBe(true)
    expect(c.checking).toBe(true)
  })

  it('keeps a configured runner checking until the providers say whether it is complete', () => {
    const waiting = input({ providers: { loaded: false, needingConfig: [] } })
    expect(row(waiting, 'agentExecutor').status).toBe('checking')
    expect(deriveSetupChecklist(waiting).checking).toBe(true)
    // Storage has no provider connection, so it does not wait on them.
    expect(row(waiting, 'binaryStorage').status).toBe('done')
  })

  it('names the cause of each broken setup, and tells it from an absent one', () => {
    expect(
      row(input({ infra: { ...ALL_CONFIGURED, agentExecutor: 'unreachable' } }), 'agentExecutor'),
    ).toMatchObject({ status: 'attention', cause: 'unreachable' })
    expect(
      row(input({ providers: { loaded: true, needingConfig: ['runner-pool'] } }), 'agentExecutor'),
    ).toMatchObject({ status: 'attention', cause: 'incomplete' })
    expect(
      row(input({ infra: { ...ALL_CONFIGURED, agentExecutor: 'not_defined' } }), 'agentExecutor'),
    ).toMatchObject({ status: 'missing', cause: null })
    expect(
      row(
        input({ model: { loaded: true, loadFailed: false, usable: true, presetBroken: true } }),
        'model',
      ),
    ).toMatchObject({ status: 'attention', cause: 'presetBroken' })
    expect(
      row(input({ sourceControl: { ...SOURCE_OK, patProblem: 'rejected' } }), 'sourceControl'),
    ).toMatchObject({ status: 'attention', cause: 'rejected' })
  })

  it('states a failed probe as unanswered, never as an absent capability', () => {
    expect(
      row(
        input({ model: { loaded: false, loadFailed: true, usable: false, presetBroken: false } }),
        'model',
      ),
    ).toMatchObject({ status: 'attention', cause: 'probeFailed' })
    const failed = input({
      sourceControl: {
        ...SOURCE_OK,
        available: false,
        unavailableCause: 'failed',
        connected: false,
      },
    })
    expect(row(failed, 'sourceControl')).toMatchObject({
      status: 'attention',
      cause: 'probeFailed',
    })
    // A deployment that switched the integration off does not use it: no gap to close.
    const disabled = input({
      sourceControl: {
        ...SOURCE_OK,
        available: false,
        unavailableCause: 'disabled',
        connected: false,
      },
    })
    expect(row(disabled, 'sourceControl').status).toBe('not_needed')
  })

  it('says so when the loaded workspace does not report its infrastructure, never spins', () => {
    const i = input({ infra: null, workspaceLoaded: true })
    expect(row(i, 'agentExecutor')).toMatchObject({ status: 'attention', cause: 'notReported' })
    expect(deriveSetupChecklist(i).checking).toBe(false)
  })

  it('leaves an area the deployment does not use out of the count', () => {
    const c = deriveSetupChecklist(
      input({ infra: { ...ALL_CONFIGURED, ephemeralEnvironments: 'not_applicable' } }),
    )
    expect(c.total).toBe(c.rows.length - 1)
    expect(c.done).toBe(c.total)
  })

  describe('who can act on a row (the banners rule, `utils/setupAudience.ts`)', () => {
    const unconfigured: InfraSetup = {
      agentExecutor: 'not_defined',
      ephemeralEnvironments: 'not_defined',
      binaryStorage: 'not_defined',
    }

    it('offers a board admin who is not an account admin only the gaps they own', () => {
      const boardAdmin = { ...ADMIN, isAccountAdmin: false }
      const i = input({
        infra: unconfigured,
        infraOwners: {
          agentExecutor: 'workspace_admin',
          ephemeralEnvironments: 'operator',
          binaryStorage: 'account_admin',
        },
        actor: boardAdmin,
      })
      expect(row(i, 'agentExecutor').remedy).toBeNull()
      expect(row(i, 'ephemeralEnvironments').remedy).toBe('operator')
      expect(row(i, 'binaryStorage').remedy).toBe('account_admin')
    })

    it('tells someone on the designer surface they can fix it themselves', () => {
      const i = input({ infra: unconfigured, actor: { ...ADMIN, fullSurface: false } })
      expect(row(i, 'agentExecutor').remedy).toBe('full_surface')
    })

    it('gives every caller the token page for a personal access token', () => {
      const member = { ...ADMIN, canManageIntegrations: false, isAccountAdmin: false }
      const i = input({
        sourceControl: { ...SOURCE_OK, patMissing: true, connected: false },
        actor: member,
      })
      expect(row(i, 'sourceControl').remedy).toBeNull()
      expect(row(input({ actor: member }), 'model').remedy).toBe('workspace_admin')
    })
  })
})
