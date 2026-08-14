import { getErrorMessage, getErrorReason, RUNNER_IMAGE_UNWIRED_REASON } from '@cat-factory/kernel'
import type { Clock, RunnerImageVariant } from '@cat-factory/kernel'
import type { ResolveRunContainerNamespace } from './runContainerNamespace'
import { logger } from '../observability/logger'

// The instance-level reaping registry. Per-run Cloudflare Containers are addressed
// by a Durable Object id derived from the job id; nothing enumerates the live ones,
// so every safety net keyed off the run record instead of the real inventory (see
// migration 0022). This registry IS that inventory: the Cloudflare transport
// records a container here on dispatch and removes it on release, and a cron reaper
// kills anything that outlived its legitimate maximum lifetime — through the same
// EXEC_CONTAINER binding that started it, needing no Cloudflare API token.

/** One live per-run container, as the registry records it. */
export interface LiveContainerRecord {
  /** The idFromName() argument (kernel's `containerKeyForRef`): the run id, variant-qualified. */
  containerKey: string
  /** The dispatch kind ('run' | 'blueprint' | 'bootstrap'); diagnostic only. */
  kind: string
  /** Owning workspace, when known (the transport seam carries only the job id). */
  workspaceId?: string
  /**
   * The executor image variant, which is WHICH CONTAINER CLASS holds this instance. Not
   * diagnostic: the reaper kills through a Durable Object namespace, and the key alone cannot
   * say which one, so a leaked UI-tester container would be looked up in the executor namespace,
   * where `idFromName` happily returns a stub for a container that never existed and the kill
   * reads as a success. Absent ⇒ the default executor class.
   */
  image?: RunnerImageVariant
  /** Epoch ms of the FIRST dispatch = the container's true age. */
  startedAt: number
}

/**
 * Persistence for the live-container inventory (the `live_containers` table). `add`
 * MUST preserve the earliest `startedAt` for a key (a replayed dispatch is a no-op)
 * so the recorded age is the container's true age.
 */
export interface LiveContainerStore {
  add(record: LiveContainerRecord): Promise<void>
  remove(containerKey: string): Promise<void>
  listStartedBefore(epochMs: number): Promise<LiveContainerRecord[]>
}

/**
 * Owns the per-run container namespace + the live-container inventory. It is the
 * single kill path for a container — `release` both SIGKILLs the instance (via the
 * Durable Object's `shutdown` RPC) and clears its inventory row — used by the
 * normal terminal-reclaim path (through the Cloudflare transport) and by the cron
 * reaper alike, so the two can never diverge.
 */
export class ContainerInstanceRegistry {
  constructor(
    /** Resolves the container class an image variant lives in, shared with the transport. */
    private readonly resolveNamespace: ResolveRunContainerNamespace,
    private readonly store: LiveContainerStore,
    private readonly clock: Clock,
  ) {}

  /**
   * Record a freshly-dispatched container in the inventory. Best-effort: a write
   * failure must never break the dispatch it is bookkeeping for, and the earliest
   * `startedAt` is preserved across replayed dispatches (so age stays truthful).
   */
  async register(record: {
    containerKey: string
    kind: string
    workspaceId?: string
    image?: RunnerImageVariant
  }): Promise<void> {
    try {
      await this.store.add({ ...record, startedAt: this.clock.now() })
    } catch (error) {
      logger.warn('container-registry: failed to record live container (continuing)', {
        containerKey: record.containerKey,
        kind: record.kind,
        image: record.image,
        err: getErrorMessage(error),
      })
    }
  }

  /**
   * Reclaim a container now and drop its inventory row — the single kill path.
   * Idempotent: `ExecutionContainer.shutdown` swallows "already gone", so this is a
   * no-op on a container that is already stopped. The row is removed only after the
   * SIGKILL resolves, so a (rare) transport-level failure leaves the row for the
   * reaper to retry rather than silently dropping a still-live container.
   */
  async release(containerKey: string, image?: RunnerImageVariant): Promise<void> {
    const namespace = this.resolveNamespace(image ?? 'default')
    await namespace.get(namespace.idFromName(containerKey)).shutdown()
    await this.store.remove(containerKey)
  }

  /**
   * The load-bearing backstop: kill every container whose first dispatch is older
   * than `epochMs` (its legitimate maximum lifetime has elapsed). With normal runs
   * self-reclaiming on their terminal path, a reaped container is a genuine LEAK, so
   * each kill is logged loudly. One wedged container never aborts the sweep — each
   * release is isolated. Returns how many were actually reaped, and how many the sweep
   * could not even address (see below).
   */
  async reapStaleBefore(epochMs: number): Promise<{ reaped: number; unreachable: number }> {
    const stale = await this.store.listStartedBefore(epochMs)
    let reaped = 0
    let unreachable = 0
    for (const record of stale) {
      logger.warn('container-reaper: killing leaked container past its max lifetime', {
        containerKey: record.containerKey,
        kind: record.kind,
        image: record.image,
        workspaceId: record.workspaceId,
        ageMs: this.clock.now() - record.startedAt,
      })
      try {
        await this.release(record.containerKey, record.image)
        reaped++
      } catch (error) {
        if (getErrorReason(error) === RUNNER_IMAGE_UNWIRED_REASON) {
          // The class this row's variant lives in is no longer BOUND (the binding was removed, or
          // the Worker rolled back past it), so there is no namespace to get a stub from and no
          // retry can produce one. Left in place the row re-throws on every pass for ever, which
          // is a permanent error rate that names nothing new and still never kills the container.
          // So it is dropped, and the fact the reaper cannot act on it is stated ONCE, loudly,
          // with the binding to restore.
          unreachable++
          logger.error(
            'container-reaper: cannot address a leaked container, its class is not bound',
            {
              containerKey: record.containerKey,
              image: record.image,
              workspaceId: record.workspaceId,
              err: getErrorMessage(error),
            },
          )
          await this.store.remove(record.containerKey)
          continue
        }
        // Leave the row in place so the next pass retries this one.
        logger.error('container-reaper: failed to kill leaked container (will retry next pass)', {
          containerKey: record.containerKey,
          err: getErrorMessage(error),
        })
      }
    }
    return { reaped, unreachable }
  }
}
