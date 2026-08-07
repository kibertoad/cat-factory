import { describe, expect, it } from 'vitest'
import * as kernel from './index.js'
import * as seed from './domain/seed.js'

// The kernel half of the extension-surface guard. The three facades re-export kernel's built-in
// pipeline ids so a deployment can pin a shipped pipeline without restating a string the platform
// owns (`registry-seams.spec.ts` on Node/local, `extension-surface.test.ts` on the Worker, each
// deriving its expectation from kernel's index). All three of those are only as complete as the
// index they derive from, which is where this one comes in: two ids reached the module that DEFINES
// them and never the index, so every facade agreed on a surface that was short by two.

describe('kernel public surface', () => {
  it('re-exports every built-in pipeline id the seed module defines', () => {
    // Derived from the defining module rather than pinned to a count. A count says "16" and fails on
    // the next ordinary addition, naming nothing about what broke and teaching the next reader to
    // re-pin it unread; this names the missing id.
    const defined = Object.keys(seed).filter((name) => name.endsWith('_PIPELINE_ID'))
    expect(defined.length).toBeGreaterThan(0)
    const exported = new Set(Object.keys(kernel))
    expect(defined.filter((name) => !exported.has(name))).toEqual([])
  })
})
