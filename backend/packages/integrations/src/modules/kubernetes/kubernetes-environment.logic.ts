import type {
  EnvironmentManifest,
  KubernetesEnvironmentConfig,
  KubernetesProvisionConfig,
  KubernetesUrlSource,
} from '@cat-factory/kernel'
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

/** Whether a manifest kind is supported by the apply loop. `Namespace` is owned by us. */
export function isSupportedKind(kind: string): boolean {
  return kind in RESOURCE_KINDS
}

/**
 * Read the per-workspace Kubernetes config off the stored manifest's `providerConfig`.
 * The config was Valibot-validated at the connect controller boundary, so this trusts
 * the stored shape (a cast) rather than re-parsing (which would pull valibot in here).
 */
export function parseKubernetesEnvConfig(manifest: EnvironmentManifest): KubernetesProvisionConfig {
  const raw = manifest.providerConfig
  if (!raw) throw new Error('Kubernetes environment manifest is missing its providerConfig')
  return raw as unknown as KubernetesProvisionConfig
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
    providerConfig: config as unknown as Record<string, unknown>,
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
 * `<repoName>-<pullNumber>`, falling back to the globally-unique block id, and only to a
 * bare PR number when neither repo nor block context is present (a manual provision).
 */
export function resolveNamespace(
  config: KubernetesEnvironmentConfig,
  inputs: Record<string, string>,
): string {
  if (config.namespaceTemplate) {
    return k8sName(renderTemplate(config.namespaceTemplate, inputs), '', 63, 'env')
  }
  const suffix =
    inputs.repoName && inputs.pullNumber
      ? `${inputs.repoName}-${inputs.pullNumber}`
      : inputs.blockId || inputs.pullNumber || 'env'
  return k8sName(suffix, ENV_NAMESPACE_PREFIX, 63, 'env')
}

/** The cluster-scoped Namespace collection/object URL. */
export function namespaceUrl(config: KubernetesEnvironmentConfig, name?: string): string {
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
 */
export function deriveUrl(
  url: KubernetesUrlSource,
  vars: Record<string, string>,
  liveAddress: string | null,
): string | null {
  const scheme = url.scheme ?? 'https'
  if (url.source === 'ingressTemplate') {
    const host = renderTemplate(url.hostTemplate, vars).trim()
    return host ? `${scheme}://${host}` : null
  }
  if (!liveAddress) return null
  if (url.source === 'serviceStatus' && url.port) {
    return `${scheme}://${liveAddress}:${url.port}`
  }
  return `${scheme}://${liveAddress}`
}
