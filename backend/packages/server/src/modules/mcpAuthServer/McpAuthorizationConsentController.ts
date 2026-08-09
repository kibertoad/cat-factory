import {
  decideMcpAuthorizationContract,
  describeMcpAuthorizationContract,
} from '@cat-factory/contracts'
import type { McpAuthorizationRequestState } from '@cat-factory/integrations'
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { requestLogger } from '../../http/requestLogging.js'
import { loadWorkspaceAccess } from '../../http/workspaceAccess.js'

// ---------------------------------------------------------------------------
// The half of MCP authorization that needs a human: describing what an MCP host is asking for, and
// recording what a person decided.
//
// Ordinary session-gated API, mounted at the root, and that is the entire reason the flow detours
// through the SPA at all. `GET /oauth/authorize` is a browser navigation a third party triggers, so
// it carries no bearer token and can establish nothing about who is looking at the screen; these
// two calls are made BY the app, with the session it already holds. Three things gate an approval,
// each of which therefore genuinely runs:
//
//   1. the SESSION, via the shared default-deny gate, so an absent user here means auth is
//      unconfigured rather than a caller who simply presented nothing;
//   2. the sealed request, which only this deployment can mint and open, carries the client and the
//      already-validated redirect URI, and expires;
//   3. `secrets.manage` on the board the human PICKED, resolved at the moment of approval. It
//      cannot be the workspace gate: the board arrives in the body, chosen on the screen, so there
//      is no `:workspaceId` segment for the gate to bind to.
//
// The permission is `secrets.manage` because what an approval MINTS is a public-API key on that
// board, which is exactly what the key panel's own gate requires. Anything looser would be a second
// door to the same credential with a lower bar on it.
// ---------------------------------------------------------------------------

export function mcpAuthorizationConsentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, describeMcpAuthorizationContract, async (c) => {
    const request = await openRequest(c, c.req.valid('json').request)
    const server = requireAuthServer(c)
    return c.json(server.describeRequest(request), 200)
  })

  buildHonoRoute(app, decideMcpAuthorizationContract, async (c) => {
    const server = requireAuthServer(c)
    const body = c.req.valid('json')
    const request = await openRequest(c, body.request)

    if (body.decision === 'deny') {
      // No permission check on a refusal, deliberately: anyone who can open the screen may decline,
      // and requiring `secrets.manage` to say no would leave a person who cannot approve with no
      // way to answer at all, so the host waits out its timeout instead of being told.
      return c.json(server.denial(request), 200)
    }

    const accountId = await assertMayApprove(c, body.workspaceId)
    const result = await server.approve(request, {
      accountId,
      workspaceId: body.workspaceId,
      scope: body.scope,
      approvedByUserId: c.get('user')?.id ?? null,
    })
    requestLogger(c).info('mcp authorization approved', {
      workspaceId: body.workspaceId,
      scope: body.scope,
      clientName: request.clientName,
    })
    return c.json(result, 200)
  })

  return app
}

/** The authorization server, or the 503 naming what this deployment has not wired. */
function requireAuthServer<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    c.get('container').mcpAuthServer,
    'This deployment does not serve MCP authorization.',
  )
}

/**
 * Open the sealed request, refusing an absent, forged or expired one as a 401.
 *
 * One refusal for all three, for the reason the consuming side records about its own sealed state:
 * they are indistinguishable to whoever presented the value, and separating them would only tell
 * someone guessing which guess was closer. The page renders "this request has expired, start again
 * from your host", which is the right instruction for every one of them.
 */
async function openRequest<E extends AppEnv>(
  c: Context<E>,
  sealed: string,
): Promise<McpAuthorizationRequestState> {
  const request = await requireAuthServer(c).readAuthorizationRequest(sealed)
  if (!request) {
    requestLogger(c).warn('mcp authorization consent carried no usable request')
    throw new UnauthorizedError(
      'This authorization request is invalid or has expired',
      'mcp_authorization_request_invalid',
    )
  }
  return request
}

/**
 * The board is one this person may mint a key on, and the account that key belongs to.
 *
 * Resolved through the ONE shared `loadWorkspaceAccess` the workspace gate uses, so a board the
 * caller cannot see is a 404 here exactly as it is everywhere else and existence is not leaked by
 * the difference between "no such board" and "not yours".
 *
 * A `null` user is dev-open, which allows everything, the same reading `requirePermission` takes.
 * That is SOUND here only because this route sits behind the default-deny session gate: with auth
 * enabled a request with no valid session never reaches the handler.
 */
async function assertMayApprove<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
): Promise<string> {
  const container = c.get('container')
  const user = c.get('user')
  if (user) {
    const access = await loadWorkspaceAccess(container, workspaceId, user.id)
    if (!access?.allowed) {
      throw new NotFoundError('Workspace', workspaceId)
    }
    if (!access.permissions.has('secrets.manage')) {
      throw new ForbiddenError('This action requires the secrets.manage permission', {
        permission: 'secrets.manage',
      })
    }
  }
  // The account the minted key belongs to. Absent means the board is gone or predates accounts, and
  // either way there is no owner to attribute a credential to, so nothing is issued.
  const accountId = await container.workspaceService.accountOf(workspaceId)
  if (accountId == null) throw new NotFoundError('Workspace', workspaceId)
  return accountId
}
