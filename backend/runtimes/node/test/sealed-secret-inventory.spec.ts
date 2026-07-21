import { defineSealedSecretInventorySuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleSealedSecretInventory } from '../src/repositories/drizzle/sealedSecretInventory.js'
import { environmentConnections, observabilityConnections } from '../src/db/schema.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the sealed-secret inventory (ADR 0026 D6.2/D6.3) against the Node
// facade's real Drizzle/Postgres store. The Cloudflare Worker runs the identical suite over D1,
// so the two inventories — and the drop remediation wired onto both — can't drift. CI provides
// Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineSealedSecretInventorySuite('node', () => ({
    inventory: new DrizzleSealedSecretInventory(db),
    seedEnvConnection: async (row) => {
      await db.insert(environmentConnections).values({
        workspace_id: row.workspaceId,
        provision_type: row.provisionType,
        manifest_id: row.manifestId,
        engine: 'kubernetes',
        backend_kind: 'k8s',
        provider_id: 'k8s',
        label: 'test',
        base_url: '',
        handler_json: '{}',
        secrets_cipher: row.secretsCipher,
        created_at: row.createdAt,
      })
    },
    seedObsConnection: async (row) => {
      await db.insert(observabilityConnections).values({
        workspace_id: row.workspaceId,
        provider: row.provider,
        credentials: row.credentials,
        summary: '{}',
        created_at: row.updatedAt,
        updated_at: row.updatedAt,
      })
    },
  }))
} else {
  describe.skip('[node] sealed-secret inventory (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
