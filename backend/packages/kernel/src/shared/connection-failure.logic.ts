import { redactSecrets } from './redact-secrets.logic.js'

// What a failed connection PROBE tells the operator. Every "Test connection" button in the
// product ends in a `fetch` that either answered (an HTTP status, which each provider maps
// itself) or threw. This module owns the threw half.
//
// The problem it exists for: on Node/undici a transport failure surfaces as
// `TypeError: fetch failed`, and the thing that actually happened (`connect ECONNREFUSED
// 127.0.0.1:6443`, `self-signed certificate`, `getaddrinfo ENOTFOUND`) hangs off `.cause`, or
// off an `AggregateError`'s `.errors`, which is what a host resolving to both `::1` and
// `127.0.0.1` produces. Reading `error.message` therefore renders the single least informative
// string in the chain, and "fetch failed" is what the connect form showed for every one of
// those causes alike.
//
// So: flatten the chain to name the EXACT failure, and add a hint for the ones whose fix is
// knowable. The two halves stay separate. The detail is what happened and is always reported;
// the hint is what to do about it and is present only for a RECOGNISED cause, because a
// guessed remedy for an unrecognised failure sends the operator somewhere wrong.

/**
 * The transport-level failure classes worth telling apart, because each has a DIFFERENT fix.
 * `unknown` is a real member: it means the chain was read and matched nothing, which is why
 * such a caller gets a detail with no hint rather than a hint that fits some other failure.
 */
export type ConnectionFailureCause =
  | 'refused'
  | 'dns'
  | 'timeout'
  | 'unreachable'
  | 'reset'
  | 'tls-untrusted'
  | 'tls-expired'
  | 'tls-hostname'
  | 'tls-protocol'
  | 'invalid-header'
  | 'unknown'

/** Who/what the probe was trying to reach, so a hint can name it instead of saying "the server". */
export interface ConnectionFailureContext {
  /** Noun phrase for the thing probed, e.g. `the Kubernetes apiserver`. Defaults to `the server`. */
  subject?: string
  /** The concrete address probed, e.g. `https://127.0.0.1:6443`. Named in a hint when known. */
  target?: string
}

export interface ConnectionFailureDescription {
  cause: ConnectionFailureCause
  /** The flattened, scrubbed cause chain: exactly what the runtime reported. */
  detail: string
  /** What to do about it; absent when the cause is not one we recognise. */
  hint?: string
}

/** Cap on the rendered cause chain, so a pathological nested error can't flood the UI. */
const MAX_DETAIL_CHARS = 400
/** Cap on how far down `cause` / `errors` the walk goes. */
const MAX_CHAIN_DEPTH = 6

/** An error-shaped value's `code`, which Node puts the useful identifier on. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : undefined
}

/** The `errors` array an `AggregateError` carries (one entry per attempted address). */
function aggregated(error: unknown): unknown[] {
  const errors = (error as { errors?: unknown } | null)?.errors
  return Array.isArray(errors) ? errors : []
}

/**
 * Every link of the failure, outermost first: `.cause` chained, plus each branch of an
 * `AggregateError`. Both are walked because they carry different information. The chain holds
 * the specific cause; the aggregate holds one entry PER RESOLVED ADDRESS, and "refused on ::1,
 * never attempted on 127.0.0.1" is a different diagnosis from "refused on both".
 */
function flatten(error: unknown, depth = 0, out: unknown[] = []): unknown[] {
  if (error === null || error === undefined || depth > MAX_CHAIN_DEPTH) return out
  out.push(error)
  for (const branch of aggregated(error)) flatten(branch, depth + 1, out)
  flatten((error as { cause?: unknown }).cause, depth + 1, out)
  return out
}

/**
 * A TRANSPORT `code`, as Node and undici spell them (`ECONNREFUSED`, `ERR_TLS_CERT_ALTNAME_INVALID`,
 * `UND_ERR_CONNECT_TIMEOUT`). Deliberately narrow: our own `DomainError`s also carry a `code`, but
 * theirs is a lowercase status class (`validation`), which identifies nothing about a connection
 * and would render as a baffling `(validation)` glued onto an already-complete sentence.
 */
const TRANSPORT_CODE = /^[A-Z][A-Z0-9_]*$/

/** One link's human text: its message, with the transport `code` appended when the message omits it. */
function describeLink(link: unknown): string {
  const message = link instanceof Error ? link.message : String(link)
  const code = errorCode(link)
  const text = message.trim()
  if (!code || !TRANSPORT_CODE.test(code)) return text || code || ''
  if (!text) return code
  return text.includes(code) ? text : `${text} (${code})`
}

/**
 * The codes/names each cause is recognised by. Matched against every link's `code` and, for the
 * DOM-side timeout, its `name`: `AbortSignal.timeout()` rejects with a `DOMException` named
 * `TimeoutError` that carries no `code` at all.
 */
const CAUSE_CODES: Record<Exclude<ConnectionFailureCause, 'unknown'>, readonly string[]> = {
  refused: ['ECONNREFUSED'],
  dns: ['ENOTFOUND', 'EAI_AGAIN'],
  timeout: [
    'TimeoutError',
    'AbortError',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ],
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
 * The one cause recognised WITHOUT a code, matched on message text. undici rejects a header
 * value carrying a control character before it ever opens a socket, and the rejection is a bare
 * `TypeError` with no `code`. So a credential pasted with a line break in it would otherwise
 * fall through to `unknown`, which is the exact case an operator most needs named.
 */
const INVALID_HEADER_TEXT = /invalid header|header value|invalid character/i

/** Classify one link, or undefined when it matches nothing. */
function classifyLink(link: unknown): ConnectionFailureCause | undefined {
  const code = errorCode(link)
  const name = link instanceof Error ? link.name : undefined
  for (const [cause, codes] of Object.entries(CAUSE_CODES)) {
    if (codes.some((c) => c === code || c === name)) return cause as ConnectionFailureCause
  }
  const message = link instanceof Error ? link.message : ''
  if (INVALID_HEADER_TEXT.test(message)) return 'invalid-header'
  return undefined
}

/** `the Kubernetes apiserver` becomes `The Kubernetes apiserver`, for a hint that opens with it. */
function capitalize(subject: string): string {
  return subject.charAt(0).toUpperCase() + subject.slice(1)
}

/**
 * The remedy for a recognised cause. Written to name the ACTION rather than restate the
 * failure, which the detail already did: a hint that only rephrases it wastes the one line an
 * operator reads. Deliberately not localized, because the backend does not localize prose and
 * the machine-readable half a SPA would map is {@link ConnectionFailureDescription.cause}.
 */
function hintFor(cause: ConnectionFailureCause, ctx: ConnectionFailureContext): string | undefined {
  const subject = ctx.subject ?? 'the server'
  const at = ctx.target ? ` at ${ctx.target}` : ''
  const address = ctx.target ?? 'that address'
  switch (cause) {
    case 'refused':
      return `Nothing is listening${at}: the connection was actively refused. ${capitalize(subject)} is most likely not running, or is bound to a different host or port. Start it (or correct the address), then test again.`
    case 'dns':
      return `The host name in ${address} does not resolve from this deployment. Check it for a typo, and note that a cluster-internal DNS name is not resolvable from outside the cluster.`
    case 'timeout':
      return `${capitalize(subject)} did not answer before the probe timed out. Packets silently dropped by a firewall or security group look exactly like this (a refusal would have come back immediately), as does a host that is up but saturated.`
    case 'unreachable':
      return `There is no network route to ${address} from this deployment. Look at the VPN, peering or routing between the two rather than at the service itself.`
    case 'reset':
      return `The connection was opened and then closed before an answer arrived. A proxy in front of ${subject}, or a server expecting a different protocol on this port, is the usual cause.`
    case 'tls-untrusted':
      return `${capitalize(subject)} presented a TLS certificate this deployment does not trust. Paste its CA bundle into the CA certificate field, or, for a local or dev cluster with a self-signed certificate, enable "Skip TLS verification".`
    case 'tls-expired':
      return `The certificate ${subject} presented is outside its validity window. Renew it, or check that this host's clock is correct.`
    case 'tls-hostname':
      return `The certificate is valid but was not issued for the host in ${address}. Use the name the certificate names, or add that name to its subject alternative names.`
    case 'tls-protocol':
      return `The TLS handshake failed. This is what a PLAIN-HTTP port answers when it is addressed over https, so check the scheme and the port before suspecting the certificate.`
    case 'invalid-header':
      return `The request could not even be built, because a header value holds a character that is not allowed in one. A credential pasted with a line break or a stray space inside it is the usual cause: re-copy it as a single unbroken line.`
    case 'unknown':
      return undefined
  }
}

/**
 * Describe a thrown connection failure: the exact cause chain, plus the remedy when the cause is
 * one we recognise. Never throws, and never invents a cause. An unmatched chain is reported as
 * itself with no hint.
 */
export function describeConnectionFailure(
  error: unknown,
  ctx: ConnectionFailureContext = {},
): ConnectionFailureDescription {
  const links = flatten(error)
  // First match wins. The walk is outermost-first and the outermost link is the generic
  // wrapper, so this reliably lands on the innermost link that carries a code, which is the one
  // that names the failure.
  const cause = links.map(classifyLink).find((c) => c !== undefined) ?? 'unknown'

  const seen = new Set<string>()
  const parts: string[] = []
  for (const link of links) {
    const text = describeLink(link)
    if (!text || seen.has(text)) continue
    seen.add(text)
    parts.push(text)
  }
  // `fetch failed` is the wrapper undici puts over every transport error. It carries no
  // information, and dropping it is what leaves the real cause in the first position. Kept when
  // it is ALL there is, so the message is never empty.
  const meaningful = parts.length > 1 ? parts.filter((p) => p !== 'fetch failed') : parts
  const joined = meaningful.join(': ').slice(0, MAX_DETAIL_CHARS)
  // Scrubbed for the same reason `describeError` is: a transport error routinely echoes the
  // request URL back, and a redirected probe's URL can carry a credential in its query.
  const detail = redactSecrets(joined) || 'The connection failed for an unreported reason.'
  const hint = hintFor(cause, ctx)
  return { cause, detail, ...(hint ? { hint } : {}) }
}

/**
 * The single operator-facing line for a failed probe: what happened, then what to do. This is
 * what a `ConnectionTestResult.message` should carry, since the connect forms render it verbatim.
 */
export function connectionFailureMessage(
  error: unknown,
  ctx: ConnectionFailureContext = {},
): string {
  const { detail, hint } = describeConnectionFailure(error, ctx)
  return hint ? `${detail}. ${hint}` : detail
}
