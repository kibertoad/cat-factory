import type { DescriptorFieldValues } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  CI_GATE_CONFIG_FIELDS,
  CONFLICTS_GATE_CONFIG_FIELDS,
  DOC_QUALITY_GATE_CONFIG_FIELDS,
  HUMAN_REVIEW_GATE_CONFIG_FIELDS,
  POST_RELEASE_HEALTH_GATE_CONFIG_FIELDS,
  gateConfigNumber,
} from './gateConfigFields.js'
import { gateRegistryWithBuiltins } from './index.js'

const config = (values: Record<string, unknown>) => values as DescriptorFieldValues

describe('gateConfigNumber', () => {
  it('reads a declared numeric parameter off the step config', () => {
    expect(gateConfigNumber(config({ maxAttempts: 3 }), 'maxAttempts')).toBe(3)
    // 0 is a real value ("never escalate"), not an absent one.
    expect(gateConfigNumber(config({ maxAttempts: 0 }), 'maxAttempts')).toBe(0)
  })

  it('reports an unset parameter, an absent config and a missing key alike as absent', () => {
    expect(gateConfigNumber(config({}), 'maxAttempts')).toBeUndefined()
    expect(gateConfigNumber(null, 'maxAttempts')).toBeUndefined()
    expect(gateConfigNumber(undefined, 'maxAttempts')).toBeUndefined()
    expect(gateConfigNumber(config({ graceMinutes: 5 }), 'maxAttempts')).toBeUndefined()
  })

  it('treats anything that is not a finite number as absent', () => {
    // Neither door can store these (both validate against the same declaration), but a
    // hand-edited row must not turn into a NaN deep inside a poll loop.
    expect(gateConfigNumber(config({ maxAttempts: '3' }), 'maxAttempts')).toBeUndefined()
    expect(gateConfigNumber(config({ maxAttempts: Number.NaN }), 'maxAttempts')).toBeUndefined()
    expect(
      gateConfigNumber(config({ maxAttempts: Number.POSITIVE_INFINITY }), 'maxAttempts'),
    ).toBeUndefined()
    expect(gateConfigNumber(config({ maxAttempts: true }), 'maxAttempts')).toBeUndefined()
    expect(gateConfigNumber(config({ maxAttempts: null }), 'maxAttempts')).toBeUndefined()
  })

  it('does NOT clamp to the declared bounds', () => {
    // The bound is enforced where the value is frozen. A reader that silently corrected it
    // would run a budget nobody configured and hide the misconfiguration from whoever could
    // fix it.
    const declared = CI_GATE_CONFIG_FIELDS.find((f) => f.key === 'maxAttempts')
    expect(declared?.max).toBeDefined()
    const beyond = (declared?.max ?? 0) + 5
    expect(gateConfigNumber(config({ maxAttempts: beyond }), 'maxAttempts')).toBe(beyond)
    expect(gateConfigNumber(config({ maxAttempts: -1 }), 'maxAttempts')).toBe(-1)
  })
})

describe('the built-in gates’ declared parameters', () => {
  const keys = (fields: readonly { key: string }[]) => fields.map((f) => f.key).sort()

  it('declares an attempt budget on every gate that can give up', () => {
    expect(keys(CI_GATE_CONFIG_FIELDS)).toEqual(['maxAttempts'])
    expect(keys(CONFLICTS_GATE_CONFIG_FIELDS)).toEqual(['maxAttempts'])
    expect(keys(DOC_QUALITY_GATE_CONFIG_FIELDS)).toEqual(['maxAttempts'])
    expect(keys(POST_RELEASE_HEALTH_GATE_CONFIG_FIELDS)).toEqual([
      'maxAttempts',
      'watchWindowMinutes',
    ])
  })

  it('declares NO attempt budget on the human-review gate', () => {
    // The gate waits for a person indefinitely by design, so a per-step cap would be a
    // deadline on a human review that nothing else in the gate expects.
    expect(keys(HUMAN_REVIEW_GATE_CONFIG_FIELDS)).toEqual(['graceMinutes'])
  })

  it('registers each gate WITH its declared fields, so the form and the reader cannot disagree', () => {
    // The registration is where the authoring form reads them from: a gate registered without
    // its fields renders no form at all, silently, while its reader keeps looking for values.
    const registry = gateRegistryWithBuiltins()
    const declared: Record<string, readonly { key: string }[]> = {
      ci: CI_GATE_CONFIG_FIELDS,
      conflicts: CONFLICTS_GATE_CONFIG_FIELDS,
      'doc-quality': DOC_QUALITY_GATE_CONFIG_FIELDS,
      'post-release-health': POST_RELEASE_HEALTH_GATE_CONFIG_FIELDS,
      'human-review': HUMAN_REVIEW_GATE_CONFIG_FIELDS,
    }
    for (const { kind } of registry.factories()) {
      expect(registry.configFields(kind)).toBe(declared[kind])
    }
    // Every registered gate is accounted for above, so a new one cannot slip through unchecked.
    expect(
      registry
        .factories()
        .map((g) => g.kind)
        .sort(),
    ).toEqual(Object.keys(declared).sort())
  })

  it('gives every declared numeric field a usable range', () => {
    for (const fields of [
      CI_GATE_CONFIG_FIELDS,
      CONFLICTS_GATE_CONFIG_FIELDS,
      DOC_QUALITY_GATE_CONFIG_FIELDS,
      POST_RELEASE_HEALTH_GATE_CONFIG_FIELDS,
      HUMAN_REVIEW_GATE_CONFIG_FIELDS,
    ]) {
      for (const field of fields) {
        expect(field.type).toBe('number')
        expect(field.min).toBeDefined()
        expect(field.max).toBeGreaterThan(field.min ?? 0)
        expect(field.label.length).toBeGreaterThan(0)
        expect(field.help?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })
})
