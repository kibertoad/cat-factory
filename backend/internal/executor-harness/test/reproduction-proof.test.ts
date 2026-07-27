import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { log } from '../src/logger.js'
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
    const report = await runReproductionLoop({
      dir,
      baseSha,
      resolveFinalSha: () => headCommit(dir),
      spec: SPEC,
      logger: log,
      opts: { log },
      runAgentPass: async () => {
        throw new Error('must not repair — there is nothing to verify')
      },
    })

    expect(report.status).toBe('inconclusive')
    expect(report.note).toContain('no commit beyond the pre-fix tree')
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
