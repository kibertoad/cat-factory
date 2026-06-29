import type { KubernetesRunnerConfig, RunnerDispatchOptions } from '@cat-factory/kernel'

// Pure helpers for the native Kubernetes runner backend. No I/O here — URL
// building, the per-run pod-name derivation, the pod manifest, and the readiness
// classification are all pure so they unit-test in isolation. The transport
// (KubernetesRunnerTransport) does the actual kube-apiserver `fetch`es.

/** The secret-bundle key the Kubernetes backend reads the ServiceAccount token from. */
export const KUBERNETES_TOKEN_KEY = 'apiToken'

/** Default port the executor-harness HTTP server listens on inside the pod. */
export const DEFAULT_HARNESS_PORT = 8080

/** Deterministic per-RUN pod name (one pod per run; steps re-attach to it). */
export function podName(runId: string): string {
  const sanitized = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  // RFC1123 label: <=63 chars, starts/ends alphanumeric. Reserve room for the prefix.
  const body = sanitized.slice(0, 63 - 'cf-run-'.length).replace(/-+$/g, '') || 'run'
  return `cf-run-${body}`
}

/** kube-apiserver root with any trailing slash stripped. */
export function apiBase(config: KubernetesRunnerConfig): string {
  return config.apiServerUrl.trim().replace(/\/+$/, '')
}

/** Collection URL for pods in the configured namespace. */
export function podsUrl(config: KubernetesRunnerConfig): string {
  return `${apiBase(config)}/api/v1/namespaces/${config.namespace}/pods`
}

/** A single pod's URL. */
export function podUrl(config: KubernetesRunnerConfig, name: string): string {
  return `${podsUrl(config)}/${encodeURIComponent(name)}`
}

/**
 * The apiserver POD-PROXY subresource URL for the pod's harness HTTP server:
 * `…/pods/<name>:<port>/proxy<path>`. Reaching this requires only HTTPS to the
 * apiserver (RBAC `pods/proxy`), so no in-cluster networking / per-run Service is
 * needed. `path` must begin with `/`.
 */
export function proxyUrl(config: KubernetesRunnerConfig, name: string, path: string): string {
  const port = config.harnessPort ?? DEFAULT_HARNESS_PORT
  const p = path.startsWith('/') ? path : `/${path}`
  return `${podsUrl(config)}/${encodeURIComponent(`${name}:${port}`)}/proxy${p}`
}

/** Resolve the image variant a dispatch needs (the heavier UI image when asked + configured). */
export function resolveImage(
  config: KubernetesRunnerConfig,
  options?: RunnerDispatchOptions,
): string {
  if (options?.image === 'ui' && config.imageUi) return config.imageUi
  return config.image
}

/** Resolve the pod resource block for a dispatch (per-size limit override, else the default). */
export function resolveResources(
  config: KubernetesRunnerConfig,
  options?: RunnerDispatchOptions,
): { requests?: Record<string, string>; limits?: Record<string, string> } | undefined {
  const sizeOverride = options?.instanceSize
    ? config.resourcesBySize?.[options.instanceSize]
    : undefined
  const limits = sizeOverride ?? config.resources?.limits
  const requests = config.resources?.requests
  const out: { requests?: Record<string, string>; limits?: Record<string, string> } = {}
  if (requests) out.requests = quantities(requests)
  if (limits) out.limits = quantities(limits)
  return out.requests || out.limits ? out : undefined
}

function quantities(q: { cpu?: string; memory?: string }): Record<string, string> {
  const out: Record<string, string> = {}
  if (q.cpu) out.cpu = q.cpu
  if (q.memory) out.memory = q.memory
  return out
}

/**
 * Build the bare-Pod manifest for a run. A bare Pod (not a Job) because the harness
 * is a long-lived HTTP server we own the lifecycle of (create on first dispatch,
 * delete on release) — Job completion semantics would fight that. The pod is
 * reachable ONLY through the apiserver pod-proxy (no Service), so the harness needs
 * no inbound shared secret here: access is gated by the SA's `pods/proxy` RBAC.
 */
export function buildPodManifest(
  config: KubernetesRunnerConfig,
  runId: string,
  name: string,
  options?: RunnerDispatchOptions,
): Record<string, unknown> {
  const port = config.harnessPort ?? DEFAULT_HARNESS_PORT
  const resources = resolveResources(config, options)
  const container: Record<string, unknown> = {
    name: 'executor',
    image: resolveImage(config, options),
    ports: [{ containerPort: port }],
    env: [{ name: 'PORT', value: String(port) }],
    ...(resources ? { resources } : {}),
  }
  const spec: Record<string, unknown> = {
    restartPolicy: 'Never',
    containers: [container],
    ...(config.serviceAccountName ? { serviceAccountName: config.serviceAccountName } : {}),
    ...(config.imagePullSecretName
      ? { imagePullSecrets: [{ name: config.imagePullSecretName }] }
      : {}),
    ...(config.nodeSelector ? { nodeSelector: config.nodeSelector } : {}),
    ...(config.tolerations ? { tolerations: config.tolerations } : {}),
  }
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: config.namespace,
      labels: { 'cat-factory.runId': labelValue(runId), ...config.labels },
      ...(config.annotations ? { annotations: config.annotations } : {}),
    },
    spec,
  }
}

/** Coerce an arbitrary id into a valid label value (<=63 chars, alnum/._-). */
function labelValue(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .slice(0, 63)
}

/** The readiness verdict from a pod's `status`. */
export type PodReadiness = 'ready' | 'pending' | 'gone'

/** Classify a pod's status JSON: ready to serve, still pending, or terminally gone. */
export function classifyPodReadiness(pod: unknown): PodReadiness {
  const status = (pod as { status?: Record<string, unknown> } | null)?.status
  const phase = typeof status?.phase === 'string' ? status.phase : undefined
  if (phase === 'Succeeded' || phase === 'Failed') return 'gone'
  if (phase !== 'Running') return 'pending'
  const conditions = Array.isArray(status?.conditions)
    ? (status.conditions as Array<Record<string, unknown>>)
    : []
  const ready = conditions.find((c) => c.type === 'Ready')
  return ready?.status === 'True' ? 'ready' : 'pending'
}

/**
 * Validate the apiserver URL at the write boundary. Unlike the manifest pool's
 * STRICT policy (no private hosts), a kube-apiserver is routinely a private IP or
 * a cluster DNS name, so private hosts are ALLOWED here — the operator is
 * explicitly pointing at their cluster. We still require https and reject the
 * link-local cloud-metadata endpoint (anti-SSRF).
 */
export function assertApiServerUrlSafe(rawUrl: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid Kubernetes apiserver URL: ${rawUrl}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error('Kubernetes apiserver URL must use https.')
  }
  const host = url.hostname.toLowerCase()
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    throw new Error('Kubernetes apiserver URL must not target the cloud metadata endpoint.')
  }
}
