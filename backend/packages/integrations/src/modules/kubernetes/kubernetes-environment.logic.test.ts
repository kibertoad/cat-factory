import { describe, expect, it } from 'vitest'
import type { Block, KubernetesEnvironmentConfig, KubernetesUrlSource } from '@cat-factory/kernel'
import { describeWildcardDnsShift, frontendOriginsForService } from '@cat-factory/contracts'
import { classifyDeploymentReadiness } from './kubernetes.logic.js'
import {
  deriveUrl,
  describeUnreachableIngressHost,
  extractLoadBalancerAddress,
  isManifestFile,
  parseManifests,
  renderTemplate,
  resolveNamespace,
  resourceUrl,
  templateVars,
  classifyIngressAdmission,
  readIngressAdmissionFacts,
  readIngressClassCatalog,
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

  it('falls back to the PR number when no template is set, ending on a letter', () => {
    expect(resolveNamespace(baseConfig, { pullNumber: '7' })).toBe('cf-env-pr7')
  })

  it('qualifies the default with the repo so same-PR-number repos do not collide', () => {
    // Two repos in one workspace can both open PR #7; a bare cf-env-pr7 would collide.
    expect(resolveNamespace(baseConfig, { repoName: 'web', pullNumber: '7' })).toBe(
      'cf-env-web-pr7',
    )
    expect(resolveNamespace(baseConfig, { repoName: 'api', pullNumber: '7' })).toBe(
      'cf-env-api-pr7',
    )
  })

  it('composes with a wildcard-DNS host instead of shifting it, which is why the pr is there', () => {
    // The platform's OWN default was half of the pairing that published an address on another
    // network: `cf-env-web-7` in front of the loopback host its docs recommend answers 7.127.0.0.
    // A default that only stopped being wrong once an operator overrode it is not a default.
    const host = `${resolveNamespace(baseConfig, { repoName: 'web', pullNumber: '7' })}.127.0.0.1.nip.io`
    expect(describeWildcardDnsShift(host)).toBeNull()
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

describe('describeUnreachableIngressHost', () => {
  const ingress = (hostTemplate: string): KubernetesUrlSource => ({
    source: 'ingressTemplate',
    hostTemplate,
    scheme: 'http',
  })

  it('refuses the composition that cost a run its tester step', () => {
    // `cf-acc-5` is the per-PR namespace for pull request 5 in front of the loopback host the k3s
    // doc recommends. It resolves to 5.127.0.0, which is not this cluster.
    const refusal = describeUnreachableIngressHost(ingress('{{namespace}}.127.0.0.1.nip.io'), {
      namespace: 'cf-acc-5',
    })
    expect(refusal).toContain('5.127.0.0')
    expect(refusal).toContain('127.0.0.1')
  })

  it('sends the fix at the connection and says the manifests are not at fault', () => {
    // The disposition matters more than the wording: this failure classifies as
    // `config_incomplete` so no fixer is dispatched at a checkout that is already correct.
    const refusal = describeUnreachableIngressHost(ingress('{{namespace}}.127.0.0.1.nip.io'), {
      namespace: 'cf-acc-5',
    })
    expect(refusal).toContain('environment connection')
    expect(refusal).toContain('manifests, which are correct')
  })

  it('refuses a rendered host a URL would truncate rather than grading the truncation', () => {
    // The template the guided k3s setup used to write. `{{branch}}` is `cat-factory/<taskId>`, so
    // the URL becomes `http://cat-factory/task_….127.0.0.1.nip.io`, whose AUTHORITY is the bare
    // `cat-factory` — an unremarkable-looking name with no wildcard suffix and nothing to report.
    // Graded as the rendered string, what actually happened is visible.
    const refusal = describeUnreachableIngressHost(ingress('{{branch}}.127.0.0.1.nip.io'), {
      branch: 'cat-factory/task_19312e8862264172b1fa1051',
    })
    expect(refusal).toContain('not a hostname')
    expect(refusal).toContain('cat-factory/task_19312e8862264172b1fa1051.127.0.0.1.nip.io')
    expect(refusal).toContain('{{branch}}.127.0.0.1.nip.io')
  })

  it.each(['{{namespace}} .example.com', '{{namespace}}_1.example.com'])(
    'refuses %s, which renders no name a resolver is ever asked for',
    (template) => {
      expect(describeUnreachableIngressHost(ingress(template), { namespace: 'app' })).toContain(
        'not a hostname',
      )
    },
  )

  it('leaves a placeholder that rendered EMPTY to the rule that owns missing values', () => {
    // `.preview.example.com` is unreachable, but the cause is a hole nothing filled, and
    // answering it here would hand back hostname-character advice for a missing-variable fault.
    expect(describeUnreachableIngressHost(ingress('{{branch}}.preview.example.com'), {})).toBeNull()
  })

  it.each([
    // The same cluster, addressed by a namespace whose last label ends in a letter.
    { template: '{{namespace}}.127.0.0.1.nip.io', vars: { namespace: 'cf-env-catalog-api-pr5' } },
    // An ordinary hostname, whatever digits it carries.
    { template: '{{namespace}}.preview.example.com', vars: { namespace: 'env-5' } },
    // Upper case resolves perfectly well; the apiserver owns what an Ingress host may look like.
    { template: '{{namespace}}.Example.COM', vars: { namespace: 'App' } },
  ])('passes $template', ({ template, vars }) => {
    expect(describeUnreachableIngressHost(ingress(template), vars)).toBeNull()
  })

  it('says nothing for a status-backed source, which has rendered nothing yet', () => {
    // Its live host is graded where every provider's published URL is, on the way to being
    // recorded. Answering here would be answering about a value that does not exist.
    expect(
      describeUnreachableIngressHost({ source: 'ingressStatus', scheme: 'http' }, {}),
    ).toBeNull()
  })

  it('says nothing when the template renders empty, which is a hole this rule does not own', () => {
    expect(describeUnreachableIngressHost(ingress('{{namespace}}'), {})).toBeNull()
  })
})

describe('ingress admission', () => {
  const traefik = {
    read: true as const,
    names: ['traefik'],
    defaultName: 'traefik',
  }

  const ingress = (spec: Record<string, unknown>, status?: Record<string, unknown>) => ({
    metadata: { name: 'catalog-api' },
    spec,
    ...(status ? { status } : {}),
  })

  describe('readIngressAdmissionFacts', () => {
    it('reads the class off spec.ingressClassName', () => {
      expect(readIngressAdmissionFacts(ingress({ ingressClassName: 'nginx' }))).toEqual({
        requestedClass: 'nginx',
        hasAddress: false,
      })
    })

    it('falls back to the deprecated annotation, so an Ingress using it is not graded classless', () => {
      // Controllers still honour `kubernetes.io/ingress.class`. Reading only the spec field would
      // call this Ingress classless and then refuse it on a cluster with no default class, which
      // is a working deployment turned red.
      const obj = {
        metadata: { name: 'x', annotations: { 'kubernetes.io/ingress.class': 'traefik' } },
        spec: {},
      }
      expect(readIngressAdmissionFacts(obj).requestedClass).toBe('traefik')
    })

    it('prefers the spec field over the annotation and ignores a blank one', () => {
      const obj = {
        metadata: { name: 'x', annotations: { 'kubernetes.io/ingress.class': 'nginx' } },
        spec: { ingressClassName: '  traefik ' },
      }
      expect(readIngressAdmissionFacts(obj).requestedClass).toBe('traefik')
      expect(
        readIngressAdmissionFacts(ingress({ ingressClassName: '   ' })).requestedClass,
      ).toBeNull()
    })

    it('reports an address once a controller has written one back', () => {
      const admitted = ingress(
        { ingressClassName: 'traefik' },
        {
          loadBalancer: { ingress: [{ ip: '172.20.0.2' }] },
        },
      )
      expect(readIngressAdmissionFacts(admitted).hasAddress).toBe(true)
    })
  })

  describe('readIngressClassCatalog', () => {
    it('reads the names and which one is default', () => {
      const payload = {
        items: [
          {
            metadata: {
              name: 'traefik',
              annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' },
            },
          },
          { metadata: { name: 'nginx' } },
        ],
      }
      expect(readIngressClassCatalog(payload)).toEqual({
        read: true,
        names: ['traefik', 'nginx'],
        defaultName: 'traefik',
      })
    })

    it('reads an EMPTY list as a read cluster with no classes, not as unreadable', () => {
      // The distinction decides everything downstream: this is the k3d-with-traefik-disabled
      // cluster, and it is a real, actionable finding.
      expect(readIngressClassCatalog({ items: [] })).toEqual({
        read: true,
        names: [],
        defaultName: null,
      })
    })

    it('reads a non-list payload as UNREADABLE, never as an empty cluster', () => {
      // A 403 on the cluster-scoped resource arrives here as a null body. Grading that as "no
      // ingress controller" would fail every environment on a perfectly working cluster.
      for (const payload of [null, undefined, {}, { items: 'nope' }]) {
        expect(readIngressClassCatalog(payload).read).toBe(false)
      }
    })
  })

  describe('classifyIngressAdmission', () => {
    it('is ADMITTED once any Ingress carries an address', () => {
      const facts = [{ requestedClass: 'traefik', hasAddress: true }]
      expect(classifyIngressAdmission(facts, traefik)).toEqual({ status: 'admitted' })
    })

    it('short-circuits on an address even when the catalog could not be read', () => {
      // An address is proof a controller claimed it, which is strictly stronger than anything the
      // catalog could say. Asking for the catalog first would strand this on `unknown`.
      const facts = [{ requestedClass: 'whatever', hasAddress: true }]
      expect(classifyIngressAdmission(facts, { read: false, detail: 'forbidden' })).toEqual({
        status: 'admitted',
      })
    })

    it('refuses a class the cluster does not have, and names both sides', () => {
      // THE motivating failure: an agent wrote `ingressClassName: nginx` onto a Traefik k3d
      // cluster. Healthy pod, accepted object, URL published, nothing routing it.
      const facts = [{ requestedClass: 'nginx', hasAddress: false }]
      const verdict = classifyIngressAdmission(facts, traefik)
      expect(verdict.status).toBe('unrouted')
      if (verdict.status !== 'unrouted') throw new Error('expected unrouted')
      expect(verdict.problem).toContain("'nginx'")
      expect(verdict.problem).toContain("'traefik'")
    })

    it('refuses a cluster that publishes no IngressClass at all', () => {
      const facts = [{ requestedClass: null, hasAddress: false }]
      const verdict = classifyIngressAdmission(facts, {
        read: true,
        names: [],
        defaultName: null,
      })
      expect(verdict.status).toBe('unrouted')
      if (verdict.status !== 'unrouted') throw new Error('expected unrouted')
      expect(verdict.problem).toContain('no ingress controller')
    })

    it('refuses a classless Ingress on a cluster that marks no default', () => {
      const facts = [{ requestedClass: null, hasAddress: false }]
      const verdict = classifyIngressAdmission(facts, {
        read: true,
        names: ['nginx'],
        defaultName: null,
      })
      expect(verdict.status).toBe('unrouted')
      if (verdict.status !== 'unrouted') throw new Error('expected unrouted')
      expect(verdict.problem).toContain('is-default-class')
    })

    it('is PENDING when the requested class exists but nothing is marked default', () => {
      // ingress-nginx installed on its own: the controller publishes and claims 'nginx', and
      // nobody annotated it default because no Ingress here is classless. Refusing this failed a
      // working deployment, and said the Ingress named no class while it plainly named one. The
      // default class governs classless Ingresses only, so it may not be read as a cluster-wide
      // requirement.
      const facts = [{ requestedClass: 'nginx', hasAddress: false }]
      expect(
        classifyIngressAdmission(facts, { read: true, names: ['nginx'], defaultName: null }),
      ).toEqual({ status: 'pending' })
    })

    it('still refuses the CLASSLESS Ingress in a chain whose sibling names a real class', () => {
      // The precondition is per-chain, not per-Ingress: one Ingress being satisfiable says nothing
      // about the one beside it that asked for nothing and has no default to claim it.
      const facts = [
        { requestedClass: 'nginx', hasAddress: false },
        { requestedClass: null, hasAddress: false },
      ]
      const verdict = classifyIngressAdmission(facts, {
        read: true,
        names: ['nginx'],
        defaultName: null,
      })
      expect(verdict.status).toBe('unrouted')
      if (verdict.status !== 'unrouted') throw new Error('expected unrouted')
      expect(verdict.problem).toContain('is-default-class')
    })

    it('is PENDING, never a refusal, when the class resolves but no address has arrived', () => {
      // The safety property. A controller writing `status.loadBalancer` back is a choice, not a
      // guarantee, so an absent address may never be evidence of a broken route: it only
      // withholds `ready` until the provision's own deadline reports a timeout.
      const facts = [{ requestedClass: 'traefik', hasAddress: false }]
      expect(classifyIngressAdmission(facts, traefik)).toEqual({ status: 'pending' })
    })

    it('is PENDING for a classless Ingress the default class will claim', () => {
      const facts = [{ requestedClass: null, hasAddress: false }]
      expect(classifyIngressAdmission(facts, traefik)).toEqual({ status: 'pending' })
    })

    it('is PENDING when the namespace declares no Ingress, since a Gateway may serve the host', () => {
      // An `ingressTemplate` URL says where the URL comes FROM, not what routes it. Refusing here
      // would fail a Gateway/HTTPRoute deployment on an assumption about how it was built.
      expect(classifyIngressAdmission([], traefik)).toEqual({ status: 'pending' })
    })

    it('is UNKNOWN when the catalog could not be read, so the check stands down', () => {
      const facts = [{ requestedClass: 'nginx', hasAddress: false }]
      expect(classifyIngressAdmission(facts, { read: false, detail: 'forbidden' })).toEqual({
        status: 'unknown',
        detail: 'forbidden',
      })
    })
  })
})
