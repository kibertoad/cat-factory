import type { FragmentOwnerKind } from '~/types/domain'

/** The authed `$fetch` instance type — Nuxt's augmented client, as returned by `$fetch.create`. */
export type ApiHttp = ReturnType<typeof $fetch.create>

/**
 * Shared plumbing handed to every grouped API module. `useApi()` builds one of
 * these (the authed `$fetch` client + the path/header helpers) and passes it to
 * each `*Api(ctx)` factory; the factories return the endpoint methods that
 * `useApi()` spreads into its single flat client object. Splitting the client
 * this way keeps call sites unchanged (`useApi().someMethod(...)`) while the
 * ~100 endpoints live in cohesive per-domain files.
 */
export interface ApiContext {
  /** The authed `$fetch` instance (bearer token + 401 handling pre-wired). */
  http: ApiHttp
  /** `/workspaces/:id` path prefix (id encoded). */
  ws: (workspaceId: string) => string
  /** Prompt-fragment library prefix, resolved from the owner scope (ADR 0006 §8). */
  scope: (kind: FragmentOwnerKind, id: string) => string
  /** The ambient personal-unlock password header (individual-usage vendors). */
  pwHeaders: (password?: string) => Record<string, string> | undefined
}

export type Position = { x: number; y: number }
