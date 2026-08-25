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

/**
 * Cap on chain text rendered for a HUMAN reader: a message on a form, a probe verdict, a
 * persisted failure `reason`, a PR comment. Sized so a pathological nesting can't flood the UI.
 */
export const MAX_ERROR_CHAIN_CHARS = 400
/**
 * Cap on chain text rendered into a LOG FIELD, deliberately far wider than the human one.
 *
 * The two readers do not share a budget. A toast has a few lines of room and a person reading it
 * wants the first sentence; a structured log line is the surface the operator turns to when the
 * first sentence was not enough, and the things that make it worth having are long: the SQL a
 * Postgres error quotes back, a provider's JSON error body, a multi-issue validation dump. Capped
 * all the same, because an unbounded field is a log-ingestion cost and a pathological nesting
 * would still be the thing that pays it.
 */
export const MAX_LOGGED_ERROR_CHAIN_CHARS = 4_000
/** Cap on how far down `cause` / `errors` the walk goes. */
const MAX_CHAIN_DEPTH = 6
/**
 * Cap on how many branches of ONE `AggregateError` are walked.
 *
 * Depth was bounded from the start; breadth was not, and it is the axis that actually gets wide:
 * a `Promise.any` over every endpoint of a fleet rejects with one branch per endpoint. Walking
 * hundreds of them to render a few hundred characters is work done and then thrown away. Sized
 * generously against what the walk exists to read (one branch per resolved address of one host,
 * so two or three), and what it drops is REPORTED rather than silently missing.
 */
const MAX_AGGREGATE_BRANCHES = 8

/**
 * One property of a thrown value, or `undefined` when reading it throws.
 *
 * The walk reads `.cause`, `.errors` and `.code` off values it did not construct: a Proxy, an
 * ORM or SDK error with an accessor-backed field, whatever a dependency chose to throw. A getter
 * that throws would make the DESCRIBER throw, and the describer runs inside `runBestEffort`'s own
 * catch and inside the `.catch` handlers of the durable drivers, whose entire contract is not to
 * propagate. A failed read is therefore an absent link, never a second failure stacked on the
 * first one.
 */
function readProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** `String(value)`, or `''` when the value's own stringification throws. Same reason as above. */
function safeText(value: unknown): string {
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** An error-shaped value's `code`, which Node puts the useful identifier on. */
function errorCode(error: unknown): string | undefined {
  const code = readProperty(error, 'code')
  return typeof code === 'string' && code ? code : undefined
}

/** The `errors` array an `AggregateError` carries (one entry per attempted address). */
function aggregated(error: unknown): unknown[] {
  const errors = readProperty(error, 'errors')
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
  const branches = aggregated(error)
  for (const branch of branches.slice(0, MAX_AGGREGATE_BRANCHES))
    flattenErrorChain(branch, depth + 1, out, seen)
  // A dropped branch is SAID rather than left out. The rendering folds identical links into a
  // count, so silently walking eight of two hundred would report "(x8)" — a reader's fair reading
  // of which is that eight is all there were.
  if (branches.length > MAX_AGGREGATE_BRANCHES)
    out.push(`[…${branches.length - MAX_AGGREGATE_BRANCHES} more branches not read]`)
  flattenErrorChain(readProperty(error, 'cause'), depth + 1, out, seen)
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
  const message = link instanceof Error ? readProperty(link, 'message') : link
  const code = errorCode(link)
  const text = safeText(message ?? '').trim()
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
  // Counted in a Map rather than by scanning the accumulated list per link: a `Map` keeps
  // insertion order, so the walk order this renders in is unchanged, and the fold stays linear
  // where the scan was quadratic in the number of DISTINCT links (the wide-aggregate shape).
  const counts = new Map<string, number>()
  for (const link of links) {
    const text = describeErrorLink(link)
    if (!text) continue
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return [...counts].map(([text, count]) => (count > 1 ? `${text} (x${count})` : text))
}

/**
 * Cap rendered chain text, SAYING that it was capped. A silent slice is indistinguishable from the
 * whole chain, so a reader concludes the inner links were never there; the count is what tells them
 * there is more to ask for. The marker sits outside the budget on purpose: it is the report about
 * the cap, not part of what was capped.
 */
export function capErrorChain(text: string, maxChars: number = MAX_ERROR_CHAIN_CHARS): string {
  if (text.length <= maxChars) return text
  const dropped = text.length - maxChars
  return `${text.slice(0, maxChars)} […${dropped} more characters of the cause chain]`
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
export function joinErrorChain(
  parts: readonly string[],
  maxChars: number = MAX_ERROR_CHAIN_CHARS,
): string {
  return capErrorChain(redactSecrets(parts.join(': ')) ?? '', maxChars)
}

/**
 * The wrapper undici puts over every transport error. It carries no information of its own: the
 * thing that happened (`connect ECONNREFUSED`, `getaddrinfo ENOTFOUND`, an expired certificate)
 * hangs off its cause.
 */
const CONTENTLESS_TRANSPORT_WRAPPER = 'fetch failed'

/**
 * Chain links rendered for a DIAGNOSIS: undici's contentless wrapper dropped, so the real cause
 * lands in the first position. Kept when it is ALL there is, so the removal never empties the
 * account.
 *
 * Takes the FLATTENED links rather than a thrown value, because `describeConnectionFailure` has
 * already walked the chain to classify it and a second walk there would read the same chain twice.
 *
 * One statement of the rule, shared by that describer and by {@link errorChainDiagnosisText}. It
 * used to be inlined in the describer, which is how the acceptance kit's per-poll observation came
 * to spend its 200-character budget re-printing the wrapper: the reduction existed as behaviour but
 * not as a function, so the reader that needed it reached for the describer that keeps it.
 *
 * The exact literal only: `renderErrorChainLinks` folds repeats into `fetch failed (x2)`, and a
 * chain that is nothing but the wrapper twice has genuinely reported two failures.
 */
export function diagnosisChainLinks(links: readonly unknown[]): readonly string[] {
  const parts = renderErrorChainLinks(links)
  const meaningful = parts.filter((part) => part !== CONTENTLESS_TRANSPORT_WRAPPER)
  return meaningful.length > 0 ? meaningful : parts
}

/**
 * A thrown value as ONE line of text: its own message, then each cause beneath it, scrubbed and
 * capped. This is what `getErrorMessage` and `describeError` both answer with.
 *
 * The outermost link is KEPT even when it is undici's contentless `fetch failed` wrapper, unlike
 * {@link errorChainDiagnosisText} and {@link describeConnectionFailure}, which drop it. The
 * difference is deliberate and is about who reads the result. A probe's verdict is prose an
 * operator reads as a diagnosis, so the wrapper is noise ahead of the real cause. This string, by
 * contrast, is the one a `DispatchError` carries, a persisted `reason` records and a log line
 * greps — and several of those are matched downstream by their opening phrase (`/dispatch failed/i`,
 * the eviction sentinels). Dropping a leading link would silently re-point every one of those
 * matches; appending the causes cannot.
 */
export function errorChainText(error: unknown, maxChars: number = MAX_ERROR_CHAIN_CHARS): string {
  return chainText(error, renderErrorChainLinks(flattenErrorChain(error)), maxChars)
}

/**
 * The same chain as {@link errorChainText}, read as a DIAGNOSIS: undici's contentless wrapper is
 * dropped so the line leads with what actually happened.
 *
 * For a reader who is looking at the string to work out what is wrong, and especially for one on a
 * BUDGET. A per-poll journal line capped at a couple of hundred characters spends every one of the
 * wrapper's on a phrase that is identical for a refused connection, an expired certificate and a
 * DNS entry that stopped resolving.
 *
 * Not the default, and never the string a downstream matcher reads: see {@link errorChainText} for
 * what leads those.
 */
export function errorChainDiagnosisText(
  error: unknown,
  maxChars: number = MAX_ERROR_CHAIN_CHARS,
): string {
  return chainText(error, diagnosisChainLinks(flattenErrorChain(error)), maxChars)
}

/**
 * The rendering both describers share: the links when there are any, and otherwise what the THROWN
 * value itself can be said to be.
 */
function chainText(error: unknown, parts: readonly string[], maxChars: number): string {
  if (parts.length > 0) return joinErrorChain(parts, maxChars)
  // Nothing in the chain had anything to say, and what that means depends on WHAT was thrown.
  //
  // For a non-error value, naming it is a report: "null" says something was thrown and there is
  // nothing behind it, where `''` reads as a failure that was never described.
  //
  // For an ERROR it is the opposite, and the difference matters because this string feeds the
  // whole product. `String(new Error(''))` is `Error`, the base constructor name EVERY error
  // shares: it names nothing about the failure, and it is exactly the string that a call site's
  // `getErrorMessage(err) || '<what the operator should do about it>'` guard exists to replace. A
  // describer that can never return empty silently turns every one of those guards into dead code
  // and prints `Error` where the actionable sentence used to be. So an error with nothing to say
  // says nothing. A CUSTOM `name` (`AbortError`) is the one fact there is, and survives.
  if (error instanceof Error) {
    const name = readProperty(error, 'name')
    return typeof name === 'string' && name && name !== Error.name
      ? joinErrorChain([name], maxChars)
      : ''
  }
  return joinErrorChain([safeText(error)], maxChars)
}

/**
 * Whether ANY link of the chain matches `pattern` — the read for a CLASSIFICATION rather than a
 * rendering (is this stop a rollout signal, is this dispatch failure an eviction).
 *
 * It deliberately does not go through {@link errorChainText}, and the difference is the point: that
 * string is scrubbed and CAPPED for a reader, and a verdict that consults it silently inherits the
 * display budget. A sentinel phrase sitting past the cap, or altered by the scrubber, would turn a
 * recognised condition into an unrecognised one, which on the eviction path means a healthy run
 * spending its crash budget on a deploy. Links are matched individually so a phrase can never be
 * split across the `: ` the join inserts either.
 *
 * Matched with `String.search`, not `RegExp.test`: `test` advances `lastIndex` on a `/g` pattern,
 * so a caller's module-level regex would answer differently on its second call.
 */
export function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  return flattenErrorChain(error).some((link) => describeErrorLink(link).search(pattern) !== -1)
}

/**
 * The OUTERMOST link only, deliberately LESS than the chain above, for a PUBLIC surface.
 *
 * Both facades' `/ready` answer an UNAUTHENTICATED caller, and that inverts the reasoning behind
 * every other describer here. A flattened chain is what makes an error useful to the operator and
 * what makes this field a leak: a pool failure's inner link is `connect ECONNREFUSED
 * 10.x.y.z:5432`, the deployment's database address, handed to anyone who curls the endpoint. The
 * operator's copy of the same failure is the boot/probe LOG line, which does carry the chain.
 *
 * It lives here, beside the describers it deliberately differs from, so the carve-out is ONE
 * named function both runtimes call rather than a hand-rolled `err instanceof Error ? …` in each
 * (which is indistinguishable from the bug the chain exists to fix, and drifted between the
 * facades the first time it was written twice).
 */
export function publicDiagnostic(error: unknown): string {
  return redactSecrets(describeErrorLink(error)) ?? ''
}
