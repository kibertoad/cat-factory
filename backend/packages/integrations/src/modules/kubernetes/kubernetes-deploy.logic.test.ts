import type { KubernetesProvisionConfig, RunnerJobView } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  buildDeployJobSpec,
  mapDeployOutcome,
  needsContainerRender,
  resolveHelmReleases,
  resolveImageOverrides,
  resolveSecretInjections,
  toDeployUrlSource,
} from './kubernetes-deploy.logic.js'

const baseConfig: KubernetesProvisionConfig = {
  label: 'k3s',
  apiServerUrl: 'https://cluster.test:6443',
  namespaceTemplate: 'cf-env-{{pullNumber}}',
  manifestSource: { type: 'colocated', path: 'k8s/overlays/preview', renderer: 'kustomize' },
  url: { source: 'gatewayStatus', scheme: 'https' },
}

const vars = { pullNumber: '42', branch: 'feat', namespace: 'cf-env-42' }
const resolveSecret = (key: string) =>
  ({ apiToken: 'tok', DB_PASSWORD: 's3cret', LICENSE: 'lic' })[key]

describe('needsContainerRender', () => {
  it('is true for a kustomize source', () => {
    expect(needsContainerRender(baseConfig)).toBe(true)
  })

  it('is true when helm releases / images / secret injections are present on a raw source', () => {
    const raw = (extra: Partial<KubernetesProvisionConfig>): KubernetesProvisionConfig => ({
      ...baseConfig,
      manifestSource: { type: 'colocated', path: 'k8s/app.yaml', renderer: 'raw' },
      ...extra,
    })
    expect(needsContainerRender(raw({}))).toBe(false)
    expect(
      needsContainerRender(raw({ helmReleases: [{ name: 'r', chart: 'c', version: '1.0.0' }] })),
    ).toBe(true)
    expect(
      needsContainerRender(raw({ images: [{ name: 'app', newTagTemplate: '{{branch}}' }] })),
    ).toBe(true)
    expect(
      needsContainerRender(
        raw({ secretInjections: [{ mode: 'secret', secretName: 's', entries: [] }] }),
      ),
    ).toBe(true)
  })
})

describe('resolveImageOverrides', () => {
  it('renders name/tag/digest templates over the vars', () => {
    expect(
      resolveImageOverrides(
        [
          { name: 'registry/app', newTagTemplate: '{{branch}}' },
          {
            name: 'registry/api',
            newNameTemplate: 'mirror/{{branch}}',
            digestTemplate: 'sha256:{{pullNumber}}',
          },
        ],
        vars,
      ),
    ).toEqual([
      { name: 'registry/app', newTag: 'feat' },
      { name: 'registry/api', newName: 'mirror/feat', digest: 'sha256:42' },
    ])
  })
})

describe('resolveSecretInjections', () => {
  it('resolves secretRef + valueTemplate entries for both modes', () => {
    expect(
      resolveSecretInjections(
        [
          {
            mode: 'secret',
            secretName: 'app-secrets',
            secretType: 'Opaque',
            entries: [
              { key: 'DB_PASSWORD', secretRef: { key: 'DB_PASSWORD' } },
              { key: 'BRANCH', valueTemplate: '{{branch}}' },
            ],
          },
          {
            mode: 'generatorEnvFile',
            envFilePath: 'overlays/preview/.env',
            entries: [{ key: 'LICENSE', secretRef: { key: 'LICENSE' } }],
          },
        ],
        vars,
        resolveSecret,
      ),
    ).toEqual([
      {
        mode: 'secret',
        secretName: 'app-secrets',
        secretType: 'Opaque',
        entries: [
          { key: 'DB_PASSWORD', value: 's3cret' },
          { key: 'BRANCH', value: 'feat' },
        ],
      },
      {
        mode: 'generatorEnvFile',
        envFilePath: 'overlays/preview/.env',
        entries: [{ key: 'LICENSE', value: 'lic' }],
      },
    ])
  })

  it('resolves a missing secret to an empty string', () => {
    const [inj] = resolveSecretInjections(
      [{ mode: 'secret', secretName: 's', entries: [{ key: 'X', secretRef: { key: 'ABSENT' } }] }],
      vars,
      resolveSecret,
    )
    expect(inj?.entries[0]?.value).toBe('')
  })
})

describe('resolveHelmReleases', () => {
  it('renders set templates + folds valuesSecretRefs into a single set array', () => {
    expect(
      resolveHelmReleases(
        [
          {
            name: 'gateway',
            chart: 'oci://ghcr.io/acme/gateway',
            version: '1.2.3',
            namespaceTemplate: 'gw-{{pullNumber}}',
            set: [{ path: 'image.tag', valueTemplate: '{{branch}}' }],
            valuesSecretRefs: [{ path: 'auth.token', secretRef: { key: 'LICENSE' } }],
            scope: 'shared',
          },
        ],
        vars,
        resolveSecret,
      ),
    ).toEqual([
      {
        name: 'gateway',
        chart: 'oci://ghcr.io/acme/gateway',
        version: '1.2.3',
        namespace: 'gw-42',
        set: [
          { path: 'image.tag', value: 'feat' },
          { path: 'auth.token', value: 'lic' },
        ],
        scope: 'shared',
      },
    ])
  })
})

describe('toDeployUrlSource', () => {
  it('drops the host template for ingressTemplate (resolved backend-side)', () => {
    expect(
      toDeployUrlSource({
        source: 'ingressTemplate',
        hostTemplate: '{{branch}}.example.com',
        scheme: 'https',
      }),
    ).toEqual({ source: 'ingressTemplate' })
  })

  it('passes the status-source fields through verbatim', () => {
    expect(
      toDeployUrlSource({ source: 'gatewayStatus', gatewayName: 'gw', scheme: 'http' }),
    ).toEqual({
      source: 'gatewayStatus',
      gatewayName: 'gw',
      scheme: 'http',
    })
    expect(toDeployUrlSource({ source: 'serviceStatus', serviceName: 'web', port: 8080 })).toEqual({
      source: 'serviceStatus',
      serviceName: 'web',
      port: 8080,
    })
  })
})

describe('buildDeployJobSpec', () => {
  it('builds a full deploy job with resolved cluster, source, and render inputs', () => {
    const config: KubernetesProvisionConfig = {
      ...baseConfig,
      caCertPem: '---CA---',
      images: [{ name: 'registry/app', newTagTemplate: '{{branch}}' }],
      helmReleases: [{ name: 'gw', chart: 'oci://x', version: '1.0.0', scope: 'shared' }],
      secretInjections: [
        {
          mode: 'generatorEnvFile',
          envFilePath: 'overlays/preview/.env',
          entries: [{ key: 'DB_PASSWORD', secretRef: { key: 'DB_PASSWORD' } }],
        },
      ],
      labels: { team: 'core' },
    }
    const spec = buildDeployJobSpec({
      jobId: 'job-1',
      config,
      vars,
      namespace: 'cf-env-42',
      clone: { cloneUrl: 'https://github.com/acme/web.git', ref: 'feat', token: 'gh-tok' },
      resolveSecret,
    })
    expect(spec).toEqual({
      jobId: 'job-1',
      cluster: {
        apiServerUrl: 'https://cluster.test:6443',
        caCertPem: '---CA---',
        token: 'tok',
        namespace: 'cf-env-42',
      },
      source: {
        cloneUrl: 'https://github.com/acme/web.git',
        ref: 'feat',
        path: 'k8s/overlays/preview',
        renderer: 'kustomize',
      },
      ghToken: 'gh-tok',
      setNamespace: true,
      images: [{ name: 'registry/app', newTag: 'feat' }],
      secretInjections: [
        {
          mode: 'generatorEnvFile',
          envFilePath: 'overlays/preview/.env',
          entries: [{ key: 'DB_PASSWORD', value: 's3cret' }],
        },
      ],
      helmReleases: [{ name: 'gw', chart: 'oci://x', version: '1.0.0', scope: 'shared' }],
      url: { source: 'gatewayStatus', scheme: 'https' },
      labels: { team: 'core' },
    })
  })

  it('omits setNamespace when no namespace template is configured (honor the overlay namespace)', () => {
    const config: KubernetesProvisionConfig = {
      ...baseConfig,
      namespaceTemplate: undefined,
    }
    const spec = buildDeployJobSpec({
      jobId: 'job-2',
      config,
      vars: { pullNumber: '42', namespace: 'cf-env-42' },
      namespace: 'cf-env-42',
      clone: { cloneUrl: 'https://github.com/acme/web.git', ref: 'feat' },
      resolveSecret,
    })
    expect(spec.setNamespace).toBeUndefined()
    expect(spec.ghToken).toBeUndefined()
  })

  it('wires rolloutTimeoutSeconds when configured', () => {
    const spec = buildDeployJobSpec({
      jobId: 'job-3',
      config: { ...baseConfig, rolloutTimeoutSeconds: 600 },
      vars,
      namespace: 'cf-env-42',
      clone: { cloneUrl: 'https://github.com/acme/web.git', ref: 'feat' },
      resolveSecret,
    })
    expect(spec.rolloutTimeoutSeconds).toBe(600)
  })

  it('throws when the cluster apiToken secret is unset', () => {
    expect(() =>
      buildDeployJobSpec({
        jobId: 'job-4',
        config: baseConfig,
        vars,
        namespace: 'cf-env-42',
        clone: { cloneUrl: 'https://github.com/acme/web.git', ref: 'feat' },
        resolveSecret: () => undefined,
      }),
    ).toThrow(/apiToken/)
  })
})

describe('mapDeployOutcome', () => {
  it('maps a successful deploy outcome into a provisioned environment', () => {
    const view: RunnerJobView = {
      state: 'done',
      result: {
        custom: { namespace: 'cf-env-42', url: 'https://feat.example.com', status: 'ready' },
      },
    }
    expect(mapDeployOutcome(view, vars)).toEqual({
      externalId: 'cf-env-42',
      url: 'https://feat.example.com',
      status: 'ready',
      expiresAt: null,
      access: null,
      fields: { ...vars, namespace: 'cf-env-42' },
    })
  })

  it('maps a provisioning outcome with no URL yet', () => {
    const view: RunnerJobView = {
      state: 'done',
      result: { custom: { namespace: 'cf-env-42', url: null, status: 'provisioning' } },
    }
    expect(mapDeployOutcome(view, vars).status).toBe('provisioning')
    expect(mapDeployOutcome(view, vars).url).toBeNull()
  })

  it('maps a failed job into a failed environment carrying the harness error', () => {
    const view: RunnerJobView = { state: 'failed', error: 'kustomize build failed' }
    const result = mapDeployOutcome(view, vars)
    expect(result.status).toBe('failed')
    expect(result.externalId).toBeNull()
    expect(result.error).toBe('kustomize build failed')
  })

  it('treats a done job with no structured outcome as failed', () => {
    const view: RunnerJobView = { state: 'done', result: {} }
    expect(mapDeployOutcome(view, vars).status).toBe('failed')
  })
})
