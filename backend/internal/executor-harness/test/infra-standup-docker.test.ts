import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { standUpInfra } from '../src/infra-standup.js'
import { silentLogger } from './helpers.js'
import type { DockerWorkload } from '../src/docker-capability.js'

// The Tester's local docker-compose stand-up against the container's OWN verdict about its Docker
// daemon. For months the image shipped with no `dockerd` binary at all and this path ran compose
// anyway, so every local-infra Tester run degraded to a no-infra run whose only trace was a
// connection error in a prompt note. The stand-up now refuses a DECIDED negative and says why;
// just as importantly, it still attempts when nothing has decided (the native host transport runs
// this harness with no entrypoint to probe, on a machine where Docker usually works).
//
// "Negative" covers two facts and they are asserted apart: nothing is answering here, and
// something is answering here that cannot run a container. The second is issue #2120, and the
// boot record cannot see it at all, because all it ever probed for was a socket.

async function withStatus(contents: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-standup-status-'))
  const path = join(dir, 'status.json')
  await writeFile(path, contents, 'utf8')
  vi.stubEnv('HARNESS_DOCKER_STATUS_FILE', path)
}

const infra = { environment: 'local' as const, composePath: 'docker-compose.yml' }

/**
 * A refusal rests on a LIVE daemon check, not on the boot record alone, so every case below says
 * what the probe answers. Injected rather than mocked away because the CI runner this suite runs
 * on has a working daemon of its own: without it, "the image has no daemon" would be contradicted
 * by the host and the assertions would swap meaning depending on where they ran.
 */
const noDaemon = (): Promise<DockerWorkload> =>
  Promise.resolve({
    status: 'unknown',
    reason: 'the docker CLI is not on PATH',
    daemonAnswered: false,
  })

/**
 * What the two ATTEMPT cases below are allowed to take.
 *
 * They are the only ones here that reach the real `docker compose`, because "the attempt was made"
 * is the whole assertion and the compose exec has no injection seam. That spawns the docker CLI
 * against whatever daemon the machine has, and on a shared CI runner the cold start of that pair
 * does not fit in vitest's 5s default: the case then reports a timeout instead of what it went
 * looking for. Sized for the SPAWN, not for compose doing any work, since the compose file does
 * not exist and the command fails as soon as it has read the directory.
 */
const ATTEMPT_TIMEOUT_MS = 30_000

describe('standUpInfra against the container docker verdict', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses, and names the cause, when the image has no daemon', async () => {
    await withStatus('{"available":false,"source":"none","reason":"missing"}')
    const result = await standUpInfra(tmpdir(), infra, undefined, silentLogger, noDaemon)
    expect(result.started).toBe(false)
    expect(result.record?.dockerAvailable).toBe(false)
    // The exact cause, not a compose connection error: this is what tells a human the fix is the
    // executor image rather than the service's compose file.
    expect(result.record?.error).toBe(
      'the dependencies could not be started: this executor image ships no Docker daemon',
    )
    expect(result.note).toContain('this executor image ships no Docker daemon')
    expect(result.record?.composePath).toBe('docker-compose.yml')
  })

  it('carries the recorded detail into the refusal', async () => {
    await withStatus(
      '{"available":false,"source":"rootless","reason":"failed","detail":"rootlesskit: no ip"}',
    )
    const result = await standUpInfra(tmpdir(), infra, undefined, silentLogger, noDaemon)
    expect(result.record?.error).toContain('rootlesskit: no ip')
  })

  it(
    'still attempts when no verdict was recorded, and claims nothing about the daemon',
    async () => {
      vi.stubEnv('HARNESS_DOCKER_STATUS_FILE', join(tmpdir(), 'cf-no-such-status.json'))
      // The compose file does not exist, so the attempt fails. The point is that it was MADE, and
      // that the record does not assert a daemon verdict this container never reached.
      const result = await standUpInfra(tmpdir(), infra, undefined, silentLogger, noDaemon)
      expect(result.started).toBe(false)
      expect(result.record?.dockerAvailable).toBeUndefined()
      expect(result.record?.error).not.toContain('ships no Docker daemon')
    },
    ATTEMPT_TIMEOUT_MS,
  )

  it('stays a no-op for a run that declared no compose dependencies', async () => {
    await withStatus('{"available":false,"source":"none","reason":"missing"}')
    const result = await standUpInfra(
      tmpdir(),
      { environment: 'local', noInfraDependencies: true },
      undefined,
      silentLogger,
      noDaemon,
    )
    // Nothing wanted a daemon, so nothing is reported about one.
    expect(result).toEqual({ started: false })
  })

  it('refuses a daemon that is serving but cannot run a container, and says which', async () => {
    // Issue #2120. The boot record says `serving`, because a socket answered, and that is all it
    // can know. This daemon then cannot mount an image, so compose died on a mount error inside
    // the one mechanism whose job is to explain why the dependencies did not come up.
    await withStatus('{"available":true,"source":"rootless","reason":"serving"}')
    const result = await standUpInfra(tmpdir(), infra, undefined, silentLogger, () =>
      Promise.resolve({ status: 'unusable', detail: 'failed to mount overlay: invalid argument' }),
    )
    expect(result.started).toBe(false)
    expect(result.note).toContain('cannot run a container')
    expect(result.note).toContain('failed to mount overlay')
    // The daemon IS reachable, so the absence sentence would send a human to fix a daemon that
    // is running perfectly well.
    expect(result.note).not.toContain('could not start')
    // And the RECORD says what the sentence says. `dockerAvailable: false` here would be the
    // same misattribution in structured form: the Tester step renders that as "no Docker daemon
    // in the executor", for a daemon the agent can watch answer.
    expect(result.record?.dockerAvailable).toBe(true)
    expect(result.record?.dockerWorkload).toBe('unusable')
  })

  it('reports an absent daemon and an unusable one as different records', async () => {
    // The pair, side by side, because one boolean cannot carry both and the fixes point in
    // opposite directions: the executor image or its sandbox, versus a daemon that is already up.
    await withStatus('{"available":false,"source":"none","reason":"missing"}')
    const absent = await standUpInfra(tmpdir(), infra, undefined, silentLogger, noDaemon)
    expect(absent.record).toMatchObject({ dockerAvailable: false, dockerWorkload: 'undetermined' })

    await withStatus('{"available":true,"source":"rootless","reason":"serving"}')
    const unusable = await standUpInfra(tmpdir(), infra, undefined, silentLogger, () =>
      Promise.resolve({ status: 'unusable', detail: 'failed to mount overlay' }),
    )
    expect(unusable.record).toMatchObject({ dockerAvailable: true, dockerWorkload: 'unusable' })
  })

  it(
    'attempts anyway when the recorded absence is contradicted by a live daemon',
    async () => {
      // A warm-pool container whose sidecar took longer to come up than the entrypoint's bounded
      // wait allows. The boot record still says unreachable; the daemon is serving. Refusing off
      // the record alone would deny this container local infra for the rest of its life.
      await withStatus('{"available":false,"source":"external","reason":"unreachable"}')
      const result = await standUpInfra(tmpdir(), infra, undefined, silentLogger, () =>
        Promise.resolve({ status: 'usable' }),
      )
      // The compose file does not exist, so the attempt fails. The point is that it was MADE, and
      // that the record claims the daemon it actually reached.
      expect(result.record?.dockerAvailable).toBe(true)
      expect(result.record?.error).not.toContain('unreachable')
    },
    ATTEMPT_TIMEOUT_MS,
  )
})
