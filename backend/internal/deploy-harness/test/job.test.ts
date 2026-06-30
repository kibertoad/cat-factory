import { describe, expect, it } from 'vitest'
import { jobSecrets, parseDeployJob } from '../src/job.js'

const base = {
  kind: 'deploy',
  jobId: 'run-1',
  cluster: {
    apiServerUrl: 'https://cluster.example:6443',
    token: 'super-secret-token-value',
    namespace: 'cf-env-42',
  },
  source: {
    cloneUrl: 'https://github.com/acme/app.git',
    ref: 'pr-42',
    path: 'k8s/overlays/preview',
    renderer: 'kustomize',
  },
  url: { source: 'gatewayStatus' },
}

describe('parseDeployJob', () => {
  it('parses a minimal kustomize job', () => {
    const job = parseDeployJob(base)
    expect(job.jobId).toBe('run-1')
    expect(job.source.renderer).toBe('kustomize')
    expect(job.cluster.namespace).toBe('cf-env-42')
    expect(job.url.source).toBe('gatewayStatus')
  })

  it('defaults an unknown renderer to raw', () => {
    const job = parseDeployJob({ ...base, source: { ...base.source, renderer: 'whatever' } })
    expect(job.source.renderer).toBe('raw')
  })

  it('parses images, secret injections, and helm releases', () => {
    const job = parseDeployJob({
      ...base,
      images: [{ name: 'acme/app', newTag: 'pr-42' }],
      secretInjections: [
        {
          mode: 'generatorEnvFile',
          envFilePath: 'k8s/overlays/preview/.env',
          entries: [{ key: 'DB', value: 'pg://x' }],
        },
        { mode: 'secret', secretName: 'app-secrets', entries: [{ key: 'API', value: 'abc' }] },
      ],
      helmReleases: [
        {
          name: 'gw',
          chart: 'oci://r/gw',
          version: '1.2.3',
          scope: 'shared',
          set: [{ path: 'a.b', value: 'v' }],
        },
      ],
    })
    expect(job.images?.[0]).toEqual({ name: 'acme/app', newTag: 'pr-42' })
    expect(job.secretInjections).toHaveLength(2)
    expect(job.helmReleases?.[0]?.scope).toBe('shared')
  })

  it('rejects an image override that sets nothing', () => {
    expect(() => parseDeployJob({ ...base, images: [{ name: 'acme/app' }] })).toThrow(
      /must set newName, newTag, or digest/,
    )
  })

  it('rejects a missing cluster token', () => {
    expect(() => parseDeployJob({ ...base, cluster: { ...base.cluster, token: '' } })).toThrow(
      /cluster.token/,
    )
  })

  it('rejects an unknown url source', () => {
    expect(() => parseDeployJob({ ...base, url: { source: 'mystery' } })).toThrow(/url.source/)
  })

  it('defaults a helm release scope to per-environment', () => {
    const job = parseDeployJob({
      ...base,
      helmReleases: [{ name: 'app', chart: 'oci://r/app', version: '1.0.0' }],
    })
    expect(job.helmReleases?.[0]?.scope).toBe('per-environment')
  })
})

describe('jobSecrets', () => {
  it('collects the cluster token, git token, and resolved secret/helm values', () => {
    const job = parseDeployJob({
      ...base,
      ghToken: 'ghp_exampletokenvalue',
      secretInjections: [
        { mode: 'secret', secretName: 's', entries: [{ key: 'A', value: 'secretvalue123' }] },
      ],
      helmReleases: [
        {
          name: 'app',
          chart: 'oci://r/app',
          version: '1.0.0',
          set: [{ path: 'p', value: 'helmsecretval' }],
        },
      ],
    })
    const secrets = jobSecrets(job)
    expect(secrets).toContain('super-secret-token-value')
    expect(secrets).toContain('ghp_exampletokenvalue')
    expect(secrets).toContain('secretvalue123')
    expect(secrets).toContain('helmsecretval')
  })

  it('collects resolved secret leaves nested in a helm release values object', () => {
    const job = parseDeployJob({
      ...base,
      helmReleases: [
        {
          name: 'app',
          chart: 'oci://r/app',
          version: '1.0.0',
          values: { db: { password: 'nested-values-secret' }, replicas: 2 },
        },
      ],
    })
    expect(jobSecrets(job)).toContain('nested-values-secret')
  })
})
