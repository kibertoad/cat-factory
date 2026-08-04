// The `./http` entry point, NOT the package root: the root re-exports the stdio boot, whose
// transport imports `node:process`, and this package is bundled into the Worker facade.
import { handleMcpHttpRequest, refuseMcpMethod } from '@cat-factory/mcp-server/http'
import { describeError } from '@cat-factory/kernel'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import type { AppLoopback } from '../../http/loopback.js'
import { requestLogger } from '../../http/requestLogging.js'
import { authorizeOrThrow, bearerToken } from './publicApiAuth.js'

// The HOSTED MCP endpoint (`POST /api/v1/mcp`): the public API spoken as Model Context Protocol, so
// a host reaches this deployment with no install.
//
// Until now the only way to drive cat-factory from a model was `npx @cat-factory/mcp-server`: an npm
// dependency, a local process per host, and a long-lived key sitting in the host's config file. That
// rules out every host that cannot spawn one — claude.ai, a hosted agent, a phone — which is most of
// where people actually work. This is the SAME server behind an HTTP transport, so those hosts need a
// URL and a key and nothing else. The stdio binary stays: it is the path that needs no backend
// deployment at all, and the only one for a host with no HTTP MCP support.
//
// The protocol implementation is `@cat-factory/mcp-server`'s, deliberately. This controller decides
// three things and nothing else: who is calling, what their key's scope means for the tool list, and
// where the tools' own API calls go. Everything a tool DOES is one `/api/v1` request under the
// caller's own key through the loopback, so this surface cannot drift from the surface it exposes and
// no capability exists here that the caller could not have reached with `curl`.
//
// NOT an OpenAPI operation, unlike every other `/api/v1` route. A JSON-RPC endpoint has no operation
// shape to describe (one path, one verb, a union of dozens of method bodies), and adding it to the
// spec would mint an SDK method in four languages for a protocol none of those clients speaks. It is
// PUBLIC SURFACE under the stability contract from its first release all the same;
// `backend/docs/public-api.md` carries that obligation in the spec's place.
//
// Two refusal shapes, and the split is the caller's own: an auth failure is HTTP-level in the MCP
// spec (the client reads the status), so it throws and `handleError` renders the deployment's error
// envelope with its correlation id and machine-readable reason. A method refusal is the TRANSPORT's
// vocabulary, so it is answered in the transport's own JSON-RPC frame by `refuseMcpMethod`.

export function publicMcpController<E extends AppEnv>(loopback: AppLoopback<E>): Hono<E> {
  const app = new Hono<E>()

  // Every verb on one handler, so a `GET` gets the protocol's "no stream here" rather than Hono's
  // bare 404, which a client reads as "no MCP endpoint at this URL".
  app.all('/api/v1/mcp', async (c) => {
    const refused = refuseMcpMethod(c.req.method)
    if (refused) return refused

    // `read` is the FLOOR, not a per-tool requirement: the ladder is inclusive, so this refuses only
    // an absent, unknown or revoked key. What each tool may do stays enforced where it already is, by
    // the `/api/v1` handler the loopback reaches — a scope table restated here would be a second
    // authority on the same question, free to disagree with the first.
    const auth = await authorizeOrThrow(c, 'read')
    const log = requestLogger(c)

    return handleMcpHttpRequest(c.req.raw, {
      // The deployment's own origin, taken from the request being answered: the tools resolve their
      // paths against it, and it is the one value that is right on a preview URL, a custom domain and
      // a test harness alike.
      baseUrl: new URL(c.req.url).origin,
      // Forwarded verbatim, so the tools authenticate as the CALLER rather than as the deployment.
      // That is what keeps the workspace scoping and the per-tool scope ladder applying unchanged.
      // Non-empty by construction: the gate above authenticated THIS value, so the fallback is
      // unreachable rather than a default standing in for a missing key.
      apiKey: bearerToken(c) ?? '',
      fetch: (input, init) => loopback(new Request(input, init), c),
      // A `read` key can only be REFUSED by a write tool, so listing the writes would spend a model's
      // turns discovering that. The reason rides along because the fix is a wider key rather than an
      // operator's edit, and the server's instructions name the right one.
      ...(auth.scope === 'read' ? { readOnly: true, readOnlyReason: 'key-scope' as const } : {}),
      onTransportError: (error) => {
        // The transport has already answered by the time this fires, so a drop here leaves a caller
        // reporting a broken endpoint and nothing on this side to read. Through `describeError`
        // rather than `error.message`: it binds the kind alongside the message and scrubs through
        // `redactSecrets`, and the request this fault interrupted was carrying a live API key.
        log.warn('Hosted MCP transport error', describeError(error))
      },
    })
  })

  return app
}
