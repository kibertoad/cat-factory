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
import { silentLogger } from './helpers.js'

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
  const usable = (): Promise<DockerWorkload> =>
    Promise.resolve({ status: 'usable', egress: { status: 'reachable' } })
  const unusable = (): Promise<DockerWorkload> =>
    Promise.resolve({ status: 'unusable', detail: 'failed to mount overlay: invalid argument' })
  /** The check could not be carried out, and it never reached a daemon on the way. */
  const nothingAnswered = (): Promise<DockerWorkload> =>
    Promise.resolve({
      status: 'unknown',
      reason: 'the docker CLI is not on PATH',
      daemonAnswered: false,
    })
  /** The check could not be carried out, but a daemon DID answer first. */
  const answeredOnly = (): Promise<DockerWorkload> =>
    Promise.resolve({
      status: 'unknown',
      reason: 'the platform ships no probe payload here',
      daemonAnswered: true,
    })

  it('refuses a recorded absence nothing live contradicts', async () => {
    const verdict = await resolveDockerVerdict(
      { available: false, source: 'rootless', reason: 'failed', detail: 'rootlesskit: no ip' },
      { probe: nothingAnswered },
    )
    expect(verdict.available).toBe(false)
    expect(verdict.refusal).toContain('rootlesskit: no ip')
    // Nothing answered, so nothing may claim a daemon was there either.
    expect(verdict.daemon).toBeUndefined()
  })

  it('lets a daemon that came up after boot overrule the recorded absence', async () => {
    // The warm-pool case. The entrypoint probes ONCE, within a bounded wait; a container serves
    // many jobs. A sidecar that needed longer than that wait is serving perfectly well by the
    // second job, and refusing off the boot record alone would latch this container into refusing
    // local infra that works, for its whole life.
    const verdict = await resolveDockerVerdict(
      { available: false, source: 'external', reason: 'unreachable' },
      { probe: usable },
    )
    expect(verdict).toMatchObject({ available: true, daemon: true })
  })

  it('lets a daemon that merely ANSWERED overrule the recorded absence too', async () => {
    // The regression this pins. The check that replaced `docker version` can come back
    // undeterminable for four reasons that say nothing about whether a daemon is up (no payload
    // in this image variant, an architecture it is not built for, a `docker load` the engine
    // refuses, a timeout). Falling straight back to the boot record there re-latches exactly the
    // stale refusal the case above rules out, for the whole life of the container.
    const verdict = await resolveDockerVerdict(
      { available: false, source: 'external', reason: 'unreachable' },
      { probe: answeredOnly },
    )
    expect(verdict).toMatchObject({ available: true, daemon: true })
    expect(verdict.refusal).toBeUndefined()
  })

  it('leaves an undecided verdict undecided rather than probing it into a refusal', async () => {
    const probe = vi.fn(unusable)
    const verdict = await resolveDockerVerdict(
      { available: undefined, source: 'rootless', reason: 'probing' },
      { probe },
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
      { probe: unusable },
    )
    expect(verdict.available).toBe(false)
    expect(verdict.refusal).toContain('cannot run a container')
    expect(verdict.refusal).toContain('failed to mount overlay')
    // Not the absence sentence: an operator sent to restart a daemon that is already serving
    // would find nothing wrong with it. The verdict says so structurally as well as in prose.
    expect(verdict.refusal).not.toContain('could not start')
    expect(verdict.daemon).toBe(true)
  })

  it('carries a recorded success through when a container runs on it', async () => {
    expect(
      await resolveDockerVerdict(
        { available: true, source: 'rootless', reason: 'serving' },
        { probe: usable },
      ),
    ).toMatchObject({ available: true, daemon: true })
  })

  it('falls back to the boot record only when nothing answered at all', async () => {
    // "The check did not run" is a fact about the check. Reading it as a fact about the daemon
    // would trade the old lie for its mirror image and refuse a stand-up that works.
    const verdict = await resolveDockerVerdict(
      { available: true, source: 'external', reason: 'serving' },
      { probe: nothingAnswered },
    )
    expect(verdict.available).toBe(true)
    // Nothing answered, so nothing claims a daemon was reached: the boot record's word is a
    // hypothesis, and a record that repeated it as a live fact would be the guess this avoids.
    expect(verdict.daemon).toBeUndefined()
  })

  it('hands the job signal to the live check', async () => {
    // The check starts a CONTAINER, so a cancelled run must stop paying for it rather than hold
    // the daemon for the rest of its budget with the job's first turn blocked behind it.
    const cancelled = new AbortController()
    const probe = vi.fn(usable)
    await resolveDockerVerdict(
      { available: true, source: 'rootless', reason: 'serving' },
      { probe, signal: cancelled.signal },
    )
    expect(probe).toHaveBeenCalledWith(cancelled.signal)
  })

  it('answers off the boot record when the live check THROWS', async () => {
    // The default probe is total by construction, but this is the seam an injected one arrives
    // through and the caller is a stand-up documented as best-effort: a throw here would fail a
    // job over the mechanism whose whole purpose is to make a failure legible. A throw settles
    // nothing, so it is the same value as any other check that could not be carried out.
    const verdict = await resolveDockerVerdict(
      { available: false, source: 'none', reason: 'missing' },
      {
        probe: () => {
          throw new Error('the probe blew up')
        },
        logger: silentLogger,
      },
    )
    expect(verdict.available).toBe(false)
    expect(verdict.refusal).toContain('ships no Docker daemon')
  })
})
