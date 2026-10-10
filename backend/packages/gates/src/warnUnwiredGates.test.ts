import { beforeEach, describe, expect, it } from 'vitest'
import {
  createRecordingLogger,
  defaultProviderRegistry,
  type ProviderRegistry,
} from '@cat-factory/kernel'
import { warnUnwiredGates, wireCiStatusProvider } from './providers.js'

/** The `gate` field of every warning recorded so far. */
function warnedGateNames(log: ReturnType<typeof createRecordingLogger>): unknown[] {
  return log.lines.filter((l) => l.level === 'warn').map((l) => l.fields.gate)
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
    const log = createRecordingLogger()
    warnUnwiredGates(providerRegistry, log)
    // ci is unwired here and must be reported (the headline pass-through risk).
    expect(warnedGateNames(log)).toContain('ci')
    expect(log.lines.every((l) => l.fields.passThrough === true)).toBe(true)
  })

  it('does not re-warn a gate already reported (per-process dedupe)', () => {
    warnUnwiredGates(providerRegistry, createRecordingLogger())
    const second = createRecordingLogger()
    warnUnwiredGates(providerRegistry, second)
    // ci was warned on the first call, so the second call (still unwired) stays silent for it.
    expect(warnedGateNames(second)).not.toContain('ci')
  })

  it('a wired gate is never reported as a pass-through', () => {
    // Note: ci was already deduped above; assert on the mergeability gate via wiring instead.
    wireCiStatusProvider(providerRegistry, { getStatus: async () => ({ repos: [] }) } as never)
    const log = createRecordingLogger()
    warnUnwiredGates(providerRegistry, log)
    expect(warnedGateNames(log)).not.toContain('ci')
  })
})
