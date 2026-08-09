import {
  McpOAuthProtocolError,
  authorizationServerMetadata,
  mcpResourceIdentifier,
  protectedResourceMetadata,
  AUTHORIZATION_SERVER_METADATA_PATH,
  OAUTH_ENDPOINT_PATHS,
  PROTECTED_RESOURCE_METADATA_PATH,
} from '@cat-factory/integrations'
import { describeError } from '@cat-factory/kernel'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { requestLogger } from '../../http/requestLogging.js'
import { consentUrlFor } from './consentRedirect.js'

// ---------------------------------------------------------------------------
// The unauthenticated half of MCP authorization on the SERVING side: two metadata documents, a
// dynamic client registration, the authorization redirect, and the token exchange.
//
// Everything here is reached WITHOUT a session, by construction rather than by exemption. A host
// reading metadata has no credential yet (that is what it is here to obtain), a registration is the
// act of becoming known at all, and the token exchange is a machine-to-machine call carrying the
// code and the PKCE verifier instead of a session. The one step that needs a signed-in human is the
// consent screen, and it is deliberately NOT here: `GET /oauth/authorize` validates and then sends
// the browser to the SPA, whose approval call is ordinary session-gated API. That is the same shape
// the CONSUMING side settled on for its vendor callback, arrived at from the other direction: a
// third party's browser navigation cannot carry a bearer token, so any identity check written on a
// route that receives one is unreachable code that reads like protection.
//
// Refusals answer in OAUTH's own vocabulary (RFC 6749 §5.2's `{ error, error_description }`),
// not the deployment's error envelope. Same split the hosted MCP endpoint already makes between an
// HTTP-level auth failure (the envelope, with its correlation id) and a protocol-level refusal (the
// transport's own frame): a client here parses `error` and branches on it, and `invalid_grant`
// against `invalid_client` is a distinction the envelope's status class cannot carry.
// ---------------------------------------------------------------------------

/** The authorization server, or the 503 naming what a deployment has not wired. */
function requireAuthServer<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    c.get('container').mcpAuthServer,
    'This deployment does not serve MCP authorization. It needs ENCRYPTION_KEY (the flow seals ' +
      'every value it carries) and the public API enabled, since what a host is issued is a ' +
      'public-API key.',
  )
}

export function mcpAuthorizationController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Both well-known paths answer the same document. RFC 9728 INSERTS the resource's path, which is
  // correct and is what a client built to the current spec asks for; the bare path is what several
  // shipped clients ask for, and Figma's live MCP server answers there too. This deployment serves
  // exactly one protected resource, so there is no second document either path could mean, and
  // answering both costs nothing but takes a whole class of "connects everywhere except here" out.
  for (const path of [PROTECTED_RESOURCE_METADATA_PATH, '/.well-known/oauth-protected-resource']) {
    app.get(path, (c) => metadataResponse(c, protectedResourceMetadata(originOf(c))))
  }

  app.get(AUTHORIZATION_SERVER_METADATA_PATH, (c) =>
    metadataResponse(c, authorizationServerMetadata(originOf(c))),
  )

  // Dynamic client registration (RFC 7591). Unauthenticated, which is the specified shape for an
  // OPEN registration endpoint and is what makes a host nobody configured able to connect at all.
  // What bounds it is that a registration grants NOTHING: no scope, no board, no token, until a
  // signed-in human with `secrets.manage` approves a specific board on the consent screen.
  app.post(OAUTH_ENDPOINT_PATHS.register, async (c) => {
    const server = requireAuthServer(c)
    const body = await readJsonBody(c)
    try {
      const registration = await server.registerClient({
        clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
        redirectUris: body.redirect_uris,
      })
      return c.json(
        {
          client_id: registration.clientId,
          client_name: registration.clientName,
          redirect_uris: registration.redirectUris,
          client_id_issued_at: Math.floor(registration.issuedAt / 1000),
          grant_types: ['authorization_code'],
          response_types: ['code'],
          // Stated rather than left to be inferred: these are PUBLIC clients, so a host that
          // expected a secret learns it here instead of at a token endpoint that ignores one.
          token_endpoint_auth_method: 'none',
        },
        201,
      )
    } catch (error) {
      return oauthErrorResponse(c, error)
    }
  })

  // The authorization endpoint: a top-level browser navigation the host opens. It validates
  // everything that can be validated without a human, then hands off to the consent screen.
  app.get(OAUTH_ENDPOINT_PATHS.authorize, async (c) => {
    const server = requireAuthServer(c)
    const query = new URL(c.req.url).searchParams
    const redirectUri = query.get('redirect_uri') ?? ''
    try {
      const { sealedRequest } = await server.beginAuthorization({
        clientId: query.get('client_id') ?? '',
        redirectUri,
        responseType: query.get('response_type') ?? '',
        codeChallenge: query.get('code_challenge') ?? '',
        codeChallengeMethod: query.get('code_challenge_method') ?? '',
        ...(query.get('state') ? { state: query.get('state') as string } : {}),
        ...(query.get('scope') ? { scope: query.get('scope') as string } : {}),
        ...(query.get('resource') ? { resource: query.get('resource') as string } : {}),
        expectedResource: mcpResourceIdentifier(originOf(c)),
      })
      return c.redirect(consentUrlFor(c, sealedRequest), 302)
    } catch (error) {
      // A refusal here is NOT reported by redirecting to the client. `beginAuthorization` refuses
      // exactly when the request is not one this server can attribute to a registered redirect
      // target, so bouncing the error to the supplied `redirect_uri` would be the open redirect the
      // registration check exists to prevent: an attacker would have a URL on this deployment's
      // origin that forwards a browser anywhere, with error text of their choosing on the end of
      // it. The human standing in front of this reads the refusal instead.
      return oauthErrorResponse(c, error)
    }
  })

  // The token endpoint: the one call a host makes with no browser involved.
  app.post(OAUTH_ENDPOINT_PATHS.token, async (c) => {
    const server = requireAuthServer(c)
    const form = await readFormBody(c)
    const grantType = form.get('grant_type') ?? ''
    try {
      if (grantType !== 'authorization_code') {
        throw new McpOAuthProtocolError(
          'unsupported_grant_type',
          `This authorization server serves the authorization_code grant; got '${grantType}'. ` +
            'There is no refresh grant: the issued token does not expire, so there is nothing ' +
            'to refresh.',
        )
      }
      const issued = await server.redeemCode({
        code: form.get('code') ?? '',
        clientId: form.get('client_id') ?? '',
        ...(form.get('redirect_uri') ? { redirectUri: form.get('redirect_uri') as string } : {}),
        codeVerifier: form.get('code_verifier') ?? '',
      })
      requestLogger(c).info('mcp authorization token issued', { keyId: issued.keyId })
      // `expires_in` is ABSENT rather than a large number, and the difference is the whole honesty
      // of the token model: RFC 6749 §5.1 makes it optional precisely so a server that issues a
      // non-expiring token says so by omission. A generous number here would have every client
      // schedule a refresh this server does not serve.
      return c.json(
        { access_token: issued.accessToken, token_type: 'Bearer', scope: issued.scope },
        200,
        // RFC 6749 §5.1 requires both: this body is a bearer credential, and a cache between the
        // host and this deployment holding it is the one storage nobody can revoke.
        { 'cache-control': 'no-store', pragma: 'no-cache' },
      )
    } catch (error) {
      return oauthErrorResponse(c, error)
    }
  })

  return app
}

/** This deployment's own origin, taken from the request being answered. */
function originOf<E extends AppEnv>(c: Context<E>): string {
  return new URL(c.req.url).origin
}

/**
 * A metadata document, cacheable and readable cross-origin.
 *
 * The `*` is on THESE two routes alone, and it is not a widening of the deployment's CORS policy:
 * both are public, credential-free documents whose whole purpose is to be read by a client that has
 * no relationship with this deployment yet, and a browser-hosted MCP client (the case this feature
 * exists for) cannot start the flow without reading them. Every route that accepts or issues a
 * credential keeps the deployment's configured allowlist.
 */
function metadataResponse<E extends AppEnv>(c: Context<E>, document: Record<string, unknown>) {
  return c.json(document, 200, {
    'cache-control': 'public, max-age=300',
    'access-control-allow-origin': '*',
  })
}

/**
 * The OAuth error body, at the status the protocol assigns.
 *
 * `invalid_client` is a 401 and everything else a 400 (RFC 6749 §5.2). Anything that is NOT a
 * protocol error is re-thrown to `handleError`, which is the whole point of narrowing here: an
 * unexpected fault must keep its correlation id and its 500 rather than being flattened into a
 * protocol code no client can act on.
 */
function oauthErrorResponse<E extends AppEnv>(c: Context<E>, error: unknown) {
  if (!(error instanceof McpOAuthProtocolError)) throw error
  requestLogger(c).warn('mcp authorization refused', {
    oauthError: error.oauthError,
    ...describeError(error),
  })
  return c.json(
    { error: error.oauthError, error_description: error.message },
    error.oauthError === 'invalid_client' ? 401 : 400,
  )
}

/** A JSON request body, or an empty object: a malformed one is refused by the validation below it. */
async function readJsonBody<E extends AppEnv>(c: Context<E>): Promise<Record<string, unknown>> {
  try {
    const body = (await c.req.json()) as unknown
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    // silent-catch-ok: an unparseable body reaches the same refusal an empty one does, and that
    // refusal names the missing field, which is more use than "invalid JSON" to whoever sent it.
    return {}
  }
}

/**
 * A token-request body, from either encoding.
 *
 * OAuth specifies `application/x-www-form-urlencoded` and that is what most clients send, but JSON
 * is common enough in MCP hosts that refusing it would be refusing working clients over a content
 * type. Read through one accessor so the handler above states each field once.
 */
async function readFormBody<E extends AppEnv>(
  c: Context<E>,
): Promise<{ get: (name: string) => string | undefined }> {
  const contentType = c.req.header('content-type') ?? ''
  const values = contentType.includes('json')
    ? await readJsonBody(c)
    : Object.fromEntries(new URLSearchParams(await c.req.text()))
  return {
    get: (name) => {
      const value = (values as Record<string, unknown>)[name]
      return typeof value === 'string' && value.length > 0 ? value : undefined
    },
  }
}
