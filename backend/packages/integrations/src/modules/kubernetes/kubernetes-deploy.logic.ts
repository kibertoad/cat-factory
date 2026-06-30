import type {
  DeployCloneTarget,
  EnvironmentStatus,
  KubernetesHelmRelease,
  KubernetesImageOverride,
  KubernetesProvisionConfig,
  KubernetesSecretInjection,
  KubernetesUrlSource,
  ProvisionedEnvironment,
  RunnerJobView,
  SecretResolver,
} from '@cat-factory/kernel'
import { renderTemplate } from './kubernetes-environment.logic.js'

// Pure logic for the CONTAINER-backed Kubernetes deploy path (real kubectl/kustomize/helm).
// It builds the opaque deploy-job body the backend POSTs to the deploy harness and maps the
// harness's structured outcome back into a ProvisionedEnvironment. No I/O — the provider
// supplies the resolved namespace, the clone target, and the secret resolver. Every template
// is rendered and every `secretRef` is resolved HERE, so the harness never sees the workspace
// bundle (it receives concrete values only). The job-body types mirror the harness's plain
// `DeployJob` shape (see `deploy-harness/src/job.ts`); they are duplicated rather than imported
// so the backend never depends on the private harness package (the harness validates on receipt).

/** A resolved image override (the kustomize `images:` shape). */
export interface DeployImageSpec {
  name: string
  newName?: string
  newTag?: string
  digest?: string
}

/** One resolved entry inside an injected Secret / generated `.env`. */
export interface DeploySecretEntrySpec {
  key: string
  value: string
}

/** How resolved secret values are fed in before apply. */
export type DeploySecretInjectionSpec =
  | { mode: 'secret'; secretName: string; secretType?: string; entries: DeploySecretEntrySpec[] }
  | { mode: 'generatorEnvFile'; envFilePath: string; entries: DeploySecretEntrySpec[] }

/** A resolved `--set path=value` for a helm release. */
export interface DeployHelmSetSpec {
  path: string
  value: string
}

/** A resolved helm release to `helm upgrade --install`. */
export interface DeployHelmReleaseSpec {
  name: string
  chart: string
  repo?: string
  version: string
  namespace?: string
  values?: Record<string, unknown>
  set?: DeployHelmSetSpec[]
  scope: 'per-environment' | 'shared'
}

/** The URL-source shape the harness consumes (the raw KubernetesUrlSource without templates). */
export type DeployUrlSourceSpec =
  | { source: 'ingressTemplate' }
  | { source: 'ingressStatus'; ingressName?: string; scheme?: 'http' | 'https' }
  | { source: 'serviceStatus'; serviceName: string; port?: number; scheme?: 'http' | 'https' }
  | { source: 'gatewayStatus'; gatewayName?: string; scheme?: 'http' | 'https' }
  | { source: 'httpRouteStatus'; httpRouteName?: string; scheme?: 'http' | 'https' }

/** The full deploy-job body (mirrors the harness's `DeployJob`). */
export interface DeployJobSpec {
  jobId: string
  cluster: {
    apiServerUrl: string
    caCertPem?: string
    insecureSkipTlsVerify?: boolean
    token: string
    namespace: string
  }
  source: { cloneUrl: string; ref: string; path: string; renderer: 'raw' | 'kustomize' }
  ghToken?: string
  setNamespace?: boolean
  images?: DeployImageSpec[]
  secretInjections?: DeploySecretInjectionSpec[]
  helmReleases?: DeployHelmReleaseSpec[]
  url: DeployUrlSourceSpec
  labels?: Record<string, string>
  rolloutTimeoutSeconds?: number
}

/**
 * Whether a service's Kubernetes config needs the container-backed deploy adapter rather than
 * the in-Worker native REST path. The REST path can only apply RAW, already-rendered manifests;
 * a `kustomize` overlay, any helm release, structured image overrides, or secret injections all
 * require real `kubectl`/`kustomize`/`helm`, so any of them forces the container path.
 */
export function needsContainerRender(config: KubernetesProvisionConfig): boolean {
  return (
    config.manifestSource.renderer === 'kustomize' ||
    (config.helmReleases?.length ?? 0) > 0 ||
    (config.images?.length ?? 0) > 0 ||
    (config.secretInjections?.length ?? 0) > 0
  )
}

/** Resolve image-override templates over the provision vars. */
export function resolveImageOverrides(
  images: KubernetesImageOverride[] | undefined,
  vars: Record<string, string>,
): DeployImageSpec[] {
  return (images ?? []).map((img) => {
    const spec: DeployImageSpec = { name: img.name }
    if (img.newNameTemplate !== undefined) spec.newName = renderTemplate(img.newNameTemplate, vars)
    if (img.newTagTemplate !== undefined) spec.newTag = renderTemplate(img.newTagTemplate, vars)
    if (img.digestTemplate !== undefined) spec.digest = renderTemplate(img.digestTemplate, vars)
    return spec
  })
}

/** Resolve one secret entry to a concrete value (a bundle ref, or a templated literal). */
function resolveEntryValue(
  entry: { secretRef?: { key: string }; valueTemplate?: string },
  vars: Record<string, string>,
  resolveSecret: SecretResolver,
): string {
  if (entry.secretRef) return resolveSecret(entry.secretRef.key) ?? ''
  return renderTemplate(entry.valueTemplate ?? '', vars)
}

/** Resolve secret injections (each entry's value) over the provision vars + the secret bundle. */
export function resolveSecretInjections(
  injections: KubernetesSecretInjection[] | undefined,
  vars: Record<string, string>,
  resolveSecret: SecretResolver,
): DeploySecretInjectionSpec[] {
  return (injections ?? []).map((inj) => {
    const entries = inj.entries.map((e) => ({
      key: e.key,
      value: resolveEntryValue(e, vars, resolveSecret),
    }))
    if (inj.mode === 'generatorEnvFile') {
      return { mode: 'generatorEnvFile', envFilePath: inj.envFilePath, entries }
    }
    return {
      mode: 'secret',
      secretName: inj.secretName,
      ...(inj.secretType !== undefined ? { secretType: inj.secretType } : {}),
      entries,
    }
  })
}

/** Resolve helm-release templates + folded-in secret `--set` values over the provision vars. */
export function resolveHelmReleases(
  releases: KubernetesHelmRelease[] | undefined,
  vars: Record<string, string>,
  resolveSecret: SecretResolver,
): DeployHelmReleaseSpec[] {
  return (releases ?? []).map((rel) => {
    const set: DeployHelmSetSpec[] = [
      ...(rel.set ?? []).map((s) => ({
        path: s.path,
        value: renderTemplate(s.valueTemplate, vars),
      })),
      ...(rel.valuesSecretRefs ?? []).map((s) => ({
        path: s.path,
        value: resolveSecret(s.secretRef.key) ?? '',
      })),
    ]
    const spec: DeployHelmReleaseSpec = {
      name: rel.name,
      chart: rel.chart,
      version: rel.version,
      scope: rel.scope ?? 'per-environment',
    }
    if (rel.repo !== undefined) spec.repo = rel.repo
    if (rel.namespaceTemplate !== undefined) {
      spec.namespace = renderTemplate(rel.namespaceTemplate, vars)
    }
    if (rel.values !== undefined) spec.values = rel.values
    if (set.length > 0) spec.set = set
    return spec
  })
}

/** Map a contract URL source to the harness URL shape (drop `ingressTemplate`'s host template). */
export function toDeployUrlSource(url: KubernetesUrlSource): DeployUrlSourceSpec {
  switch (url.source) {
    case 'ingressTemplate':
      // Resolved backend-side (the native REST `status()`), so the harness only needs the tag.
      return { source: 'ingressTemplate' }
    case 'ingressStatus':
      return {
        source: 'ingressStatus',
        ...(url.ingressName !== undefined ? { ingressName: url.ingressName } : {}),
        ...(url.scheme !== undefined ? { scheme: url.scheme } : {}),
      }
    case 'serviceStatus':
      return {
        source: 'serviceStatus',
        serviceName: url.serviceName,
        ...(url.port !== undefined ? { port: url.port } : {}),
        ...(url.scheme !== undefined ? { scheme: url.scheme } : {}),
      }
    case 'gatewayStatus':
      return {
        source: 'gatewayStatus',
        ...(url.gatewayName !== undefined ? { gatewayName: url.gatewayName } : {}),
        ...(url.scheme !== undefined ? { scheme: url.scheme } : {}),
      }
    case 'httpRouteStatus':
      return {
        source: 'httpRouteStatus',
        ...(url.httpRouteName !== undefined ? { httpRouteName: url.httpRouteName } : {}),
        ...(url.scheme !== undefined ? { scheme: url.scheme } : {}),
      }
  }
}

export interface BuildDeployJobParams {
  jobId: string
  config: KubernetesProvisionConfig
  vars: Record<string, string>
  namespace: string
  clone: DeployCloneTarget
  resolveSecret: SecretResolver
}

/**
 * Build the deploy-job body the backend dispatches to the deploy harness, with every template
 * rendered and every secret resolved. `setNamespace` overrides the overlay's pinned namespace
 * only for a `kustomize` source with a configured `namespaceTemplate` (true per-PR isolation);
 * absent ⇒ the overlay keeps its own namespace (the shared-namespace ephemeral-env shape).
 */
export function buildDeployJobSpec(params: BuildDeployJobParams): DeployJobSpec {
  const { jobId, config, vars, namespace, clone, resolveSecret } = params
  const renderer = config.manifestSource.renderer ?? 'raw'
  const images = resolveImageOverrides(config.images, vars)
  const secretInjections = resolveSecretInjections(config.secretInjections, vars, resolveSecret)
  const helmReleases = resolveHelmReleases(config.helmReleases, vars, resolveSecret)
  const setNamespace = renderer === 'kustomize' && !!config.namespaceTemplate
  const spec: DeployJobSpec = {
    jobId,
    cluster: {
      apiServerUrl: config.apiServerUrl,
      ...(config.caCertPem !== undefined ? { caCertPem: config.caCertPem } : {}),
      ...(config.insecureSkipTlsVerify !== undefined
        ? { insecureSkipTlsVerify: config.insecureSkipTlsVerify }
        : {}),
      token: resolveSecret('apiToken') ?? '',
      namespace,
    },
    source: {
      cloneUrl: clone.cloneUrl,
      ref: clone.ref,
      path: config.manifestSource.path,
      renderer,
    },
    ...(clone.token !== undefined ? { ghToken: clone.token } : {}),
    ...(setNamespace ? { setNamespace } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(secretInjections.length > 0 ? { secretInjections } : {}),
    ...(helmReleases.length > 0 ? { helmReleases } : {}),
    url: toDeployUrlSource(config.url),
    ...(config.labels !== undefined ? { labels: config.labels } : {}),
  }
  return spec
}

/** The structured outcome the deploy harness returns on the job result's `custom` channel. */
interface DeployOutcome {
  namespace: string
  url: string | null
  status: 'ready' | 'provisioning'
}

function isDeployOutcome(value: unknown): value is DeployOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DeployOutcome).namespace === 'string'
  )
}

/**
 * Map a finished deploy job's view into a {@link ProvisionedEnvironment}. A failed job (or one
 * with no structured outcome) becomes a `failed` environment carrying the harness error; a
 * successful one carries the namespace (the externalId), the resolved URL, and the readiness.
 * `fields` preserves the provision vars so a later native REST `status()` can re-derive an
 * `ingressTemplate` URL (the same vars the synchronous `provision()` persists).
 */
export function mapDeployOutcome(
  view: RunnerJobView,
  vars: Record<string, string>,
): ProvisionedEnvironment {
  const outcome = view.result?.custom
  if (view.state === 'failed' || !isDeployOutcome(outcome)) {
    return {
      externalId: null,
      url: null,
      status: 'failed',
      expiresAt: null,
      access: null,
      fields: { ...vars },
      error: view.error ?? 'Deploy job did not return an environment outcome',
    }
  }
  const status: EnvironmentStatus = outcome.status === 'ready' ? 'ready' : 'provisioning'
  return {
    externalId: outcome.namespace,
    url: outcome.url,
    status,
    expiresAt: null,
    access: null,
    fields: { ...vars, namespace: outcome.namespace },
  }
}
