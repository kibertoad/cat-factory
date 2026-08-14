import type { D1Database } from '@cloudflare/workers-types'
import type {
  LiveContainerRecord,
  LiveContainerStore,
} from '../containers/ContainerInstanceRegistry'

/**
 * A stored variant is read back VERBATIM, with no narrowing against a list of names this build
 * knows. The set is open (a deployment names its own images), so a row written by a build that
 * bound a variant this one does not is a container that still EXISTS and still has to be reaped:
 * dropping the name here would look it up in the default class, where `idFromName` hands back a
 * stub for a container that was never started and the kill reads as a success. Carrying it
 * through instead makes the reap fail loudly against a namespace nothing binds, which leaves the
 * row for the next pass and says which binding went missing.
 */
function storedImageVariant(value: string | null): string | undefined {
  return value?.trim() || undefined
}

/**
 * The live-container inventory over D1 (`live_containers`, migration 0022; `image` added in
 * 0094). `add` uses `ON CONFLICT(container_key) DO NOTHING` so a replayed dispatch preserves
 * the first `started_at`, the container's true age the reaper keys off.
 */
export class D1LiveContainerRepository implements LiveContainerStore {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async add(record: LiveContainerRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO live_containers (container_key, kind, workspace_id, image, started_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(container_key) DO NOTHING`,
      )
      .bind(
        record.containerKey,
        record.kind,
        record.workspaceId ?? null,
        record.image ?? null,
        record.startedAt,
      )
      .run()
  }

  async remove(containerKey: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM live_containers WHERE container_key = ?')
      .bind(containerKey)
      .run()
  }

  async listStartedBefore(epochMs: number): Promise<LiveContainerRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT container_key, kind, workspace_id, image, started_at FROM live_containers
         WHERE started_at < ?
         ORDER BY started_at`,
      )
      .bind(epochMs)
      .all<{
        container_key: string
        kind: string
        workspace_id: string | null
        image: string | null
        started_at: number
      }>()
    return (results ?? []).map((r) => ({
      containerKey: r.container_key,
      kind: r.kind,
      ...(r.workspace_id != null ? { workspaceId: r.workspace_id } : {}),
      // Narrowed against the variant vocabulary rather than cast: a row written by a build that
      // knew a variant this one does not must not send the reaper to a namespace resolver that
      // will throw on it, which would leave the leaked container alive AND the row behind.
      ...(storedImageVariant(r.image) ? { image: storedImageVariant(r.image) } : {}),
      startedAt: r.started_at,
    }))
  }
}
