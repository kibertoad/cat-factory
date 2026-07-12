import { Hono } from 'hono'
import { signerFor, type MachinePayload, TOKEN_AUDIENCE } from '../../auth/signing.js'
import type { AppEnv } from '../../http/env.js'

/**
 * The mothership-mode GitHub delegation API: `POST /internal/github/installation-token`.
 *
 * The mothership owns the GitHub App (its private key never reaches a laptop), but a
 * mothership-mode local node runs the agent containers and gate probes that must reach
 * GitHub — clone/push, CI check reads, merges, the RepoFiles branch ops. This endpoint
 * closes that gap the same way GitHub Apps hand credentials to workers everywhere: the
 * node presents its machine token and an installation id, and the mothership mints the
 * short-lived (~1h) INSTALLATION token for it. No long-lived credential and no App key
 * crosses the machine API — only the same scoped token GitHub itself hands any App
 * integration.
 *
 * Security mirrors `PersistenceController`: the machine-token audience pin runs FIRST
 * (a user session / ws ticket / container token can never reach the mint), then the
 * call is account-scoped — the installation must fan out to at least one workspace
 * owned by an account in the token's scope, resolved server-side exactly like the
 * persistence RPC's `workspace` rule. An unknown or out-of-scope installation is a 404
 * (no existence leak). `forceRefresh` passes through so the client can defeat the
 * mothership's in-memory token cache after a permission change on GitHub.
 *
 * Mounted on BOTH facades via the shared controller registration, so either a Node or
 * a Cloudflare deployment can serve it. A deployment that is not a mothership (no
 * `repositories` registry) or has no GitHub App (no `githubTokenDelegation` seam)
 * serves a 503 — after the auth check, so the machine gate is asserted uniformly.
 */
export function githubDelegationController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/internal/github/installation-token', async (c) => {
    const container = c.get('container')

    // Machine-token gate first: the endpoint's availability must not be probeable
    // without a valid token, and the shared conformance suite asserts the 403 on
    // facades that wire no GitHub App at all.
    const secret = container.config.auth.sessionSecret
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const payload = secret
      ? await signerFor(secret).verify<MachinePayload>(token, { aud: TOKEN_AUDIENCE.machine })
      : null
    if (!payload) {
      return c.json({ error: { code: 'forbidden', message: 'invalid machine token' } }, 403)
    }

    const registry = container.repositories
    const delegation = container.githubTokenDelegation
    if (!registry || !delegation) {
      return c.json(
        {
          error: {
            code: 'unavailable',
            message: 'GitHub token delegation is not enabled on this deployment',
          },
        },
        503,
      )
    }

    let body: { installationId?: unknown; forceRefresh?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: { code: 'validation', message: 'invalid request body' } }, 422)
    }
    const installationId = body?.installationId
    if (typeof installationId !== 'number' || !Number.isInteger(installationId)) {
      return c.json(
        { error: { code: 'validation', message: 'installationId (integer) is required' } },
        422,
      )
    }

    // Scope binding: an installation is reachable by this node iff it fans out to at
    // least one workspace whose owning account is in the token scope — the same
    // resolution `resolveRepoTarget` rides when the node reads the installation row
    // over the persistence RPC. Fail closed as 404 (no existence leak), including when
    // the mothership's own GitHub wiring lacks the resolver methods.
    const denied = c.json({ error: { code: 'not_found', message: 'Not found' } }, 404)
    const installations = registry.githubInstallationRepository
    const workspaces = registry.workspaceRepository
    if (
      typeof installations?.listWorkspacesForInstallation !== 'function' ||
      typeof workspaces?.accountOf !== 'function'
    ) {
      return denied
    }
    try {
      const workspaceIds = (await installations.listWorkspacesForInstallation(
        installationId,
      )) as string[]
      let inScope = false
      for (const workspaceId of workspaceIds ?? []) {
        const accountId = (await workspaces.accountOf(workspaceId)) as string | null | undefined
        if (typeof accountId === 'string' && payload.scope.accountIds.includes(accountId)) {
          inScope = true
          break
        }
      }
      if (!inScope) return denied

      const minted = await delegation.installationToken(installationId, {
        forceRefresh: body.forceRefresh === true,
      })
      return c.json({ token: minted }, 200)
    } catch {
      // Opaque 500 — never leak an internal error's message over the machine API.
      return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500)
    }
  })

  return app
}
