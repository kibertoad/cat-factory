import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reinitAndPush } from '../src/git.js'

const exec = promisify(execFile)

// Real-git coverage for the bootstrap PUSH phase (stuck-run audit F8). The phase resets the
// working tree's history to one commit and force-pushes it to the pre-created target repo, and
// it is the last thing a bootstrap job does — so it is also the phase most likely to be running
// when a watchdog fires. Both cases below use a local bare repo as the target, so the test needs
// no network or token (`authenticatedCloneUrl` only rewrites https URLs).
//
// The pair matters more than either half: the abort case only proves anything BECAUSE the
// control case shows the same call pushes for real when nothing aborts it. Without the control,
// a push that failed for an unrelated reason would read as a working abort.

describe('reinitAndPush', () => {
  let target: string
  let work: string
  const g = (cwd: string, ...args: string[]): Promise<unknown> => exec('git', args, { cwd })
  const spec = (cloneUrl: string) => ({
    owner: 'o',
    name: 'r',
    cloneUrl,
    defaultBranch: 'main',
  })
  /** Commit subjects on the target's default branch; empty for a repo with no commits yet. */
  const targetLog = async (): Promise<string[]> => {
    const { stdout } = await exec('git', ['log', '--format=%s', 'main'], { cwd: target }).catch(
      () => ({ stdout: '' }),
    )
    return stdout.split('\n').filter(Boolean)
  }

  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), 'boot-target-'))
    await g(target, 'init', '--bare', '-b', 'main')
    work = await mkdtemp(join(tmpdir(), 'boot-work-'))
    await writeFile(join(work, 'index.js'), 'export const scaffolded = true\n', 'utf8')
  })
  afterEach(async () => {
    await rm(target, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  it('force-pushes the bootstrapped contents as a single commit', async () => {
    await reinitAndPush({
      dir: work,
      target: spec(target),
      ghToken: 'unused-for-local-origin',
      message: 'Bootstrap new repository',
    })
    expect(await targetLog()).toEqual(['Bootstrap new repository'])
  })

  it('honours an aborted signal instead of pushing (the watchdog can interrupt the push phase)', async () => {
    // Pre-aborted rather than raced on a timer: the point is that the signal reaches the git
    // commands at all. Before F8 none of the six took it, so this call ran to completion and
    // pushed — an abort raised here could not stop the job for up to ~6 per-command timeouts
    // past its max-duration kill.
    await expect(
      reinitAndPush({
        dir: work,
        target: spec(target),
        ghToken: 'unused-for-local-origin',
        message: 'Bootstrap new repository',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow()
    expect(await targetLog()).toEqual([])
  })
})
