import type { FragmentOwnerKind } from '~/types/domain'
import { createApiClient, createSend, createSendWith } from './api/client'
import type { ApiContext } from './api/context'
import { accountsApi } from './api/accounts'
import { authApi } from './api/auth'
import { bootstrapApi } from './api/bootstrap'
import { boardApi } from './api/board'
import { documentsApi } from './api/documents'
import { executionApi } from './api/execution'
import { followUpsApi } from './api/followUps'
import { fragmentsApi } from './api/fragments'
import { githubApi } from './api/github'
import { humanReviewApi } from './api/humanReview'
import { humanTestApi } from './api/humanTest'
import { infraHandlersApi } from './api/infraHandlers'
import { initiativeApi } from './api/initiative'
import { docInterviewApi } from './api/docInterview'
import { visualConfirmApi } from './api/visualConfirm'
import { kaizenApi } from './api/kaizen'
import { localSettingsApi } from './api/localSettings'
import { modelsApi } from './api/models'
import { notificationsApi } from './api/notifications'
import { packageRegistriesApi } from './api/packageRegistries'
import { preflightsApi } from './api/preflights'
import { presetsApi } from './api/presets'
import { sharedStacksApi } from './api/sharedStacks'
import { providerConnectionsApi } from './api/providerConnections'
import { provisioningLogsApi } from './api/provisioningLogs'
import { recurringApi } from './api/recurring'
import { previewApi } from './api/preview'
import { environmentsApi } from './api/environments'
import { releaseHealthApi } from './api/releaseHealth'
import { sandboxApi } from './api/sandbox'
import { reviewsApi } from './api/reviews'
import { slackApi } from './api/slack'
import { specApi } from './api/spec'
import { tasksApi } from './api/tasks'
import { userSecretsApi } from './api/userSecrets'
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

  // The contract-driven client (wretch + sendByApiContract): one source of truth for
  // path/method/request/response, shared with the backend via @cat-factory/contracts.
  // API groups are migrated onto `send` incrementally; the rest still use `http`.
  const client = createApiClient()
  const send = createSend(client)
  const sendWith = createSendWith(client)

  const ctx: ApiContext = { http, client, send, sendWith, ws, scope, pwHeaders }

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
    ...followUpsApi(ctx),
    ...humanTestApi(ctx),
    ...visualConfirmApi(ctx),
    ...humanReviewApi(ctx),
    ...kaizenApi(ctx),
    ...localSettingsApi(ctx),
    ...specApi(ctx),
    ...notificationsApi(ctx),
    ...presetsApi(ctx),
    ...preflightsApi(ctx),
    ...sharedStacksApi(ctx),
    ...providerConnectionsApi(ctx),
    ...infraHandlersApi(ctx),
    ...initiativeApi(ctx),
    ...docInterviewApi(ctx),
    ...provisioningLogsApi(ctx),
    ...releaseHealthApi(ctx),
    ...packageRegistriesApi(ctx),
    ...previewApi(ctx),
    ...environmentsApi(ctx),
    ...recurringApi(ctx),
    ...sandboxApi(ctx),
    ...githubApi(ctx),
    ...slackApi(ctx),
    ...bootstrapApi(ctx),
    ...userSecretsApi(ctx),
  }
}
