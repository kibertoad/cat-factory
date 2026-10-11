import { describe, expect, it } from 'vitest'
import type { InfraSetup } from '@cat-factory/contracts'
import { deriveSetupChecklist, type SetupProbeInput } from '~/utils/setupChecklist'

// The checklist adds no probe of its own; what it owes is to state each probe's answer without
// changing its meaning. Two rules matter most: an unanswered probe is never "missing", and a
// broken setup is never "missing" either (that would send the reader to create a second one).

const ALL_CONFIGURED: InfraSetup = {
  agentExecutor: 'configured',
  ephemeralEnvironments: 'configured',
  binaryStorage: 'configured',
}

function input(overrides: Partial<SetupProbeInput> = {}): SetupProbeInput {
  return {
    model: { loaded: true, usable: true, presetBroken: false },
    sourceControl: {
      available: true,
      connected: true,
      patMissing: false,
      patNeedsAttention: false,
    },
    infra: ALL_CONFIGURED,
    needingConfig: [],
    ...overrides,
  }
}

function status(i: SetupProbeInput, id: string) {
  return deriveSetupChecklist(i).rows.find((r) => r.id === id)?.status
}

describe('deriveSetupChecklist', () => {
  it('reports a fully set-up workspace as done and not blocking', () => {
    const c = deriveSetupChecklist(input())
    expect(c.done).toBe(c.total)
    expect(c.blocking).toBe(false)
  })

  it('reports an unanswered probe as checking, never as missing', () => {
    const c = deriveSetupChecklist(
      input({
        model: { loaded: false, usable: false, presetBroken: false },
        sourceControl: {
          available: null,
          connected: false,
          patMissing: false,
          patNeedsAttention: false,
        },
        infra: null,
      }),
    )
    expect(c.rows.every((r) => r.status === 'checking')).toBe(true)
    expect(c.blocking).toBe(false)
  })

  it('tells a broken setup from an absent one', () => {
    expect(
      status(
        input({ infra: { ...ALL_CONFIGURED, agentExecutor: 'unreachable' } }),
        'agentExecutor',
      ),
    ).toBe('attention')
    expect(status(input({ needingConfig: ['runner-pool'] }), 'agentExecutor')).toBe('attention')
    expect(
      status(
        input({ infra: { ...ALL_CONFIGURED, agentExecutor: 'not_defined' } }),
        'agentExecutor',
      ),
    ).toBe('missing')
    expect(
      status(input({ model: { loaded: true, usable: true, presetBroken: true } }), 'model'),
    ).toBe('attention')
  })

  it('blocks on a required row only; an optional gap switches agents off but runs tasks', () => {
    expect(
      deriveSetupChecklist(input({ infra: { ...ALL_CONFIGURED, binaryStorage: 'not_defined' } }))
        .blocking,
    ).toBe(false)
    expect(
      deriveSetupChecklist(
        input({
          sourceControl: {
            available: true,
            connected: false,
            patMissing: true,
            patNeedsAttention: false,
          },
        }),
      ).blocking,
    ).toBe(true)
  })

  it('leaves an area the deployment does not use out of the count', () => {
    const c = deriveSetupChecklist(
      input({ infra: { ...ALL_CONFIGURED, ephemeralEnvironments: 'not_applicable' } }),
    )
    expect(c.total).toBe(c.rows.length - 1)
    expect(c.done).toBe(c.total)
  })
})
