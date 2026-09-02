import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeDockerAbsence,
  readDockerStatus,
  resolveDockerVerdict,
} from '../src/docker-status.js'
import type { DockerWorkload } from '../src/docker-capability.js'

// The reader for the verdict `entrypoint.sh` records about this container's Docker daemon.
// The whole value of it is the THREE-valued answer, so most of what is asserted here is that
// "not decided" survives every way the file can be useless — an absent file, a truncated one, a
// vocabulary this build doesn't know — rather than collapsing into the `false` that refuses a
// Tester's stand-up.

async function statusFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-docker-status-'))
  const path = join(dir, 'status.json')
  await writeFile(path, contents, 'utf8')
  return path
}

describe('readDockerStatus', () => {
  it('reads a recorded verdict', async () => {
    const path = await statusFile(
      '{"available":true,"source":"rootless","reason":"serving","detail":""}',
    )
    expect(await readDockerStatus(path)).toEqual({
      available: true,
      source: 'rootless',
      reason: 'serving',
    })
  })

  it('carries the failure detail (the dockerd log tail) through', async () => {
    const path = await statusFile(
      '{"available":false,"source":"rootless","reason":"failed","detail":"exec: dockerd: not found"}',
    )
    expect(await readDockerStatus(path)).toEqual({
      available: false,
      source: 'rootless',
      reason: 'failed',
      detail: 'exec: dockerd: not found',
    })
  })

  it('reports an absent file as undecided, not as an absent daemon', async () => {
    const status = await readDockerStatus(join(tmpdir(), 'cf-no-such-status-file.json'))
    expect(status.available).toBeUndefined()
    expect(status.source).toBe('unreported')
  })

  it('reports a truncated (mid-write) file as undecided', async () => {
    const path = await statusFile('{"available":false,"source":"root')
    expect(await readDockerStatus(path)).toMatchObject({
      available: undefined,
      source: 'unreported',
    })
  })

  it('treats a probe still in flight as undecided', async () => {
    const path = await statusFile('{"available":null,"source":"rootless","reason":"probing"}')
    expect(await readDockerStatus(path)).toMatchObject({
      available: undefined,
      source: 'rootless',
      reason: 'probing',
    })
  })

  it('falls back to unreported for a source word this build does not know', async () => {
    const path = await statusFile('{"available":false,"source":"podman","reason":"failed"}')
    // The verdict itself is still honoured — only the source, which this build cannot map, degrades.
    expect(await readDockerStatus(path)).toMatchObject({ available: false, source: 'unreported' })
  })
})

describe('describeDockerAbsence', () => {
  it('names the cause per source', () => {
    expect(
      describeDockerAbsence({ available: false, source: 'none', reason: 'missing' }),
    ).toContain('ships no Docker daemon')
    expect(
      describeDockerAbsence({ available: false, source: 'external', reason: 'unreachable' }),
    ).toContain('unreachable')
    expect(
      describeDockerAbsence({ available: false, source: 'rootless', reason: 'failed' }),
    ).toContain('rootless Docker daemon')
  })

  it('appends the recorded detail so the cause is not merely a category', () => {
    const reason = describeDockerAbsence({
      available: false,
      source: 'rootless',
      reason: 'failed',
      detail: 'rootlesskit: failed to setup network',
    })
    expect(reason).toBe(
      'this container could not start its rootless Docker daemon ' +
        '(rootlesskit: failed to setup network)',
    )
  })

  it('does not attribute an unnamed source to the rootless daemon', () => {
    // The reachable case, not a hypothetical: the reader above keeps a recorded `false` while
    // degrading a source word this build does not know, so a status file from a NEWER entrypoint
    // lands here as `unreported`. Guessing "rootless" would send a human to fix the one thing the
    // verdict never mentioned.
    const reason = describeDockerAbsence({
      available: false,
      source: 'unreported',
      reason: 'failed',
    })
    expect(reason).not.toContain('rootless')
    expect(reason).toContain('did not say which one')
  })
})

describe('resolveDockerVerdict', () => {
  const usable = (): Promise<DockerWorkload> => Promise.resolve({ status: 'usable' })
  const unusable = (): Promise<DockerWorkload> =>
    Promise.resolve({ status: 'unusable', detail: 'failed to mount overlay: invalid argument' })
  const undeterminable = (): Promise<DockerWorkload> =>
    Promise.resolve({ status: 'unknown', reason: 'the docker CLI is not on PATH' })

  it('refuses a recorded absence a live daemon does not contradict', async () => {
    const verdict = await resolveDockerVerdict(
      { available: false, source: 'rootless', reason: 'failed', detail: 'rootlesskit: no ip' },
      undeterminable,
    )
    expect(verdict.available).toBe(false)
    expect(verdict.refusal).toContain('rootlesskit: no ip')
  })

  it('lets a daemon that came up after boot overrule the recorded absence', async () => {
    // The warm-pool case. The entrypoint probes ONCE, within a bounded wait; a container serves
    // many jobs. A sidecar that needed longer than that wait is serving perfectly well by the
    // second job, and refusing off the boot record alone would latch this container into refusing
    // local infra that works, for its whole life.
    const verdict = await resolveDockerVerdict(
      { available: false, source: 'external', reason: 'unreachable' },
      usable,
    )
    expect(verdict).toEqual({ available: true })
  })

  it('leaves an undecided verdict undecided rather than probing it into a refusal', async () => {
    const probe = vi.fn(unusable)
    const verdict = await resolveDockerVerdict(
      { available: undefined, source: 'rootless', reason: 'probing' },
      probe,
    )
    expect(verdict).toEqual({ available: undefined })
    // The third value exists so that nothing turns "not decided" into a refusal, and a probe here
    // is exactly what would: the entrypoint's bounded wait may still be running, and a workload
    // that fails against a half-started daemon says nothing about the next second.
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses a RECORDED SUCCESS whose daemon cannot actually run a container', async () => {
    // Issue #2120. The entrypoint records `serving` off a socket that answers, and that is the
    // whole of what it can know. A rootless daemon nested in a sandbox answers throughout while
    // no image layer can be mounted, so compose against it died on a mount error inside the one
    // mechanism whose job is to explain why the dependencies did not come up.
    const verdict = await resolveDockerVerdict(
      { available: true, source: 'rootless', reason: 'serving' },
      unusable,
    )
    expect(verdict.available).toBe(false)
    expect(verdict.refusal).toContain('cannot run a container')
    expect(verdict.refusal).toContain('failed to mount overlay')
    // Not the absence sentence: an operator sent to restart a daemon that is already serving
    // would find nothing wrong with it.
    expect(verdict.refusal).not.toContain('could not start')
  })

  it('carries a recorded success through when a container runs on it', async () => {
    expect(
      await resolveDockerVerdict(
        { available: true, source: 'rootless', reason: 'serving' },
        usable,
      ),
    ).toEqual({ available: true })
  })

  it('falls back to the boot record when the workload check could not be carried out', async () => {
    // "The check did not run" is a fact about the check. Reading it as a fact about the daemon
    // would trade the old lie for its mirror image and refuse a stand-up that works.
    expect(
      await resolveDockerVerdict(
        { available: true, source: 'external', reason: 'serving' },
        undeterminable,
      ),
    ).toEqual({ available: true })
  })
})
