import type { KubernetesConnectionConfig, KubernetesProvisionConfig } from '@cat-factory/kernel'
import { isLoopbackHost } from '@cat-factory/kernel'
import { resolveImageOverrides } from './kubernetes-deploy.logic.js'
import type { KubernetesResource } from './kubernetes-environment.logic.js'

// Pure helpers for wiring a per-PR namespace's REGISTRY PULL CREDENTIAL on a throwaway
// local cluster. No I/O — the provider does the apiserver writes.
//
// The problem these solve: a per-PR namespace is created by the platform seconds before the
// manifests are applied, so a pull secret cannot be waiting in it, and the images a scaffolded
// service builds are published to the VCS host's own registry (GHCR for GitHub, the GitLab
// container registry for GitLab), which is PRIVATE until somebody makes it public. The pull then
// 403s for the whole life of the environment and presents as a cluster that never becomes ready.
//
// The credential to fix it is already in hand: a provision resolves a short-lived git token to
// clone the manifests repo, and that same token authenticates against the VCS host's registry.
// So nothing new is configured, asked for, or stored. What is derived here is only whether the
// token PLAUSIBLY covers the registry the image names, which is the one judgement that must not
// be made by guessing.

/**
 * Whether this cluster is one running on the machine that is provisioning into it, which is what
 * makes the automatic credential wiring appropriate.
 *
 * The test is the APISERVER being a loopback address, and it is deliberately not the handler's
 * declared engine. A public-API caller cannot pick between `local-k3s` and `remote-kubernetes`
 * (the split is not a public fact, and every API-registered connection lands on the remote name),
 * so gating on the engine would give two identically-configured clusters different behaviour
 * depending on which door connected them, and would silently miss the acceptance suite entirely.
 * The apiserver address is the same fact for both doors.
 *
 * Loopback rather than "private" (`isBlockedPrivateHost`) because a shared staging cluster on
 * 10.x is somebody else's machine however private its address, and its namespaces are not a place
 * to put a developer's git token unasked. The residual case is a port-forward of a remote
 * apiserver to localhost, which reads as local here; the cost is a short-lived token in a
 * namespace this platform created, and it is named in the operator docs.
 */
export function isLocalThrowawayCluster(config: KubernetesConnectionConfig): boolean {
  try {
    return isLoopbackHost(new URL(config.apiServerUrl).hostname)
  } catch {
    // silent-catch-ok: an apiserver URL that will not parse is about to fail the provision on its
    // own terms, with a better message than anything this could add. Not local ⇒ nothing written.
    return false
  }
}

/** Name of the pull Secret the provider materializes in the per-PR namespace. */
export const REGISTRY_AUTH_SECRET_NAME = 'cat-factory-registry-auth'

/**
 * Field manager for the pull-secret writes, DELIBERATELY distinct from the manifest apply's.
 *
 * Server-side apply treats every apply from one manager as that manager's complete desired
 * state, so patching a ServiceAccount's `imagePullSecrets` under the same manager the manifests
 * apply through would have the manifests' own apply of that ServiceAccount silently REMOVE the
 * field again (it does not mention it, so the manager is declaring it gone). Under a separate
 * manager the two own disjoint fields and both survive.
 */
export const REGISTRY_AUTH_FIELD_MANAGER = 'cat-factory-registry-auth'

/** A resolved registry credential: what to log into, and with what. */
export interface RegistryAuth {
  /** Registry host, e.g. `ghcr.io`. */
  registry: string
  username: string
  password: string
}

/**
 * The registry host an image reference pulls from, or null when it names none.
 *
 * A reference's first path segment is a registry only when it looks like a host (it carries a
 * `.` or a `:`, or it is `localhost`); otherwise the reference is a Docker Hub short name and
 * this answers null. Null is the honest answer rather than `docker.io`, because the caller's
 * question is "is this a registry a VCS token could cover", and Docker Hub never is.
 *
 * An empty string answers null too. That is not a degenerate case: an unconfigured
 * `imageTemplate` renders `{{image}}` as the empty string, which is exactly the manifest that
 * used to reach a cluster and fail there.
 */
export function registryHostForImage(image: string | undefined): string | null {
  const ref = image?.trim()
  if (!ref) return null
  const slash = ref.indexOf('/')
  if (slash === -1) return null
  const head = ref.slice(0, slash)
  if (head === 'localhost' || head.includes('.') || head.includes(':')) return head
  return null
}

/**
 * The registry hosts a git credential for `cloneUrl` can be expected to authenticate against.
 *
 * The two hosted providers publish their registry on a DIFFERENT host from their git host, so
 * those two are mapped explicitly. Any other host maps to ITSELF, which is the self-hosted
 * GitLab shape (git and registry on one host). A host whose registry is neither is simply not
 * matched, and an unmatched registry means the convenience does not apply: the failure direction
 * is "no pull secret written", never "a credential sent somewhere it does not belong".
 */
export function registriesCoveredByCloneUrl(cloneUrl: string): string[] {
  let host: string
  try {
    host = new URL(cloneUrl).hostname.toLowerCase()
  } catch {
    // silent-catch-ok: an unparseable clone URL only costs the pull-secret convenience, and the
    // provision goes on to fail (or succeed) on its own terms. There is nothing to report that
    // the clone itself will not report better.
    return []
  }
  if (!host) return []
  if (host === 'github.com') return ['ghcr.io']
  if (host === 'gitlab.com') return ['registry.gitlab.com']
  return [host]
}

/**
 * Every image reference a provision could pull, across both render paths: the single rendered
 * `{{image}}` the raw path substitutes, plus the `newName` of each structured image override a
 * kustomize overlay carries. Both are collected unconditionally because a config may carry
 * either or both, and a candidate that names no registry is dropped downstream anyway.
 */
export function registryAuthImageCandidates(
  config: KubernetesProvisionConfig,
  vars: Record<string, string>,
): (string | undefined)[] {
  return [vars.image, ...resolveImageOverrides(config.images, vars).map((image) => image.newName)]
}

/**
 * Which of a provision's image references the git credential covers, as one credential per
 * distinct registry. An empty result means "do not write a pull secret", for any of the reasons
 * that legitimately produce it: no images, a Docker Hub short name, no token (a public repo
 * needs none), or a registry this credential has no business at.
 *
 * It takes the image refs as a LIST because the two render paths name their images differently:
 * the raw path resolves one `{{image}}`, while a kustomize overlay carries a structured image
 * override per container. Reducing them here keeps that difference out of the provider.
 *
 * The username is the repo owner when the provision knows one. GHCR and the GitLab registry both
 * authenticate on the TOKEN and accept any non-empty username, so the owner is a readable
 * default rather than a load-bearing value, and the fallback covers a provision that carries no
 * repo context.
 */
export function resolveRegistryAuth(args: {
  images: (string | undefined)[]
  cloneUrl: string
  token: string | undefined
  repoOwner?: string
}): RegistryAuth[] {
  if (!args.token) return []
  const covered = registriesCoveredByCloneUrl(args.cloneUrl)
  const username = args.repoOwner?.trim() || 'x-access-token'
  const seen = new Map<string, RegistryAuth>()
  for (const image of args.images) {
    const registry = registryHostForImage(image)
    if (!registry) continue
    const key = registry.toLowerCase()
    if (!covered.includes(key) || seen.has(key)) continue
    seen.set(key, { registry, username, password: args.token })
  }
  return [...seen.values()]
}

/** The `.dockerconfigjson` payload a `kubernetes.io/dockerconfigjson` Secret carries. */
export function dockerConfigJson(auths: RegistryAuth[]): string {
  const entries = auths.map((auth) => [
    auth.registry,
    {
      username: auth.username,
      password: auth.password,
      auth: base64(`${auth.username}:${auth.password}`),
    },
  ])
  return JSON.stringify({ auths: Object.fromEntries(entries) })
}

/** The pull Secret to apply into the per-PR namespace. */
export function buildPullSecret(namespace: string, auths: RegistryAuth[]): KubernetesResource {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: REGISTRY_AUTH_SECRET_NAME, namespace },
    type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': base64(dockerConfigJson(auths)) },
  }
}

/**
 * The ServiceAccount body that attaches the pull secret. Applied per name, under the dedicated
 * field manager, so it carries `imagePullSecrets` and nothing else: whatever else the account
 * has (or the manifests later give it) is owned by another manager and left alone.
 */
export function buildServiceAccountPullSecretPatch(
  name: string,
  namespace: string,
): KubernetesResource {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name, namespace },
    imagePullSecrets: [{ name: REGISTRY_AUTH_SECRET_NAME }],
  }
}

/**
 * Every ServiceAccount that needs the pull secret attached: `default`, plus each account the
 * manifests declare, plus each one their pod templates NAME (which the manifests do not
 * necessarily declare themselves).
 *
 * The last two are what make this cover more than the `default`-ServiceAccount trick alone: a
 * workload that sets `serviceAccountName` does not read `default`, so attaching only there would
 * leave exactly the manifests that bothered to have an identity unable to pull.
 */
export function serviceAccountsNeedingPullSecret(resources: KubernetesResource[]): string[] {
  const names = new Set<string>(['default'])
  for (const resource of resources) {
    if (resource.kind === 'ServiceAccount' && resource.metadata.name) {
      names.add(resource.metadata.name)
    }
    const referenced = podSpecServiceAccountName(resource)
    if (referenced) names.add(referenced)
  }
  return [...names]
}

/**
 * The `serviceAccountName` a resource's pod template declares, reading both the workload shape
 * (`spec.template.spec`) and a bare Pod's own `spec`. Unknown shapes answer null.
 */
function podSpecServiceAccountName(resource: KubernetesResource): string | null {
  const spec = resource.spec as
    | { serviceAccountName?: unknown; template?: { spec?: { serviceAccountName?: unknown } } }
    | undefined
  const name = spec?.template?.spec?.serviceAccountName ?? spec?.serviceAccountName
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/**
 * Base64 of a string's UTF-8 bytes. `btoa` alone is wrong here: it encodes CODE UNITS, so any
 * non-ASCII character in a repo owner would produce a payload the apiserver stores and the
 * kubelet cannot parse. The bytes are accumulated in a loop rather than spread into
 * `String.fromCharCode(...)`, which blows the call stack on a large enough input.
 */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
