import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createDockerWorkloadProbe,
  measureDockerWorkload,
  oneSlotArchiveMemo,
  reportedDockerWorkload,
  type DockerWorkloadDeps,
} from '../src/docker-capability.js'
import type { CommandOutcome } from '../src/docker-command.js'
import {
  buildProbeArchive,
  EGRESS_DNS_MARKER,
  EGRESS_TCP_MARKER,
  parseEgressTarget,
  payloadArchitecture,
  PROBE_IMAGE_TAG,
  PROBE_SENTINEL,
} from '../src/docker-probe-image.js'
import type { Logger } from '../src/logger.js'
import { silentLogger } from './helpers.js'

// Whether this machine's Docker daemon can RUN A CONTAINER, which is not what `docker info`
// answers. A rootless daemon nested in a sandbox serves happily while its snapshotter cannot
// mount a single image layer, so `docker build`, `docker run` and `docker pull` of anything
// multi-layer all fail with one EINVAL while every reachability check passes (issue #2120).
//
// The property nearly everything here defends is the ASYMMETRY of the three answers. Only the
// container RUN may produce `unusable`, and only where the DAEMON is what refused it; every step
// before it, and every failure of the platform's own payload, produces "I could not tell" and
// never "your daemon is broken". Getting that backwards would trade the original lie for its
// mirror image, and the agent reading the result is told not to re-check it either way.

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

/** What the daemon answers when asked its own architecture, which is the check's first step. */
const ARCH_ANSWER: CommandOutcome = { outcome: 'ran', code: 0, stdout: 'amd64\n', stderr: '' }
const RAN_CLEAN: CommandOutcome = { outcome: 'ran', code: 0, stdout: '', stderr: '' }
const RAN_PROBE: CommandOutcome = {
  outcome: 'ran',
  code: 0,
  stdout: `${PROBE_SENTINEL}\n`,
  stderr: '',
}

/** What the egress container prints when both observations came back with exit status $1/$2. */
function EGRESS(tcp: number, dns: number): CommandOutcome {
  return {
    outcome: 'ran',
    code: tcp === 0 && dns === 0 ? 0 : 1,
    stdout: `${EGRESS_TCP_MARKER}${tcp}\n${EGRESS_DNS_MARKER}${dns}\n`,
    stderr: '',
  }
}

/** A container that reached everything: the answer every case not about egress wants. */
const EGRESS_OK = EGRESS(0, 0)

/** Which docker command a set of argv is, including the TWO runs, which differ by network. */
type Step = 'version' | 'load' | 'run' | 'egress' | 'image'

function stepOf(args: string[]): Step {
  if (args[0] !== 'run') return args[0] as Step
  // Told apart by the argv the egress run OWNS: the shell script that prints its two markers.
  // Not by `--network none`, which belongs to the OTHER run and is the thing several cases here
  // assert about it. A heuristic reading that flag would silently swap the two the moment
  // someone wrote `--network=none`, and every assertion below would pass against the wrong
  // container while the suite still went green.
  return args.some((arg) => arg.includes(EGRESS_TCP_MARKER)) ? 'egress' : 'run'
}

/**
 * A runner that answers per docker subcommand, so a case states only the step it is about.
 * Anything unstated is a clean success, and `version` always names an architecture matching the
 * `x64` payload the deps below declare.
 */
function runner(
  table: Partial<Record<Step, CommandOutcome>> = {},
): DockerWorkloadDeps['runDocker'] {
  return async (args) => {
    const step = stepOf(args)
    if (table[step]) return table[step] as CommandOutcome
    if (step === 'version') return ARCH_ANSWER
    if (step === 'run') return RAN_PROBE
    if (step === 'egress') return EGRESS_OK
    return RAN_CLEAN
  }
}

/** Deps whose every answer a case states, so nothing here consults the machine it runs on. */
function deps(overrides: Partial<DockerWorkloadDeps> = {}): DockerWorkloadDeps {
  return {
    readPayload: async () => PAYLOAD,
    payloadPath: '/bin/busybox',
    runDocker: runner(),
    arch: 'x64',
    egress: { target: '203.0.113.9:443', dnsName: 'registry.example.com' },
    logger: silentLogger,
    ...overrides,
  }
}

/** A logger that keeps its warnings, for the cases whose whole point is that something was said. */
function recordingLogger(): { logger: Logger; warnings: { msg: string; fields?: object }[] } {
  const warnings: { msg: string; fields?: object }[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => {
      warnings.push({ msg, ...(fields ? { fields } : {}) })
    },
    error: () => {},
    child: () => logger,
  }
  return { logger, warnings }
}

describe('the probe image', () => {
  it('is a readable docker-archive whose layer digest is the one the config declares', () => {
    const archive = buildProbeArchive(PAYLOAD, 'amd64')
    const entries = readTar(archive)
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

  it('is byte-stable, which is what lets one archive be built per container', () => {
    expect(buildProbeArchive(PAYLOAD, 'amd64').equals(buildProbeArchive(PAYLOAD, 'amd64'))).toBe(
      true,
    )
  })

  it('names the architecture the PAYLOAD is built for, and refuses to invent one', () => {
    // The table maps this PROCESS's architecture, never the daemon's, and the caller compares the
    // two rather than declaring ours as the daemon's. An unmapped one yields nothing to compare.
    expect(payloadArchitecture('x64')).toBe('amd64')
    expect(payloadArchitecture('ia32')).toBe('386')
    expect(payloadArchitecture('mips')).toBeUndefined()
  })
})

describe('measuring what the daemon can do', () => {
  it('calls a daemon that ran the container and printed the marker USABLE', async () => {
    expect(await measureDockerWorkload(deps())).toEqual({
      status: 'usable',
      egress: { status: 'reachable' },
    })
  })

  it('runs the container with no network and no route to a registry', async () => {
    const runDocker = vi.fn(runner())
    await measureDockerWorkload(deps({ runDocker }))
    const run = runDocker.mock.calls.map((call) => call[0]).find((args) => stepOf(args) === 'run')
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
        runDocker: runner({
          run: {
            outcome: 'ran',
            code: 125,
            stdout: '',
            stderr:
              'docker: Error response from daemon: failed to mount ...: fstype: overlay, err: invalid argument',
          },
        }),
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
      const runDocker = vi.fn(
        runner({
          run: { outcome: 'ran', code, stdout: code === 0 ? PROBE_SENTINEL : '', stderr: 'boom' },
        }),
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

  it('says so when the cleanup failed, rather than discarding the outcome', async () => {
    // The daemon has two ordinary ways to refuse: a `--rm` teardown still holding the image, and
    // a wedged daemon that answers nothing. Both leave the image the line above promises an agent
    // will never find, so a silent outcome makes that promise unverifiable where it breaks.
    const { logger, warnings } = recordingLogger()
    const verdict = await measureDockerWorkload(
      deps({
        logger,
        runDocker: runner({
          image: {
            outcome: 'ran',
            code: 1,
            stdout: '',
            stderr: 'conflict: unable to delete cat-factory-docker-probe:1 (must be forced)',
          },
        }),
      }),
    )
    // The cleanup is not the verdict: the container ran.
    expect(verdict).toEqual({ status: 'usable', egress: { status: 'reachable' } })
    expect(warnings.map((w) => w.msg)).toContainEqual(
      'docker capability: the probe image could not be removed',
    )
    expect(JSON.stringify(warnings)).toContain('unable to delete')
  })

  it('does not give the cleanup the caller signal, since nobody else will clean up', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const runDocker: DockerWorkloadDeps['runDocker'] = async (args, opts) => {
      if (args[0] === 'image') seen.push(opts.signal)
      const step = stepOf(args)
      if (step === 'version') return ARCH_ANSWER
      if (step === 'run') return RAN_PROBE
      return step === 'egress' ? EGRESS_OK : RAN_CLEAN
    }
    const cancelled = new AbortController()
    await measureDockerWorkload(deps({ runDocker }), cancelled.signal)
    expect(seen).toEqual([undefined])
  })

  it('says it could not tell, NOT that the daemon is broken, when its own load fails', async () => {
    // The load step is the one this repo wrote itself. A malformed archive must never be able to
    // tell an agent that a working daemon cannot run containers.
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: runner({
          load: { outcome: 'ran', code: 1, stdout: '', stderr: 'invalid tar header' },
        }),
      }),
    )
    expect(verdict.status).toBe('unknown')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('invalid tar header') })
  })

  it.each([
    [126, 'could not be invoked'],
    [127, 'could not be invoked'],
  ])(
    'says it could not tell when the probe binary itself failed to run (exit %i)',
    async (code, sentence) => {
      // 126 and 127 are docker's codes for "the container's command could not be invoked / was
      // not found", and the container had to be created and STARTED to produce either. They are
      // facts about a binary this platform put in an image it built, so calling them `unusable`
      // would tell every agent, as a prohibition it is told not to re-check, that a daemon which
      // just started a container for us cannot start one.
      const verdict = await measureDockerWorkload(
        deps({
          runDocker: runner({
            run: { outcome: 'ran', code, stdout: '', stderr: 'exec /busybox: no such file' },
          }),
        }),
      )
      expect(verdict.status).toBe('unknown')
      expect(verdict).toMatchObject({ reason: expect.stringContaining(sentence) })
    },
  )

  it('says it could not tell when the image it loaded was not there to run', async () => {
    // Exit 125 is `docker run` itself failing, which covers BOTH the daemon refusing to create a
    // container (the verdict this exists for) and the tag not resolving, which is our own load
    // having produced nothing. Only what docker said separates them.
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: runner({
          run: {
            outcome: 'ran',
            code: 125,
            stdout: '',
            stderr: 'docker: Error response from daemon: No such image: cat-factory-docker-probe:1',
          },
        }),
      }),
    )
    expect(verdict.status).toBe('unknown')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('not there to be run') })
  })

  it('says it could not tell when the payload cannot execute on the daemon machine', async () => {
    // An architecture matched by name and not by ABI (a bare `arm` payload on an armv6 daemon).
    // The binary is ours, so this says nothing about what the daemon can run.
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: runner({
          run: {
            outcome: 'ran',
            code: 125,
            stdout: '',
            stderr: 'failed to create task for container: exec format error',
          },
        }),
      }),
    )
    expect(verdict.status).toBe('unknown')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('cannot be executed') })
  })

  it('says it could not tell when this machine has no payload to build an image from', async () => {
    // The native host transport (`LOCAL_NATIVE_AGENTS`), where the harness runs on a developer's
    // laptop that never saw this image. Docker there usually works, so an absence must not read
    // as a broken daemon.
    const verdict = await measureDockerWorkload(
      deps({
        readPayload: () => Promise.reject(Object.assign(new Error('boom'), { code: 'ENOENT' })),
        payloadPath: '/bin/busybox',
      }),
    )
    expect(verdict).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('/bin/busybox') as unknown as string,
    })
    expect(verdict).toMatchObject({ reason: expect.stringContaining('does not have') })
  })

  it.each([
    ['EACCES', 'not permitted to read'],
    ['EISDIR', 'to be a file'],
    ['EIO', 'could not be read'],
  ])('distinguishes a payload that failed to read for %s', async (code, sentence) => {
    // A misconfigured `HARNESS_DOCKER_PROBE_BINARY` is an operator's to fix, and the sentence
    // goes into an agent's system prompt and into `GET /health`. Asserting absence for every
    // cause states the opposite fact and throws the one detail away that names the fix.
    const verdict = await measureDockerWorkload(
      deps({ readPayload: () => Promise.reject(Object.assign(new Error('nope'), { code })) }),
    )
    expect(verdict.status).toBe('unknown')
    expect(verdict).toMatchObject({ reason: expect.stringContaining(sentence) })
    expect(verdict).not.toMatchObject({ reason: expect.stringContaining('does not have') })
  })

  it('says it could not tell on an architecture it has no payload for', async () => {
    const verdict = await measureDockerWorkload(deps({ arch: 'mips' }))
    expect(verdict.status).toBe('unknown')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('mips') })
  })

  it('says it could not tell when the container exits clean and prints nothing', async () => {
    // Nothing explains this, so it is a fact about the check. The marker on stdout is the whole
    // evidence that a process inside the container ran; an exit status is the daemon's word for it.
    const verdict = await measureDockerWorkload(deps({ runDocker: runner({ run: RAN_CLEAN }) }))
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
      daemonAnswered: false,
    })
  })

  it('answers rather than throwing when its own machinery falls over', async () => {
    // The thing this replaced was total by construction (a `try/catch` around one `execFile`),
    // and `standUpInfra` awaits it OUTSIDE the try that owns compose failures, on a path
    // documented as best-effort. A throw here would fail a job over the very mechanism whose
    // purpose is to explain a failure, so a throw is the platform's machinery breaking: unknown.
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: () => {
          throw new TypeError('spawn blew up')
        },
      }),
    )
    expect(verdict).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('spawn blew up'),
      daemonAnswered: false,
    })
  })
})

describe('which daemon the image is built for', () => {
  it('asks the DAEMON its architecture instead of assuming this process shares it', async () => {
    // An external `DOCKER_HOST` is a supported path: an arm64 harness against an amd64 sidecar,
    // or a remote x86_64 daemon from an arm64 laptop. Declaring OUR architecture there gets the
    // run refused, which would report a perfectly good daemon as one that cannot run containers.
    const runDocker = vi.fn(runner())
    await measureDockerWorkload(deps({ runDocker }))
    expect(runDocker.mock.calls[0]?.[0]).toEqual(['version', '--format', '{{.Server.Arch}}'])
  })

  it('builds the image for the architecture the daemon named', async () => {
    const loaded: Buffer[] = []
    const runDocker: DockerWorkloadDeps['runDocker'] = async (args, opts) => {
      if (args[0] === 'load' && opts.stdin) loaded.push(opts.stdin)
      const step = stepOf(args)
      if (step === 'version') return { outcome: 'ran', code: 0, stdout: 'arm64', stderr: '' }
      if (step === 'run') return RAN_PROBE
      return step === 'egress' ? EGRESS_OK : RAN_CLEAN
    }
    await measureDockerWorkload(deps({ runDocker, arch: 'arm64' }))
    const config = readTar(loaded[0] as Buffer).find((e) => e.name === 'config.json')
    expect(JSON.parse((config as { content: Buffer }).content.toString('utf8')).architecture).toBe(
      'arm64',
    )
  })

  it('says it could not tell when the payload is for another architecture than the daemon', async () => {
    // Nothing here can make an arm64 busybox run on an amd64 daemon, and refusing to try is the
    // whole point: the alternative is a run docker rejects, read as a broken daemon.
    const verdict = await measureDockerWorkload(
      deps({
        arch: 'arm64',
        runDocker: runner({ version: { outcome: 'ran', code: 0, stdout: 'amd64', stderr: '' } }),
      }),
    )
    expect(verdict).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('built for arm64 and this daemon runs amd64'),
      daemonAnswered: true,
    })
  })

  it('never starts a container when the architectures do not match', async () => {
    const runDocker = vi.fn(
      runner({ version: { outcome: 'ran', code: 0, stdout: 'amd64', stderr: '' } }),
    )
    await measureDockerWorkload(deps({ runDocker, arch: 'arm64' }))
    expect(runDocker.mock.calls.map((call) => call[0][0])).toEqual(['version'])
  })

  it('says it could not tell when the daemon names nothing usable', async () => {
    const verdict = await measureDockerWorkload(
      deps({
        runDocker: runner({ version: { outcome: 'ran', code: 0, stdout: '\n', stderr: '' } }),
      }),
    )
    expect(verdict).toMatchObject({ status: 'unknown', daemonAnswered: true })
  })
})

describe('what a check that could not be carried out still knows', () => {
  it('reports whether a daemon ANSWERED, because a stale boot record is read against it', async () => {
    // `resolveDockerVerdict` needs the cheap fact on the way past: a warm-pool container whose
    // sidecar came up after the entrypoint's bounded wait must not be latched into refusing local
    // infra for its whole life just because the workload check could not be carried out.
    const answered = await measureDockerWorkload(
      deps({
        readPayload: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })),
      }),
    )
    expect(answered).toMatchObject({ status: 'unknown', daemonAnswered: true })

    const silent = await measureDockerWorkload(
      deps({
        runDocker: runner({
          version: {
            outcome: 'ran',
            code: 1,
            stdout: '',
            stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
          },
        }),
      }),
    )
    expect(silent).toMatchObject({ status: 'unknown', daemonAnswered: false })
  })
})

describe('whether a container started here can reach the network', () => {
  // The half a local workload check structurally cannot see (issue #2174). Loading and running an
  // image the platform built needs no network, so a daemon whose nested containers are cut off
  // passes the marker run exactly as a working one does, and the harness said `usable` while every
  // `docker build` that fetched a dependency was guaranteed to fail. The rules below are what stop
  // this becoming the mirror-image lie: only a measurement from INSIDE a container may conclude
  // anything, and a check that could not be carried out concludes nothing.

  const egressOf = async (
    outcome: CommandOutcome,
    overrides: Partial<DockerWorkloadDeps> = {},
  ): Promise<unknown> => {
    const verdict = await measureDockerWorkload(
      deps({ runDocker: runner({ egress: outcome }), ...overrides }),
    )
    return verdict.status === 'usable' ? verdict.egress : verdict
  }

  it('runs the egress container on the DEFAULT network, unlike the marker run', async () => {
    // The two need opposite networking, which is why they cannot be one container: the marker run
    // is pinned to `--network none` so it answers about the daemon alone, and the bridge is
    // exactly what a daemon started with `--iptables=false` fails to NAT.
    const runDocker = vi.fn(runner())
    await measureDockerWorkload(deps({ runDocker }))
    const runs = runDocker.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'run')
    expect(runs).toHaveLength(2)
    expect(runs[1]).not.toContain('--network')
    expect(runs[1]).toContain('--pull')
    expect(runs[1]).toContain('never')
    expect(runs[1]?.join(' ')).toContain('203.0.113.9 443')
    expect(runs[1]?.join(' ')).toContain('registry.example.com')
  })

  it('calls a container that connected AND resolved REACHABLE', async () => {
    expect(await egressOf(EGRESS(0, 0))).toEqual({ status: 'reachable' })
  })

  it('calls a container that reached neither BLOCKED, and names what it tried', async () => {
    // Names the two addresses rather than claiming there is no route at all. The check aims at
    // the public internet by default, and a deployment that deliberately has none but runs an
    // internal mirror would otherwise read a confident "no route" about a `docker build` that
    // works there. What was measured is that these two are unreachable, and that is what it says.
    expect(await egressOf(EGRESS(1, 1))).toMatchObject({
      status: 'blocked',
      detail: expect.stringContaining('203.0.113.9:443'),
    })
    expect((await egressOf(EGRESS(1, 1))) as { detail: string }).toMatchObject({
      detail: expect.stringContaining('registry.example.com'),
    })
  })

  it('separates a daemon that refused the egress container from one that printed nothing', async () => {
    // Both leave the two markers unread, and they need different words: a 125 means the container
    // never started, so nothing measured the network, where a container that started and printed
    // something unrecognisable is the platform's own payload misbehaving. Sending an operator to
    // read the check's output for a container that produced none is the wrong errand.
    expect(
      await egressOf({ outcome: 'ran', code: 125, stdout: '', stderr: 'network bridge not found' }),
    ).toMatchObject({
      status: 'undetermined',
      reason: expect.stringContaining('did not start'),
    })
  })

  it('calls a working route with broken DNS blocked, and names DNS as the half to fix', async () => {
    // Not `reachable`: nothing an agent installs is fetched by address, so a build that fetches
    // anything fails here exactly as it does with no route. The two have different fixes, so the
    // detail has to say which one this is.
    const verdict = await egressOf(EGRESS(0, 1))
    expect(verdict).toMatchObject({ status: 'blocked' })
    expect((verdict as { detail: string }).detail).toContain('DNS does not')
  })

  it('will not condemn a container that resolved but could not reach the configured address', async () => {
    // A resolved name proves a path out exists, so the connect failing is about the ADDRESS far
    // more often than about the network: a deployment that filters egress to everything but its
    // own mirrors is the ordinary case. Reporting `blocked` there would have the platform tell an
    // agent to stop trying on evidence that says nothing of the kind.
    expect(await egressOf(EGRESS(1, 0))).toMatchObject({
      status: 'undetermined',
      reason: expect.stringContaining('HARNESS_DOCKER_EGRESS_TARGET'),
    })
  })

  it("reads a missing applet as the platform's own gap, never as an absent network", async () => {
    // busybox exits 127 for an applet it was not built with. That is a fact about the image this
    // repo assembles, and reporting it as no egress would be this module condemning a working
    // sandbox over its own payload: the same asymmetry the daemon verdict is built on.
    expect(await egressOf(EGRESS(127, 127))).toMatchObject({
      status: 'undetermined',
      reason: expect.stringContaining('probe container'),
    })
  })

  it('says it could not tell when the container printed no verdict at all', async () => {
    expect(
      await egressOf({ outcome: 'ran', code: 0, stdout: 'hello\n', stderr: '' }),
    ).toMatchObject({
      status: 'undetermined',
      reason: expect.stringContaining('printed no verdict'),
    })
  })

  it('says it could not tell when the egress container never ran', async () => {
    expect(
      await egressOf({ outcome: 'failed', reason: '`docker run` did not answer within 20s' }),
    ).toMatchObject({ status: 'undetermined', reason: expect.stringContaining('did not answer') })
  })

  it('does not measure egress at all on a daemon that could not run the container', async () => {
    // There is nothing to measure it ON, and asking would spend a second container start to
    // rediscover the verdict already reached.
    const runDocker = vi.fn(
      runner({ run: { outcome: 'ran', code: 125, stdout: '', stderr: 'cannot mount' } }),
    )
    const verdict = await measureDockerWorkload(deps({ runDocker }))
    expect(verdict.status).toBe('unusable')
    expect(runDocker.mock.calls.map((call) => stepOf(call[0]))).not.toContain('egress')
  })

  it('reports a misconfigured target rather than quietly using the default', async () => {
    // An operator who pointed this at an address their network permits is entitled to find out
    // that it was rejected, and a target that is quietly wrong produces a confident `blocked`
    // about a daemon that is fine.
    const runDocker = vi.fn(runner())
    const verdict = await measureDockerWorkload(
      deps({
        runDocker,
        egress: { target: 'proxy.internal:443', dnsName: 'registry.example.com' },
      }),
    )
    expect(verdict).toMatchObject({
      status: 'usable',
      egress: { status: 'undetermined', reason: expect.stringContaining('IPv4:port') },
    })
    expect(runDocker.mock.calls.map((call) => stepOf(call[0]))).not.toContain('egress')
  })

  it('refuses every target shape that could not be evidence, or could not be safely run', async () => {
    // The host and the name are interpolated into a `sh -c` script inside the probe container,
    // so anything that is not an address and a hostname is refused before it gets there. A NAME
    // is refused for a second reason that is not about safety at all: a connect that has to
    // resolve first cannot separate a broken route from broken DNS, which is the whole split.
    for (const bad of [
      'registry.example.com:443',
      '1.1.1.1',
      '1.1.1.1:0',
      '1.1.1.1:99999',
      '1.1.1.1:443:443',
      '1.1.1.1:$(id)',
      '999.1.1.1:443',
    ]) {
      expect(parseEgressTarget(bad, 'registry.example.com'), bad).toHaveProperty('invalid')
    }
    for (const bad of ['not a host', 'localhost', 'registry.example.com; id', '']) {
      expect(parseEgressTarget('1.1.1.1:443', bad), bad).toHaveProperty('invalid')
    }
    expect(parseEgressTarget('1.1.1.1:443', 'registry.npmjs.org')).toEqual({
      target: { host: '1.1.1.1', port: 443, dnsName: 'registry.npmjs.org' },
    })
  })
})

describe('what one measurement is allowed to cost', () => {
  it('shares ONE budget out across its commands rather than one ceiling each', async () => {
    // Three commands at a per-command ceiling multiply into a minute and a half of dead time on a
    // wedged daemon, on the critical path ahead of the clone. The budget is for the whole pass, so
    // each command asks for what is left of it.
    const budgets = new Map<Step, number>()
    const runDocker: DockerWorkloadDeps['runDocker'] = async (args, opts) => {
      const step = stepOf(args)
      budgets.set(step, opts.timeoutMs)
      if (step === 'version') return ARCH_ANSWER
      if (step === 'run') return RAN_PROBE
      return step === 'egress' ? EGRESS_OK : RAN_CLEAN
    }
    await measureDockerWorkload(deps({ runDocker }))
    const shared = (['version', 'load', 'run'] as const).map((step) => budgets.get(step) as number)
    expect(shared).toHaveLength(3)
    for (const [index, budget] of shared.entries()) {
      expect(budget).toBeGreaterThan(0)
      expect(budget).toBeLessThanOrEqual(shared[0] as number)
      if (index > 0) expect(budget).toBeLessThanOrEqual(shared[index - 1] as number)
    }
  })

  it('gives the egress container its OWN budget rather than what is left of that one', async () => {
    // The argument for sharing is that per-command ceilings multiply on a WEDGED daemon, and it
    // does not reach the egress run: by then another container has already run to completion, so
    // the daemon is known to work. What that step DOES need is room to be slow in the failing
    // case, since a blocked route expires two in-container timeouts rather than being refused.
    // Taking that out of the shared budget would starve the step this whole check exists for.
    const budgets = new Map<Step, number>()
    const slow: DockerWorkloadDeps['runDocker'] = async (args, opts) => {
      const step = stepOf(args)
      budgets.set(step, opts.timeoutMs)
      if (step === 'version') {
        // Spend some of the shared budget, so the run that follows visibly has less of it left.
        await new Promise((resolve) => setTimeout(resolve, 50))
        return ARCH_ANSWER
      }
      if (step === 'run') return RAN_PROBE
      return step === 'egress' ? EGRESS_OK : RAN_CLEAN
    }
    await measureDockerWorkload(deps({ runDocker: slow }))
    expect(budgets.get('run')).toBeLessThan(budgets.get('version') as number)
    expect(budgets.get('egress')).toBeGreaterThan(budgets.get('run') as number)
  })

  it('hands the caller signal to every command it makes on the job path', async () => {
    const cancelled = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    const runDocker: DockerWorkloadDeps['runDocker'] = async (args, opts) => {
      const step = stepOf(args)
      if (step !== 'image') seen.push(opts.signal)
      if (step === 'version') return ARCH_ANSWER
      if (step === 'run') return RAN_PROBE
      return step === 'egress' ? EGRESS_OK : RAN_CLEAN
    }
    await measureDockerWorkload(deps({ runDocker }), cancelled.signal)
    // Four, and the fourth is the egress container: it is a container start like any other, so a
    // job abandoned while it runs must stop paying for it too.
    expect(seen).toEqual(Array.from({ length: 4 }, () => cancelled.signal))
  })

  it('reads the payload once per container rather than per measurement', async () => {
    // The archive is byte-stable for one (payload, architecture) pair by construction, and a
    // NEGATIVE verdict is deliberately re-measured, so without the memo the same two megabytes
    // are re-read and re-hashed on every pass for a value that cannot differ.
    const readPayload = vi.fn(async () => PAYLOAD)
    const shared = deps({
      readPayload,
      archives: oneSlotArchiveMemo(),
      runDocker: runner({ run: { outcome: 'ran', code: 1, stdout: '', stderr: 'no' } }),
    })
    await measureDockerWorkload(shared)
    await measureDockerWorkload(shared)
    expect(readPayload).toHaveBeenCalledTimes(1)
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
          if (args[0] === 'version') return ARCH_ANSWER
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
          const step = stepOf(args)
          if (step === 'run') succeeded += 1
          if (step === 'version') return ARCH_ANSWER
          if (step === 'run') return RAN_PROBE
          return step === 'egress' ? EGRESS_OK : RAN_CLEAN
        },
      }),
    )
    await working()
    await working()
    expect(succeeded).toBe(1)
  })

  /** Count the egress containers a probe starts while answering `calls` times over. */
  const egressRunsOver = async (
    calls: number,
    answers: (nth: number) => CommandOutcome,
  ): Promise<{ runs: number; last: unknown }> => {
    let runs = 0
    const probe = createDockerWorkloadProbe(
      deps({
        runDocker: async (args) => {
          const step = stepOf(args)
          if (step === 'version') return ARCH_ANSWER
          if (step === 'run') return RAN_PROBE
          if (step !== 'egress') return RAN_CLEAN
          runs += 1
          return answers(runs)
        },
      }),
    )
    let last: unknown
    for (let i = 0; i < calls; i += 1) last = await probe()
    return { runs, last }
  }

  it('re-measures a usable daemon whose EGRESS could still answer differently', async () => {
    // Whether the bridge is NATed is settled for the daemon's life, so a measured `reachable` or
    // `blocked` is kept with the verdict. A check that TIMED OUT measured nothing, and latching
    // that would leave the container permanently unable to say which of the two it is, which is
    // the same rule the negative verdict above is kept under.
    const timedOut: CommandOutcome = {
      outcome: 'failed',
      reason: '`docker run` did not answer within 20s',
    }
    const { runs, last } = await egressRunsOver(3, (nth) => (nth === 1 ? timedOut : EGRESS(1, 1)))
    expect(last).toMatchObject({ egress: { status: 'blocked' } })
    expect(runs).toBe(2)
  })

  it('latches an undetermined egress whose cause cannot change under a running container', async () => {
    // The other half of the same rule, and the one that costs real time when it is missing. A
    // payload with no `nc` applet, a rejected target setting and an address this deployment
    // filters all answer identically on every job, so re-measuring never converges, and
    // re-measuring is `docker version`, the archive, `docker load`, TWO container starts and an
    // `image rm`, per job, on the critical path ahead of the clone.
    const { runs, last } = await egressRunsOver(3, () => EGRESS(127, 127))
    expect(last).toMatchObject({ egress: { status: 'undetermined', recheck: false } })
    expect(runs).toBe(1)
  })

  it('latches a rejected target setting without starting a container to re-read it', async () => {
    let measurements = 0
    const probe = createDockerWorkloadProbe(
      deps({
        runDocker: async (args) => {
          if (stepOf(args) === 'version') measurements += 1
          return stepOf(args) === 'version' ? ARCH_ANSWER : RAN_PROBE
        },
        egress: { target: 'proxy.internal:443', dnsName: 'registry.example.com' },
      }),
    )
    await probe()
    await probe()
    expect(measurements).toBe(1)
  })

  it('shares one measurement between concurrent callers', async () => {
    // Two jobs in one warm container ask at the same time. Each starting its own container would
    // double the cost of the answer and race over the same image tag.
    let started = 0
    const probe = createDockerWorkloadProbe(
      deps({
        runDocker: async (args) => {
          const step = stepOf(args)
          if (step === 'version') return ARCH_ANSWER
          if (step === 'run') started += 1
          await new Promise((resolve) => setTimeout(resolve, 5))
          if (step === 'run') return RAN_PROBE
          return step === 'egress' ? EGRESS_OK : RAN_CLEAN
        },
      }),
    )
    await Promise.all([probe(), probe(), probe()])
    expect(started).toBe(1)
  })

  it('stops waiting for a measurement the caller job has abandoned', async () => {
    // The check is on the critical path ahead of the clone. A cancelled run must not sit on a
    // wedged daemon for the rest of the budget with its first turn blocked behind it.
    const cancelled = new AbortController()
    const probe = createDockerWorkloadProbe(
      deps({
        runDocker: async (args) => {
          if (args[0] === 'version') return ARCH_ANSWER
          return await new Promise(() => {}) // a wedged daemon: never answers
        },
      }),
    )
    const pending = probe(cancelled.signal)
    cancelled.abort()
    expect(await pending).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('cancelled'),
    })
  })

  it('cancels the measurement once the LAST caller has abandoned it', async () => {
    // Both halves matter: a measurement nobody awaits is a container start no job will read, and
    // one job's abort may not kill a measurement a sibling is still waiting on (the local native
    // transport serves every concurrent job from one process).
    const first = new AbortController()
    const second = new AbortController()
    let observed: AbortSignal | undefined
    const probe = createDockerWorkloadProbe(
      deps({
        runDocker: async (args, opts) => {
          if (args[0] === 'version') return ARCH_ANSWER
          observed = opts.signal
          return await new Promise(() => {})
        },
      }),
    )
    const a = probe(first.signal)
    const b = probe(second.signal)
    first.abort()
    await a
    expect(observed?.aborted).toBe(false)
    second.abort()
    await b
    expect(observed?.aborted).toBe(true)
  })

  it('reports the last verdict to /health without taking a measurement', async () => {
    // /health is polled from boot. A probe per poll would start a container per poll to answer a
    // question this endpoint does not act on, so "nothing has asked yet" is its own word rather
    // than an omitted key that reads as a build which cannot report one.
    const runDocker = vi.fn(runner())
    const probe = createDockerWorkloadProbe(deps({ runDocker }))
    expect(reportedDockerWorkload(probe)).toEqual({
      status: 'unmeasured',
      reason: expect.stringContaining('has needed the docker daemon yet') as unknown as string,
    })
    expect(runDocker).not.toHaveBeenCalled()

    await probe()
    expect(reportedDockerWorkload(probe)).toEqual({
      status: 'usable',
      egress: { status: 'reachable' },
    })
  })
})
