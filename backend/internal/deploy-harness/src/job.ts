// The deploy job the backend's KubernetesEnvironmentProvider.buildProvisionJob (slice 8)
// POSTs to /jobs. Kept as plain types with a hand-rolled validator so the image needs no
// schema dependency (mirrors the executor harness's job.ts). Every templated/secret value
// is ALREADY RESOLVED by the backend before dispatch: the harness never sees the workspace
// secret bundle, so `secretInjections`/`helmReleases[].set`/`valuesSecretRefs` arrive as
// concrete values. `cluster.token` and `ghToken` are the only credentials and are consumed
// into the kubeconfig / git askpass, never logged.

/** How `source.path` is turned into resources: raw apply vs `kustomize build`. */
export type KubernetesRenderer = 'raw' | 'kustomize'

/** The apiserver connection (from the workspace kube engine config + the apiToken secret). */
export interface ClusterSpec {
  apiServerUrl: string
  caCertPem?: string
  insecureSkipTlsVerify?: boolean
  /** Bearer token (secret). */
  token: string
  /** The resolved per-PR namespace the env lives in. */
  namespace: string
}

/** Where to read the manifests from (a git repo + ref + path — colocated or separate). */
export interface SourceSpec {
  /** HTTPS clone URL of the manifests repo (the PR repo for colocated, else the separate repo). */
  cloneUrl: string
  /** Branch/tag/sha to read at. */
  ref: string
  /** Overlay directory (kustomize) or file/dir path (raw) within the repo. */
  path: string
  renderer: KubernetesRenderer
}

/** A resolved image override (templates rendered backend-side): the kustomize `images:` shape. */
export interface ImageOverrideSpec {
  name: string
  newName?: string
  newTag?: string
  digest?: string
}

/** One resolved entry inside an injected Secret / generated `.env`. */
export interface SecretEntrySpec {
  key: string
  value: string
}

/** How resolved secret values are fed in before apply (see the contracts' kubernetesSecretInjectionSchema). */
export type SecretInjectionSpec =
  | { mode: 'secret'; secretName: string; secretType?: string; entries: SecretEntrySpec[] }
  | { mode: 'generatorEnvFile'; envFilePath: string; entries: SecretEntrySpec[] }

/** A resolved `--set path=value` for a helm release. */
export interface HelmSetSpec {
  path: string
  value: string
}

/** A resolved helm release to `helm upgrade --install`. */
export interface HelmReleaseSpec {
  name: string
  chart: string
  repo?: string
  version: string
  /** Resolved install namespace; absent ⇒ the env namespace. */
  namespace?: string
  values?: Record<string, unknown>
  set?: HelmSetSpec[]
  /** `shared` ⇒ a cluster singleton installed before the manifests, never torn down per-PR. */
  scope: 'per-environment' | 'shared'
}

/** How the environment URL is derived once applied — the raw KubernetesUrlSource shape. */
export type UrlSourceSpec =
  | { source: 'ingressTemplate' }
  | { source: 'ingressStatus'; ingressName?: string; scheme?: 'http' | 'https' }
  | { source: 'serviceStatus'; serviceName: string; port?: number; scheme?: 'http' | 'https' }
  | { source: 'gatewayStatus'; gatewayName?: string; scheme?: 'http' | 'https' }
  | { source: 'httpRouteStatus'; httpRouteName?: string; scheme?: 'http' | 'https' }

export interface DeployJob {
  jobId: string
  cluster: ClusterSpec
  source: SourceSpec
  /** Git token for cloning a private manifests repo. Optional (public repo). */
  ghToken?: string
  /**
   * Override the overlay's pinned namespace at build time (`kustomize edit set namespace`).
   * Absent/false ⇒ honor the overlay's own `namespace:` (the shared-namespace env shape).
   * Only meaningful for `renderer: 'kustomize'`.
   */
  setNamespace?: boolean
  images?: ImageOverrideSpec[]
  secretInjections?: SecretInjectionSpec[]
  helmReleases?: HelmReleaseSpec[]
  url: UrlSourceSpec
  /** Extra labels stamped on the namespace. */
  labels?: Record<string, string>
  /** Per-deployment rollout wait, seconds (default 180). */
  rolloutTimeoutSeconds?: number
}

// --- hand-rolled validator -------------------------------------------------

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid deploy job: '${path}' must be a non-empty string`)
  }
  return value
}

function optStr(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return str(value, path)
}

function optBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optPosInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid deploy job: '${path}' must be an object`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid deploy job: '${path}' must be an array`)
  return value
}

function optStrRecord(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  const o = asObject(value, path)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) out[k] = str(v, `${path}.${k}`)
  return out
}

function parseCluster(value: unknown): ClusterSpec {
  const o = asObject(value, 'cluster')
  return {
    apiServerUrl: str(o.apiServerUrl, 'cluster.apiServerUrl'),
    ...(optStr(o.caCertPem, 'cluster.caCertPem') !== undefined
      ? { caCertPem: o.caCertPem as string }
      : {}),
    ...(optBool(o.insecureSkipTlsVerify) !== undefined
      ? { insecureSkipTlsVerify: o.insecureSkipTlsVerify as boolean }
      : {}),
    token: str(o.token, 'cluster.token'),
    namespace: str(o.namespace, 'cluster.namespace'),
  }
}

function parseSource(value: unknown): SourceSpec {
  const o = asObject(value, 'source')
  const renderer = o.renderer === 'kustomize' ? 'kustomize' : 'raw'
  return {
    cloneUrl: str(o.cloneUrl, 'source.cloneUrl'),
    ref: str(o.ref, 'source.ref'),
    path: str(o.path, 'source.path'),
    renderer,
  }
}

function parseImages(value: unknown): ImageOverrideSpec[] | undefined {
  if (value === undefined || value === null) return undefined
  return asArray(value, 'images').map((raw, i) => {
    const o = asObject(raw, `images[${i}]`)
    const spec: ImageOverrideSpec = { name: str(o.name, `images[${i}].name`) }
    const newName = optStr(o.newName, `images[${i}].newName`)
    const newTag = optStr(o.newTag, `images[${i}].newTag`)
    const digest = optStr(o.digest, `images[${i}].digest`)
    if (newName !== undefined) spec.newName = newName
    if (newTag !== undefined) spec.newTag = newTag
    if (digest !== undefined) spec.digest = digest
    if (spec.newName === undefined && spec.newTag === undefined && spec.digest === undefined) {
      throw new Error(`Invalid deploy job: 'images[${i}]' must set newName, newTag, or digest`)
    }
    return spec
  })
}

function parseSecretEntries(value: unknown, path: string): SecretEntrySpec[] {
  return asArray(value, path).map((raw, i) => {
    const o = asObject(raw, `${path}[${i}]`)
    return {
      key: str(o.key, `${path}[${i}].key`),
      // A secret value may legitimately be empty (an unset optional), so accept '' here.
      value: typeof o.value === 'string' ? o.value : str(o.value, `${path}[${i}].value`),
    }
  })
}

function parseSecretInjections(value: unknown): SecretInjectionSpec[] | undefined {
  if (value === undefined || value === null) return undefined
  return asArray(value, 'secretInjections').map((raw, i) => {
    const o = asObject(raw, `secretInjections[${i}]`)
    if (o.mode === 'generatorEnvFile') {
      return {
        mode: 'generatorEnvFile',
        envFilePath: str(o.envFilePath, `secretInjections[${i}].envFilePath`),
        entries: parseSecretEntries(o.entries, `secretInjections[${i}].entries`),
      }
    }
    if (o.mode === 'secret') {
      const secretType = optStr(o.secretType, `secretInjections[${i}].secretType`)
      return {
        mode: 'secret',
        secretName: str(o.secretName, `secretInjections[${i}].secretName`),
        ...(secretType !== undefined ? { secretType } : {}),
        entries: parseSecretEntries(o.entries, `secretInjections[${i}].entries`),
      }
    }
    throw new Error(
      `Invalid deploy job: 'secretInjections[${i}].mode' must be secret|generatorEnvFile`,
    )
  })
}

function parseHelmReleases(value: unknown): HelmReleaseSpec[] | undefined {
  if (value === undefined || value === null) return undefined
  return asArray(value, 'helmReleases').map((raw, i) => {
    const o = asObject(raw, `helmReleases[${i}]`)
    const repo = optStr(o.repo, `helmReleases[${i}].repo`)
    const namespace = optStr(o.namespace, `helmReleases[${i}].namespace`)
    const set =
      o.set === undefined || o.set === null
        ? undefined
        : asArray(o.set, `helmReleases[${i}].set`).map((s, j) => {
            const so = asObject(s, `helmReleases[${i}].set[${j}]`)
            return {
              path: str(so.path, `helmReleases[${i}].set[${j}].path`),
              value:
                typeof so.value === 'string'
                  ? so.value
                  : str(so.value, `helmReleases[${i}].set[${j}].value`),
            }
          })
    const values =
      o.values === undefined || o.values === null
        ? undefined
        : asObject(o.values, `helmReleases[${i}].values`)
    return {
      name: str(o.name, `helmReleases[${i}].name`),
      chart: str(o.chart, `helmReleases[${i}].chart`),
      ...(repo !== undefined ? { repo } : {}),
      version: str(o.version, `helmReleases[${i}].version`),
      ...(namespace !== undefined ? { namespace } : {}),
      ...(values !== undefined ? { values } : {}),
      ...(set !== undefined ? { set } : {}),
      scope: o.scope === 'shared' ? 'shared' : 'per-environment',
    }
  })
}

function optScheme(value: unknown): 'http' | 'https' | undefined {
  return value === 'http' || value === 'https' ? value : undefined
}

function parseUrl(value: unknown): UrlSourceSpec {
  const o = asObject(value, 'url')
  const scheme = optScheme(o.scheme)
  switch (o.source) {
    case 'ingressTemplate':
      return { source: 'ingressTemplate' }
    case 'ingressStatus':
      return {
        source: 'ingressStatus',
        ...(optStr(o.ingressName, 'url.ingressName') !== undefined
          ? { ingressName: o.ingressName as string }
          : {}),
        ...(scheme ? { scheme } : {}),
      }
    case 'serviceStatus':
      return {
        source: 'serviceStatus',
        serviceName: str(o.serviceName, 'url.serviceName'),
        ...(optPosInt(o.port) !== undefined ? { port: optPosInt(o.port) } : {}),
        ...(scheme ? { scheme } : {}),
      }
    case 'gatewayStatus':
      return {
        source: 'gatewayStatus',
        ...(optStr(o.gatewayName, 'url.gatewayName') !== undefined
          ? { gatewayName: o.gatewayName as string }
          : {}),
        ...(scheme ? { scheme } : {}),
      }
    case 'httpRouteStatus':
      return {
        source: 'httpRouteStatus',
        ...(optStr(o.httpRouteName, 'url.httpRouteName') !== undefined
          ? { httpRouteName: o.httpRouteName as string }
          : {}),
        ...(scheme ? { scheme } : {}),
      }
    default:
      throw new Error(`Invalid deploy job: 'url.source' is not a known URL source`)
  }
}

/** Parse + validate a raw POST /jobs body into a {@link DeployJob}. Throws a 400-worthy error. */
export function parseDeployJob(input: unknown): DeployJob {
  const o = asObject(input, 'job')
  const images = parseImages(o.images)
  const secretInjections = parseSecretInjections(o.secretInjections)
  const helmReleases = parseHelmReleases(o.helmReleases)
  const labels = optStrRecord(o.labels, 'labels')
  const rollout = optPosInt(o.rolloutTimeoutSeconds)
  return {
    jobId: str(o.jobId, 'jobId'),
    cluster: parseCluster(o.cluster),
    source: parseSource(o.source),
    ...(optStr(o.ghToken, 'ghToken') !== undefined ? { ghToken: o.ghToken as string } : {}),
    ...(optBool(o.setNamespace) !== undefined ? { setNamespace: o.setNamespace as boolean } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(secretInjections !== undefined ? { secretInjections } : {}),
    ...(helmReleases !== undefined ? { helmReleases } : {}),
    url: parseUrl(o.url),
    ...(labels !== undefined ? { labels } : {}),
    ...(rollout !== undefined ? { rolloutTimeoutSeconds: rollout } : {}),
  }
}

/** The credential strings a job carries, for redaction of any surfaced error/output. */
export function jobSecrets(job: DeployJob): string[] {
  const secrets = new Set<string>()
  if (job.cluster.token) secrets.add(job.cluster.token)
  if (job.ghToken) secrets.add(job.ghToken)
  for (const inj of job.secretInjections ?? []) {
    for (const e of inj.entries) if (e.value) secrets.add(e.value)
  }
  for (const rel of job.helmReleases ?? []) {
    for (const s of rel.set ?? []) if (s.value) secrets.add(s.value)
  }
  return [...secrets]
}
