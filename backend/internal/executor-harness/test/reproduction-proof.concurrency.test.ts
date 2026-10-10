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
import { headCommit } from '../src/git.js'
import { runReproductionLoop, runReproductionProof } from '../src/reproduction-proof.js'

const exec = promisify(execFile)

// PER-JOB ISOLATION for the bugfix reproduction proof, on the LOCAL NATIVE path — a REQUIRED item
// of the initiative's D5, not a nice-to-have.
//
// A container runs one job per process with its own HOME, so per-job state staged in a process- or
// HOME-global would look correct there. The local native transport (`LOCAL_NATIVE_AGENTS`,
// `LocalProcessRunnerTransport`) breaks that: ONE long-lived host process serves EVERY concurrent
// ambient job. This phase is the sharpest case in the harness, because it materialises whole
// WORKTREES on disk: a shared worktree root would let two concurrent bugfix runs check out over
// each other's base trees — and since the base tree is what decides `reproduced` vs
// `inconclusive`, the corruption would surface as a FALSE VERDICT on a pull request rather than as
// a crash. The container path would never catch it. These run the two jobs genuinely
// CONCURRENTLY, which is the case a sequential test would miss.

/** A repo whose `check.sh` exits non-zero until `fix.txt` says `fixed`. */
async function makeRepo(prefix: string): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const g = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
  await g('init', '-b', 'main')
  await g('config', 'user.email', 'o@e.com')
  await g('config', 'user.name', 'Origin')
  await writeFile(join(dir, 'fix.txt'), 'buggy\n', 'utf8')
  await g('add', '-A')
  await g('commit', '-m', 'base')
  return { dir, baseSha: await headCommit(dir) }
}

async function commitWork(
  dir: string,
  opts: { test?: boolean; fix?: boolean; message?: string },
): Promise<string> {
  const g = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
  if (opts.test) {
    await writeFile(
      join(dir, 'check.sh'),
      '#!/bin/sh\ngrep -q fixed fix.txt || { echo "reproduced in $(basename $(pwd))"; exit 1; }\n',
      'utf8',
    )
  }
  if (opts.fix) await writeFile(join(dir, 'fix.txt'), 'fixed\n', 'utf8')
  await g('add', '-A')
  await g('commit', '--allow-empty', '-m', opts.message ?? 'work')
  return headCommit(dir)
}

const spec = (over: Record<string, unknown> = {}) => ({
  command: 'sh check.sh',
  testPaths: ['check.sh'],
  maxAttempts: 3,
  ...over,
})

let a: { dir: string; baseSha: string }
let b: { dir: string; baseSha: string }
beforeEach(async () => {
  ;[a, b] = await Promise.all([makeRepo('repro-job-a-'), makeRepo('repro-job-b-')])
})
afterEach(async () => {
  await rm(a.dir, { recursive: true, force: true })
  await rm(b.dir, { recursive: true, force: true })
})

describe('concurrent reproduction proofs stay isolated', () => {
  it('gives each job its OWN worktrees, so neither can see the other’s trees', async () => {
    // Job A is genuinely reproducible (red then green); job B is not (red on both). Running them
    // at the same time must not let either verdict bleed into the other.
    const finalA = await commitWork(a.dir, { test: true, fix: true })
    const finalB = await commitWork(b.dir, { test: true })

    const [ra, rb] = await Promise.all([
      runReproductionProof({
        dir: a.dir,
        baseSha: a.baseSha,
        finalSha: finalA,
        spec: spec(),
        attempt: 1,
        logger: log,
        opts: { log },
      }),
      runReproductionProof({
        dir: b.dir,
        baseSha: b.baseSha,
        finalSha: finalB,
        spec: spec(),
        attempt: 1,
        logger: log,
        opts: { log },
      }),
    ])

    expect(ra.report.status).toBe('reproduced')
    expect(rb.report.status).toBe('inconclusive')
    // Every worktree is torn down in each job's own `finally`, so neither leaves a record behind
    // that the sibling (or a later round) could collide with on the fixed base/final dir names.
    for (const dir of [a.dir, b.dir]) {
      const list = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: dir })
      expect(list.stdout.match(/^worktree /gm)).toHaveLength(1)
    }
  })

  it("does not leak one job's env into the other (agentEnv, never process.env)", async () => {
    const before = process.env.JOB_MARKER
    const finalA = await commitWork(a.dir, { test: true, fix: true })
    const finalB = await commitWork(b.dir, { test: true, fix: true })

    const [ra, rb] = await Promise.all([
      runReproductionProof({
        dir: a.dir,
        baseSha: a.baseSha,
        finalSha: finalA,
        spec: spec({ command: 'echo "marker=$JOB_MARKER"; exit 1' }),
        attempt: 1,
        logger: log,
        opts: { log, agentEnv: { JOB_MARKER: 'from_job_a' } },
      }),
      runReproductionProof({
        dir: b.dir,
        baseSha: b.baseSha,
        finalSha: finalB,
        spec: spec({ command: 'echo "marker=$JOB_MARKER"; exit 1' }),
        attempt: 1,
        logger: log,
        opts: { log, agentEnv: { JOB_MARKER: 'from_job_b' } },
      }),
    ])

    expect(ra.report.base?.outputTail).toContain('marker=from_job_a')
    expect(rb.report.base?.outputTail).toContain('marker=from_job_b')
    // The shared host process must be untouched: a global set/restore would leak into a sibling,
    // and the sibling's restore would clear it mid-run.
    expect(process.env.JOB_MARKER).toBe(before)
  })

  it("keeps each concurrent loop's attempt budget, repair prompts and publishes separate", async () => {
    await commitWork(a.dir, { test: true })
    await commitWork(b.dir, { test: true })
    const promptsA: string[] = []
    const promptsB: string[] = []
    const seenA: number[] = []
    const seenB: number[] = []

    const [ra, rb] = await Promise.all([
      runReproductionLoop({
        dir: a.dir,
        baseSha: a.baseSha,
        resolveFinalSha: () => headCommit(a.dir),
        spec: spec({ maxAttempts: 2 }),
        logger: log,
        opts: { log, onReproductionProof: (r) => seenA.push(r.attempts) },
        runAgentPass: async (p) => {
          promptsA.push(p)
          await commitWork(a.dir, { message: 'a still broken' })
        },
      }),
      runReproductionLoop({
        dir: b.dir,
        baseSha: b.baseSha,
        resolveFinalSha: () => headCommit(b.dir),
        spec: spec({ maxAttempts: 3 }),
        logger: log,
        opts: { log, onReproductionProof: (r) => seenB.push(r.attempts) },
        runAgentPass: async (p) => {
          promptsB.push(p)
          await commitWork(b.dir, { message: 'b still broken' })
        },
      }),
    ])

    expect(ra.attempts).toBe(2)
    expect(ra.maxAttempts).toBe(2)
    expect(rb.attempts).toBe(3)
    expect(rb.maxAttempts).toBe(3)
    expect(promptsA).toHaveLength(1)
    expect(promptsB).toHaveLength(2)
    // Each job publishes only its OWN attempts, to its OWN callback.
    expect(seenA).toEqual([1, 2])
    expect(seenB).toEqual([1, 2, 3])
  })
})
