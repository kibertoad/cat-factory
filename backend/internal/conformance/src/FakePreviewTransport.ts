import type { BuildPreviewJob } from '@cat-factory/orchestration'
import type { PreviewRef, PreviewTransport, PreviewView } from '@cat-factory/kernel'

// Deterministic fakes for the browsable-frontend-preview flow (slice 5c). The REAL preview
// transport is a per-runtime differentiator (local Docker/Apple), so the cross-runtime
// conformance suite drives the runtime-NEUTRAL half — the PreviewService lifecycle + its
// ephemeral `environments`-row persistence + the capability gate — against BOTH Postgres
// runtimes with these fakes injected (exactly as the FakeAgentExecutor stands in for a real
// container). It proves the service + the D1⇄Drizzle env-row parity, not the real container.

/**
 * A preview transport that comes up instantly at a fixed URL. `start`/`stop` are recorded no-ops;
 * `poll` reports the served app running at {@link url} once started, else `starting`.
 */
export class FakePreviewTransport implements PreviewTransport {
  readonly started: PreviewRef[] = []
  readonly stopped: PreviewRef[] = []
  private readonly live = new Set<string>()

  constructor(readonly url = 'http://preview.test:4173') {}

  private key(ref: PreviewRef): string {
    return `${ref.workspaceId}:${ref.frameId}`
  }

  async start(ref: PreviewRef): Promise<void> {
    this.started.push(ref)
    this.live.add(this.key(ref))
  }

  async poll(ref: PreviewRef): Promise<PreviewView> {
    return this.live.has(this.key(ref))
      ? { state: 'running', url: this.url }
      : { state: 'starting' }
  }

  async stop(ref: PreviewRef): Promise<void> {
    this.stopped.push(ref)
    this.live.delete(this.key(ref))
  }
}

/**
 * A preview job builder that returns a stub plan for any frame — the conformance suite injects it
 * (alongside {@link FakePreviewTransport}) so the preview lifecycle runs without GitHub. The real
 * repo/token/session resolution (`makePreviewJobBuilder`) is exercised by the server unit tests.
 */
export const fakeBuildPreviewJob: BuildPreviewJob = async ({ frameId }) => ({
  jobId: 'preview',
  spec: { jobId: 'preview', mode: 'preview', frameId },
  servePort: 4173,
})
