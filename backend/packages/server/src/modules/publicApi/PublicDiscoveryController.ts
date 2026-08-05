import { getPublicIdentityContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { OPENAPI_JSON } from './openapiDocument.generated.js'
import { authorize, refuse } from './publicApiAuth.js'

// DISCOVERY: the two calls an integration makes before it does anything — what am I, and what is
// this API? Both were holes a caller worked around by guessing:
//
//  - `GET /api/v1/me` answers what the calling key may do. Without it, "can I do X" was answerable
//    only by attempting X and reading the `403`, which for a destructive operation is not a check.
//  - `GET /api/v1/openapi.json` serves the deployment's own spec, so a client is generated against
//    the surface it will actually call rather than against whatever copy of the repo file someone
//    found. It matters most where the two can differ: a deployment a release behind.
//
// Their own controller rather than two more routes on `PublicApiController`, which is at the size
// where the ratchet says split rather than grow. The seam is cohesive: neither reads any workspace
// state, so this controller needs none of the engine the board/job routes are built around.

export function publicDiscoveryController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getPublicIdentityContract, async (c) => {
    // `read` is the FLOOR, not a judgement about sensitivity: an integration's startup check must
    // work whatever rung it holds, and everything answered here is a property of the credential
    // the caller just presented.
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const { keyId, accountId, workspaceId, scope, label, createdAt } = gate.auth
    // Straight off the auth result: `authenticate` already loaded the row, so self-description
    // costs no read of its own.
    return c.json({ keyId, accountId, workspaceId, scope, label, createdAt }, 200)
  })

  // Hand-mounted rather than contract-driven, for the reason the hosted MCP endpoint is: it has no
  // honest OPERATION shape. Its response is an OpenAPI document, whose schema is "any JSON object",
  // and describing it in the spec would mint a method in four generated SDKs that returns an
  // untyped blob — plus an MCP tool that pours 360 KB of schema into a model's context to tell it
  // about tools it already has. It is PUBLIC SURFACE under the stability contract all the same;
  // `backend/docs/public-api.md` carries that obligation in the spec's place.
  //
  // AUTHENTICATED like every other `/api/v1` route. The document describes only the public API and
  // leaks no workspace state, but an unauthenticated route here would be the one endpoint whose
  // presence a probe could confirm without a key, and the spec is the map of everything else.
  app.get('/api/v1/openapi.json', async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    // The bytes verbatim, never a re-serialised parse: the committed document and the served one
    // are the same string, so a client generated from either cannot find a difference.
    return c.body(OPENAPI_JSON, 200, { 'content-type': 'application/json; charset=utf-8' })
  })

  return app
}
