import { defineMachineNodeSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1MachineNodeRepository } from '../../src/infrastructure/repositories/D1MachineNodeRepository'

// Cross-runtime parity for the machine-node roster + revocation tombstones (SEC-5)
// against the Worker's real D1 repository, inside workerd. The Node service runs the
// identical suite over its own Postgres table — together they mandate the two stores
// behave the same.
defineMachineNodeSuite('cloudflare', () => new D1MachineNodeRepository({ db: env.DB }))
