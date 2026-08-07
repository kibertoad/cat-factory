import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// This suite asserts on RESULTS, never on log lines, so its logger is silent: the harness
// logger writes straight to stdout with no level gate, and the real one made every green run
// print a phase line per case. See `silentLogger` in ./helpers.js.
import { silentLogger as log } from './helpers.js'
import {
  buildDependencyInstallNote,
  dependencyInstallTimeoutMs,
  parseDependencyInstallSpec,
  prepopulateDependencies,
  runDependencyInstall,
  withDependencyNote,
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

  it('fences a failure tail that itself contains a code fence', () => {
    // A package manager prints backticks often enough to matter (a linter quoting a template
    // literal, a test echoing a fixture). A fixed ``` fence would close on the tail's own fence
    // and spill the rest of it — and the instructions above it — into what the model reads as
    // prose. The block has to span the whole tail whatever the tail contains.
    const tail = 'error in:\n```js\nconst a = `x`\n```\nsee above'
    const note = buildDependencyInstallNote({
      command: 'pnpm install',
      exitCode: 1,
      passed: false,
      outputTail: tail,
      durationMs: 1_000,
    })
    const fence = '`'.repeat(4)
    expect(note).toContain(`${fence}\n${tail}\n${fence}`)
  })
})

describe('withDependencyNote', () => {
  it('appends the note, and is the identity when there is none', () => {
    expect(withDependencyNote('do the work', 'installed')).toBe('do the work\n\ninstalled')
    expect(withDependencyNote('do the work', undefined)).toBe('do the work')
  })
})

describe('dependencyInstallTimeoutMs', () => {
  // Derived from the CONFIGURED job ceiling rather than hardcoded against the default one — the
  // install is setup, so a wedged package manager must never be able to consume the run it is
  // preparing for.
  it('defaults to a third of the job ceiling', () => {
    expect(dependencyInstallTimeoutMs({})).toBe(20 * 60_000)
    expect(dependencyInstallTimeoutMs({ JOB_MAX_DURATION_MS: String(30 * 60_000) })).toBe(
      10 * 60_000,
    )
  })

  it('clamps an override that would let setup eat the run', () => {
    expect(
      dependencyInstallTimeoutMs({
        JOB_MAX_DURATION_MS: String(30 * 60_000),
        DEPENDENCY_INSTALL_TIMEOUT_MS: String(45 * 60_000),
      }),
    ).toBe(10 * 60_000)
  })

  it('honours an override below the ceiling', () => {
    expect(dependencyInstallTimeoutMs({ DEPENDENCY_INSTALL_TIMEOUT_MS: '250' })).toBe(250)
  })

  it('floors the derived ceiling so a tiny job is not a guaranteed timeout', () => {
    // The floor guards the DERIVED ceiling only; the explicit override above stays honoured.
    expect(dependencyInstallTimeoutMs({ JOB_MAX_DURATION_MS: '1000' })).toBe(30_000)
  })
})

describe('prepopulateDependencies', () => {
  const exec = promisify(execFile)
  const git = (cwd: string, ...args: string[]): Promise<unknown> => exec('git', args, { cwd })

  /** A real checkout: the exclusion writes `.git/info/exclude` and git alone can judge it. */
  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dependency-repo-'))
    await git(dir, 'init', '-b', 'main')
    await git(dir, 'config', 'user.email', 'o@e.com')
    await git(dir, 'config', 'user.name', 'Origin')
    await writeFile(join(dir, 'package.json'), '{}\n', 'utf8')
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-m', 'base')
    return dir
  }

  /** What a broad `git add -A` would sweep into the agent's commit. */
  async function stageable(dir: string): Promise<string[]> {
    const { stdout } = await exec(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory'],
      { cwd: dir },
    )
    return stdout.split('\n').filter((line) => line.trim() !== '')
  }

  let checkout: string
  beforeEach(async () => {
    checkout = await repo()
  })
  afterEach(async () => {
    await rm(checkout, { recursive: true, force: true })
  })

  it('is a no-op with no declared install', async () => {
    let phased = false
    const note = await prepopulateDependencies({
      spec: undefined,
      installDir: checkout,
      repoDir: checkout,
      agentDir: checkout,
      logger: log,
      opts: { log, onPhase: () => (phased = true) },
    })
    expect(note).toBeUndefined()
    // Not even the phase marker: an unconfigured service must be byte-for-byte the old flow.
    expect(phased).toBe(false)
  })

  it('keeps what the install created out of the agent’s commits', async () => {
    // The repo has NO .gitignore for node_modules — the shape this protects. Without the
    // exclusion the agent's own `git add -A` (or the conflict flow's) would put the whole
    // dependency tree in the pull request.
    const note = await prepopulateDependencies({
      spec: { command: 'mkdir -p node_modules/pkg && echo x > node_modules/pkg/index.js' },
      installDir: checkout,
      repoDir: checkout,
      agentDir: checkout,
      logger: log,
      opts,
    })
    expect(note).toMatch(/already been installed/i)
    expect(await stageable(checkout)).toEqual([])
  })

  it('excludes a partial tree left by a FAILED install too', async () => {
    await prepopulateDependencies({
      spec: { command: 'mkdir -p node_modules/half && exit 1' },
      installDir: checkout,
      repoDir: checkout,
      agentDir: checkout,
      logger: log,
      opts,
    })
    expect(await stageable(checkout)).toEqual([])
  })

  it('leaves untracked files the install did not create alone', async () => {
    // Only what the install ADDED is excluded. A file that was already there is the agent's
    // business — a prior run's work on a persistent checkout, or a resumed edit — and hiding
    // it from git would lose work rather than protect it.
    await writeFile(join(checkout, 'notes.md'), 'mine\n', 'utf8')
    await prepopulateDependencies({
      spec: { command: 'mkdir -p node_modules/pkg' },
      installDir: checkout,
      repoDir: checkout,
      agentDir: checkout,
      logger: log,
      opts,
    })
    expect(await stageable(checkout)).toEqual(['notes.md'])
  })

  it('names the install location when the agent stands somewhere else', async () => {
    // The multi-repo layout (agent at the workspace root, install in a sibling) and the
    // conflict flow (agent at the repo root, install in a monorepo service subtree).
    const service = join(checkout, 'packages', 'api')
    await mkdir(service, { recursive: true })
    const note = await prepopulateDependencies({
      spec: { command: 'true' },
      installDir: service,
      repoDir: checkout,
      agentDir: checkout,
      logger: log,
      opts,
    })
    expect(note).toContain('`packages/api/` checkout')
  })

  it('runs the install and reports it even when the directory is not a git checkout', async () => {
    // The exclusion is a best-effort ADDITION to the phase, never a precondition for it.
    const plain = await mkdtemp(join(tmpdir(), 'dependency-plain-'))
    try {
      const note = await prepopulateDependencies({
        spec: { command: 'true' },
        installDir: plain,
        repoDir: plain,
        agentDir: plain,
        logger: log,
        opts,
      })
      expect(note).toMatch(/already been installed/i)
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})
