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
 * Resolve one name to every address it answers with, never rejecting.
 *
 * `all: true` because the proof wants the whole answer: a balancer publishes one address per
 * availability zone and the first is not more likely to carry than the rest. `verbatim: true`
 * keeps the resolver's own order rather than re-sorting IPv4 ahead of IPv6, which is the default
 * Node changed years ago and which nothing here has a reason to re-impose.
 *
 * The timeout is a race rather than an option, because `dns.lookup` has none: it is a threadpool
 * call into the platform resolver and it answers when that answers. The losing leg is left to
 * settle on its own with nobody awaiting it, which is why the rejection is observed here: an
 * unhandled rejection from a diagnostic is how a diagnostic comes to take down the process it was
 * diagnosing.
 */
export const nodeHostResolver: HostResolver = async (
  req: HostResolveRequest,
): Promise<HostResolveOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const answer = lookup(req.host, { all: true, verbatim: true })
  void answer.then(undefined, () => undefined)
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('host resolution timed out')), req.timeoutMs)
    })
    const entries = await Promise.race([answer, deadline])
    const addresses = entries.map((entry) => entry.address).filter(Boolean)
    // An empty answer is the same fact as `ENODATA`: the name exists and offers no address to
    // dial. Kept apart from a failure, because only this one rules the candidate out.
    return addresses.length > 0 ? { state: 'resolved', addresses } : { state: 'unresolved' }
  } catch (error) {
    return classify(error as NodeJS.ErrnoException)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
