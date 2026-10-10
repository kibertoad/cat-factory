import { HARNESS_JOB_PORT } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_PORT } from '../src/harness-port.js'

// The deploy image builds from `src/` plus typescript alone, so it can carry no runtime
// dependency on a workspace package and states its port itself. The transports do not know the
// two images apart when they address one: the Cloudflare container base class hands both the same
// `defaultPort`, and the local runtime publishes the same in-container port for both. So a deploy
// harness that kept its own number would simply stop answering, with the dispatch reporting a
// container that never became ready rather than a port that moved.
//
// This is a `test/**`-only file, so it ships with NO runner-image bump.

describe('deploy harness ⇄ backend job port', () => {
  it('binds the port every transport dispatches to', () => {
    expect(DEFAULT_HARNESS_PORT).toBe(HARNESS_JOB_PORT)
  })
})
