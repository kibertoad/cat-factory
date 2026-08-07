import { describe, expect, it } from 'vitest'
import { resolveWritebackFlag } from './writeback.js'

// Three-state resolution collapsed to a boolean: the per-task override, when set, always wins,
// and only an ABSENT override inherits the workspace setting. Both directions of the override
// matter. `off` on a workspace that writes back is how a single task is kept out of a customer's
// ticket, and `on` is how one task writes back on a workspace that otherwise does not.

describe('resolveWritebackFlag', () => {
  it('lets an `on` override enable writeback on a workspace that has it off', () => {
    expect(resolveWritebackFlag(false, 'on')).toBe(true)
  })

  it('lets an `off` override disable writeback on a workspace that has it on', () => {
    expect(resolveWritebackFlag(true, 'off')).toBe(false)
  })

  it('keeps the override winning even when it AGREES with the workspace', () => {
    expect(resolveWritebackFlag(true, 'on')).toBe(true)
    expect(resolveWritebackFlag(false, 'off')).toBe(false)
  })

  it('inherits the workspace setting when no override is set', () => {
    for (const override of [null, undefined] as const) {
      expect(resolveWritebackFlag(true, override)).toBe(true)
      expect(resolveWritebackFlag(false, override)).toBe(false)
    }
  })
})
