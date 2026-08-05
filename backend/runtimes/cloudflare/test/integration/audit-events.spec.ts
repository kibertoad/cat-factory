import { defineAuditEventSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AuditEventRepository } from '../../src/infrastructure/repositories/D1AuditEventRepository'

// Cross-runtime parity for the append-only account audit log against the Worker's real D1
// repository in its SEPARATE database (the AUDIT_DB binding), inside workerd. The Node service
// runs the identical suite over its own `audit` Postgres schema; together they mandate the two
// stores behave the same.
defineAuditEventSuite('cloudflare', () => new D1AuditEventRepository({ db: env.AUDIT_DB }))
