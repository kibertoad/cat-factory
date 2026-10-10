// Whether a `ready` environment can actually be REACHED, as opposed to whether it was
// provisioned.
//
// These are two questions, and the platform only ever asked the first one. An environment
// carries one nullable `url`, so "reachable" has meant "a URL exists"; the tester is then handed
// a name, gets `curl` exit code 000, and reports the one hypothesis its own task makes salient,
// that the ENVIRONMENT is down. That reading is wrong often enough to be expensive: a name that
// does not resolve, a route that does not carry, and an application that answers 503 are three
// different faults with three different owners, and a connection failure renders all three
// identically.
//
// The vocabulary here is the platform's answer to the LOWER two layers. It is deliberately a
// SIBLING of `EnvironmentFailureReason` rather than an extension of it: that one is
// provisioning-scoped in every member and in its docstring (`cluster_unreachable` means the
// PROVIDER could not be reached), and a reaching failure against an environment the provider
// calls `ready` is a different question for a different audience. Only the one-word verdict the
// DEPLOYER settles on lives over there (`environment_unreachable`), because the deployer settles
// in that vocabulary.

import * as v from 'valibot'

/**
 * One place a provider states traffic for its environment's URL host goes: an ADDRESS the platform
 * dials as written, or a NAME it resolves when it dials.
 *
 * The motivating shape is an org running per-PR preview environments whose per-environment DNS
 * record lives in an internal view while the load balancers fronting it are ordinary names and
 * the ingress routes on the `Host` header. The address exists and a container's egress reaches
 * it. The only missing thing is a name-to-address mapping, which is exactly what a hosts-file
 * entry (or a Kubernetes `hostAliases` entry) is.
 *
 * **Exactly one of {@link EnvironmentRouteCandidate.address} and
 * {@link EnvironmentRouteCandidate.host} is set, and which one is the PROVIDER'S statement**, never
 * something the platform reads off the spelling. Guessing would rest the security rule on a parse:
 * `isBridgeableAddress` refuses a non-canonical literal precisely so `2130706433` cannot become
 * loopback, and a resolver handed that same string answers loopback happily. A candidate stating
 * neither (or both, which is two claims with no way to tell which was meant) therefore names no
 * target at all and is RECORDED as one, on the same rule as an address no bridge may name.
 *
 * `label` is for the human reading a diagnostic ("internal ALB", "public ALB"), never for
 * matching: the platform picks by PROBING, never by name.
 */
export const environmentRouteCandidateSchema = v.object({
  /** An IP literal, dialled as written. Never a name: see {@link EnvironmentRouteCandidate.host}. */
  address: v.optional(v.string()),
  /**
   * A NAME the platform RESOLVES at proof time, expanding it in place into the addresses it
   * answers with.
   *
   * For the provider whose stable identity IS a name, which is the ordinary shape of a managed
   * load balancer: an ALB's addresses change as it scales or gains a zone, and its DNS name is
   * what the vendor documents a client should use. A provider stating the resolved literals
   * instead re-pins a snapshot of that set on every poll, and owes bounded resolution, stable
   * ordering and partial-failure handling of its own.
   *
   * Deliberately NOT the URL's own host, which is the lookup that already failed. This is a
   * DIFFERENT name in a different zone, and its whole point is resolving when that one does not.
   * Nothing downstream ever sees it: every address it resolves to is graded by
   * `isBridgeableAddress` exactly as a stated address is, and the proof publishes the ADDRESS that
   * carried with the name it came from beside it, so a bridge is still built from a literal the
   * platform itself proved.
   */
  host: v.optional(v.string()),
  /** What this candidate IS, for the diagnostic. Never load-bearing. */
  label: v.optional(v.string()),
})
export type EnvironmentRouteCandidate = v.InferOutput<typeof environmentRouteCandidateSchema>

/**
 * What one candidate actually names, or that it names nothing usable.
 *
 * A discriminated result rather than two optional reads at every site, because the three cases
 * want three different reactions and the third is the one a nullable read renders as absent. Read
 * through this rather than off the fields, so "which kind is this" is answered once.
 */
export type StatedRouteTarget =
  | { kind: 'address'; address: string }
  | { kind: 'host'; host: string }
  | { kind: 'unusable' }

/**
 * Read a stated candidate as the one thing it names.
 *
 * A host is lower-cased because DNS is case-insensitive and this value is both a map key and a
 * comparison target: two spellings of one balancer name must not resolve twice, nor invalidate a
 * proof by failing to match themselves.
 */
export function statedRouteTarget(candidate: EnvironmentRouteCandidate): StatedRouteTarget {
  const address = candidate.address?.trim() ?? ''
  const host = candidate.host?.trim().toLowerCase() ?? ''
  if (address && host) return { kind: 'unusable' }
  if (address) return { kind: 'address', address }
  if (host) return { kind: 'host', host }
  return { kind: 'unusable' }
}

/**
 * One candidate as a reader sees it: its value, its label, and a NAME marked as one.
 *
 * ONE renderer, because three surfaces print this list (the environment investigation's route
 * section, its timeline entry and the diagnostics bundle) and a name printed into a sentence about
 * "the addresses the provider stated" reads as an address somebody typed wrong.
 */
export function describeRouteCandidate(candidate: EnvironmentRouteCandidate): string {
  const stated = statedRouteTarget(candidate)
  const label = candidate.label?.trim()
  if (stated.kind === 'address') return label ? `${stated.address} (${label})` : stated.address
  if (stated.kind === 'host') return `${stated.host} (name${label ? `, ${label}` : ''})`
  return label
    ? `an entry stating no usable target (${label})`
    : 'an entry stating no usable target'
}

/**
 * Why a `ready` environment could not be reached, at the layer the platform can observe.
 *
 * Separate members rather than one "unreachable" because they need different reactions and name
 * different owners: `name_unresolved` with candidates that also failed is an environment nobody
 * can reach, `no_candidate` is a PROVIDER that never told us where the thing lives, and
 * `connection_refused` is a route that carries to a box with nothing listening, which is the
 * deployed workload rather than the network.
 *
 *  - `no_candidate`       the environment carries no URL, or one with no host to probe. There
 *                         was nothing to try, which is not the same as trying and failing.
 *  - `name_unresolved`    a name resolved nowhere: the URL's own host, with no stated candidate
 *                         carrying either, or one stated NAME whose own lookup answered nothing.
 *  - `no_route`           something resolved and the connect never completed (timeout,
 *                         host/network unreachable). The expensive failure: a lookup that
 *                         worked followed by a connect that hangs.
 *  - `connection_refused` the route carries and nothing is listening on the port.
 *  - `address_refused`    the provider stated a target the platform will not dial: a loopback,
 *                         link-local/vendor-metadata or non-canonical address (whether stated or
 *                         resolved from a stated name), or a candidate naming no single target at
 *                         all. Recorded as an attempt rather than dropped, because a refused input
 *                         is an omission the operator has to be able to see.
 *  - `resolver_unavailable` the provider stated a NAME and nothing in this deployment can turn one
 *                         into an address. An admission about the PLATFORM, never a verdict about
 *                         the environment, so it leaves the route unruled-out exactly as
 *                         `probe_failed` does.
 *  - `not_attempted`      the platform stopped short of the list its provider stated: it looks up
 *                         a bounded number of names and dials a bounded number of addresses, so a
 *                         longer list is a PREFIX. Recorded ONCE, naming how many were passed
 *                         over, because a reader who assumes a prefix concludes the tail was
 *                         never stated. Another admission about the PLATFORM: a candidate nothing
 *                         looked at cannot be part of a verdict that nothing reaches the
 *                         environment.
 *  - `probe_failed`       the probe itself errored in a way it could not classify. Kept apart
 *                         from the three above so "we could not tell" never renders as a
 *                         verdict about the environment.
 */
export const environmentUnreachableReasonSchema = v.picklist([
  'no_candidate',
  'name_unresolved',
  'no_route',
  'connection_refused',
  'address_refused',
  'resolver_unavailable',
  'not_attempted',
  'probe_failed',
])
export type EnvironmentUnreachableReason = v.InferOutput<typeof environmentUnreachableReasonSchema>

/** One target the proof tried, in the order it was tried, and what came back. */
export const environmentRouteAttemptSchema = v.object({
  /** `host:port` for the name itself, `host@address:port` for a stated address. */
  target: v.string(),
  /** `carried`, or the {@link EnvironmentUnreachableReason} that target produced. */
  outcome: v.string(),
  /**
   * What the probe said when it could not classify its own failure, capped for a rendered
   * surface. The ONLY field carrying WHY a `probe_failed` attempt failed.
   *
   * Kept because `probe_failed` names no layer by design, so without this an operator reading a
   * proof cannot tell a TLS or resolver fault from a runtime restriction from a bug in the probe:
   * the three need different fixes and the reason renders identically for all of them. Absent for
   * every other outcome, which is already self-describing.
   */
  detail: v.optional(v.string()),
})
export type EnvironmentRouteAttempt = v.InferOutput<typeof environmentRouteAttemptSchema>

/**
 * What the platform PROVED about reaching an environment, once, at the moment it went `ready`.
 *
 * `state` splits along TWO axes and both are load-bearing. `reached` and `not_reached` are
 * verdicts about the ENVIRONMENT, and only `not_reached` fails a deployer frame. `inconclusive`
 * and `unproved` are verdicts about the PLATFORM, and neither may ever fail anything: collapsing
 * either into `not_reached` turns a diagnostic into a second way for a healthy deploy to die,
 * which is the one failure mode this whole module must not introduce, and collapsing either into
 * `reached` hands a tester the unbacked claim it exists to retire.
 *
 *   - `inconclusive` the platform LOOKED and established nothing either way: a probe that
 *                    errored in a way it could not classify, or an environment with no address to
 *                    dial. Narrated, because "we could not tell" is exactly the fact that stops an
 *                    agent concluding the environment is dead.
 *   - `unproved`     nothing was wired to open a socket, so nothing was tried. SILENT (see
 *                    {@link reachabilityNote}): it is the standing state of every deployment with
 *                    no prober, and a line on every prompt is a line nobody reads on the one
 *                    prompt where it matters.
 */
export const environmentRouteProofSchema = v.object({
  state: v.picklist(['reached', 'not_reached', 'inconclusive', 'unproved']),
  /**
   * The stated address that CARRIED, or null when the URL's own name carried (the ordinary case)
   * and when nothing carried at all. Read `state` to tell those two apart.
   *
   * This is the field a container bridge is built from, which is why the proof publishes the
   * candidate that carried rather than the first that resolved: a bridge built from an unproved
   * address is recorded as successfully applied while the tester still fails, and the evidence
   * then points further from the cause than no bridge at all did.
   */
  via: v.nullable(v.string()),
  /**
   * The stated NAME {@link via} was resolved from, when the candidate that carried was a host
   * rather than an address. Absent when `via` is itself a stated address, when the URL's own name
   * carried, and when nothing carried.
   *
   * Recorded because the fold decides a `reached` proof's survival on whether the target it names
   * is still on offer, and for a resolved name that target is the NAME. The address is a snapshot
   * of a set that rotates (a balancer scaling or gaining a zone changes it, and tells the platform
   * nothing about whether the proved route still carries), so matching `via` against the candidate
   * list would drop a good proof on every such event and pay a fresh probe sequence for it.
   *
   * Optional so a proof written before this existed still parses, where its absence reads as the
   * address case, which is what it was.
   */
  viaHost: v.optional(v.string()),
  /**
   * The {@link EnvironmentUnreachableReason} when `state` is `not_reached` or `inconclusive`,
   * else null. An open string on the wire so a stored proof written by an older build never fails
   * to parse; readers that branch on it treat an unknown value as "not one of the cases I handle".
   */
  reason: v.nullable(v.string()),
  /** Every target tried, in order. Recorded whether or not one carried. */
  attempts: v.array(environmentRouteAttemptSchema),
  /** When the proof ran (epoch ms). */
  checkedAt: v.number(),
})
export type EnvironmentRouteProof = v.InferOutput<typeof environmentRouteProofSchema>

/**
 * Everything the platform knows about ADDRESSING an environment, beside the one string it knows
 * about naming it.
 *
 * Two halves because they come from two places and one of them is a claim: `candidates` is what
 * the PROVIDER said, `proof` is what the platform TRIED. Keeping the claim after the proof runs
 * is deliberate: an operator debugging a dead environment wants to see which addresses were
 * offered as well as which were reached, and a re-probe on a later poll re-reads the same claim.
 */
export const environmentReachabilitySchema = v.object({
  /**
   * The addresses and names the provider states carry traffic for the URL's host, in ITS
   * preference order.
   */
  candidates: v.array(environmentRouteCandidateSchema),
  /** What proving found, or null when nothing has probed this environment yet. */
  proof: v.nullable(environmentRouteProofSchema),
  /**
   * When the platform last LOOKED at reaching this environment, carried forward even once the
   * proof it produced no longer applies.
   *
   * The third half, and it exists because the other two cannot answer "has anything ever tried".
   * `proof.checkedAt` dates a verdict that still STANDS, so a proof the fold had to drop takes its
   * date with it, leaving a row indistinguishable from one nothing ever probed. Anything pacing
   * itself against that value degenerates: the status poll re-takes a dropped proof on a bounded
   * interval, and the first time it decides to wait, the drop is persisted, the next poll reads an
   * environment nothing has ever dialled, and the re-take never fires again.
   *
   * Optional because a value written before this existed carries none, which reads as "unknown
   * when" and lets the poll re-prove at its first opportunity: the right disposition for a row
   * whose probe history cannot be dated.
   */
  probedAt: v.optional(v.number()),
})
export type EnvironmentReachability = v.InferOutput<typeof environmentReachabilitySchema>

/**
 * The reachability facts an agent (or a container dispatch) is handed for ONE environment it is
 * being pointed at.
 *
 * A flattened projection rather than the stored shape, because the reader's question is narrower
 * than the operator's: it needs the address it may dial and the layer that failed, not the
 * provider's full candidate list. `state: 'reached'` with no `address` means the name itself
 * carried, which is the case that needs no narration at all.
 */
export interface EnvironmentReachabilityNote {
  /**
   * Deliberately NOT the proof's full state union: an `unproved` note is unrepresentable, because
   * the projection withholds it (see {@link reachabilityNote}). A reader that branched on
   * `'unproved'` here would be writing a case its input can never hold.
   */
  state: Exclude<EnvironmentRouteProof['state'], 'unproved'>
  /** The address that carried, when the name did not. */
  address?: string
  reason?: string
  /** What a `probe_failed` attempt said, when one did. See the attempt's own `detail`. */
  detail?: string
}

/**
 * Project a stored {@link EnvironmentReachability} onto the note an agent or a dispatch reads, or
 * undefined when there is nothing to say.
 *
 * Undefined in two cases, and they are the same fact from two directions: no proof has been
 * written, and a proof recording that nothing was WIRED to probe. "Nothing has looked" is the
 * ordinary state of an environment mid-provision AND the permanent state of a deployment with no
 * prober, so narrating it would put an unverified-reachability warning on every prompt of such a
 * deployment and train a reader to skip the section that matters. The row still records the
 * `unproved` proof, because when the probe ran is a fact an operator reads off the environment.
 */
export function reachabilityNote(
  reachability: EnvironmentReachability | null | undefined,
): EnvironmentReachabilityNote | undefined {
  const proof = reachability?.proof
  if (!proof || proof.state === 'unproved') return undefined
  const detail = proof.attempts.find((attempt) => attempt.detail)?.detail
  return {
    state: proof.state,
    ...(proof.via ? { address: proof.via } : {}),
    ...(proof.reason ? { reason: proof.reason } : {}),
    ...(detail ? { detail } : {}),
  }
}

/** Where an environment URL is dialled: its host, the port, and the scheme it names. */
export interface EnvironmentCoordinates {
  host: string
  /** Explicit from the URL, else the scheme default (443/80), else null: nothing to dial. */
  port: number | null
  /** URL scheme without the trailing colon (e.g. `https`). */
  scheme: string
}

/** `scheme://` plus everything up to the path, query or fragment: the authority. */
const URL_AUTHORITY = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i

/**
 * Derive the coordinates of an environment URL, or null when there is no URL or it does not parse.
 *
 * ONE deriver, here rather than beside either of its two readers, because they have to agree about
 * the same string and the divergence is not cosmetic: the route proof DIALS what this returns and
 * the Tester prompt states it to the agent as the environment's Host / Port / Scheme. Two parsers
 * mean an agent told to dial coordinates the platform never probed, and the copies this replaced
 * had already diverged on the one case that mattered (an unknown scheme became port `0` in one and
 * `null` in the other, and `0` is what routed a non-http URL into a failed deploy).
 *
 * The parse is hand-rolled because contracts compiles against `lib: ["ES2022"]` with no DOM and no
 * Node types, so `URL` is unavailable here exactly as it is in kernel, and this is the one package
 * both readers can see. The three things a naive split gets wrong are handled: userinfo (whose
 * password may itself contain `@`, so the LAST one separates it from the host), a bracketed IPv6
 * literal (kept bracketed, which is what `URL.hostname` also returns), and an explicit port, where
 * a MALFORMED one answers null rather than being dropped so a garbled URL cannot be silently
 * dialled on the scheme default. Deliberately not attempted: IDNA/punycode and percent-decoding,
 * neither of which an environment URL from a provider needs.
 *
 * An unknown scheme yields `port: null` (there is no default to invent), which every caller reads
 * as "nothing to dial".
 */
export function deriveEnvironmentCoordinates(
  url: string | null | undefined,
): EnvironmentCoordinates | null {
  if (!url) return null
  const match = URL_AUTHORITY.exec(url.trim())
  if (!match) return null
  const scheme = (match[1] ?? '').toLowerCase()
  const authority = match[2] ?? ''
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const split = splitHostPort(hostPort)
  if (!split) return null
  const port = split.port ?? defaultPortForScheme(scheme)
  return { host: split.host, port, scheme }
}

/** The default port a scheme implies, or null when it implies none the platform knows. */
function defaultPortForScheme(scheme: string): number | null {
  return scheme === 'https' ? 443 : scheme === 'http' ? 80 : null
}

/**
 * Split an authority's `host[:port]` half, or null when it is not one.
 *
 * Null rather than a best guess for every malformed shape: an unclosed bracket, an unbracketed
 * literal carrying several colons (an IPv6 address that a URL may not spell that way), and a port
 * that is not a number in range. Each of those is a URL `new URL` would throw on, and answering
 * with a host anyway is how a garbled URL gets dialled.
 */
function splitHostPort(hostPort: string): { host: string; port: number | null } | null {
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']')
    if (close < 1) return null
    const host = hostPort.slice(0, close + 1).toLowerCase()
    const rest = hostPort.slice(close + 1)
    if (rest === '') return { host, port: null }
    if (!rest.startsWith(':')) return null
    const port = parsePort(rest.slice(1))
    return port === null ? null : { host, port }
  }
  const colon = hostPort.indexOf(':')
  if (colon < 0) return hostPort ? { host: hostPort.toLowerCase(), port: null } : null
  if (hostPort.indexOf(':', colon + 1) >= 0) return null
  const host = hostPort.slice(0, colon).toLowerCase()
  const port = parsePort(hostPort.slice(colon + 1))
  return host && port !== null ? { host, port } : null
}

/** A port as written in a URL: digits, 1-65535. Null for anything else. */
function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null
  const port = Number(raw)
  return port >= 1 && port <= 65535 ? port : null
}
