import { describe, expect, it } from 'vitest'
import type { PublicRun } from '@cat-factory/sdk'
import { requireRunDone } from './runDriver.js'

// What an unfinished run is told to look at next, which is the suite's only output when a pass
// fails at 2am and nobody watched it happen.
//
// The case this exists for: the merge-preset hint fired on "there is a pull request and the status
// is not done", which a run that DIED in the coder step also satisfies. A failed run then arrived
// with advice about a merge threshold, for a merge that was never considered, on top of an error
// that already said what happened. A hint that competes with the failure is worse than none.

const run = (over: Partial<PublicRun>): PublicRun => ({
  runId: 'run_1',
  taskId: 'task_1',
  status: 'failed',
  currentStep: 2,
  createdAt: 0,
  steps: [],
  error: null,
  externalIdentity: null,
  externalIdentityWithheld: false,
  pullRequest: null,
  ...over,
})

const failureOf = (over: Partial<PublicRun>): string => {
  try {
    requireRunDone(run(over), 'scaffolding')
    return '(did not throw)'
  } catch (err) {
    return (err as Error).message
  }
}

const evicted = {
  code: 'evicted',
  message: 'The executor-harness shut down while this job was still running',
} as PublicRun['error']

const pr = { url: 'https://example.test/pr/3', branch: 'cat-factory/task_1' }

describe('requireRunDone', () => {
  it('hands a done run straight back', () => {
    const done = run({ status: 'done' })
    expect(requireRunDone(done, 'scaffolding')).toBe(done)
  })

  it('does not blame the merge threshold for a run that failed with a pull request open', () => {
    const message = failureOf({ status: 'failed', error: evicted, pullRequest: pr })
    expect(message).toContain('The executor-harness shut down')
    expect(message).not.toMatch(/merge-threshold|merge was HELD/)
    expect(message).toContain('debug/runs/run_1')
  })

  it('still names the merge threshold when nothing else explains the stop', () => {
    // The case the hint was written for: the pipeline ran out, a pull request is open, and the
    // run recorded no failure of its own. `paused` is how a held merge surfaces on this surface.
    const message = failureOf({ status: 'paused', pullRequest: pr })
    expect(message).toMatch(/merge was HELD/)
    expect(message).toContain('merge-threshold preset')
  })

  it('points a parked run at its decisions', () => {
    expect(failureOf({ status: 'blocked' })).toContain('/decisions')
  })

  it('adds nothing it cannot support', () => {
    const message = failureOf({ status: 'paused' })
    expect(message).toContain("run run_1 ended 'paused'")
    expect(message).not.toMatch(/merge|decisions|debug/)
  })
})
