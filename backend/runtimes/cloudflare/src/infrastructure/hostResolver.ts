import type { HostResolveOutcome, HostResolveRequest, HostResolver } from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'

// The Worker facade's `HostResolver`, the symmetric twin of the Node facade's `dns.lookup` probe.
// See `kernel/src/ports/host-resolver.ts` for why the platform resolves a stated name at all.
//
// **Why DNS-over-HTTPS and not a resolver API.** workerd exposes none: there is no `node:dns`, and
// `connect()` resolves internally without telling the caller which address it reached, which is the
// one thing the proof needs (a bridge is built from an address, and `via` naming a name would be a
// bridge target no runtime can install). A resolver-less facade would leave every name candidate
// recorded `resolver_unavailable`, which is honest and is still a runtime-neutral behaviour missing
// from one runtime, so it is not the answer this repo accepts.
//
// The endpoint is Cloudflare's own public resolver, which is the same view the Worker's outbound
// `connect()` resolves through, so a name this answers for is a name that facade could dial and a
// name it does not is one it could not. Reaching for a resolver with a DIFFERENT view (a public
// resolver on another network) would answer a question about somebody else's DNS.
//
// The known limit is the one the whole feature already carries and ADR 0062 states: the
// ORCHESTRATOR'S vantage point is not the CONTAINER'S. A deployment whose per-environment names
// live in a split-horizon zone the Cloudflare network cannot see gets `unresolved` here, which
// rules that candidate out rather than admitting the platform could not look. That is correct for
// this facade, whose own egress cannot see that zone either.

/** Cloudflare's public DNS-over-HTTPS endpoint, in its JSON dialect (RFC 8484's sibling). */
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'

/** The record types an address answer can arrive as: A (IPv4) and AAAA (IPv6). */
const ADDRESS_TYPES = [
  { query: 'A', code: 1 },
  { query: 'AAAA', code: 28 },
] as const

/** `Status` values the resolver answers with. 0 is NOERROR, 3 is NXDOMAIN. */
const NOERROR = 0
const NXDOMAIN = 3

/** One `Answer` entry, of which only an address record's own `data` is read. */
interface DohAnswer {
  type?: unknown
  data?: unknown
}

/** The JSON body, read defensively: it is a third party's shape and a 200 does not guarantee it. */
interface DohResponse {
  Status?: unknown
  Answer?: unknown
}

/** What one record-type query found, or why it could not be asked. */
type TypeAnswer = { ok: true; addresses: string[] } | { ok: false; detail: string }

/**
 * Ask for one record type for one name.
 *
 * A CNAME chain arrives inline as extra `Answer` entries, which is why the type code is checked
 * per entry rather than assumed: reading `data` off a CNAME would hand the plan a NAME where it
 * expects a literal, and `isBridgeableAddress` would then refuse it as non-canonical, reporting a
 * perfectly ordinary alias as an address the platform will not dial.
 */
async function queryType(
  host: string,
  type: (typeof ADDRESS_TYPES)[number],
  signal: AbortSignal,
): Promise<TypeAnswer> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type.query}`
  const response = await fetch(url, { headers: { accept: 'application/dns-json' }, signal })
  if (!response.ok) {
    return { ok: false, detail: `DoH ${type.query} answered HTTP ${response.status}` }
  }
  const body = (await response.json()) as DohResponse
  const status = typeof body.Status === 'number' ? body.Status : -1
  // NXDOMAIN is an ANSWER, not a failure: the name has nothing, which is exactly what
  // `unresolved` means one level up. Any other non-zero status is the resolver declining to say.
  if (status === NXDOMAIN) return { ok: true, addresses: [] }
  if (status !== NOERROR) return { ok: false, detail: `DoH ${type.query} status ${status}` }
  const answers = Array.isArray(body.Answer) ? (body.Answer as DohAnswer[]) : []
  const addresses = answers
    .filter((answer) => answer?.type === type.code && typeof answer.data === 'string')
    .map((answer) => (answer.data as string).trim())
    .filter(Boolean)
  return { ok: true, addresses }
}

/**
 * Resolve one name to every address it answers with, never rejecting.
 *
 * Both record types are asked CONCURRENTLY and their answers concatenated, A first: two round
 * trips serialised would double the wait for an answer neither half orders. A first because a
 * deployment whose runners are IPv4-only is the ordinary case, and the plan tries candidates in
 * order, so putting the addresses most likely to carry first costs nothing and saves a timeout.
 *
 * A partial answer COUNTS. One type erroring while the other returns addresses is a resolvable
 * name, and reporting the pair as a failure would leave a dialable balancer untried on the
 * strength of a missing AAAA. The pair fails only when NEITHER type could be asked, and it answers
 * `unresolved` only when both agree there is nothing: an NXDOMAIN plus an empty NOERROR is the same
 * fact as two NXDOMAINs.
 */
export const workerHostResolver: HostResolver = async (
  req: HostResolveRequest,
): Promise<HostResolveOutcome> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs)
  try {
    const results = await Promise.all(
      ADDRESS_TYPES.map((type): Promise<TypeAnswer> =>
        queryType(req.host, type, controller.signal).catch((error: unknown) => ({
          ok: false,
          detail: getErrorMessage(error) || 'the DNS-over-HTTPS request failed',
        })),
      ),
    )
    const addresses: string[] = []
    const failures: string[] = []
    for (const result of results) {
      if (result.ok) addresses.push(...result.addresses)
      else failures.push(result.detail)
    }
    if (failures.length === results.length) return { state: 'failed', detail: failures.join('; ') }
    return addresses.length > 0 ? { state: 'resolved', addresses } : { state: 'unresolved' }
  } finally {
    clearTimeout(timer)
  }
}
