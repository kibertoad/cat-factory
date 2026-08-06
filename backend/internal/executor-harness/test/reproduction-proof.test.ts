import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// This suite asserts on RESULTS, never on log lines, so its logger is silent: the harness
// logger writes straight to stdout with no level gate, and the real one made every green run
// print a phase line per case. See `silentLogger` in ./helpers.js.
import { silentLogger as log } from './helpers.js'
import { headCommit } from '../src/git.js'
import {
  buildReproductionRepairPrompt,
  parseReproductionSpec,
  runReproductionLoop,
  runReproductionProof,
  type ReproductionReport,
  type ReproductionSpec,
} from '../src/reproduction-proof.js'

const exec = promisify(execFile)

// BUGFIX REPRODUCTION PROOF — real-git coverage for the harness phase.
//
// These drive a REAL local repository through `git worktree`, because the whole safety argument
// (the initiative's D4) is about what the two trees actually contain: a mocked git would happily
// "prove" a reproduction that the real one could not. The reproduction command is a shell script
// committed into the repo, so red/green is decided by the tree the worktree checked out and
// nothing else.

/** A repo whose `check.sh` exits non-zero until `fix.txt` says `fixed`. */
async function makeRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'repro-repo-'))
  const g = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
  await g('init', '-b', 'main')
  await g('config', 'user.email', 'o@e.com')
  await g('config', 'user.name', 'Origin')
  await writeFile(join(dir, 'fix.txt'), 'buggy\n', 'utf8')
  await g('add', '-A')
  await g('commit', '-m', 'base')
  return { dir, baseSha: await headCommit(dir) }
}

/**
 * Commit the reproduction test (a script asserting the fix is in place) and, optionally, the fix
 * itself — the two commits whose combination decides the verdict.
 */
async function commitWork(
  dir: string,
  opts: { test?: boolean; fix?: boolean; message?: string },
): Promise<string> {
  const g = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
  if (opts.test) {
    await writeFile(
      join(dir, 'check.sh'),
      '#!/bin/sh\ngrep -q fixed fix.txt || { echo "BUG REPRODUCED: fix.txt is still buggy"; exit 1; }\n',
      'utf8',
    )
  }
  if (opts.fix) await writeFile(join(dir, 'fix.txt'), 'fixed\n', 'utf8')
  await g('add', '-A')
  // `--allow-empty` so a test can model an agent pass that committed nothing useful.
  await g('commit', '--allow-empty', '-m', opts.message ?? 'work')
  return headCommit(dir)
}

const SPEC: ReproductionSpec = {
  command: 'sh check.sh',
  testPaths: ['check.sh'],
  maxAttempts: 3,
}

let dir: string
let baseSha: string
beforeEach(async () => {
  ;({ dir, baseSha } = await makeRepo())
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runReproductionProof', () => {
  it('reports `reproduced` for red at the pre-fix tree and green at the final tree', async () => {
    const finalSha = await commitWork(dir, { test: true, fix: true })

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: SPEC,
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect(report.status).toBe('reproduced')
    expect(report.base?.passed).toBe(false)
    expect(report.final?.passed).toBe(true)
    // The captured output is what lets a human check the base was red for the RIGHT reason —
    // the one thing symmetry alone cannot establish (the initiative's D4 limitation).
    expect(report.base?.outputTail).toContain('BUG REPRODUCED')
    expect(report.attempts).toBe(1)
    expect(report.at).toBeGreaterThan(0)
  })

  it('applies the DECLARED test paths onto the pre-fix tree without dragging the fix across', async () => {
    // The test file does not exist at `baseSha` at all: without the overlay the base worktree
    // could not run the check, and a whole-tree checkout would bring `fix.txt` with it and green
    // the base — the exact failure the path-scoped overlay exists to prevent.
    const finalSha = await commitWork(dir, { test: true, fix: true })

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: SPEC,
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect(report.status).toBe('reproduced')
    expect(report.base?.exitCode).toBe(1)
  })

  it('reports `inconclusive` when the check passes on the pre-fix tree, and never runs the final tree', async () => {
    // A test that passes without the fix demonstrates nothing. `reproduced` requires a RED base,
    // so the final phase is skipped — the report documents `final` as absent in exactly this case.
    await writeFile(join(dir, 'check.sh'), '#!/bin/sh\nexit 0\n', 'utf8')
    const finalSha = await commitWork(dir, { fix: true })

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: SPEC,
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.base?.passed).toBe(true)
    expect(report.final).toBeUndefined()
    expect(report.note).toContain('PASSED on the pre-fix tree')
  })

  it('reports `inconclusive` — never proof — when the check is red on BOTH trees', async () => {
    // Red-then-red is what an environmental defect looks like (a missing toolchain, an unrelated
    // pre-existing breakage). Symmetry is what makes it fail both phases; reporting it as
    // `reproduced` would launder an unverified claim into a captured "fact".
    const finalSha = await commitWork(dir, { test: true })

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: SPEC,
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.base?.passed).toBe(false)
    expect(report.final?.passed).toBe(false)
    expect(report.note).toContain('both')
  })

  it('reads two IDENTICAL failures as an environment problem rather than an ineffective fix', async () => {
    // Two trees that differ only by the change, failing the exact same way, is far more often one
    // broken environment failing both ways — a missing dependency, an uninstalled toolchain, a
    // collection error — than a fix that does nothing. Offering both readings with equal weight
    // leaves a reviewer to guess at precisely the moment the evidence points somewhere.
    await commitWork(dir, { test: true })
    const finalSha = await commitWork(dir, { message: 'a change that fixes nothing' })

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: { ...SPEC, command: 'exit 42' },
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.note).toContain('Both trees failed the SAME way (exit 42)')
  })

  it('says the change is ineffective when the two failures DIFFER', async () => {
    // Two DIFFERENT failures mean the change did something — just not enough — so the reading
    // above (one environment failing both trees identically) does not apply.
    await commitWork(dir, { test: true })
    await writeFile(join(dir, 'fix.txt'), 'partial\n', 'utf8')
    const finalSha = await commitWork(dir, { message: 'a partial fix' })

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: {
        ...SPEC,
        command: 'grep -q fixed fix.txt || { grep -q partial fix.txt && exit 3; exit 1; }',
      },
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect(report.base?.exitCode).toBe(1)
    expect(report.final?.exitCode).toBe(3)
    expect(report.note).toContain('does not make the check pass')
  })

  it('runs the setup command in BOTH worktrees, and flags a setup failure rather than calling it a red tree', async () => {
    const finalSha = await commitWork(dir, { test: true, fix: true })
    const marker = join(dir, 'setup-runs.log')

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: { ...SPEC, setupCommand: `echo ran >> ${marker}` },
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect(report.status).toBe('reproduced')
    // Both trees got the SAME setup — an asymmetric one is how a false `reproduced` is made.
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(2)

    const failed = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: { ...SPEC, setupCommand: 'exit 3' },
      attempt: 1,
      logger: log,
      opts: { log },
    })
    expect(failed.report.status).toBe('inconclusive')
    expect(failed.report.base?.setupFailed).toBe(true)
    expect(failed.report.note).toContain('environment problem')
  })

  it('says so when no declared test file is committed, instead of reporting a verdict without it', async () => {
    // The proof runs against COMMITTED trees, so an unadded test took no part in it — and is
    // equally missing from the push. A verdict computed without the reproduction in it would be
    // indistinguishable from "the test does not capture the defect".
    const finalSha = await commitWork(dir, { fix: true })
    await writeFile(join(dir, 'check.sh'), '#!/bin/sh\nexit 1\n', 'utf8')

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: SPEC,
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.base).toBeUndefined()
    expect(report.note).toContain('check.sh')
  })

  it('echoes the engine-dropped path count onto the report', async () => {
    const finalSha = await commitWork(dir, { test: true, fix: true })

    const { report } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: { ...SPEC, omittedTestPaths: 2 },
      attempt: 1,
      logger: log,
      opts: { log },
    })

    // A dropped path can leave the base without the reproduction, so the omission has to travel
    // with the verdict rather than being implied by it.
    expect(report.omittedTestPaths).toBe(2)
  })

  it('tears both worktrees down, leaving the agent’s own checkout untouched', async () => {
    const finalSha = await commitWork(dir, { test: true, fix: true })
    const before = (await readdir(dir)).sort()

    await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      spec: SPEC,
      attempt: 1,
      logger: log,
      opts: { log },
    })

    expect((await readdir(dir)).sort()).toEqual(before)
    // No worktree administrative records survive, so a later `git worktree add` can reuse names.
    const list = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: dir })
    expect(list.stdout.match(/^worktree /gm)).toHaveLength(1)
    // The checkout still sits on the branch the push and the PR come off.
    expect(await headCommit(dir)).toBe(finalSha)
  })
})

describe('runReproductionLoop', () => {
  it('feeds a failed verification back to the agent and settles once it is proved', async () => {
    // Round 1: the test is committed but the fix is not, so both trees are red.
    await commitWork(dir, { test: true })
    const prompts: string[] = []
    const published: ReproductionReport[] = []

    const report = await runReproductionLoop({
      dir,
      baseSha,
      resolveFinalSha: () => headCommit(dir),
      spec: SPEC,
      logger: log,
      opts: { log, onReproductionProof: (r) => published.push(r) },
      runAgentPass: async (prompt) => {
        prompts.push(prompt)
        // The "agent" repairs by landing the actual fix.
        await commitWork(dir, { fix: true, message: 'fix' })
      },
    })

    expect(report.status).toBe('reproduced')
    expect(report.attempts).toBe(2)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('FAILED on the pre-fix tree')
    // Every attempt is published live, each with its own timestamp — the engine's change
    // detection compares on `at`, so a stale republish would be dropped as "no change".
    expect(published).toHaveLength(2)
    expect(published[0]?.status).toBe('inconclusive')
    expect(published[1]?.status).toBe('reproduced')
  })

  it('degrades to `inconclusive` when the budget is spent — it never fails the run', async () => {
    await commitWork(dir, { test: true })
    let passes = 0

    const report = await runReproductionLoop({
      dir,
      baseSha,
      resolveFinalSha: () => headCommit(dir),
      spec: { ...SPEC, maxAttempts: 2 },
      logger: log,
      opts: { log },
      // An agent that keeps committing without fixing anything.
      runAgentPass: async () => {
        passes += 1
        await commitWork(dir, { message: `no-op ${passes}` })
      },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.attempts).toBe(2)
    expect(report.maxAttempts).toBe(2)
    expect(passes).toBe(1)
  })

  it('does not spend repair rounds on a setup failure the agent cannot fix', async () => {
    await commitWork(dir, { test: true })
    let passes = 0

    const report = await runReproductionLoop({
      dir,
      baseSha,
      resolveFinalSha: () => headCommit(dir),
      spec: { ...SPEC, setupCommand: 'exit 7', maxAttempts: 3 },
      logger: log,
      opts: { log },
      runAgentPass: async () => {
        passes += 1
      },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.base?.setupFailed).toBe(true)
    // The setup command is declared by the reproduction step; re-running the agent against a
    // broken environment produces nothing but cost.
    expect(passes).toBe(0)
  })

  it('reports `inconclusive` without running anything when the branch never advanced', async () => {
    const published: ReproductionReport[] = []
    const report = await runReproductionLoop({
      dir,
      baseSha,
      resolveFinalSha: () => headCommit(dir),
      spec: SPEC,
      logger: log,
      opts: { log, onReproductionProof: (r) => published.push(r) },
      runAgentPass: async () => {
        throw new Error('must not repair — there is nothing to verify')
      },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.note).toContain('no commit beyond the pre-fix tree')
    // Published like every other settled attempt: a verdict that only reaches the terminal result
    // is invisible while the job runs, and an absent section reads as "the phase never ran".
    expect(published).toEqual([report])
  })

  it('prunes every round’s worktrees, so a multi-round loop cannot accumulate them', async () => {
    await commitWork(dir, { test: true })
    await runReproductionLoop({
      dir,
      baseSha,
      resolveFinalSha: () => headCommit(dir),
      spec: { ...SPEC, maxAttempts: 3 },
      logger: log,
      opts: { log },
      runAgentPass: async () => {
        await commitWork(dir, { message: 'still broken' })
      },
    })

    // Three rounds × two worktrees, all removed: only the main checkout is left registered. A
    // leaked record would also collide on the next round's fixed `base`/`final` directory names.
    const list = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: dir })
    expect(list.stdout.match(/^worktree /gm)).toHaveLength(1)
    expect(existsSync(dir)).toBe(true)
  })
})

// A RESUMED run's pre-fix tree is the work branch as it stood when this pass started. In the
// designed flow that is the reproduction step's test commit — but a coder container evicted
// mid-run has already committed and checkpoint-pushed its work, so the re-dispatch resumes a
// branch that carries this same step's own partial fix. The check then legitimately passes on the
// "pre-fix" tree, and calling that "your test does not demonstrate the defect" is both false and
// an invitation to weaken a reproduction that is fine.
describe('a pre-fix tree that already carries work', () => {
  it('does not blame the test — and spends no repair round — when the base carries non-test work', async () => {
    // The base tree ALREADY has the fix (an interrupted earlier pass committed it), so the check
    // is green there for a reason that has nothing to do with the test.
    const resumedTip = await commitWork(dir, { test: true, fix: true })
    const finalSha = await commitWork(dir, { message: 'more work on top' })
    let passes = 0

    const report = await runReproductionLoop({
      dir,
      baseSha: resumedTip,
      resolveFinalSha: async () => finalSha,
      spec: SPEC,
      logger: log,
      opts: { log },
      listBaseTreeChanges: async () => ['check.sh', 'fix.txt'],
      runAgentPass: async () => {
        passes += 1
      },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.base?.passed).toBe(true)
    expect(report.note).toContain('ALREADY carries non-test work')
    expect(report.note).toContain('fix.txt')
    // The declared test file is not "prior work" — it is the reproduction itself.
    expect(report.note).not.toContain('check.sh')
    expect(passes).toBe(0)
  })

  it('still blames the test when the base carries ONLY the declared reproduction', async () => {
    // The legitimate green-base case the guard must not suppress: the branch carries the test and
    // nothing else, so the test really does pass without a fix.
    const resumedTip = await commitWork(dir, { test: true, fix: true })
    const finalSha = await commitWork(dir, { message: 'more work on top' })
    let passes = 0

    const report = await runReproductionLoop({
      dir,
      baseSha: resumedTip,
      resolveFinalSha: async () => finalSha,
      spec: { ...SPEC, maxAttempts: 2 },
      logger: log,
      opts: { log },
      listBaseTreeChanges: async () => ['check.sh'],
      runAgentPass: async () => {
        passes += 1
      },
    })

    expect(report.note).toContain('does not demonstrate the defect')
    expect(passes).toBe(1)
  })

  it('falls back to the plain diagnosis when the provenance probe cannot answer', async () => {
    // A shallow clone has no reachable merge base. An unavailable answer must degrade to the old
    // behaviour, never suppress a diagnosis on a guess.
    const resumedTip = await commitWork(dir, { test: true, fix: true })
    const finalSha = await commitWork(dir, { message: 'more work on top' })

    const report = await runReproductionLoop({
      dir,
      baseSha: resumedTip,
      resolveFinalSha: async () => finalSha,
      spec: { ...SPEC, maxAttempts: 1 },
      logger: log,
      opts: { log },
      listBaseTreeChanges: async () => undefined,
      runAgentPass: async () => {},
    })

    expect(report.note).toContain('does not demonstrate the defect')
  })

  it('probes the pre-fix tree at most ONCE across a whole loop', async () => {
    // Three rounds that each hit the green base, so each one asks the provenance question.
    const resumedTip = await commitWork(dir, { test: true, fix: true })
    await commitWork(dir, { message: 'this pass’s work' })
    let probes = 0
    let passes = 0

    await runReproductionLoop({
      dir,
      baseSha: resumedTip,
      resolveFinalSha: () => headCommit(dir),
      spec: { ...SPEC, maxAttempts: 3 },
      logger: log,
      opts: { log },
      // Answers a question about `baseSha`, which never moves — and costs a fetch each time.
      listBaseTreeChanges: async () => {
        probes += 1
        return ['check.sh']
      },
      runAgentPass: async () => {
        passes += 1
        await commitWork(dir, { message: `round ${passes}` })
      },
    })

    expect(passes).toBe(2)
    expect(probes).toBe(1)
  })
})

describe('the phase’s cost ceiling', () => {
  const restore = { ...process.env }
  afterEach(() => {
    process.env = { ...restore }
  })

  it('settles `inconclusive` when the whole-phase time budget is spent, running no agent round', async () => {
    // Attempts multiply two full tree runs each, and the phase's heartbeat deliberately stops the
    // job-level inactivity watchdog from ever cutting it short — so this budget is the only thing
    // bounding the phase's wall clock.
    process.env.REPRODUCTION_TOTAL_BUDGET_MS = '1'
    await commitWork(dir, { test: true })
    let passes = 0

    const report = await runReproductionLoop({
      dir,
      baseSha,
      resolveFinalSha: () => headCommit(dir),
      spec: SPEC,
      logger: log,
      opts: { log },
      runAgentPass: async () => {
        passes += 1
      },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.note).toContain('time budget')
    // A cost limit is not a verdict about the fix, so it never fails the run.
    expect(passes).toBe(0)
  })

  it('does not spend repair rounds on a timed-out tree', async () => {
    // A watchdog kill is not a failing assertion the agent can act on, and each round would cost
    // two more full tree runs to learn the same thing.
    process.env.REPRODUCTION_COMMAND_TIMEOUT_MS = '100'
    await commitWork(dir, { test: true })
    let passes = 0

    const report = await runReproductionLoop({
      dir,
      baseSha,
      resolveFinalSha: () => headCommit(dir),
      spec: { ...SPEC, command: 'sleep 30', maxAttempts: 3 },
      logger: log,
      opts: { log },
      runAgentPass: async () => {
        passes += 1
      },
    })

    expect(report.base?.timedOut).toBe(true)
    expect(report.final?.timedOut).toBe(true)
    // And it is reported as a watchdog kill, not as "a missing dependency" or "the fix does
    // nothing" — neither of which the two identical exit-124s are evidence for.
    expect(report.note).toContain('TIMED OUT on both')
    expect(passes).toBe(0)
  })
})

describe('parseReproductionSpec', () => {
  it('returns undefined for a body with no usable command, so the run is unchanged', () => {
    expect(parseReproductionSpec(undefined)).toBeUndefined()
    expect(parseReproductionSpec({})).toBeUndefined()
    expect(parseReproductionSpec({ command: '   ' })).toBeUndefined()
    expect(parseReproductionSpec({ testPaths: ['a.ts'] })).toBeUndefined()
  })

  it('refuses unsafe declared paths and COUNTS them as omitted', () => {
    // These paths are handed to `git checkout` against a worktree, so this is the harness's own
    // trust boundary — and a silently shorter list would understate what the base tree is missing.
    const spec = parseReproductionSpec({
      command: 'npm test',
      testPaths: ['ok/a.test.ts', '../escape.ts', '/etc/passwd', '-oh-no', 'b\\c.test.ts'],
      omittedTestPaths: 1,
    })

    expect(spec?.testPaths).toEqual(['ok/a.test.ts', 'b/c.test.ts'])
    // 1 dropped by the engine + 3 refused here.
    expect(spec?.omittedTestPaths).toBe(4)
  })

  it('refuses git PATHSPEC MAGIC, which would drag the fix onto the pre-fix tree', () => {
    // `--` stops a path being read as a REVISION but does nothing about pathspec syntax, so a
    // glob would apply far more of the final tree onto the base worktree than the declared
    // reproduction — greening the base and reporting a perfectly good test as worthless.
    const spec = parseReproductionSpec({
      command: 'npm test',
      testPaths: [
        'ok/a.test.ts',
        ':(glob)**',
        ':/etc/x',
        '*',
        'src/*.test.ts',
        'src/a?.test.ts',
        'src/[ab].test.ts',
      ],
    })

    expect(spec?.testPaths).toEqual(['ok/a.test.ts'])
    expect(spec?.omittedTestPaths).toBe(6)
  })

  it('refuses an over-long path, matching the engine’s own cap', () => {
    const spec = parseReproductionSpec({
      command: 'npm test',
      testPaths: [`${'a'.repeat(401)}.ts`],
    })

    expect(spec?.testPaths).toEqual([])
    expect(spec?.omittedTestPaths).toBe(1)
  })

  it('clamps the attempt budget and defaults a missing one', () => {
    expect(parseReproductionSpec({ command: 'x', maxAttempts: 999 })?.maxAttempts).toBe(10)
    expect(parseReproductionSpec({ command: 'x' })?.maxAttempts).toBe(3)
    expect(parseReproductionSpec({ command: 'x', maxAttempts: 0 })?.maxAttempts).toBe(3)
  })
})

describe('buildReproductionRepairPrompt', () => {
  const report = (over: Partial<ReproductionReport>): ReproductionReport => ({
    status: 'inconclusive',
    command: 'npm test -- repro',
    testPaths: ['a.test.ts'],
    attempts: 1,
    maxAttempts: 3,
    at: 1,
    ...over,
  })

  it('names the green-base case and forbids weakening the test', () => {
    const prompt = buildReproductionRepairPrompt(
      report({ base: { exitCode: 0, passed: true } }),
      new Map(),
    )

    expect(prompt).toContain('PASSED on the pre-fix tree')
    // A loop that lets the agent "succeed" by weakening the reproduction is worse than no loop:
    // it launders an unverified claim into a captured fact.
    expect(prompt).toContain('Do NOT weaken')
    expect(prompt).toContain('2 attempt(s) left')
  })

  it('uses the FULL captured tail rather than the report’s smaller bound', () => {
    const prompt = buildReproductionRepairPrompt(
      report({
        base: { exitCode: 1, passed: false, outputTail: 'TRUNCATED' },
        final: { exitCode: 1, passed: false },
      }),
      new Map([['base', 'THE WHOLE FAILURE']]),
    )

    expect(prompt).toContain('THE WHOLE FAILURE')
    expect(prompt).not.toContain('TRUNCATED')
  })

  it('names uncommitted new files, which the committed-tree proof could not see', () => {
    const prompt = buildReproductionRepairPrompt(
      report({ base: { exitCode: 0, passed: true } }),
      new Map(),
      ['src/repro.test.ts'],
    )

    expect(prompt).toContain('src/repro.test.ts')
    expect(prompt).toContain('git add')
  })
})
