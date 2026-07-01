import { connectMothershipContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { HmacSigner, type SessionPayload, TOKEN_AUDIENCE } from '../../auth/signing.js'
import type { AppEnv } from '../../http/env.js'

/**
 * Local-mode mothership login: `POST /local/mothership/connect`.
 *
 * A mothership-mode local node has no static machine token — instead the SPA signs the user
 * into the MOTHERSHIP (OAuth), captures the returned session from the redirect fragment (which
 * only the browser can read), and hands it to its OWN node here (same origin — no CORS). The
 * node forwards the session to the mothership's `/auth/machine-token`, caches the returned
 * OPAQUE machine token in its local store, and reports the resulting account scope. Subsequent
 * `/internal/persistence` calls read the cached token.
 *
 * Wired only on the local-mode facade (the `mothershipConnect` seam) — 503 elsewhere. Local mode
 * runs with the auth gate open on the developer's own machine, so the security boundary is that
 * the forwarded session must itself be a valid mothership session (else the mint 403s): a token
 * this endpoint caches can only ever be one the mothership was willing to mint for that session.
 */
export function mothershipConnectController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, connectMothershipContract, async (c) => {
    const connector = c.get('container').mothershipConnect
    if (!connector) {
      return c.json(
        {
          error: {
            code: 'unavailable',
            message: 'Mothership connect is only available on a mothership-mode local node',
          },
        },
        503,
      )
    }
    const { session } = c.req.valid('json')
    const result = await connector.connect(session)
    if (!result.ok) {
      // A rejected session (the user must re-login) surfaces as 403; anything else (the mothership
      // unreachable / a malformed mint response) is an upstream failure (502).
      const isAuth = result.status === 401 || result.status === 403
      return c.json(
        { error: { code: isAuth ? 'forbidden' : 'unavailable', message: result.message } },
        isAuth ? 403 : 502,
      )
    }
    // Mint a LOCAL session (this node's own secret) for the connected user, so the SPA is signed
    // into its own node — the mothership session it forwarded is signed with the MOTHERSHIP's
    // secret and cannot be verified here.
    const cfg = c.get('container').config.auth
    const local: SessionPayload = {
      ...result.user,
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + cfg.sessionTtlMs,
    }
    const sessionToken = await new HmacSigner(cfg.sessionSecret).sign(local)
    return c.json(
      { accountIds: result.accountIds, exp: result.exp, session: sessionToken, user: result.user },
      200,
    )
  })

  return app
}
