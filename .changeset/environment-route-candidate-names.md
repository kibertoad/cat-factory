---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
---

An environment provider can state a balancer by NAME, and the platform resolves it when it dials

A route candidate had to be an IP literal, on the reasoning that "a name would just be the lookup
that already failed". That is true of the environment's own hostname and false of the name the
deployments this feature exists for actually have: a per-PR environment whose record lives in an
internal view is fronted by load balancers that are ordinary public names, and those names resolve
from anywhere. A provider had to resolve them itself and state the result, which pins a snapshot of
a set that rotates as the balancer scales, forces DNS into a pure response mapping, and asks every
such provider to get bounded resolution and partial failure right on its own.

A candidate may now state `host` instead of `address`, and a manifest declares one through the new
`response.hostsPath` beside `addressesPath`. The platform resolves each stated name at the moment
it dials, expands it in place into the addresses it answered with (so the provider's preference
order still means what it says), and grades every one of those addresses by exactly the rule that
governs a stated address, so an address a bridge may not name is still refused and the destination
a container is bridged to is still a literal the platform itself proved. The proof publishes the
address that carried plus the name it came from, and the stored candidate stays the stable identity
rather than today's answer, which is also what lets a proof survive the balancer changing addresses.

Which kind a candidate names is stated, never inferred from the value. The address rule refuses
`2130706433` precisely because it is loopback in a disguise, and a resolver handed the same string
answers loopback without complaint, so a bare string means an address under `addressesPath` and a
name under `hostsPath`.

Every way a name fails to become an address is recorded as its own attempt rather than dropped: a
name that resolves nowhere rules that candidate out and the proof moves to the next, a lookup that
failed carries the resolver's own words, and a deployment with nothing wired to resolve records the
new `resolver_unavailable` reason, which settles nothing either way and can never fail a frame.
Both facades wire a resolver (Node through `dns.lookup`, the Worker over DNS-over-HTTPS, which is
the view its own outbound connections already resolve through).

Internal breaks, no migration: `EnvironmentAddress` / `environmentAddressSchema` are renamed to
`EnvironmentRouteCandidate` / `environmentRouteCandidateSchema` with `address` now optional;
`planRouteProbes` takes an options object in place of its bare timeout argument;
`RouteProbeTarget`'s `refused` member is generalized to `undialled` and `recordRefusedAttempt` to
`recordUndialledAttempt`; and `reduceRouteProof` takes the carrying target rather than its address.
A stored candidate or proof written before this parses and behaves exactly as it did.
