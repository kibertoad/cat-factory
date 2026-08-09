import type { ConnectionFailureCause, ConnectionTestResult } from '@cat-factory/contracts'
import { redactSecrets } from './redact-secrets.logic.js'

// Re-exported so the probes (spread across integrations and both facades, which share only
// kernel) need no second import to name the cause they got back. The vocabulary itself belongs to
// contracts, because the SPA owns the translated copy per member.
export type { ConnectionFailureCause }

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
// knowable. THREE halves, actually, and they stay separate. The `cause` is the machine-readable
// class and is what a localized surface renders; the detail is what happened and is always
// reported; the hint is what to do about it and is present only for a RECOGNISED cause, because a
// guessed remedy for an unrecognised failure sends the operator somewhere wrong.
//
// The cause vocabulary itself lives in `@cat-factory/contracts` because the SPA has to agree about
// it (it owns the translated copy per member); this module is its one producer.

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
 *
 * A link the walk has already reached is not walked again: a `cause` that points back at its own
 * error (or at any ancestor) is otherwise re-rendered once per remaining depth step. Bounding it
 * by IDENTITY rather than by rendered text is what lets the two branches of an aggregate stay
 * distinct even when they stringify identically, which is the whole point of reading them.
 */
function flatten(
  error: unknown,
  depth = 0,
  out: unknown[] = [],
  seen: Set<unknown> = new Set(),
): unknown[] {
  if (error === null || error === undefined || depth > MAX_CHAIN_DEPTH) return out
  if (typeof error === 'object') {
    if (seen.has(error)) return out
    seen.add(error)
  }
  out.push(error)
  for (const branch of aggregated(error)) flatten(branch, depth + 1, out, seen)
  flatten((error as { cause?: unknown }).cause, depth + 1, out, seen)
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
 * DOM-side rejections, its `name`: `AbortSignal.timeout()` rejects with a `DOMException` named
 * `TimeoutError` that carries no `code` at all.
 */
const CAUSE_CODES: Record<Exclude<ConnectionFailureCause, 'unknown'>, readonly string[]> = {
  refused: ['ECONNREFUSED'],
  dns: ['ENOTFOUND', 'EAI_AGAIN'],
  timeout: [
    'TimeoutError',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ],
  // A CANCELLED request, which is not a timeout however much it looks like one at the call site:
  // `AbortSignal.timeout()` aborts with a `TimeoutError`, so an `AbortError` here is some OTHER
  // abort (a shutting-down worker, a superseded probe). Folding it into `timeout` sent the
  // operator to inspect firewalls and security groups over a request that was never allowed to
  // finish.
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
 * The one cause recognised WITHOUT a code, matched on message text. undici rejects a header
 * value carrying a control character before it ever opens a socket, and the rejection is a bare
 * `TypeError` with no `code`. So a credential pasted with a line break in it would otherwise
 * fall through to `unknown`, which is the exact case an operator most needs named.
 *
 * Deliberately narrow, and it is the whole wording each runtime uses rather than a keyword.
 * A bare `invalid character` matched `invalid character 'e' looking for beginning of value`, which
 * is Go's JSON decode error and one of the commonest things a kube-apiserver or an intercepting
 * proxy answers with: that operator was told to re-copy a credential that was never the problem.
 */
const INVALID_HEADER_TEXT = /invalid header value|invalid header field|invalid character in header/i

/** Classify one link by its transport `code` (or DOM `name`), or undefined when neither matches. */
function classifyByCode(link: unknown): ConnectionFailureCause | undefined {
  const code = errorCode(link)
  const name = link instanceof Error ? link.name : undefined
  for (const [cause, codes] of Object.entries(CAUSE_CODES)) {
    if (codes.some((c) => c === code || c === name)) return cause as ConnectionFailureCause
  }
  return undefined
}

/**
 * The cause of the whole chain, in two passes over it DEEPEST-FIRST.
 *
 * Depth order is the specificity order: undici's outer links are generic wrappers around the link
 * that names the failure (a mid-handshake `DEPTH_ZERO_SELF_SIGNED_CERT` arrives wrapped in a
 * `SocketError` carrying `UND_ERR_SOCKET`, which is itself a recognised `reset`). Taking the first
 * match in walk order therefore answered with the wrapper and sent the operator to look for a
 * proxy instead of pasting a CA bundle: the exact misdiagnosis this module exists to prevent.
 *
 * The text pass runs only after EVERY link failed to produce a code, because a message match is a
 * guess where a code is a fact, and it must never outrank one.
 */
function classifyChain(links: readonly unknown[]): ConnectionFailureCause {
  const deepestFirst = [...links].reverse()
  for (const link of deepestFirst) {
    const byCode = classifyByCode(link)
    if (byCode) return byCode
  }
  for (const link of deepestFirst) {
    if (link instanceof Error && INVALID_HEADER_TEXT.test(link.message)) return 'invalid-header'
  }
  return 'unknown'
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
  // The target is scrubbed for the same reason the detail is, and it needs its OWN scrub: it comes
  // from the caller's config rather than from the error, so nothing else on the way out touches it.
  // A base URL may legitimately carry userinfo (`https://svc:secret@host`), which no URL policy
  // rejects, and this string is rendered in the SPA and logged wherever the verdict is.
  const target = ctx.target ? (redactSecrets(ctx.target) ?? undefined) : undefined
  const at = target ? ` at ${target}` : ''
  const address = target ?? 'that address'
  switch (cause) {
    case 'refused':
      return `Nothing is listening${at}: the connection was actively refused. ${capitalize(subject)} is most likely not running, or is bound to a different host or port. Start it (or correct the address), then test again.`
    case 'dns':
      return `The host name in ${address} does not resolve from this deployment. Check it for a typo, and note that a cluster-internal DNS name is not resolvable from outside the cluster.`
    case 'timeout':
      return `${capitalize(subject)} did not answer before the probe timed out. Packets silently dropped by a firewall or security group look exactly like this (a refusal would have come back immediately), as does a host that is up but saturated.`
    case 'aborted':
      return `The request was cancelled before an answer arrived, so nothing was learned about whether ${subject} is reachable. A probe that ran out of its own time reports itself as a timeout instead, so this is usually a request superseded or a process shutting down: run the test again.`
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
 * The links' texts in walk order, with links that render IDENTICALLY folded into a count rather
 * than dropped. A bare dedupe made "refused on both of this host's addresses" render byte-for-byte
 * like "refused on one", which is the distinction the aggregate branches are walked for: undici
 * emits address-less `connect ECONNREFUSED` forms, so two branches routinely stringify the same.
 */
function renderLinks(links: readonly unknown[]): string[] {
  const counted: { text: string; count: number }[] = []
  for (const link of links) {
    const text = describeLink(link)
    if (!text) continue
    const existing = counted.find((c) => c.text === text)
    if (existing) existing.count += 1
    else counted.push({ text, count: 1 })
  }
  return counted.map((c) => (c.count > 1 ? `${c.text} (x${c.count})` : c.text))
}

/**
 * Cap the rendered chain, SAYING that it was capped. A silent slice is indistinguishable from the
 * whole chain, so a reader concludes the inner links were never there; the count is what tells
 * them there is more to ask for. The marker sits outside the budget on purpose: it is the report
 * about the cap, not part of what was capped.
 */
function capDetail(text: string): string {
  if (text.length <= MAX_DETAIL_CHARS) return text
  const dropped = text.length - MAX_DETAIL_CHARS
  return `${text.slice(0, MAX_DETAIL_CHARS)} […${dropped} more characters of the cause chain]`
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
  const cause = classifyChain(links)

  const parts = renderLinks(links)
  // `fetch failed` is the wrapper undici puts over every transport error. It carries no
  // information, and dropping it is what leaves the real cause in the first position. Kept when
  // it is ALL there is, so the message is never empty.
  const meaningful = parts.length > 1 ? parts.filter((p) => p !== 'fetch failed') : parts
  // Scrubbed for the same reason `describeError` is: a transport error routinely echoes the
  // request URL back, and a redirected probe's URL can carry a credential in its query. It runs
  // BEFORE the cap, because a secret sliced in half matches none of the shape rules: a JWT cut
  // after its second segment, or a `bearer <tok>` cut to under the rule's minimum run, would ship
  // its surviving characters verbatim.
  const scrubbed = redactSecrets(meaningful.join(': ')) ?? ''
  const detail = capDetail(scrubbed) || 'The connection failed for an unreported reason.'
  const hint = hintFor(cause, ctx)
  return { cause, detail, ...(hint ? { hint } : {}) }
}

/**
 * The whole failed-probe verdict a `testConnection` should return: the English account (what
 * happened, then what to do) AND the machine-readable `failureCause` the SPA maps to translated
 * copy.
 *
 * Every probe that can throw a transport error answers through this rather than assembling
 * `{ ok: false, message }` itself, because the cause is the half a 10-locale UI can actually
 * render, and a hand-built literal structurally cannot carry it. (The same argument as
 * `handleError` owning the HTTP error envelope.) A caller that is NOT a probe takes
 * {@link describeConnectionFailure} and reads `detail`: the hints end in "then test again", which
 * names a button only a connect form has.
 */
export function connectionFailureResult(
  error: unknown,
  ctx: ConnectionFailureContext = {},
): ConnectionTestResult {
  const { cause, detail, hint } = describeConnectionFailure(error, ctx)
  return {
    ok: false,
    message: hint ? `${detail}. ${hint}` : detail,
    failureCause: cause,
  }
}
