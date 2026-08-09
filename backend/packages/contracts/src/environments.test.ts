import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  cloudflareConnectionConfigSchema,
  cloudflareEnvironmentConfigSchema,
} from './environments.js'
import {
  eksConnectionConfigSchema,
  isKubernetesUrlSource,
  kubernetesConnectionConfigSchema,
  kubernetesEnvironmentConfigSchema,
  kubernetesUrlSourceSchema,
} from './environments-kubernetes.js'

describe('isKubernetesUrlSource', () => {
  it('accepts every discriminant of the variant it is derived from', () => {
    // Derived from the same source the parser reads, so a variant added there is covered here
    // with no second list to remember: the assertion is the RELATION, not a pinned count.
    for (const option of kubernetesUrlSourceSchema.options)
      expect(isKubernetesUrlSource(option.entries.source.literal)).toBe(true)
  })

  it('rejects a source this build does not define, which stored configs go on carrying', () => {
    // Why the guard exists: the discriminant is closed but PERSISTED, so a config written by a
    // deployment that knows a source this one does not reaches the settings form and falls off
    // the end of its exhaustive switch.
    expect(isKubernetesUrlSource('ingressTemplateV2')).toBe(false)
    expect(isKubernetesUrlSource(undefined)).toBe(false)
    expect(isKubernetesUrlSource('')).toBe(false)
  })
})

describe('the connection ÷ provisioning split', () => {
  const connection = {
    apiServerUrl: 'https://cluster.test:6443',
    caCertPem: '-----BEGIN CERTIFICATE-----',
    insecureSkipTlsVerify: true,
  }

  it('reads a Kubernetes connection off a config whose provisioning half no longer validates', () => {
    // The property the reclaim path depends on: standing an environment up needs the whole
    // config, tearing one down needs the connection, and drift in the former must not be able to
    // refuse the latter (an environment nobody can delete goes on costing money).
    const drifted = { ...connection, manifestSource: {}, url: { source: 'retired' } }
    expect(v.safeParse(kubernetesEnvironmentConfigSchema, drifted).success).toBe(false)
    expect(v.parse(kubernetesConnectionConfigSchema, drifted)).toEqual(connection)
  })

  it('refuses a Kubernetes connection that lost its apiserver URL', () => {
    // The one field with no safe default: a refusal beats a DELETE aimed at a guessed cluster.
    const { apiServerUrl: _dropped, ...withoutCluster } = connection
    expect(v.safeParse(kubernetesConnectionConfigSchema, withoutCluster).success).toBe(false)
    expect(
      v.safeParse(kubernetesConnectionConfigSchema, { ...connection, apiServerUrl: '' }).success,
    ).toBe(false)
  })

  it('carries the AWS coordinates on the EKS connection, because the token is minted from them', () => {
    const eks = { ...connection, region: 'us-east-1', clusterName: 'preview' }
    expect(v.parse(eksConnectionConfigSchema, { ...eks, manifestSource: {} })).toEqual(eks)
  })

  it('reads a Cloudflare connection off a config whose worker settings no longer validate', () => {
    const drifted = { label: 'preview', workersSubdomain: 'NOT VALID' }
    expect(v.safeParse(cloudflareEnvironmentConfigSchema, drifted).success).toBe(false)
    expect(v.parse(cloudflareConnectionConfigSchema, drifted)).toEqual({})
  })

  it('refuses a Cloudflare connection whose API root is what drifted', () => {
    // Absent means the documented public default; present but unusable must not silently BECOME
    // it, which for a GitHub Enterprise deployment is a write to the wrong host.
    expect(v.safeParse(cloudflareConnectionConfigSchema, { apiBaseUrl: '' }).success).toBe(false)
    expect(v.safeParse(cloudflareConnectionConfigSchema, { apiBaseUrl: 42 }).success).toBe(false)
  })
})
