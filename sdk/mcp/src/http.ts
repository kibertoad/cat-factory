import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CatFactoryMcpOptions } from './config.ts'
import { createCatFactoryMcpServer } from './server.ts'

// The HOSTED half: the same server, reached over HTTP instead of a spawned process.
//
// A deployment mounts this on one route and its callers need no install, no local process and no
// long-lived key in a host's config file. It is the same `createCatFactoryMcpServer` the stdio
// binary builds — same generated tool table, same result rendering, same instructions — so the two
// access paths cannot answer differently about what the deployment can do.
//
// It lives HERE rather than in the backend that mounts it for two reasons. The MCP SDK's types
// reach for Node's, and the backend's HTTP layer is deliberately typed against the Web platform
// alone so it cannot break on workerd; and a hosted endpoint is a thing any deployment of this API
// should be able to stand up, not a private detail of ours.
//
// This module is also the package's `./http` ENTRY POINT, and mounting code should import it rather
// than the root. The root re-exports the stdio boot beside this, which drags
// `@modelcontextprotocol/sdk/server/stdio.js` and its `node:process` import into whatever bundles it:
// harmless on Node, dead weight in a Worker, and a build failure on any runtime whose `node:`
// shimming is narrower. Nothing reached from here imports a Node built-in at all
// (`test/runtime-neutral.test.ts` pins it), so this entry is the one that is honestly portable.
//
// `WebStandardStreamableHTTPServerTransport`, NOT the `StreamableHTTPServerTransport` beside it:
// that one is a wrapper over Node's `IncomingMessage`/`ServerResponse`, so a facade on a Worker
// runtime could not mount it, and "the hosted endpoint exists on one runtime" is exactly the
// facade asymmetry this platform treats as a showstopper.

/** How a deployment mounts the hosted endpoint. */
export interface HostedMcpOptions extends CatFactoryMcpOptions {
  /**
   * Report a transport-level fault (a malformed frame, a write to a stream that went away).
   *
   * These never reach the caller — the transport has already answered by the time it fires — so
   * without this they are lost, and a client reporting "the MCP endpoint is broken" leaves nothing
   * behind to read. A mount points this at its own logger.
   */
  onTransportError?: (error: Error) => void
}

/**
 * Serve ONE Streamable-HTTP request against a freshly built server.
 *
 * STATELESS, per request, on purpose. A session-keyed server holds its state in the memory of the
 * process that minted the session id, and neither runtime this has to serve can promise the next
 * request lands there: a Worker request gets whichever isolate the edge picks, and a Node
 * deployment scaled past one instance has the same problem without sticky routing. So a stateful
 * endpoint works on a developer's single process and fails intermittently in production, which is
 * the worst shape a bug can take. Nothing here needs the state anyway: every tool call is one
 * key-authenticated HTTP call, and the server pushes nothing between them.
 *
 * `enableJsonResponse` follows from the same choice. With no server-initiated messages there is
 * nothing for an SSE stream to carry, and holding one open on a request-scoped runtime costs a
 * connection to deliver nothing.
 */
export async function handleMcpHttpRequest(
  request: Request,
  options: HostedMcpOptions,
): Promise<Response> {
  const { server } = createCatFactoryMcpServer(options)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  if (options.onTransportError) transport.onerror = options.onTransportError
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } finally {
    // Closes the transport with it. In JSON-response mode `handleRequest` has already resolved the
    // complete `Response`, so there is no stream left for this to cut short.
    await server.close()
  }
}

/**
 * The refusal for a method this endpoint does not answer, or null for the one it does (`POST`).
 *
 * `GET` is a client asking to open a server-to-client SSE stream and `DELETE` is it ending a session;
 * a stateless, JSON-answering endpoint has neither. Both are refused HERE rather than passed to the
 * transport, which would field a `GET` by opening a stream that nothing will ever write to and then
 * keeping it alive with heartbeats.
 *
 * `405` with `Allow`, in the transport's OWN error shape (`handleUnsupportedRequest` answers a `PUT`
 * with byte-identical bytes), because the caller here is a protocol client rather than an API client:
 * it reads a JSON-RPC error frame and it reads the `Allow` header, and the spec names 405 as the way
 * an endpoint says it offers no stream. A mount rendering this in its own error envelope would give
 * the endpoint two answer shapes and lose the header.
 */
export function refuseMcpMethod(method: string): Response | null {
  if (method === 'POST') return null
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'Method not allowed. This MCP endpoint answers JSON-RPC over POST only: it is stateless ' +
          'and returns a JSON response per request, so there is no event stream to GET and no ' +
          'session to DELETE.',
      },
      id: null,
    }),
    { status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json' } },
  )
}
