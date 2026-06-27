import { definePasswordResetTokenSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1PasswordResetTokenRepository } from '../../src/infrastructure/repositories/D1PasswordResetTokenRepository'

// Cross-runtime parity for the password-reset token store against the Worker's real D1
// repository, inside workerd. The Node service runs the identical suite over its own
// Postgres table — together they mandate the two stores behave the same.
definePasswordResetTokenSuite(
  'cloudflare',
  () => new D1PasswordResetTokenRepository({ db: env.DB }),
)
