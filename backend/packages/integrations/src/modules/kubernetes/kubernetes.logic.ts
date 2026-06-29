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

/** Decode a host literal to its IPv4 octets (dotted-decimal, bare integer, or
 * IPv4-mapped IPv6), or null when it is not an IPv4 literal. Covers the obfuscated
 * encodings that trivially bypass a naive dotted-decimal equality check. */
function decodeIpv4(host: string): [number, number, number, number] | null {
  const dotted = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    const parts = dotted.slice(1, 5).map(Number) as [number, number, number, number]
    return parts.every((n) => n <= 255) ? parts : null
  }
  const mapped = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (mapped) {
    const parts = mapped.slice(1, 5).map(Number) as [number, number, number, number]
    return parts.every((n) => n <= 255) ? parts : null
  }
  // IPv4-mapped IPv6 in hex form (`::ffff:a9fe:a9fe`), the shape `new URL` normalizes
  // `::ffff:1.2.3.4` to.
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1] ?? '0', 16)
    const lo = parseInt(hex[2] ?? '0', 16)
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
  }
  if (/^\d+$/.test(host)) {
    const n = Number(host)
    if (n > 0xffffffff) return null
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  }
  return null
}

/** Whether a host resolves to a known cloud-metadata / link-local target. */
function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'metadata.google.internal') return true
  // AWS IPv6 IMDS.
  if (host === 'fd00:ec2::254') return true
  const v4 = decodeIpv4(host)
  if (v4) {
    const [a, b, c, d] = v4
    // The whole 169.254.0.0/16 link-local range (incl. 169.254.169.254 IMDS) — a
    // kube-apiserver is never link-local, so block the range, not just the one IP.
    if (a === 169 && b === 254) return true
    // Alibaba Cloud metadata.
    if (a === 100 && b === 100 && c === 100 && d === 200) return true
  }
  return false
}

/**
 * Validate the apiserver URL at the write boundary. Unlike the manifest pool's
 * STRICT policy (no private hosts), a kube-apiserver is routinely a private IP or
 * a cluster DNS name, so private hosts are ALLOWED here — the operator is
 * explicitly pointing at their cluster. We still require https and reject the
 * cloud-metadata endpoints (anti-SSRF), including their obfuscated IP encodings
 * (bare integer, IPv4-mapped IPv6) and the full link-local range.
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
  if (isMetadataHost(url.hostname)) {
    throw new Error('Kubernetes apiserver URL must not target the cloud metadata endpoint.')
  }
}
