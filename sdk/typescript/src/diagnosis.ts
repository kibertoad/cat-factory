// What a transport failure actually was, and what the client already knows about the origin.
//
// The problem this exists for: on Node a transport failure's own message is the contentless
// `fetch failed`, identical for an unreachable host, a bad cert and a DNS typo, and the SDK used
// to render every one of them as `failed to reach <baseUrl>`. That sentence is a verdict about
// REACHABILITY, and it is the one provably false reading when the deployment answered nine calls
// two hundred milliseconds earlier and then restarted: it sends the reader to the boot log, the
// database and the CORS config before the transport is ever suspected.
//
// So the SDK says which cause it was, and drops the reachability claim when the cause does not
// support it. The two facts needed for that are already here: the CAUSE hangs off the thrown
// value's chain, and the HISTORY belongs to the client instance that made the earlier calls.
//
// A PORT of the platform's own `ConnectionFailureCause` vocabulary (kernel's
// `connection-failure.logic.ts`, owned by `@cat-factory/contracts`), not an import of it. This SDK
// declares no dependencies by design, so reaching across that boundary is not available.
//
// What keeps the copy honest is `scripts/check-sdk-connection-causes.mjs`, a repo-level guard that
// reads the contracts picklist and all four ported lists and fails on any disagreement. It has to
// be a guard rather than a test in here: a test in this package cannot see the picklist, so it
// could only restate the list a second time and would stay green through the exact drift that
// matters. What each cause is MATCHED ON below is this runtime's own business, and is pinned by
// `test/diagnosis.test.ts`.

/**
 * Why a request never produced a response. `unknown` is a real member: an unrecognised chain is
 * reported as itself rather than guessed onto a cause, because a wrong cause is what sends a
 * reader to fix something that was never broken.
 */
export type TransportFailureCause =
  | 'refused'
  | 'dns'
  | 'timeout'
  | 'aborted'
  | 'unreachable'
  | 'reset'
  | 'tls-untrusted'
  | 'tls-expired'
  | 'tls-hostname'
  | 'tls-protocol'
  | 'invalid-header'
  | 'unknown'

/** What this client has seen from the origin, which is what tells a restart from a bad address. */
export interface OriginHistory {
  /** Requests that produced a RESPONSE, of any status: each one proves the origin answered. */
  completedCalls: number
  /** When the last of them answered (epoch ms), or null when none has. */
  lastCompletedAt: number | null
}

/** The codes and DOM names each cause is recognised by, deliberately the platform's own list. */
const CAUSE_CODES: Record<Exclude<TransportFailureCause, 'unknown'>, readonly string[]> = {
  refused: ['ECONNREFUSED'],
  dns: ['ENOTFOUND', 'EAI_AGAIN'],
  timeout: [
    'TimeoutError',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ],
  aborted: ['AbortError', 'UND_ERR_ABORTED'],
  unreachable: ['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN'],
  reset: ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'],
  'tls-untrusted': [
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_UNTRUSTED',
  ],
  'tls-expired': ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'],
  'tls-hostname': ['ERR_TLS_CERT_ALTNAME_INVALID'],
  'tls-protocol': [
    'EPROTO',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_PACKET_LENGTH_TOO_LONG',
    'ERR_SSL_UNEXPECTED_MESSAGE',
    'ERR_TLS_HANDSHAKE_TIMEOUT',
  ],
  'invalid-header': ['ERR_INVALID_CHAR', 'ERR_INVALID_HTTP_TOKEN', 'ERR_HTTP_INVALID_HEADER_VALUE'],
}

/**
 * The one cause recognised WITHOUT a code, matched on the whole wording each runtime uses rather
 * than a keyword: a header value carrying a control character is rejected before a socket is ever
 * opened, as a bare `TypeError`, and a credential pasted with a line break in it is exactly the
 * case a reader most needs named. A looser `invalid character` matches a JSON decode error, which
 * is one of the commonest things a proxy answers with.
 */
const INVALID_HEADER_TEXT = /invalid header value|invalid header field|invalid character in header/i

/** `fetch` wraps every transport error in this, and it says nothing at all. */
const CONTENTLESS_WRAPPER = 'fetch failed'

/** Bounded, because a chain a caller built can be cyclic or arbitrarily deep. */
const MAX_CHAIN_LINKS = 12

/**
 * Flatten a thrown value's whole cause chain, outermost first.
 *
 * `AggregateError.errors` is walked as well as `cause`: a host resolving to both `::1` and
 * `127.0.0.1` fails as an aggregate of two connection attempts, and the useful code is inside it.
 */
export function flattenCauseChain(error: unknown): unknown[] {
  const links: unknown[] = []
  const seen = new Set<unknown>()
  const queue: unknown[] = [error]
  while (queue.length > 0 && links.length < MAX_CHAIN_LINKS) {
    const link = queue.shift()
    if (link === undefined || link === null) continue
    if (typeof link === 'object') {
      if (seen.has(link)) continue
      seen.add(link)
    }
    links.push(link)
    const aggregated = (link as { errors?: unknown }).errors
    if (Array.isArray(aggregated)) queue.push(...aggregated)
    queue.push((link as { cause?: unknown }).cause)
  }
  return links
}

function errorCode(link: unknown): string | undefined {
  const code = (link as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : undefined
}

function classifyLink(link: unknown): TransportFailureCause | undefined {
  const code = errorCode(link)
  const name = link instanceof Error ? link.name : undefined
  for (const [cause, codes] of Object.entries(CAUSE_CODES)) {
    if (codes.some((candidate) => candidate === code || candidate === name)) {
      return cause as TransportFailureCause
    }
  }
  return undefined
}

/**
 * The cause of a whole chain, DEEPEST-FIRST, because depth is specificity order: a mid-handshake
 * `DEPTH_ZERO_SELF_SIGNED_CERT` arrives wrapped in a socket error that is itself a recognised
 * `reset`, so taking the first match in walk order answers with the wrapper and sends the reader
 * looking for a proxy instead of pasting a CA bundle.
 *
 * The text pass runs only after EVERY link failed to produce a code: a message match is a guess
 * where a code is a fact, and it must never outrank one.
 */
export function classifyTransportFailure(error: unknown): TransportFailureCause {
  const deepestFirst = flattenCauseChain(error).reverse()
  for (const link of deepestFirst) {
    const byCode = classifyLink(link)
    if (byCode) return byCode
  }
  for (const link of deepestFirst) {
    if (link instanceof Error && INVALID_HEADER_TEXT.test(link.message)) return 'invalid-header'
  }
  return 'unknown'
}

/** Render the chain as the runtime reported it, leading with the link that names the failure. */
export function renderCauseChain(error: unknown): string {
  const parts: string[] = []
  for (const link of flattenCauseChain(error)) {
    const text = link instanceof Error ? link.message : String(link)
    const trimmed = text.trim()
    if (!trimmed || parts.includes(trimmed)) continue
    parts.push(trimmed)
  }
  // Drop the contentless wrapper, but only when something else survives it: an empty diagnosis is
  // worse than an uninformative one.
  const meaningful = parts.filter((part) => part !== CONTENTLESS_WRAPPER)
  return (meaningful.length > 0 ? meaningful : parts).join(': ')
}

/** The host a base URL names, for a sentence about DNS or a certificate. Falls back to the URL. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl
  } catch {
    return baseUrl
  }
}

/**
 * What happened, in the caller's terms. Every sentence states only what the cause supports: a
 * refusal names a port with nothing behind it, a reset names an origin that WAS there, and a
 * request rejected before a socket was opened claims nothing about the origin at all.
 */
function verdictFor(cause: TransportFailureCause, baseUrl: string): string {
  switch (cause) {
    case 'refused':
      return `nothing is listening at ${baseUrl}`
    case 'dns':
      return `the host ${hostOf(baseUrl)} does not resolve from here`
    case 'timeout':
      return `${baseUrl} did not answer before the connection timed out`
    case 'aborted':
      return `the request was cancelled before an answer arrived, so nothing was learned about ${baseUrl}`
    case 'unreachable':
      return `there is no network route to ${baseUrl} from here`
    case 'reset':
      return `${baseUrl} reset the connection before answering`
    case 'tls-untrusted':
      return `${baseUrl} presented a TLS certificate this client does not trust`
    case 'tls-expired':
      return `the TLS certificate ${baseUrl} presented is outside its validity window`
    case 'tls-hostname':
      return `the TLS certificate ${baseUrl} presented was not issued for ${hostOf(baseUrl)}`
    case 'tls-protocol':
      return `the TLS handshake with ${baseUrl} failed, which is what a plain-HTTP port answers when it is addressed over https`
    case 'invalid-header':
      return 'the request could not be built, because a header value holds a character that is not allowed in one'
    case 'unknown':
      return `the request to ${baseUrl} ended before any response arrived`
  }
}

/** `0.2s`, `12.5s`, `4m`: precise where a restart is being told from a long-dead origin. */
function renderAge(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  return `${Math.round(seconds / 60)}m`
}

/**
 * What this client already knows about the origin, which is the half that separates a deployment
 * that restarted from one that was never there. Stated in both directions: "answered nothing yet"
 * is evidence too, and it is what points at the address rather than at the deployment.
 */
function historyFor(history: OriginHistory, baseUrl: string, now: number): string {
  if (history.completedCalls === 0 || history.lastCompletedAt === null) {
    return ` This client has not completed a call against ${baseUrl} yet.`
  }
  const calls = history.completedCalls === 1 ? '1 call' : `${history.completedCalls} calls`
  return ` This client had answered ${calls} against ${baseUrl}, the last ${renderAge(now - history.lastCompletedAt)} ago.`
}

/**
 * The whole message a {@link CatFactoryConnectionError} carries: what happened, what this client
 * knows about the origin, and the exact chain the runtime reported, in that order.
 *
 * The chain stays LAST and stays verbatim. It is the evidence, and a reader who disagrees with the
 * classification needs it unedited.
 */
export function describeTransportFailure(input: {
  method: string
  path: string
  baseUrl: string
  error: unknown
  history: OriginHistory
  now: number
}): string {
  const cause = classifyTransportFailure(input.error)
  const detail = renderCauseChain(input.error)
  const evidence = detail ? ` (${detail})` : ''
  return `cat-factory SDK: ${input.method} ${input.path} failed: ${verdictFor(cause, input.baseUrl)}.${historyFor(input.history, input.baseUrl, input.now)}${evidence}`
}
