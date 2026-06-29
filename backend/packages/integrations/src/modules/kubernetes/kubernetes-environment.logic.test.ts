import { describe, expect, it } from 'vitest'
import type { KubernetesEnvironmentConfig } from '@cat-factory/kernel'
import { classifyDeploymentReadiness } from './kubernetes.logic.js'
import {
  deriveUrl,
  extractLoadBalancerAddress,
  isManifestFile,
  parseManifests,
  resolveNamespace,
  resourceUrl,
  templateVars,
} from './kubernetes-environment.logic.js'

const baseConfig: KubernetesEnvironmentConfig = {
  label: 'k3s',
  apiServerUrl: 'https://cluster.test:6443',
  manifestSource: { type: 'colocated', path: 'k8s' },
  url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.preview.example.com' },
}

describe('resolveNamespace', () => {
  it('renders the template then sanitizes to an RFC1123 label', () => {
    const ns = resolveNamespace(
      { ...baseConfig, namespaceTemplate: 'cf-env-{{pullNumber}}' },
      { pullNumber: '42' },
    )
    expect(ns).toBe('cf-env-42')
  })

  it('falls back to the PR number when no template is set', () => {
    expect(resolveNamespace(baseConfig, { pullNumber: '7' })).toBe('cf-env-7')
  })

  it('sanitizes an unsafe namespace value to a valid label', () => {
    const ns = resolveNamespace(
      { ...baseConfig, namespaceTemplate: 'Feature/Login_Branch!' },
      {},
    )
    expect(ns).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
    expect(ns).toBe('feature-login-branch')
  })
})

describe('resourceUrl', () => {
  it('builds a core/v1 namespaced path', () => {
    expect(resourceUrl(baseConfig, 'v1', 'Service', 'ns', 'web')).toBe(
      'https://cluster.test:6443/api/v1/namespaces/ns/services/web',
    )
  })

  it('builds a grouped apps/v1 path', () => {
    expect(resourceUrl(baseConfig, 'apps/v1', 'Deployment', 'ns', 'web')).toBe(
      'https://cluster.test:6443/apis/apps/v1/namespaces/ns/deployments/web',
    )
  })

  it('omits the name segment for a collection GET', () => {
    expect(resourceUrl(baseConfig, 'apps/v1', 'Deployment', 'ns')).toBe(
      'https://cluster.test:6443/apis/apps/v1/namespaces/ns/deployments',
    )
  })

  it('throws for an unsupported kind', () => {
    expect(() => resourceUrl(baseConfig, 'v1', 'Frobnicator', 'ns', 'x')).toThrow(/Unsupported/)
  })
})

describe('parseManifests', () => {
  it('templates vars, forces the namespace, stamps the block label, drops Namespace docs', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
        - name: app
          image: {{image}}
---
apiVersion: v1
kind: Namespace
metadata:
  name: should-be-dropped
`
    const vars = templateVars({ branch: 'feat' }, 'cf-env-1', 'ghcr.io/acme/web:feat')
    const resources = parseManifests(yaml, vars, 'cf-env-1', 'blk1', undefined)
    expect(resources).toHaveLength(1)
    const dep = resources[0]!
    expect(dep.kind).toBe('Deployment')
    expect(dep.metadata.namespace).toBe('cf-env-1')
    expect(dep.metadata.labels?.['cat-factory.blockId']).toBe('blk1')
    const container = (dep.spec as { template: { spec: { containers: { image: string }[] } } })
      .template.spec.containers[0]!
    expect(container.image).toBe('ghcr.io/acme/web:feat')
  })

  it('throws when a document is missing metadata.name', () => {
    const yaml = 'apiVersion: v1\nkind: Service\nmetadata: {}\n'
    expect(() => parseManifests(yaml, {}, 'ns', undefined, undefined)).toThrow(/metadata.name/)
  })
})

describe('deriveUrl', () => {
  it('renders an ingress-template host immediately (no live address needed)', () => {
    expect(
      deriveUrl(
        { source: 'ingressTemplate', hostTemplate: '{{branch}}.preview.example.com' },
        { branch: 'feat' },
        null,
      ),
    ).toBe('https://feat.preview.example.com')
  })

  it('returns null for a status source until the live address is known', () => {
    expect(deriveUrl({ source: 'serviceStatus', serviceName: 'web' }, {}, null)).toBeNull()
  })

  it('builds a serviceStatus URL with the configured port', () => {
    expect(
      deriveUrl({ source: 'serviceStatus', serviceName: 'web', port: 8080 }, {}, '10.0.0.5'),
    ).toBe('https://10.0.0.5:8080')
  })
})

describe('extractLoadBalancerAddress', () => {
  it('prefers hostname over ip', () => {
    expect(
      extractLoadBalancerAddress({ status: { loadBalancer: { ingress: [{ hostname: 'h', ip: '1.2.3.4' }] } } }),
    ).toBe('h')
  })
  it('returns null when no ingress address is assigned', () => {
    expect(extractLoadBalancerAddress({ status: { loadBalancer: { ingress: [] } } })).toBeNull()
  })
})

describe('isManifestFile', () => {
  it('matches yaml/yml/json', () => {
    expect(isManifestFile('k8s/deploy.yaml')).toBe(true)
    expect(isManifestFile('k8s/svc.yml')).toBe(true)
    expect(isManifestFile('k8s/cfg.json')).toBe(true)
    expect(isManifestFile('README.md')).toBe(false)
  })
})

describe('classifyDeploymentReadiness', () => {
  it('is ready when availableReplicas meets the desired count', () => {
    expect(classifyDeploymentReadiness({ spec: { replicas: 2 }, status: { availableReplicas: 2 } })).toBe(
      'ready',
    )
  })
  it('is pending while rolling out', () => {
    expect(classifyDeploymentReadiness({ spec: { replicas: 2 }, status: { availableReplicas: 1 } })).toBe(
      'pending',
    )
  })
  it('is gone on a terminal ProgressDeadlineExceeded', () => {
    expect(
      classifyDeploymentReadiness({
        spec: { replicas: 1 },
        status: {
          availableReplicas: 0,
          conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }],
        },
      }),
    ).toBe('gone')
  })
})
