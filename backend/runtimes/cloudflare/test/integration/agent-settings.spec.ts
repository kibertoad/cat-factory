import { defineAgentSettingsSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1WorkspaceAgentSettingsRepository } from '../../src/infrastructure/repositories/D1WorkspaceAgentSettingsRepository'

// Cross-runtime parity for the per-agent-kind generation-settings store against the Worker's real
// D1 repository, inside workerd. The Node service runs the identical suite over Postgres —
// together they mandate the two stores agree that an upsert REPLACES (this store's conflict
// resolves to an update, the deliberate opposite of the prompt log beside it), that the ceiling
// round-trips as a number, and that rows are workspace-scoped.
defineAgentSettingsSuite('cloudflare', () => new D1WorkspaceAgentSettingsRepository({ db: env.DB }))
