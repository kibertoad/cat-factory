import { describe, expect, it, vi } from 'vitest'
import type { SetupActor } from './setupAudience'
import { MODEL_SETUP_FIX, RUNNER_POOL_FIX, gateSetupFix, type SetupRemedies } from './setupFixes'

const admin: SetupActor = {
  fullSurface: true,
  canManageIntegrations: true,
  canExecuteRuns: true,
  canWriteBoard: true,
  isAccountAdmin: false,
  accountsEnabled: true,
}
const member: SetupActor = { ...admin, canManageIntegrations: false }

function remedies(): SetupRemedies {
  return {
    openInfraArea: vi.fn(),
    openModelSetup: vi.fn(),
    openModelConfig: vi.fn(),
    openSourceControl: vi.fn(),
    openServiceEnvironment: vi.fn(),
  }
}

describe('gateSetupFix', () => {
  it('gives a caller who can save the setting the button, which opens its screen', () => {
    const opened = remedies()
    const gated = gateSetupFix(
      MODEL_SETUP_FIX,
      { actor: admin, owners: null },
      { remedies: () => opened },
    )
    expect(gated.remedy).toBeNull()
    if (gated.remedy === null) gated.run()
    expect(opened.openModelSetup).toHaveBeenCalledOnce()
  })

  it('gives a caller who cannot save the setting the owner to name, and no button', () => {
    const gated = gateSetupFix(
      MODEL_SETUP_FIX,
      { actor: member, owners: null },
      { remedies: remedies },
    )
    expect(gated).toEqual({ remedy: 'workspace_admin' })
  })

  it('reads the owner the server reports for an infrastructure area', () => {
    const gated = gateSetupFix(
      RUNNER_POOL_FIX,
      {
        actor: admin,
        owners: {
          agentExecutor: 'operator',
          ephemeralEnvironments: 'workspace_admin',
          binaryStorage: 'account_admin',
        },
      },
      { remedies: remedies },
    )
    expect(gated).toEqual({ remedy: 'operator' })
  })
})
