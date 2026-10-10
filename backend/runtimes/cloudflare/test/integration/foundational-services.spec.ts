import { defineFoundationalServicesSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import {
  D1ApiContractRepository,
  D1FoundationalServiceRepository,
  D1FoundationalServiceSourceRepository,
} from '../../src/infrastructure/repositories/D1FoundationalServiceRepository'
import { D1ServiceCatalogConnectionRepository } from '../../src/infrastructure/repositories/D1ServiceCatalogConnectionRepository'

// Cross-runtime parity for the foundational-services catalog against the Worker's real D1
// repositories, inside workerd. The Node service runs the identical suite over its own Postgres
// tables — together they mandate the two stores behave the same.
defineFoundationalServicesSuite('cloudflare', () => ({
  services: new D1FoundationalServiceRepository({ db: env.DB }),
  contracts: new D1ApiContractRepository({ db: env.DB }),
  sources: new D1FoundationalServiceSourceRepository({ db: env.DB }),
  serviceCatalog: new D1ServiceCatalogConnectionRepository({ db: env.DB }),
}))
