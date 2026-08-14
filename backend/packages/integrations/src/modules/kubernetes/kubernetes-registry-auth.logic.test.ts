import { describe, expect, it } from 'vitest'
import type { KubernetesProvisionConfig } from '@cat-factory/kernel'
import type { KubernetesResource } from './kubernetes-environment.logic.js'
import {
  buildPullSecret,
  buildServiceAccountPullSecretPatch,
  dockerConfigJson,
  isLocalThrowawayCluster,
  REGISTRY_AUTH_FIELD_MANAGER,
  REGISTRY_AUTH_SECRET_NAME,
  registryAuthImageCandidates,
  registryHostForImage,
  registriesCoveredByCloneUrl,
  resolveRegistryAuth,
  serviceAccountsNeedingPullSecret,
} from './kubernetes-registry-auth.logic.js'

const GITHUB_CLONE = 'https://github.com/acme/web.git'

describe('isLocalThrowawayCluster', () => {
  const at = (apiServerUrl: string) => isLocalThrowawayCluster({ apiServerUrl })

  it('recognises the shapes a local cluster actually presents', () => {
    // k3d, kind, Rancher Desktop and WSL2 k3s all publish their apiserver on loopback, which is
    // what the docs tell an operator to paste into the connection.
    expect(at('https://127.0.0.1:6443')).toBe(true)
    expect(at('https://localhost:6443')).toBe(true)
    expect(at('https://[::1]:6443')).toBe(true)
  })

  it('does not treat somebody else’s private cluster as a throwaway', () => {
    // The distinction that keeps this from being a credential leak: a shared staging cluster on
    // an RFC1918 address is another machine, however private the address looks.
    expect(at('https://10.4.1.9:6443')).toBe(false)
    expect(at('https://192.168.1.20:6443')).toBe(false)
    expect(at('https://cluster.internal:6443')).toBe(false)
    expect(at('https://prod-eks.example.com')).toBe(false)
  })

  it('answers no for an apiserver URL it cannot read', () => {
    expect(at('not a url')).toBe(false)
  })
})

describe('registryHostForImage', () => {
  it('reads the registry off a reference that names one', () => {
    expect(registryHostForImage('ghcr.io/acme/web:pr-42')).toBe('ghcr.io')
    expect(registryHostForImage('registry.gitlab.com/acme/web@sha256:abc')).toBe(
      'registry.gitlab.com',
    )
    expect(registryHostForImage('localhost:5000/web:dev')).toBe('localhost:5000')
  })

  it('answers null for a Docker Hub short name, which no VCS token covers', () => {
    // The first segment is a registry only when it LOOKS like a host. `library/postgres` and
    // `postgres` are both Docker Hub, and reporting `library` as a registry would put a git
    // credential up for consideration against a host that does not exist.
    expect(registryHostForImage('postgres:16')).toBeNull()
    expect(registryHostForImage('library/postgres:16')).toBeNull()
  })

  it('answers null for the empty reference an unconfigured image template renders', () => {
    // Not a degenerate input: `{{image}}` with no `imageTemplate` configured renders as '', and
    // that is the manifest that used to reach a cluster and fail there.
    expect(registryHostForImage('')).toBeNull()
    expect(registryHostForImage('   ')).toBeNull()
    expect(registryHostForImage(undefined)).toBeNull()
  })
})

describe('registriesCoveredByCloneUrl', () => {
  it('maps the hosted providers onto the registry they actually publish to', () => {
    expect(registriesCoveredByCloneUrl(GITHUB_CLONE)).toEqual(['ghcr.io'])
    expect(registriesCoveredByCloneUrl('https://gitlab.com/acme/web.git')).toEqual([
      'registry.gitlab.com',
    ])
  })

  it('maps any other host onto itself, the self-hosted shape', () => {
    expect(registriesCoveredByCloneUrl('https://gitlab.corp.internal/acme/web.git')).toEqual([
      'gitlab.corp.internal',
    ])
  })

  it('covers nothing when the clone URL cannot be read', () => {
    // The failure direction that matters: an unreadable URL must never widen what the credential
    // is offered to.
    expect(registriesCoveredByCloneUrl('not a url')).toEqual([])
    expect(registriesCoveredByCloneUrl('')).toEqual([])
  })
})

describe('resolveRegistryAuth', () => {
  const base = { cloneUrl: GITHUB_CLONE, token: 'gh-tok', repoOwner: 'acme' }

  it('wires the credential for an image on the registry the clone credential covers', () => {
    expect(resolveRegistryAuth({ ...base, images: ['ghcr.io/acme/web:pr-42'] })).toEqual([
      { registry: 'ghcr.io', username: 'acme', password: 'gh-tok' },
    ])
  })

  it('wires nothing when there is no token, which is what a public repo provisions with', () => {
    expect(resolveRegistryAuth({ ...base, token: undefined, images: ['ghcr.io/a/b'] })).toEqual([])
  })

  it('wires nothing for a registry the credential has no business at', () => {
    // The property that keeps this from being a credential leak: a GitHub token is never offered
    // to Docker Hub or to somebody else's registry just because a manifest named one.
    expect(resolveRegistryAuth({ ...base, images: ['registry.gitlab.com/a/b'] })).toEqual([])
    expect(resolveRegistryAuth({ ...base, images: ['postgres:16'] })).toEqual([])
  })

  it('collapses many references onto one credential per distinct registry', () => {
    const auths = resolveRegistryAuth({
      ...base,
      images: ['ghcr.io/acme/web:1', 'ghcr.io/acme/api:1', 'postgres:16', undefined],
    })
    expect(auths).toEqual([{ registry: 'ghcr.io', username: 'acme', password: 'gh-tok' }])
  })

  it('falls back to a neutral username when the provision carries no repo owner', () => {
    // Both registries authenticate on the token and accept any non-empty username, so the owner
    // is readability rather than a load-bearing value; a block-less provision still works.
    const [auth] = resolveRegistryAuth({ ...base, repoOwner: undefined, images: ['ghcr.io/a/b'] })
    expect(auth?.username).toBe('x-access-token')
  })
})

describe('the rendered Secret', () => {
  const auths = [{ registry: 'ghcr.io', username: 'acme', password: 'gh-tok' }]

  it('carries the credential in the shape a kubelet reads', () => {
    const secret = buildPullSecret('cf-env-42', auths)
    expect(secret.type).toBe('kubernetes.io/dockerconfigjson')
    expect(secret.metadata).toEqual({ name: REGISTRY_AUTH_SECRET_NAME, namespace: 'cf-env-42' })
    const data = (secret.data as Record<string, string>)['.dockerconfigjson']!
    expect(JSON.parse(atob(data))).toEqual({
      auths: {
        'ghcr.io': { username: 'acme', password: 'gh-tok', auth: btoa('acme:gh-tok') },
      },
    })
  })

  it('holds every covered registry, because one provision can pull from more than one', () => {
    const json = JSON.parse(
      dockerConfigJson([...auths, { registry: 'ghcr.io.other', username: 'a', password: 'b' }]),
    )
    expect(Object.keys(json.auths)).toEqual(['ghcr.io', 'ghcr.io.other'])
  })

  it('encodes UTF-8 bytes rather than code units', () => {
    // `btoa` on the raw string would throw (or truncate) on a non-ASCII owner, and the payload a
    // kubelet cannot parse is indistinguishable from a wrong password at pull time.
    const json = dockerConfigJson([{ registry: 'r.io', username: 'ünico', password: 'p' }])
    expect(JSON.parse(json).auths['r.io'].username).toBe('ünico')
    expect(() => atob(JSON.parse(json).auths['r.io'].auth)).not.toThrow()
  })
})

describe('serviceAccountsNeedingPullSecret', () => {
  const deployment = (serviceAccountName?: string): KubernetesResource => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web' },
    spec: { template: { spec: serviceAccountName ? { serviceAccountName } : {} } },
  })

  it('always includes the default account, which un-opinionated manifests run as', () => {
    expect(serviceAccountsNeedingPullSecret([deployment()])).toEqual(['default'])
  })

  it('includes the account a workload NAMES, which is the one default-only wiring misses', () => {
    // A pod that sets serviceAccountName does not read `default`, so attaching only there would
    // leave exactly the manifests that bothered to have an identity unable to pull.
    expect(serviceAccountsNeedingPullSecret([deployment('web-sa')])).toEqual(['default', 'web-sa'])
  })

  it('includes a declared account, and names each one once', () => {
    const declared: KubernetesResource = {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'web-sa' },
    }
    const pod: KubernetesResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'job' },
      spec: { serviceAccountName: 'web-sa' },
    }
    expect(serviceAccountsNeedingPullSecret([declared, pod, deployment('web-sa')])).toEqual([
      'default',
      'web-sa',
    ])
  })
})

describe('registryAuthImageCandidates', () => {
  const config = (images?: KubernetesProvisionConfig['images']): KubernetesProvisionConfig =>
    ({
      label: 'k3s',
      apiServerUrl: 'https://cluster.test:6443',
      manifestSource: { type: 'colocated', path: 'k8s' },
      url: { source: 'ingressTemplate', hostTemplate: 'h' },
      ...(images ? { images } : {}),
    }) as KubernetesProvisionConfig

  it('offers both render paths’ notion of an image', () => {
    // The raw path substitutes one `{{image}}`; a kustomize overlay names its images through
    // structured overrides instead. A provision carrying only the second must still be covered.
    const candidates = registryAuthImageCandidates(
      config([{ name: 'registry/app', newNameTemplate: 'ghcr.io/acme/{{repoName}}' }]),
      { image: 'ghcr.io/acme/web:pr-42', repoName: 'api' },
    )
    expect(candidates).toEqual(['ghcr.io/acme/web:pr-42', 'ghcr.io/acme/api'])
  })
})

describe('the field manager', () => {
  it('is not the manifests’ own', async () => {
    // Load-bearing rather than cosmetic: server-side apply treats each apply from one manager as
    // that manager's complete desired state, so sharing a manager with the manifest apply would
    // have a later apply of the same ServiceAccount strip the imagePullSecrets it does not
    // mention. Asserted against the provider's constant so the two cannot drift together.
    const { FIELD_MANAGER } = await import('./KubernetesEnvironmentProvider.js')
    expect(REGISTRY_AUTH_FIELD_MANAGER).not.toBe(FIELD_MANAGER)
    expect(buildServiceAccountPullSecretPatch('default', 'ns').imagePullSecrets).toEqual([
      { name: REGISTRY_AUTH_SECRET_NAME },
    ])
  })
})
