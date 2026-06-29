import type {
  ConnectionTestResult,
  KubernetesRunnerConfig,
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
  SecretResolver,
} from '@cat-factory/kernel'
import {
  apiBase,
  buildPodManifest,
  classifyPodReadiness,
  classifyPodStartupFailure,
  describePodStatus,
  KUBERNETES_TOKEN_KEY,
  podName,
  podUrl,
  podsUrl,
  proxyUrl,
} from './kubernetes.logic.js'

// Native Kubernetes runner transport (target k8s 1.35+). One bare Pod per RUN,
// named deterministically from `ref.runId`; every step of the run re-attaches to
// that pod by `ref.jobId` — mirroring CloudflareContainerTransport's per-run model
// and the harness's per-run-container assumption. The orchestrator reaches the
// per-pod executor-harness HTTP server through the kube-apiserver POD-PROXY
// subresource, so it needs only HTTPS to the apiserver (no in-cluster networking,
// no per-run Service/Ingress) and the full RunnerJobView fidelity is preserved
// verbatim — the harness is unchanged.
//
// Auth to the apiserver is a Bearer ServiceAccount token (secret key `apiToken`),
// needing RBAC `create/get/delete` on `pods` and `create/get` on `pods/proxy` in
// the namespace. The pod itself has no Service, so its harness is reachable only
// via the RBAC-gated proxy — no inbound harness shared secret is required.

// The eviction marker the engine classifies (job.logic `isContainerEvictionError`):
// a 404 from the proxy means the pod vanished (deleted/crashed/evicted).
const EVICTION_ERROR = 'Job not found (container evicted or crashed)'

const DISPATCH_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000
// Bounded readiness wait inside dispatch. The engine treats `dispatch` as blocking
// until the runner has accepted the job (a plain dispatch throw hard-fails the run as
// `failureKind: 'dispatch'`), exactly like the Cloudflare container backend, so we
// must wait here rather than fail fast. The window is generous enough to cover a cold
// first image pull in one shot; on a readiness failure we surface a RECOVERABLE
// eviction (see EVICTION_ERROR) so the durable driver re-drives — by then the pod is
// created (ensurePod 409s) and its image is cached, so the re-drive proceeds.
const READY_WAIT_MS = 120_000
const READY_POLL_INTERVAL_MS = 1_500

export class KubernetesRunnerTransport implements RunnerTransport {
  constructor(
    private readonly config: KubernetesRunnerConfig,
    private readonly resolveSecret: SecretResolver,
  ) {}

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    const name = podName(ref.runId)
    await this.ensurePod(name, ref.runId, options)
    await this.waitForPodReady(name)
    const res = await this.proxyFetch('POST', name, '/jobs', { ...spec, kind }, DISPATCH_TIMEOUT_MS)
    if (!res.ok) {
      throw new Error(`Container dispatch failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    const name = podName(ref.runId)
    const res = await this.proxyFetch(
      'GET',
      name,
      `/jobs/${encodeURIComponent(ref.jobId)}`,
      undefined,
      POLL_TIMEOUT_MS,
    )
    if (res.status === 404) {
      // The pod-proxy 404s when the pod is gone (deleted/crashed/evicted) — the
      // harness keeps a finished job's view, so a 404 is the pod vanishing, not a
      // forgotten job. Report it as the eviction the engine recovers from.
      return { state: 'failed', error: EVICTION_ERROR }
    }
    if (!res.ok) {
      throw new Error(`Container job poll failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    return (await res.json()) as RunnerJobView
  }

  /** Reclaim the run's pod (idempotent — a missing pod is a no-op). */
  async release(ref: RunnerJobRef): Promise<void> {
    const name = podName(ref.runId)
    const res = await this.apiFetch(
      'DELETE',
      podUrl(this.config, name),
      undefined,
      DISPATCH_TIMEOUT_MS,
    )
    // A 404 means the pod is already gone — idempotent success. Any other failure
    // (e.g. a 403 from a token lacking `delete`, or a transient 5xx) must NOT be
    // swallowed: a bare Pod (restartPolicy: Never, no owner ref / Job TTL) is not
    // garbage-collected, so a silently-dropped delete leaks the pod (and its node
    // slot) indefinitely. Throw so the caller's best-effort wrapper records it (the
    // LoggingRunnerTransport logs a `release` failure instead of a false success).
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `Failed to release runner pod '${name}' (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
  }

  /** Probe the apiserver with the configured token (lists pods; nothing created). */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const res = await this.apiFetch(
        'GET',
        `${podsUrl(this.config)}?limit=1`,
        undefined,
        DISPATCH_TIMEOUT_MS,
      )
      if (res.ok) {
        return {
          ok: true,
          message: `Reached ${apiBase(this.config)} (namespace ${this.config.namespace}).`,
        }
      }
      return {
        ok: false,
        message: `apiserver responded ${res.status}: ${await safeText(res)}`,
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  // --- internals ----------------------------------------------------------

  private async ensurePod(
    name: string,
    runId: string,
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    const manifest = buildPodManifest(this.config, runId, name, options)
    const res = await this.apiFetch('POST', podsUrl(this.config), manifest, DISPATCH_TIMEOUT_MS)
    // 409 AlreadyExists ⇒ the run's pod is already up (a later step or a replay):
    // idempotent re-attach, exactly like CloudflareContainerTransport.
    if (res.ok || res.status === 409) return
    throw new Error(`Failed to create runner pod (HTTP ${res.status}): ${await safeText(res)}`)
  }

  private async waitForPodReady(name: string): Promise<void> {
    const deadline = Date.now() + READY_WAIT_MS
    // Every readiness failure carries the eviction marker so the engine recovers it by
    // re-driving the step (the re-drive re-attaches to the existing pod, by then ready
    // / image-cached) instead of hard-failing the run on a cold pull or a transient
    // pod blip. See EVICTION_ERROR and job.logic `isContainerEvictionError`.
    const recoverable = (reason: string) => new Error(`${reason} (container evicted or crashed)`)
    // The latest pod-status detail seen (a waiting container's reason:message, a failed
    // condition, …), folded into the recoverable timeout so even a stuck-but-not-yet-terminal
    // pod surfaces SOMETHING actionable instead of a bare "not ready within 120000ms".
    let lastDetail = ''
    for (;;) {
      const res = await this.apiFetch('GET', podUrl(this.config, name), undefined, POLL_TIMEOUT_MS)
      if (res.status === 404) {
        throw recoverable(`Runner pod '${name}' vanished before it became ready`)
      }
      if (res.ok) {
        const pod = await res.json()
        // Fail fast + NON-recoverably on a deterministic start-up failure (bad/unpullable
        // image, bad container config, crash loop): re-driving the same pod would just hang
        // the whole window again, so surface the real reason as a `dispatch` failure (the
        // message deliberately omits the "evicted or crashed" marker so the engine does NOT
        // treat it as recoverable). This is the K8s analogue of the local Docker fail-fast.
        const fatal = classifyPodStartupFailure(pod)
        if (fatal) {
          throw new Error(`Runner pod '${name}' failed to start: ${fatal}`)
        }
        const detail = describePodStatus(pod)
        if (detail) lastDetail = detail
        const readiness = classifyPodReadiness(pod)
        if (readiness === 'ready') return
        if (readiness === 'gone') {
          throw recoverable(
            `Runner pod '${name}' terminated before serving${lastDetail ? ` (${lastDetail})` : ''}`,
          )
        }
      }
      if (Date.now() >= deadline) {
        throw recoverable(
          `Runner pod '${name}' not ready within ${READY_WAIT_MS}ms${lastDetail ? ` (last status: ${lastDetail})` : ''}`,
        )
      }
      await sleep(READY_POLL_INTERVAL_MS)
    }
  }

  private proxyFetch(
    method: string,
    name: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    return this.apiFetch(method, proxyUrl(this.config, name, path), body, timeoutMs)
  }

  private async apiFetch(
    method: string,
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const token = this.resolveSecret(KUBERNETES_TOKEN_KEY)
    if (!token)
      throw new Error(`Missing Kubernetes ServiceAccount token ('${KUBERNETES_TOKEN_KEY}')`)
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    }
    let payload: string | undefined
    if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
      payload = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    const init: RequestInit & { dispatcher?: unknown } = {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    }
    const dispatcher = await this.tlsDispatcher()
    if (dispatcher) init.dispatcher = dispatcher
    return fetch(url, init)
  }

  /**
   * Build the undici dispatcher carrying the cluster CA / insecure-skip flag, when
   * configured. A kube-apiserver usually presents a private CA, which `fetch` can't
   * verify without this. Loaded lazily (Node only) so the Worker bundle never pulls
   * in `undici`; on a runtime without it, a custom-CA/insecure config fails clearly.
   *
   * The Agent is cached at MODULE scope keyed by the CA/insecure pair, not per
   * instance: the wiring builds a fresh transport on every dispatch/poll resolve, so
   * a per-instance cache would create (and abandon) one Agent — a TLS connection pool
   * — per poll tick, defeating keep-alive and leaking sockets.
   */
  private async tlsDispatcher(): Promise<unknown> {
    if (!this.config.caCertPem && !this.config.insecureSkipTlsVerify) return undefined
    const key = `${this.config.insecureSkipTlsVerify ? 'insecure' : 'verify'}:${this.config.caCertPem ?? ''}`
    const existing = tlsDispatcherCache.get(key)
    if (existing) return existing
    // Variable specifier so bundlers don't statically resolve `undici`.
    const moduleName = 'undici'
    const undici = (await import(moduleName).catch(() => null)) as {
      Agent: new (opts: unknown) => unknown
    } | null
    if (!undici) {
      throw new Error(
        'Kubernetes custom CA / insecure TLS requires the Node runtime (undici is unavailable).',
      )
    }
    const agent = new undici.Agent({
      connect: {
        ca: this.config.caCertPem,
        rejectUnauthorized: !this.config.insecureSkipTlsVerify,
      },
    })
    tlsDispatcherCache.set(key, agent)
    return agent
  }
}

/** Module-scoped undici Agent cache, keyed by the CA/insecure pair (see tlsDispatcher). */
const tlsDispatcherCache = new Map<string, unknown>()

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return '(no body)'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
