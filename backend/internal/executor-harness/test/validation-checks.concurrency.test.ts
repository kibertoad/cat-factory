import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// This suite asserts on RESULTS, never on log lines, so its logger is silent: the harness
// logger writes straight to stdout with no level gate, and the real one made every green run
// print a phase line per case. See `silentLogger` in ./helpers.js.
import { silentLogger as log } from './helpers.js'
import { runValidationChecks, runValidationLoop } from '../src/validation-checks.js'

// PER-JOB ISOLATION for pre-PR validation, on the LOCAL NATIVE path.
//
// A container runs one job per process with its own HOME, so per-job state staged in a process-
// or HOME-global would look correct there. The local native transport (`LOCAL_NATIVE_AGENTS`,
// `LocalProcessRunnerTransport`) breaks that: ONE long-lived host process serves EVERY concurrent
// ambient job. So two jobs with different validation configs must not be able to see each other's
// commands, environment, checkout, or attempt budget — and the container path alone will never
// catch a regression. These tests run the two jobs genuinely CONCURRENTLY (interleaved by real
// process scheduling), which is the case a sequential test would miss.

let dirA: string
let dirB: string
beforeEach(async () => {
  dirA = await mkdtemp(join(tmpdir(), 'validation-job-a-'))
  dirB = await mkdtemp(join(tmpdir(), 'validation-job-b-'))
})
afterEach(async () => {
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

describe('concurrent validation jobs stay isolated', () => {
  it("does not leak one job's env into the other (agentEnv, never process.env)", async () => {
    const before = process.env.JOB_MARKER

    const [a, b] = await Promise.all([
      runValidationChecks(
        dirA,
        { checks: [{ label: 'env', command: 'echo "marker=$JOB_MARKER"' }], maxAttempts: 1 },
        1,
        log,
        { log, agentEnv: { JOB_MARKER: 'from_job_a' } },
      ),
      runValidationChecks(
        dirB,
        { checks: [{ label: 'env', command: 'echo "marker=$JOB_MARKER"' }], maxAttempts: 1 },
        1,
        log,
        { log, agentEnv: { JOB_MARKER: 'from_job_b' } },
      ),
    ])

    expect(a.report.outcomes[0]?.outputTail).toContain('marker=from_job_a')
    expect(b.report.outcomes[0]?.outputTail).toContain('marker=from_job_b')
    // The shared host process must be untouched: a global set/restore would leak into a sibling,
    // and the sibling's restore would clear it mid-run.
    expect(process.env.JOB_MARKER).toBe(before)
  })

  it('runs each job against its OWN checkout, with its OWN commands', async () => {
    const [a, b] = await Promise.all([
      runValidationChecks(
        dirA,
        { checks: [{ label: 'a-only', command: 'pwd' }], maxAttempts: 1 },
        1,
        log,
        { log },
      ),
      runValidationChecks(
        dirB,
        { checks: [{ label: 'b-only', command: 'pwd' }], maxAttempts: 1 },
        1,
        log,
        { log },
      ),
    ])

    expect(a.report.outcomes.map((o) => o.label)).toEqual(['a-only'])
    expect(b.report.outcomes.map((o) => o.label)).toEqual(['b-only'])
    // `pwd` resolves symlinked temp roots (/var → /private/var on macOS), so compare basenames.
    expect(a.report.outcomes[0]?.outputTail).toContain(dirA.split('/').pop() ?? '')
    expect(b.report.outcomes[0]?.outputTail).toContain(dirB.split('/').pop() ?? '')
  })

  it("keeps each concurrent loop's attempt budget and repair prompts separate", async () => {
    const promptsA: string[] = []
    const promptsB: string[] = []

    const [a, b] = await Promise.all([
      runValidationLoop({
        workDir: dirA,
        spec: { checks: [{ label: 'lint', command: 'echo A-BROKE; exit 1' }], maxAttempts: 2 },
        logger: log,
        opts: { log },
        runAgentPass: async (p) => {
          promptsA.push(p)
        },
      }),
      runValidationLoop({
        workDir: dirB,
        spec: { checks: [{ label: 'lint', command: 'echo B-BROKE; exit 1' }], maxAttempts: 4 },
        logger: log,
        opts: { log },
        runAgentPass: async (p) => {
          promptsB.push(p)
        },
      }),
    ])

    expect(a.attempts).toBe(2)
    expect(a.maxAttempts).toBe(2)
    expect(b.attempts).toBe(4)
    expect(b.maxAttempts).toBe(4)
    // Each job's repair instruction carries only its OWN failure output.
    expect(promptsA.every((p) => p.includes('A-BROKE') && !p.includes('B-BROKE'))).toBe(true)
    expect(promptsB.every((p) => p.includes('B-BROKE') && !p.includes('A-BROKE'))).toBe(true)
  })

  it('publishes each job’s attempts to its OWN callback', async () => {
    const seenA: number[] = []
    const seenB: number[] = []

    await Promise.all([
      runValidationLoop({
        workDir: dirA,
        spec: { checks: [{ label: 'lint', command: 'exit 1' }], maxAttempts: 2 },
        logger: log,
        opts: { log, onValidationReport: (r) => seenA.push(r.attempts) },
        runAgentPass: async () => {},
      }),
      runValidationLoop({
        workDir: dirB,
        spec: { checks: [{ label: 'lint', command: 'exit 1' }], maxAttempts: 3 },
        logger: log,
        opts: { log, onValidationReport: (r) => seenB.push(r.attempts) },
        runAgentPass: async () => {},
      }),
    ])

    expect(seenA).toEqual([1, 2])
    expect(seenB).toEqual([1, 2, 3])
  })
})
