import type {
  ConnectionTestResult,
  EnvironmentConnectionTestRequest,
  EnvironmentProvider,
  EnvironmentStatus,
  EnvironmentStatusRequest,
  EnvironmentTeardownRequest,
  KubernetesEnvironmentConfig,
  ProviderConfigField,
  ProvisionEnvironmentRequest,
  ProvisionedEnvironment,
  RepoFiles,
  RunRepoContext,
} from '@cat-factory/kernel'
import { KubernetesApiClient, safeText } from './KubernetesApiClient.js'
import { apiBase, classifyDeploymentReadiness } from './kubernetes.logic.js'
import {
  deriveUrl,
  extractLoadBalancerAddress,
  isManifestFile,
  type KubernetesResource,
  namespaceUrl,
  parseKubernetesEnvConfig,
  parseManifests,
  resolveNamespace,
  resourceUrl,
  templateVars,
} from './kubernetes-environment.logic.js'

// Native Kubernetes ephemeral-environment provider. It applies an operator-authored
// set of k3s/Kubernetes manifests (read from the PR repo or a separate repo) into a
// per-PR namespace via the apiserver, using the SAME KubernetesApiClient (bearer
// token + custom-CA TLS) as the runner backend. Per-PR isolation means provisioning
// is idempotent (server-side apply) and teardown is a single namespace delete.
//
// The per-workspace config rides the stored manifest's `providerConfig` bag (parsed +
// validated here); the apiserver token is the `apiToken` secret. The provider is a
// stateless singleton — every call re-derives the client from the manifest, so one
// instance serves every workspace.

const APPLY_TIMEOUT_MS = 30_000
const READ_TIMEOUT_MS = 30_000
const FIELD_MANAGER = 'cat-factory'

export interface KubernetesEnvironmentProviderOptions {
  /** Reserved for future URL-policy-aware behaviour; unused today. */
  urlPolicy?: unknown
}

export class KubernetesEnvironmentProvider implements EnvironmentProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly options: KubernetesEnvironmentProviderOptions = {}) {}

  async provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment> {
    const config = parseKubernetesEnvConfig(req.manifest)
    const client = new KubernetesApiClient(config, req.resolveSecret)
    const inputs = req.inputs
    const namespace = resolveNamespace(config, inputs)
    const image = config.imageTemplate ? renderImage(config.imageTemplate, inputs) : undefined
    const vars = templateVars(inputs, namespace, image)

    await this.ensureNamespace(client, config, namespace)

    const texts = await this.readManifests(req, config)
    const resources: KubernetesResource[] = []
    for (const text of texts) {
      resources.push(...parseManifests(text, vars, namespace, inputs.blockId, config.labels))
    }
    if (resources.length === 0) {
      throw new Error('No Kubernetes manifests were found at the configured source path')
    }
    for (const resource of resources) {
      await this.apply(client, config, namespace, resource)
    }

    // For an ingress-template URL the address is known immediately; status-backed
    // sources resolve to null until `status()` reads the live LoadBalancer address.
    const url = deriveUrl(config.url, vars, null)
    return {
      externalId: namespace,
      url,
      status: 'provisioning',
      expiresAt: null,
      access: null,
      // Persist the FULL template var set (not just namespace/branch): `status()`
      // re-derives an ingress-template URL from these, so dropping e.g. `{{pullNumber}}`
      // / `{{image}}` here would silently corrupt a previously-correct URL on the next
      // status poll. The vars are non-secret PR/repo context.
      fields: { ...vars },
    }
  }

  async status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment> {
    const config = parseKubernetesEnvConfig(req.manifest)
    const namespace = req.provisionFields.namespace ?? req.externalId
    if (!namespace) {
      return {
        externalId: null,
        url: null,
        status: 'failed',
        expiresAt: null,
        access: null,
        fields: {},
      }
    }
    const client = new KubernetesApiClient(config, req.resolveSecret)
    const status = await this.deploymentStatus(client, config, namespace)
    const url = await this.resolveLiveUrl(client, config, namespace, req.provisionFields)
    return {
      externalId: namespace,
      url,
      status,
      expiresAt: null,
      access: null,
      fields: req.provisionFields,
    }
  }

  async teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }> {
    const config = parseKubernetesEnvConfig(req.manifest)
    const namespace = req.provisionFields.namespace ?? req.externalId
    if (!namespace) return { status: 'torn_down' }
    const client = new KubernetesApiClient(config, req.resolveSecret)
    const res = await client.fetch(
      'DELETE',
      namespaceUrl(config, namespace),
      undefined,
      APPLY_TIMEOUT_MS,
    )
    // 404 ⇒ already gone (idempotent). 409 ⇒ a delete is already in flight.
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      throw new Error(
        `Failed to delete namespace '${namespace}' (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
    return { status: 'torn_down' }
  }

  async testConnection(req: EnvironmentConnectionTestRequest): Promise<ConnectionTestResult> {
    if (!req.manifest) return { ok: false, message: 'Expected a Kubernetes environment manifest.' }
    let config: KubernetesEnvironmentConfig
    try {
      config = parseKubernetesEnvConfig(req.manifest)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    const client = new KubernetesApiClient(config, req.resolveSecret)
    try {
      const res = await client.fetch(
        'GET',
        `${namespaceUrl(config)}?limit=1`,
        undefined,
        READ_TIMEOUT_MS,
      )
      if (res.ok) return { ok: true, message: `Reached ${apiBase(config)}.` }
      return { ok: false, message: `apiserver responded ${res.status}: ${await safeText(res)}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  describeConfig(): ProviderConfigField[] {
    // The structured fields (apiserver URL, namespace template, manifest source, URL
    // source) are collected by the bespoke Kubernetes connect form; the only secret is
    // the ServiceAccount token, surfaced here so the unconfigured banner can clear.
    return [{ key: 'apiToken', label: 'ServiceAccount token', secret: true, required: true }]
  }

  // --- internals ----------------------------------------------------------

  private async ensureNamespace(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
  ): Promise<void> {
    const body = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        ...(config.labels ? { labels: config.labels } : {}),
        ...(config.annotations ? { annotations: config.annotations } : {}),
      },
    }
    const res = await client.fetch('POST', namespaceUrl(config), body, APPLY_TIMEOUT_MS)
    if (res.ok || res.status === 409) return // 409 AlreadyExists ⇒ idempotent
    throw new Error(
      `Failed to create namespace '${namespace}' (HTTP ${res.status}): ${await safeText(res)}`,
    )
  }

  private async apply(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
    resource: KubernetesResource,
  ): Promise<void> {
    const name = resource.metadata.name!
    const url = `${resourceUrl(config, resource.apiVersion, resource.kind, namespace, name)}?fieldManager=${FIELD_MANAGER}&force=true`
    // Server-side apply with the `apply-patch+yaml` content type and a JSON body. JSON is a
    // subset of YAML, so the apiserver parses the JSON payload fine — and this is the content
    // type every apiserver since 1.22 accepts (the `apply-patch+json` media type only exists
    // on much newer servers, so sending it 415s on an older/stock cluster), exactly as
    // kubectl/client-go do.
    const res = await client.fetch(
      'PATCH',
      url,
      JSON.stringify(resource),
      APPLY_TIMEOUT_MS,
      'application/apply-patch+yaml',
    )
    if (!res.ok) {
      throw new Error(
        `Failed to apply ${resource.kind}/${name} (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
  }

  /** Aggregate the namespace's Deployments into one lifecycle verdict. */
  private async deploymentStatus(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
  ): Promise<EnvironmentStatus> {
    const res = await client.fetch(
      'GET',
      resourceUrl(config, 'apps/v1', 'Deployment', namespace),
      undefined,
      READ_TIMEOUT_MS,
    )
    if (res.status === 404) return 'failed'
    if (!res.ok) return 'provisioning'
    const body = (await res.json()) as { items?: unknown[] }
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) return 'ready' // nothing to roll out (e.g. a static Service)
    let anyPending = false
    for (const item of items) {
      const readiness = classifyDeploymentReadiness(item)
      if (readiness === 'gone') return 'failed'
      if (readiness !== 'ready') anyPending = true
    }
    return anyPending ? 'provisioning' : 'ready'
  }

  /** Resolve the live URL, reading the LoadBalancer address for status-backed sources. */
  private async resolveLiveUrl(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
    fields: Record<string, string>,
  ): Promise<string | null> {
    const url = config.url
    const vars = { ...fields, namespace }
    if (url.source === 'ingressTemplate') return deriveUrl(url, vars, null)
    const address = await this.readLoadBalancerAddress(client, config, namespace)
    return address ? deriveUrl(url, vars, address) : null
  }

  /**
   * Read the LoadBalancer address backing a status source: the named Service/Ingress, or
   * — when `ingressStatus` omits the name — the single Ingress applied in the namespace
   * (the schema/UI documents "absent ⇒ the only Ingress applied"). Null until assigned.
   */
  private async readLoadBalancerAddress(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
  ): Promise<string | null> {
    const url = config.url
    if (url.source === 'serviceStatus') {
      const res = await client.fetch(
        'GET',
        resourceUrl(config, 'v1', 'Service', namespace, url.serviceName),
        undefined,
        READ_TIMEOUT_MS,
      )
      return res.ok ? extractLoadBalancerAddress(await res.json()) : null
    }
    // ingressTemplate is resolved by the caller; only ingressStatus reaches here.
    if (url.source !== 'ingressStatus') return null
    // ingressStatus: a named Ingress, else the only Ingress in the namespace.
    if (url.ingressName) {
      const res = await client.fetch(
        'GET',
        resourceUrl(config, 'networking.k8s.io/v1', 'Ingress', namespace, url.ingressName),
        undefined,
        READ_TIMEOUT_MS,
      )
      return res.ok ? extractLoadBalancerAddress(await res.json()) : null
    }
    const res = await client.fetch(
      'GET',
      resourceUrl(config, 'networking.k8s.io/v1', 'Ingress', namespace),
      undefined,
      READ_TIMEOUT_MS,
    )
    if (!res.ok) return null
    const body = (await res.json()) as { items?: unknown[] }
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) return null
    return extractLoadBalancerAddress(items[0])
  }

  /** Read the manifest file(s) from the configured source (co-located or separate repo). */
  private async readManifests(
    req: ProvisionEnvironmentRequest,
    config: KubernetesEnvironmentConfig,
  ): Promise<string[]> {
    const source = config.manifestSource
    let ctx: RunRepoContext | null
    let ref: string
    if (source.type === 'colocated') {
      ctx = req.runRepo ?? null
      if (!ctx) {
        throw new Error('Co-located manifests require the run repo (is GitHub connected?)')
      }
      ref = req.inputs.branch || ctx.baseBranch
    } else {
      const [owner, repo] = source.repo.split('/')
      ctx = (await req.resolveRepoFiles?.({ owner: owner!, repo: repo!, ref: source.ref })) ?? null
      if (!ctx) {
        throw new Error(`Could not resolve the separate manifests repo '${source.repo}'`)
      }
      ref = source.ref || ctx.baseBranch
    }
    return this.readPath(ctx.repo, source.path, ref)
  }

  /** Read a single manifest file, or every manifest file in a directory. */
  private async readPath(repo: RepoFiles, path: string, ref: string): Promise<string[]> {
    const entries = await repo.listDirectory(path, ref)
    const files = entries.filter((e) => e.type === 'file' && isManifestFile(e.path))
    if (files.length > 0) {
      const texts: string[] = []
      for (const entry of files) {
        const file = await repo.getFile(entry.path, ref)
        if (file) texts.push(file.content)
      }
      return texts
    }
    const single = await repo.getFile(path, ref)
    if (!single) throw new Error(`No manifests found at '${path}'`)
    return [single.content]
  }
}

/** Render the optional image template over the provision inputs. */
function renderImage(template: string, inputs: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => inputs[key] ?? '')
}
