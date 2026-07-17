import { defineVcsProviderSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1GitHubInstallationRepository } from '../../src/infrastructure/repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from '../../src/infrastructure/repositories/D1RepoProjectionRepository'

// Cross-runtime parity for the `provider` VCS discriminator against the Worker's real D1
// projection tables, inside workerd. The Node service runs the identical suite over its own
// Postgres tables — together they mandate the two stores persist/read provider the same.
defineVcsProviderSuite('cloudflare', () => ({
  installations: new D1GitHubInstallationRepository({ db: env.DB }),
  repoProjection: new D1RepoProjectionRepository({ db: env.DB }),
}))
