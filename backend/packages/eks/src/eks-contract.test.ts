import {
  environmentBackendConfigSchema,
  RESERVED_ENVIRONMENT_BACKEND_KINDS,
  RESERVED_RUNNER_BACKEND_KINDS,
  runnerBackendConfigSchema,
} from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'

// The EKS backends ride first-class `{ kind: 'eks', eks }` contract variants (an EKS apiserver
// needs its own region/cluster fields, so it can't ride the generic manifest custom member).
// These assert the variants parse and that `'eks'` is a reserved kind (so a wrong-shaped custom
// payload can't silently match it).

const eksRunnerConfig = {
  label: 'prod-eks',
  apiServerUrl: 'https://ABC123.gr7.us-east-1.eks.amazonaws.com',
  namespace: 'cat-factory',
  image: 'ghcr.io/kibertoad/cat-factory-executor:latest',
  region: 'us-east-1',
  clusterName: 'prod',
}

describe('EKS runner backend contract', () => {
  it('parses a { kind: "eks", eks } runner config', () => {
    const parsed = v.parse(runnerBackendConfigSchema, { kind: 'eks', eks: eksRunnerConfig })
    expect(parsed.kind).toBe('eks')
  })

  it('reserves the "eks" kind', () => {
    expect(RESERVED_RUNNER_BACKEND_KINDS).toContain('eks')
    // A custom-kind payload using the reserved slug must NOT validate as the generic member.
    const bad = v.safeParse(runnerBackendConfigSchema, {
      kind: 'eks',
      manifest: { providerId: 'x', label: 'x', baseUrl: 'https://x', auth: { type: 'none' } },
    })
    expect(bad.success).toBe(false)
  })

  it('rejects a runner config missing the AWS region/cluster', () => {
    const { region: _r, clusterName: _c, ...noAws } = eksRunnerConfig
    expect(v.safeParse(runnerBackendConfigSchema, { kind: 'eks', eks: noAws }).success).toBe(false)
  })
})

describe('EKS environment backend contract', () => {
  it('parses a { kind: "eks", eks } provision config', () => {
    const parsed = v.parse(environmentBackendConfigSchema, {
      kind: 'eks',
      eks: {
        label: 'prod-eks',
        apiServerUrl: 'https://ABC123.gr7.us-east-1.eks.amazonaws.com',
        namespaceTemplate: 'pr-{{pullNumber}}',
        manifestSource: { type: 'colocated', path: 'deploy/k8s' },
        url: { source: 'serviceStatus', serviceName: 'web' },
        region: 'us-east-1',
        clusterName: 'prod',
      },
    })
    expect(parsed.kind).toBe('eks')
  })

  it('reserves the "eks" environment kind', () => {
    expect(RESERVED_ENVIRONMENT_BACKEND_KINDS).toContain('eks')
  })
})
