import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createDockerWorkloadProbe,
  measureDockerWorkload,
  reportedDockerWorkload,
  type DockerWorkloadDeps,
} from '../src/docker-capability.js'
import {
  buildProbeArchive,
  dockerArchitecture,
  PROBE_IMAGE_TAG,
  PROBE_SENTINEL,
} from '../src/docker-probe-image.js'

// Whether this machine's Docker daemon can RUN A CONTAINER, which is not what `docker info`
// answers. A rootless daemon nested in a sandbox serves happily while its snapshotter cannot
// mount a single image layer, so `docker build`, `docker run` and `docker pull` of anything
// multi-layer all fail with one EINVAL while every reachability check passes (issue #2120).
//
// The property nearly everything here defends is the ASYMMETRY of the three answers. Only the
// container RUN may produce `unusable`, because only it is evidence about the daemon; every step
// before it is the platform's own machinery, and a bug in that must be able to say "I could not
// tell" and never "your daemon is broken". Getting that backwards would trade the original lie
// for its mirror image, and the agent reading the result is told not to re-check it either way.

/** Minimal tar reader: enough to prove `docker load` gets a well-formed archive back. */
function readTar(archive: Buffer): { name: string; content: Buffer }[] {
  const entries: { name: string; content: Buffer }[] = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) break
    // The checksum is over the header with its own eight bytes read as spaces. Verified rather
    // than assumed: a writer that sums its own checksum field produces headers every reader
    // rejects, and `docker load` reports that as an unreadable archive rather than as a bug here.
    const claimed = Number.parseInt(
      header.subarray(148, 156).toString('latin1').replace(/\0.*$/, '').trim(),
      8,
    )
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0)
    expect(sum).toBe(claimed)
    expect(header.subarray(257, 262).toString('latin1')).toBe('ustar')
    const size = Number.parseInt(
      header.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim(),
      8,
    )
    const start = offset + 512
    entries.push({ name, content: archive.subarray(start, start + size) })
    offset = start + Math.ceil(size / 512) * 512
  }
  return entries
}

const PAYLOAD = Buffer.from('a statically linked binary, for the purposes of this suite')

/** Deps whose every answer a case states, so nothing here consults the machine it runs on. */
function deps(overrides: Partial<DockerWorkloadDeps> = {}): DockerWorkloadDeps {
  return {
    readPayload: async () => PAYLOAD,
    payloadPath: '/bin/busybox',
    runDocker: async (args) =>
      args[0] === 'run'
        ? { outcome: 'ran', code: 0, stdout: `${PROBE_SENTINEL}\n`, stderr: '' }
        : { outcome: 'ran', code: 0, stdout: '', stderr: '' },
    arch: 'x64',
    ...overrides,
  }
}

describe('the probe image', () => {
  it('is a readable docker-archive whose layer digest is the one the config declares', () => {
    const archive = buildProbeArchive(PAYLOAD, 'x64')
    expect(archive).toBeDefined()
    const entries = readTar(archive as Buffer)
    expect(entries.map((e) => e.name)).toEqual(['config.json', 'layer.tar', 'manifest.json'])

    const [configEntry, layerEntry, manifestEntry] = entries as [
      { name: string; content: Buffer },
      { name: string; content: Buffer },
      { name: string; content: Buffer },
    ]
    const layer = layerEntry.content
    const config = JSON.parse(configEntry.content.toString('utf8'))
    // `rootfs.diff_ids` means the sha256 of the UNCOMPRESSED layer tar. An engine that disagrees
    // refuses the load, and the caller then reports could-not-determine on a daemon that works.
    expect(config.rootfs.diff_ids).toEqual([
      `sha256:${createHash('sha256').update(layer).digest('hex')}`,
    ])
    expect(config.architecture).toBe('amd64')

    const manifest = JSON.parse(manifestEntry.content.toString('utf8'))
    expect(manifest).toEqual([
      { Config: 'config.json', RepoTags: [PROBE_IMAGE_TAG], Layers: ['layer.tar'] },
    ])
    // The payload is in the layer, at the path the run command names.
    expect(readTar(layer).map((e) => e.name)).toEqual(['busybox'])
  })

  it('refuses an architecture it cannot name rather than guessing one', () => {
    // A config whose `architecture` does not match the daemon's is refused at run time, so a guess
    // here would report a perfectly good daemon as one that cannot run containers.
    expect(dockerArchitecture('mips')).toBeUndefined()
    expect(buildProbeArchive(PAYLOAD, 'mips')).toBeUndefined()
  })
})

describe('measuring what the daemon can do', () => {
  it('calls a daemon that ran the container and printed the marker USABLE', async () => {
    expect(await measureDockerWorkload(deps())).toEqual({ status: 'usable' })
  })

  it('runs the container with no network and no route to a registry', async () => {
    const runDocker = vi.fn(deps().runDocker)
    await measureDockerWorkload(deps({ runDocker }))
    const run = runDocker.mock.calls.map((call) => call[0]).find((args) => args[0] === 'run')
    expect(run).toContain('--network')
    expect(run).toContain('none')
    // Without this, a load that silently produced no image sends the check to a registry, and the
    // verdict then describes the network rather than the daemon.
    expect(run).toContain('--pull')
    expect(run).toContain('never')
    expect(run).toContain(PROBE_IMAGE_TAG)
  })

  it('calls a daemon that could not run the container UNUSABLE, with what it said', async () => {
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: async (args) =>
          args[0] === 'run'
            ? {
                outcome: 'ran',
                code: 125,
                stdout: '',
                stderr:
                  'docker: Error response from daemon: failed to mount ...: fstype: overlay, err: invalid argument',
              }
            : { outcome: 'ran', code: 0, stdout: '', stderr: '' },
      }),
    )
    expect(verdict.status).toBe('unusable')
    expect(verdict).toMatchObject({ detail: expect.stringContaining('err: invalid argument') })
  })

  it('removes its own image whatever the verdict was', async () => {
    // An agent that lists images should not have to wonder whose `cat-factory-docker-probe` this
    // is, and a probe that leaves one behind on the failing path is the one that leaves it behind
    // most often.
    for (const code of [0, 125]) {
      const runDocker = vi.fn<DockerWorkloadDeps['runDocker']>(async (args) =>
        args[0] === 'run'
          ? { outcome: 'ran', code, stdout: code === 0 ? PROBE_SENTINEL : '', stderr: 'boom' }
          : { outcome: 'ran', code: 0, stdout: '', stderr: '' },
      )
      await measureDockerWorkload(deps({ runDocker }))
      expect(runDocker.mock.calls.map((call) => call[0])).toContainEqual([
        'image',
        'rm',
        '-f',
        PROBE_IMAGE_TAG,
      ])
    }
  })

  it('says it could not tell, NOT that the daemon is broken, when its own load fails', async () => {
    // The load step is the one this repo wrote itself. A malformed archive must never be able to
    // tell an agent that a working daemon cannot run containers.
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: async (args) =>
          args[0] === 'load'
            ? { outcome: 'ran', code: 1, stdout: '', stderr: 'invalid tar header' }
            : { outcome: 'ran', code: 0, stdout: PROBE_SENTINEL, stderr: '' },
      }),
    )
    expect(verdict.status).toBe('unknown')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('invalid tar header') })
  })

  it('says it could not tell when this machine has no payload to build an image from', async () => {
    // The native host transport (`LOCAL_NATIVE_AGENTS`), where the harness runs on a developer's
    // laptop that never saw this image. Docker there usually works, so an absence must not read
    // as a broken daemon.
    const verdict = await measureDockerWorkload(
      deps({
        readPayload: () => Promise.reject(new Error('ENOENT')),
        payloadPath: '/bin/busybox',
      }),
    )
    expect(verdict).toEqual({
      status: 'unknown',
      reason: expect.stringContaining('/bin/busybox') as unknown as string,
    })
  })

  it('says it could not tell on an architecture it has no image for', async () => {
    const verdict = await measureDockerWorkload(deps({ arch: 'mips' }))
    expect(verdict.status).toBe('unknown')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('mips') })
  })

  it('says it could not tell when the container exits clean and prints nothing', async () => {
    // Nothing explains this, so it is a fact about the check. The marker on stdout is the whole
    // evidence that a process inside the container ran; an exit status is the daemon's word for it.
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: async () => ({ outcome: 'ran', code: 0, stdout: '', stderr: '' }),
      }),
    )
    expect(verdict.status).toBe('unknown')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('without printing its marker'),
    })
  })

  it('says it could not tell when docker itself is not there', async () => {
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: async () => ({ outcome: 'failed', reason: 'the docker CLI is not on PATH' }),
      }),
    )
    expect(verdict).toEqual({
      status: 'unknown',
      reason: expect.stringContaining('the docker CLI is not on PATH') as unknown as string,
    })
  })
})

describe('measuring at most once per container', () => {
  it('keeps a positive verdict and re-measures a negative one', async () => {
    // A daemon that has run a container proved something that does not stop being true. A daemon
    // that had not finished starting when the first job landed has not, and latching that would
    // deny a warm-pool container docker for the rest of its life, which is the rule the boot record
    // is read under (`resolveDockerVerdict`).
    let ran = 0
    const failing = createDockerWorkloadProbe(
      deps({
        runDocker: async (args) => {
          if (args[0] === 'run') ran += 1
          return { outcome: 'ran', code: args[0] === 'run' ? 1 : 0, stdout: '', stderr: 'no' }
        },
      }),
    )
    await failing()
    await failing()
    expect(ran).toBe(2)

    let succeeded = 0
    const working = createDockerWorkloadProbe(
      deps({
        runDocker: async (args) => {
          if (args[0] === 'run') succeeded += 1
          return { outcome: 'ran', code: 0, stdout: PROBE_SENTINEL, stderr: '' }
        },
      }),
    )
    await working()
    await working()
    expect(succeeded).toBe(1)
  })

  it('shares one measurement between concurrent callers', async () => {
    // Two jobs in one warm container ask at the same time. Each starting its own container would
    // double the cost of the answer and race over the same image tag.
    let started = 0
    const probe = createDockerWorkloadProbe(
      deps({
        runDocker: async (args) => {
          if (args[0] === 'run') started += 1
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { outcome: 'ran', code: 0, stdout: PROBE_SENTINEL, stderr: '' }
        },
      }),
    )
    await Promise.all([probe(), probe(), probe()])
    expect(started).toBe(1)
  })

  it('reports the last verdict to /health without taking a measurement', async () => {
    // /health is polled from boot. A probe per poll would start a container per poll to answer a
    // question this endpoint does not act on, so "nothing has asked yet" is its own word rather
    // than an omitted key that reads as a build which cannot report one.
    const runDocker = vi.fn(deps().runDocker)
    const probe = createDockerWorkloadProbe(deps({ runDocker }))
    expect(reportedDockerWorkload(probe)).toEqual({
      status: 'unmeasured',
      reason: expect.stringContaining('has needed the docker daemon yet') as unknown as string,
    })
    expect(runDocker).not.toHaveBeenCalled()

    await probe()
    expect(reportedDockerWorkload(probe)).toEqual({ status: 'usable' })
  })
})
