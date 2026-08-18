// ---------------------------------------------------------------------------
// What an MCP request LOOKS like, per protocol era, and how a refusal tells the two eras apart.
//
// Revision `2026-07-28` did not extend the protocol the probe was written against, it deleted its
// spine: there is no `initialize`, no `notifications/initialized` and no `Mcp-Session-Id`. A modern
// request instead carries its protocol version, client identity and client capabilities in `_meta`
// on EVERY call, mirrors its method into an `Mcp-Method` header, and asks a dedicated
// `server/discover` RPC for the identity the handshake used to return. The spec's own compatibility
// matrix rates a legacy client against a modern server as "Fails", with no fall-forward, which is
// why speaking only the old dialect is a break rather than drift.
//
// Both eras are still live in the wild, so the probe is DUAL-ERA: it opens modern and falls back,
// which is the direction the spec prescribes for Streamable HTTP (attempt a modern request, inspect
// the body of a 4xx before falling back). This module owns the two dialects as pure functions, so
// the transport beside it stays about fetch, redirects and body reading.
//
// Read 2026-08-18:
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
//   https://modelcontextprotocol.io/specification/2026-07-28/server/discover
// ---------------------------------------------------------------------------

/** The modern revision the probe opens with. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

/**
 * Every modern revision this client can speak, newest first. A server answering
 * `UnsupportedProtocolVersionError` lists what it supports, and this is what that list is
 * intersected against: a version outside it is one whose per-request shape we have not implemented,
 * so agreeing to it would be a handshake we could not follow.
 */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION]

/** The legacy revision the fallback handshake asks for. Negotiated, so a server may answer older. */
export const LEGACY_PROTOCOL_VERSION = '2025-11-25'

/** The `_meta` keys the modern revision reserves. Prefixed by the spec, not by us. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

/**
 * The MCP error codes the spec reserves for itself, which is what makes a 400 readable as "a modern
 * server refused this" rather than "an older server did not understand it". `-32601` is deliberately
 * NOT here: it is JSON-RPC's own "method not found", which a legacy server answers to
 * `server/discover` precisely because it is not modern.
 */
const HEADER_MISMATCH = -32020
const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021
const UNSUPPORTED_PROTOCOL_VERSION = -32022

/** What the probe identifies itself as, on every modern request and in the legacy handshake. */
export const CLIENT_INFO = { name: 'cat-factory-tool-server-probe', version: '1' } as const

/** Which dialect the exchange is speaking. Decided once per server, then held for every request. */
export type McpEra = { era: 'modern'; version: string } | { era: 'legacy' }

export const MODERN_ERA = {
  era: 'modern',
  version: MODERN_PROTOCOL_VERSION,
} as const satisfies McpEra
export const LEGACY_ERA = { era: 'legacy' } as const satisfies McpEra

/**
 * The params one request carries.
 *
 * Modern: the caller's params plus the `_meta` block, on EVERY request rather than once at a
 * handshake. `clientCapabilities: {}` is honest and load-bearing, exactly as the legacy
 * `capabilities: {}` was: this client implements no roots, no sampling and no elicitation.
 */
export function requestParams(
  era: McpEra,
  params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (era.era === 'legacy') return params
  return {
    ...params,
    _meta: {
      [META_PROTOCOL_VERSION]: era.version,
      [META_CLIENT_INFO]: CLIENT_INFO,
      [META_CLIENT_CAPABILITIES]: {},
    },
  }
}

/**
 * The headers the dialect adds to a POST.
 *
 * `Mcp-Method` is REQUIRED on every modern request and is validated against the body under penalty
 * of `-32020 HeaderMismatch`, so it is derived from the method rather than passed beside it.
 * `Mcp-Name` is required only for `tools/call`, `resources/read` and `prompts/get`: a probe calls
 * none of them, and sending a name for a method that has none is itself a mismatch.
 * `MCP-Protocol-Version` must equal the body's `_meta` version, which is why both read the same
 * `era.version`.
 */
export function dialectHeaders(era: McpEra, method: string): Record<string, string> {
  if (era.era === 'legacy') return {}
  return { 'mcp-protocol-version': era.version, 'mcp-method': method }
}

/** The `initialize` params of the legacy handshake. */
export function legacyInitializeParams(): Record<string, unknown> {
  return {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }
}

export interface ServerIdentity {
  serverName: string
  serverVersion: string
}

/**
 * The server's self-reported identity out of a modern result's `_meta`, or undefined when it sent
 * none. Only SHOULD-level in the modern revision, so its absence is not a fault: it is a name the
 * surface renders, and refusing an otherwise complete probe over a missing display string would
 * report a working server as broken.
 */
export function readModernServerInfo(result: Record<string, unknown>): ServerIdentity | undefined {
  const meta = isRecord(result._meta) ? result._meta : undefined
  const info = meta && isRecord(meta[META_SERVER_INFO]) ? meta[META_SERVER_INFO] : undefined
  if (!info) return undefined
  return {
    serverName: typeof info.name === 'string' ? info.name : '',
    serverVersion: typeof info.version === 'string' ? info.version : '',
  }
}

/**
 * A `server/discover` result, or undefined when the answer was not one. `supportedVersions` is the
 * field that makes the answer PROOF of a modern MCP server: a JSON-RPC endpoint that is something
 * else entirely answers 200 with a result that has none, and that is the case the caller must not
 * read as a successful probe.
 */
export function readDiscoverResult(
  result: Record<string, unknown>,
): { supportedVersions: string[]; identity?: ServerIdentity } | undefined {
  const versions = result.supportedVersions
  if (!Array.isArray(versions)) return undefined
  const identity = readModernServerInfo(result)
  return {
    supportedVersions: versions.filter((v): v is string => typeof v === 'string'),
    ...(identity ? { identity } : {}),
  }
}

/** What a refused modern attempt means for which dialect to speak next. */
export type EraVerdict =
  /** A modern server refused the VERSION and named what it speaks. Retry with this one. */
  | { verdict: 'retry'; version: string }
  /** The refusal is a modern server's, and no version we speak is on offer. Report it. */
  | { verdict: 'report'; error: string }
  /** Nothing modern answered. Fall back to the `initialize` handshake. */
  | { verdict: 'legacy' }

/**
 * Read a refusal of the modern `server/discover` and decide what it says about the server's ERA.
 *
 * The spec's rule for Streamable HTTP is to attempt a modern request and inspect the BODY of a 4xx,
 * because a modern server also answers 400 for an unsupported version, a missing client capability
 * and a header mismatch. This widens that in one direction the spec's prose does not spell out but
 * its own compatibility matrix does: a legacy server may refuse an unknown method at HTTP 200 with
 * a JSON-RPC `-32601`, or refuse it as "not initialized", and neither is a 4xx. Every refusal that
 * is not one of the three MCP-reserved codes therefore means "not modern", and the fallback is what
 * decides whether the server is legacy or not an MCP server at all.
 */
export function readEraVerdict(frame: Record<string, unknown> | undefined): EraVerdict {
  const error = frame && isRecord(frame.error) ? frame.error : undefined
  const code = typeof error?.code === 'number' ? error.code : undefined
  if (code === UNSUPPORTED_PROTOCOL_VERSION) {
    const supported =
      isRecord(error?.data) && Array.isArray(error.data.supported)
        ? error.data.supported.filter((v): v is string => typeof v === 'string')
        : []
    const mutual = MODERN_PROTOCOL_VERSIONS.find((version) => supported.includes(version))
    if (mutual) return { verdict: 'retry', version: mutual }
    // The server is modern and speaks none of our revisions. Falling back to `initialize` here
    // would ask a server that just NAMED its versions for one it did not name, so the honest
    // answer is the mismatch itself, with both sides listed.
    return {
      verdict: 'report',
      error:
        `the server supports MCP ${supported.join(', ') || '(none named)'} and this deployment ` +
        `speaks ${[...MODERN_PROTOCOL_VERSIONS, LEGACY_PROTOCOL_VERSION].join(', ')}`,
    }
  }
  if (code === HEADER_MISMATCH || code === MISSING_REQUIRED_CLIENT_CAPABILITY) {
    // A modern server refusing a modern request on grounds this client controls. Reported rather
    // than retried: the fix is here, and falling back would hide it behind a legacy handshake.
    const message = typeof error?.message === 'string' ? error.message : `JSON-RPC error ${code}`
    return { verdict: 'report', error: `the server refused the request: ${message}` }
  }
  return { verdict: 'legacy' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
