# ADR 0064: A route candidate may be a NAME, and the platform resolves it when it dials

- Status: accepted
- Date: 2026-09-02
- Context layer: `@cat-factory/contracts` (the candidate vocabulary and the manifest key) + kernel
  (the resolver port, the plan, the proof) + `@cat-factory/integrations` (the prover, the fold, the
  manifest extraction) + orchestration (the dependency) + both runtime facades

Extends [ADR 0062](./0062-environment-address-bridge-and-route-proof.md), which is the design this
one changes one input of. Closes issue
[#2164](https://github.com/kibertoad/cat-factory/issues/2164), filed by the deployment ADR 0062 was
written against. Website half: cat-factory-website#85.

## Context

ADR 0062 gave an environment a second addressing fact beside its URL: the addresses its provider
states carry traffic for that URL's host. `EnvironmentAddress.address` was documented "An IP
literal. Never a name: a name would just be the lookup that already failed", and `planRouteProbes`
enforced it, refusing anything `isBridgeableAddress` could not parse as a v4 or v6 literal.

That rationale is exactly right for the name it was written about. The URL's own host is the lookup
that already failed, so restating it as a candidate would prove nothing. It does not hold for the
name the consumer actually has.

Their per-PR environment publishes `<env>.test.lokalise.cloud`, a record that exists only in an
internal view. The load balancers fronting it are ordinary public AWS names, the ingress routes on
the `Host` header, and a machine that cannot resolve the environment at all gets a 200 under a valid
certificate by pointing at one of them. They have the NAME. They do not have the address.

To state a candidate at all, their provider had to resolve the balancer FQDNs itself and hand back
the result. That cost three things, in the order they hurt:

**The stated value became a snapshot of a set that rotates.** An ALB's addresses change as it scales
or gains an availability zone, which is why AWS documents the NAME as the thing a client should use.
So the platform stored a value that could be stale by the time anything dialled it, and re-pinned a
fresh one on every poll. [#2165](https://github.com/kibertoad/cat-factory/issues/2165) made a
churning candidate list survivable rather than proof-destroying, which lowered the cost without
removing it.

**It forced DNS into a pure response mapping.** Their `mapPREnv` is a synchronous function over the
Kargo response and the balancers are one field of it; resolution is async, so the code that knows
which balancers were chosen and in what order ended up in one place and the code that states them in
another, and neither half read as complete on its own.

**Every provider fronted by a name reimplements the same step**, including the parts that are easy
to get wrong: bounded resolution, stable ordering, and what to do when one name resolves and another
does not.

## Decision

**1. A candidate states an address OR a name, and which one is the PROVIDER'S statement.**
`environmentAddressSchema` becomes `environmentRouteCandidateSchema` (a type named
`EnvironmentAddress` carrying a `host` misleads the next reader about what `host` means) with
`address` and `host` both optional, read through one classifier, `statedRouteTarget`. Exactly one is
set; stating both, or neither, names no target and is recorded as one.

**2. Resolution is a kernel port, `HostResolver`, wired on both facades.** Node resolves through
`dns.lookup`, which is the system view a socket on that box would have used. workerd exposes no
resolver API, so the Worker asks Cloudflare's public DNS-over-HTTPS endpoint, which is the same view
its own `connect()` resolves through.

**3. The plan expands a name IN PLACE, and grades what it answered with.** `planHostResolutions`
names the bounded set of names to look up, the prover resolves them concurrently, and
`planRouteProbes` splices each name's addresses into the candidate order where the name sat. Every
resulting address goes through `isBridgeableAddress` exactly as a stated one does, so an address that
is refused when a provider states it is still refused when a name answers with it.

**4. The proof publishes the address that carried AND the name it came from.** `via` stays the
literal a bridge is built from; a new optional `viaHost` records the stated name it was resolved
from, and the fold decides a `reached` proof's survival on THAT. A balancer the provider still states
which has since scaled answers with a different address set, and matching the stored `via` against
the candidate list would drop a good proof on that routine event.

**4a. And the literal is REFRESHED where a poll can see it.** Surviving the rescale is the point,
and it is also what leaves `via` a snapshot of a set the platform does not own: the same scale-in
that keeps the name good can release that address, so a proof left alone goes on publishing a bridge
target the vendor may have handed to someone else. A `reached` proof carrying `viaHost` therefore
does not win the status poll's "a surviving proof is left alone" short-circuit; it is re-taken on
`ROUTE_REPROVE_MIN_INTERVAL_MS`, the same bound that paces a dropped proof's re-take. Known limit:
this can only refresh a literal where a poll happens, so an environment nothing polls between the
settle that proved it and the dispatch that bridges to it keeps whatever the settle recorded.

**5. Every way a name fails to become an address is its own recorded attempt.** The plan's second
target member is generalized from `refused` to `undialled`, carrying a reason and a detail: a name
that resolved nowhere is `name_unresolved` (a fact about the name, which settles that candidate), a
lookup that failed is `probe_failed` with the resolver's own words, and a deployment with nothing
wired to resolve is a new `resolver_unavailable`, which leaves the route unruled-out. A resolver
that REJECTS is folded onto that same `probe_failed`, per name: the port says it never does and
nothing can enforce that, and a fail-fast over the lookups would cost the whole proof (and, on the
poll path, the whole poll) for one adapter's bad leg.

**5a. And the plan says when it is a PREFIX.** Three caps here end the candidate list early (names
beyond `MAX_RESOLVED_HOSTS`, addresses beyond the dial budget, records beyond the recording budget),
and each one passed over a candidate the platform never looked at. The plan counts them and appends
one final `not_attempted` target naming the count, which leaves the route unruled-out: a verdict
that nothing reaches the environment may not be graded against a list the platform stopped reading.
`resolver_unavailable` gets the same treatment one layer up, where the status poll re-takes such a
proof once a resolver IS wired rather than leaving an `inconclusive` proof that survives set
equality for the life of the environment.

**6. The manifest gains `response.hostsPath` beside `addressesPath`.** Both feed the one ordered
candidate list; addresses are tried ahead of names when both are declared, and a provider wanting a
different order between them states everything through `addressesPath` as `{ address }` / `{ host }`
objects, the one shape that can interleave.

## Rationale

**Why the platform resolves rather than the provider.** The issue offered an alternative we did not
take: a `resolveAddresses` hook on the provider port, called immediately before the proof. It fixes
the staleness and the split mapping and leaves the third cost where it is, so every future provider
fronted by a name reimplements bounded resolution and partial-failure handling. Proof time is where
the answer is needed and the platform is already there.

**This grants no reach the platform did not have.** The consumer's workaround performs the identical
dials; all that moves is who does the lookup. The platform already resolves the URL's own host, which
is provider-authored on the same terms, and every address a name answers with is graded by the same
rule that governs a stated one. ADR 0062's safety property is that the orchestrator's socket and the
container's hosts file both point only at addresses the platform itself admitted, and that is intact:
the destination a bridge is built from is still an IP the platform proved.

**Why a separate field rather than reading a name out of `address`.** One widened field would be
smaller and it would rest the security rule on a parse. `isBridgeableAddress` refuses non-canonical
literals precisely because `2130706433` is loopback in a disguise, and "if it does not parse as an
address it must be a name" hands exactly those strings to a resolver, which answers loopback for them
quite happily. The kind has to be STATED, which is also why a bare string in a manifest means an
address under `addressesPath` and a name under `hostsPath` rather than being sniffed.

**Why two optional fields rather than a discriminated union in the schema.** The reachability blob is
PERSISTED and parsed defensively: an unreadable value reads as absent, taking a good proof with it. A
`v.variant` would fail the whole array on one entry a newer build wrote, so the shape is one that
cannot fail to parse and the discrimination happens in `statedRouteTarget`, which has a member for
"this names nothing I can use". Same rule as `EnvironmentRouteProof.reason` being an open string in
the same file, and the same reason.

**Why the Worker resolves over DoH rather than declaring it cannot.** A resolver-less facade would be
honest: a name candidate records `resolver_unavailable`, nothing fails, and an operator can see why.
It would also be a runtime-neutral behaviour missing from one runtime, which this repo does not
accept where the runtime CAN do the thing. workerd has no resolver API but it has `fetch`, and
Cloudflare's own resolver is the view that facade's `connect()` already uses, so a name it answers
for is a name the Worker could dial and a name it does not is one it could not. The known limit is
ADR 0062's: the orchestrator's vantage point is not the container's, and a split-horizon zone the
Cloudflare network cannot see is `unresolved` there, correctly, because that facade's own egress
cannot see it either.

**Why `resolver_unavailable` is not `probe_failed`.** Both leave the route unruled-out, so the
disposition is identical and one member would do. They send a reader to different places: one is a
lookup that went wrong and carries the resolver's words, the other is a deployment that never looked
and has a wiring fix. Collapsing them would put "we could not tell" on a condition that is fully
determined.

## Consequences

- `EnvironmentAddress` / `environmentAddressSchema` are renamed to `EnvironmentRouteCandidate` /
  `environmentRouteCandidateSchema`, and `address` is now optional. Internal, so no migration; a
  stored candidate stating an address parses and behaves exactly as it did.
- `planRouteProbes` takes a `RouteProbePlan` options object in place of its bare `timeoutMs`
  argument, `RouteProbeTarget`'s `refused` member becomes `undialled`, `recordRefusedAttempt`
  becomes `recordUndialledAttempt`, and `reduceRouteProof` takes the carrying TARGET rather than its
  address alone.
- `EnvironmentUnreachableReason` gains `resolver_unavailable` and `not_attempted`. The vocabulary is
  closed and mapped through exhaustive `Record`s (`LEAVES_ROUTE_UNKNOWN`, `UNREACHABLE_CAUSES`), so
  both had to pick a side for each before this compiled.
- `routeReproveDecision` takes `canResolveHosts`. It gates the `resolver_unavailable` re-take on the
  deployment having the capability the proof records lacking, which is the same shape the
  `unproved` case gets for free from the caller only consulting it with a prober in hand.
- The Node resolver bounds itself to two outstanding `dns.lookup` calls process-wide. The deadline
  cannot cancel one (it is a libuv threadpool call), so an abandoned leg keeps its thread until the
  platform resolver gives up: four names started at once could hold the whole default four-thread
  pool and queue every `fs` and `crypto` callback in the server behind a diagnostic. A caller that
  finds the gate full still answers within its own `timeoutMs`, as `failed`.
- `EnvironmentRouteProof` gains an optional `viaHost`. A proof written before it reads as the
  address case, which is what it was.
- Three surfaces that printed `candidate.address` into a sentence about addresses now print
  `describeRouteCandidate`, which marks a name as one. A name rendered bare into that sentence reads
  as an address somebody typed wrong.
- `CoreDependencies.hostResolver` is optional, on the same terms as `routeProbe`: absent means a name
  candidate settles nothing and an address candidate is untouched, so a facade or a test app with no
  resolver behaves as it did.
- The lookups are concurrent where the dials are sequential. Nothing is chosen by answering first
  (the answers land in a map the plan reads by name), so a resolver race cannot disturb the
  provider's order, and serialising them would add up to `MAX_RESOLVED_HOSTS` timeouts to a settle
  path already waiting on dials.
