import { describe, expect, it } from 'vitest'
import type { Block, KubernetesEnvironmentConfig } from '@cat-factory/kernel'
import { frontendOriginsForService } from '@cat-factory/contracts'
import { classifyDeploymentReadiness } from './kubernetes.logic.js'
import {
  describeMisresolvingEnvironmentUrl,
  deriveUrl,
  extractLoadBalancerAddress,
  isManifestFile,
  parseManifests,
  renderTemplate,
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

describe('frontendOrigins CORS injection (deployer input → K8s template)', () => {
  it('renders the derived frontend origins into a secretInjection valueTemplate via {{frontendOrigins}}', () => {
    // End-to-end reverse-origin chain for the K8s native adapter: a `frontend` frame bound to
    // this service contributes its browser origin; the deployer flattens it into the provision
    // inputs; `templateVars` spreads all inputs, so an operator's `{{frontendOrigins}}` template
    // (like `{{branch}}`) folds it into the backend's CORS env var.
    const frontendFrame: Pick<Block, 'level' | 'type' | 'frontendConfig'> = {
      level: 'frame',
      type: 'frontend',
      frontendConfig: {
        backendBindings: [
          { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
        ],
        servePort: 4173,
      },
    }
    const origins = frontendOriginsForService('blk_api', [frontendFrame]).join(',')
    const vars = templateVars({ frontendOrigins: origins, branch: 'feat' }, 'cf-env-1', undefined)
    expect(renderTemplate('{{frontendOrigins}}', vars)).toBe('http://localhost:4173')
    // An unrelated existing var still renders (the new key doesn't shadow the curated ones).
    expect(renderTemplate('{{branch}}', vars)).toBe('feat')
  })

  it('renders empty when no frontend binds the service (the key is simply absent)', () => {
    const vars = templateVars({}, 'cf-env-1', undefined)
    expect(renderTemplate('{{frontendOrigins}}', vars)).toBe('')
  })
})

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

  it('qualifies the default with the repo so same-PR-number repos do not collide', () => {
    // Two repos in one workspace can both open PR #7; a bare cf-env-7 would collide.
    expect(resolveNamespace(baseConfig, { repoName: 'web', pullNumber: '7' })).toBe('cf-env-web-7')
    expect(resolveNamespace(baseConfig, { repoName: 'api', pullNumber: '7' })).toBe('cf-env-api-7')
  })

  it('falls back to the globally-unique block id when there is no repo context', () => {
    expect(resolveNamespace(baseConfig, { blockId: 'blk1', pullNumber: '7' })).toBe('cf-env-blk1')
  })

  it('sanitizes an unsafe namespace value to a valid label', () => {
    const ns = resolveNamespace({ ...baseConfig, namespaceTemplate: 'Feature/Login_Branch!' }, {})
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

  it('appends a configured ingress-template port, which the host template cannot carry', () => {
    // The rendered host template is also the Ingress `spec.rules[].host` the manifests declare, and
    // Kubernetes rejects a `host` with a port, so a cluster whose controller is published on a
    // non-default host port needs the port as its own field for the URL to be right.
    expect(
      deriveUrl(
        {
          source: 'ingressTemplate',
          hostTemplate: '{{branch}}.127.0.0.1.nip.io',
          port: 18080,
          scheme: 'http',
        },
        { branch: 'feat' },
        null,
      ),
    ).toBe('http://feat.127.0.0.1.nip.io:18080')
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
      extractLoadBalancerAddress({
        status: { loadBalancer: { ingress: [{ hostname: 'h', ip: '1.2.3.4' }] } },
      }),
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
    expect(
      classifyDeploymentReadiness({ spec: { replicas: 2 }, status: { availableReplicas: 2 } }),
    ).toBe('ready')
  })
  it('is pending while rolling out', () => {
    expect(
      classifyDeploymentReadiness({ spec: { replicas: 2 }, status: { availableReplicas: 1 } }),
    ).toBe('pending')
  })
  it('is gone on a terminal ProgressDeadlineExceeded', () => {
    expect(
      classifyDeploymentReadiness({
        spec: { replicas: 1 },
        status: {
          availableReplicas: 0,
          conditions: [
            { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' },
          ],
        },
      }),
    ).toBe('gone')
  })
})

describe('describeMisresolvingEnvironmentUrl', () => {
  it('refuses the composition that cost a run its tester step', () => {
    // `cf-acc-5` is the acceptance suite's per-PR namespace for pull request 5, in front of the
    // loopback host the k3s doc recommends. Resolves to 5.127.0.0, which is not this cluster.
    const refusal = describeMisresolvingEnvironmentUrl('http://cf-acc-5.127.0.0.1.nip.io')
    expect(refusal).toContain('5.127.0.0')
    expect(refusal).toContain('127.0.0.1')
  })

  it('sends the fix at the connection and says the manifests are not at fault', () => {
    // The disposition matters more than the wording: this failure classifies as
    // `config_incomplete` so no fixer is dispatched at a checkout that is already correct.
    const refusal = describeMisresolvingEnvironmentUrl('http://cf-acc-5.127.0.0.1.nip.io')
    expect(refusal).toContain('Kubernetes connection')
    expect(refusal).toContain('manifests, which are correct')
  })

  it('reads the host out of a URL carrying a port', () => {
    expect(describeMisresolvingEnvironmentUrl('http://cf-acc-5.127.0.0.1.nip.io:18080')).toContain(
      '5.127.0.0',
    )
  })

  it.each([
    // The same cluster, addressed by a namespace whose last label ends in a letter.
    'http://cf-env-catalog-api-pr5.127.0.0.1.nip.io',
    // An ordinary hostname, whatever digits it carries.
    'http://env-5.preview.example.com',
    // A LoadBalancer address, the other URL source.
    'http://192.168.1.40',
  ])('passes %s', (url) => {
    expect(describeMisresolvingEnvironmentUrl(url)).toBeNull()
  })

  it('says nothing when there is no URL yet, which is the status-backed sources on provision', () => {
    expect(describeMisresolvingEnvironmentUrl(null)).toBeNull()
  })

  it('leaves an unparseable URL to the policy that already refuses it', () => {
    // Answering here would put a DNS note in front of a failure that is not about DNS.
    expect(describeMisresolvingEnvironmentUrl('not a url')).toBeNull()
  })
})
