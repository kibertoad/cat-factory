import { describe, expect, it } from 'vitest'
import { describeProcessExit } from './process-exit.logic.js'

// The first fork in the road when diagnosing a dead agent run: an externally-killed job (an OOM
// kill, a `docker stop` racing teardown, a pool eviction) needs a different investigation from a
// CLI that gave up on its own. Rendering the `null` verbatim produces "exited with code null",
// which reads as neither.

describe('describeProcessExit', () => {
  it('reports the process’s own exit code when it exited of its own accord', () => {
    expect(describeProcessExit(1, null)).toBe('exited with code 1')
    expect(describeProcessExit(137, null)).toBe('exited with code 137')
  })

  it('reports a ZERO exit code as an exit, not as a signal kill', () => {
    // `0` is falsy, so a truthiness check here would send a clean exit down the killed-by branch.
    expect(describeProcessExit(0, null)).toBe('exited with code 0')
  })

  it('names the signal when a null code says the process did not exit on its own', () => {
    expect(describeProcessExit(null, 'SIGKILL')).toBe('killed by SIGKILL')
    expect(describeProcessExit(null, 'SIGTERM')).toBe('killed by SIGTERM')
  })

  it('degrades to the generic word rather than a wrong claim about an exit code', () => {
    // Some platforms report the kill without naming the signal. "killed by signal" is still the
    // right half of the diagnosis; "exited with code null" would be neither half.
    expect(describeProcessExit(null, null)).toBe('killed by signal')
  })

  it('prefers the code over the signal when a runtime reports BOTH', () => {
    // Node reports exactly one, but the code is the more specific fact if a caller supplies two.
    expect(describeProcessExit(2, 'SIGINT')).toBe('exited with code 2')
  })
})
