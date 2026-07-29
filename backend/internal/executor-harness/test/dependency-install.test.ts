import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { log } from '../src/logger.js'
import {
  buildDependencyInstallNote,
  parseDependencyInstallSpec,
  runDependencyInstall,
} from '../src/dependency-install.js'

// DEPENDENCY PREPOPULATION: the install run against the checkout BEFORE the agent's first turn
// (docs/initiatives/agent-dependency-prepopulation.md). These run REAL `sh -c` commands in a temp
// dir — the exit code is a real programmatic outcome, not a self-report.

const opts = { log }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dependency-install-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('parseDependencyInstallSpec', () => {
  it('accepts a command and trims it', () => {
    expect(parseDependencyInstallSpec({ command: '  pnpm install  ' })).toEqual({
      command: 'pnpm install',
    })
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a bare string', 'pnpm install'],
    ['an empty command', { command: '' }],
    ['a whitespace command', { command: '   ' }],
    ['a non-string command', { command: 42 }],
  ])('degrades %s to no install phase', (_label, input) => {
    // A malformed body must reproduce the exact pre-feature behaviour (the agent starts against
    // the bare clone) rather than failing an otherwise-good run.
    expect(parseDependencyInstallSpec(input)).toBeUndefined()
  })
})

describe('runDependencyInstall', () => {
  it('reports a successful install and keeps no output', async () => {
    const outcome = await runDependencyInstall({
      cwd: dir,
      spec: { command: 'echo installed-1234-packages' },
      logger: log,
      opts,
    })

    expect(outcome.passed).toBe(true)
    expect(outcome.exitCode).toBe(0)
    // A successful install prints tens of thousands of uninteresting lines; the agent needs to
    // know THAT it succeeded, not what it resolved.
    expect(outcome.outputTail).toBeUndefined()
  })

  it('reports a failed install with its output, and never throws', async () => {
    const outcome = await runDependencyInstall({
      cwd: dir,
      spec: { command: 'echo ERR_PNPM_NO_LOCKFILE >&2; exit 3' },
      logger: log,
      opts,
    })

    expect(outcome.passed).toBe(false)
    expect(outcome.exitCode).toBe(3)
    expect(outcome.outputTail).toContain('ERR_PNPM_NO_LOCKFILE')
  })

  it('reports a missing binary as a failure rather than a crash', async () => {
    // The common shape in the field: an image without the ecosystem's package manager. It must
    // reach the agent as a note, not take the run down.
    const outcome = await runDependencyInstall({
      cwd: dir,
      spec: { command: 'definitely-not-a-real-package-manager install' },
      logger: log,
      opts,
    })

    expect(outcome.passed).toBe(false)
    expect(outcome.exitCode).not.toBe(0)
  })

  it('kills a wedged install on the watchdog and reports it as timed out', async () => {
    process.env.DEPENDENCY_INSTALL_TIMEOUT_MS = '250'
    try {
      const outcome = await runDependencyInstall({
        cwd: dir,
        spec: { command: 'sleep 30' },
        logger: log,
        opts,
      })
      expect(outcome.timedOut).toBe(true)
      expect(outcome.passed).toBe(false)
      expect(outcome.exitCode).toBe(124)
    } finally {
      delete process.env.DEPENDENCY_INSTALL_TIMEOUT_MS
    }
  })

  it('runs in the checkout it is given, not the harness process cwd', async () => {
    const outcome = await runDependencyInstall({
      cwd: dir,
      spec: { command: 'pwd > pwd.txt; grep -q "$(pwd)" pwd.txt' },
      logger: log,
      opts,
    })
    expect(outcome.passed).toBe(true)
  })

  it("feeds the run's inactivity watchdog while the install is silent", async () => {
    // A cold install emits no agent activity, and JOB_INACTIVITY_MS (10 min) is tighter than the
    // install's own watchdog — without the heartbeat a healthy install aborts the run as "hung".
    process.env.DEPENDENCY_INSTALL_HEARTBEAT_MS = '25'
    let beats = 0
    try {
      await runDependencyInstall({
        cwd: dir,
        spec: { command: 'sleep 0.3' },
        logger: log,
        opts: { log, onActivity: () => (beats += 1) },
      })
    } finally {
      delete process.env.DEPENDENCY_INSTALL_HEARTBEAT_MS
    }
    expect(beats).toBeGreaterThan(0)
  })
})

describe('buildDependencyInstallNote', () => {
  it('tells the agent the tree is ready and not to reinstall', () => {
    const note = buildDependencyInstallNote({
      command: 'pnpm install',
      exitCode: 0,
      passed: true,
      durationMs: 1_000,
    })
    expect(note).toContain('pnpm install')
    expect(note).toMatch(/already been installed/i)
    expect(note).toMatch(/do NOT re-run/i)
  })

  it('states a failure, its cause and that the agent may install things itself', () => {
    // Silence is the failure mode this exists to prevent: an agent that merely finds no
    // dependencies and no explanation concludes the environment is offline.
    const note = buildDependencyInstallNote({
      command: 'pnpm install',
      exitCode: 3,
      passed: false,
      outputTail: 'ERR_PNPM_NO_LOCKFILE',
      durationMs: 1_000,
    })
    expect(note).toContain('could NOT be installed')
    expect(note).toContain('exited 3')
    expect(note).toContain('ERR_PNPM_NO_LOCKFILE')
    expect(note).toMatch(/network access/i)
  })

  it('names the sibling checkout when the agent’s cwd is not where the install ran', () => {
    // The multi-repo layout runs the agent at the workspace ROOT, which has no dependency tree of
    // its own — "this checkout" would point it at the wrong place.
    const note = buildDependencyInstallNote(
      { command: 'pnpm install', exitCode: 0, passed: true, durationMs: 1_000 },
      'acme-api',
    )
    expect(note).toContain('`acme-api/` checkout')
    expect(note).not.toContain('This checkout')
  })

  it('describes a timeout as a timeout rather than an exit code', () => {
    const note = buildDependencyInstallNote({
      command: 'pnpm install',
      exitCode: 124,
      passed: false,
      durationMs: 90_000,
      timedOut: true,
    })
    expect(note).toContain('timed out after 90s')
    expect(note).not.toContain('exited 124')
  })
})
