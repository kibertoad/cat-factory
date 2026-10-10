import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { VcsPatConnectionService } from '@cat-factory/integrations'
import { vcsConnectController } from './VcsConnectController.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// The connect-capability route is what stops the SPA rendering a connect surface the deployment
// can't serve (an App picker with no App, a PAT box with no connect service). Its whole contract
// is the mapping from what the facade wired to what it advertises, so that mapping is asserted
// directly here — the shared HTTP layer computes it identically on every runtime.

function appWith(container: Partial<ServerContainer>) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container as ServerContainer)
    await next()
  })
  app.route('/workspaces/:workspaceId', vcsConnectController())
  return app
}

const withGithub = (enabled: boolean) =>
  ({
    config: { github: { enabled } },
    // The hosts the facade resolved, the same value a connection carries once bound.
    vcsWebUrls: { github: 'https://github.com', gitlab: 'https://gitlab.acme.dev' },
  }) as ServerContainer
const patService = (provider: 'github' | 'gitlab') =>
  ({ provider }) as unknown as VcsPatConnectionService

async function options(container: Partial<ServerContainer>) {
  const res = await appWith(container).request('/workspaces/ws-1/vcs/connect-options')
  expect(res.status).toBe(200)
  return (await res.json()).options
}

describe('vcsConnectController', () => {
  it('advertises the GitHub App connect only when the App is configured AND the module built', async () => {
    expect(await options({ ...withGithub(true), github: {} as never })).toEqual([
      { provider: 'github', method: 'app', webUrl: 'https://github.com' },
    ])
    // A GitLab-only deployment still builds the `github` module (with the GitLab client), so the
    // module's presence alone must NOT advertise an installable App.
    expect(await options({ ...withGithub(false), github: {} as never })).toEqual([])
    // Configured but unbuilt (a missing key) is likewise not installable.
    expect(await options(withGithub(true))).toEqual([])
  })

  it('advertises the PAT connect for the provider the wired service names', async () => {
    expect(
      await options({ ...withGithub(false), vcsConnectionService: patService('gitlab') }),
    ).toEqual([{ provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' }])
  })

  it('advertises both when a deployment serves an App and a PAT connect', async () => {
    expect(
      await options({
        ...withGithub(true),
        github: {} as never,
        vcsConnectionService: patService('gitlab'),
      }),
    ).toEqual([
      { provider: 'github', method: 'app', webUrl: 'https://github.com' },
      { provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' },
    ])
  })

  // The host rides the OPTION because the surfaces that need it (the PAT box's token link,
  // bootstrap's create-repository button) render before anything is connected. A deployment
  // whose API base does not invert to a host says so, and those surfaces drop the affordance
  // rather than sending the user to the provider's public instance.
  it('reports a null host for a provider the facade resolved none for', async () => {
    expect(
      await options({
        config: { github: { enabled: false } },
        vcsWebUrls: {},
        vcsConnectionService: patService('gitlab'),
      } as unknown as ServerContainer),
    ).toEqual([{ provider: 'gitlab', method: 'pat', webUrl: null }])
  })

  it('reports nothing connectable on a deployment with neither', async () => {
    expect(await options(withGithub(false))).toEqual([])
  })
})
