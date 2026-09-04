import { createGitHubRepoContract } from '@cat-factory/contracts'
import { requestByContract } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { handleError } from '../src/http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { githubController } from '../src/modules/github/GitHubController.js'

// What the CONTROLLER decides about creating a repository, as opposed to what the provisioning
// service decides (whether the installation may create one at all, in `provisioning.logic.test`):
// the SHAPE of the repository it asks for.
//
// One rule, and it is the kind that is invisible until two features meet. Every repository this
// endpoint creates exists to be bootstrapped into, and a `pull_request` bootstrap is opened
// BETWEEN two commits: it refuses a repository holding none. A create with no initial commit
// therefore made the modal refuse, at launch, the repository it had made for the user one click
// earlier. The other delivery loses nothing by it, since a force-pushed bootstrap replaces that
// commit's history outright.

function makeApp() {
  const provision = vi.fn(async () => ({
    status: 'created' as const,
    repo: {
      githubId: 1,
      owner: 'acme',
      name: 'payments',
      defaultBranch: 'main',
      private: true,
    },
  }))
  const container = {
    github: {
      provisioningService: { provision },
      installationService: {
        requireInstallation: vi.fn(async () => ({
          installationId: 42,
          accountLogin: 'acme',
        })),
      },
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    c.set('user', {
      id: 'usr_1',
      login: 'ada',
      name: null,
      avatarUrl: null,
      aud: 'session',
      exp: 0,
      gen: 0,
    })
    // The gate reads `permissions` as a Set, exactly as `loadWorkspaceAccess` publishes it.
    c.set('workspaceAccess', {
      role: 'admin',
      permissions: new Set(['integrations.manage']),
    } as never)
    await next()
  })
  app.route('/workspaces/:workspaceId', githubController())
  app.onError(handleError)
  return { app, provision }
}

describe('POST /workspaces/:workspaceId/github/repos', () => {
  it('asks for an initial commit, so the created repository can take a pull request', async () => {
    const { app, provision } = makeApp()
    const res = await requestByContract(app, createGitHubRepoContract, {
      pathPrefix: '/workspaces/ws_1',
      body: { name: 'payments', private: true, description: 'Payments service' },
    })
    expect(res.status).toBe(201)
    expect(provision).toHaveBeenCalledWith(42, {
      org: 'acme',
      name: 'payments',
      private: true,
      description: 'Payments service',
      autoInit: true,
    })
  })
})
