import { defineDirectoryFeedSuite, defineDirectoryWebhookSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1DirectoryRepository } from '../../src/infrastructure/repositories/D1DirectoryRepository'
import { D1DirectoryWebhookRepository } from '../../src/infrastructure/repositories/D1DirectoryWebhookRepository'
import { D1MembershipRepository } from '../../src/infrastructure/repositories/D1MembershipRepository'
import { D1RepoProjectionRepository } from '../../src/infrastructure/repositories/D1RepoProjectionRepository'
import { D1UserRepository } from '../../src/infrastructure/repositories/D1UserRepository'
import { D1WorkspaceMemberRepository } from '../../src/infrastructure/repositories/D1WorkspaceMemberRepository'
import { D1WorkspaceRepository } from '../../src/infrastructure/repositories/D1WorkspaceRepository'

// The directory change feed against the Worker's real D1 repositories inside workerd. The Node
// facade runs the identical suite over Postgres, where the ordering guarantee rests on an advisory
// lock rather than SQLite's single writer.
defineDirectoryFeedSuite('cloudflare', () => {
  const db = env.DB
  return {
    users: new D1UserRepository({ db }),
    memberships: new D1MembershipRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
    workspaceMembers: new D1WorkspaceMemberRepository({ db }),
    repos: new D1RepoProjectionRepository({ db }),
    changes: new D1DirectoryRepository({ db }),
  }
})

defineDirectoryWebhookSuite('cloudflare', () => new D1DirectoryWebhookRepository({ db: env.DB }))
