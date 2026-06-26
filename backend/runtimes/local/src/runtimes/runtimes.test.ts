import { describe, expect, it } from 'vitest'
import type { ContainerExec } from './containerRuntime.js'
import { createRuntimeAdapter, resolveHostAlias, resolveRuntimeId } from './index.js'
import { AppleContainerRuntimeAdapter } from './appleContainerRuntime.js'
import { DockerRuntimeAdapter } from './dockerRuntime.js'

/** A scripted CLI that records calls and returns canned stdout per first arg. */
function fakeExec(table: Record<string, string> = {}) {
  const calls: string[][] = []
  const exec: ContainerExec = (args) => {
    calls.push(args)
    return Promise.resolve({ stdout: table[args[0] ?? ''] ?? '', stderr: '' })
  }
  return { exec, calls }
}

describe('runtime selection', () => {
  it('defaults to docker for an unset/unknown LOCAL_CONTAINER_RUNTIME', () => {
    expect(resolveRuntimeId({})).toBe('docker')
    expect(resolveRuntimeId({ LOCAL_CONTAINER_RUNTIME: 'nope' })).toBe('docker')
  })

  it('selects the requested runtime (case-insensitive)', () => {
    expect(resolveRuntimeId({ LOCAL_CONTAINER_RUNTIME: 'Podman' })).toBe('podman')
    expect(resolveRuntimeId({ LOCAL_CONTAINER_RUNTIME: 'apple' })).toBe('apple')
  })

  it('builds the docker-family adapter for docker/podman/orbstack/colima', () => {
    const podman = createRuntimeAdapter({ LOCAL_CONTAINER_RUNTIME: 'podman' })
    expect(podman).toBeInstanceOf(DockerRuntimeAdapter)
    expect(podman.binary).toBe('podman')
    expect(podman.capabilities.localDind).toBe(true)

    const colima = createRuntimeAdapter({ LOCAL_CONTAINER_RUNTIME: 'colima' })
    expect(colima).toBeInstanceOf(DockerRuntimeAdapter)
    expect(colima.binary).toBe('docker')
    expect(colima.hostAlias).toBe('host.lima.internal')
  })

  it('builds the Apple adapter (no DinD, container binary)', () => {
    const apple = createRuntimeAdapter({ LOCAL_CONTAINER_RUNTIME: 'apple' })
    expect(apple).toBeInstanceOf(AppleContainerRuntimeAdapter)
    expect(apple.binary).toBe('container')
    expect(apple.capabilities.localDind).toBe(false)
  })

  it('honours LOCAL_DOCKER_BINARY and LOCAL_HARNESS_HOST_ALIAS overrides', () => {
    const a = createRuntimeAdapter({
      LOCAL_CONTAINER_RUNTIME: 'docker',
      LOCAL_DOCKER_BINARY: '/usr/local/bin/podman',
      LOCAL_HARNESS_HOST_ALIAS: '10.0.0.1',
    })
    expect(a.binary).toBe('/usr/local/bin/podman')
    expect(a.hostAlias).toBe('10.0.0.1')
    expect(resolveHostAlias({ LOCAL_HARNESS_HOST_ALIAS: '10.0.0.1' })).toBe('10.0.0.1')
  })
})

describe('DockerRuntimeAdapter', () => {
  it('builds run args with the host-gateway add-host when enabled', async () => {
    const adapter = new DockerRuntimeAdapter({
      id: 'docker',
      binary: 'docker',
      hostAlias: 'host.docker.internal',
      addHostGateway: true,
      localDind: true,
      pooling: true,
    })
    const { exec, calls } = fakeExec({ run: 'cid\n' })
    const id = await adapter.run(exec, {
      runId: 'r1',
      image: 'img:test',
      sharedSecret: 'sek',
      privileged: true,
      env: {},
    })
    expect(id).toBe('cid')
    const run = calls[0]!
    expect(run.join(' ')).toContain('-p 127.0.0.1:0:8080')
    expect(run).toContain('--privileged')
    expect(run).toContain('--add-host=host.docker.internal:host-gateway')
  })

  it('omits the add-host when disabled (e.g. Colima)', async () => {
    const adapter = new DockerRuntimeAdapter({
      id: 'colima',
      binary: 'docker',
      hostAlias: 'host.lima.internal',
      addHostGateway: false,
      localDind: true,
      pooling: true,
    })
    const { exec, calls } = fakeExec({ run: 'cid\n' })
    await adapter.run(exec, {
      runId: 'r',
      image: 'i',
      sharedSecret: 's',
      privileged: false,
      env: {},
    })
    expect(calls[0]!.some((a) => a.startsWith('--add-host'))).toBe(false)
  })

  it('parses the published host port from `docker port`', async () => {
    const adapter = new DockerRuntimeAdapter({
      id: 'docker',
      binary: 'docker',
      hostAlias: 'host.docker.internal',
      addHostGateway: true,
      localDind: true,
      pooling: true,
    })
    const { exec } = fakeExec({ port: '127.0.0.1:49170\n' })
    expect(await adapter.endpoint(exec, 'cid')).toEqual({ host: '127.0.0.1', port: 49170 })
  })
})

describe('AppleContainerRuntimeAdapter', () => {
  const adapter = new AppleContainerRuntimeAdapter({ hostAlias: '192.168.64.1' })

  it('runs detached by deterministic name, no published port, no privileged', async () => {
    const { exec, calls } = fakeExec()
    const id = await adapter.run(exec, {
      runId: 'run_42',
      image: 'ghcr.io/x/harness:1',
      sharedSecret: 'sek',
      privileged: true, // ignored: Apple has no DinD
      env: { FOO: 'bar' },
    })
    expect(id).toBe('cf-run_42')
    const run = calls[0]!
    expect(run.slice(0, 2)).toEqual(['run', '-d'])
    expect(run).toContain('--name')
    expect(run).toContain('cf-run_42')
    expect(run.join(' ')).not.toContain('-p ')
    expect(run).not.toContain('--privileged')
    expect(run.join(' ')).toContain('FOO=bar')
    expect(run[run.length - 1]).toBe('ghcr.io/x/harness:1')
  })

  it('resolves the endpoint from the container IP in `container inspect`', async () => {
    const inspect = JSON.stringify([
      { status: 'running', networks: [{ address: '192.168.64.5/24', gateway: '192.168.64.1' }] },
    ])
    const { exec } = fakeExec({ inspect })
    // Must pick the container address, not the gateway.
    expect(await adapter.endpoint(exec, 'cf-run_42')).toEqual({ host: '192.168.64.5', port: 8080 })
  })

  it('reports running state from inspect', async () => {
    const running = fakeExec({ inspect: JSON.stringify({ status: 'running' }) })
    const stopped = fakeExec({ inspect: JSON.stringify({ status: 'stopped' }) })
    expect(await adapter.isRunning(running.exec, 'cf-x')).toBe(true)
    expect(await adapter.isRunning(stopped.exec, 'cf-x')).toBe(false)
  })

  it('finds a run container by its deterministic id in `container list`', async () => {
    const list = JSON.stringify([
      { id: 'cf-run_42', status: 'running' },
      { id: 'unrelated', status: 'running' },
    ])
    const { exec } = fakeExec({ list })
    expect(await adapter.find(exec, 'run_42')).toBe('cf-run_42')
    expect(await adapter.find(exec, 'other')).toBeUndefined()
  })

  it('deletes via `container delete --force`', async () => {
    const { exec, calls } = fakeExec()
    await adapter.remove(exec, 'cf-x')
    expect(calls[0]).toEqual(['delete', '--force', 'cf-x'])
  })

  it('reaps stopped managed containers and returns the count', async () => {
    const list = JSON.stringify([
      { id: 'cf-a', status: 'stopped' },
      { id: 'cf-b', status: 'running' },
      { id: 'cf-c', status: 'stopped' },
      { id: 'other', status: 'stopped' },
    ])
    const { exec, calls } = fakeExec({ list })
    expect(await adapter.reapExited(exec)).toBe(2)
    const del = calls.find((c) => c[0] === 'delete')!
    expect(del).toEqual(['delete', '--force', 'cf-a', 'cf-c'])
  })

  it('never reaps a managed container with an unrecognised/empty status (could be running)', async () => {
    const list = JSON.stringify([
      { id: 'cf-a', status: 'stopped' }, // terminal → reaped
      { id: 'cf-b', status: 'starting' }, // not terminal → left alone
      { id: 'cf-c' }, // no status at all → left alone
      { id: 'cf-d', status: 'EXITED' }, // case-insensitive terminal → reaped
    ])
    const { exec, calls } = fakeExec({ list })
    expect(await adapter.reapExited(exec)).toBe(2)
    const del = calls.find((c) => c[0] === 'delete')!
    expect(del).toEqual(['delete', '--force', 'cf-a', 'cf-d'])
  })

  it('finds and reaps by the `name` field when `id` is a content hash', async () => {
    // Some CLI versions report a hash `id` plus the assigned `--name` separately.
    const list = JSON.stringify([
      { id: 'sha256:deadbeef', name: 'cf-run_42', status: 'running' },
      { id: 'sha256:c0ffee', name: 'cf-old', status: 'stopped' },
    ])
    const { exec, calls } = fakeExec({ list })
    // find matches on `name` and returns the addressable deterministic handle.
    expect(await adapter.find(exec, 'run_42')).toBe('cf-run_42')
    // reap detects the managed container via its name and deletes by that handle.
    expect(await adapter.reapExited(exec)).toBe(1)
    const del = calls.find((c) => c[0] === 'delete')!
    expect(del).toEqual(['delete', '--force', 'cf-old'])
  })
})
