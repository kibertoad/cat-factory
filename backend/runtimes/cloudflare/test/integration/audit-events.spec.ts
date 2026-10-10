import { defineAuditEventSuite, defineSessionGenerationSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AuditEventRepository } from '../../src/infrastructure/repositories/D1AuditEventRepository'
import { D1UserRepository } from '../../src/infrastructure/repositories/D1UserRepository'

// Cross-runtime parity for the append-only account audit log against the Worker's real D1
// repository in its SEPARATE database (the AUDIT_DB binding), inside workerd. The Node service
// runs the identical suite over its own `audit` Postgres schema; together they mandate the two
// stores behave the same.
defineAuditEventSuite('cloudflare', () => new D1AuditEventRepository({ db: env.AUDIT_DB }))

// The session-generation column: the other half of the same enterprise-offboarding story (the
// audit log records a revocation, the generation performs it). Against the MAIN db, not AUDIT_DB —
// it lives on `users`, where the login path reads it.
defineSessionGenerationSuite('cloudflare', () => new D1UserRepository({ db: env.DB }))
