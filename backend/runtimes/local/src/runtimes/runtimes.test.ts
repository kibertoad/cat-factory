import { describe, expect, it } from 'vitest'
import type { ContainerExec } from './containerRuntime.js'
import {
  createRuntimeAdapter,
  resolveHostAlias,
  resolveInstallId,
  resolveRuntimeId,
  unrecognizedRuntimeId,
} from './index.js'
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

  it('flags an unrecognised LOCAL_CONTAINER_RUNTIME value (A9 boot warning)', () => {
    // Unset or valid ⇒ nothing to warn about.
    expect(unrecognizedRuntimeId({})).toBeUndefined()
    expect(unrecognizedRuntimeId({ LOCAL_CONTAINER_RUNTIME: 'podman' })).toBeUndefined()
    expect(unrecognizedRuntimeId({ LOCAL_CONTAINER_RUNTIME: '  Apple  ' })).toBeUndefined()
    // Set but unrecognised ⇒ the raw (untrimmed-case) value the preflight surfaces.
    expect(unrecognizedRuntimeId({ LOCAL_CONTAINER_RUNTIME: 'nope' })).toBe('nope')
    expect(unrecognizedRuntimeId({ LOCAL_CONTAINER_RUNTIME: 'pod man' })).toBe('pod man')
    // Blank (whitespace-only) is treated as unset, not a rejected value.
    expect(unrecognizedRuntimeId({ LOCAL_CONTAINER_RUNTIME: '   ' })).toBeUndefined()
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

  // ADR 0026 D5: a stable per-install fingerprint that partitions containers by the axis the
  // isolation protects — the baked HARNESS_SHARED_SECRET.
  it('resolveInstallId is stable, secret-derived, and never leaks the secret verbatim', () => {
    const a = resolveInstallId({ HARNESS_SHARED_SECRET: 'secret-A' })
    expect(a).toBe(resolveInstallId({ HARNESS_SHARED_SECRET: 'secret-A' })) // stable
    expect(a).not.toBe(resolveInstallId({ HARNESS_SHARED_SECRET: 'secret-B' })) // per-secret
    expect(a).not.toContain('secret-A') // one-way fingerprint, not the secret
    // Falls back to other stable config when the secret is unset, so the id is always defined.
    expect(resolveInstallId({ DATABASE_URL: 'postgres://x/5433' })).toBeTruthy()
    expect(resolveInstallId({})).toBeTruthy()
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
      installId: 'i0',
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
      installId: 'i0',
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
      installId: 'i0',
    })
    const { exec } = fakeExec({ port: '127.0.0.1:49170\n' })
    expect(await adapter.endpoint(exec, 'cid')).toEqual({ host: '127.0.0.1', port: 49170 })
  })

  it('pins a preview serve port to a deterministic host port alongside the harness :8080', async () => {
    const adapter = new DockerRuntimeAdapter({
      id: 'docker',
      binary: 'docker',
      hostAlias: 'host.docker.internal',
      addHostGateway: true,
      localDind: true,
      pooling: true,
      installId: 'i0',
    })
    const { exec, calls } = fakeExec({ run: 'cid\n' })
    await adapter.run(exec, {
      runId: 'preview-blk_fe',
      image: 'img',
      sharedSecret: 's',
      privileged: false,
      env: {},
      publishPorts: [{ container: 4173, host: 4173 }],
    })
    const run = calls[0]!.join(' ')
    expect(run).toContain('-p 127.0.0.1:0:8080')
    // A pinned `host` gives a deterministic, pre-knowable host port (the preview origin).
    expect(run).toContain('-p 127.0.0.1:4173:4173')
    expect(adapter.publishesToLocalhost).toBe(true)
  })

  it('publishes an extra port to an ephemeral host port when no host is pinned', async () => {
    const adapter = new DockerRuntimeAdapter({
      id: 'docker',
      binary: 'docker',
      hostAlias: 'host.docker.internal',
      addHostGateway: true,
      localDind: true,
      pooling: true,
      installId: 'i0',
    })
    const { exec, calls } = fakeExec({ run: 'cid\n' })
    await adapter.run(exec, {
      runId: 'preview-blk_fe',
      image: 'img',
      sharedSecret: 's',
      privileged: false,
      env: {},
      publishPorts: [{ container: 4173 }],
    })
    expect(calls[0]!.join(' ')).toContain('-p 127.0.0.1:0:4173')
  })

  it('reads the endpoint for a specific in-container port (the preview serve port)', async () => {
    const adapter = new DockerRuntimeAdapter({
      id: 'docker',
      binary: 'docker',
      hostAlias: 'host.docker.internal',
      addHostGateway: true,
      localDind: true,
      pooling: true,
      installId: 'i0',
    })
    const { exec, calls } = fakeExec({ port: '127.0.0.1:51999\n' })
    expect(await adapter.endpoint(exec, 'cid', 4173)).toEqual({ host: '127.0.0.1', port: 51999 })
    // The `docker port` query targets the requested in-container port, not the default 8080.
    expect(calls[0]).toEqual(['port', 'cid', '4173/tcp'])
  })

  // ADR 0026 D5: namespace every managed container by install id so a shared daemon can't cross
  // installs (a pool member bakes THIS install's HARNESS_SHARED_SECRET in).
  it('stamps the per-install label on run (per-run AND pool) and filters every enumeration on it', async () => {
    const adapter = new DockerRuntimeAdapter({
      id: 'docker',
      binary: 'docker',
      hostAlias: 'host.docker.internal',
      addHostGateway: true,
      localDind: true,
      pooling: true,
      installId: 'inst-A',
    })
    const { exec, calls } = fakeExec({ run: 'cid\n' })
    await adapter.run(exec, {
      runId: 'r1',
      image: 'i',
      sharedSecret: 's',
      privileged: false,
      env: {},
    })
    expect(calls[0]!.join(' ')).toContain('--label cat-factory.install=inst-A')
    calls.length = 0
    // A warm-pool member carries the SAME per-install label, so a neighbour never re-leases it.
    await adapter.run(exec, {
      runId: 'm1',
      image: 'i',
      sharedSecret: 's',
      privileged: false,
      env: {},
      pool: true,
    })
    expect(calls[0]!.join(' ')).toContain('--label cat-factory.install=inst-A')

    // Every daemon-wide enumeration is scoped strictly to this install's label.
    const enu = fakeExec()
    await adapter.reapExited(enu.exec)
    await adapter.listPoolMembers(enu.exec)
    await adapter.listRunContainers(enu.exec)
    await adapter.find(enu.exec, 'r1')
    for (const c of enu.calls) {
      expect(c.join(' ')).toContain('--filter label=cat-factory.install=inst-A')
    }
  })
})

describe('AppleContainerRuntimeAdapter', () => {
  // The container NAME is `cf-<installId>-<runId>` — the install id namespaces the reaper +
  // enumerations so a shared `container` daemon can't cross installs (ADR 0026 D5).
  const adapter = new AppleContainerRuntimeAdapter({ hostAlias: '192.168.64.1', installId: 'i0' })
  /** This install's deterministic name for a run id. */
  const n = (runId: string) => `cf-i0-${runId}`

  it('runs detached by a per-install deterministic name, no published port, no privileged', async () => {
    const { exec, calls } = fakeExec()
    const id = await adapter.run(exec, {
      runId: 'run_42',
      image: 'ghcr.io/x/harness:1',
      sharedSecret: 'sek',
      privileged: true, // ignored: Apple has no DinD
      env: { FOO: 'bar' },
      publishPorts: [{ container: 4173, host: 4173 }], // ignored: no published-port model
    })
    expect(id).toBe(n('run_42'))
    expect(adapter.publishesToLocalhost).toBe(false)
    const run = calls[0]!
    expect(run.slice(0, 2)).toEqual(['run', '-d'])
    expect(run).toContain('--name')
    expect(run).toContain(n('run_42'))
    // The per-install label rides along for parity/inspectability.
    expect(run.join(' ')).toContain('cat-factory.install=i0')
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
    expect(await adapter.endpoint(exec, n('run_42'))).toEqual({ host: '192.168.64.5', port: 8080 })
  })

  it('reaches an extra in-container port at the container IP (no published-port model)', async () => {
    const inspect = JSON.stringify([
      { status: 'running', networks: [{ address: '192.168.64.5/24', gateway: '192.168.64.1' }] },
    ])
    const { exec } = fakeExec({ inspect })
    // The preview serve port is reached directly on the container's own IP.
    expect(await adapter.endpoint(exec, n('run_42'), 4173)).toEqual({
      host: '192.168.64.5',
      port: 4173,
    })
  })

  it('reports running state from inspect', async () => {
    const running = fakeExec({ inspect: JSON.stringify({ status: 'running' }) })
    const stopped = fakeExec({ inspect: JSON.stringify({ status: 'stopped' }) })
    expect(await adapter.isRunning(running.exec, n('x'))).toBe(true)
    expect(await adapter.isRunning(stopped.exec, n('x'))).toBe(false)
  })

  it('finds a run container by its per-install deterministic id in `container list`', async () => {
    const list = JSON.stringify([
      { id: n('run_42'), status: 'running' },
      { id: 'unrelated', status: 'running' },
    ])
    const { exec } = fakeExec({ list })
    expect(await adapter.find(exec, 'run_42')).toBe(n('run_42'))
    expect(await adapter.find(exec, 'other')).toBeUndefined()
  })

  it('deletes via `container delete --force`', async () => {
    const { exec, calls } = fakeExec()
    await adapter.remove(exec, n('x'))
    expect(calls[0]).toEqual(['delete', '--force', n('x')])
  })

  it('reaps stopped managed containers and returns the count', async () => {
    const list = JSON.stringify([
      { id: n('a'), status: 'stopped' },
      { id: n('b'), status: 'running' },
      { id: n('c'), status: 'stopped' },
      { id: 'other', status: 'stopped' },
    ])
    const { exec, calls } = fakeExec({ list })
    expect(await adapter.reapExited(exec)).toBe(2)
    const del = calls.find((c) => c[0] === 'delete')!
    expect(del).toEqual(['delete', '--force', n('a'), n('c')])
  })

  it('never adopts/reaps ANOTHER install’s container (different install prefix)', async () => {
    const list = JSON.stringify([
      { id: n('mine'), status: 'stopped' }, // this install → reaped
      { id: 'cf-other-theirs', status: 'stopped' }, // a DIFFERENT install → left alone
    ])
    const { exec, calls } = fakeExec({ list })
    // A neighbour's per-run container is invisible to find + reap.
    expect(await adapter.find(exec, 'theirs')).toBeUndefined()
    expect(await adapter.reapExited(exec)).toBe(1)
    const del = calls.find((c) => c[0] === 'delete')!
    expect(del).toEqual(['delete', '--force', n('mine')])
  })

  it('never reaps a managed container with an unrecognised/empty status (could be running)', async () => {
    const list = JSON.stringify([
      { id: n('a'), status: 'stopped' }, // terminal → reaped
      { id: n('b'), status: 'starting' }, // not terminal → left alone
      { id: n('c') }, // no status at all → left alone
      { id: n('d'), status: 'EXITED' }, // case-insensitive terminal → reaped
    ])
    const { exec, calls } = fakeExec({ list })
    expect(await adapter.reapExited(exec)).toBe(2)
    const del = calls.find((c) => c[0] === 'delete')!
    expect(del).toEqual(['delete', '--force', n('a'), n('d')])
  })

  it('finds and reaps by the `name` field when `id` is a content hash', async () => {
    // Some CLI versions report a hash `id` plus the assigned `--name` separately.
    const list = JSON.stringify([
      { id: 'sha256:deadbeef', name: n('run_42'), status: 'running' },
      { id: 'sha256:c0ffee', name: n('old'), status: 'stopped' },
    ])
    const { exec, calls } = fakeExec({ list })
    // find matches on `name` and returns the addressable deterministic handle.
    expect(await adapter.find(exec, 'run_42')).toBe(n('run_42'))
    // reap detects the managed container via its name and deletes by that handle.
    expect(await adapter.reapExited(exec)).toBe(1)
    const del = calls.find((c) => c[0] === 'delete')!
    expect(del).toEqual(['delete', '--force', n('old')])
  })

  it('recovers the run id by stripping the per-install prefix in listRunContainers', async () => {
    const list = JSON.stringify([
      { id: n('run_42'), status: 'running' },
      { id: 'cf-other-nope', status: 'running' }, // a neighbour's — excluded
      { id: n('run_7'), status: 'stopped' }, // terminal — excluded
    ])
    const { exec } = fakeExec({ list })
    expect(await adapter.listRunContainers(exec)).toEqual([
      { runId: 'run_42', containerId: n('run_42') },
    ])
  })
})
