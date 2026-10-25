import { describe, expect, it } from 'vitest'
import { GateRegistry, ValidationError, type GateFactory } from '@cat-factory/kernel'
import type { DescriptorField } from '@cat-factory/contracts'
import { validatePipelineShape } from './pipelineShape.js'

// A gate's own parameters are judged with the gate's declared DEFAULTS folded in, the same filled
// bag the run freezes onto the gate. A default answers a `required` field the author left empty; a
// required field with neither a value nor a default is an unanswered form and is refused, even
// when the step carries no gate configuration at all.

const factory = (() => ({})) as unknown as GateFactory

function registryWith(configFields: DescriptorField[]): GateRegistry {
  const registry = new GateRegistry()
  registry.register('soak-gate', factory, { configFields })
  return registry
}

function refusal(fn: () => void): ValidationError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ValidationError) return error
    throw error
  }
  throw new Error('expected a ValidationError')
}

describe('validatePipelineShape: gate parameter defaults and required fields', () => {
  const required: DescriptorField = {
    key: 'channel',
    label: 'Channel',
    type: 'text',
    required: true,
  }

  it('accepts a required parameter left empty when the gate declares its default', () => {
    expect(() =>
      validatePipelineShape({
        agentKinds: ['coder', 'soak-gate'],
        gateRegistry: registryWith([{ ...required, default: '#ops' }]),
      }),
    ).not.toThrow()
  })

  it('refuses a required parameter with no value and no default, naming the reason', () => {
    const error = refusal(() =>
      validatePipelineShape({
        agentKinds: ['coder', 'soak-gate'],
        stepOptions: [null, { gateConfig: { fields: {} } }],
        gateRegistry: registryWith([required]),
      }),
    )
    expect(error.message).toMatch(/Step 'soak-gate' has invalid gate parameters/)
    expect(error.details).toMatchObject({ reason: 'gate_config_fields_invalid' })
  })

  it('refuses it when the step carries no gate configuration at all', () => {
    const error = refusal(() =>
      validatePipelineShape({
        agentKinds: ['coder', 'soak-gate'],
        gateRegistry: registryWith([required]),
      }),
    )
    expect(error.details).toMatchObject({ reason: 'gate_config_fields_invalid' })
  })

  it('accepts the required parameter once the step supplies it', () => {
    expect(() =>
      validatePipelineShape({
        agentKinds: ['coder', 'soak-gate'],
        stepOptions: [null, { gateConfig: { fields: { channel: '#release' } } }],
        gateRegistry: registryWith([required]),
      }),
    ).not.toThrow()
  })

  it('leaves a disabled gate step alone', () => {
    expect(() =>
      validatePipelineShape({
        agentKinds: ['coder', 'soak-gate'],
        enabled: [true, false],
        gateRegistry: registryWith([required]),
      }),
    ).not.toThrow()
  })
})
