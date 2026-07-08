import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { EVICTION_ERROR } from './harnessHttp.js'

// NATIVE-MODE transport router (local facade, `LOCAL_NATIVE_AGENTS`): native mode runs the
// developer's OWN `claude` / `codex` CLI as a host process (no sandbox), which is only
// appropriate for the steps that actually use that ambient login. The executor flags such a
// step with `ambientAuth: true` on its job body; everything else (a proxy/`pi` model, or a
// non-native vendor reusing the claude-code harness) MUST still run in a sandboxed per-run
// container, exactly as the README promises ("proxy-only models still need the container
// path"). Previously native mode sent EVERY dispatch to the host process, silently running
// proxy-model steps unsandboxed.
//
// So this routes per JOB (not per run — a single run legitimately mixes an ambient Claude
// step with a proxy step): `ambientAuth` jobs → the host-process transport; the rest → the
// container transport (built lazily, so a native deployment that only runs Claude/Codex
// never needs LOCAL_HARNESS_IMAGE; a proxy step without an image fails loudly there). The
// chosen transport is remembered per ref so poll/release reach the same backend.

const refKey = (ref: RunnerJobRef): string => `${ref.runId}:${ref.jobId}`

export class NativeRoutingRunnerTransport implements RunnerTransport {
  /** ref → the transport that handled its dispatch, so poll/release hit the same backend. */
  private readonly routed = new Map<string, RunnerTransport>()

  constructor(
    /** Host-process transport for ambient (native CLI) steps — built lazily, cached. */
    private readonly ambient: () => RunnerTransport | Promise<RunnerTransport>,
    /** Per-run container transport for everything else — built lazily, cached (the
     * container transport resolves its pool config from the DB, so this may be async). */
    private readonly managed: () => RunnerTransport | Promise<RunnerTransport>,
  ) {}

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    const transport = await (spec.ambientAuth === true ? this.ambient() : this.managed())
    this.routed.set(refKey(ref), transport)
    await transport.dispatch(ref, spec, kind, options)
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    let transport = this.routed.get(refKey(ref))
    if (!transport) {
      transport = await this.recoverTransport()
      // No container leg configured (Claude/Codex-only native) ⇒ nothing could have survived;
      // report the eviction so the sweeper re-drives (an idempotent re-dispatch re-routes).
      if (!transport) return { state: 'failed', error: EVICTION_ERROR }
      // Remember the route so the follow-up polls hit the same backend with no rebuild.
      this.routed.set(refKey(ref), transport)
    }
    const view = await transport.poll(ref)
    // An evicted job never comes back on this transport — drop the route so the map can't
    // grow unboundedly on a long-lived dev server (a re-dispatch re-populates it anyway).
    if (view.state === 'failed' && view.error === EVICTION_ERROR) this.routed.delete(refKey(ref))
    // Stamp WHICH leg served the job (native host process vs. per-run container) so the run
    // diagnostics record the true backend — this router picks per job, so it can't declare a
    // single static `backend` the shared job client would stamp.
    return view.backend ? view : { ...view, backend: transport.backend }
  }

  async release(ref: RunnerJobRef): Promise<void> {
    // Prefer the remembered route; on an unknown ref (a cold release after a restart, e.g. the
    // run was cancelled before any poll re-routed it) fall back to the managed leg exactly as
    // poll() does — a survivor can only be a per-run container that leg re-finds by run-id
    // label, so tearing it down there beats no-oping and leaking a still-running container. The
    // release is terminal, so unlike poll() we don't persist the route.
    const transport = this.routed.get(refKey(ref)) ?? (await this.recoverTransport())
    this.routed.delete(refKey(ref))
    await transport?.release?.(ref)
  }

  /**
   * Build the managed (container) transport for a ref missing from the in-memory routing map — a
   * fresh process after a restart/durable replay. The ambient host process died WITH the old
   * parent, so a job that survived can only live on the container leg, which re-finds a per-run
   * container by its run-id label with no in-process state. Returns undefined when no container
   * leg can be built (Claude/Codex-only native), so the caller degrades to eviction / no-op.
   */
  private async recoverTransport(): Promise<RunnerTransport | undefined> {
    try {
      return await this.managed()
    } catch {
      return undefined
    }
  }
}
