import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// This suite asserts on RESULTS, never on log lines, so its logger is silent: the harness
// logger writes straight to stdout with no level gate, and the real one made every green run
// print a phase line per case. See `silentLogger` in ./helpers.js.
import { silentLogger as log } from './helpers.js'
import { runDependencyInstall } from '../src/dependency-install.js'

// PER-JOB ISOLATION for dependency prepopulation, on the LOCAL NATIVE path.
//
// A container runs one job per process with its own HOME, so per-job state staged in a process-
// or HOME-global would look correct there. The local native transport (`LOCAL_NATIVE_AGENTS`,
// `LocalProcessRunnerTransport`) breaks that: ONE long-lived host process serves EVERY concurrent
// ambient job. An install is the single most dangerous phase to get this wrong — it writes a
// dependency tree and reads registry auth — so two concurrent jobs must not be able to see each
// other's command, environment or checkout. These tests run the two jobs genuinely CONCURRENTLY;
// the container path alone would never catch a regression, and neither would a sequential test.

let dirA: string
let dirB: string
beforeEach(async () => {
  dirA = await mkdtemp(join(tmpdir(), 'dependency-job-a-'))
  dirB = await mkdtemp(join(tmpdir(), 'dependency-job-b-'))
})
afterEach(async () => {
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

describe('concurrent dependency installs stay isolated', () => {
  it("does not leak one job's registry env into the other (agentEnv, never process.env)", async () => {
    // `npm_config_userconfig` is the real payload here: it points at the job's own npmrc, which
    // carries its workspace's private-registry token. A global would hand job B job A's token.
    const before = process.env.npm_config_userconfig

    const [a, b] = await Promise.all([
      runDependencyInstall({
        cwd: dirA,
        spec: { command: 'echo "npmrc=$npm_config_userconfig" >&2; exit 1' },
        logger: log,
        opts: { log, agentEnv: { npm_config_userconfig: '/tmp/job-a/.npmrc' } },
      }),
      runDependencyInstall({
        cwd: dirB,
        spec: { command: 'echo "npmrc=$npm_config_userconfig" >&2; exit 1' },
        logger: log,
        opts: { log, agentEnv: { npm_config_userconfig: '/tmp/job-b/.npmrc' } },
      }),
    ])

    expect(a.outputTail).toContain('npmrc=/tmp/job-a/.npmrc')
    expect(b.outputTail).toContain('npmrc=/tmp/job-b/.npmrc')
    // The shared host process must be untouched: a global set/restore would leak into a sibling,
    // and the sibling's restore would clear it mid-install.
    expect(process.env.npm_config_userconfig).toBe(before)
  })

  it('installs into each job’s OWN checkout, with its OWN command', async () => {
    const [a, b] = await Promise.all([
      runDependencyInstall({
        cwd: dirA,
        spec: { command: 'mkdir -p node_modules && echo job-a > node_modules/.marker' },
        logger: log,
        opts: { log },
      }),
      runDependencyInstall({
        cwd: dirB,
        spec: { command: 'mkdir -p node_modules && echo job-b > node_modules/.marker' },
        logger: log,
        opts: { log },
      }),
    ])

    expect(a.passed).toBe(true)
    expect(b.passed).toBe(true)
    expect((await readFile(join(dirA, 'node_modules/.marker'), 'utf8')).trim()).toBe('job-a')
    expect((await readFile(join(dirB, 'node_modules/.marker'), 'utf8')).trim()).toBe('job-b')
  })

  it('reports each job’s own outcome when one install fails and the other succeeds', async () => {
    // A shared outcome/among-jobs cache would surface as job B inheriting job A's verdict — and
    // a FALSE "dependencies are installed" note is worse than none, because the agent then never
    // installs what it actually needs.
    const [a, b] = await Promise.all([
      runDependencyInstall({
        cwd: dirA,
        spec: { command: 'echo job-a-broke >&2; exit 7' },
        logger: log,
        opts: { log },
      }),
      runDependencyInstall({
        cwd: dirB,
        spec: { command: 'echo job-b-fine' },
        logger: log,
        opts: { log },
      }),
    ])

    expect(a.passed).toBe(false)
    expect(a.exitCode).toBe(7)
    expect(a.outputTail).toContain('job-a-broke')
    expect(b.passed).toBe(true)
    expect(b.outputTail).toBeUndefined()
  })
})
