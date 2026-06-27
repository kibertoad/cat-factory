import type { WretchInstance } from '@toad-contracts/frontend-http-client'
import type { FragmentOwnerKind } from '~/types/domain'
import type { ApiSend, ApiSendWith } from './client'

/** The authed `$fetch` instance type — Nuxt's augmented client, as returned by `$fetch.create`. */
export type ApiHttp = ReturnType<typeof $fetch.create>

/**
 * Shared plumbing handed to every grouped API module. `useApi()` builds one of
 * these (the authed wretch client, the contract `send` helper + the path/header
 * helpers) and passes it to each `*Api(ctx)` factory; the factories return the
 * endpoint methods that `useApi()` spreads into its single flat client object.
 * Splitting the client this way keeps call sites unchanged
 * (`useApi().someMethod(...)`) while the ~100 endpoints live in cohesive
 * per-domain files.
 */
export interface ApiContext {
  /**
   * The authed `$fetch` instance (bearer token + 401 handling pre-wired).
   * Transitional: API groups not yet migrated to contract `send` still use it.
   */
  http: ApiHttp
  /** The authed wretch client (bearer token + 401 handling pre-wired). */
  client: WretchInstance
  /**
   * Contract sender: validates the response against the route contract and returns
   * the success body, or throws the typed error. The single source of truth for
   * path + method + request + response is the contract in `@cat-factory/contracts`.
   */
  send: ApiSend
  /**
   * Like {@link send} but attaches ambient headers the contract doesn't model — today the
   * personal-subscription unlock password on gated run calls (individual-usage vendors).
   */
  sendWith: ApiSendWith
  /** `/workspaces/:id` path prefix (id encoded). */
  ws: (workspaceId: string) => string
  /** Prompt-fragment library prefix, resolved from the owner scope (ADR 0006 §8). */
  scope: (kind: FragmentOwnerKind, id: string) => string
  /** The ambient personal-unlock password header (individual-usage vendors). */
  pwHeaders: (password?: string) => Record<string, string> | undefined
}

export type Position = { x: number; y: number }
