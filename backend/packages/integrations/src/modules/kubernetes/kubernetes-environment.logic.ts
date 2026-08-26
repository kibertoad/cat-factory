import type {
  EnvironmentManifest,
  KubernetesConnectionConfig,
  KubernetesEnvironmentConfig,
  KubernetesProvisionConfig,
  KubernetesUrlSource,
} from '@cat-factory/kernel'
import {
  describeWildcardDnsShift,
  kubernetesConnectionConfigSchema,
  kubernetesProvisionConfigSchema,
  parseStoredProviderConfig,
} from '@cat-factory/contracts'
import { describeMisresolvingHostProblem } from '../environments/environments.logic.js'
import { parseAllDocuments } from 'yaml'
import { apiBase, k8sName, labelValue } from './kubernetes.logic.js'

// Pure helpers for the native Kubernetes ENVIRONMENT backend: parse the operator's
// per-PR config off the stored manifest's `providerConfig`, render the namespace +
// templated manifests, map a (group/version/)kind onto its apiserver resource path,
// and derive the environment URL. No I/O — the provider does the apiserver fetches.

/** The label key stamped on the namespace + applied resources, carrying the run/block id. */
export const ENV_BLOCK_LABEL = 'cat-factory.blockId'
/** The owning-prefix for the per-PR namespace. */
export const ENV_NAMESPACE_PREFIX = 'cf-env-'

/** A parsed Kubernetes resource (apiVersion + kind + metadata + the rest). */
export interface KubernetesResource {
  apiVersion: string
  kind: string
  metadata: { name?: string; namespace?: string; labels?: Record<string, string> } & Record<
    string,
    unknown
  >
  [key: string]: unknown
}

/**
 * Built-in allow-list mapping a manifest `kind` → its apiserver plural + scope. An
 * unlisted kind is rejected (a clear error beats a guessed/incorrect resource path).
 * The group/version come from each resource's own `apiVersion`, so any API group is
 * supported as long as the kind's plural is known here.
 */
const RESOURCE_KINDS: Record<string, { plural: string; namespaced: boolean }> = {
  Deployment: { plural: 'deployments', namespaced: true },
  StatefulSet: { plural: 'statefulsets', namespaced: true },
  DaemonSet: { plural: 'daemonsets', namespaced: true },
  ReplicaSet: { plural: 'replicasets', namespaced: true },
  Pod: { plural: 'pods', namespaced: true },
  Service: { plural: 'services', namespaced: true },
  Ingress: { plural: 'ingresses', namespaced: true },
  ConfigMap: { plural: 'configmaps', namespaced: true },
  Secret: { plural: 'secrets', namespaced: true },
  ServiceAccount: { plural: 'serviceaccounts', namespaced: true },
  PersistentVolumeClaim: { plural: 'persistentvolumeclaims', namespaced: true },
  Job: { plural: 'jobs', namespaced: true },
  CronJob: { plural: 'cronjobs', namespaced: true },
  Role: { plural: 'roles', namespaced: true },
  RoleBinding: { plural: 'rolebindings', namespaced: true },
  HorizontalPodAutoscaler: { plural: 'horizontalpodautoscalers', namespaced: true },
  NetworkPolicy: { plural: 'networkpolicies', namespaced: true },
  HTTPRoute: { plural: 'httproutes', namespaced: true },
  Gateway: { plural: 'gateways', namespaced: true },
}

/**
 * Read the per-workspace Kubernetes config off the stored manifest's `providerConfig`.
 *
 * Re-validated against the same schema the connect controller admitted it through, rather than
 * asserted. See {@link parseStoredProviderConfig} for why a stored config is re-read.
 */
export function parseKubernetesEnvConfig(manifest: EnvironmentManifest): KubernetesProvisionConfig {
  const raw = manifest.providerConfig
  if (!raw) throw new Error('Kubernetes environment manifest is missing its providerConfig')
  return parseStoredProviderConfig(
    kubernetesProvisionConfigSchema,
    raw,
    'Kubernetes environment manifest',
  )
}

/**
 * Read only what it takes to REACH the apiserver off the stored manifest, for the reclaim path.
 *
 * The distinction from {@link parseKubernetesEnvConfig} is the whole point (see
 * {@link kubernetesConnectionConfigSchema}): standing an environment up needs the manifests, the
 * URL derivation and the templates, and a stored config that stopped matching any of them should
 * fail loudly before it provisions something wrong. Tearing one down needs the apiserver URL and
 * its TLS settings and nothing else — so validating the rest there would turn a config-schema
 * drift into a namespace that can never be deleted, which is the one failure mode worse than
 * acting on a partly-stale config.
 */
export function parseKubernetesEnvConnection(
  manifest: EnvironmentManifest,
): KubernetesConnectionConfig {
  const raw = manifest.providerConfig
  if (!raw) throw new Error('Kubernetes environment manifest is missing its providerConfig')
  return parseStoredProviderConfig(
    kubernetesConnectionConfigSchema,
    raw,
    'Kubernetes environment manifest',
  )
}

/** Build the stored manifest that carries a Kubernetes env config in its providerConfig. */
export function kubernetesConfigToManifest(
  config: KubernetesEnvironmentConfig,
): EnvironmentManifest {
  return {
    providerId: 'kubernetes',
    label: config.label,
    // baseUrl is the apiserver root; it is NOT manifest-SSRF-checked (a cluster is
    // routinely a private host) — the backend runs `assertApiServerUrlSafe` instead.
    baseUrl: config.apiServerUrl,
    auth: { type: 'bearer', secretRef: { key: 'apiToken' } },
    // A native adapter ignores these request templates at run time, but the manifest
    // schema requires `provision` + `response`; supply inert placeholders.
    provision: { method: 'POST', pathTemplate: '' },
    response: {},
    ...(config.defaultTtlMs ? { defaultTtlMs: config.defaultTtlMs } : {}),
    providerConfig: config,
  }
}

/** The `{{var}}` substitution map available to the namespace + manifest templates. */
export function templateVars(
  inputs: Record<string, string>,
  namespace: string,
  image: string | undefined,
): Record<string, string> {
  return { ...inputs, namespace, ...(image !== undefined ? { image } : {}) }
}

/** Replace `{{ key }}` placeholders from `vars`; an unknown key resolves to ''. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
}

/**
 * Resolve the per-PR namespace name: render the configured template (or a default
 * derived from the repo + PR number / block id) then sanitize to an RFC1123 label.
 *
 * The default qualifies the PR number with the repo, because a workspace can have many
 * repos and two of them can open a PR with the SAME number. A bare `cf-env-<pr>` would
 * then collide on one namespace — and since `ensureNamespace` treats the resulting 409
 * as idempotent, the second PR's manifests would be applied INTO the first's live
 * environment (and its teardown would delete the wrong namespace). So prefer
 * `<repoName>-pr<pullNumber>`, falling back to the globally-unique block id, and only to a
 * bare PR number when neither repo nor block context is present (a manual provision).
 *
 * **The `pr` is load-bearing** and is not decoration: a name ending in a separator plus digits
 * opens a four-octet window of its own in front of a wildcard-DNS host, so the platform's own
 * default composed with the host shape its own docs recommend published an address on somebody
 * else's network (`cf-env-catalog-api-5.127.0.0.1.nip.io` answers 5.127.0.0). Rendering `pr5`
 * ends the label with a letter, which is not an octet. `describeWildcardDnsShift` in contracts
 * owns the rule and {@link describeUnreachableIngressHost} refuses what an operator's own
 * template composes; this is the half the platform is responsible for on its own.
 */
export function resolveNamespace(
  config: KubernetesEnvironmentConfig,
  inputs: Record<string, string>,
): string {
  if (config.namespaceTemplate) {
    return k8sName(renderTemplate(config.namespaceTemplate, inputs), '', 63, 'env')
  }
  const pull = inputs.pullNumber ? `pr${inputs.pullNumber}` : undefined
  const suffix =
    inputs.repoName && pull ? `${inputs.repoName}-${pull}` : inputs.blockId || pull || 'env'
  return k8sName(suffix, ENV_NAMESPACE_PREFIX, 63, 'env')
}

/**
 * The cluster-scoped Namespace collection/object URL. Typed against the CONNECTION rather than
 * the full config, because the teardown path builds it from a config parsed as one.
 */
export function namespaceUrl(config: KubernetesConnectionConfig, name?: string): string {
  const base = `${apiBase(config)}/api/v1/namespaces`
  return name ? `${base}/${encodeURIComponent(name)}` : base
}

/**
 * The apiserver resource URL for server-side apply (`name` required) or a collection
 * GET (`name` omitted). Throws for an unsupported kind. `apiVersion` carries the
 * group/version; the kind's plural comes from the built-in allow-list.
 */
export function resourceUrl(
  config: KubernetesEnvironmentConfig,
  apiVersion: string,
  kind: string,
  namespace: string,
  name?: string,
): string {
  const meta = RESOURCE_KINDS[kind]
  if (!meta) {
    throw new Error(
      `Unsupported manifest kind '${kind}' (add it to the Kubernetes env resource allow-list)`,
    )
  }
  const slash = apiVersion.indexOf('/')
  const group = slash === -1 ? '' : apiVersion.slice(0, slash)
  const version = slash === -1 ? apiVersion : apiVersion.slice(slash + 1)
  const root = group
    ? `${apiBase(config)}/apis/${group}/${version}`
    : `${apiBase(config)}/api/${version}`
  const nsSeg = meta.namespaced ? `/namespaces/${encodeURIComponent(namespace)}` : ''
  const nameSeg = name ? `/${encodeURIComponent(name)}` : ''
  return `${root}${nsSeg}/${meta.plural}${nameSeg}`
}

/**
 * The cluster-scoped `IngressClass` collection URL.
 *
 * Built here rather than through {@link resourceUrl}, and that is the point rather than a
 * convenience: `resourceUrl` reads `RESOURCE_KINDS`, which is the ALLOW-LIST of kinds a
 * repository's own manifests may have applied on its behalf. Adding `IngressClass` to it to reach
 * this one read would also let a checkout apply a cluster-scoped object, which is a privilege
 * widening with nothing to do with reading a catalog.
 */
export function ingressClassesUrl(config: KubernetesEnvironmentConfig): string {
  return `${apiBase(config)}/apis/networking.k8s.io/v1/ingressclasses`
}

/** Whether a repo entry path is a manifest file we should read (yaml/yml/json). */
export function isManifestFile(path: string): boolean {
  return /\.(ya?ml|json)$/i.test(path)
}

/**
 * Parse one or more YAML/JSON documents into resources, templating `{{var}}` first,
 * then forcing each resource's namespace + stamping the env label. Empty docs are
 * dropped. Throws on a document missing apiVersion/kind/metadata.name.
 */
export function parseManifests(
  text: string,
  vars: Record<string, string>,
  namespace: string,
  blockId: string | undefined,
  extraLabels: Record<string, string> | undefined,
): KubernetesResource[] {
  const rendered = renderTemplate(text, vars)
  const docs = parseAllDocuments(rendered)
  const out: KubernetesResource[] = []
  for (const doc of docs) {
    const json = doc.toJSON() as KubernetesResource | null
    if (!json || typeof json !== 'object') continue
    if (!json.apiVersion || !json.kind) {
      throw new Error('Manifest document is missing apiVersion/kind')
    }
    if (json.kind === 'Namespace') continue // we own the per-PR namespace
    const name = json.metadata?.name
    if (!name) throw new Error(`Manifest ${json.kind} is missing metadata.name`)
    json.metadata = {
      ...json.metadata,
      namespace,
      labels: {
        ...json.metadata.labels,
        ...(blockId ? { [ENV_BLOCK_LABEL]: labelValue(blockId) } : {}),
        ...extraLabels,
      },
    }
    out.push(json)
  }
  return out
}

/** Read the first LoadBalancer address (ip or hostname) off a Service/Ingress status. */
export function extractLoadBalancerAddress(obj: unknown): string | null {
  const status = (obj as { status?: { loadBalancer?: { ingress?: unknown[] } } } | null)?.status
  const ingress = status?.loadBalancer?.ingress
  if (!Array.isArray(ingress) || ingress.length === 0) return null
  const first = ingress[0] as { ip?: string; hostname?: string }
  return first.hostname || first.ip || null
}

/**
 * The deprecated pre-1.18 spelling of {@link IngressAdmissionFacts.requestedClass}. Read beside
 * `spec.ingressClassName` because controllers still honour it, so an Ingress carrying only this
 * one IS claimable and must not be graded as classless.
 */
const LEGACY_INGRESS_CLASS_ANNOTATION = 'kubernetes.io/ingress.class'

/** The annotation marking an `IngressClass` as the one that claims a classless Ingress. */
const DEFAULT_INGRESS_CLASS_ANNOTATION = 'ingressclass.kubernetes.io/is-default-class'

/** One Ingress reduced to the two facts that decide whether anything can route it. */
export type IngressAdmissionFacts = {
  /** The class it asks for (`spec.ingressClassName`, else the legacy annotation), or null. */
  requestedClass: string | null
  /** Whether some controller has written an address onto `status.loadBalancer`. */
  hasAddress: boolean
}

/**
 * The cluster's `IngressClass` list, or the fact that it could not be read.
 *
 * `read: false` is its own member rather than an empty list, and the distinction is the whole
 * point: the ServiceAccount's ClusterRole may not cover the cluster-scoped `ingressclasses`
 * resource, and a 403 read as "this cluster has no ingress controller" would fail every
 * environment on a working cluster. Same three-state rule as `k3s-ingress.ts`' probe verdict.
 */
export type IngressClassCatalog =
  | { read: true; names: readonly string[]; defaultName: string | null }
  | { read: false; detail: string }

/**
 * Whether anything in the cluster will serve the host an `ingressTemplate` URL names.
 *
 * `unrouted` carries prose because the three causes need three different fixes and only one of
 * them is in anybody's checkout; `pending` and `unknown` are deliberately NOT failures (see
 * {@link classifyIngressAdmission}).
 */
export type IngressAdmission =
  | { status: 'admitted' }
  | { status: 'pending' }
  | { status: 'unknown'; detail: string }
  | { status: 'unrouted'; problem: string }

/** The two facts above, off a live Ingress object. */
export function readIngressAdmissionFacts(obj: unknown): IngressAdmissionFacts {
  const ingress = obj as {
    spec?: { ingressClassName?: unknown }
    metadata?: { annotations?: Record<string, unknown> }
  } | null
  const fromSpec = ingress?.spec?.ingressClassName
  const fromAnnotation = ingress?.metadata?.annotations?.[LEGACY_INGRESS_CLASS_ANNOTATION]
  return {
    requestedClass: firstNonEmptyString(fromSpec, fromAnnotation),
    hasAddress: extractLoadBalancerAddress(obj) !== null,
  }
}

/** The first of `values` that is a non-blank string, trimmed, or null. */
function firstNonEmptyString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * The `IngressClass` names in a `kubectl get ingressclass`-shaped payload, plus which one is
 * marked default. A payload that is not a list reads as UNREADABLE rather than as an empty
 * cluster, for the reason {@link IngressClassCatalog} gives.
 */
export function readIngressClassCatalog(obj: unknown): IngressClassCatalog {
  const items = (obj as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    return { read: false, detail: 'the apiserver returned no IngressClass list' }
  }
  const names: string[] = []
  let defaultName: string | null = null
  for (const item of items) {
    const entry = item as {
      metadata?: { name?: unknown; annotations?: Record<string, unknown> }
    } | null
    const name = entry?.metadata?.name
    if (typeof name !== 'string' || !name) continue
    names.push(name)
    if (entry?.metadata?.annotations?.[DEFAULT_INGRESS_CLASS_ANNOTATION] === 'true') {
      defaultName ??= name
    }
  }
  return { read: true, names, defaultName }
}

/**
 * Grade whether the cluster can actually serve an `ingressTemplate` environment URL.
 *
 * **Why this exists.** Environment readiness was the Deployments' rollout and nothing else, so a
 * namespace whose pods were all `1/1 Running` reported `ready` and published a URL derived purely
 * from CONFIG TEXT: a claim no part of the cluster had agreed to. The run that motivated it wrote
 * an Ingress naming ingress class 'nginx' onto a k3d cluster that runs Traefik. The apiserver
 * accepted the object, the pod was healthy, the URL was published, and the Ingress sat with an
 * empty `status.loadBalancer` because nothing was watching that class. The tester then spent
 * fourteen minutes on curl code 000 and reported the ENVIRONMENT as unreachable, which reads as a
 * broken cluster or an unpullable image; the deployer, which had said `done` in one second, was
 * never suspected. ADR-worthy sibling: PR #2075 fixed the case where the host NAME resolves to a
 * stranger's network and left this one open.
 *
 * **What it will and will not fail on, which is the load-bearing part.** It fails only on POSITIVE
 * evidence that no controller can ever claim the Ingress: the cluster publishes no `IngressClass`
 * at all, or the Ingress asks for one that is not among those it does publish, or it asks for none
 * and the cluster marks none default. Each is a fact about the cluster's own catalog, and none of
 * them can become true later without someone changing the cluster.
 *
 * The ABSENCE of an address is deliberately NOT evidence. Writing `status.loadBalancer` back is a
 * controller's choice rather than a guarantee, so failing on an empty status would refuse
 * deployments whose routing works: the same trap PR #2075 avoided by pinning its rule to real
 * resolutions rather than to what a spec implies. So an address SHORT-CIRCUITS to `admitted`, and
 * its absence is at most `pending`, which keeps the environment provisioning until the provision's
 * own deadline reports `timeout`. That leaves no new way to hang and no new way to refuse a
 * working cluster.
 *
 * An empty `ingresses` list yields `pending` rather than a refusal: an `ingressTemplate` URL says
 * where the URL comes FROM and not what routes it, so manifests may legitimately serve that host
 * through a Gateway or an HTTPRoute. Claiming otherwise would fail a working shape on the strength
 * of an assumption about how it was built.
 */
export function classifyIngressAdmission(
  ingresses: readonly IngressAdmissionFacts[],
  catalog: IngressClassCatalog,
): IngressAdmission {
  if (ingresses.some((ingress) => ingress.hasAddress)) return { status: 'admitted' }
  if (!catalog.read) return { status: 'unknown', detail: catalog.detail }
  if (ingresses.length === 0) return { status: 'pending' }
  const available = catalog.names.length
    ? `the cluster publishes ${catalog.names.map((name) => `'${name}'`).join(', ')}`
    : 'the cluster publishes none'
  if (catalog.names.length === 0) {
    return {
      status: 'unrouted',
      problem:
        'this cluster runs no ingress controller: it publishes no IngressClass at all, so the ' +
        'Ingress applied for this environment has nothing watching it and the environment URL ' +
        'will never answer, however healthy the workload is. Install an ingress controller (a ' +
        'default k3d/k3s cluster bundles Traefik; kind ships none), or point this connection ' +
        'at an environment URL source the cluster does serve.',
    }
  }
  const unsatisfiable = ingresses
    .map((ingress) => ingress.requestedClass)
    .find((requested) => requested !== null && !catalog.names.includes(requested))
  if (unsatisfiable) {
    return {
      status: 'unrouted',
      problem:
        `the Ingress for this environment asks for ingress class '${unsatisfiable}', which this ` +
        `cluster does not have (${available}). Nothing claims it, so the apiserver accepts the ` +
        'object, every workload reports healthy, and the environment URL never answers. Remove ' +
        'the ingressClassName field from the manifests so the cluster default class claims the ' +
        'Ingress, or set it to one of the classes above.',
    }
  }
  if (catalog.defaultName === null) {
    return {
      status: 'unrouted',
      problem:
        'the Ingress for this environment names no ingress class and this cluster marks none as ' +
        `default (${available}), so nothing claims it and the environment URL never answers. ` +
        'Annotate one class with ingressclass.kubernetes.io/is-default-class: "true", or set ' +
        'ingressClassName in the manifests to one of the classes above.',
    }
  }
  return { status: 'pending' }
}

/** A concrete, resolvable host — a wildcard listener/route hostname (`*.example.com`) is not. */
export function isUsableHost(host: string | undefined): host is string {
  return !!host && !host.startsWith('*')
}

/** The first entry of a `{ items: [...] }` list response, or null when empty. */
export function firstListItem(obj: unknown): unknown {
  const items = (obj as { items?: unknown[] } | null)?.items
  return Array.isArray(items) && items.length > 0 ? items[0] : null
}

/** Read the first Gateway-API `Gateway` address off its `.status.addresses[]`. */
export function extractGatewayAddress(obj: unknown): string | null {
  const addresses = (obj as { status?: { addresses?: { value?: string }[] } } | null)?.status
    ?.addresses
  if (!Array.isArray(addresses) || addresses.length === 0) return null
  return addresses[0]?.value || null
}

/** The first usable (non-wildcard) listener hostname declared on a `Gateway`'s spec. */
export function extractGatewayListenerHost(obj: unknown): string | null {
  const listeners = (obj as { spec?: { listeners?: { hostname?: string }[] } } | null)?.spec
    ?.listeners
  if (!Array.isArray(listeners)) return null
  return listeners.map((l) => l?.hostname).find(isUsableHost) ?? null
}

/** The first usable (non-wildcard) hostname declared on an `HTTPRoute`'s spec. */
export function extractHttpRouteHost(obj: unknown): string | null {
  const hostnames = (obj as { spec?: { hostnames?: string[] } } | null)?.spec?.hostnames
  if (!Array.isArray(hostnames)) return null
  return hostnames.find(isUsableHost) ?? null
}

/** The first `parentRef` (name + optional namespace) of an `HTTPRoute`, or null. */
export function httpRouteParentRef(obj: unknown): { name: string; namespace?: string } | null {
  const refs = (obj as { spec?: { parentRefs?: { name?: string; namespace?: string }[] } } | null)
    ?.spec?.parentRefs
  const ref = Array.isArray(refs) ? refs[0] : undefined
  if (!ref?.name) return null
  return { name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) }
}

/**
 * Derive the environment URL from the configured source. For `ingressTemplate` the URL
 * is known immediately (rendered host); the status-backed sources return null until the
 * caller has fetched the live address and passes it in.
 *
 * A configured `port` is appended here rather than being baked into the host template, because
 * the rendered template is also the Ingress `host` the manifests declare and a Kubernetes `host`
 * may not carry a port. A local cluster whose controller is published on a non-default host port
 * is the case that needs it.
 */
export function deriveUrl(
  url: KubernetesUrlSource,
  vars: Record<string, string>,
  liveAddress: string | null,
): string | null {
  const scheme = url.scheme ?? 'https'
  if (url.source === 'ingressTemplate') {
    const host = renderTemplate(url.hostTemplate, vars).trim()
    if (!host) return null
    return url.port ? `${scheme}://${host}:${url.port}` : `${scheme}://${host}`
  }
  if (!liveAddress) return null
  if (url.source === 'serviceStatus' && url.port) {
    return `${scheme}://${liveAddress}:${url.port}`
  }
  return `${scheme}://${liveAddress}`
}

/**
 * Refuse a RENDERED ingress host that cannot reach this cluster, or `null` when there is nothing
 * wrong. `ingressTemplate` only: a status-backed source has rendered nothing yet at provision
 * time, and its live host is graded where every provider's published URL is
 * (`describeMisresolvingEnvironmentUrl`, run by `EnvironmentProvisioningService`).
 *
 * It grades the rendered host STRING rather than re-parsing the URL that host went into, and the
 * difference is not cosmetic: a URL's authority stops at the first `/`, so a template rendering
 * `{{branch}}` (which is `cat-factory/<taskId>`) yields `http://cat-factory/task_….127.0.0.1.nip.io`,
 * whose authority is the bare `cat-factory`. Read that way the name looks like an ordinary host
 * with nothing to say about it, when what actually happened is that the template produced
 * something no resolver will ever be asked for.
 *
 * So there are two causes here, and they need different fixes: a rendered host that is not a
 * hostname at all (the template filled a hole with a value carrying a `/`, a space, an
 * underscore) and one that IS a hostname but whose wildcard-DNS answer is a different network.
 *
 * **Called BEFORE anything is applied**, which is the whole reason it is on this side rather than
 * only at the publication seam: by the time a provisioned URL is graded there, this provider has
 * created the namespace, written the registry pull Secret into it and applied every workload, and
 * a failed provision records no `externalId`, so nothing would ever reclaim them. The inputs are a
 * config template and the vars, neither of which the cluster contributes to, so nothing is lost by
 * asking first.
 */
export function describeUnreachableIngressHost(
  url: KubernetesUrlSource,
  vars: Record<string, string>,
): string | null {
  if (url.source !== 'ingressTemplate') return null
  const host = renderTemplate(url.hostTemplate, vars).trim()
  if (!host) return null
  const malformed = describeMalformedHost(url.hostTemplate, host)
  if (malformed) return malformed
  const shift = describeWildcardDnsShift(host)
  return shift ? describeMisresolvingHostProblem(shift) : null
}

/** A label of letters, digits and dashes, not starting or ending on a dash. */
const HOSTNAME_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/**
 * A rendered host that is not a hostname, named together with the template that produced it.
 *
 * Both halves are needed to act on it: the template is what the operator will edit and the
 * rendered value is the only thing that shows WHICH hole misbehaved. Case is folded first,
 * because an upper-case name resolves perfectly well and refusing it would put this rule in front
 * of a Kubernetes naming rule the apiserver already reports clearly.
 *
 * **An EMPTY label is deliberately not this rule's business**, and that is a boundary rather than
 * an oversight. It means a placeholder rendered to nothing, which for a run-supplied key is the
 * documented lenient substitution and for a config-supplied one is already refused by name
 * (`describeUnfilledConfigPlaceholders`). Claiming it here would answer a missing-variable
 * failure with a paragraph about legal hostname characters: the wrong fix, stated confidently.
 * What this rule owns is a host that was fully composed and is still not a name.
 */
function describeMalformedHost(template: string, host: string): string | null {
  const labels = host.toLowerCase().replace(/[.]$/, '').split('.')
  if (labels.some((label) => label === '')) return null
  if (
    host.length <= 253 &&
    labels.every((label) => label.length <= 63 && HOSTNAME_LABEL.test(label))
  ) {
    return null
  }
  return (
    `The environment URL cannot reach this cluster: the host template '${template}' rendered ` +
    `'${host}', which is not a hostname. A label may hold only letters, digits and '-', at most ` +
    `63 characters each and 253 in total. Check what the template's placeholders fill with: ` +
    `{{branch}} is 'cat-factory/<taskId>', whose '/' ends the host and turns the rest into a ` +
    `path. {{namespace}} is sanitized to a single RFC1123 label and is the safe one to build on.`
  )
}
