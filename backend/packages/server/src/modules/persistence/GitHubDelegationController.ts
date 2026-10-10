import { Hono } from 'hono'
import type { GitHubInstallation, GitHubRepo } from '@cat-factory/kernel'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import { getErrorMessage, RateLimitedError, UnavailableError } from '@cat-factory/kernel'

/**
 * The mothership-mode GitHub delegation API: `POST /internal/github/installation-token`.
 *
 * The mothership owns the GitHub App (its private key never reaches a laptop), but a
 * mothership-mode local node runs the agent containers and gate probes that must reach
 * GitHub — clone/push, CI check reads, merges, the RepoFiles branch ops. This endpoint
 * closes that gap the same way GitHub Apps hand credentials to workers everywhere: the
 * node presents its machine token and an installation id, and the mothership mints the
 * short-lived (~1h) INSTALLATION token for it. No long-lived credential and no App key
 * crosses the machine API — only a scoped short-lived token.
 *
 * Security mirrors `PersistenceController`, then goes further:
 * - The machine-token audience pin runs FIRST (a user session / ws ticket / container
 *   token can never reach the mint), before even the availability probe.
 * - A fixed-window rate limit keyed by the AUTHENTICATED node id brakes a compromised
 *   or runaway satellite before it can hammer GitHub's mint API.
 * - The call is account-scoped server-side: the installation's own account binding
 *   (`GitHubInstallation.accountId` — an installation is bound to exactly one account)
 *   must be in the token's scope. An unknown, uninstalled, unbound, or out-of-scope
 *   installation is a uniform 404 (no existence leak).
 * - The minted token is REPO-SCOPED (`repository_ids`), not installation-wide: it is
 *   narrowed to the live App-linked repos the mothership projects for the installation
 *   (`github_repos`), so a delegated token can never reach repos the platform doesn't
 *   even track. `user_pat`-linked rows are excluded (not reachable through the App
 *   installation). A caller may narrow FURTHER by naming `repositoryIds` (a container
 *   dispatch names the repos its run resolved), which is INTERSECTED with the linked set:
 *   asking narrows, never widens. Nothing left in scope ⇒ 404.
 * - Every mint (and every denial/failure) is audit-logged with the token's nodeId +
 *   userId; the client-facing 500 stays opaque.
 *
 * `forceRefresh` passes through so the client can defeat the mothership's in-memory
 * token cache after a permission change on GitHub (repo-scoped mints bypass that cache
 * anyway — see `GitHubAppAuth.installationToken`).
 *
 * Mounted on BOTH facades via the shared controller registration, so either a Node or
 * a Cloudflare deployment can serve it. A deployment that is not a mothership (no
 * `repositories` registry) or has no GitHub App (no `githubTokenDelegation` seam)
 * serves a 503 — after the auth check, so the machine gate is asserted uniformly.
 */

/** Fixed-window rate limit for the delegation mint (per authenticated node). */
interface GitHubDelegationRateLimit {
  /** Max mints per node per window. */
  limit: number
  windowMs: number
}

export interface GitHubDelegationControllerOptions {
  /** Override the default mint rate limit (tests inject a tight one). */
  rateLimit?: GitHubDelegationRateLimit
  /** Injectable clock for the rate-limit window (tests). */
  now?: () => number
}

/**
 * Generous for a legitimate satellite: the client (`DelegatedAppTokenSource`) memoises a
 * minted token for 60s per installation, so steady-state traffic is ~1 mint/min per
 * installation the node works — 30/min leaves ample headroom for bursts (run start
 * fan-out, forceRefresh after a grant change) while braking a runaway loop.
 */
const DEFAULT_RATE_LIMIT: GitHubDelegationRateLimit = { limit: 30, windowMs: 60_000 }

/**
 * The caller's requested narrowing, or `undefined` when it asked for none. A malformed entry
 * makes the whole field `undefined` (⇒ the full linked scope) rather than a partial list: the
 * request is only ever intersected with what the mothership links, so ignoring a garbled ask can
 * never widen past the installation's own repos, while honouring half of one would mint a token
 * missing a repo the caller is about to clone.
 */
function readRequestedRepositoryIds(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const ids: number[] = []
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
    ids.push(value)
  }
  return ids
}

export function githubDelegationController(
  options: GitHubDelegationControllerOptions = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { limit, windowMs } = options.rateLimit ?? DEFAULT_RATE_LIMIT
  const now = options.now ?? Date.now
  // Fixed-window counters, PER PROCESS/ISOLATE (one Worker isolate / one Node replica) —
  // a coarse abuse brake on the GitHub mint API, not a distributed quota. Keyed by the
  // AUTHENTICATED nodeId (signed into the machine token by the mothership's own mint),
  // so cardinality is bounded by the nodes the mothership provisioned.
  const mintWindows = new Map<string, { windowStart: number; count: number }>()

  app.post('/internal/github/installation-token', async (c) => {
    const container = c.get('container')

    // Machine-token gate first: the endpoint's availability must not be probeable
    // without a valid token, and the shared conformance suite asserts the 403 on
    // facades that wire no GitHub App at all.
    const payload = await verifyMachineRequest(c)
    if (!payload) {
      return c.json({ error: { code: 'forbidden', message: 'invalid machine token' } }, 403)
    }
    const log = logger.child({
      scope: 'githubDelegation',
      nodeId: payload.nodeId,
      userId: payload.userId,
    })

    // Rate limit right after auth (the key is the authenticated nodeId), before any
    // repository read or mint work.
    const nowMs = now()
    const bucket = mintWindows.get(payload.nodeId)
    if (!bucket || nowMs - bucket.windowStart >= windowMs) {
      mintWindows.set(payload.nodeId, { windowStart: nowMs, count: 1 })
    } else if (++bucket.count > limit) {
      log.warn('github delegation: mint rate limit exceeded', { limit, windowMs })
      throw new RateLimitedError('too many token mints, retry shortly')
    }

    const registry = container.repositories
    const delegation = container.githubTokenDelegation
    if (!registry || !delegation) {
      throw new UnavailableError('GitHub token delegation is not enabled on this deployment')
    }

    let body: { installationId?: unknown; forceRefresh?: unknown; repositoryIds?: unknown }
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

    // Scope binding: an installation is bound to exactly ONE account (migration 0017 —
    // `GitHubInstallation.accountId`; `listWorkspacesForInstallation` fans out to that
    // account's workspaces), so the check is a single point read of the installation row:
    // it must exist, be live (not uninstalled/suspended), and its account must be in the
    // token scope. A null accountId (the auth-disabled binding path — never a mothership,
    // which always runs with auth) fails closed. Uniform 404 on every denial (no
    // existence leak), including when the mothership's wiring lacks the resolver methods.
    const denied = () => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404)
    const installations = registry.githubInstallationRepository
    const repoProjection = registry.repoProjectionRepository
    if (
      typeof installations?.getByInstallationId !== 'function' ||
      typeof repoProjection?.listByInstallation !== 'function'
    ) {
      return denied()
    }
    try {
      const installation = (await installations.getByInstallationId(
        installationId,
      )) as GitHubInstallation | null
      const accountId = installation && !installation.deletedAt ? installation.accountId : null
      if (typeof accountId !== 'string' || !payload.scope.accountIds.includes(accountId)) {
        log.warn('github delegation: installation out of scope, denied', { installationId })
        return denied()
      }

      // Token scope minimization: narrow the mint to the LIVE App-linked repos the
      // mothership projects for this installation (one batched read across its
      // workspaces), instead of handing out an installation-wide token. `user_pat` rows
      // are excluded — they are reachable only through a member's personal token, never
      // the App installation, and GitHub would reject their ids on the mint. The same
      // repo linked by several workspaces projects one row each, so dedupe by githubId.
      const repos = (await repoProjection.listByInstallation(installationId)) as GitHubRepo[]
      const linked = new Set(
        (repos ?? [])
          .filter((repo) => (repo.linkedVia ?? 'app') !== 'user_pat')
          .map((repo) => repo.githubId),
      )
      // A caller may ask for LESS: a container dispatch requests only the repos its run resolved
      // (`jobTokenRepoIds`), so the delegated token is as narrow as the engine's own would be on a
      // hosted deployment. The request is INTERSECTED with the linked set, never unioned: the
      // node's ask is a narrowing hint, and the mothership's projection stays the authority on
      // what may be granted. An unscoped request (the engine's gate/merge calls) takes the whole
      // linked set, as before.
      const requested = readRequestedRepositoryIds(body.repositoryIds)
      const repositoryIds = requested ? requested.filter((id) => linked.has(id)) : [...linked]
      if (repositoryIds.length === 0) {
        // Nothing in scope to grant, the same uniform denial as an out-of-scope installation. It
        // covers both "this installation links nothing" and "nothing the caller asked for is
        // linked"; the log line separates them, the response deliberately does not.
        log.warn('github delegation: no linked repos to scope, denied', {
          installationId,
          linkedCount: linked.size,
          ...(requested ? { requestedCount: requested.length } : {}),
        })
        return denied()
      }

      const forceRefresh = body.forceRefresh === true
      const minted = await delegation.installationToken(installationId, {
        forceRefresh,
        repositoryIds,
      })
      // Audit trail: who minted what, scoped how wide. `requestedCount` beside `repoCount` is
      // what shows a caller asking for a repo this installation does not link (a repo unlinked
      // between the node's read and this mint). The token is still granted, narrower than asked,
      // and the harness would fail to clone the missing leg. NEVER log the token itself.
      log.info('github delegation: minted repo-scoped installation token', {
        installationId,
        forceRefresh,
        repoCount: repositoryIds.length,
        ...(requested ? { requestedCount: requested.length } : {}),
      })
      return c.json({ token: minted }, 200)
    } catch (error) {
      // Server-side diagnostics only — the client-facing 500 stays opaque so an internal
      // error's message never leaks over the machine API.
      log.error('github delegation: mint failed', {
        installationId,
        err: getErrorMessage(error),
      })
      return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500)
    }
  })

  return app
}
