import type { KubernetesRunnerConfig, RunnerDispatchOptions } from '@cat-factory/kernel'
import { isCloudMetadataHost } from '@cat-factory/kernel'
import { KUBERNETES_RUNNER_TOKEN_SECRET_KEY } from '@cat-factory/contracts'

// Pure helpers for the native Kubernetes runner backend. No I/O here — URL
// building, the per-run pod-name derivation, the pod manifest, and the readiness
// classification are all pure so they unit-test in isolation. The transport
// (KubernetesRunnerTransport) does the actual kube-apiserver `fetch`es.

/**
 * The secret-bundle key the Kubernetes backend reads the ServiceAccount token from.
 * Re-exported from the wire contract (the single source of truth shared with the SPA
 * connect form) so the key is defined once.
 */
export const KUBERNETES_TOKEN_KEY = KUBERNETES_RUNNER_TOKEN_SECRET_KEY

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
  // The apiserver pod-proxy subresource addresses the target as a literal
  // `pods/<name>:<port>/proxy` path segment — kubectl/client-go send the colon
  // UNENCODED. Encode the name (RFC1123, so a no-op in practice) but keep the
  // `:<port>` literal so the apiserver parses the name:port pair.
  return `${podsUrl(config)}/${encodeURIComponent(name)}:${port}/proxy${p}`
}

/** Resolve the image variant a dispatch needs (the heavier UI image when asked + configured). */
export function resolveImage(
  config: KubernetesRunnerConfig,
  options?: RunnerDispatchOptions,
): string {
  if (options?.image === 'ui' && config.imageUi) return config.imageUi
  return config.image
}

/** Resolve the pod resource block for a dispatch (per-size override, else the default). */
export function resolveResources(
  config: KubernetesRunnerConfig,
  options?: RunnerDispatchOptions,
): { requests?: Record<string, string>; limits?: Record<string, string> } | undefined {
  const sizeOverride = options?.instanceSize
    ? config.resourcesBySize?.[options.instanceSize]
    : undefined
  // A per-size override is the t-shirt size for this run: it sets BOTH the request and
  // the limit (requests == limits ⇒ Guaranteed QoS). Applying it to the limit alone
  // while keeping a larger default request produces requests > limits, which the
  // apiserver rejects with a 422 — so a smaller size could never start.
  const requests = sizeOverride ?? config.resources?.requests
  const limits = sizeOverride ?? config.resources?.limits
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
 * Container `state.waiting.reason`s that will NOT self-heal within the readiness window:
 * a bad/unpullable image, a malformed container config, a failed lifecycle hook, or a
 * container that keeps crashing on boot. These are deterministic — re-driving the same pod
 * just hangs the full window again — so the transport must FAIL FAST and NON-recoverably on
 * them (a `dispatch` failure with the root cause), not poll until the generic timeout and
 * then mis-tag it as a recoverable eviction.
 *
 * This is an explicit ALLOW-LIST of known-terminal kubelet reasons, NOT a deny-list of the
 * transient ones, ON PURPOSE: the genuinely-transient set is just `ContainerCreating` /
 * `PodInitializing`, but inverting (treat every other reason as terminal) would kill pods on
 * any unrecognised or genuinely-transient reason a newer kubelet introduces. A reason we fail
 * to enumerate here degrades GRACEFULLY — it falls through to the readiness DEADLINE, which
 * still bounds the wait (it just costs the full window before failing, rather than failing at
 * once) — whereas a false-terminal would mis-kill a pod that would have recovered. So keep
 * this list current as kubelet adds reasons, but a miss is a latency cost, not a correctness
 * bug.
 */
const TERMINAL_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'ErrImageNeverPull',
  'ErrInvalidImageName',
  'InvalidImageName',
  'ImageInspectError',
  'RegistryUnavailable',
  'CreateContainerConfigError',
  'CreateContainerError',
  'PreStartHookError',
  'PostStartHookError',
  'CrashLoopBackOff',
  'RunContainerError',
])

function statusOf(pod: unknown): Record<string, unknown> | undefined {
  return (pod as { status?: Record<string, unknown> } | null)?.status
}

function containerStatuses(
  status: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  return Array.isArray(status?.containerStatuses)
    ? (status.containerStatuses as Array<Record<string, unknown>>)
    : []
}

function waitingOf(cs: Record<string, unknown>): { reason?: string; message?: string } | undefined {
  const state = cs.state as { waiting?: Record<string, unknown> } | undefined
  const waiting = state?.waiting
  if (!waiting) return undefined
  return {
    reason: typeof waiting.reason === 'string' ? waiting.reason : undefined,
    message: typeof waiting.message === 'string' ? waiting.message : undefined,
  }
}

/**
 * A terminal, unrecoverable container start-up failure (a bad image / config / crash
 * loop), formatted as `"<reason>: <message>"`, or null when the pod is just still coming
 * up. Drives the transport's fail-fast path so a doomed pod surfaces its real reason
 * (e.g. `ImagePullBackOff: Back-off pulling image "…"`) at once instead of after the
 * 120s readiness timeout.
 */
export function classifyPodStartupFailure(pod: unknown): string | null {
  for (const cs of containerStatuses(statusOf(pod))) {
    const waiting = waitingOf(cs)
    if (waiting?.reason && TERMINAL_WAITING_REASONS.has(waiting.reason)) {
      return waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason
    }
  }
  return null
}

/**
 * Best-effort short, human-readable detail of WHY a pod isn't ready — a waiting
 * container's `reason: message`, else the pod's failed/unready condition message — for
 * enriching an otherwise root-cause-less "terminated"/"not ready in time" error. Returns
 * '' when nothing useful is present.
 */
export function describePodStatus(pod: unknown): string {
  const status = statusOf(pod)
  for (const cs of containerStatuses(status)) {
    const waiting = waitingOf(cs)
    if (waiting?.reason)
      return waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason
    const terminated = (cs.state as { terminated?: Record<string, unknown> } | undefined)
      ?.terminated
    if (terminated && typeof terminated.reason === 'string') {
      const msg = typeof terminated.message === 'string' ? terminated.message : undefined
      return msg ? `${terminated.reason}: ${msg}` : terminated.reason
    }
  }
  const conditions = Array.isArray(status?.conditions)
    ? (status.conditions as Array<Record<string, unknown>>)
    : []
  const failing = conditions.find(
    (c) => c.status === 'False' && typeof c.message === 'string' && c.message,
  )
  if (failing && typeof failing.message === 'string') {
    return typeof failing.reason === 'string'
      ? `${failing.reason}: ${failing.message}`
      : failing.message
  }
  return ''
}

/**
 * Validate the apiserver URL at the write boundary. Unlike the manifest pool's
 * STRICT policy (no private hosts), a kube-apiserver is routinely a private IP or
 * a cluster DNS name, so private hosts are ALLOWED here — the operator is
 * explicitly pointing at their cluster. We still require https and reject the
 * cloud-metadata endpoints (anti-SSRF), including their obfuscated IP encodings
 * (bare integer, IPv4-mapped IPv6) and the full link-local range — see the shared
 * {@link isCloudMetadataHost} classifier.
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
  if (isCloudMetadataHost(url.hostname)) {
    throw new Error('Kubernetes apiserver URL must not target the cloud metadata endpoint.')
  }
}
