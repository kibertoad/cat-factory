import { describe, expect, it } from 'vitest'
import type { EnvironmentBackendConfig, EnvironmentManifest } from '@cat-factory/kernel'
import {
  environmentBackend,
  registeredEnvironmentBackendKinds,
} from './environment-backends.js'
import { HttpEnvironmentProvider } from './HttpEnvironmentProvider.js'
import { KubernetesEnvironmentProvider } from '../kubernetes/KubernetesEnvironmentProvider.js'

const manifest: EnvironmentManifest = {
  providerId: 'acme',
  label: 'Acme',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
  provision: { method: 'POST', pathTemplate: '/envs' },
  response: {},
}

const k8sConfig: EnvironmentBackendConfig = {
  kind: 'kubernetes',
  kubernetes: {
    label: 'k3s',
    apiServerUrl: 'https://cluster.test:6443',
    manifestSource: { type: 'colocated', path: 'k8s' },
    url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.preview.example.com' },
  },
}

describe('environment-backends registry', () => {
  it('registers both built-in kinds', () => {
    expect(registeredEnvironmentBackendKinds().sort()).toEqual(['kubernetes', 'manifest'])
  })

  it('manifest backend builds an HttpEnvironmentProvider and reports the manifest secret keys', () => {
    const backend = environmentBackend('manifest')!
    const config: EnvironmentBackendConfig = { kind: 'manifest', manifest }
    expect(backend.referencedSecretKeys(config)).toEqual(['API_TOKEN'])
    expect(backend.connectionMeta(config)).toEqual({
      providerId: 'acme',
      label: 'Acme',
      baseUrl: 'https://envs.test/api',
    })
    expect(backend.buildProvider({})).toBeInstanceOf(HttpEnvironmentProvider)
    // round-trips through the stored manifest
    expect(backend.fromManifest(backend.toManifest(config))).toEqual(config)
  })

  it('kubernetes backend builds a KubernetesEnvironmentProvider and reads apiToken', () => {
    const backend = environmentBackend('kubernetes')!
    expect(backend.referencedSecretKeys(k8sConfig)).toEqual(['apiToken'])
    expect(backend.connectionMeta(k8sConfig)).toEqual({
      providerId: 'kubernetes',
      label: 'k3s',
      baseUrl: 'https://cluster.test:6443',
    })
    expect(backend.buildProvider({})).toBeInstanceOf(KubernetesEnvironmentProvider)
    // The k8s config rides the stored manifest's providerConfig and round-trips.
    const stored = backend.toManifest(k8sConfig)
    expect(stored.providerId).toBe('kubernetes')
    expect(backend.fromManifest(stored)).toEqual(k8sConfig)
  })

  it('kubernetes assertConfigSafe rejects a non-https apiserver URL', () => {
    const backend = environmentBackend('kubernetes')!
    const bad: EnvironmentBackendConfig = {
      kind: 'kubernetes',
      kubernetes: { ...k8sConfig.kubernetes, apiServerUrl: 'http://cluster.test:6443' },
    }
    expect(() => backend.assertConfigSafe(bad)).toThrow(/https/i)
  })

  it('kubernetes assertConfigSafe rejects a custom CA when the runtime cannot honor TLS', () => {
    const backend = environmentBackend('kubernetes')!
    const withCa: EnvironmentBackendConfig = {
      kind: 'kubernetes',
      kubernetes: { ...k8sConfig.kubernetes, caCertPem: '-----BEGIN CERTIFICATE-----' },
    }
    expect(() => backend.assertConfigSafe(withCa, { customTlsSupported: false })).toThrow(
      /custom CA|Node runtime/i,
    )
    // Allowed on a runtime that supports custom TLS.
    expect(() => backend.assertConfigSafe(withCa, { customTlsSupported: true })).not.toThrow()
  })
})
