import type {
  KubernetesRunnerConfig,
  ProviderConfigField,
  RunnerDispatchOptions,
} from '@cat-factory/kernel'
import {
  deploymentImageVariantMessage,
  isCloudMetadataHost,
  isPlatformImageVariant,
  RUNNER_IMAGE_UNWIRED_REASON,
  UnavailableError,
  ValidationError,
} from '@cat-factory/kernel'
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

/**
 * The shared NON-SECRET flat connect-form fields common to every apiserver-backed runner
 * backend (native Kubernetes AND EKS — an EKS apiserver IS a Kubernetes apiserver). The
 * Kubernetes backend appends its ServiceAccount-token secret; the EKS backend appends the AWS
 * region/cluster + credential-secret fields. Defined once here so the two can't drift. The
 * advanced pod knobs (resources / nodeSelector / tolerations / labels) are intentionally NOT
 * surfaced — they're records/arrays a flat form can't express, so they stay API-only exactly
 * as the previous hardcoded form left them (a re-save preserves them; see `RunnerBackendForm`).
 */
export const KUBERNETES_RUNNER_FORM_FIELDS: ProviderConfigField[] = [
  { key: 'label', label: 'Name', required: true, placeholder: 'prod cluster' },
  {
    key: 'apiServerUrl',
    label: 'API server URL',
    required: true,
    placeholder: 'https://10.0.0.1:6443',
  },
  { key: 'namespace', label: 'Namespace', required: true, placeholder: 'cat-factory' },
  {
    key: 'image',
    label: 'Executor image',
    required: true,
    placeholder: 'ghcr.io/kibertoad/cat-factory-executor:latest',
  },
  {
    key: 'imageUi',
    label: 'UI-tester image',
    help: 'The heavier Playwright image used for image:ui dispatches (optional).',
  },
  {
    key: 'caCertPem',
    label: 'API server CA (PEM)',
    type: 'textarea',
    help: 'PEM CA bundle verifying the apiserver cert. Omit only for a publicly-trusted CA.',
  },
  {
    key: 'harnessPort',
    label: 'Harness port',
    type: 'number',
    default: String(DEFAULT_HARNESS_PORT),
  },
  {
    key: 'insecureSkipTlsVerify',
    label: 'Skip TLS verification',
    type: 'checkbox',
    help: 'Strongly discouraged; kind/dev clusters only.',
  },
]

/**
 * Invert a stored discriminated config's payload object into the flat `{ key: string }` values
 * a native connect form prefills from (the inverse of overlaying flat fields onto the config).
 * Secrets are skipped (write-only) and non-string scalars are stringified so `harnessPort`
 * (number) / `insecureSkipTlsVerify` (boolean) round-trip through the string-typed form.
 */
export function flattenConfigValues(
  payload: Record<string, unknown>,
  fields: ProviderConfigField[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fields) {
    if (field.secret) continue
    const value = payload[field.key]
    if (value === undefined || value === null) continue
    out[field.key] = typeof value === 'string' ? value : String(value)
  }
  return out
}

/**
 * Coerce an arbitrary id into a `<prefix><sanitized>` RFC1123 label (<=`max` chars,
 * lowercase alphanumeric/hyphens, starts/ends alphanumeric). Shared by the per-run
 * pod name and the per-PR environment namespace.
 */
export function k8sName(value: string, prefix: string, max = 63, fallback = 'x'): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const body = sanitized.slice(0, max - prefix.length).replace(/-+$/g, '') || fallback
  return `${prefix}${body}`
}

/**
 * Deterministic pod name for one CONTAINER KEY (kernel's `containerKeyForRef`): a run's steps
 * share one pod, EXCEPT that a step declaring a different executor image gets its own.
 *
 * It takes the key rather than the run id because that is the whole identity. A run's later
 * `ensurePod` 409s and re-attaches by design, which is right for two steps that want the same
 * image and silently wrong for two that do not: the second would run in the first's container,
 * on an image chosen before its variant was known. The key already qualifies the run id with
 * the variant, and `k8sName` folds its `:` into a hyphen like any other separator.
 */
export function podName(containerKey: string): string {
  return k8sName(containerKey, 'cf-run-', 63, 'run')
}

/** kube-apiserver root with any trailing slash stripped (shared by runner + env). */
export function apiBase(config: { apiServerUrl: string }): string {
  return config.apiServerUrl.trim().replace(/\/+$/, '')
}

/**
 * Turn a FAILED apiserver connection-test response into a human-readable, ACTIONABLE
 * message for the connect form (rendered verbatim). Shared by the Kubernetes runner +
 * environment `testConnection`s so the two can't drift.
 *
 * The two verdicts worth explaining are the auth ones — their raw body
 * (`{"kind":"Status",...,"message":"Unauthorized"}`) tells the operator nothing about what to
 * DO, and on a local k3s/k3d/kind cluster a 401 is by far the most common way a connection that
 * "used to work" stops working:
 *
 * - **401 Unauthorized** — the apiserver could not AUTHENTICATE the token (distinct from 403,
 *   which authenticates then denies on RBAC). The token is expired or the cluster no longer
 *   recognises it. Two "worked before, now 401" causes dominate on a local cluster: (a) the token
 *   aged out — a `kubectl create token` token is time-bound (default 1 hour) — and (b) the cluster
 *   was recreated/reinstalled, which rotates the ServiceAccount token-signing keypair and
 *   invalidates EVERY previously-issued token. A plain restart of a persistent cluster does NOT
 *   rotate those keys, so it doesn't invalidate tokens. Either way the fix is: mint a fresh token
 *   and paste it in.
 * - **403 Forbidden** — the token authenticated but the ServiceAccount lacks the RBAC for the
 *   probe (`operation`). Grant the role and re-test.
 *
 * Any other status keeps the raw `apiserver responded <status>: <body>` shape (an unexpected
 * apiserver error the operator wants verbatim).
 */
export function apiServerConnectionFailureMessage(
  status: number,
  body: string,
  ctx: { operation: string; namespace?: string },
): string {
  if (status === 401) {
    const ns = ctx.namespace ?? '<namespace>'
    return (
      'The apiserver rejected the ServiceAccount token (401 Unauthorized) — an authentication ' +
      'failure (the token is expired or no longer recognised by the cluster), not an RBAC one. ' +
      'If this worked before, on a local k3s/k3d/kind cluster it is usually because the token ' +
      'aged out (a `kubectl create token` token is short-lived — default 1 hour) or the cluster ' +
      'was recreated/reinstalled, which rotates its token-signing keys and invalidates every ' +
      'earlier token (a plain restart does not). Mint a fresh token and paste it into the token ' +
      `field, then test again: \`kubectl create token <serviceaccount> -n ${ns}\` (add ` +
      '`--duration=720h`, or create a long-lived kubernetes.io/service-account-token Secret, for ' +
      'a token that does not expire in an hour).'
    )
  }
  if (status === 403) {
    return (
      `The apiserver authenticated the token but denied the request (403 Forbidden): the ` +
      `ServiceAccount is not allowed to ${ctx.operation}` +
      (ctx.namespace ? ` in namespace '${ctx.namespace}'` : '') +
      `. Bind it to a Role/ClusterRole granting that access, then test again. Details: ${body}`
    )
  }
  return `apiserver responded ${status}: ${body}`
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

/**
 * Resolve the image variant a dispatch needs: the heavier UI image for `image:'ui'`, the
 * separate deploy-harness image for `image:'deploy'` (the container-backed Kubernetes render
 * path), else the default executor image.
 *
 * The two unconfigured variants are NOT symmetric, because what happens next differs. An
 * unconfigured `imageDeploy` keeps the pod on the executor image, which lacks the k8s CLIs, and
 * the deploy harness's own preflight then fails loudly naming them. An unconfigured `imageUi`
 * has no such backstop: the executor image runs the browser-driven tester perfectly happily
 * right up to the point it needs a browser, which is after the checkout, the install and the
 * model's first turns, and the report that comes back is an `abort` indistinguishable from an
 * app that would not boot. So `ui` is REFUSED here, naming the pool setting to fill in.
 */
export function resolveImage(
  config: KubernetesRunnerConfig,
  options?: RunnerDispatchOptions,
): string {
  if (options?.image === 'ui') {
    if (config.imageUi) return config.imageUi
    throw new UnavailableError(
      'This step runs on the UI-tester executor image (Playwright + a browser), but this ' +
        "runner pool configures no UI-tester image. Set the pool's `imageUi` to a published " +
        'cat-factory-executor-ui tag. Until then, drop the `tester-ui` step from the pipeline: ' +
        'the visual-confirmation gate still runs on screenshots a person uploads.',
      RUNNER_IMAGE_UNWIRED_REASON,
      { image: options.image, setting: 'imageUi' },
    )
  }
  if (options?.image === 'deploy' && config.imageDeploy) return config.imageDeploy
  const variant = options?.image
  if (!variant || isPlatformImageVariant(variant)) return config.image
  // A DEPLOYMENT's own variant. Unlike `deploy` above, which falls back to the executor image so
  // the deploy harness's own preflight reports the missing CLIs, nothing here knows what this one
  // carries: running the default would produce a job silently missing it.
  const mapped = config.imageVariants?.[variant]
  if (mapped) return mapped
  throw new UnavailableError(
    deploymentImageVariantMessage(variant, "the runner backend's `imageVariants`"),
    RUNNER_IMAGE_UNWIRED_REASON,
    { image: variant, setting: 'imageVariants' },
  )
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
    // A readiness probe on the harness's health endpoint so the pod's `Ready` condition —
    // which `waitForPodReady` blocks on before `dispatch` POSTs the job — reflects the
    // harness HTTP server actually LISTENING, not merely the container being Running.
    // Without it a slow-starting container (e.g. a cpu-throttled small instance) is marked
    // Ready before it binds the port, and the dispatch POST races into a not-yet-listening
    // server → the pod-proxy returns 502/503. The probe's failure budget covers a cold start.
    readinessProbe: {
      httpGet: { path: '/health', port },
      initialDelaySeconds: 1,
      periodSeconds: 2,
      timeoutSeconds: 2,
      failureThreshold: 30,
    },
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
export function labelValue(value: string): string {
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

/** Classify a Deployment's status JSON: rolled out, still progressing, or failed. */
export function classifyDeploymentReadiness(deployment: unknown): PodReadiness {
  const obj = deployment as
    | { spec?: { replicas?: number }; status?: Record<string, unknown> }
    | null
    | undefined
  const status = obj?.status
  if (!status) return 'pending'
  const desired = typeof obj?.spec?.replicas === 'number' ? obj.spec.replicas : 1
  const available = typeof status.availableReplicas === 'number' ? status.availableReplicas : 0
  // A zero-replica Deployment is intentionally scaled to nothing — treat as ready.
  if (desired === 0) return 'ready'
  if (available >= desired) return 'ready'
  const conditions = Array.isArray(status.conditions)
    ? (status.conditions as Array<Record<string, unknown>>)
    : []
  // `Progressing=False` with reason `ProgressDeadlineExceeded` is a terminal rollout failure.
  const progressing = conditions.find((c) => c.type === 'Progressing')
  if (progressing?.status === 'False' && progressing.reason === 'ProgressDeadlineExceeded') {
    return 'gone'
  }
  return 'pending'
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

/** Format a kubelet `reason`/`message` pair as `"<reason>: <message>"` (bare reason if no message). */
function joinReasonMessage(reason: string, message?: string): string {
  return message ? `${reason}: ${message}` : reason
}

/**
 * A pod-status string worth reporting, or undefined. A whitespace-only value is treated as
 * absent: the apiserver does write `message: ""`, and reporting it verbatim yields a line that
 * announces an account and then gives none.
 */
function readPodStatusText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * One pass over a pod's container statuses + conditions, yielding BOTH readings the readiness
 * loop needs so the pod JSON isn't walked (and the two views aren't kept in sync) twice:
 * - `terminal`: the first container whose `state.waiting.reason` is a known-unrecoverable
 *   start-up failure (bad image / config / crash loop), formatted as `"<reason>: <message>"`,
 *   else null — drives the transport's fail-fast path.
 * - `detail`: a short human-readable reason the pod isn't ready (the first waiting/terminated
 *   container reason, else a failed pod condition), '' when nothing useful is present — enriches
 *   an otherwise root-cause-less "terminated"/"not ready in time" error.
 */
export function analyzePodStatus(pod: unknown): { terminal: string | null; detail: string } {
  const status = statusOf(pod)
  let terminal: string | null = null
  let detail = ''
  for (const cs of containerStatuses(status)) {
    const waiting = waitingOf(cs)
    if (waiting?.reason) {
      const formatted = joinReasonMessage(waiting.reason, waiting.message)
      if (!detail) detail = formatted
      if (!terminal && TERMINAL_WAITING_REASONS.has(waiting.reason)) terminal = formatted
      continue
    }
    if (!detail) {
      const terminated = (cs.state as { terminated?: Record<string, unknown> } | undefined)
        ?.terminated
      if (terminated && typeof terminated.reason === 'string') {
        const msg = typeof terminated.message === 'string' ? terminated.message : undefined
        detail = joinReasonMessage(terminated.reason, msg)
      }
    }
  }
  if (!detail) {
    const conditions = Array.isArray(status?.conditions)
      ? (status.conditions as Array<Record<string, unknown>>)
      : []
    const failing = conditions.find(
      (c) => c.status === 'False' && typeof c.message === 'string' && c.message,
    )
    if (failing && typeof failing.message === 'string') {
      detail =
        typeof failing.reason === 'string'
          ? `${failing.reason}: ${failing.message}`
          : failing.message
    }
  }
  return { terminal, detail }
}

/**
 * A terminal, unrecoverable container start-up failure (a bad image / config / crash
 * loop), formatted as `"<reason>: <message>"`, or null when the pod is just still coming
 * up. Drives the transport's fail-fast path so a doomed pod surfaces its real reason
 * (e.g. `ImagePullBackOff: Back-off pulling image "…"`) at once instead of after the
 * 120s readiness timeout.
 */
export function classifyPodStartupFailure(pod: unknown): string | null {
  return analyzePodStatus(pod).terminal
}

/**
 * Best-effort short, human-readable detail of WHY a pod isn't ready — a waiting
 * container's `reason: message`, else the pod's failed/unready condition message — for
 * enriching an otherwise root-cause-less "terminated"/"not ready in time" error. Returns
 * '' when nothing useful is present.
 */
export function describePodStatus(pod: unknown): string {
  return analyzePodStatus(pod).detail
}

/** The `state.terminated` / `lastState.terminated` block, narrowed to the fields worth reporting. */
function terminatedOf(
  cs: Record<string, unknown>,
  key: 'state' | 'lastState',
): { exitCode?: number; signal?: number; reason?: string; message?: string } | undefined {
  const block = (cs[key] as { terminated?: Record<string, unknown> } | undefined)?.terminated
  if (!block) return undefined
  return {
    ...(typeof block.exitCode === 'number' ? { exitCode: block.exitCode } : {}),
    ...(typeof block.signal === 'number' ? { signal: block.signal } : {}),
    ...(typeof block.reason === 'string' ? { reason: block.reason } : {}),
    ...(typeof block.message === 'string' ? { message: block.message } : {}),
  }
}

/**
 * The POST-MORTEM of a pod whose harness stopped answering: how its containers ended, plus
 * whatever the pod itself says about being taken away. `''` when the pod status carries nothing.
 *
 * Distinct from {@link describePodStatus}, which explains a pod that has not come up YET and is
 * read while the readiness loop still hopes. This one is read after the job poll 404s, when the
 * only remaining question is what killed a workload that was running: `state.terminated` for a
 * container that ended and was left in place (`restartPolicy: Never`, so the pod is not
 * recreated), `lastState.terminated` for the run BEFORE a restart, and the pod-level
 * `reason`/`message` for the deaths the container never saw at all (a kubelet eviction under
 * node pressure names itself only there). Finding D1: this is the block the transport had the
 * `apiFetch` to read and never did.
 *
 * `OOMKilled` is the value that pays for the whole function: a memory-capped agent container is
 * otherwise indistinguishable from an unexplained vanishing.
 */
export function describePodTermination(pod: unknown): string {
  const status = statusOf(pod)
  const lines: string[] = []
  for (const cs of containerStatuses(status)) {
    // `state.terminated` is how it ended NOW; `lastState.terminated` is how the previous
    // incarnation ended. Prefer the current one, but report the previous when the container is
    // between lives (waiting to restart), which is where a crash loop's real cause sits.
    const terminated = terminatedOf(cs, 'state') ?? terminatedOf(cs, 'lastState')
    if (!terminated) continue
    const name = typeof cs.name === 'string' ? cs.name : 'container'
    const how = [
      terminated.reason,
      terminated.exitCode !== undefined ? `exit code ${terminated.exitCode}` : undefined,
      terminated.signal !== undefined ? `signal ${terminated.signal}` : undefined,
    ]
      .filter(Boolean)
      .join(', ')
    lines.push(
      `Container '${name}' terminated${how ? `: ${how}` : ''}` +
        `${terminated.message ? ` (${terminated.message})` : ''}`,
    )
  }
  // A pod-level reason (`Evicted`, `NodeAffinity`, `Shutdown`) is the kubelet's own account of
  // taking the pod away, which no container status reports: it is ADDITIONAL to the lines above,
  // never a substitute for them.
  //
  // The two halves are read INDEPENDENTLY. `message` is the kubelet's prose ("The node was low on
  // resource: ephemeral-storage", a preemption notice) and the apiserver does not guarantee the
  // machine-readable `reason` beside it; gating the prose on the code drops the only evidence a
  // pod carried and renders it as an empty detail, which is indistinguishable from a pod that
  // said nothing at all.
  const reason = readPodStatusText(status?.reason)
  const message = readPodStatusText(status?.message)
  if (reason) lines.push(`Pod ${joinReasonMessage(reason, message)}`)
  else if (message) lines.push(`Pod reports: ${message}`)
  return lines.join('\n')
}

/**
 * Whether a pod's workload EXITED CLEANLY, i.e. every container that has ended reports exit code
 * 0 and no signal. On a runner pod, whose only workload is the executor-harness, that means the
 * harness was SHUT DOWN while the job it was serving was still in flight, rather than crashing or
 * being reclaimed. False for everything else: a non-zero exit, a signal, a pod nothing terminated,
 * and a pod whose kubelet reports its OWN reason for taking it away (`Evicted`, `Shutdown`,
 * `NodeAffinity`), which is an eviction whatever the container managed to report on the way out.
 *
 * `restartPolicy: Never` is what makes this readable at all: the pod object outlives the workload
 * until `release` deletes it, so the poll that finds the job gone can still ask how it ended. A pod
 * already deleted or garbage-collected answers false, because an absent account is not a zero (the
 * same rule the Apple `container` runtime falls under locally).
 */
export function podExitedCleanly(pod: unknown): boolean {
  const status = statusOf(pod)
  if (readPodStatusText(status?.reason)) return false
  let ended = 0
  for (const cs of containerStatuses(status)) {
    // `state.terminated` only: `lastState` is a PREVIOUS incarnation, and how an earlier life
    // ended says nothing about the exit that just stopped serving this job.
    const terminated = terminatedOf(cs, 'state')
    if (!terminated) continue
    ended += 1
    if (terminated.exitCode !== 0 || terminated.signal !== undefined) return false
  }
  return ended > 0
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
  // A bad/unsupported URL is a caller-input error, so throw ValidationError (→ 422 with
  // the actionable reason) rather than a plain Error (→ a generic 500 that swallows it);
  // the connect form relies on the message. Shared by the env + runner-pool backends.
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ValidationError(`Invalid Kubernetes apiserver URL: ${rawUrl}`)
  }
  if (url.protocol !== 'https:') {
    throw new ValidationError('Kubernetes apiserver URL must use https.')
  }
  if (isCloudMetadataHost(url.hostname)) {
    throw new ValidationError(
      'Kubernetes apiserver URL must not target the cloud metadata endpoint.',
    )
  }
}

/**
 * Reject a config that carries custom TLS trust material (a private CA / insecure-skip)
 * on a runtime that can't honor it. Custom TLS is honored only on a runtime with undici
 * (Node/local); the Cloudflare Worker sets `customTlsSupported: false`, so we fail up
 * front here instead of letting the connection save and then die at every dispatch.
 * Shared by the Kubernetes runner + environment backends.
 */
export function assertCustomTlsSupported(
  config: { caCertPem?: string; insecureSkipTlsVerify?: boolean },
  opts?: { customTlsSupported?: boolean },
): void {
  const needsCustomTls = !!config.caCertPem || !!config.insecureSkipTlsVerify
  if (needsCustomTls && opts?.customTlsSupported === false) {
    // Caller-input error (a config this runtime can't honor) → ValidationError (422 with
    // the reason), not a plain Error (a generic 500 the connect form can't surface).
    throw new ValidationError(
      'This runtime cannot verify a custom CA / skip TLS for the Kubernetes apiserver ' +
        '(it requires the Node runtime). Use a publicly-trusted apiserver certificate, or ' +
        'run this workspace on the Node/local deployment.',
    )
  }
}
