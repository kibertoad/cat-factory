import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDockerPreflightProbes } from './preflight.js'

// Host-adapter tests for the deterministic probes (memory / env-file marker / HTTP / a refused TCP
// connect / a missing docker binary). The daemon/registry/mkcert/hosts probes read machine-global
// state, so they're covered structurally in the integrations PreflightService suite; here we prove
// the adapter normalizes real host outcomes into a verdict and NEVER throws.

describe('createDockerPreflightProbes', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('memory: passes above the floor, fails below', async () => {
    const probes = createDockerPreflightProbes()
    expect((await probes.memory(0)).status).toBe('pass')
    // 1 EiB — no machine has this, so it must fail (with a detail, never a throw).
    const low = await probes.memory(2 ** 60)
    expect(low.status).toBe('fail')
    expect(low.detail).toContain('total')
  })

  it('envSecretsMarker: present / absent / missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preflight-'))
    try {
      const file = join(dir, '.env.local')
      await writeFile(file, 'FOO=bar\n# BOF SECRETS #\nSECRET=1\n', 'utf8')
      const probes = createDockerPreflightProbes()
      expect((await probes.envSecretsMarker(file, '# BOF SECRETS #')).status).toBe('pass')
      expect((await probes.envSecretsMarker(file, '# MISSING #')).status).toBe('fail')
      const missing = await probes.envSecretsMarker(join(dir, 'nope'), 'x')
      expect(missing.status).toBe('fail')
      expect(missing.detail).toContain('could not read')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('registryAuth: an auths/credHelpers entry passes, a global credsStore alone does NOT false-pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preflight-'))
    try {
      // A stock Docker Desktop config: a global credsStore but no login for our registry. This must
      // NOT pass — the whole point is to catch a missing / expired registry login.
      const cfgOnlyStore = join(dir, 'only-store.json')
      await writeFile(cfgOnlyStore, JSON.stringify({ credsStore: 'desktop' }), 'utf8')
      const noLogin = createDockerPreflightProbes({ dockerConfigPath: cfgOnlyStore })
      expect((await noLogin.registryAuth('reg.example.com')).status).toBe('fail')

      // After `docker login`, docker writes a per-registry `auths` entry (empty secret when a
      // credsStore holds it) — that is the reliable signal, even alongside a credsStore.
      const cfgLoggedIn = join(dir, 'logged-in.json')
      await writeFile(
        cfgLoggedIn,
        JSON.stringify({ credsStore: 'desktop', auths: { 'reg.example.com': {} } }),
        'utf8',
      )
      const loggedIn = createDockerPreflightProbes({ dockerConfigPath: cfgLoggedIn })
      expect((await loggedIn.registryAuth('https://reg.example.com/v2/')).status).toBe('pass')

      // A per-registry credential helper also counts as logged in.
      const cfgHelper = join(dir, 'helper.json')
      await writeFile(
        cfgHelper,
        JSON.stringify({ credHelpers: { 'reg.example.com': 'ecr-login' } }),
        'utf8',
      )
      const viaHelper = createDockerPreflightProbes({ dockerConfigPath: cfgHelper })
      expect((await viaHelper.registryAuth('reg.example.com')).status).toBe('pass')

      // A missing config file ⇒ never logged in anywhere.
      const missing = createDockerPreflightProbes({ dockerConfigPath: join(dir, 'nope.json') })
      expect((await missing.registryAuth('reg.example.com')).status).toBe('fail')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('httpReachable: 2xx passes, non-2xx fails, network error fails', async () => {
    const probes = createDockerPreflightProbes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )
    expect((await probes.httpReachable('https://es.local/health')).status).toBe('pass')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    )
    expect((await probes.httpReachable('https://es.local/health')).status).toBe('fail')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const err = await probes.httpReachable('https://es.local/health')
    expect(err.status).toBe('fail')
    expect(err.detail).toContain('ECONNREFUSED')
  })

  it('httpReachable: honours an expected-body substring', async () => {
    const probes = createDockerPreflightProbes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"status":"green"}', { status: 200 })),
    )
    expect(
      (await probes.httpReachable('https://es.local', { expectBodyContains: 'green' })).status,
    ).toBe('pass')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"status":"red"}', { status: 200 })),
    )
    expect(
      (await probes.httpReachable('https://es.local', { expectBodyContains: 'green' })).status,
    ).toBe('fail')
  })

  it('tcpReachable: a refused connect is a fail, not a throw', async () => {
    const probes = createDockerPreflightProbes()
    // Port 1 on loopback is not listening — a fast ECONNREFUSED.
    const res = await probes.tcpReachable('127.0.0.1', 1)
    expect(res.status).toBe('fail')
  })

  it('dockerDaemon: a missing binary is a fail, not a throw', async () => {
    const probes = createDockerPreflightProbes({ binary: 'definitely-not-a-docker-binary-xyz' })
    expect((await probes.dockerDaemon()).status).toBe('fail')
  })
})
