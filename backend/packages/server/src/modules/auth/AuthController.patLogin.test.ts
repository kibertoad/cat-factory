import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ConflictError, type LocalVcsSetup, type VcsProvider } from '@cat-factory/kernel'
import { authController } from './AuthController.js'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// The PAT-login route is where local mode's one token becomes BOTH the session and the credential
// the deployment operates with. That second half is the whole point of the flow (a developer who
// has just created a token must not be sent to `.env` and a restart), and it is a side effect the
// route performs on a capability only one facade wires — so it is asserted here rather than left
// to whichever runtime happens to exercise sign-in.

const IDENTITY = {
  provider: 'github' as const,
  externalId: '42',
  login: 'octocat',
  name: 'Octo Cat',
  avatarUrl: null,
  email: 'octo@example.com',
}

/** Records what was installed, and can refuse like the real (env-owned) facade does. */
function recordingSetup(options: { installable?: VcsProvider[]; refuse?: boolean } = {}) {
  const installed: { provider: VcsProvider; token: string; login?: string | null }[] = []
  const setup: LocalVcsSetup = {
    installable: () => options.installable ?? ['github', 'gitlab'],
    install: async (provider, token, opts) => {
      if (options.refuse) throw new ConflictError('GITHUB_PAT is set in this environment.')
      installed.push({ provider, token, login: opts?.login })
    },
  }
  return { setup, installed }
}

function appWith(container: Partial<ServerContainer>) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container as ServerContainer)
    await next()
  })
  app.route('/auth', authController())
  // Without this every refusal would read as a 500 (CLAUDE.md → "A controller REFUSES by throwing").
  app.onError(handleError)
  return app
}

function container(overrides: Partial<ServerContainer>): Partial<ServerContainer> {
  return {
    config: {
      localMode: { enabled: true },
      auth: { sessionTtlMs: 60_000, sessionSecret: 'x'.repeat(40), allowedLogins: [] },
    } as unknown as ServerContainer['config'],
    vcsIdentity: {
      github: { resolver: { resolveIdentity: async () => IDENTITY } },
      gitlab: { resolver: { resolveIdentity: async () => ({ ...IDENTITY, provider: 'gitlab' }) } },
    } as unknown as ServerContainer['vcsIdentity'],
    userService: {
      findOrCreateByIdentity: async () => ({ id: 'usr_1', name: 'Octo Cat', email: null }),
      // Every session mint stamps the user's current generation.
      sessionGeneration: async () => 0,
    } as unknown as ServerContainer['userService'],
    accountService: {
      ensurePersonalAccount: async () => undefined,
    } as unknown as ServerContainer['accountService'],
    ...overrides,
  }
}

const signIn = (app: Hono<AppEnv>, body: Record<string, unknown>) =>
  app.request('/auth/pat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /auth/pat — local-mode credential install', () => {
  it('adopts a pasted token as the deployment credential and signs the user in', async () => {
    const { setup, installed } = recordingSetup()
    const res = await signIn(appWith(container({ localVcsSetup: setup })), {
      provider: 'github',
      token: 'ghp_pasted',
    })
    expect(res.status).toBe(200)
    expect(installed).toEqual([{ provider: 'github', token: 'ghp_pasted', login: 'octocat' }])
  })

  it('never re-installs the deployment token on a ONE-CLICK sign-in', async () => {
    // No `token` in the body: the deployment's own configured token is used. Installing there
    // would re-write the credential with itself on every sign-in.
    const { setup, installed } = recordingSetup()
    const res = await signIn(
      appWith(
        container({
          localVcsSetup: setup,
          vcsIdentity: {
            github: {
              resolver: { resolveIdentity: async () => IDENTITY },
              configuredToken: () => 'ghp_env',
            },
          } as unknown as ServerContainer['vcsIdentity'],
        }),
      ),
      { provider: 'github' },
    )
    expect(res.status).toBe(200)
    expect(installed).toEqual([])
  })

  it('leaves a pasted token alone where the facade says it is not installable', async () => {
    // A HOSTED deployment wires no setup capability at all, and a local one whose `.env` owns the
    // credential reports nothing installable. In both, the pasted token is only ever an identity.
    const { setup, installed } = recordingSetup({ installable: [] })
    expect(
      (
        await signIn(appWith(container({ localVcsSetup: setup })), {
          provider: 'github',
          token: 'ghp_pasted',
        })
      ).status,
    ).toBe(200)
    expect(installed).toEqual([])
    expect(
      (
        await signIn(appWith(container({})), {
          provider: 'github',
          token: 'ghp_pasted',
        })
      ).status,
    ).toBe(200)
  })

  it('reports a refused install instead of handing out a session that cannot reach a repo', async () => {
    const { setup } = recordingSetup({ refuse: true })
    const res = await signIn(appWith(container({ localVcsSetup: setup })), {
      provider: 'github',
      token: 'ghp_pasted',
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('conflict')
  })
})
