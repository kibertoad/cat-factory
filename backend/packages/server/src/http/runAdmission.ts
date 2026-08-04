import type { Context } from 'hono'
import type { WorkspaceRole } from '@cat-factory/contracts'
import type { AppEnv } from './env.js'

/**
 * The admission facts a run start CONSUMES off the request, in one place.
 *
 * Sibling of `params.ts`'s `param()` and the `guards.ts` accessors: a one-line total accessor in
 * place of a nullable read every start route would otherwise restate. That restating is what this
 * exists to stop — the role-scoped merge policy shipped wired into `ExecutionController` alone,
 * so the bug-hunt adopt route (a member-tier start, through a different module) minted runs that
 * pinned no role and therefore escaped both the role narrowing and the sandbox.
 */

/**
 * The workspace ROLE the request's caller holds, as the auth gate already resolved it.
 *
 * READ, never re-derived: `mountAuthGate` calls the single `loadWorkspaceAccess` on every
 * `/workspaces/:ws/*` request and publishes the result, and workspace-rbac keeps membership
 * resolution in exactly one place (ADR 0025). A controller that resolved it again would be a
 * second answer to a question with one authority.
 *
 * `null` is a REAL state and the honest reading of dev-open: with auth disabled the gate resolves
 * no access object, so there is no tier to scope by and the run stays on its preset's BASE merge
 * policy rather than being scoped to a guess. See `ExecutionInstance.initiatedByRole` for why
 * absent is deliberately not treated as the lowest tier.
 */
export function runInitiatorRole<E extends AppEnv>(c: Context<E>): WorkspaceRole | null {
  return c.get('workspaceAccess')?.role ?? null
}
