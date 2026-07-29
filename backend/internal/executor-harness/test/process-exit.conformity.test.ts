import { describeProcessExit as kernelDescribeProcessExit } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { describeProcessExit } from '../src/process-exit.js'

// `src/process-exit.ts` is a deliberate COPY of kernel's `describeProcessExit` (the container
// image is built from `src/` plus typescript alone, so the harness can carry no runtime dependency
// on a workspace package). The two render the same operational distinction — the CLI's own failure
// exit vs something having killed it — onto failure text an operator reads across BOTH the
// container harness and the local inline runner, so a drift would have the same event described
// two different ways depending on where it ran. Pin them equal.

const CASES: Array<[name: string, code: number | null, signal: NodeJS.Signals | null]> = [
  ['a plain failure exit', 1, null],
  ['exit 0 (a caller that asks anyway)', 0, null],
  ['a shell-convention timeout exit', 124, null],
  ['a high exit code', 255, null],
  ['an OOM/forced kill', null, 'SIGKILL'],
  ['a graceful termination', null, 'SIGTERM'],
  ['an interrupt', null, 'SIGINT'],
  // Node types `signal` as nullable alongside a null code; a platform that reports neither must
  // still not produce a claim about an exit code that did not happen.
  ['killed with no signal name reported', null, null],
]

describe('harness describeProcessExit conforms to kernel describeProcessExit', () => {
  for (const [name, code, signal] of CASES) {
    it(`matches for ${name}`, () => {
      expect(describeProcessExit(code, signal)).toBe(kernelDescribeProcessExit(code, signal))
    })
  }

  it('never renders a null code as an exit code', () => {
    expect(describeProcessExit(null, 'SIGKILL')).toBe('killed by SIGKILL')
    expect(describeProcessExit(null, null)).toBe('killed by signal')
    expect(describeProcessExit(null, null)).not.toMatch(/code/)
  })
})
