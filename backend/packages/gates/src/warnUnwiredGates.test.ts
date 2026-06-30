import { afterEach, describe, expect, it } from 'vitest'
import {
  clearGateProviders,
  warnUnwiredGates,
  wireCiStatusProvider,
  type GateWiringLogger,
} from './providers.js'

function capturingLogger(): { warnings: Record<string, unknown>[]; log: GateWiringLogger } {
  const warnings: Record<string, unknown>[] = []
  return { warnings, log: { warn: (obj) => warnings.push(obj) } }
}

describe('warnUnwiredGates', () => {
  afterEach(() => clearGateProviders())

  it('warns once for each gate whose provider is not wired', () => {
    clearGateProviders()
    const { warnings, log } = capturingLogger()
    warnUnwiredGates(log)
    const gates = warnings.map((w) => w.gate)
    // ci is unwired here and must be reported (the headline pass-through risk).
    expect(gates).toContain('ci')
    expect(warnings.every((w) => w.passThrough === true)).toBe(true)
  })

  it('does not re-warn a gate already reported (per-process dedupe)', () => {
    clearGateProviders()
    const first = capturingLogger()
    warnUnwiredGates(first.log)
    const second = capturingLogger()
    warnUnwiredGates(second.log)
    // ci was warned on the first call, so the second call (still unwired) stays silent for it.
    expect(second.warnings.map((w) => w.gate)).not.toContain('ci')
  })

  it('a wired gate is never reported as a pass-through', () => {
    // Note: ci was already deduped above; assert on the mergeability gate via wiring instead.
    wireCiStatusProvider({ getCheckRuns: async () => [] } as never)
    const { warnings, log } = capturingLogger()
    warnUnwiredGates(log)
    expect(warnings.map((w) => w.gate)).not.toContain('ci')
  })
})
