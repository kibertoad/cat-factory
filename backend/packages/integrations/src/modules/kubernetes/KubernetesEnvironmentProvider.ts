import type {
  AsyncProvisionCapability,
  ConnectionTestResult,
  DeployProvisionJob,
  EnvironmentConnectionTestRequest,
  EnvironmentManifest,
  EnvironmentProvider,
  EnvironmentStatus,
  EnvironmentStatusRequest,
  EnvironmentTeardownRequest,
  KubernetesConnectionConfig,
  KubernetesEnvironmentConfig,
  KubernetesProvisionConfig,
  ProviderConfigField,
  ProvisionEnvironmentRequest,
  ProvisionedEnvironment,
  RepoFiles,
  RunnerJobView,
  RunRepoContext,
  SecretResolver,
  TeardownProbe,
} from '@cat-factory/kernel'
import {
  connectionFailureResult,
  describeConnectionFailure,
  describeUnfilledConfigPlaceholders,
  environmentFailure,
  getErrorMessage,
  unresolvedPlaceholders,
} from '@cat-factory/kernel'
import { KubernetesApiClient, safeText } from './KubernetesApiClient.js'
import {
  classifyApplyFailure,
  KUBERNETES_CONFIG_PLACEHOLDERS,
} from './environment-failure.logic.js'
import {
  apiBase,
  apiServerConnectionFailureMessage,
  classifyDeploymentReadiness,
} from './kubernetes.logic.js'
import {
  buildDeployJobSpec,
  deployTargetsBackendNamespace,
  mapDeployOutcome,
  needsContainerRender,
} from './kubernetes-deploy.logic.js'
import {
  apiServerHostname,
  buildPullSecret,
  buildServiceAccountPullSecretPatch,
  describeRegistryAuthSkip,
  describeRegistryAuthVerdict,
  isLocalThrowawayCluster,
  REGISTRY_AUTH_FIELD_MANAGER,
  registryAuthImageCandidates,
  registriesNamedByImages,
  resolveRegistryAuth,
  serviceAccountsNeedingOwnPatch,
  withPullSecretOnServiceAccounts,
} from './kubernetes-registry-auth.logic.js'
import {
  describeMisresolvingEnvironmentUrl,
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
  parseKubernetesEnvConnection,
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
/**
 * Field manager for the manifest applies. Exported so the registry-auth writes can be pinned as
 * using a DIFFERENT one: an apply is a manager's complete desired state, so sharing it would have
 * the next manifest apply declare the pull Secret and its account patches gone.
 */
export const FIELD_MANAGER = 'cat-factory'

/**
 * The `status.phase` of a namespace read (`Active` / `Terminating`), or null when the body
 * could not be parsed. Null is NOT read as either phase by the caller: a namespace that answered
 * a GET is present whatever its body says, and only the terminating/active split is unknown.
 */
async function namespacePhase(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { status?: { phase?: unknown } }
    const phase = body?.status?.phase
    return typeof phase === 'string' ? phase : null
  } catch {
    // silent-catch-ok: an unparseable body only costs the Active/Terminating detail; the caller
    // already knows the namespace is present because the read succeeded.
    return null
  }
}

export interface KubernetesEnvironmentProviderOptions {
  /** Reserved for future URL-policy-aware behaviour; unused today. */
  urlPolicy?: unknown
}

export class KubernetesEnvironmentProvider implements EnvironmentProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly options: KubernetesEnvironmentProviderOptions = {}) {}

  /**
   * Parse the stored manifest's `providerConfig` into the concrete K8s config. Overridable so a
   * subclass (the EKS provider) can parse its own superset config (K8s fields + AWS region /
   * cluster) while every method below still consumes it through the shared K8s fields.
   */
  protected parseConfig(manifest: EnvironmentManifest): KubernetesProvisionConfig {
    return parseKubernetesEnvConfig(manifest)
  }

  /**
   * Parse only what it takes to REACH the cluster, for the paths that reclaim rather than build.
   *
   * Separate from {@link parseConfig} so a stored config whose PROVISIONING half stopped matching
   * the contract can still be torn down: a manifest source or URL derivation that no longer
   * validates has to stop a provision, and must not be what leaves a namespace running forever
   * with nothing able to delete it. Overridable alongside `parseConfig` so a subclass whose
   * connection carries more (the EKS provider's AWS coordinates) narrows this the same way.
   */
  protected parseConnection(manifest: EnvironmentManifest): KubernetesConnectionConfig {
    return parseKubernetesEnvConnection(manifest)
  }

  /**
   * Build the apiserver client for a request. Overridable so a subclass can inject a different
   * auth scheme (the EKS provider passes a SigV4/STS token minter) WITHOUT touching any of the
   * provisioning/status/teardown logic, which stays auth-agnostic.
   *
   * Takes the CONNECTION shape, not the full config: the reclaim paths only ever parse that much,
   * and the provisioning paths pass a full config, which is one.
   */
  protected makeClient(
    config: KubernetesConnectionConfig,
    resolveSecret: SecretResolver,
  ): KubernetesApiClient {
    return new KubernetesApiClient(config, resolveSecret)
  }

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
    const config = this.parseConfig(req.manifest)
    const client = this.makeClient(config, req.resolveSecret)
    const { namespace, vars } = this.provisionContext(config, req.inputs)

    await this.ensureNamespace(client, config, namespace)

    const texts = await this.readManifests(req, config)
    // Refuse BEFORE applying when a placeholder this CONNECTION was meant to fill has no value:
    // rendering it to the empty string and applying anyway produces an apiserver rejection that
    // describes the RESULT and blames the file, which is how a correct `image: "{{image}}"` was
    // reported as a Deployment missing a required image. A run-supplied key that renders empty is
    // NOT a refusal: it is the documented lenient substitution, and which keys those are is the
    // scope rule `describeUnfilledConfigPlaceholders` owns.
    const missing = unresolvedPlaceholders(texts.join('\n'), vars, KUBERNETES_CONFIG_PLACEHOLDERS)
    const refusal = describeUnfilledConfigPlaceholders(missing)
    if (refusal) throw environmentFailure(refusal, 'config_incomplete')
    const resources: KubernetesResource[] = []
    for (const text of texts) {
      resources.push(...parseManifests(text, vars, namespace, req.inputs.blockId, config.labels))
    }
    if (resources.length === 0) {
      throw new Error('No Kubernetes manifests were found at the configured source path')
    }
    // Before the workloads, never after, and the reason is stricter than "pods start quickly":
    // the ServiceAccount admission controller copies an account's `imagePullSecrets` onto a pod
    // when the pod is CREATED, so an account patched after its Deployment applied does not reach
    // the pods already admitted. The accounts are read off the parsed resources, and the
    // manifests come back with the secret folded into the ServiceAccounts they declare, so this
    // has to sit between the parse and the apply.
    const toApply = await this.ensureRegistryAuth(client, config, namespace, resources, req, vars)
    for (const resource of toApply) {
      await this.apply(client, config, namespace, resource)
    }

    // For an ingress-template URL the address is known immediately; status-backed
    // sources resolve to null until `status()` reads the live LoadBalancer address.
    const url = deriveUrl(config.url, vars, null)
    // Graded once the namespace has joined the vars, because the namespace is half of what
    // mis-resolves: the template alone cannot be judged. See the helper for why this refuses
    // rather than warns, and why it is not repeated on the status poll.
    const misresolving = describeMisresolvingEnvironmentUrl(url)
    if (misresolving) throw environmentFailure(misresolving, 'config_incomplete')
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
    const config = this.parseConfig(req.manifest)
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
    const client = this.makeClient(config, req.resolveSecret)
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
    // The CONNECTION, not the full config: deleting a namespace needs the apiserver and nothing
    // the provisioning half of the config describes (see {@link parseConnection}).
    const config = this.parseConnection(req.manifest)
    const namespace = req.provisionFields.namespace ?? req.externalId
    if (!namespace) return { status: 'torn_down' }
    const client = this.makeClient(config, req.resolveSecret)
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

  /**
   * Confirm the namespace this environment lived in is gone, by reading it back.
   *
   * A namespace `DELETE` is asynchronous: the apiserver accepts it immediately and the namespace
   * sits in `Terminating` until its finalizers drain, which for a workload holding a PVC or a
   * webhook can be minutes. So the teardown call returning is genuinely not the environment being
   * gone, and this is the read that settles it: a 404 is the proof, an `Active` namespace means
   * the delete did nothing, and `Terminating` is reported as still-present-but-on-its-way rather
   * than as either, so a caller can re-probe instead of concluding.
   */
  async confirmTeardown(req: EnvironmentTeardownRequest): Promise<TeardownProbe> {
    const namespace = req.provisionFields.namespace ?? req.externalId
    // No namespace was ever recorded, so there is nothing to look for. Deliberately NOT reported
    // as `gone`: nothing was observed, and a provision that failed before it created a namespace
    // is indistinguishable here from a record that lost its external id.
    if (!namespace) {
      // Permanent: no later probe invents an id the record never had.
      return {
        state: 'unknown',
        retryable: false,
        reason: 'No namespace recorded for this environment.',
      }
    }
    let config: KubernetesConnectionConfig
    try {
      // Same narrow read as `teardown` — the probe reads the namespace back off the apiserver, so
      // it is answerable for exactly the configs a teardown is.
      config = this.parseConnection(req.manifest)
    } catch (err) {
      // A manifest whose apiserver coordinates no longer parse is fixed by editing it, not by
      // re-probing.
      return {
        state: 'unknown',
        retryable: false,
        reason: getErrorMessage(err),
      }
    }
    const client = this.makeClient(config, req.resolveSecret)
    let res: Response
    try {
      res = await client.fetch('GET', namespaceUrl(config, namespace), undefined, READ_TIMEOUT_MS)
    } catch (err) {
      return {
        state: 'unknown',
        retryable: true,
        // The DETAIL only, deliberately without the hint: the hints are written for the connect
        // form's Test button ("…then test again"), and this reason is read on a disposal card by
        // someone who is not testing a connection. What they need is the exact transport failure.
        reason: `Could not read namespace '${namespace}': ${describeConnectionFailure(err).detail}`,
      }
    }
    if (res.status === 404) return { state: 'gone' }
    if (!res.ok) {
      // A 401/403 is the apiserver refusing the read, not an answer about the namespace. Reporting
      // it as `gone` would turn an expired token into a clean teardown proof on every run.
      return {
        state: 'unknown',
        retryable: true,
        reason: `Could not read namespace '${namespace}' (HTTP ${res.status}): ${await safeText(res)}`,
      }
    }
    const phase = await namespacePhase(res)
    return {
      state: 'present',
      terminating: phase === 'Terminating',
      ...(phase ? { detail: `Namespace '${namespace}' is ${phase}.` } : {}),
    }
  }

  async testConnection(req: EnvironmentConnectionTestRequest): Promise<ConnectionTestResult> {
    if (!req.manifest) return { ok: false, message: 'Expected a Kubernetes environment manifest.' }
    let config: KubernetesEnvironmentConfig
    try {
      config = this.parseConfig(req.manifest)
    } catch (err) {
      return { ok: false, message: getErrorMessage(err) }
    }
    const client = this.makeClient(config, req.resolveSecret)
    try {
      const res = await client.fetch(
        'GET',
        `${namespaceUrl(config)}?limit=1`,
        undefined,
        READ_TIMEOUT_MS,
      )
      if (res.ok) return { ok: true, message: `Reached ${apiBase(config)}.` }
      return {
        ok: false,
        message: apiServerConnectionFailureMessage(res.status, await safeText(res), {
          operation: 'list namespaces',
        }),
      }
    } catch (err) {
      // The apiserver never answered, so there is no status to map: the failure is the thrown
      // transport error, whose real cause hangs off `.cause` and reads as a bare "fetch failed"
      // if taken at face value.
      return connectionFailureResult(err, {
        subject: 'the Kubernetes apiserver',
        target: apiBase(config),
      })
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
  private async buildProvisionJob(
    req: ProvisionEnvironmentRequest,
  ): Promise<DeployProvisionJob | null> {
    const config: KubernetesProvisionConfig = this.parseConfig(req.manifest)
    if (!needsContainerRender(config)) return null
    const deploy = req.deploy
    if (!deploy) {
      throw new Error(
        'This Kubernetes environment needs the container deploy adapter (kustomize / helm / ' +
          'image overrides / secret injections), but the deploy inputs were not provided.',
      )
    }
    const { namespace, vars } = this.provisionContext(config, req.inputs)
    // Prepare the namespace + its pull credential over the apiserver BEFORE handing the job over,
    // so both render paths behave the same way about private registries. Creating the namespace
    // early is idempotent (the deploy container applies into it either way), and it is what makes
    // a Secret placeable at all: there is nowhere to put one until it exists.
    //
    // No resources are passed, and that is the honest limit of this path: the manifests are
    // rendered inside the container, so the ServiceAccounts they declare cannot be enumerated
    // here and only `default` is attached. The recorded step says so rather than implying the
    // same coverage the raw path gets.
    await this.prepareRegistryAuth(config, namespace, req, vars)
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
      spec,
      kind: 'deploy',
      options: { image: 'deploy' },
    }
  }

  /** Map a finished deploy job's view into a provisioned environment. */
  private finalizeProvision(
    view: RunnerJobView,
    req: ProvisionEnvironmentRequest,
  ): ProvisionedEnvironment {
    const config = this.parseConfig(req.manifest)
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

  /**
   * The container-render path's half of the registry wiring: ensure the namespace exists, then
   * run the same best-effort credential wiring the inline path runs, with no manifests to read.
   *
   * The namespace has to be created here because the credential needs somewhere to live and the
   * render container holds no platform credential to make a Secret with. That write is only
   * correct where the backend's namespace is the one the deploy lands in
   * ({@link deployTargetsBackendNamespace}): a kustomize overlay that picks its own namespace is
   * resolved inside the container, so pre-creating here would leave an empty namespace nothing
   * tears down and a credential no pod reads, under a log line claiming success.
   *
   * Everything after the gate sits inside the best-effort envelope, the namespace create
   * included: an apiserver blip or a service account without namespace-create RBAC must cost the
   * convenience, never a provision that used to succeed without any of this (the deploy
   * container creates the namespace itself either way).
   */
  private async prepareRegistryAuth(
    config: KubernetesProvisionConfig,
    namespace: string,
    req: ProvisionEnvironmentRequest,
    vars: Record<string, string>,
  ): Promise<void> {
    // The cluster gate is asked first, and by the method that owns it: on a remote cluster the
    // namespace question never arises, and reporting the overlay's namespace as the reason would
    // name a configuration detail in place of the actual one.
    if (isLocalThrowawayCluster(config) && !deployTargetsBackendNamespace(config)) {
      await this.recordRegistryAuth(req, Date.now(), {
        outcome: 'success',
        detail: describeRegistryAuthSkip({ kind: 'namespace-not-derivable' }),
      })
      return
    }
    await this.ensureRegistryAuth(null, config, namespace, [], req, vars)
  }

  /**
   * Give the per-PR namespace a registry pull credential, on a THROWAWAY local cluster only.
   *
   * Why this exists: the namespace is minted seconds before the manifests are applied, so no
   * pull secret can be waiting in it, and a scaffolded service's image lands in its VCS host's
   * registry, private until somebody makes it public. The credential that fixes it is already
   * resolved for the clone, so the whole thing needs no configuration and no operator step.
   *
   * Three properties hold it together. It is gated on the apiserver naming THIS MACHINE (see
   * {@link isLocalThrowawayCluster}), because pushing a git credential into every per-PR
   * namespace is right for a cluster running here and is not a decision to make implicitly
   * against a shared one. It only ever fires when the image's registry is one the clone
   * credential plausibly covers. And it is BEST-EFFORT: a deployment whose packages are already
   * public pulls fine without it, so a refused write (missing RBAC on a hand-rolled
   * ServiceAccount) is reported and stepped over rather than failing a provision that would
   * otherwise have succeeded.
   *
   * Every path through it records a `registry-auth` step, the skips included. An unauthenticated
   * pull is the normal case and is ALSO what a private package looks like right up until the
   * kubelet 403s, so a silent skip is the one outcome that leaves a reader unable to tell which
   * happened. `client` is null where the caller has none yet (the container-render path), so the
   * apiserver client is built inside the envelope with everything else.
   *
   * @param resources the parsed manifests, MUTATED-BY-COPY through the returned array: the
   *   caller applies what comes back, not what it passed in.
   */
  private async ensureRegistryAuth(
    client: KubernetesApiClient | null,
    config: KubernetesProvisionConfig,
    namespace: string,
    resources: KubernetesResource[],
    req: ProvisionEnvironmentRequest,
    vars: Record<string, string>,
  ): Promise<KubernetesResource[]> {
    const startedAt = Date.now()
    if (!isLocalThrowawayCluster(config)) {
      await this.recordRegistryAuth(req, startedAt, {
        outcome: 'success',
        detail: describeRegistryAuthSkip({
          kind: 'not-local-cluster',
          apiServerHost: apiServerHostname(config),
        }),
      })
      return resources
    }
    try {
      // The clone thunk mints a short-lived token, so it is only pulled once an image is known
      // to name a registry a credential could cover: the port documents the thunk as lazy
      // precisely so a provision that needs no checkout never pays the mint.
      const images = registryAuthImageCandidates(config, vars)
      const clone = registriesNamedByImages(images).length > 0 ? await req.clone?.() : undefined
      const verdict = resolveRegistryAuth({
        images,
        clone,
        ...(req.inputs.repoOwner !== undefined ? { repoOwner: req.inputs.repoOwner } : {}),
      })
      if (verdict.kind !== 'wired') {
        await this.recordRegistryAuth(req, startedAt, {
          outcome: 'success',
          detail: describeRegistryAuthVerdict(verdict),
        })
        return resources
      }
      const api = client ?? this.makeClient(config, req.resolveSecret)
      if (!client) await this.ensureNamespace(api, config, namespace)
      await this.applyResource(api, config, namespace, buildPullSecret(namespace, verdict.auths), {
        fieldManager: REGISTRY_AUTH_FIELD_MANAGER,
      })
      // Two disjoint halves, and the split is what keeps the secret attached. An account the
      // manifests declare takes the entry inside their OWN body, because `imagePullSecrets` is
      // an atomic list that one field manager owns whole. Everything else is patched here.
      const patchedAccounts = serviceAccountsNeedingOwnPatch(resources)
      for (const account of patchedAccounts) {
        await this.applyResource(
          api,
          config,
          namespace,
          buildServiceAccountPullSecretPatch(account, namespace),
          { fieldManager: REGISTRY_AUTH_FIELD_MANAGER },
        )
      }
      const withSecret = withPullSecretOnServiceAccounts(resources)
      await this.recordRegistryAuth(req, startedAt, {
        outcome: 'success',
        detail: describeRegistryAuthVerdict(verdict, {
          auths: verdict.auths,
          patchedAccounts,
          declaredAccounts: resources
            .filter((r) => r.kind === 'ServiceAccount' && r.metadata.name)
            .map((r) => r.metadata.name!),
          manifestsVisible: resources.length > 0,
        }),
      })
      return withSecret
    } catch (error) {
      // Best-effort by design (see above), so the cause is REPORTED and the provision continues
      // with the manifests exactly as they were.
      await this.recordRegistryAuth(req, startedAt, {
        outcome: 'failure',
        error: getErrorMessage(error),
        detail: 'The environment will still provision; a private image will fail to pull.',
      })
      return resources
    }
  }

  /** Stream one registry-auth verdict to the provisioning log, when a sink is wired. */
  private async recordRegistryAuth(
    req: ProvisionEnvironmentRequest,
    startedAt: number,
    log: { outcome: 'success' | 'failure'; detail: string; error?: string },
  ): Promise<void> {
    await req.recordStep?.({
      name: 'registry-auth',
      outcome: log.outcome,
      durationMs: Date.now() - startedAt,
      detail: log.detail,
      ...(log.error ? { error: log.error } : {}),
    })
  }

  private async apply(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
    resource: KubernetesResource,
  ): Promise<void> {
    return this.applyResource(client, config, namespace, resource)
  }

  /**
   * Server-side apply one resource. The field manager is a parameter because the pull-secret
   * writes MUST NOT share the manifests' one: an apply is a manager's complete desired state, so
   * a later manifest apply of the same ServiceAccount under the same manager would take the
   * `imagePullSecrets` it does not mention straight back off again.
   */
  private async applyResource(
    client: KubernetesApiClient,
    config: KubernetesEnvironmentConfig,
    namespace: string,
    resource: KubernetesResource,
    options?: { fieldManager?: string },
  ): Promise<void> {
    const name = resource.metadata.name!
    const manager = options?.fieldManager ?? FIELD_MANAGER
    const url = `${resourceUrl(config, resource.apiVersion, resource.kind, namespace, name)}?fieldManager=${manager}&force=true`
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
      const body = await safeText(res)
      // Classified, not just reported. The verbatim apiserver text is what a person reads, and
      // the `reason` is what decides whether an automated fixer may be dispatched at this
      // failure at all: only a document the apiserver rejected on its own merits is something a
      // checkout edit can address. See `classifyApplyFailure`.
      throw environmentFailure(
        `Failed to apply ${resource.kind}/${name} (HTTP ${res.status}): ${body}`,
        classifyApplyFailure(res.status, body),
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
    // A credential / permission error (the apiserver rejecting the token, or the
    // ServiceAccount lacking RBAC to read Deployments) will NEVER self-heal — so surface it as a
    // hard failure (the caller's `refreshStatus` logs it to the provisioning log and the gate
    // degrades) instead of reporting the env as `provisioning`, which would leave a misconfigured
    // token/RBAC spinning up forever with no error. A transient 5xx/429 still keeps polling.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `apiserver rejected the environment status read (HTTP ${res.status}) — check the ` +
          `ServiceAccount token and its RBAC: ${await safeText(res)}`,
      )
    }
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
