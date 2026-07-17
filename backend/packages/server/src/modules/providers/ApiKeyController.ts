import {
  addUserApiKeyContract,
  addWorkspaceApiKeyContract,
  listUserApiKeysContract,
  listWorkspaceApiKeysContract,
  removeUserApiKeyContract,
  removeWorkspaceApiKeyContract,
  type ApiKey,
} from '@cat-factory/contracts'
import type { ApiKeySummary } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'

// Direct-provider API-key endpoints. Keys (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot)
// are onboarded here and stored encrypted, replacing deployment-env onboarding. The
// raw key is write-only — only metadata + rolling-window usage is ever returned.
//
// This controller mounts the WORKSPACE-scoped routes (under `/workspaces/:workspaceId`)
// and the USER-scoped routes (`/me/api-keys`, the caller's own pool). ACCOUNT-scoped
// keys are managed by the AccountController, which admin-gates them.

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'API key storage is not configured' } }, 503)

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unauthorized', message: 'Sign in to manage your API keys' } }, 401)

/** Project the service summary onto the wire type (already secret-free). */
export function apiKeyToWire(summary: ApiKeySummary): ApiKey {
  return {
    id: summary.id,
    scope: summary.scope,
    scopeId: summary.scopeId,
    provider: summary.provider,
    label: summary.label,
    createdAt: summary.createdAt,
    lastUsedAt: summary.lastUsedAt,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    requestCount: summary.requestCount,
  }
}

/** Workspace-scoped API-key routes, mounted under `/workspaces/:workspaceId`. */
export function workspaceApiKeyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('secrets.manage'))

  buildHonoRoute(app, listWorkspaceApiKeysContract, async (c) => {
    const apiKeys = c.get('container').apiKeys
    if (!apiKeys) return unavailable(c)
    const keys = await apiKeys.listKeys('workspace', param(c, 'workspaceId'))
    return c.json({ keys: keys.map(apiKeyToWire) }, 200)
  })

  buildHonoRoute(app, addWorkspaceApiKeyContract, async (c) => {
    const apiKeys = c.get('container').apiKeys
    if (!apiKeys) return unavailable(c)
    const summary = await apiKeys.addKey('workspace', param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(apiKeyToWire(summary), 201)
  })

  buildHonoRoute(app, removeWorkspaceApiKeyContract, async (c) => {
    const apiKeys = c.get('container').apiKeys
    if (!apiKeys) return unavailable(c)
    await apiKeys.removeKey('workspace', param(c, 'workspaceId'), c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}

/** User-scoped API-key routes (the caller's own pool), mounted at the root. */
export function userApiKeyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listUserApiKeysContract, async (c) => {
    const apiKeys = c.get('container').apiKeys
    if (!apiKeys) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const keys = await apiKeys.listKeys('user', user.id)
    return c.json({ keys: keys.map(apiKeyToWire) }, 200)
  })

  buildHonoRoute(app, addUserApiKeyContract, async (c) => {
    const apiKeys = c.get('container').apiKeys
    if (!apiKeys) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const summary = await apiKeys.addKey('user', user.id, c.req.valid('json'))
    return c.json(apiKeyToWire(summary), 201)
  })

  buildHonoRoute(app, removeUserApiKeyContract, async (c) => {
    const apiKeys = c.get('container').apiKeys
    if (!apiKeys) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    await apiKeys.removeKey('user', user.id, c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}
