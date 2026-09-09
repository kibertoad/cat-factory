# @cat-factory/conformance

## 0.52.2

### Patch Changes

- Updated dependencies [ca5be97]
- Updated dependencies [333b967]
  - @cat-factory/kernel@0.342.0
  - @cat-factory/orchestration@0.305.0
  - @cat-factory/server@0.318.0
  - @cat-factory/agents@0.159.1
  - @cat-factory/gates@0.11.42
  - @cat-factory/integrations@0.172.11
  - @cat-factory/prompt-fragments@1.1.38

## 0.52.1

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0
  - @cat-factory/agents@0.159.0
  - @cat-factory/orchestration@0.304.0
  - @cat-factory/server@0.317.0
  - @cat-factory/gates@0.11.41
  - @cat-factory/integrations@0.172.10
  - @cat-factory/prompt-fragments@1.1.37

## 0.52.0

### Minor Changes

- 8dc6677: Test whether an agent can actually operate a service's ephemeral environment, before a pipeline finds out
  
  "Test environment creation" answers whether a service's provisioning stands an environment up and
  takes it down again. The expensive failure is the one after that, and it is a GREEN deploy: the
  environment is up, the tester reaches it, and the agent then spends its whole step
  reverse-engineering an auth flow, guessing a base path, or reporting the service as broken because
  nobody told it which credential to send. That is a full run spent to discover a missing sentence of
  configuration.
  
  "Test agent dry run" sits beside it on the same service and buys the same finding for one
  container. It runs the identical lifecycle against a throwaway branch and adds one stage in the
  middle. The environment is handed to an agent (HTTP for a backend service, a browser for a
  frontend frame) together with the frame's sealed test credentials, the provider's own access
  handle and a read-only checkout of the branch the environment was built from. The agent picks a few
  simple but meaningful operations, at least one of which must go through authentication, attempts
  them, and reports each one: what it was, how it was performed, whether it exercised auth, and what
  happened. Then the run tears the environment down and deletes the branch exactly as before.
  
  The report's most valuable field is the one listing what the PLATFORM failed to supply (a
  credential with no reference, an endpoint that could not be discovered, an auth flow that had to
  be reverse-engineered), because each entry is a thing to fix before a real run spends a step on
  it. An operation the agent could not even attempt is a first-class outcome carrying the reason,
  not a failed call, and the failure vocabulary is grouped by whose problem each kind is: "no credential
  was supplied" and "the credential I was given was refused" are different fixes and therefore
  different members.
  
  The verdict is computed by the platform from the agent's per-operation judgements, never read off
  the reply, and it will not call a service operable unless something that worked went through
  authentication: a healthcheck answering 200 proves an ingress exists and nothing about whether an
  agent can work there.
  
  Two things to watch when reviewing. The run's `status` deliberately stays a statement about the
  LIFECYCLE, so a dry run reporting `inoperable` is a SUCCEEDED run that found something. Folding
  the verdict in would make the one interesting outcome indistinguishable from a broken diagnostic
  and leave a real teardown failure with nothing to say. And everything knowable before the first
  side effect is refused there rather than mid-run: a deployment that cannot drive a dry run at all,
  one whose runner backend has no image for THIS frame's surface, a workspace over its spend budget,
  and a frame that already has a self-test running. Each of those otherwise costs a branch, a full
  provision and a teardown to discover.
  
  Internal break: `environment_test_runs` gains `mode`, `probe_surface`, `probe_dispatched_at`,
  `probe_progress` and `probe` on both runtimes, and the start endpoint takes an optional `{ mode }`
  body (absent is the provisioning self-test, so an existing client is unchanged). The reasoning, the
  traps and the wiring: `backend/docs/environment-self-tests.md`.

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/contracts@0.348.0
  - @cat-factory/kernel@0.340.0
  - @cat-factory/agents@0.158.0
  - @cat-factory/orchestration@0.303.0
  - @cat-factory/server@0.316.0
  - @cat-factory/gates@0.11.40
  - @cat-factory/integrations@0.172.9
  - @cat-factory/prompt-fragments@1.1.36

## 0.51.11

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/agents@0.157.2
  - @cat-factory/integrations@0.172.8
  - @cat-factory/kernel@0.339.0
  - @cat-factory/orchestration@0.302.2
  - @cat-factory/server@0.315.2
  - @cat-factory/gates@0.11.39
  - @cat-factory/prompt-fragments@1.1.35

## 0.51.10

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/agents@0.157.1
  - @cat-factory/integrations@0.172.7
  - @cat-factory/kernel@0.338.0
  - @cat-factory/orchestration@0.302.1
  - @cat-factory/server@0.315.1
  - @cat-factory/gates@0.11.38
  - @cat-factory/prompt-fragments@1.1.34

## 0.51.9

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/orchestration@0.302.0
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0
  - @cat-factory/agents@0.157.0
  - @cat-factory/server@0.315.0
  - @cat-factory/integrations@0.172.6
  - @cat-factory/gates@0.11.37
  - @cat-factory/prompt-fragments@1.1.33

## 0.51.8

### Patch Changes

- Updated dependencies [5c50d30]
  - @cat-factory/agents@0.156.3
  - @cat-factory/contracts@0.346.2
  - @cat-factory/integrations@0.172.5
  - @cat-factory/kernel@0.336.1
  - @cat-factory/orchestration@0.301.3
  - @cat-factory/prompt-fragments@1.1.32
  - @cat-factory/server@0.314.3
  - @cat-factory/gates@0.11.36

## 0.51.7

### Patch Changes

- Updated dependencies [cd220f2]
  - @cat-factory/agents@0.156.2
  - @cat-factory/integrations@0.172.4
  - @cat-factory/kernel@0.336.0
  - @cat-factory/orchestration@0.301.2
  - @cat-factory/server@0.314.2
  - @cat-factory/gates@0.11.35
  - @cat-factory/prompt-fragments@1.1.31

## 0.51.6

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1
  - @cat-factory/orchestration@0.301.1
  - @cat-factory/server@0.314.1
  - @cat-factory/agents@0.156.1
  - @cat-factory/gates@0.11.34
  - @cat-factory/integrations@0.172.3
  - @cat-factory/prompt-fragments@1.1.30

## 0.51.5

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0
  - @cat-factory/agents@0.156.0
  - @cat-factory/orchestration@0.301.0
  - @cat-factory/server@0.314.0
  - @cat-factory/gates@0.11.33
  - @cat-factory/integrations@0.172.2
  - @cat-factory/prompt-fragments@1.1.29

## 0.51.4

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0
  - @cat-factory/agents@0.155.0
  - @cat-factory/orchestration@0.300.0
  - @cat-factory/server@0.313.0
  - @cat-factory/gates@0.11.32
  - @cat-factory/integrations@0.172.1
  - @cat-factory/prompt-fragments@1.1.28

## 0.51.3

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0
  - @cat-factory/agents@0.154.0
  - @cat-factory/orchestration@0.299.0
  - @cat-factory/integrations@0.172.0
  - @cat-factory/server@0.312.0
  - @cat-factory/gates@0.11.31
  - @cat-factory/prompt-fragments@1.1.27

## 0.51.2

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0
  - @cat-factory/agents@0.153.1
  - @cat-factory/gates@0.11.30
  - @cat-factory/integrations@0.171.2
  - @cat-factory/orchestration@0.298.1
  - @cat-factory/prompt-fragments@1.1.26
  - @cat-factory/server@0.311.3

## 0.51.1

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0
  - @cat-factory/agents@0.153.0
  - @cat-factory/orchestration@0.298.0
  - @cat-factory/gates@0.11.29
  - @cat-factory/integrations@0.171.1
  - @cat-factory/prompt-fragments@1.1.25
  - @cat-factory/server@0.311.2

## 0.51.0

### Minor Changes

- 1c79070: An environment provider can state a balancer by NAME, and the platform resolves it when it dials
  
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
  failed (or a resolver that rejected, which the port forbids and nothing can enforce) carries the
  resolver's own words, and a deployment with nothing wired to resolve records the new
  `resolver_unavailable` reason, which settles nothing either way and can never fail a frame. Both
  facades wire a resolver (Node through `dns.lookup`, the Worker over DNS-over-HTTPS, which is the
  view its own outbound connections already resolve through).
  
  The platform also says when it stopped reading: the plan bounds how many names it looks up and how
  many addresses it dials, and a list longer than that now ends in one `not_attempted` attempt naming
  how many were passed over. That is a second new reason, and it leaves the route unruled-out for the
  same reason the first does. A verdict that nothing reaches an environment may not be graded against
  candidates nobody looked at, and the deployer fails a frame on that verdict.
  
  Two proofs that used to stand forever are now re-taken by the status poll: one recording that this
  deployment could not resolve a name (once one is wired), and a `reached` proof whose address was
  RESOLVED rather than stated. The second is the price of surviving a balancer rescale, which is what
  `viaHost` is for: the name stays good while the literal beside it, the one a container host bridge
  is built from, can be released by the same scale event.
  
  Internal breaks, no migration: `EnvironmentAddress` / `environmentAddressSchema` are renamed to
  `EnvironmentRouteCandidate` / `environmentRouteCandidateSchema` with `address` now optional;
  `planRouteProbes` takes an options object in place of its bare timeout argument;
  `RouteProbeTarget`'s `refused` member is generalized to `undialled` and `recordRefusedAttempt` to
  `recordUndialledAttempt`; and `reduceRouteProof` takes the carrying target rather than its address.
  A stored candidate or proof written before this parses and behaves exactly as it did.

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0
  - @cat-factory/integrations@0.171.0
  - @cat-factory/agents@0.152.0
  - @cat-factory/orchestration@0.297.0
  - @cat-factory/gates@0.11.28
  - @cat-factory/prompt-fragments@1.1.24
  - @cat-factory/server@0.311.1

## 0.50.3

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0
  - @cat-factory/agents@0.151.0
  - @cat-factory/orchestration@0.296.0
  - @cat-factory/server@0.311.0
  - @cat-factory/gates@0.11.27
  - @cat-factory/integrations@0.170.1
  - @cat-factory/prompt-fragments@1.1.23

## 0.50.2

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0
  - @cat-factory/integrations@0.170.0
  - @cat-factory/agents@0.150.0
  - @cat-factory/orchestration@0.295.0
  - @cat-factory/gates@0.11.26
  - @cat-factory/prompt-fragments@1.1.22
  - @cat-factory/server@0.310.2

## 0.50.1

### Patch Changes

- Updated dependencies [436f373]
- Updated dependencies [720bad0]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0
  - @cat-factory/orchestration@0.294.0
  - @cat-factory/agents@0.149.1
  - @cat-factory/gates@0.11.25
  - @cat-factory/integrations@0.169.1
  - @cat-factory/prompt-fragments@1.1.21
  - @cat-factory/server@0.310.1

## 0.50.0

### Minor Changes

- a745ee2: An environment now carries an address as well as a name, and the platform proves the route before a tester is pointed at it
  
  An environment reached an agent as one nullable URL, so "reachable" meant "a URL exists" and
  nothing between the provider stating it and a tester dialling it ever checked. The tester then got
  `curl` code 000, which covers a DNS failure, a missing route and a refused connection as one
  symptom, and reported the hypothesis its own task made salient: that the environment was down.
  
  Three things change together, because landing any one alone is incoherent or worse than today. A
  host bridge can now map a name to an ADDRESS as well as to the container runtime's host gateway,
  which is what a per-PR environment whose DNS record lives in an internal view needs. The deployer
  DIALS the environment once when its frame settles ready, publishing the candidate that carried
  rather than the first that resolved and recording every attempt either way. And what it proved
  rides the handle into the tester's prompt, so an agent that cannot resolve a name is told which
  layer the platform already ruled out and which address carried.
  
  An environment nothing can reach now settles the frame `failed` with the new
  `environment_unreachable` reason, in about two minutes, rather than being handed on for a tester to
  spend ten minutes and a model budget misdiagnosing. That failing verdict is deliberately the narrow
  one, because a wrong "unreachable" kills a healthy deploy while a wrong "could not tell" costs one
  diagnostic: a probe that could not classify its own failure, an environment with no address to dial
  (a `ready` service that publishes no ingress), and a facade with nothing wired to open a socket are
  `inconclusive` or `unproved`, and neither fails anything. The agent is told when a check was
  inconclusive; a deployment with no prober carries no reachability line at all.
  
  The addresses the platform will dial are limited to those a host bridge may name, applied when the
  probe is PLANNED rather than only when a bridge is built, so a provider-authored address list
  cannot aim the platform's own outbound socket at loopback or a cloud metadata endpoint. A refused
  address is recorded on the proof rather than silently dropped.
  
  Internal breaks, both deliberate: `RunnerDispatchOptions.environmentUrls` becomes `environments`,
  a list of `{ url, address? }` (the pairing is what keeps the host side of a bridge a host the job
  was actually handed), and `planEnvironmentBridges` moves from the local runtime into
  `@cat-factory/integrations`, where the Kubernetes runner transport builds the same bridges as pod
  `hostAliases`. Existing environment rows carry no addresses and no proof, which reads exactly as it
  should: nothing has looked yet.

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0
  - @cat-factory/integrations@0.169.0
  - @cat-factory/agents@0.149.0
  - @cat-factory/orchestration@0.293.0
  - @cat-factory/server@0.310.0
  - @cat-factory/gates@0.11.24
  - @cat-factory/prompt-fragments@1.1.20

## 0.49.0

### Minor Changes

- 92232a6: Let a provider say WHY an environment is not ready yet, so the readiness ceiling stops reporting only its own duration
  
  `judgeEnvironmentReadiness` formatted the provider's `lastError` into its `timed_out` message, and
  `lastError` is structurally always `null` on the one status that can reach that branch. Both
  persistence sites write it on `failed` alone and null it otherwise, so every poll that keeps a
  readiness wait alive cleared it and any poll that would have filled it settled the wait as `failed`
  first. The clause was unreachable, and the platform's whole account of a 20-minute wait was that it
  had waited 20 minutes.
  
  The missing thing was not the clause. `ProvisionedEnvironment` had no channel at all for a
  non-terminal explanation, so a provider that could name the stage an environment was stuck at had
  nowhere to put it. `ProvisionedEnvironment.statusNote` is that channel: one sentence, persisted on
  every provision and every poll whatever the status, surfaced in the step's Environment panel while
  the run is parked, in the run outcome's environment row, and in the `timed_out` failure detail.
  
  **A sibling field rather than `lastError` widened to every status**, which was the cheaper option
  and the wrong one. The note is rendered, and under the error's name a healthy environment
  mid-rollout would show an operator a "last error" it does not have. The two are read by different
  readers for opposite reasons and only one of them is a fault, so each keeps its own column and its
  own label wherever it is shown.
  
  **A recorded fault outranks a note on every reader, and neither is ever dropped for the other.**
  The `timed_out` message states both when both are present, fault first, each under its own label.
  The Environment panel withholds the note whenever a `lastError` is recorded, whatever the status
  (a torn-down environment carries the fault of the failure that preceded it), and says nothing
  beside a status that has already left the state a note describes. And where the run OUTCOME's
  environment row shows one of them, it says which: `OutcomeEnvironment.detailKind` is `fault` or
  `note`, because the two arrive through one slot, read identically as prose, and send a reader to
  opposite conclusions. Public API surface 1.63.0, additive.
  
  **The note is bounded where it is written**, not where it is read: provider-authored prose reaches
  three surfaces, and a code adapter answering with a controller dump would otherwise push each of
  them off screen. A capped note says it was capped.
  
  **The note is the current account, never a log.** It is re-read and rewritten on every poll,
  including back to `null`, so a note a provider stops returning stops being stored and cannot outlive
  the state it described. A deployment whose providers never set one keeps today's behaviour byte for
  byte, including the exact wording of both refusals.
  
  The built-in Kubernetes adapter is the first producer, at the two places it already knew and said
  nothing: which Deployments have not finished rolling out (capped, and the cap says it is capped),
  and a workload that is healthy behind an Ingress no controller has routed yet, where the ceiling
  previously reported a bare twenty-minute wait on an environment that had been up for nineteen of
  them. `IngressAdmission`'s `pending` verdict gained the prose that distinguishes its two causes.
  
  Its FAULT channel had the same hole, one status over, and it is closed here too: a rollout that
  gave up and a namespace that no longer exists were both reported as the generic `Provisioning
  failed` literal, though the reduction computing the verdict was holding the workload's own name.
  Both now name what happened.
  
  Watch for: the new `status_note` column lands as a nullable add on both runtimes (D1 migration 0098
  and the Drizzle mirror), and the deployer's projection comparison is now derived from the projected
  object rather than a hand-listed subset of its fields. During a wait the note is the only field that
  moves, so leaving it off the list would have meant the one update the projection exists to deliver
  was the one it never pushed; the TTL, provision type and engine beside it were already in that
  position, and now a field added to the projection joins the comparison with no second edit.
  
  The Node Drizzle schema's ephemeral-environment tables moved into `db/tables/environments.ts` to
  keep `schema.ts` inside its size budget, re-exported so no importer changes.

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0
  - @cat-factory/integrations@0.168.0
  - @cat-factory/orchestration@0.292.0
  - @cat-factory/server@0.309.0
  - @cat-factory/agents@0.148.0
  - @cat-factory/gates@0.11.23
  - @cat-factory/prompt-fragments@1.1.19

## 0.48.0

### Minor Changes

- dc4a5d9: Import an organisation's Backstage catalog, so triage agents know which services exist and who owns them
  
  The platform knew a great deal about the service being built and, since ADR 0031, about the shared
  capabilities a deployment registered by hand. It knew nothing about the rest of the estate. That
  cost most on the triage path: a bug investigator looking at a cross-service report had the
  repositories it was handed and no record of what else the organisation runs, who owns it, or what
  it exposes, so "which service is this?" was answered from repository names.
  
  Most organisations already record exactly that, in a developer portal. A workspace can now point
  the platform at its Backstage instance and have its components arrive as `workspace`-tier
  foundational services: identity, owner, system, domain and lifecycle composed into the
  description, tags as capabilities, and each API entity's definition stored as one of the service's
  contracts.
  
  **It feeds the EXISTING catalog rather than standing beside it**, which is the decision the rest
  follows from. A parallel mechanism would have meant a second `.cat-context/` directory, a second
  set of trait guidance, a second tiered merge and a second suppression surface, all describing the
  same organisation to the same agents. So an imported service is an ordinary catalog row carrying
  `sourceId: 'service-catalog'`, and the tier merge, the suppression sub-resource, the lazily-read
  contract documents and the SPA's catalog list are untouched.
  
  **Triage agents read it under a new `service-estate` trait, deliberately not the design one.**
  `foundational-catalog` asks its kind to prefer consuming a shared service and to end its reply
  with a machine-read declaration block; both are wrong for an agent whose job is to locate a fault,
  and the second is worse than wrong, because `bug-investigator` and its peers are structured-output
  kinds whose reply IS a JSON object. The estate file states ownership and interface surface and
  asks for nothing back. `bug-investigator` and `on-call` carry it; a deployment's own kind opts in
  through `registerAgentKind({ traits })`. It carries no contract DOCUMENTS: an orientation read
  happens on every triage dispatch, and folding every service's OpenAPI document into one would make
  the prompt scale with the size of the organisation's specs, which is what the catalog/contracts
  split exists to prevent.
  
  **The auth modes are a closed vocabulary of the shapes a self-hosted portal actually runs
  behind**: a static service token, the legacy shared secret (a short-lived HS256 token the platform
  mints per pass), OAuth2 client credentials for an instance behind an IdP or an identity-aware
  proxy, HTTP Basic for a reverse proxy, an explicit header list for a gateway that authenticates on
  its own names, and none at all for an instance reachable only inside a VPN. Free-form headers
  alone would have covered the mechanics and lost every remedy an operator needs when one fails. Two
  details are load-bearing: the legacy secret is base64-DECODED into an HMAC key rather than used as
  UTF-8 (which is what decides whether the token verifies at all, so a secret that is not base64 is
  refused rather than signed with the wrong key), and the header mode takes a LIST because the
  common case needs two: a Cloudflare Access service token is an id plus a secret, and a
  single-pair shape would have sent half a credential.
  
  Reviewers may want to look hardest at three things.
  
  **Widening the URL guard is the ordinary case here, not an exception.** A self-hosted portal
  usually lives on an internal host, so `SERVICE_CATALOG_ALLOW_URL_HOSTS` /
  `SERVICE_CATALOG_ALLOW_HTTP_URLS` exist and are scoped to this integration alone. Redirects are
  followed by hand and re-checked per hop, with the body and `Authorization` dropped on a
  cross-origin one, because the base URL is operator-supplied.
  
  **A partial import must never read as the estate.** An import reports `complete` / `truncated` /
  `empty` coverage plus three skip counts, and stamps `ok` / `partial` / `failed` with a sentence on
  the connection. `empty` is `partial` rather than a healthy import of zero services, because a
  filter that matched nothing is a configuration problem with a remedy. EVERY failure past the
  connection lookup is stamped before it propagates, including one raised before the portal is
  contacted: `lastSyncedAt` is what the autorefresh sweep orders on and it sorts nulls first, so an
  unstamped failure would pin that connection to the head of the stale queue and starve the sweep.
  A failure tombstones nothing: an unreachable portal and an empty one are opposite facts.
  
  **The import YIELDS to a service the workspace already registered by another route**, counting the
  refusal as `skippedConflicts` rather than taking the id over. An upsert there would replace a
  hand-authored row, delete its uploaded contracts and strip any platform capability it was granted,
  and disconnecting would then tombstone the original.
  
  **Two size ratchets moved DOWN, both by splitting.** The Worker's `container.ts` lost its three
  content-library selectors to a new `container-content-library-deps.ts`, the twin of the file the
  Node facade already had, so both facades now hold the same selectors in the same place (874 → 800).
  `orchestration`'s `dependencies.ts` lost the same three libraries' declarations to
  `content-library-dependencies.ts`, which `CoreDependencies` extends (1514 → 1301, under the
  default).
  
  Also in here, because the import needs them: `asyncapi`, `graphql` and `grpc` join the
  contract-format vocabulary, with AsyncAPI indexed (its channels are a parse, not a guess) and the
  other two answering through `operationsAreIndexable` as formats nobody reads. That widened what a
  linked-repository SCAN picks up too, so `detectContractFormat` requires a type-system definition of
  a `.graphql`/`.gql` file and a `service` block of a `.proto` one: the common `.gql` in a repo is a
  client's query text and the common `.proto` is generated message shapes, and neither is an
  interface the service publishes. `ApiContractManifestEntry` gains `sourceSha`, so a sync can decide
  whether a document changed without reading a body. The rendered catalog and estate blocks gained a
  total size cap that states what it dropped, because an imported estate is the first catalog whose
  size is decided by the organisation rather than by this deployment; the catalog's per-service
  heading now reads `id (Name)`, the form the estate block already used.
  
  Four batched repository methods land with it (`upsertMany`, `softDeleteByIds`,
  `replaceForServices`, `deleteForServices`, all on the mothership allow-list): reconciling a
  thousand-service estate one row at a time is two thousand sequential round trips inside one
  request. The `ownerFieldList` scope rule is new beside them, binding every record of a batched
  write rather than the first.

### Patch Changes

- 4d999cb: Treat OpenRouter as the gateway it is, rather than as one more OpenAI-compatible vendor.
  
  **Its own client.** `openrouter` now resolves through `@openrouter/ai-sdk-provider`
  (`openRouterResolver`) instead of the generic `createOpenAICompatible`; every other
  OpenAI-compatible provider is unchanged. The dispatch is made once, in
  `directOpenAiCompatibleResolver`, which both entry points that build a provider from a leased key
  route through.
  
  **Cost and upstream are now RECORDED rather than derived.** Usage accounting is requested on both
  model paths, so `llm_call_metrics` gains `reported_cost_usd` (the gateway's own USD ledger figure)
  and `upstream_provider` (which vendor actually served the call). Both are nullable and null is
  load-bearing: every other cost on the table is derived from the spend price table, so a 0 would
  report an unpriced call as free. **Break:** the two columns are added to the D1 telemetry store, the
  Postgres `telemetry` schema and local mode's SQLite store; existing rows read NULL, which is the
  correct answer for them.
  
  **`supportsStructuredOutputs` is now set** on the generic OpenAI-compatible client for the cloud
  VENDORS. Without it the SDK silently rewrites a schema-carrying request to `{ type: 'json_object' }`
  and drops the schema. Nothing in this repo passes a schema today, so this closes a trap rather than
  changing behaviour. It is withheld from the upstreams nobody here can vouch for: per-user local
  runners (which never come through this path anyway) and the operator-hosted `bifrost` / `litellm`
  gateways, whose model ids are the operator's own aliases and routinely front an Ollama or vLLM
  model that answers a `json_schema` request with a 400.
  
  **The `/models` catalog reads what it was dropping**: the conditional `overrides` pricing bands
  (folded to their maximum), both cache classes and the 1-hour write fallback, `expiration_date` and
  `canonical_slug`. A published cache rate now reaches the spend table instead of the derived
  multiplier, unless it is zero, which cannot be told apart from a placeholder for a class the
  gateway does not bill separately and would meter every cache hit free. A model's withdrawal date
  is shown in the catalog picker.
  
  **Prompt caching is no longer reported as absent for every gateway model.** `providerCachePolicy`
  takes the model, so an `openrouter:deepseek/…` slug resolves to the policy stated for its vendor
  prefix. Those are stated per prefix rather than borrowed from the direct provider of the same
  name, because the two genuinely differ: OpenRouter's Moonshot route caches automatically while our
  direct `moonshot` does not, and its Alibaba route needs explicit breakpoints while direct Qwen
  does not. Anthropic (and now Qwen) behind a gateway stays `none`, because nothing on that path
  sends `cache_control`. **Break:** the rule moved from `@cat-factory/kernel` to
  `@cat-factory/contracts` (kernel re-exports it unchanged) so the SPA can read the same function
  instead of mirroring it in a Vue constant, which had already drifted.
  
  **Two new env vars, because both routing constraints can empty the upstream pool.**
  `OPENROUTER_DATA_COLLECTION` (default `deny`, stricter than the vendor's own) is whether OpenRouter
  may route to a prompt-retaining upstream; `OPENROUTER_REQUIRE_PARAMETERS` (default `true`) is
  whether it must route only to an upstream advertising every parameter the request carries. A pool
  narrowed to nothing is a 404, not a degraded call, so the proxy recognises that refusal and records
  which constraint could have caused it: the gateway cannot say, since our request is the only place
  both are stated.
  
  **New check `scripts/check-openrouter-pins.mjs`** re-reads the live catalogue against the spend
  table's pinned slugs, comparing all three pinned classes: input, output, and the cache-READ rate a
  row names only where the vendor departs from the derived floor (so nothing else follows it when the
  vendor moves). Its runs found four pins metering below the live rate, one
  (`deepseek/deepseek-v4-pro`) by nearly 3x; all four are repinned here.
  
  **Reported cost and upstream are rendered**, in the observability panel's call list: the upstream
  beside `provider:model`, the gateway's own figure in the expanded row. They stay out of the spend
  rollups, which remain derived end to end, because a rollup mixing a measured figure for one
  provider's rows with an estimate for the rest answers a different question per row.
  
  **The inline instrumented provider now REFUSES to stream** rather than passing an unrecorded call
  through. Nothing inline streams today (the recorder hard-codes `streaming: false` for that reason),
  and a streamed call would have reached no sink at all, which downstream is indistinguishable from a
  step that spent nothing.
- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0
  - @cat-factory/integrations@0.167.0
  - @cat-factory/agents@0.147.0
  - @cat-factory/orchestration@0.291.0
  - @cat-factory/server@0.308.0
  - @cat-factory/gates@0.11.22
  - @cat-factory/prompt-fragments@1.1.18

## 0.47.19

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/agents@0.146.6
  - @cat-factory/integrations@0.166.22
  - @cat-factory/kernel@0.323.2
  - @cat-factory/orchestration@0.290.2
  - @cat-factory/server@0.307.9
  - @cat-factory/gates@0.11.21
  - @cat-factory/prompt-fragments@1.1.17

## 0.47.18

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/agents@0.146.5
  - @cat-factory/integrations@0.166.21
  - @cat-factory/kernel@0.323.1
  - @cat-factory/orchestration@0.290.1
  - @cat-factory/server@0.307.8
  - @cat-factory/gates@0.11.20
  - @cat-factory/prompt-fragments@1.1.16

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
