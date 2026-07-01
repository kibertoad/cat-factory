import type {
  AsyncProvisionCapability,
  ConnectionTestResult,
  DeployProvisionJob,
  EnvironmentConnectionTestRequest,
  EnvironmentProvider,
  EnvironmentStatus,
  EnvironmentStatusRequest,
  EnvironmentTeardownRequest,
  KubernetesEnvironmentConfig,
  KubernetesProvisionConfig,
  ProviderConfigField,
  ProvisionEnvironmentRequest,
  ProvisionedEnvironment,
  RepoFiles,
  RunnerJobView,
  RunRepoContext,
} from '@cat-factory/kernel'
import { KubernetesApiClient, safeText } from './KubernetesApiClient.js'
import { apiBase, classifyDeploymentReadiness } from './kubernetes.logic.js'
import {
  buildDeployJobSpec,
  mapDeployOutcome,
  needsContainerRender,
} from './kubernetes-deploy.logic.js'
import {
  deriveUrl,
  extractGatewayAddress,
  extractGatewayListenerHost,
  extractHttpRouteHost,
  extractLoadBalancerAddress,
  firstListItem,
  httpRouteParentRef,
  isManifestFile,
  type KubernetesResource,
  namespaceUrl,
  parseKubernetesEnvConfig,
  parseManifests,
  renderTemplate,
  resolveNamespace,
  resourceUrl,
  templateVars,
} from './kubernetes-environment.logic.js'

/** Gateway-API group/version for `Gateway` + `HTTPRoute` status reads. */
const GATEWAY_API_VERSION = 'gateway.networking.k8s.io/v1'

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

  /**
   * Asynchronous, container-backed provisioning for configs the in-Worker REST path can't
   * render (`kustomize`, helm releases, structured image overrides, secret injections). The
   * provider builds the deploy job + maps its outcome; the engine dispatches/polls it.
   */
  readonly asyncProvision: AsyncProvisionCapability = {
    buildProvisionJob: (req) => this.buildProvisionJob(req),
    finalizeProvision: (view, req) => this.finalizeProvision(view, req),
  }

  async provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment> {
    const config = parseKubernetesEnvConfig(req.manifest)
    const client = new KubernetesApiClient(config, req.resolveSecret)
    const { namespace, vars } = this.provisionContext(config, req.inputs)

    await this.ensureNamespace(client, config, namespace)

    const texts = await this.readManifests(req, config)
    const resources: KubernetesResource[] = []
    for (const text of texts) {
      resources.push(...parseManifests(text, vars, namespace, req.inputs.blockId, config.labels))
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

  /**
   * Build a deploy-container job for a config that needs rendering, or null to use the
   * synchronous REST `provision()` path (raw manifests, no helm/images/secret-injections).
   * Throws when rendering is required but the engine supplied no deploy inputs (a wiring bug).
   */
  private buildProvisionJob(req: ProvisionEnvironmentRequest): DeployProvisionJob | null {
    const config: KubernetesProvisionConfig = parseKubernetesEnvConfig(req.manifest)
    if (!needsContainerRender(config)) return null
    const deploy = req.deploy
    if (!deploy) {
      throw new Error(
        'This Kubernetes environment needs the container deploy adapter (kustomize / helm / ' +
          'image overrides / secret injections), but the deploy inputs were not provided.',
      )
    }
    const { namespace, vars } = this.provisionContext(config, req.inputs)
    const spec = buildDeployJobSpec({
      jobId: deploy.ref.jobId,
      config,
      vars,
      namespace,
      clone: deploy.clone,
      resolveSecret: req.resolveSecret,
    })
    return {
      ref: deploy.ref,
      spec: spec as unknown as Record<string, unknown>,
      kind: 'deploy',
      options: { image: 'deploy' },
    }
  }

  /** Map a finished deploy job's view into a provisioned environment. */
  private finalizeProvision(
    view: RunnerJobView,
    req: ProvisionEnvironmentRequest,
  ): ProvisionedEnvironment {
    const config = parseKubernetesEnvConfig(req.manifest)
    return mapDeployOutcome(view, this.provisionContext(config, req.inputs).vars)
  }

  /**
   * Resolve the per-PR namespace and the `{{var}}` substitution map (inputs + namespace +
   * optional rendered image) in one place, so `provision()`, `buildProvisionJob()`, and
   * `finalizeProvision()` derive them identically.
   */
  private provisionContext(
    config: KubernetesProvisionConfig,
    inputs: Record<string, string>,
  ): { namespace: string; vars: Record<string, string> } {
    const namespace = resolveNamespace(config, inputs)
    const image = config.imageTemplate ? renderTemplate(config.imageTemplate, inputs) : undefined
    return { namespace, vars: templateVars(inputs, namespace, image) }
  }

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

  /** Resolve the live URL, reading the status host/address for status-backed sources. */
  private async resolveLiveUrl(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
    fields: Record<string, string>,
  ): Promise<string | null> {
    const url = config.url
    const vars = { ...fields, namespace }
    if (url.source === 'ingressTemplate') return deriveUrl(url, vars, null)
    const address = await this.readStatusHost(client, config, namespace)
    return address ? deriveUrl(url, vars, address) : null
  }

  /**
   * Read the host/address backing a status source: the LoadBalancer address of the named
   * Service/Ingress (or — when `ingressStatus` omits the name — the single Ingress applied
   * in the namespace), or the Gateway-API host for `gatewayStatus`/`httpRouteStatus`. Null
   * until assigned. NOTE: a Gateway/HTTPRoute that DECLARES a concrete hostname resolves
   * immediately (the host is the intended URL), which can precede the address actually being
   * programmed — readiness is driven by the Deployments' rollout, not by this URL.
   */
  private async readStatusHost(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
  ): Promise<string | null> {
    const url = config.url
    if (url.source === 'serviceStatus') {
      const svc = await this.getByNameOrFirst(
        client,
        config,
        'v1',
        'Service',
        namespace,
        url.serviceName,
      )
      return svc ? extractLoadBalancerAddress(svc) : null
    }
    if (url.source === 'gatewayStatus') return this.readGatewayHost(client, config, namespace)
    if (url.source === 'httpRouteStatus') return this.readHttpRouteHost(client, config, namespace)
    // ingressTemplate is resolved by the caller; only ingressStatus reaches here.
    if (url.source !== 'ingressStatus') return null
    // ingressStatus: a named Ingress, else the only Ingress in the namespace.
    const ingress = await this.getByNameOrFirst(
      client,
      config,
      'networking.k8s.io/v1',
      'Ingress',
      namespace,
      url.ingressName,
    )
    return ingress ? extractLoadBalancerAddress(ingress) : null
  }

  /**
   * Resolve a `gatewayStatus` host: a named `Gateway` (else the only one in the namespace),
   * preferring a concrete listener hostname over the raw assigned address. Null until assigned.
   */
  private async readGatewayHost(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
  ): Promise<string | null> {
    const url = config.url
    if (url.source !== 'gatewayStatus') return null
    const gw = await this.getByNameOrFirst(
      client,
      config,
      GATEWAY_API_VERSION,
      'Gateway',
      namespace,
      url.gatewayName,
    )
    if (!gw) return null
    return extractGatewayListenerHost(gw) ?? extractGatewayAddress(gw)
  }

  /**
   * Resolve an `httpRouteStatus` host: a named `HTTPRoute` (else the only one), preferring its
   * own concrete hostname; otherwise the parent `Gateway`'s assigned address (read in the
   * parentRef's namespace, since a shared gateway commonly lives elsewhere). Null until assigned.
   */
  private async readHttpRouteHost(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
  ): Promise<string | null> {
    const url = config.url
    if (url.source !== 'httpRouteStatus') return null
    const route = await this.getByNameOrFirst(
      client,
      config,
      GATEWAY_API_VERSION,
      'HTTPRoute',
      namespace,
      url.httpRouteName,
    )
    if (!route) return null
    const host = extractHttpRouteHost(route)
    if (host) return host
    const parent = httpRouteParentRef(route)
    if (!parent) return null
    const gw = await this.getByNameOrFirst(
      client,
      config,
      GATEWAY_API_VERSION,
      'Gateway',
      parent.namespace ?? namespace,
      parent.name,
    )
    return gw ? extractGatewayAddress(gw) : null
  }

  /** GET a URL, returning the parsed JSON body, or null on any non-OK response. */
  private async getJson(client: KubernetesApiClient, url: string): Promise<unknown | null> {
    const res = await client.fetch('GET', url, undefined, READ_TIMEOUT_MS)
    return res.ok ? await res.json() : null
  }

  /**
   * GET a namespaced resource by name, or the first item of its collection when `name` is
   * omitted. Returns null when the resource/collection is absent or empty.
   */
  private async getByNameOrFirst(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    apiVersion: string,
    kind: string,
    namespace: string,
    name?: string,
  ): Promise<unknown | null> {
    const body = await this.getJson(client, resourceUrl(config, apiVersion, kind, namespace, name))
    if (body === null) return null
    return name ? body : firstListItem(body)
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
