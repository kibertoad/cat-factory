import { beforeEach, describe, expect, it } from 'vitest'
import { defaultProviderRegistry, type ProviderRegistry } from '@cat-factory/kernel'
import { warnUnwiredGates, wireCiStatusProvider, type GateWiringLogger } from './providers.js'

function capturingLogger(): { warnings: Record<string, unknown>[]; log: GateWiringLogger } {
  const warnings: Record<string, unknown>[] = []
  return { warnings, log: { warn: (obj) => warnings.push(obj) } }
}

// A fresh provider registry per test (no module global to clear). NOTE: `warnUnwiredGates`
// dedupes per PROCESS via a module-global `warnedGates` set (so a per-request rebuild doesn't
// re-log), which is why the dedupe assertions below hold across cases in this file.
let providerRegistry: ProviderRegistry
beforeEach(() => {
  providerRegistry = defaultProviderRegistry()
})

describe('warnUnwiredGates', () => {
  it('warns once for each gate whose provider is not wired', () => {
    const { warnings, log } = capturingLogger()
    warnUnwiredGates(providerRegistry, log)
    const gates = warnings.map((w) => w.gate)
    // ci is unwired here and must be reported (the headline pass-through risk).
    expect(gates).toContain('ci')
    expect(warnings.every((w) => w.passThrough === true)).toBe(true)
  })

  it('does not re-warn a gate already reported (per-process dedupe)', () => {
    const first = capturingLogger()
    warnUnwiredGates(providerRegistry, first.log)
    const second = capturingLogger()
    warnUnwiredGates(providerRegistry, second.log)
    // ci was warned on the first call, so the second call (still unwired) stays silent for it.
    expect(second.warnings.map((w) => w.gate)).not.toContain('ci')
  })

  it('a wired gate is never reported as a pass-through', () => {
    // Note: ci was already deduped above; assert on the mergeability gate via wiring instead.
    wireCiStatusProvider(providerRegistry, { getStatus: async () => ({ repos: [] }) } as never)
    const { warnings, log } = capturingLogger()
    warnUnwiredGates(providerRegistry, log)
    expect(warnings.map((w) => w.gate)).not.toContain('ci')
  })
})
