import type {
  DropSealedSecretResult,
  SealedSecretInventory,
  SealedSecretRef,
} from '@cat-factory/kernel'
import { and, eq, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { environmentConnections, observabilityConnections } from '../../db/schema.js'

// ADR 0026 D6.2/D6.3 — the Drizzle/Postgres sealed-secret inventory (mirrors the D1
// `D1SealedSecretInventory`). It enumerates every sealed-at-rest credential across the sources
// this runtime knows so the drift sweep can attempt a decrypt of each, and drops a specific
// unrecoverable one. The two sources initially covered are the ones ADR 0026's incident named:
//
//   - `environment_connection` — one sealed `secrets_cipher` per (workspace, provision_type,
//     manifest_id), sealed under `cat-factory:environments`. Drop = soft-delete (tombstone), so
//     the connection is re-registered on re-entry (`secrets_cipher` is NOT NULL — it can't be
//     nulled in place).
//   - `observability_connection` — one sealed `credentials` per workspace, sealed under
//     `cat-factory:observability`. Drop = row delete (one sealed column, no tombstone).
//
// Adding a source is a change here + the D1 twin, never in the runtime-neutral sweep.

const ENV_INFO = 'cat-factory:environments'
const OBS_INFO = 'cat-factory:observability'
const ENV_SOURCE = 'environment_connection'
const OBS_SOURCE = 'observability_connection'

/** Encode an environment connection's composite key into an opaque `SealedSecretRef.id`. */
function envId(workspaceId: string, provisionType: string, manifestId: string): string {
  return [workspaceId, provisionType, manifestId].join('|')
}

/** Decode an env-connection `SealedSecretRef.id` back to its three key parts. */
function parseEnvId(id: string): {
  workspaceId: string
  provisionType: string
  manifestId: string
} {
  // workspaceId/provisionType are system slugs with no `|`; manifestId may contain one, so it
  // captures everything after the second delimiter — keeping the round-trip with `envId`'s
  // `join('|')` lossless even for a pipe-bearing manifestId (drop would otherwise miss the row).
  const parts = id.split('|')
  return {
    workspaceId: parts[0] ?? '',
    provisionType: parts[1] ?? '',
    manifestId: parts.slice(2).join('|'),
  }
}

export class DrizzleSealedSecretInventory implements SealedSecretInventory {
  constructor(
    private readonly db: DrizzleDb,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async listSealed(): Promise<SealedSecretRef[]> {
    const refs: SealedSecretRef[] = []

    const envRows = await this.db
      .select()
      .from(environmentConnections)
      .where(isNull(environmentConnections.deleted_at))
    for (const row of envRows) {
      refs.push({
        source: ENV_SOURCE,
        id: envId(row.workspace_id, row.provision_type, row.manifest_id),
        workspaceId: row.workspace_id,
        label: row.provider_id || row.backend_kind || row.provision_type,
        info: ENV_INFO,
        envelope: row.secrets_cipher,
        sealedAt: row.created_at,
      })
    }

    const obsRows = await this.db.select().from(observabilityConnections)
    for (const row of obsRows) {
      refs.push({
        source: OBS_SOURCE,
        id: row.workspace_id,
        workspaceId: row.workspace_id,
        label: row.provider,
        info: OBS_INFO,
        envelope: row.credentials,
        sealedAt: row.updated_at,
      })
    }

    return refs
  }

  async drop(ref: { source: string; id: string }): Promise<DropSealedSecretResult> {
    if (ref.source === ENV_SOURCE) {
      const { workspaceId, provisionType, manifestId } = parseEnvId(ref.id)
      const result = await this.db
        .update(environmentConnections)
        .set({ deleted_at: this.now() })
        .where(
          and(
            eq(environmentConnections.workspace_id, workspaceId),
            eq(environmentConnections.provision_type, provisionType),
            eq(environmentConnections.manifest_id, manifestId),
            isNull(environmentConnections.deleted_at),
          ),
        )
        .returning({ workspace_id: environmentConnections.workspace_id })
      return { dropped: result.length > 0 }
    }
    if (ref.source === OBS_SOURCE) {
      const result = await this.db
        .delete(observabilityConnections)
        .where(eq(observabilityConnections.workspace_id, ref.id))
        .returning({ workspace_id: observabilityConnections.workspace_id })
      return { dropped: result.length > 0 }
    }
    return { dropped: false }
  }
}
