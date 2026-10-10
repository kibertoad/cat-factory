import {
  addUserApiKeyContract,
  addWorkspaceApiKeyContract,
  listUserApiKeysContract,
  listWorkspaceApiKeysContract,
  removeUserApiKeyContract,
  removeWorkspaceApiKeyContract,
  updateUserApiKeyContract,
  updateWorkspaceApiKeyContract,
  type ApiKey,
} from '@cat-factory/contracts'
import type { ApiKeySummary } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability, requireUser } from '../../http/guards.js'

// Direct-provider API-key endpoints. Keys (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot)
// are onboarded here and stored encrypted, replacing deployment-env onboarding. The
// raw key is write-only — only metadata + rolling-window usage is ever returned.
//
// This controller mounts the WORKSPACE-scoped routes (under `/workspaces/:workspaceId`)
// and the USER-scoped routes (`/me/api-keys`, the caller's own pool). ACCOUNT-scoped
// keys are managed by the AccountController, which admin-gates them.

/** Project the service summary onto the wire type (already secret-free). */
/** Resolve the API-key store, or refuse with a 503 naming what isn't wired. */
function requireApiKeys<E extends AppEnv>(c: Context<E>) {
  return requireCapability(c.get('container').apiKeys, 'API key storage is not configured')
}

/** The signed-in caller, or a 401 wording the prompt for what this controller manages. */
function requireSignedIn<E extends AppEnv>(c: Context<E>) {
  return requireUser(c, 'Sign in to manage your API keys')
}

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
    enabled: summary.enabled,
    isDefault: summary.isDefault,
  }
}

/** Workspace-scoped API-key routes, mounted under `/workspaces/:workspaceId`. */
export function workspaceApiKeyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'secrets.manage', ['/api-keys'])

  buildHonoRoute(app, listWorkspaceApiKeysContract, async (c) => {
    const apiKeys = requireApiKeys(c)
    const keys = await apiKeys.listKeys('workspace', param(c, 'workspaceId'))
    return c.json({ keys: keys.map(apiKeyToWire) }, 200)
  })

  buildHonoRoute(app, addWorkspaceApiKeyContract, async (c) => {
    const apiKeys = requireApiKeys(c)
    const summary = await apiKeys.addKey('workspace', param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(apiKeyToWire(summary), 201)
  })

  buildHonoRoute(app, updateWorkspaceApiKeyContract, async (c) => {
    const apiKeys = requireApiKeys(c)
    const summary = await apiKeys.updateKey(
      'workspace',
      param(c, 'workspaceId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    return c.json(apiKeyToWire(summary), 200)
  })

  buildHonoRoute(app, removeWorkspaceApiKeyContract, async (c) => {
    const apiKeys = requireApiKeys(c)
    await apiKeys.removeKey('workspace', param(c, 'workspaceId'), c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}

/** User-scoped API-key routes (the caller's own pool), mounted at the root. */
export function userApiKeyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listUserApiKeysContract, async (c) => {
    const apiKeys = requireApiKeys(c)
    const user = requireSignedIn(c)
    const keys = await apiKeys.listKeys('user', user.id)
    return c.json({ keys: keys.map(apiKeyToWire) }, 200)
  })

  buildHonoRoute(app, addUserApiKeyContract, async (c) => {
    const apiKeys = requireApiKeys(c)
    const user = requireSignedIn(c)
    const summary = await apiKeys.addKey('user', user.id, c.req.valid('json'))
    return c.json(apiKeyToWire(summary), 201)
  })

  buildHonoRoute(app, updateUserApiKeyContract, async (c) => {
    const apiKeys = requireApiKeys(c)
    const user = requireSignedIn(c)
    const summary = await apiKeys.updateKey(
      'user',
      user.id,
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    return c.json(apiKeyToWire(summary), 200)
  })

  buildHonoRoute(app, removeUserApiKeyContract, async (c) => {
    const apiKeys = requireApiKeys(c)
    const user = requireSignedIn(c)
    await apiKeys.removeKey('user', user.id, c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}
