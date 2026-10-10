import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// This suite asserts on RESULTS, never on log lines, so its logger is silent: the harness
// logger writes straight to stdout with no level gate, and the real one made every green run
// print a phase line per case. See `silentLogger` in ./helpers.js.
import { silentLogger as log } from './helpers.js'
import { runRalphValidation, RALPH_VALIDATION_TAIL_CHARS } from '../src/coding-agent.js'
import { headCommit } from '../src/git.js'

const exec = promisify(execFile)
const g = (cwd: string, ...args: string[]): Promise<unknown> => exec('git', args, { cwd })

// The Ralph loop's completion criterion, run by the HARNESS (never self-reported by the model).
// These run REAL `sh -c` commands against a REAL git checkout — the exit code and the head SHA
// are the two things the engine's loop decisions are built on, so both are asserted for real.

const opts = { log }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ralph-validation-'))
  await g(dir, 'init', '-b', 'main')
  await g(dir, 'config', 'user.email', 'test@example.com')
  await g(dir, 'config', 'user.name', 'Test')
  await writeFile(join(dir, 'seed.txt'), 'seed\n', 'utf8')
  await g(dir, 'add', '-A')
  await g(dir, 'commit', '-m', 'seed')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runRalphValidation', () => {
  it('passes on exit 0 and reports the head the criterion was judged against', async () => {
    const head = await headCommit(dir)
    const verdict = await runRalphValidation(
      dir,
      dir,
      { command: 'echo all-green', iteration: 2 },
      log,
      opts,
    )

    expect(verdict.validationPassed).toBe(true)
    expect(verdict.exitCode).toBe(0)
    expect(verdict.iteration).toBe(2)
    expect(verdict.validationOutputTail).toContain('all-green')
    expect(verdict.headSha).toBe(head)
  })

  it('fails on a non-zero exit, capturing stderr as well as stdout', async () => {
    const verdict = await runRalphValidation(
      dir,
      dir,
      { command: 'echo "2 tests failed" >&2; exit 3' },
      log,
      opts,
    )

    expect(verdict.validationPassed).toBe(false)
    expect(verdict.exitCode).toBe(3)
    expect(verdict.validationOutputTail).toContain('2 tests failed')
  })

  it('reports the MOVED head after a command that commits, so the loop can see progress', async () => {
    const before = await headCommit(dir)
    const verdict = await runRalphValidation(
      dir,
      dir,
      { command: 'echo more > extra.txt && git add -A && git commit -q -m more' },
      log,
      opts,
    )

    expect(verdict.headSha).not.toBe(before)
    expect(verdict.headSha).toBe(await headCommit(dir))
  })

  it('scrubs secrets out of the captured tail', async () => {
    const verdict = await runRalphValidation(
      dir,
      dir,
      { command: 'echo "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"; exit 1' },
      log,
      opts,
    )

    expect(verdict.validationOutputTail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('bounds the tail that crosses the wire, saying what it dropped', async () => {
    // The tail is persisted on the step AND on every entry of the iteration log, inside the
    // run's `detail` blob — which is re-serialized on every step-progress write. It must not
    // ride at the full in-container capture size.
    const verdict = await runRalphValidation(
      dir,
      dir,
      { command: `head -c 60000 /dev/zero | tr '\\0' 'x'; exit 1` },
      log,
      opts,
    )

    const tail = verdict.validationOutputTail ?? ''
    expect(tail.length).toBeLessThan(RALPH_VALIDATION_TAIL_CHARS + 200)
    expect(tail).toMatch(/earlier chars trimmed/)
  })

  it('feeds the inactivity watchdog while the command runs', async () => {
    // `JOB_INACTIVITY_MS` (10 min) is TIGHTER than the command's own watchdog (15 min), and a
    // harness-spawned command emits no activity of its own — so without this heartbeat a
    // legitimately slow validation aborts the whole iteration as "inactivity".
    process.env.RALPH_VALIDATION_HEARTBEAT_MS = '20'
    let beats = 0
    try {
      await runRalphValidation(dir, dir, { command: 'sleep 0.3' }, log, {
        ...opts,
        onActivity: () => {
          beats += 1
        },
      })
    } finally {
      delete process.env.RALPH_VALIDATION_HEARTBEAT_MS
    }
    expect(beats).toBeGreaterThan(0)
  })

  it('treats a hung command as a failure rather than blocking the loop', async () => {
    process.env.RALPH_VALIDATION_TIMEOUT_MS = '150'
    try {
      const verdict = await runRalphValidation(dir, dir, { command: 'sleep 30' }, log, opts)
      expect(verdict.validationPassed).toBe(false)
      expect(verdict.exitCode).toBe(124)
    } finally {
      delete process.env.RALPH_VALIDATION_TIMEOUT_MS
    }
  })
})
