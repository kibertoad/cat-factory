import { defineSealedSecretInventorySuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1SealedSecretInventory } from '../../src/infrastructure/repositories/D1SealedSecretInventory'

// Cross-runtime parity for the sealed-secret inventory (ADR 0026 D6.2/D6.3) against the Worker's
// real D1 store, inside workerd. The Node service runs the identical suite over Postgres —
// together they mandate the two inventories (and the drop remediation) behave the same.

defineSealedSecretInventorySuite('cloudflare', () => ({
  inventory: new D1SealedSecretInventory({ db: env.DB }),
  seedEnvConnection: async (row) => {
    await env.DB.prepare(
      `INSERT INTO environment_connections
         (workspace_id, provision_type, manifest_id, engine, backend_kind, provider_id, label,
          base_url, handler_json, secrets_cipher, created_at)
       VALUES (?, ?, ?, 'kubernetes', 'k8s', 'k8s', 'test', '', '{}', ?, ?)`,
    )
      .bind(row.workspaceId, row.provisionType, row.manifestId, row.secretsCipher, row.createdAt)
      .run()
  },
  seedObsConnection: async (row) => {
    await env.DB.prepare(
      `INSERT INTO observability_connections
         (workspace_id, provider, credentials, summary, created_at, updated_at)
       VALUES (?, ?, ?, '{}', ?, ?)`,
    )
      .bind(row.workspaceId, row.provider, row.credentials, row.updatedAt, row.updatedAt)
      .run()
  },
}))
