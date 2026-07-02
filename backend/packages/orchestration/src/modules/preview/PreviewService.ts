import type {
  Clock,
  EnvironmentRecord,
  EnvironmentRegistryRepository,
  IdGenerator,
  PreviewRef,
  PreviewTransport,
} from '@cat-factory/kernel'
import { PREVIEW_PROVISION_TYPE } from '@cat-factory/kernel'
import type { PreviewState } from '@cat-factory/contracts'

// The browsable frontend PREVIEW service (slice 5c of the frontend-preview initiative). It is
// the runtime-NEUTRAL half of the flow: it drives a {@link PreviewTransport} (the per-runtime
// container half — local Docker/Apple; the Worker never wires one) and persists the running
// preview like an ephemeral `environments` row keyed by the `frontend` frame, reusing the SAME
// registry table + soft-delete stop path the deployer envs use. A preview has NO provisioning
// provider, so `stop()` owns its teardown (transport stop + registry `softDelete`) directly
// rather than reusing `EnvironmentTeardownService` (which resolves a `provider.teardown`).

/** The dispatch-ready plan the facade's builder produces for a frame's preview. */
export interface PreviewJobPlan {
  /** The harness job id inside the preview container (constant per single-purpose preview). */
  jobId: string
  /** The full harness `mode: 'preview'` job body (repo/auth/frontend infra spec). */
  spec: Record<string, unknown>
  /** The in-container port the built app is served on (published to a host port by the transport). */
  servePort: number
}

/**
 * Build the harness preview job for a `frontend` frame — resolves the repo/token/session +
 * the frontend infra spec (build/serve/mock knobs, bindings → live env URLs or WireMock).
 * Facade-provided (server-layer seams live there); THROWS a domain error when the frame is
 * not a previewable `frontend` frame or has no connected repo.
 */
export type BuildPreviewJob = (input: {
  workspaceId: string
  frameId: string
}) => Promise<PreviewJobPlan>

export interface PreviewServiceDependencies {
  previewTransport: PreviewTransport
  buildPreviewJob: BuildPreviewJob
  environmentRegistryRepository: EnvironmentRegistryRepository
  idGenerator: IdGenerator
  clock: Clock
}

export class PreviewService {
  constructor(private readonly deps: PreviewServiceDependencies) {}

  /**
   * Start (or restart) the browsable preview for a `frontend` frame: supersede any prior
   * preview, persist a `provisioning` row keyed by the frame, and dispatch the long-lived
   * build+serve container. A build-time stand-up failure is recorded as a `failed` state
   * (returned, not thrown) — an invalid frame / missing repo throws (a request error).
   */
  async start(workspaceId: string, frameId: string): Promise<PreviewState> {
    const plan = await this.deps.buildPreviewJob({ workspaceId, frameId })

    // Supersede any prior preview for this frame (soft-delete its row); the transport replaces
    // the container on start, so no explicit prior stop is needed.
    const prior = await this.currentPreview(workspaceId, frameId)
    if (prior)
      await this.deps.environmentRegistryRepository.softDelete(workspaceId, prior.id, this.now())

    const now = this.now()
    const id = this.deps.idGenerator.next('prev')
    const record: EnvironmentRecord = {
      id,
      workspaceId,
      blockId: frameId,
      frameId,
      executionId: null,
      providerId: PREVIEW_PROVISION_TYPE,
      externalId: null,
      url: null,
      status: 'provisioning',
      accessCipher: null,
      provisionFieldsCipher: null,
      createdAt: now,
      // A preview has no TTL — it lives until an explicit stop, so it is never swept by the
      // expiry cron (which keys off `expiresAt`).
      expiresAt: null,
      lastError: null,
      deletedAt: null,
      provisionType: PREVIEW_PROVISION_TYPE,
      engine: PREVIEW_PROVISION_TYPE,
    }
    await this.deps.environmentRegistryRepository.insert(record)

    const ref: PreviewRef = { workspaceId, frameId }
    try {
      await this.deps.previewTransport.start(ref, plan.spec, plan.servePort)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.deps.environmentRegistryRepository.update(workspaceId, id, {
        status: 'failed',
        lastError: message,
      })
      return this.state(frameId, 'failed', { error: message })
    }
    return this.state(frameId, 'starting')
  }

  /**
   * The frame's current preview state. While the build is still in flight (`provisioning`) it
   * re-polls the transport so a completed / failed / vanished container is reflected + persisted.
   * A terminal `ready` / `failed` row and a `stopped` (no row) short-circuit without a transport
   * call — once served, the persisted host URL is authoritative (the container keeps serving; a
   * lost one is simply re-started), which also spares the transport a serve-port lookup it can
   * only satisfy within the starting process.
   */
  async get(workspaceId: string, frameId: string): Promise<PreviewState> {
    const row = await this.currentPreview(workspaceId, frameId)
    if (!row) return this.state(frameId, 'stopped')
    // A terminal `failed` row is authoritative — no transport call.
    if (row.status === 'failed') return this.rowState(row)

    let view
    try {
      view = await this.deps.previewTransport.poll({ workspaceId, frameId })
    } catch {
      // A transient poll error leaves the persisted state untouched (the SPA polls again).
      return this.rowState(row)
    }

    if (view.state === 'failed') {
      // Covers both a build that never came up (a `provisioning` row) AND a served preview whose
      // container has since vanished/been evicted (a `ready` row) — the transport reports either
      // as `failed`, so a dead preview stops reporting a stale, unreachable URL.
      const error = view.error ?? 'The preview failed'
      await this.deps.environmentRegistryRepository.update(workspaceId, row.id, {
        status: 'failed',
        lastError: error,
      })
      return this.state(frameId, 'failed', { error })
    }
    if (view.state === 'running' && view.url) {
      await this.deps.environmentRegistryRepository.update(workspaceId, row.id, {
        status: 'ready',
        url: view.url,
      })
      return this.state(frameId, 'ready', { url: view.url })
    }
    // The container is alive but the transport can't (re)confirm a URL — e.g. after a process
    // restart the served-app port lookup is only possible within the starting process. For an
    // already-`ready` row keep its authoritative persisted URL rather than demoting a healthy
    // preview to `starting`; a still-`provisioning` row simply stays `starting`.
    return this.rowState(row)
  }

  /** Stop the frame's preview: reclaim the container and tombstone the row. Idempotent. */
  async stop(workspaceId: string, frameId: string): Promise<PreviewState> {
    const row = await this.currentPreview(workspaceId, frameId)
    if (!row) return this.state(frameId, 'stopped')
    // Best-effort container reclaim; the tombstone is authoritative either way.
    await this.deps.previewTransport.stop({ workspaceId, frameId }).catch(() => undefined)
    await this.deps.environmentRegistryRepository.softDelete(workspaceId, row.id, this.now())
    return this.state(frameId, 'stopped')
  }

  /** The live preview row for a frame (the newest non-deleted `preview`-typed env), if any. */
  private async currentPreview(
    workspaceId: string,
    frameId: string,
  ): Promise<EnvironmentRecord | null> {
    const row = await this.deps.environmentRegistryRepository.getByBlock(workspaceId, frameId)
    // `getByBlock` returns the newest non-deleted env for the block id; guard on the preview
    // discriminator so a (hypothetical) provisioned env on the same block id is never mistaken
    // for a preview.
    return row && row.provisionType === PREVIEW_PROVISION_TYPE ? row : null
  }

  private rowState(row: EnvironmentRecord): PreviewState {
    if (row.status === 'ready') {
      return this.state(row.blockId ?? '', 'ready', { url: row.url ?? undefined })
    }
    if (row.status === 'failed') {
      return this.state(row.blockId ?? '', 'failed', { error: row.lastError ?? undefined })
    }
    return this.state(row.blockId ?? '', 'starting')
  }

  private state(
    frameId: string,
    status: PreviewState['status'],
    extra: { url?: string; error?: string } = {},
  ): PreviewState {
    return {
      frameId,
      status,
      ...(extra.url ? { url: extra.url } : {}),
      ...(extra.error ? { error: extra.error } : {}),
      updatedAt: this.now(),
    }
  }

  private now(): number {
    return this.deps.clock.now()
  }
}
