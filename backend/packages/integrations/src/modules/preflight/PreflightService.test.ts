import { describe, expect, it } from 'vitest'
import type { PreflightHostProbes, PreflightProbeOutcome, PreflightRef } from '@cat-factory/kernel'
import {
  formatPreflightFailure,
  preflightBlockingFailures,
  PreflightService,
} from './PreflightService.js'

// A fake host-probe seam: every probe records its args and returns a scripted outcome (default
// pass). The tracker's validation plan #4 — "fake probe states drive every verdict + remediation
// rendering" — is exactly this: no real daemon/VPN/mkcert needed.
function fakeProbes(
  overrides: Partial<Record<keyof PreflightHostProbes, PreflightProbeOutcome>> = {},
) {
  const calls: { probe: string; args: unknown[] }[] = []
  const outcome = (probe: keyof PreflightHostProbes): PreflightProbeOutcome =>
    overrides[probe] ?? { status: 'pass' }
  const record =
    (probe: keyof PreflightHostProbes) =>
    async (...args: unknown[]): Promise<PreflightProbeOutcome> => {
      calls.push({ probe, args })
      return outcome(probe)
    }
  const probes: PreflightHostProbes = {
    dockerDaemon: record('dockerDaemon'),
    diskSpace: record('diskSpace'),
    memory: record('memory'),
    registryAuth: record('registryAuth'),
    tcpReachable: record('tcpReachable'),
    httpReachable: record('httpReachable'),
    mkcertCa: record('mkcertCa'),
    hostsEntries: record('hostsEntries'),
    envSecretsMarker: record('envSecretsMarker'),
  }
  return { probes, calls }
}

describe('PreflightService', () => {
  it('maps each ref to its probe with the right args and passes them through', async () => {
    const { probes, calls } = fakeProbes()
    const refs: PreflightRef[] = [
      { check: 'docker-daemon' },
      { check: 'disk-space', params: { minGib: 16 } },
      { check: 'memory', params: { minGib: 8 } },
      { check: 'registry-auth', params: { registry: 'reg.example.com' } },
      { check: 'tcp-reachable', params: { host: 'vault.internal', port: 8200 } },
      { check: 'http-reachable', params: { url: 'https://es.local/health', expectStatus: 200 } },
      { check: 'mkcert-ca' },
      { check: 'hosts-entries', params: { hostnames: ['acme.local'] } },
      { check: 'env-secrets-marker', params: { file: '.env', marker: '# BOF SECRETS #' } },
    ]
    const results = await new PreflightService({ hostProbes: probes }).run(refs)

    // One result per ref, in order, all pass, no remediation on a pass.
    expect(results.map((r) => r.check)).toEqual(refs.map((r) => r.check))
    expect(results.every((r) => r.status === 'pass')).toBe(true)
    expect(results.every((r) => r.remediation === undefined)).toBe(true)

    // GiB params are converted to bytes; host/port/url/registry threaded verbatim.
    const byProbe = Object.fromEntries(calls.map((c) => [c.probe, c.args]))
    expect(byProbe.diskSpace).toEqual([16 * 1024 ** 3])
    expect(byProbe.memory).toEqual([8 * 1024 ** 3])
    expect(byProbe.registryAuth).toEqual(['reg.example.com'])
    expect(byProbe.tcpReachable).toEqual(['vault.internal', 8200])
    expect(byProbe.httpReachable).toEqual(['https://es.local/health', { expectStatus: 200 }])
    expect(byProbe.hostsEntries).toEqual([['acme.local']])
    expect(byProbe.envSecretsMarker).toEqual(['.env', '# BOF SECRETS #'])
  })

  it('renders the built-in remediation on a required failure', async () => {
    const { probes } = fakeProbes({ registryAuth: { status: 'fail', detail: 'no docker login' } })
    const [result] = await new PreflightService({ hostProbes: probes }).run([
      { check: 'registry-auth', params: { registry: '053.dkr.ecr.eu-central-1.amazonaws.com' } },
    ])
    expect(result?.status).toBe('fail')
    expect(result?.required).toBe(true)
    expect(result?.detail).toBe('no docker login')
    expect(result?.remediation).toContain('docker login')
    expect(result?.remediation).toContain('053.dkr.ecr.eu-central-1.amazonaws.com')
  })

  it('honours a per-ref remediation and label override', async () => {
    const { probes } = fakeProbes({ tcpReachable: { status: 'fail', detail: 'timed out' } })
    const [result] = await new PreflightService({ hostProbes: probes }).run([
      {
        check: 'tcp-reachable',
        params: { host: 'vault', port: 8200 },
        label: 'Corporate VPN',
        remediation: 'Run `tailscale up --accept-routes` first.',
      },
    ])
    expect(result?.title).toBe('Corporate VPN')
    expect(result?.remediation).toBe('Run `tailscale up --accept-routes` first.')
  })

  it('downgrades a non-required failure to an advisory warning (not blocking)', async () => {
    const { probes } = fakeProbes({ diskSpace: { status: 'fail', detail: '9.0 GiB free' } })
    const results = await new PreflightService({ hostProbes: probes }).run([
      { check: 'disk-space', params: { minGib: 16 }, required: false },
    ])
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.required).toBe(false)
    // A warn still carries remediation (it's not a pass) but does NOT block.
    expect(results[0]?.remediation).toBeDefined()
    expect(preflightBlockingFailures(results)).toHaveLength(0)
  })

  it('fails a check whose required param is missing (misconfigured), without calling the probe', async () => {
    const { probes, calls } = fakeProbes()
    const [result] = await new PreflightService({ hostProbes: probes }).run([
      { check: 'disk-space' }, // no minGib
    ])
    expect(result?.status).toBe('fail')
    expect(result?.detail).toContain('misconfigured')
    expect(calls.some((c) => c.probe === 'diskSpace')).toBe(false)
  })

  it('collects blocking failures and formats them with detail + remediation', async () => {
    const { probes } = fakeProbes({
      dockerDaemon: { status: 'fail', detail: 'daemon not reachable' },
      httpReachable: { status: 'fail', detail: 'HTTP 000' },
    })
    const results = await new PreflightService({ hostProbes: probes }).run([
      { check: 'docker-daemon' },
      { check: 'http-reachable', params: { url: 'https://es.local' }, required: false },
      { check: 'memory', params: { minGib: 8 } }, // passes
    ])
    // Only the required docker-daemon failure blocks; the non-required http one is a warn.
    const blocking = preflightBlockingFailures(results)
    expect(blocking.map((b) => b.check)).toEqual(['docker-daemon'])
    const message = formatPreflightFailure(blocking)
    expect(message).toContain('Preflight check(s) failed')
    expect(message).toContain('daemon not reachable')
    expect(message).toContain('Docker Desktop')
  })

  it('never throws — a probe that rejects becomes a fail verdict', async () => {
    const probes = {
      ...fakeProbes().probes,
      mkcertCa: () => Promise.reject(new Error('boom')),
    } as PreflightHostProbes
    const [result] = await new PreflightService({ hostProbes: probes }).run([
      { check: 'mkcert-ca' },
    ])
    expect(result?.status).toBe('fail')
    expect(result?.detail).toBe('boom')
  })
})
