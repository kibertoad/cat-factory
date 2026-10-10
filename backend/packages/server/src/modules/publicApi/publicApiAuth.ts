import { PUBLIC_API_WORKSPACE_HEADER, type PublicApiScope } from '@cat-factory/contracts'
import {
  keyReaches,
  scopeSatisfies,
  type PublicApiKeyAuth,
  type PublicApiKeyIdentity,
} from '@cat-factory/integrations'
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
} from '@cat-factory/kernel'
import type { Context, TypedResponse } from 'hono'
import type { AppEnv } from '../../http/env.js'

// The in-controller bearer-key gate shared by every `/api/v1` controller. The public surface is
// NOT behind the SPA's session gate (its `/api` prefix is in the authGate bypass list), so each
// route authenticates here — mirroring how `/internal` self-authenticates with a machine token.
// Lives in its own module because the surface is now more than one controller (the board/job
// routes in `PublicApiController`, the parked-decision routes in `PublicDecisionController`) and
// both MUST resolve keys and ladder scopes through exactly one implementation.

/**
 * The outcome of authenticating a public-API call: the resolved key scope, or a `fail` describing
 * the error the handler should emit. Kept as DATA rather than a `Response` so the contract
 * handlers stay typed against their declared response schemas.
 */
export type KeyResult = { auth: PublicApiKeyAuth } | { fail: KeyFailure }

type KeyFailure = {
  status: 401 | 403 | 404 | 422 | 503
  code: string
  message: string
  /** Machine-readable context (a `{ reason }`), rendered as the envelope's `details`. */
  details?: { reason: string }
}

type IdentityResult = { auth: PublicApiKeyIdentity } | { fail: KeyFailure }

/**
 * The wire body of a refusal. Spelt out as the declared return type of {@link refuse} because the
 * type `c.json` infers names a hono-internal alias that a declaration emit cannot reference.
 */
type RefusalBody = { error: { code: string; message: string; details?: { reason: string } } }

/**
 * The raw key the caller presented, stripped of its `Bearer` prefix.
 *
 * Shared rather than re-derived, because the hosted MCP endpoint FORWARDS the key onto the calls its
 * tools make: a second copy of this parse could admit a key here and hand a differently-trimmed one
 * to the SDK, which authenticates as nobody.
 */
export function bearerToken<E extends AppEnv>(c: Context<E>): string | undefined {
  return c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
}

/**
 * Render an auth `fail` as its response. Lives here rather than in each controller because the
 * refusal shape is part of the surface's contract, not a per-route choice: every `/api/v1` handler
 * emits the SAME `{ error: { code, message } }` at the SAME status, and a controller that spelt it
 * out itself is one that can drift from the rest by a copy-paste.
 *
 * Hand-built rather than a thrown `DomainError` for the reason {@link KeyResult} exists: on this
 * surface a refusal is DATA the contract handler returns, so the handler stays typed against its
 * declared response schemas.
 */
export function refuse<E extends AppEnv>(
  c: Context<E>,
  fail: KeyFailure,
): Response & TypedResponse<RefusalBody, KeyFailure['status'], 'json'> {
  const details = fail.details === undefined ? {} : { details: fail.details }
  return c.json({ error: { code: fail.code, message: fail.message, ...details } }, fail.status)
}

/** Resolve the caller's public-API key to a workspace scope, or the error to emit. */
async function resolveKey<E extends AppEnv>(c: Context<E>): Promise<IdentityResult> {
  const svc = c.get('container').publicApiKeys
  if (!svc) {
    return { fail: { status: 503, code: 'unavailable', message: 'Public API is not configured' } }
  }
  const auth = await svc.authenticate(bearerToken(c))
  if (!auth) {
    return { fail: { status: 401, code: 'unauthorized', message: 'Invalid or missing API key' } }
  }
  return { auth }
}

/**
 * Authenticate the caller AND require a minimum permission scope. The scope ladder is inclusive
 * (read ⊂ write ⊂ decide ⊂ admin), so a `write` key satisfies a `read` requirement and an `admin`
 * key satisfies any. A valid key whose scope is too low is a 403 `insufficient_scope` (distinct
 * from the 401 an unknown/absent key gets) — the caller can tell "wrong key" from "key can't do
 * this". Every `/api/v1` handler gates through this, naming the least scope it needs.
 */
export async function authorize<E extends AppEnv>(
  c: Context<E>,
  need: PublicApiScope,
): Promise<KeyResult> {
  const result = await authorizeAccount(c, need)
  if ('fail' in result) return result
  const workspace = await resolveWorkspace(c, result.auth)
  if ('fail' in workspace) return workspace
  return { auth: { ...result.auth, workspaceId: workspace.workspaceId } }
}

/**
 * {@link authorize} for an ACCOUNT-scoped route (the directory surface): the key and its scope, with
 * no workspace resolved and no `x-cat-factory-workspace` header read. The handler applies the key's
 * workspace reach itself, because what a restricted key may see there is a filter, not a refusal.
 */
export async function authorizeAccount<E extends AppEnv>(
  c: Context<E>,
  need: PublicApiScope,
): Promise<{ auth: PublicApiKeyIdentity } | { fail: KeyFailure }> {
  const result = await resolveKey(c)
  if ('fail' in result) return result
  if (!scopeSatisfies(result.auth.scope, need)) {
    return {
      fail: {
        status: 403,
        code: 'insufficient_scope',
        message: `This action requires a '${need}'-scope key; this key is scoped '${result.auth.scope}'`,
      },
    }
  }
  return result
}

/**
 * The workspace a request acts on: the one the {@link PUBLIC_API_WORKSPACE_HEADER} header names, or
 * the key's only workspace when it has exactly one (every key minted before keys could span
 * workspaces). A restricted key's grants were checked against its account at mint, and a board
 * never leaves an account once linked, so only an unrestricted key naming a board needs the
 * ownership read. Absent and out of reach answer the same 404, so a key cannot probe for
 * workspaces it was not granted.
 */
async function resolveWorkspace<E extends AppEnv>(
  c: Context<E>,
  key: PublicApiKeyIdentity,
): Promise<{ workspaceId: string } | { fail: KeyFailure }> {
  const named = c.req.header(PUBLIC_API_WORKSPACE_HEADER)?.trim()
  const implied = key.workspaceIds?.length === 1 ? key.workspaceIds[0] : undefined
  const workspaceId = named || implied
  if (!workspaceId) {
    return {
      fail: {
        status: 422,
        code: 'validation',
        message: `This key reaches several workspaces; name one in the '${PUBLIC_API_WORKSPACE_HEADER}' header`,
        details: { reason: 'workspace_required' },
      },
    }
  }
  const notFound: { fail: KeyFailure } = {
    fail: {
      status: 404,
      code: 'not_found',
      message: 'Workspace not found',
      details: { reason: 'workspace_not_found' },
    },
  }
  if (!keyReaches(key.workspaceIds, workspaceId)) return notFound
  if (key.workspaceIds !== null) return { workspaceId }
  const accountId = await c.get('container').workspaceService.accountOf(workspaceId)
  return accountId === key.accountId ? { workspaceId } : notFound
}

/**
 * {@link authorize} for a route with no contract-declared response schema: the refusal is THROWN as
 * a `DomainError` so `handleError` renders it, correlation id and all.
 *
 * The `fail`-as-data shape above exists because the contract handlers must stay typed against their
 * declared responses; a hand-mounted route (the MCP endpoint) has no such obligation and gets the
 * repo's default instead of a fourth hand-built envelope. Same ladder either way: the scope rule
 * lives in exactly one place, and this is a translation of its verdict rather than a second copy.
 *
 * `details.reason` carries the machine-readable cause, since `code` is only the status class: an
 * `insufficient_scope` needs a wider key, a `invalid_api_key` a valid one, and an unconfigured
 * public API needs the deployment's operator.
 */
export async function authorizeOrThrow<E extends AppEnv>(
  c: Context<E>,
  need: PublicApiScope,
): Promise<PublicApiKeyAuth> {
  const result = await authorize(c, need)
  if (!('fail' in result)) return result.auth
  const { status, code, message, details } = result.fail
  switch (status) {
    case 401:
      throw new UnauthorizedError(message, 'invalid_api_key')
    case 403:
      throw new ForbiddenError(message, { reason: code, requiredScope: need })
    case 404:
      throw new NotFoundError('Workspace', c.req.header(PUBLIC_API_WORKSPACE_HEADER) ?? '', details)
    case 422:
      throw new ValidationError(message, details)
    case 503:
      throw new UnavailableError(message, 'public_api_unconfigured')
  }
}
