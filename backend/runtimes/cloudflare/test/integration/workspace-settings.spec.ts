import { defineWorkspaceSettingsSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1WorkspaceSettingsRepository } from '../../src/infrastructure/repositories/D1WorkspaceSettingsRepository'

// Cross-runtime parity for the per-workspace runtime-settings store against the Worker's real
// D1 repository, inside workerd. The Node service runs the identical suite over its own Postgres
// table — together they mandate the two stores behave the same.
defineWorkspaceSettingsSuite('cloudflare', () => new D1WorkspaceSettingsRepository({ db: env.DB }))
