import { defineResearchPersistenceSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import {
  D1FindingsRevisionRepository,
  D1FindingsStoragePolicyRepository,
  D1ResearchDefinitionRepository,
  D1ResearchProjectRepository,
} from '../../src/infrastructure/repositories/D1ResearchRepositories'
import { D1BlockRepository } from '../../src/infrastructure/repositories/D1BlockRepository'
import { D1ProjectRepository } from '../../src/infrastructure/repositories/D1ProjectRepository'
import { D1WorkspaceRepository } from '../../src/infrastructure/repositories/D1WorkspaceRepository'

// Research persistence against the Worker's real D1, inside workerd. The Node facade runs the
// identical suite over Postgres.
defineResearchPersistenceSuite('cloudflare', () => ({
  definitions: new D1ResearchDefinitionRepository({ db: env.DB }),
  projects: new D1ResearchProjectRepository({ db: env.DB }),
  revisions: new D1FindingsRevisionRepository({ db: env.DB }),
  policies: new D1FindingsStoragePolicyRepository({ db: env.DB }),
  board: {
    workspaces: new D1WorkspaceRepository({ db: env.DB }),
    blocks: new D1BlockRepository({ db: env.DB }),
    projects: new D1ProjectRepository({ db: env.DB }),
  },
}))
