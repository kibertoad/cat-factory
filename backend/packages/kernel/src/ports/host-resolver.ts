/**
 * Turn one NAME into the addresses it answers with, so the platform can dial a candidate a
 * provider identified by name rather than by a literal it had to snapshot itself.
 *
 * A port rather than a helper for the same reason {@link RouteProbe} is one: both facades can do
 * this and neither does it the same way. Node has a real resolver (`dns.lookup`, which is the
 * system view a socket would have used anyway); workerd exposes none, so the Worker facade asks
 * over DNS-over-HTTPS, which is the same view its own `connect()` resolves through.
 *
 * It exists because the alternative is every provider resolving its own names before it states
 * them, which pins a snapshot of a set that rotates (a managed load balancer's addresses change as
 * it scales or gains a zone, and its NAME is the stable identity the vendor documents), forces DNS
 * into an otherwise pure response mapping, and asks each provider to get bounded resolution,
 * stable ordering and partial failure right on its own.
 *
 * Nothing here is on the container-dispatch path. The bridge classifier stays syntactic with no
 * lookup for the reasons stated in `shared/environment-host-bridge.logic.ts`; this runs beside the
 * route proof, in the deployer's settle path and the status poll's bounded re-prove.
 */
export interface HostResolveRequest {
  /** The name to look up, already trimmed and lower-cased by the plan that asked for it. */
  host: string
  /** Give up after this long, and answer `failed` rather than hanging the proof behind it. */
  timeoutMs: number
}

/**
 * What one lookup found.
 *
 * `unresolved` and `failed` are split for the reason every other pair in this vocabulary is: the
 * first is a fact about the NAME (nothing answers for it, so that candidate is a dead end and the
 * proof may say so), the second is an admission that the platform could not tell, which must never
 * become a verdict about the environment.
 */
export type HostResolveOutcome =
  /**
   * The name answered. Addresses are IP literals in the order the resolver returned them, which is
   * kept: it is the only preference signal a resolver gives, and re-ordering it here would be the
   * platform inventing one.
   */
  | { state: 'resolved'; addresses: readonly string[] }
  /** The name answered with nothing (NXDOMAIN, or a record set with no address in it). */
  | { state: 'unresolved' }
  /** The lookup itself failed: a timeout, a resolver outage, a transport error. */
  | { state: 'failed'; detail: string }

/**
 * Resolve one name. Resolves with an outcome for every case including failure, and NEVER rejects,
 * on the same contract as {@link RouteProbe}: a thrown resolver would turn a diagnostic into a
 * second way for a healthy run to die, and `failed` is what says "we could not tell" honestly.
 */
export type HostResolver = (req: HostResolveRequest) => Promise<HostResolveOutcome>
