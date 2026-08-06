import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// This suite asserts on RESULTS, never on log lines, so its logger is silent: the harness
// logger writes straight to stdout with no level gate, and the real one made every green run
// print a phase line per case. See `silentLogger` in ./helpers.js.
import { silentLogger as log } from './helpers.js'
import {
  buildRepairPrompt,
  runValidationChecks,
  runValidationLoop,
  VALIDATION_REPORT_TAIL_CHARS,
  type ValidationChecksSpec,
} from '../src/validation-checks.js'

// Pre-PR validation: the generic check runner + the repair loop that gates the PR
// (docs/initiatives/pre-pr-validation.md). These run REAL `sh -c` commands in a temp dir —
// the point is that the exit code is a real programmatic verdict, not a model self-report.

const opts = { log }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'validation-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function spec(checks: { label: string; command: string }[], maxAttempts = 3): ValidationChecksSpec {
  return { checks, maxAttempts }
}

describe('runValidationChecks', () => {
  it('passes when every command exits 0 and captures their output', async () => {
    const { report } = await runValidationChecks(
      dir,
      spec([
        { label: 'lint', command: 'echo lint-clean' },
        { label: 'test', command: 'echo tests-green' },
      ]),
      1,
      log,
      opts,
    )

    expect(report.passed).toBe(true)
    expect(report.attempts).toBe(1)
    expect(report.outcomes.map((o) => o.label)).toEqual(['lint', 'test'])
    expect(report.outcomes.every((o) => o.passed && o.exitCode === 0)).toBe(true)
    // A PASSING command's output is captured too — that is the "captured proof" the run records.
    expect(report.outcomes[0]?.outputTail).toContain('lint-clean')
    expect(report.outcomes[1]?.outputTail).toContain('tests-green')
  })

  it('fails on a non-zero exit and records the exit code + output', async () => {
    const { report } = await runValidationChecks(
      dir,
      spec([{ label: 'test', command: 'echo "3 tests failed" >&2; exit 2' }]),
      1,
      log,
      opts,
    )

    expect(report.passed).toBe(false)
    expect(report.outcomes[0]).toMatchObject({ label: 'test', exitCode: 2, passed: false })
    expect(report.outcomes[0]?.outputTail).toContain('3 tests failed')
  })

  it('runs EVERY check even after one fails, so a repair round sees all the problems', async () => {
    const { report } = await runValidationChecks(
      dir,
      spec([
        { label: 'lint', command: 'echo lint-bad; exit 1' },
        { label: 'test', command: 'echo test-bad; exit 1' },
      ]),
      1,
      log,
      opts,
    )

    expect(report.outcomes).toHaveLength(2)
    expect(report.outcomes.every((o) => !o.passed)).toBe(true)
  })

  it('scrubs secrets out of the captured output', async () => {
    const { report } = await runValidationChecks(
      dir,
      spec([
        {
          label: 'build',
          command: 'echo "DATABASE_PASSWORD=hunter2 ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"; exit 1',
        },
      ]),
      1,
      log,
      opts,
    )

    const tail = report.outcomes[0]?.outputTail ?? ''
    expect(tail).not.toContain('hunter2')
    expect(tail).not.toContain('ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH')
    expect(tail).toContain('***')
  })

  it('bounds the reported output tail', async () => {
    const { report, fullTails } = await runValidationChecks(
      dir,
      // ~40k of output — well past the report bound.
      spec([
        { label: 'noisy', command: 'for i in $(seq 1 4000); do echo 0123456789; done; exit 1' },
      ]),
      1,
      log,
      opts,
    )

    const tail = report.outcomes[0]?.outputTail ?? ''
    expect(tail.length).toBeLessThanOrEqual(VALIDATION_REPORT_TAIL_CHARS + 100)
    expect(tail).toContain('earlier chars trimmed')
    // The agent's repair prompt gets the LARGER tail — it needs the whole failure to fix it.
    expect((fullTails.get('noisy') ?? '').length).toBeGreaterThan(tail.length)
  })

  it('kills a hung command on the watchdog and treats it as a failure', async () => {
    process.env.VALIDATION_COMMAND_TIMEOUT_MS = '300'
    try {
      const { report } = await runValidationChecks(
        dir,
        spec([{ label: 'hang', command: 'sleep 30' }]),
        1,
        log,
        opts,
      )
      expect(report.passed).toBe(false)
      expect(report.outcomes[0]).toMatchObject({ exitCode: 124, timedOut: true })
    } finally {
      delete process.env.VALIDATION_COMMAND_TIMEOUT_MS
    }
  })

  it('runs the commands in the given checkout directory', async () => {
    await writeFile(join(dir, 'marker.txt'), 'here')
    const { report } = await runValidationChecks(
      dir,
      spec([{ label: 'cwd', command: 'test -f marker.txt' }]),
      1,
      log,
      opts,
    )
    expect(report.passed).toBe(true)
  })

  // A regression guard, not a nicety. These commands are activity-SILENT (a cold install, a full
  // test run) and the harness spawns them itself, so nothing else emits activity while they run.
  // The job-level inactivity watchdog (JOB_INACTIVITY_MS, default 10 min) is TIGHTER than one
  // command's own watchdog (default 15 min), so a loop that stopped feeding it would abort
  // healthy long builds as "inactivity" — a failure the container path would report as a wedge.
  it('feeds the run’s inactivity watchdog while an output-silent command runs', async () => {
    process.env.VALIDATION_HEARTBEAT_MS = '50'
    try {
      const beats: number[] = []
      const { report } = await runValidationChecks(
        dir,
        // Emits nothing at all, and outlasts several heartbeat intervals.
        spec([{ label: 'slow', command: 'sleep 0.4' }]),
        1,
        log,
        { ...opts, onActivity: () => beats.push(Date.now()) },
      )
      expect(report.passed).toBe(true)
      expect(beats.length).toBeGreaterThan(1)
    } finally {
      delete process.env.VALIDATION_HEARTBEAT_MS
    }
  })
})

describe('runValidationLoop', () => {
  it('returns immediately when the first attempt is green (no repair pass)', async () => {
    let passes = 0
    const report = await runValidationLoop({
      workDir: dir,
      spec: spec([{ label: 'lint', command: 'true' }]),
      logger: log,
      opts,
      runAgentPass: async () => {
        passes += 1
      },
    })

    expect(report.passed).toBe(true)
    expect(report.attempts).toBe(1)
    expect(passes).toBe(0)
  })

  it('re-runs the agent with the failure output and stops once the checkout goes green', async () => {
    // The "agent" fixes the checkout by creating the file the check requires.
    const prompts: string[] = []
    const report = await runValidationLoop({
      workDir: dir,
      spec: spec([
        { label: 'lint', command: 'test -f fixed.txt || { echo "missing fixed.txt"; exit 1; }' },
      ]),
      logger: log,
      opts,
      runAgentPass: async (prompt) => {
        prompts.push(prompt)
        await writeFile(join(dir, 'fixed.txt'), 'ok')
      },
    })

    expect(report.passed).toBe(true)
    expect(report.attempts).toBe(2)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('missing fixed.txt')
  })

  it('gives up at the attempt budget and reports the last red attempt', async () => {
    let passes = 0
    const report = await runValidationLoop({
      workDir: dir,
      spec: spec([{ label: 'lint', command: 'echo still-broken; exit 1' }], 3),
      logger: log,
      opts,
      runAgentPass: async () => {
        passes += 1
      },
    })

    expect(report.passed).toBe(false)
    expect(report.attempts).toBe(3)
    expect(report.maxAttempts).toBe(3)
    // 3 attempts ⇒ 2 repair passes between them (the budget counts CHECK rounds).
    expect(passes).toBe(2)
  })

  it('publishes every completed attempt so the loop is observable while it runs', async () => {
    const published: { attempts: number; passed: boolean }[] = []
    await runValidationLoop({
      workDir: dir,
      spec: spec([{ label: 'lint', command: 'exit 1' }], 2),
      logger: log,
      opts: { ...opts, onValidationReport: (r) => published.push(r) },
      runAgentPass: async () => {},
    })

    expect(published.map((p) => p.attempts)).toEqual([1, 2])
    expect(published.every((p) => !p.passed)).toBe(true)
  })

  it('never repairs when the budget is 1 (check once, fail)', async () => {
    let passes = 0
    const report = await runValidationLoop({
      workDir: dir,
      spec: spec([{ label: 'lint', command: 'exit 1' }], 1),
      logger: log,
      opts,
      runAgentPass: async () => {
        passes += 1
      },
    })
    expect(report.attempts).toBe(1)
    expect(passes).toBe(0)
  })
})

describe('buildRepairPrompt', () => {
  it('names the failing checks, their output, and the remaining budget', () => {
    const prompt = buildRepairPrompt(
      {
        passed: false,
        attempts: 1,
        maxAttempts: 3,
        at: 0,
        outcomes: [
          { label: 'lint', command: 'pnpm lint', exitCode: 1, passed: false, outputTail: 'short' },
          { label: 'test', command: 'pnpm test', exitCode: 0, passed: true },
        ],
      },
      new Map([['lint', 'the FULL lint output']]),
    )

    expect(prompt).toContain('lint')
    expect(prompt).toContain('pnpm lint')
    // The prompt carries the FULL tail, not the report's truncated one.
    expect(prompt).toContain('the FULL lint output')
    expect(prompt).not.toContain('short')
    // A passing check isn't dumped into the repair instruction.
    expect(prompt).not.toContain('pnpm test')
    expect(prompt).toContain('2 attempt(s) left')
    // The gate must not be gameable by weakening the check.
    expect(prompt).toMatch(/do not edit, disable, skip, or relax the checks/i)
    // Always tell the agent to stage new files: only tracked edits are auto-staged, so an
    // unadded file is dropped from the branch even though the checks (run against the working
    // tree) can see it — the one way a "green" report can describe work the PR won't contain.
    expect(prompt).toMatch(/`git add` any NEW file/i)
  })

  it('names the uncommitted new files the push would silently drop', () => {
    const report = {
      passed: false,
      attempts: 1,
      maxAttempts: 3,
      at: 0,
      outcomes: [
        { label: 'test', command: 'pnpm test', exitCode: 1, passed: false, outputTail: 'boom' },
      ],
    }
    const withNone = buildRepairPrompt(report, new Map())
    expect(withNone).not.toContain('Uncommitted new files')

    const withSome = buildRepairPrompt(report, new Map(), ['src/new-thing.ts', 'src/other.ts'])
    expect(withSome).toContain('Uncommitted new files')
    expect(withSome).toContain('src/new-thing.ts')
    expect(withSome).toContain('src/other.ts')
  })
})
