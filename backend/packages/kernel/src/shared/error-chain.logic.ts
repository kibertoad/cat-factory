import { redactSecrets } from './redact-secrets.logic.js'

// How a THROWN VALUE is turned into text, for every reader in the repo: a log line
// (`describeError`), a message rendered to a human (`getErrorMessage`), and a connection probe's
// verdict (`describeConnectionFailure`). All three ask the same question and used to answer it
// three ways, two of which read `error.message` alone.
//
// That is not a cosmetic difference. On Node/undici a transport failure IS a bare
// `TypeError: fetch failed`, and the thing that actually happened (`connect ECONNREFUSED
// 127.0.0.1:6443`, `self-signed certificate`, `getaddrinfo ENOTFOUND`) hangs off `.cause`, or off
// an `AggregateError`'s `.errors` when a host resolved to both `::1` and `127.0.0.1`. So a reader
// that stops at `.message` renders the single least informative string in the chain: the probes
// were taught to walk it (see `connection-failure.logic.ts`), and everything else in the product
// kept answering "fetch failed" — the same failure, described two ways depending on which path
// happened to report it.
//
// This module owns the walk and the rendering; `connection-failure.logic.ts` keeps what is its
// own (classifying the cause and naming a remedy) and reads the links from here.

/** Cap on rendered chain text, so a pathological nesting can't flood a log line or the UI. */
export const MAX_ERROR_CHAIN_CHARS = 400
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
 * Every link of a failure, outermost first: `.cause` chained, plus each branch of an
 * `AggregateError`. Both are walked because they carry different information. The chain holds the
 * specific cause; the aggregate holds one entry PER RESOLVED ADDRESS, and "refused on ::1, never
 * attempted on 127.0.0.1" is a different diagnosis from "refused on both".
 *
 * A link the walk has already reached is not walked again: a `cause` that points back at its own
 * error (or at any ancestor) is otherwise re-rendered once per remaining depth step. Bounding it by
 * IDENTITY rather than by rendered text is what lets the two branches of an aggregate stay distinct
 * even when they stringify identically, which is the whole point of reading them.
 */
export function flattenErrorChain(
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
  for (const branch of aggregated(error)) flattenErrorChain(branch, depth + 1, out, seen)
  flattenErrorChain((error as { cause?: unknown }).cause, depth + 1, out, seen)
  return out
}

/**
 * A TRANSPORT `code`, as Node and undici spell them (`ECONNREFUSED`, `ERR_TLS_CERT_ALTNAME_INVALID`,
 * `UND_ERR_CONNECT_TIMEOUT`). Deliberately narrow: our own `DomainError`s also carry a `code`, but
 * theirs is a lowercase status class (`validation`), which identifies nothing about a failure and
 * would render as a baffling `(validation)` glued onto an already-complete sentence.
 */
const TRANSPORT_CODE = /^[A-Z][A-Z0-9_]*$/

/** One link's human text: its message, with the transport `code` appended when the message omits it. */
export function describeErrorLink(link: unknown): string {
  const message = link instanceof Error ? link.message : String(link)
  const code = errorCode(link)
  const text = message.trim()
  if (!code || !TRANSPORT_CODE.test(code)) return text || code || ''
  if (!text) return code
  return text.includes(code) ? text : `${text} (${code})`
}

/**
 * The links' texts in walk order, with links that render IDENTICALLY folded into a count rather
 * than dropped. A bare dedupe made "refused on both of this host's addresses" render byte-for-byte
 * like "refused on one", which is the distinction the aggregate branches are walked for: undici
 * emits address-less `connect ECONNREFUSED` forms, so two branches routinely stringify the same.
 */
export function renderErrorChainLinks(links: readonly unknown[]): string[] {
  const counted: { text: string; count: number }[] = []
  for (const link of links) {
    const text = describeErrorLink(link)
    if (!text) continue
    const existing = counted.find((c) => c.text === text)
    if (existing) existing.count += 1
    else counted.push({ text, count: 1 })
  }
  return counted.map((c) => (c.count > 1 ? `${c.text} (x${c.count})` : c.text))
}

/**
 * Cap rendered chain text, SAYING that it was capped. A silent slice is indistinguishable from the
 * whole chain, so a reader concludes the inner links were never there; the count is what tells them
 * there is more to ask for. The marker sits outside the budget on purpose: it is the report about
 * the cap, not part of what was capped.
 */
export function capErrorChain(text: string): string {
  if (text.length <= MAX_ERROR_CHAIN_CHARS) return text
  const dropped = text.length - MAX_ERROR_CHAIN_CHARS
  return `${text.slice(0, MAX_ERROR_CHAIN_CHARS)} […${dropped} more characters of the cause chain]`
}

/**
 * Join rendered links into one scrubbed, capped string.
 *
 * Scrubbed for the same reason `describeError` always was: a transport error routinely echoes the
 * request URL back, and a redirected call's URL can carry a credential in its query. It runs BEFORE
 * the cap, because a secret sliced in half matches none of the shape rules: a JWT cut after its
 * second segment, or a `bearer <tok>` cut to under the rule's minimum run, would ship its surviving
 * characters verbatim.
 */
export function joinErrorChain(parts: readonly string[]): string {
  return capErrorChain(redactSecrets(parts.join(': ')) ?? '')
}

/**
 * A thrown value as ONE line of text: its own message, then each cause beneath it, scrubbed and
 * capped. This is what `getErrorMessage` and `describeError` both answer with.
 *
 * The outermost link is KEPT even when it is undici's contentless `fetch failed` wrapper, unlike
 * {@link describeConnectionFailure}, which drops it. The difference is deliberate and is about who
 * reads the result. A probe's verdict is prose an operator reads as a diagnosis, so the wrapper is
 * noise ahead of the real cause. This string, by contrast, is the one a `DispatchError` carries,
 * a persisted `reason` records and a log line greps — and several of those are matched downstream by
 * their opening phrase (`/dispatch failed/i`, the eviction sentinels). Dropping a leading link would
 * silently re-point every one of those matches; appending the causes cannot.
 */
export function errorChainText(error: unknown): string {
  const parts = renderErrorChainLinks(flattenErrorChain(error))
  // A thrown `null`/`undefined` (or an error whose message is empty) walks to NO links, because the
  // walk's job is to stop at an absent `cause`. Naming the value is still better than reporting
  // nothing: "null" says something was thrown and there is nothing behind it, where `''` reads as a
  // failure that was never described.
  if (parts.length === 0) return joinErrorChain([String(error)])
  return joinErrorChain(parts)
}
