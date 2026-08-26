import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { standUpInfra } from '../src/agent.js'
import { silentLogger } from './helpers.js'

// The Tester's local docker-compose stand-up against the container's OWN verdict about its Docker
// daemon. For months the image shipped with no `dockerd` binary at all and this path ran compose
// anyway, so every local-infra Tester run degraded to a no-infra run whose only trace was a
// connection error in a prompt note. The stand-up now refuses a DECIDED absence and says why —
// and, just as importantly, still attempts when nothing has decided (the native host transport
// runs this harness with no entrypoint to probe, on a machine where Docker usually works).

async function withStatus(contents: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-standup-status-'))
  const path = join(dir, 'status.json')
  await writeFile(path, contents, 'utf8')
  vi.stubEnv('HARNESS_DOCKER_STATUS_FILE', path)
}

const infra = { environment: 'local' as const, composePath: 'docker-compose.yml' }

describe('standUpInfra against the container docker verdict', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses, and names the cause, when the image has no daemon', async () => {
    await withStatus('{"available":false,"source":"none","reason":"missing"}')
    const result = await standUpInfra(tmpdir(), infra, undefined, silentLogger)
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
    const result = await standUpInfra(tmpdir(), infra, undefined, silentLogger)
    expect(result.record?.error).toContain('rootlesskit: no ip')
  })

  it('still attempts when no verdict was recorded, and claims nothing about the daemon', async () => {
    vi.stubEnv('HARNESS_DOCKER_STATUS_FILE', join(tmpdir(), 'cf-no-such-status.json'))
    // The compose file does not exist, so the attempt fails — the point is that it was MADE and
    // that the record does not assert a daemon verdict this container never reached.
    const result = await standUpInfra(tmpdir(), infra, undefined, silentLogger)
    expect(result.started).toBe(false)
    expect(result.record?.dockerAvailable).toBeUndefined()
    expect(result.record?.error).not.toContain('ships no Docker daemon')
  })

  it('stays a no-op for a run that declared no compose dependencies', async () => {
    await withStatus('{"available":false,"source":"none","reason":"missing"}')
    const result = await standUpInfra(
      tmpdir(),
      { environment: 'local', noInfraDependencies: true },
      undefined,
      silentLogger,
    )
    // Nothing wanted a daemon, so nothing is reported about one.
    expect(result).toEqual({ started: false })
  })
})
