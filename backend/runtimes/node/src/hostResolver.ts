import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { HostResolveOutcome, HostResolveRequest, HostResolver } from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'

// The Node facade's `HostResolver`: one bounded `dns.lookup`, classified by what the resolver said.
//
// `lookup` rather than `resolve4`/`resolve6` deliberately. It is the system view, so it honours
// `/etc/hosts`, `nsswitch.conf` and whatever split-horizon resolver the deployment's network hands
// the process, which is exactly the view `net.connect` would have used on the same box. The
// `resolve*` family talks to a nameserver directly and would answer a DIFFERENT question from the
// one the route proof is about to act on: "what does the public zone say" instead of "what would
// this machine reach".
//
// See `kernel/src/ports/host-resolver.ts` for why the platform resolves a stated name rather than
// asking every provider to resolve its own.

/**
 * Map a resolver error onto the port's vocabulary.
 *
 * `ENOTFOUND`/`ENODATA` are the name answering with nothing, which is a fact about the NAME and is
 * the one outcome here that establishes anything. `EAI_AGAIN` is deliberately NOT one of them: it
 * is a transient resolver failure, and reading it as "this balancer does not exist" is how a DNS
 * blip becomes a recorded verdict about somebody's environment.
 */
function classify(error: NodeJS.ErrnoException): HostResolveOutcome {
  switch (error.code) {
    case 'ENOTFOUND':
    case 'ENODATA':
      return { state: 'unresolved' }
    default:
      return { state: 'failed', detail: error.code ?? getErrorMessage(error) }
  }
}

/**
 * How many `dns.lookup` calls this adapter lets be OUTSTANDING at once, process-wide.
 *
 * `lookup` is a libuv THREADPOOL call and the deadline below cannot cancel one: a leg the race
 * abandons keeps its thread until the platform resolver gives up, which against a blackholed
 * resolver is tens of seconds. The pool is four threads by default and `fs` and `crypto` share it,
 * so a proof resolving `MAX_RESOLVED_HOSTS` names concurrently can hold every thread in the
 * process and queue every file read and every `pbkdf2` in the server behind a diagnostic.
 *
 * Two, so the worst this adapter can hold is half the default pool. A caller that finds the gate
 * full waits no longer than its own `timeoutMs`, because the deadline covers the wait as well as
 * the lookup: a hung resolver costs the names behind it a `failed` outcome ("we could not tell",
 * which leaves the candidate unruled-out) rather than costing the process its threadpool.
 */
const MAX_OUTSTANDING_LOOKUPS = 2

/**
 * The gate itself: a count of the lookups in flight and the callers queued behind them.
 *
 * Module-scoped because the resource it bounds is: one libuv threadpool per process, shared by
 * every concurrent proof, not per environment and not per request.
 */
let outstanding = 0
const queued: (() => void)[] = []

/** Take a slot, resolving as soon as one is free. Always paired with {@link releaseSlot}. */
function takeSlot(): Promise<void> {
  if (outstanding < MAX_OUTSTANDING_LOOKUPS) {
    outstanding += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => queued.push(resolve))
}

/**
 * Hand the slot to the next caller, or give it back.
 *
 * Called from the lookup's OWN settlement and never from the deadline. A leg the deadline
 * abandoned is still holding a threadpool thread, so releasing the gate then would let the next
 * caller start a third concurrent `getaddrinfo`, which is the saturation the gate exists to bound.
 */
function releaseSlot(): void {
  const next = queued.shift()
  if (next) next()
  else outstanding -= 1
}

/**
 * One gated lookup, whose own rejection is observed here.
 *
 * `all: true` because the proof wants the whole answer: a balancer publishes one address per
 * availability zone and the first is not more likely to carry than the rest. `verbatim: true`
 * keeps the resolver's own order rather than re-sorting IPv4 ahead of IPv6, which is the default
 * Node changed years ago and which nothing here has a reason to re-impose.
 */
async function gatedLookup(host: string, abandoned: () => boolean): Promise<string[]> {
  await takeSlot()
  // The deadline may have fired while this waited for a slot. Starting the lookup then would spend
  // a thread on an answer nobody will read, and a queue of abandoned callers doing that is how the
  // gate stays full without a single live request behind it.
  if (abandoned()) {
    releaseSlot()
    throw new Error('host resolution timed out')
  }
  let answer: Promise<LookupAddress[]>
  try {
    answer = lookup(host, { all: true, verbatim: true })
  } catch (error) {
    // `lookup` validates its arguments synchronously, and a throw from that stage has to hand the
    // slot back here: nothing else can, because the release below rides the lookup's own
    // settlement and there is no lookup.
    releaseSlot()
    throw error
  }
  // Released from the lookup's own settlement, and the rejection observed in the same place: an
  // unhandled rejection from a diagnostic is how a diagnostic comes to take down the process it
  // was diagnosing.
  void answer.then(releaseSlot, releaseSlot)
  return (await answer).map((entry) => entry.address).filter(Boolean)
}

/**
 * Resolve one name to every address it answers with, never rejecting.
 *
 * The timeout is a race rather than an option, because `dns.lookup` has none: it is a threadpool
 * call into the platform resolver and it answers when that answers.
 *
 * The lookup is started INSIDE the `try`, which is the whole reason this is a helper rather than
 * two lines up here: `lookup` validates its arguments synchronously, and a throw from that stage
 * would escape and REJECT this resolver, where the port promises it never does. The sibling
 * `nodeRouteProbe` wraps `net.connect` for exactly that reason, and this adapter did not.
 */
export const nodeHostResolver: HostResolver = async (
  req: HostResolveRequest,
): Promise<HostResolveOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abandoned = false
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true
        reject(new Error('host resolution timed out'))
      }, req.timeoutMs)
    })
    const addresses = await Promise.race([gatedLookup(req.host, () => abandoned), deadline])
    // An empty answer is the same fact as `ENODATA`: the name exists and offers no address to
    // dial. Kept apart from a failure, because only this one rules the candidate out.
    return addresses.length > 0 ? { state: 'resolved', addresses } : { state: 'unresolved' }
  } catch (error) {
    return classify(error as NodeJS.ErrnoException)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
