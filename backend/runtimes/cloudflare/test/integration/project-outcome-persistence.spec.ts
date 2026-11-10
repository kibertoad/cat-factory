import { defineProjectOutcomePersistenceSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1BlockRepository } from '../../src/infrastructure/repositories/D1BlockRepository'
import {
  D1OutcomeStoragePolicyRepository,
  D1ProjectDefinitionRepository,
  D1ProjectRecordRepository,
} from '../../src/infrastructure/repositories/D1ProjectOutcomeRepositories'
import { D1ProjectRepository } from '../../src/infrastructure/repositories/D1ProjectRepository'
import { D1WorkspaceRepository } from '../../src/infrastructure/repositories/D1WorkspaceRepository'

// Project definition and outcome persistence against the Worker's real D1, inside workerd. The
// Node facade runs the identical suite over Postgres.
defineProjectOutcomePersistenceSuite('cloudflare', () => ({
  definitions: new D1ProjectDefinitionRepository({ db: env.DB }),
  records: new D1ProjectRecordRepository({ db: env.DB }),
  policies: new D1OutcomeStoragePolicyRepository({ db: env.DB }),
  board: {
    workspaces: new D1WorkspaceRepository({ db: env.DB }),
    blocks: new D1BlockRepository({ db: env.DB }),
    projects: new D1ProjectRepository({ db: env.DB }),
  },
}))
