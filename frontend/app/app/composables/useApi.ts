import type { FragmentOwnerKind } from '~/types/domain'
import type { ApiContext } from './api/context'
import { accountsApi } from './api/accounts'
import { authApi } from './api/auth'
import { bootstrapApi } from './api/bootstrap'
import { boardApi } from './api/board'
import { documentsApi } from './api/documents'
import { executionApi } from './api/execution'
import { fragmentsApi } from './api/fragments'
import { githubApi } from './api/github'
import { modelsApi } from './api/models'
import { notificationsApi } from './api/notifications'
import { presetsApi } from './api/presets'
import { recurringApi } from './api/recurring'
import { releaseHealthApi } from './api/releaseHealth'
import { reviewsApi } from './api/reviews'
import { slackApi } from './api/slack'
import { tasksApi } from './api/tasks'
import { workspacesApi } from './api/workspaces'

/**
 * Thin typed client over the cat-factory backend (a Hono worker). Every method
 * maps to one REST endpoint; the request/response shapes mirror
 * `@cat-factory/contracts`, so responses drop straight into the Pinia stores.
 *
 * The endpoints are grouped by domain into the `./api/*` factory modules; this
 * function builds the shared {@link ApiContext} (the authed `$fetch` client +
 * path/header helpers) and spreads every group into a single flat client, so
 * call sites stay `useApi().someMethod(...)`.
 *
 * The base URL comes from runtime config (`NUXT_PUBLIC_API_BASE`), defaulting to
 * the local wrangler dev server — see `nuxt.config.ts`.
 */
export function useApi() {
  const apiBase = useRuntimeConfig().public.apiBase
  const http = $fetch.create({
    baseURL: apiBase,
    // Attach the session token (when signed in) so the backend's auth gate lets
    // the request through. Read lazily from the store so a fresh token applies
    // without rebuilding the client.
    onRequest({ options }) {
      const token = useAuthStore().token
      if (!token) return
      const headers = new Headers(options.headers)
      headers.set('Authorization', `Bearer ${token}`)
      options.headers = headers
    },
    // A 401 means our token lapsed or was revoked — drop it so the UI re-gates.
    onResponseError({ response }) {
      if (response?.status === 401) useAuthStore().handleUnauthorized()
    },
  })

  // The personal-subscription unlock password (individual-usage vendors) rides as an
  // ambient request header — like the bearer token — so it never lands in a request
  // body/wire-contract payload. Mirrors PERSONAL_PASSWORD_HEADER in @cat-factory/contracts.
  const pwHeaders = (password?: string): Record<string, string> | undefined =>
    password ? { 'X-Personal-Password': password } : undefined

  const ws = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`
  // Prompt-fragment library routes exist at both tiers; resolve the prefix from
  // the owner scope (ADR 0006 §8).
  const scope = (kind: FragmentOwnerKind, id: string) =>
    kind === 'account'
      ? `/accounts/${encodeURIComponent(id)}`
      : `/workspaces/${encodeURIComponent(id)}`

  const ctx: ApiContext = { http, ws, scope, pwHeaders }

  return {
    ...authApi(ctx),
    ...fragmentsApi(ctx),
    ...modelsApi(ctx),
    ...accountsApi(ctx),
    ...workspacesApi(ctx),
    ...boardApi(ctx),
    ...executionApi(ctx),
    ...documentsApi(ctx),
    ...tasksApi(ctx),
    ...reviewsApi(ctx),
    ...notificationsApi(ctx),
    ...presetsApi(ctx),
    ...releaseHealthApi(ctx),
    ...recurringApi(ctx),
    ...githubApi(ctx),
    ...slackApi(ctx),
    ...bootstrapApi(ctx),
  }
}
