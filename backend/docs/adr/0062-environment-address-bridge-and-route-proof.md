# ADR 0062: An environment carries an address as well as a name, and the route is proved once

- Status: accepted
- Date: 2026-09-01
- Context layer: `@cat-factory/contracts` (the reachability vocabulary) + kernel (the bridge rule,
  the probe port, the proof logic) + `@cat-factory/integrations` (the provider field, the shared
  bridge plan, the prover) + orchestration (the deployer settle) + `@cat-factory/server` (the
  dispatch declaration) + `@cat-factory/agents` (what the tester is told) + all three runtime
  facades

Extends `shared/environment-host-bridge.logic.ts` (PR #2075 and its successor, which fixed the
LOCAL half of this) and [ADR 0033](./0033-bugfix-reproduction-proof.md)'s principle that a claim
the platform makes about a run should be one it can show evidence for. Closes issue #2148.

## Context

An environment reached an agent as one nullable string. "Reachable" therefore meant "a URL exists",
and nothing between the provider stating that URL and a tester dialling it ever checked.

`environment-host-bridge.logic.ts` exists because of what that costs. The tester that motivated it
reported `curl` code 000 on every one of ~39 attempts over fourteen minutes and concluded the
ENVIRONMENT was down, when the environment was serving perfectly to anything on the host. That
module fixed the case it was built for: a compose stack on `localhost`, re-pointed into the
container at the runtime's host gateway.

A deployment running Kargo preview environments hit the adjacent case, and it produced three
findings that are one piece of work.

**A bridge could carry a name but never an address.** The classifier's three outcomes are `none`,
`bridge` and `unbridgeable`, and `none`'s own docstring asserts the thing that is false for a
remote environment whose name resolves nowhere: "the container reaches it as written". That is the
DEFAULT state for a per-PR environment whose record lives in an internal DNS view while the
balancers fronting it are ordinary public names and the ingress routes on the `Host` header. The
address exists, the container's egress reaches it, and the only missing thing is a name-to-address
mapping, which is exactly what a hosts entry is. The module already drew that distinction for the
LOCAL version of the same state, so the omission was visible against its own design.

**Nothing ever proved a route.** A name that resolves is not a route that carries: an internal
balancer publishing private addresses in public DNS gives a lookup that succeeds and an address
most readers cannot route to, which is the expensive failure. Verified whole-repo, the only socket
sites were the local-mode boot preflight and two CLI probes; the connection probes test a
PROVIDER'S management API and the infra sweep tests CONFIGURED connections. Neither ever saw a
provisioned environment's URL, and the dispatch guard named in
`domain/environment-readiness.logic.ts` as owning reachability was a null check on a string.

**A tester had no way to say which layer failed.** `EnvironmentAccessHandle` models authentication
with six fields; addressing was one nullable string, and the `Host / Port / Scheme` lines in the
prompt are a re-parse of it rather than independently known facts. `curl` code 000 covers a DNS
failure, a missing route, a refused connection and a TLS failure as one symptom, and the hypothesis
an agent's own task makes salient is "the environment is broken", which is the one wrong answer
that looks like a finding rather than a gap in evidence.

A live incident on 2026-09-01 separated the layers precisely. The tester was handed the
environment's name, could not resolve it, polled for ten minutes and failed the run, reporting the
DNS layer accurately (it even ruled out its own sandbox) and the cause wrongly. Underneath: the
name did not resolve, a route existed anyway through both balancers with the `Host` header
preserved under a valid certificate, and the route carried nothing because the VM was offline. The
environment really was dead, the tester really did have a usable route to prove it with, and
nothing in the interface let it hold both thoughts. The adapter had already computed the right
answer and had nowhere to put it: the balancer list went into `provisionFields`, which is persisted
encrypted as teardown state and reaches nobody.

## Decision

Five changes, in dependency order. Landing any one alone is incoherent or worse than today.

**1. The bridge target is explicit.** `LocalMachineHostBridge`'s `bridge` member gains
`target: 'host-gateway' | { ip: string }` rather than the type gaining a fourth sibling `kind`, so
`none` / `bridge` / `unbridgeable` keep meaning what they mean. The address rule is stated in
kernel beside the classifier (`isBridgeableAddress`), and a bridge's identity is `hostBridgeKey`,
because that string decides whether a running container is destroyed and rebuilt.

**2. A typed address field beside `url`.** `ProvisionedEnvironment.addresses` carries what a
provider STATES, through `EnvironmentRecord.reachability` (a new column on both facades) to
`EnvironmentHandle`, `resolveForBlock`, agent context and dispatch options. Explicitly not a
`ProvisionFields` key: those are encrypted teardown state, absent from every handle, so an address
written there reaches nobody who could dial it. The manifest-driven provider reads it from an
`addressesPath`, so a deployment states its addresses declaratively rather than by forking.

**3. The deployer proves the route once**, at the ready write, publishing the candidate that
CARRIED rather than the first that RESOLVED and recording every attempt either way. A bounded TCP
connect through the new kernel `RouteProbe` port, wired on both facades (`net` on Node,
`cloudflare:sockets` on the Worker). It is deliberately NOT a gate:
`deployment-failure-remediation.md` already withdrew a `deploy-health` gate on the grounds that the
deployer owns provisioning through to a terminal verdict.

**4. The proved result is the note on the handle**, with `EnvironmentUnreachableReason` as a
SIBLING vocabulary of `EnvironmentFailureReason`. That one is provisioning-scoped in every member
and in its docstring (`cluster_unreachable` means the PROVIDER could not be reached), and a
reaching failure against a `ready` environment is a different question for a different audience.
`EnvironmentFailureReason` gains exactly one member, `environment_unreachable`, because that is the
vocabulary the deployer settles a frame in; it is not repo-fixable, so the remediation loop stays
out of it.

**5. Both container runtimes install what they can, and the third says it cannot.**
Name-to-`host-gateway` is genuinely Docker-family-only. Name-to-address is not: Kubernetes
`hostAliases` is natively `{ ip, hostnames[] }`, so the pod manifest carries it and the runner
transport replaces a pod created without an alias it now needs (readable off the live pod, which is
the one thing this transport can do that Docker cannot). Apple `container` declares
`honoursHostBridges: false` and the transport says so once per dispatch rather than accepting the
field and dropping it.

## Rationale

**Why the three findings are one change.** (1) alone builds the pipe and puts unverified data in
it, which is strictly worse than today: `bridgedHosts` would record a bridge as successfully
applied while the tester still failed, so the evidence would point further from the cause than it
does now. (2) alone has nothing to prove, since the only address a bridge could name was a literal
chosen by code. (3) alone has nothing to report, because `resolveForBlock` carried no address facts
to narrate.

**Why a TCP connect and not a request.** The question is whether packets get there. The incident's
balancer answered 503 over a route that worked perfectly, and reading an HTTP status as the
transport verdict would have mislabelled the one fact the tester needed. Proving the transport and
observing the application stay separate jobs, which is also why a `reached` environment can still
be reported dead by the tester a moment later.

**Why the proof fails the frame.** Step 3 would have changed the incident's outcome on its own, and
not by making the environment work: the deployer settles `failed` naming an unreachable target in
about two minutes, instead of a tester spending ten and a model budget arriving at a confident
diagnosis of the wrong layer. The known limit is that the ORCHESTRATOR'S vantage point is not the
CONTAINER'S, so a deployment whose backend egress differs from its runners' can see a route the
agent cannot, or miss one it has. Three things bound it: `unproved` is a distinct state that never
fails anything, so a facade with no prober behaves exactly as before; the reason and every attempt
are recorded, so a misdiagnosis is legible rather than silent; and a conformance app always injects
its probe, because a suite whose deploys depend on the machine's DNS is asserting the wrong thing.

**Why security shapes this rather than blocking it.** `planEnvironmentBridges` needed no allow-list
while the target was the fixed literal `host-gateway`: the destination was CODE. An address makes
it DATA, on a path whose container is the trust boundary, and with no rule beyond "the provider said
so" a `<host>:<ip>` pair could re-point any name inside the container, including the harness's own
alias for reaching back to its host. The rule has two halves, both structural. `isBridgeableAddress`
refuses loopback (which inside a container is the container's own namespace, where the harness
listens), link-local and vendor metadata, the unspecified/multicast/broadcast ranges, and every
non-canonical literal encoding; RFC1918 is deliberately ALLOWED, because an internal balancer on
`10.x` is the entire population this exists for. And the HOST side comes from the URL the job was
handed, because `DispatchEnvironment` PAIRS the address with its URL rather than carrying a
free-form map a provider could key by any name.

## Consequences

- An `EnvironmentHandle` now carries `reachability`: the provider's stated candidates and what
  dialling them proved. An unreadable or stale blob reads as ABSENT rather than throwing, because
  "no proof" and "an unparseable proof" are the same fact to every reader.
- A provisioning failure can now be `environment_unreachable`. It is in `REPO_FIXABLE_ENVIRONMENT_
FAILURES` as `false`: a DNS zone, a security group or a load balancer is not in the checkout, and
  an agent handed the failure and a repo has exactly one move, which is to change the address the
  manifest publishes.
- `RunnerDispatchOptions.environmentUrls` is replaced by `environments`, a list of
  `{ url, address? }`. Internal wire shape, so no migration; the pairing is the point.
- `planEnvironmentBridges` moved from `runtimes/local` into `@cat-factory/integrations`, because
  the Kubernetes runner transport builds the same bridges and the two must not drift about what
  they dropped.
- A Kubernetes runner pod created before its run's environment existed is now DELETED and
  recreated when it lacks a needed alias, waiting out the terminating one holding its name. That
  cost is the same trade the local transport already makes, against a step that otherwise fails
  every single time.
- The `environments` table gains a plaintext `reachability` column on both facades. Deliberately
  not encrypted: a list of addresses for a host already published in plaintext beside it is neither
  a credential nor arbitrary provider state.
