import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'

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

const EVICTION_ERROR = 'Job not found (container evicted or crashed)'

const refKey = (ref: RunnerJobRef): string => `${ref.runId}:${ref.jobId}`

export class NativeRoutingRunnerTransport implements RunnerTransport {
  /** ref → the transport that handled its dispatch, so poll/release hit the same backend. */
  private readonly routed = new Map<string, RunnerTransport>()

  constructor(
    /** Host-process transport for ambient (native CLI) steps — built lazily, cached. */
    private readonly ambient: () => RunnerTransport,
    /** Per-run container transport for everything else — built lazily, cached. */
    private readonly managed: () => RunnerTransport,
  ) {}

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    const transport = spec.ambientAuth === true ? this.ambient() : this.managed()
    this.routed.set(refKey(ref), transport)
    await transport.dispatch(ref, spec, kind, options)
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    // Unknown ref (a fresh process after a durable replay): report an eviction so the
    // sweeper re-drives — the re-dispatch (idempotent) re-populates the routing map.
    const transport = this.routed.get(refKey(ref))
    if (!transport) return { state: 'failed', error: EVICTION_ERROR }
    return transport.poll(ref)
  }

  async release(ref: RunnerJobRef): Promise<void> {
    const transport = this.routed.get(refKey(ref))
    this.routed.delete(refKey(ref))
    await transport?.release?.(ref)
  }
}
