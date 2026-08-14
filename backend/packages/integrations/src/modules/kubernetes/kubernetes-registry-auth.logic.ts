import type { KubernetesConnectionConfig, KubernetesProvisionConfig } from '@cat-factory/kernel'
import { isLocalMachineHost } from '@cat-factory/kernel'
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
 * The apiserver's hostname, or null when the URL will not parse (a provision that is about to
 * fail on its own terms, with a better message than anything derived here).
 */
export function apiServerHostname(config: KubernetesConnectionConfig): string | null {
  try {
    return new URL(config.apiServerUrl).hostname.toLowerCase()
  } catch {
    // silent-catch-ok: the provision fails on the malformed URL a moment later. Reported by the
    // caller as an unreadable apiserver rather than swallowed.
    return null
  }
}

/**
 * Whether this cluster is one running on the machine that is provisioning into it, which is what
 * makes the automatic credential wiring appropriate.
 *
 * The test is the APISERVER HOST, and it is deliberately not the handler's declared engine. A
 * public-API caller cannot pick between `local-k3s` and `remote-kubernetes` (the split is not a
 * public fact, and every API-registered connection lands on the remote name), so gating on the
 * engine would give two identically-configured clusters different behaviour depending on which
 * door connected them, and would silently miss the acceptance suite entirely. The apiserver
 * address is the same fact for both doors.
 *
 * `isLocalMachineHost` rather than a bare loopback test, because the two spellings a local
 * cluster actually writes into a kubeconfig are k3d's wildcard `0.0.0.0` and Docker Desktop's
 * `kubernetes.docker.internal`. Gating on loopback alone withheld the whole behaviour from the
 * default setup of both, which is most of the population it exists for. Still not "private"
 * (`isBlockedPrivateHost`): a shared staging cluster on 10.x is somebody else's machine however
 * private its address, and its namespaces are not a place to put a developer's git token unasked.
 * The residual case is a port-forward of a remote apiserver to localhost, which reads as local
 * here; the cost is a short-lived token in a namespace this platform created, and it is named in
 * the operator docs.
 */
export function isLocalThrowawayCluster(config: KubernetesConnectionConfig): boolean {
  const host = apiServerHostname(config)
  return host !== null && isLocalMachineHost(host)
}

/** Name of the pull Secret the provider materializes in the per-PR namespace. */
export const REGISTRY_AUTH_SECRET_NAME = 'cat-factory-registry-auth'

/**
 * Field manager for the writes this module's resources go in under, DELIBERATELY distinct from
 * the manifest apply's.
 *
 * Server-side apply treats every apply from one manager as that manager's complete desired
 * state, so writing the Secret and the undeclared-account patches under the manifests' manager
 * would have the next manifest apply declare them gone. A separate manager owns them outright.
 *
 * What this does NOT buy is co-ownership of a field the manifests also set: see
 * {@link withPullSecretOnServiceAccounts} for why a DECLARED account's `imagePullSecrets` cannot
 * be split across two managers at all.
 */
export const REGISTRY_AUTH_FIELD_MANAGER = 'cat-factory-registry-auth'

/**
 * How long the wired credential stays usable, stated because nothing renews it.
 *
 * The password is the provision's own short-lived git token (a GitHub App installation token
 * lasts about an hour), and the Secret keeps whatever value it held at provision time. Every
 * image pull inside that window succeeds; a pull AFTER it (a rollout, a scale-up, a pod
 * rescheduled onto a node with no cached layer) re-enters `ImagePullBackOff` with no new
 * provisioning-log entry to explain it, because nothing ran. Re-provisioning the environment
 * mints a fresh token and rewrites the Secret.
 *
 * A renewing design would need something that outlives the provision (a controller in the
 * cluster, or a sweep re-writing every live environment's Secret), which is a large amount of
 * machinery for a throwaway local preview whose images are almost always pulled once at rollout.
 * The honest half of the trade is that the window is NAMED: in the recorded step, and in the
 * operator doc.
 */
export const REGISTRY_AUTH_CREDENTIAL_LIFETIME =
  'about an hour, the git token being short-lived and nothing renewing it: a pull after that ' +
  '(a rollout, a scale-up, a reschedule) needs the environment re-provisioned'

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
 * The distinct registries a provision's image references name, in first-seen order. An image
 * that names none (a Docker Hub short name, an unset `{{image}}`) contributes nothing.
 */
export function registriesNamedByImages(images: (string | undefined)[]): string[] {
  const seen = new Map<string, string>()
  for (const image of images) {
    const registry = registryHostForImage(image)
    if (registry && !seen.has(registry.toLowerCase())) seen.set(registry.toLowerCase(), registry)
  }
  return [...seen.values()]
}

/**
 * Why a provision ended up with (or without) a pull credential. A discriminated verdict rather
 * than an empty array, because the four ways to end up with no credential need four different
 * things from whoever reads the provisioning log next to an `ImagePullBackOff`: nothing to do,
 * wire a VCS connection, make the package public or grant the token package-read scope, and
 * "this registry is not one the git host serves". An empty list said all four at once.
 */
export type RegistryAuthVerdict =
  /** At least one image names a registry the clone credential covers. */
  | { kind: 'wired'; auths: RegistryAuth[] }
  /** No image reference names a registry, so no credential could apply to anything. */
  | { kind: 'no-registry-image'; images: string[] }
  /** Images name a registry, but the provision has no clone target at all (no VCS connection). */
  | { kind: 'no-clone-target'; registries: string[] }
  /** A clone target with no token: a public manifests repo needs none, and none is derivable. */
  | { kind: 'no-token'; registries: string[] }
  /** The credential's git host does not serve the registries the images name. */
  | { kind: 'registry-not-covered'; registries: string[]; covered: string[] }

/**
 * Which of a provision's image references the git credential covers, as one credential per
 * distinct registry, or the reason there is none.
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
  clone: { cloneUrl: string; token?: string | undefined } | undefined
  repoOwner?: string
}): RegistryAuthVerdict {
  const registries = registriesNamedByImages(args.images)
  if (registries.length === 0) {
    return {
      kind: 'no-registry-image',
      images: args.images.filter((i): i is string => !!i?.trim()),
    }
  }
  if (!args.clone) return { kind: 'no-clone-target', registries }
  const token = args.clone.token
  if (!token) return { kind: 'no-token', registries }
  const covered = registriesCoveredByCloneUrl(args.clone.cloneUrl)
  const username = args.repoOwner?.trim() || 'x-access-token'
  const auths = registries
    .filter((registry) => covered.includes(registry.toLowerCase()))
    .map((registry) => ({ registry, username, password: token }))
  if (auths.length === 0) return { kind: 'registry-not-covered', registries, covered }
  return { kind: 'wired', auths }
}

/** Why the wiring did not run at all, as opposed to running and finding no credential to wire. */
export type RegistryAuthSkip =
  /** The apiserver is not this machine's, so a git token is not ours to put in its namespaces. */
  | { kind: 'not-local-cluster'; apiServerHost: string | null }
  /**
   * A kustomize overlay chooses its own namespace, resolved inside the deploy container. Nothing
   * can be placed before dispatch because the destination is not known yet.
   */
  | { kind: 'namespace-not-derivable' }

/** One line for the provisioning log explaining why nothing was attempted. */
export function describeRegistryAuthSkip(skip: RegistryAuthSkip): string {
  switch (skip.kind) {
    case 'not-local-cluster':
      return (
        `No registry credential wired: the apiserver ` +
        `(${skip.apiServerHost ?? 'an unreadable URL'}) is not on this machine, and a git ` +
        `credential is only placed into namespaces on a local throwaway cluster. A private ` +
        `image needs a pull secret this deployment provides.`
      )
    case 'namespace-not-derivable':
      return (
        `No registry credential wired: this kustomize overlay declares its own namespace, ` +
        `which is resolved when the overlay is built inside the deploy container, so there is ` +
        `no namespace to place a pull secret in before dispatch. Set a namespace template on ` +
        `the connection to get per-PR isolation and automatic registry credentials.`
      )
    default:
      return exhaustiveSkip(skip)
  }
}

/** What the wiring did, once it ran. */
export interface RegistryAuthWiredReport {
  auths: RegistryAuth[]
  /** Accounts patched under this module's own field manager. */
  patchedAccounts: string[]
  /** ServiceAccounts the manifests declare, which carry the secret in their own body. */
  declaredAccounts: string[]
  /** False on the container-render path, where the manifests are not visible to the backend. */
  manifestsVisible: boolean
}

/**
 * One line for the provisioning log describing the credential outcome.
 *
 * Every branch is spelled out rather than collapsed into "no credential wired", because the four
 * causes need four different actions and only this log records which one happened: by the time
 * an `ImagePullBackOff` is visible, nothing distinguishes a public image that never needed a
 * credential from a private one whose credential was refused.
 */
export function describeRegistryAuthVerdict(
  verdict: RegistryAuthVerdict,
  report?: RegistryAuthWiredReport,
): string {
  switch (verdict.kind) {
    case 'wired': {
      const wired = report ?? {
        auths: verdict.auths,
        patchedAccounts: [],
        declaredAccounts: [],
        manifestsVisible: false,
      }
      const covered = wired.manifestsVisible
        ? `${wired.patchedAccounts.length} service account(s) directly and ` +
          `${wired.declaredAccounts.length} declared by the manifests`
        : `the default service account only (this render path builds its manifests inside the ` +
          `deploy container, so the accounts they declare are not visible here)`
      return (
        `Wired a ${wired.auths.map((a) => a.registry).join(', ')} pull credential ` +
        `(user '${wired.auths[0]!.username}') into ${covered}. It lasts ` +
        `${REGISTRY_AUTH_CREDENTIAL_LIFETIME}. A 403 before then means the git token lacks ` +
        `package-read scope.`
      )
    }
    case 'no-registry-image':
      return (
        `No registry credential wired: ` +
        `${verdict.images.length > 0 ? `[${verdict.images.join(', ')}] names` : 'the manifests name'} ` +
        `no registry host, so no credential could apply. An image pulled from Docker Hub or an ` +
        `unqualified name is never covered by a git credential.`
      )
    case 'no-clone-target':
      return (
        `No registry credential wired for [${verdict.registries.join(', ')}]: this provision has ` +
        `no clone target, so there is no git credential to derive one from (no VCS connection, ` +
        `or a block-less manual provision). A private image will fail to pull.`
      )
    case 'no-token':
      return (
        `No registry credential wired for [${verdict.registries.join(', ')}]: the manifests repo ` +
        `is cloned without a token, so none is available to reuse. That is expected for a public ` +
        `manifests repo. A private image will fail to pull.`
      )
    case 'registry-not-covered':
      return (
        `No registry credential wired: the images pull from ` +
        `[${verdict.registries.join(', ')}], and the git credential authenticates against ` +
        `[${verdict.covered.join(', ') || 'no registry'}]. A private image will fail to pull.`
      )
    default:
      return exhaustiveVerdict(verdict)
  }
}

/* c8 ignore start -- compile-time totality guards; unreachable while the unions are exhaustive. */
function exhaustiveSkip(skip: never): string {
  return `No registry credential wired: ${JSON.stringify(skip)}`
}

function exhaustiveVerdict(verdict: never): string {
  return `No registry credential wired: ${JSON.stringify(verdict)}`
}
/* c8 ignore stop */

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
 * The ServiceAccount body that attaches the pull secret to an account the manifests do NOT
 * declare. Applied under the dedicated field manager, carrying `imagePullSecrets` and nothing
 * else, so whatever else the account has is owned by another manager and left alone.
 *
 * Only safe for an UNDECLARED account, which is why {@link serviceAccountsNeedingOwnPatch} picks
 * the names: `imagePullSecrets` is an ATOMIC list, so the manager that applies it last owns the
 * whole thing. Against an account the manifests also apply, this write is either erased by them
 * or erases theirs, depending on the order. A declared account is served by
 * {@link withPullSecretOnServiceAccounts} instead, which puts the entry into the manifests' own
 * body so ONE manager declares the union.
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

/** The `imagePullSecrets` entries a ServiceAccount resource already declares, names only. */
function declaredPullSecretNames(resource: KubernetesResource): string[] {
  const raw = (resource as { imagePullSecrets?: unknown }).imagePullSecrets
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
}

/**
 * The manifests' own resources, with every ServiceAccount they declare carrying the pull secret
 * alongside whatever it already declared.
 *
 * This exists because `ServiceAccount.imagePullSecrets` is an ATOMIC list in the OpenAPI schema:
 * server-side apply gives ownership of the WHOLE list to one manager, so two managers cannot own
 * disjoint entries of it the way they can own disjoint fields. A separate-manager patch beside
 * the manifests' own apply is therefore not a merge, it is a race, and with `force=true` the
 * later writer wins outright. Since the manifests are applied by this provider, the fix is to
 * apply the UNION: the entry goes into their declared body and no second writer touches the
 * field. Their own entries are preserved and never reordered, so a manifest that pins a pull
 * secret keeps it first.
 *
 * A pod's pull secrets are resolved by the ServiceAccount admission controller when the pod is
 * CREATED, which is the other half of why this shape is the correct one: patching the account
 * after its Deployment applied would leave the pods already admitted without the secret.
 */
export function withPullSecretOnServiceAccounts(
  resources: KubernetesResource[],
): KubernetesResource[] {
  return resources.map((resource) => {
    if (resource.kind !== 'ServiceAccount') return resource
    const existing = declaredPullSecretNames(resource)
    if (existing.includes(REGISTRY_AUTH_SECRET_NAME)) return resource
    return {
      ...resource,
      imagePullSecrets: [
        ...existing.map((name) => ({ name })),
        { name: REGISTRY_AUTH_SECRET_NAME },
      ],
    }
  })
}

/**
 * The ServiceAccounts that need a patch of THIS provider's own: `default` plus every account a
 * pod template NAMES, minus the ones the manifests declare themselves.
 *
 * The subtraction is the point. A declared account gets the secret through
 * {@link withPullSecretOnServiceAccounts}, inside the manifests' own apply; patching it here as
 * well would be the atomic-list race that function exists to avoid. What is left is exactly the
 * set nothing else writes: `default`, which Kubernetes creates per namespace, and any account a
 * workload names but never defines (a cluster-wide account, or a manifest that assumes one).
 */
export function serviceAccountsNeedingOwnPatch(resources: KubernetesResource[]): string[] {
  const declared = new Set<string>()
  const needed = new Set<string>(['default'])
  for (const resource of resources) {
    if (resource.kind === 'ServiceAccount' && resource.metadata.name) {
      declared.add(resource.metadata.name)
    }
    const referenced = podSpecServiceAccountName(resource)
    if (referenced) needed.add(referenced)
  }
  return [...needed].filter((name) => !declared.has(name))
}

/** A pod spec, as far as reading its service account needs to see. */
interface PodSpecShape {
  serviceAccountName?: unknown
  template?: { spec?: PodSpecShape }
  /** A CronJob's `spec.jobTemplate`, whose own spec carries the pod template. */
  jobTemplate?: { spec?: PodSpecShape }
}

/**
 * The `serviceAccountName` a resource's pod template declares.
 *
 * Three nestings reach a pod spec and all three occur in ordinary manifests: a bare Pod's own
 * `spec`, a workload's `spec.template.spec` (Deployment, StatefulSet, DaemonSet, Job), and a
 * CronJob's `spec.jobTemplate.spec.template.spec`. Missing the last one left a CronJob naming an
 * undeclared account with no pull secret, which is the failure mode that shows up hours later on
 * the first schedule rather than at provision time. Unknown shapes answer null.
 */
function podSpecServiceAccountName(resource: KubernetesResource): string | null {
  const spec = resource.spec as PodSpecShape | undefined
  const name =
    spec?.jobTemplate?.spec?.template?.spec?.serviceAccountName ??
    spec?.template?.spec?.serviceAccountName ??
    spec?.serviceAccountName
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
