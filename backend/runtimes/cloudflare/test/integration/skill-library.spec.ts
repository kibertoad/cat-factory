import { defineSkillLibrarySuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AccountSkillRepository } from '../../src/infrastructure/repositories/D1AccountSkillRepository'
import { D1SkillSourceRepository } from '../../src/infrastructure/repositories/D1SkillSourceRepository'
import { D1GitHubInstallationRepository } from '../../src/infrastructure/repositories/D1GitHubInstallationRepository'
import { D1WorkspaceRepository } from '../../src/infrastructure/repositories/D1WorkspaceRepository'

// Cross-runtime parity for the repo-sourced Claude Skills library against the Worker's
// real D1 repositories, inside workerd. The Node service runs the identical suite over
// its own Postgres tables — together they mandate the two stores behave the same.
defineSkillLibrarySuite('cloudflare', () => ({
  skillSources: new D1SkillSourceRepository({ db: env.DB }),
  accountSkills: new D1AccountSkillRepository({ db: env.DB }),
  installations: new D1GitHubInstallationRepository({ db: env.DB }),
  workspaces: new D1WorkspaceRepository({ db: env.DB }),
}))
