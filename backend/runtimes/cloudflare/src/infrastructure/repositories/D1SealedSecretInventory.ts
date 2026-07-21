import type {
  DropSealedSecretResult,
  SealedSecretInventory,
  SealedSecretRef,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// ADR 0026 D6.2/D6.3 — the D1 sealed-secret inventory (mirrors the Node Drizzle
// `DrizzleSealedSecretInventory`; keep the two in step). See that file for the source model:
//   - `environment_connection` (sealed `secrets_cipher`, `cat-factory:environments`) → drop =
//     soft-delete (NOT NULL column can't be nulled in place).
//   - `observability_connection` (sealed `credentials`, `cat-factory:observability`) → drop =
//     row delete.

const ENV_INFO = 'cat-factory:environments'
const OBS_INFO = 'cat-factory:observability'
const ENV_SOURCE = 'environment_connection'
const OBS_SOURCE = 'observability_connection'

interface EnvRow {
  workspace_id: string
  provision_type: string
  manifest_id: string
  provider_id: string | null
  backend_kind: string | null
  secrets_cipher: string
  created_at: number
}

interface ObsRow {
  workspace_id: string
  provider: string
  credentials: string
  updated_at: number
}

function envId(workspaceId: string, provisionType: string, manifestId: string): string {
  return [workspaceId, provisionType, manifestId].join('|')
}

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

export class D1SealedSecretInventory implements SealedSecretInventory {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listSealed(): Promise<SealedSecretRef[]> {
    const refs: SealedSecretRef[] = []

    const env = await this.db
      .prepare('SELECT * FROM environment_connections WHERE deleted_at IS NULL')
      .all<EnvRow>()
    for (const row of env.results ?? []) {
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

    const obs = await this.db.prepare('SELECT * FROM observability_connections').all<ObsRow>()
    for (const row of obs.results ?? []) {
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
        .prepare(
          `UPDATE environment_connections SET deleted_at = ?
           WHERE workspace_id = ? AND provision_type = ? AND manifest_id = ? AND deleted_at IS NULL`,
        )
        .bind(Date.now(), workspaceId, provisionType, manifestId)
        .run()
      return { dropped: (result.meta?.changes ?? 0) > 0 }
    }
    if (ref.source === OBS_SOURCE) {
      const result = await this.db
        .prepare('DELETE FROM observability_connections WHERE workspace_id = ?')
        .bind(ref.id)
        .run()
      return { dropped: (result.meta?.changes ?? 0) > 0 }
    }
    return { dropped: false }
  }
}
