import {
  composePostMortem,
  type ConnectionTestResult,
  connectionFailureResult,
  CONTAINER_EVICTION_ERROR,
  harnessDispatchError,
  type KubernetesRunnerConfig,
  readRunnerDispatchAck,
  type RunnerDispatchAck,
  type RunnerDispatchKind,
  type RunnerDispatchOptions,
  type RunnerJobRef,
  type RunnerJobStopOutcome,
  type RunnerJobView,
  type RunnerTransport,
  type SecretResolver,
} from '@cat-factory/kernel'
import {
  KubernetesApiClient,
  type KubernetesTokenProvider,
  safeText,
} from './KubernetesApiClient.js'
import {
  analyzePodStatus,
  apiBase,
  apiServerConnectionFailureMessage,
  buildPodManifest,
  classifyPodReadiness,
  describePodTermination,
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

// The eviction marker the engine classifies (job.logic `isContainerEvictionError`): a 404 from
// the proxy means the pod vanished (deleted/crashed/evicted). A poll returns it alongside the
// structured `RunnerJobView.evicted: 'crash'` field (the primary signal); this string stays the
// fallback older consumers match, and it is ALSO the readiness-throw marker in `waitForPodReady`
// below (a dispatch-time throw carries no view, so it rides the string channel only). The
// wording is kernel's (`CONTAINER_EVICTION_ERROR`) because it is a cross-transport contract.
const EVICTION_ERROR = CONTAINER_EVICTION_ERROR

const DISPATCH_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000
// A stop WAITS by design: the harness holds the response until the aborted job has actually
// settled (up to its own ~6s force-kill window), because the caller's question is whether the
// agent is still running, not whether a signal was sent.
const STOP_TIMEOUT_MS = 30_000
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
  /** Backend id recorded in run diagnostics (self-hosted runner pool on Kubernetes). */
  readonly backend = 'runner-pool'
  private readonly client: KubernetesApiClient

  constructor(
    private readonly config: KubernetesRunnerConfig,
    resolveSecret: SecretResolver,
    /**
     * Optional async token source forwarded to the apiserver client. Omitted for the native
     * Kubernetes backend (static ServiceAccount token); supplied by the EKS backend so the
     * SAME transport drives an EKS apiserver behind a minted, short-lived IAM token.
     */
    tokenProvider?: KubernetesTokenProvider,
  ) {
    this.client = new KubernetesApiClient(
      config,
      resolveSecret,
      KUBERNETES_TOKEN_KEY,
      tokenProvider,
    )
  }

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
    options?: RunnerDispatchOptions,
  ): Promise<RunnerDispatchAck | undefined> {
    const name = podName(ref.runId)
    await this.ensurePod(name, ref.runId, options)
    await this.waitForPodReady(name)
    const res = await this.proxyFetch('POST', name, '/jobs', { ...spec, kind }, DISPATCH_TIMEOUT_MS)
    if (!res.ok) {
      // Structured DispatchError (carrying the HTTP status) so consumers classify by field, not
      // regex; a 404 on the harness /jobs route elaborates to the stale-image republish remedy.
      throw harnessDispatchError({
        label: 'Container',
        status: res.status,
        body: await safeText(res),
      })
    }
    // This transport POSTs to the harness ITSELF (through the apiserver pod-proxy), so the
    // acceptance body it gets back IS the handshake, unlike a manifest-driven pool, which sees
    // only whatever its own scheduler chose to return. Dropping it here would leave every k8s/EKS
    // deployment permanently `unknown`: warning on each capability dispatch against an image that
    // is in fact current, and unable to ever refuse a genuinely blind one.
    return readRunnerDispatchAck(await safeJson(res))
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
      // forgotten job. Report it as the eviction the engine recovers from — the structured
      // `evicted: 'crash'` field is the primary signal; the string suffix is the fallback.
      //
      // The pod OBJECT usually outlives the workload (`restartPolicy: Never` leaves a Failed
      // pod in place until `release` deletes it), so this is the one moment its termination
      // state is still readable. The post-mortem never changes the verdict, and never fails
      // the poll: a run that lost its container must still be failed, cause or no cause.
      const detail = await this.podPostMortem(name)
      return {
        state: 'failed',
        error: EVICTION_ERROR,
        evicted: 'crash',
        ...(detail ? { detail } : {}),
      }
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

  /**
   * Stop ONE job and confirm it. Always answers `stopped`: the graceful path aborts that job at
   * the harness through the pod-proxy and waits for it to settle, and anything else escalates to
   * deleting the pod, which stops everything in it.
   *
   * The pod is per-RUN, so the escalation costs the rest of the run, which is exactly the trade
   * the only caller has already made by failing it. A bare Pod is not garbage-collected either,
   * so a stop that gave up here would leak the pod as well as the agent.
   */
  async stopJob(ref: RunnerJobRef): Promise<RunnerJobStopOutcome> {
    const name = podName(ref.runId)
    const res = await this.proxyFetch(
      'DELETE',
      name,
      `/jobs/${encodeURIComponent(ref.jobId)}`,
      undefined,
      STOP_TIMEOUT_MS,
    )
    if (res.ok) {
      const body = (await safeJson(res)) as { state?: unknown } | undefined
      if (body?.state !== 'running') return 'stopped'
    }
    await this.release(ref)
    return 'stopped'
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
        message: apiServerConnectionFailureMessage(res.status, await safeText(res), {
          operation: 'list pods',
          namespace: this.config.namespace,
        }),
      }
    } catch (err) {
      // Nothing answered, so there is no status to map. The real cause is buried in the thrown
      // error's `.cause` chain, which reads as a bare "fetch failed" if taken at face value.
      return connectionFailureResult(err, {
        subject: 'the Kubernetes apiserver',
        target: apiBase(this.config),
      })
    }
  }

  // --- internals ----------------------------------------------------------

  /**
   * What killed the run's pod, for the eviction `detail`, or undefined when nothing can be said.
   *
   * The pod is per-RUN, so whatever it reports is unambiguously this run's: none of the
   * shared-backend caution the local warm pool needs applies here.
   *
   * Never throws, and never returns silence for a failure to look. Three outcomes are three
   * different investigations and only one of them is "the container died": a pod that is GONE
   * from the apiserver was deleted or garbage-collected by something outside this run, and an
   * apiserver that would not answer means nobody looked at all. Reporting the last two as an
   * absent detail would make an unreachable control plane read exactly like a clean vanishing.
   */
  private async podPostMortem(name: string): Promise<string | undefined> {
    try {
      const res = await this.apiFetch('GET', podUrl(this.config, name), undefined, POLL_TIMEOUT_MS)
      if (res.status === 404) {
        return composePostMortem([
          `Runner pod '${name}' no longer exists: it was deleted or garbage-collected, so the ` +
            `kubelet's account of how it ended is gone with it.`,
        ])
      }
      if (!res.ok) {
        return composePostMortem([
          `Could not read runner pod '${name}' to explain the eviction: the apiserver answered ` +
            `HTTP ${res.status}. The pod's own termination state was not consulted.`,
        ])
      }
      // Scrubbed, because a kubelet `message` echoes the container's termination log, which is
      // agent-authored text landing on a surface a person reads.
      return composePostMortem([describePodTermination(await res.json())])
    } catch (error) {
      // The cause goes into PROSE on the run rather than into log fields, so it is the message
      // itself that is wanted here, not `describeError`'s field pair; `composePostMortem` applies
      // the same scrub that helper would have.
      const cause = error instanceof Error ? error.message : String(error)
      return composePostMortem([
        `Could not read runner pod '${name}' to explain the eviction: ${cause}. ` +
          `The pod's own termination state was not consulted.`,
      ])
    }
  }

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
        // One walk of the pod status yields both readings (fatal start-up reason + the
        // enrichment detail), so the JSON isn't parsed twice per poll.
        const { terminal: fatal, detail } = analyzePodStatus(pod)
        // Fail fast + NON-recoverably on a deterministic start-up failure (bad/unpullable
        // image, bad container config, crash loop): re-driving the same pod would just hang
        // the whole window again, so surface the real reason as a `dispatch` failure (the
        // message deliberately omits the "evicted or crashed" marker so the engine does NOT
        // treat it as recoverable). This is the K8s analogue of the local Docker fail-fast.
        if (fatal) {
          throw new Error(`Runner pod '${name}' failed to start: ${fatal}`)
        }
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

  private apiFetch(
    method: string,
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    return this.client.fetch(method, url, body, timeoutMs)
  }
}

/**
 * A response body as JSON, or undefined for anything unreadable. Never throws: both callers are
 * past the point where a parse failure should change the outcome (the job is accepted, or the
 * stop escalates), so an unreadable body degrades to "nothing reported".
 */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    // silent-catch-ok: an unreadable body IS the "nothing reported" answer both callers handle.
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
