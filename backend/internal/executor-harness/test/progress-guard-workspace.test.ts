import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProgressGuard, type ProgressGuardLimits } from '../src/progress-guard.js'
import { createGuardDriver } from '../src/guard-driver.js'
import {
  agentChangedPaths,
  createWorkspaceProbe,
  type WorkspaceEvidence,
} from '../src/workspace-probe.js'
import { headCommit } from '../src/git.js'
import type { Logger } from '../src/logger.js'

const exec = promisify(execFile)

// The regression this whole file exists for: an agent that writes every file through `bash`
// (heredocs, `sed -i`, `node -e`) makes no tool call the guard recognises as an edit, so the
// no-edit bound used to kill it however much it had built. The bound now asks the working tree.

const LIMITS: ProgressGuardLimits = { maxToolCallsWithoutEdit: 3, maxConsecutiveErrors: 99 }

/** A logger that records rather than writing to the job's stdout, so a green run stays silent. */
function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  const self: Logger & { warnings: string[] } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warnings.push(msg)
    },
    error: () => {},
    child: () => self,
  }
  return self
}

const clean = (headSha = 'aaaa111'): WorkspaceEvidence => ({
  mutated: false,
  headSha,
  headMoved: false,
  dirtyPathCount: 0,
})
const mutated = (headSha = 'aaaa111'): WorkspaceEvidence => ({
  mutated: true,
  headSha,
  headMoved: false,
  dirtyPathCount: 4,
})

describe('guard driver (the no-edit bound decides on the working tree)', () => {
  /** Drive `count` `bash` calls through a driver and let every queued probe settle. */
  const runBash = async (
    driver: ReturnType<typeof createGuardDriver>,
    count: number,
  ): Promise<void> => {
    for (let i = 0; i < count; i++) driver.observeSignal({ name: 'Bash', isError: false })
    // The probe is async and the stream handler is not, so let its microtasks drain.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  it('does NOT kill a bash-only run that is mutating the working tree', async () => {
    const aborts: string[] = []
    let probes = 0
    const driver = createGuardDriver({
      guard: new ProgressGuard(LIMITS),
      probe: async () => {
        probes++
        return mutated()
      },
      onAbort: (reason) => aborts.push(reason),
      log: recordingLogger(),
    })

    await runBash(driver, 3)
    expect(aborts).toEqual([])
    expect(probes).toBe(1)

    // And the bound is satisfied PERMANENTLY, exactly as an edit-tool call satisfies it: many
    // more action calls, and no second probe is ever made.
    await runBash(driver, 20)
    expect(aborts).toEqual([])
    expect(probes).toBe(1)
    expect(driver.aborted()).toBe(false)
  })

  it('aborts on a clean tree, and states the evidence it acted on', async () => {
    const aborts: string[] = []
    let probes = 0
    const driver = createGuardDriver({
      guard: new ProgressGuard(LIMITS),
      probe: async () => {
        probes++
        return clean('deadbee')
      },
      onAbort: (reason) => aborts.push(reason),
      log: recordingLogger(),
    })

    await runBash(driver, 3)
    expect(aborts).toHaveLength(1)
    expect(aborts[0]).toMatch(/no recognised file edit/i)
    expect(aborts[0]).toMatch(/deadbee/)
    expect(driver.aborted()).toBe(true)

    // Neither the abort nor the probe can repeat.
    await runBash(driver, 10)
    expect(aborts).toHaveLength(1)
    expect(probes).toBe(1)
  })

  it('treats a throwing probe as inconclusive: no abort, and no re-probe until the bound trips again', async () => {
    const aborts: string[] = []
    let probes = 0
    const logger = recordingLogger()
    const driver = createGuardDriver({
      guard: new ProgressGuard(LIMITS),
      probe: async () => {
        probes++
        throw new Error('git status failed', { cause: new Error('not a git repository') })
      },
      onAbort: (reason) => aborts.push(reason),
      log: logger,
    })

    await runBash(driver, 3)
    expect(aborts).toEqual([])
    expect(probes).toBe(1)
    expect(logger.warnings.join(' ')).toMatch(/workspace probe failed/i)

    // Two more action calls are still short of the re-armed bound, so nothing is re-probed.
    await runBash(driver, 2)
    expect(probes).toBe(1)
    // The third re-arms it: the bound may trip again, exactly once more.
    await runBash(driver, 1)
    expect(probes).toBe(2)
    expect(aborts).toEqual([])
  })

  it('leaves every streak bound immediate — they read only the stream', async () => {
    const aborts: string[] = []
    let probes = 0
    const driver = createGuardDriver({
      guard: new ProgressGuard({ maxToolCallsWithoutEdit: 999, maxConsecutiveErrors: 3 }),
      probe: async () => {
        probes++
        return mutated()
      },
      onAbort: (reason) => aborts.push(reason),
      log: recordingLogger(),
    })
    for (let i = 0; i < 3; i++) driver.observeSignal({ name: 'Bash', isError: true })
    expect(aborts).toHaveLength(1)
    expect(aborts[0]).toMatch(/consecutive failing tool calls/i)
    expect(probes).toBe(0)
  })

  it('falls back to the tool-name judgement when no probe is wired', async () => {
    const aborts: string[] = []
    const driver = createGuardDriver({
      guard: new ProgressGuard(LIMITS),
      onAbort: (reason) => aborts.push(reason),
      log: recordingLogger(),
    })
    await runBash(driver, 3)
    expect(aborts).toHaveLength(1)
    expect(aborts[0]).toMatch(/Aborting before it burns the whole run/)
  })

  it('drives the same decision off a Pi event stream', async () => {
    const aborts: string[] = []
    const driver = createGuardDriver({
      guard: new ProgressGuard(LIMITS),
      probe: async () => mutated(),
      onAbort: (reason) => aborts.push(reason),
      log: recordingLogger(),
    })
    for (let i = 0; i < 6; i++) {
      driver.observeEvent({ type: 'tool_execution_end', toolName: 'bash', isError: false })
    }
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(aborts).toEqual([])
  })
})

describe('agentChangedPaths (the harness excludes its own sentinels)', () => {
  it('drops the sentinels at the root and in a monorepo service directory', () => {
    const status = [
      '?? .cat-effort.json',
      '?? services/api/.cat-follow-ups.jsonl',
      '?? .cat-pr-description.md',
      ' M src/app.ts',
      '?? src/routes/health.ts',
    ].join('\n')
    expect(agentChangedPaths(status)).toEqual(['src/app.ts', 'src/routes/health.ts'])
  })

  it('reads a run that wrote nothing but its effort report as unchanged', () => {
    expect(agentChangedPaths('?? .cat-effort.json\n')).toEqual([])
  })
})

describe('createWorkspaceProbe (against a real repository)', () => {
  let dir: string
  const git = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'probe-test-'))
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(dir, 'README.md'), '# base\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'base')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('sees a file written straight into the tree, whichever tool wrote it', async () => {
    const baseSha = await headCommit(dir)
    const probe = createWorkspaceProbe({ dir, baseSha })
    expect((await probe()).mutated).toBe(false)

    // What a `bash` heredoc leaves behind: an untracked file and no tool call anyone recognised.
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')
    const evidence = await probe()
    expect(evidence.mutated).toBe(true)
    expect(evidence.dirtyPathCount).toBe(1)
    expect(evidence.headMoved).toBe(false)
  })

  it('sees a commit the agent made itself', async () => {
    const baseSha = await headCommit(dir)
    const probe = createWorkspaceProbe({ dir, baseSha })
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'feat: by the agent')

    const evidence = await probe()
    expect(evidence.mutated).toBe(true)
    expect(evidence.headMoved).toBe(true)
    expect(evidence.dirtyPathCount).toBe(0)
  })

  it('does not read a gitignored dependency install as progress', async () => {
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'ignore deps')
    const baseSha = await headCommit(dir)
    const probe = createWorkspaceProbe({ dir, baseSha })

    await exec('mkdir', ['-p', join(dir, 'node_modules', 'left-pad')])
    await writeFile(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    expect((await probe()).mutated).toBe(false)
  })

  it('throws (inconclusive, never a pass) where there is no repository', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'probe-norepo-'))
    try {
      await expect(createWorkspaceProbe({ dir: bare, baseSha: 'abc' })()).rejects.toThrow()
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})
