import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockerUnavailableReason, readDockerStatus } from '../src/docker-status.js'

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

describe('dockerUnavailableReason', () => {
  it('names the cause per source', () => {
    expect(
      dockerUnavailableReason({ available: false, source: 'none', reason: 'missing' }),
    ).toContain('ships no Docker daemon')
    expect(
      dockerUnavailableReason({ available: false, source: 'external', reason: 'unreachable' }),
    ).toContain('unreachable')
    expect(
      dockerUnavailableReason({ available: false, source: 'rootless', reason: 'failed' }),
    ).toContain('rootless Docker daemon')
  })

  it('appends the recorded detail so the cause is not merely a category', () => {
    const reason = dockerUnavailableReason({
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

  it('answers null for anything that is not a decided absence', () => {
    expect(
      dockerUnavailableReason({ available: true, source: 'rootless', reason: 'serving' }),
    ).toBeNull()
    expect(
      dockerUnavailableReason({ available: undefined, source: 'unreported', reason: 'none' }),
    ).toBeNull()
  })
})
