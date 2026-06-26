import { defineProvisioningLogSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1ProvisioningLogRepository } from '../../src/infrastructure/repositories/D1ProvisioningLogRepository'

// Cross-runtime parity for the provisioning event log against the Worker's real D1
// repository in its SEPARATE database (the PROVISIONING_DB binding), inside workerd.
// The Node service runs the identical suite over its own Postgres schema — together
// they mandate the two separate stores behave the same.
defineProvisioningLogSuite(
  'cloudflare',
  // Bound in wrangler.toml (its own database + migrations), so present in tests.
  () => new D1ProvisioningLogRepository({ db: env.PROVISIONING_DB! }),
)
