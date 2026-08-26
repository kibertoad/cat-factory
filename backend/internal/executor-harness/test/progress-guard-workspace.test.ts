import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProgressGuard, type ProgressGuardLimits } from '../src/progress-guard.js'
import { createGuardDriver } from '../src/guard-driver.js'
import {
  agentChangedPaths,
  composeWorkspaceProbes,
  createWorkspaceProbe,
  type WorkspaceEvidence,
  type WorkspaceProbe,
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
  /** `git status --porcelain -z`: NUL after every field, nothing quoted. */
  const porcelainZ = (...fields: string[]): string => `${fields.join('\0')}\0`

  it('drops the sentinels at the root and in a monorepo service directory', () => {
    const status = porcelainZ(
      '?? .cat-effort.json',
      '?? services/api/.cat-follow-ups.jsonl',
      '?? .cat-pr-description.md',
      ' M src/app.ts',
      '?? src/routes/health.ts',
    )
    expect(agentChangedPaths(status)).toEqual(['src/app.ts', 'src/routes/health.ts'])
  })

  it('reads a run that wrote nothing but its effort report as unchanged', () => {
    expect(agentChangedPaths(porcelainZ('?? .cat-effort.json'))).toEqual([])
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

  it('sees a file whose name git would C-QUOTE', async () => {
    const baseSha = await headCommit(dir)
    const probe = createWorkspaceProbe({ dir, baseSha })
    await writeFile(join(dir, 'café.ts'), 'export const x = 1\n', 'utf8')
    const evidence = await probe()
    expect(evidence.mutated).toBe(true)
    expect(evidence.dirtyPathCount).toBe(1)
  })

  it('throws (inconclusive, never a pass) where there is no repository', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'probe-norepo-'))
    try {
      await expect(createWorkspaceProbe({ dir: bare, baseSha: 'abc' })()).rejects.toThrow()
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('decides on the DIRTY TREE where the checkout has no commit yet', async () => {
    // A scaffold-from-scratch bootstrap: `rev-parse HEAD` errors, which is the exact case the
    // dirty-tree half was written for. Reading HEAD unconditionally turned it into a throw, so the
    // bound went inconclusive forever on the one shape the whole change exists to serve.
    const fresh = await mkdtemp(join(tmpdir(), 'probe-nocommit-'))
    try {
      await exec('git', ['init', '-b', 'main'], { cwd: fresh })
      const probe = createWorkspaceProbe({ dir: fresh, baseSha: '' })
      expect(await probe()).toMatchObject({ mutated: false, headSha: '', headMoved: false })

      await writeFile(join(fresh, 'src.ts'), 'export const x = 1\n', 'utf8')
      const evidence = await probe()
      expect(evidence.mutated).toBe(true)
      expect(evidence.dirtyPathCount).toBe(1)
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })
})

describe('composeWorkspaceProbes (a workspace of sibling checkouts)', () => {
  // A multi-repo run's cwd is the workspace ROOT, which is no repository: probing it throws every
  // time, so the bound never enforced anything. The honest question is whether the run changed ANY
  // of the checkouts it was given.
  const answering =
    (evidence: WorkspaceEvidence): WorkspaceProbe =>
    () =>
      Promise.resolve(evidence)
  const throwing =
    (message: string): WorkspaceProbe =>
    () =>
      Promise.reject(new Error(message))

  it('reads a change in ANY checkout as the run making progress', async () => {
    const evidence = await composeWorkspaceProbes([
      answering(clean('aaa')),
      answering({ mutated: true, headSha: 'bbb', headMoved: true, dirtyPathCount: 2 }),
    ])()
    expect(evidence.mutated).toBe(true)
    expect(evidence.headMoved).toBe(true)
    expect(evidence.dirtyPathCount).toBe(2)
  })

  it('names every answering checkout’s HEAD, since a workspace has no single one', async () => {
    const evidence = await composeWorkspaceProbes([
      answering(clean('aaa')),
      answering(clean('bbb')),
    ])()
    expect(evidence.mutated).toBe(false)
    expect(evidence.headSha).toBe('aaa, bbb')
  })

  it('is INCONCLUSIVE rather than clean when a checkout could not be probed', async () => {
    // The leg that threw might have been the changed one, so reporting the rest as clean would
    // kill a productive run on evidence nobody has.
    await expect(
      composeWorkspaceProbes([answering(clean('aaa')), throwing('not a git repository')])(),
    ).rejects.toThrow(/could not be probed/)
  })

  it('still settles when a checkout that DID answer had changed', async () => {
    const evidence = await composeWorkspaceProbes([
      answering(mutated('aaa')),
      throwing('not a git repository'),
    ])()
    expect(evidence.mutated).toBe(true)
  })
})

describe('the probe reaches BOTH harness paths', () => {
  // A wiring guard, because an unwired probe is SILENT: `createGuardDriver` falls back to the
  // tool-name judgement (see the case above), which is the very bound this file exists to
  // replace. So a path that stops forwarding it does not fail a test, it just quietly goes back
  // to killing bash-only runs.
  //
  // Source-level for the same reason `pr-template.coverage.test.ts` is: the forwarding happens in
  // a spec literal handed to a runner, and the two paths build their own. This nearly regressed
  // once already, when the subscription branch moved into its own function while this probe was
  // being added on the other side of a merge.
  /**
   * One top-level function's body, bounded by the NEXT top-level declaration. Both spellings the
   * file uses have to end a body (`export async function` as well as a bare `async function`), or
   * the slice runs to end of file and the assertion passes on a neighbour's code.
   */
  const DECLARATION = /^(?:export )?(?:async )?function (\w+)\(/gm
  const bodyOf = (source: string, name: string): string => {
    const starts = [...source.matchAll(DECLARATION)]
    const at = starts.findIndex((match) => match[1] === name)
    expect(at, `${name} not found`).toBeGreaterThan(-1)
    return source.slice(starts[at]!.index, starts[at + 1]?.index ?? source.length)
  }

  it('is built once in the shared middle, and each path forwards it to its runner', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/pi-workspace.ts', import.meta.url)),
      'utf8',
    )
    // Built ONCE. A second builder would give the two paths different baselines, and a repair
    // round judged against the wrong one is the bug the baseline comment warns about.
    expect(source.match(/await buildWorkspaceProbe\(/g)).toHaveLength(1)
    // The shared middle builds it and hands it to the subscription path, which is a separate
    // function; the Pi path stays inline in the same body.
    expect(bodyOf(source, 'runAgentInWorkspace')).toContain('workspaceProbe')
    // Each path then forwards it into the spec its runner actually reads. The subscription one
    // is the half a refactor can silently drop, since it crosses a function boundary.
    expect(bodyOf(source, 'runSubscriptionInWorkspace')).toContain('workspaceProbe,')
  })
})
