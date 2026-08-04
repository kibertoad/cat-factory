# @cat-factory/server

## 0.203.0

### Minor Changes

- 807e442: Let a deployment register its own task source in code. The source vocabulary is now
  `builtin picklist ∪ <namespace>:<name>`, matching the shape task types already use, so a
  deployment's provider on the app-owned `TaskSourceRegistry` is served by connect, import,
  search, bug hunt and webhook intake without a fork.

  The built-ins keep their bare ids, so no persisted row changes. A bare non-built-in id still
  fails validation, keeping a typo distinguishable from a registration.

  Issue-intake board scope gains an opaque `boardId` leg for registered sources; without it a
  registered source's board id fell through to the GitHub field.

- 175f78f: Security hardening round 2, P1: close SEC-3, SEC-4 and SEC-5 (docs/initiatives/security-hardening-round-2.md).

  - **Machine tokens are revocable (SEC-5).** Every `POST /auth/machine-token` mint is recorded on
    the new `machine_nodes` roster (kernel `MachineNodeRepository`; D1 migration
    `0077_machine_nodes.sql` ⇄ Drizzle `machineNodes`), the new shared machine gate
    (`verifyMachineRequest`) checks the revocation tombstone on every `/internal/*` machine surface
    plus the WS subscribe handshake, and the owner drives `GET /auth/machine-nodes` /
    `POST /auth/machine-nodes/:nodeId/revoke`. A revoked node id can never be re-minted and a
    foreign node id cannot be taken over, enforced by the roster WRITE itself (a guarded
    `ON CONFLICT ... WHERE`) so two concurrent mints of one id cannot leave a row whose owner did
    not mint it. A mothership with no roster wired refuses to mint at all, since an unrecorded token
    could never be revoked; a roster read that fails refuses the call rather than serving it, and on
    the WS handshake answers 503 (retry) rather than crashing the upgrade. Rows prune once past
    their latest signed `exp`.
  - **The password throttle is durable and spoof-resistant (SEC-4).** Attempts land in the new
    cross-replica `auth_attempts` ledger (kernel `AuthAttemptRepository`; D1 migration
    `0078_auth_attempts.sql` ⇄ Drizzle `authAttempts`) with a per-`ip:email` burst cap AND a per-IP
    aggregate that catches one-password-many-emails credential stuffing; the in-process Map remains
    only as the store-outage backstop. WHICH header carries the client address is a per-facade
    decision behind `ServerContainer.resolveClientAddress`: Node reads the socket peer, and
    `x-forwarded-for` (rightmost hop, `AUTH_TRUST_PROXY_HOPS` deep) only under the new
    `AUTH_TRUST_PROXY=true`; the Worker reads `cf-connecting-ip`, which is authentic only there.
    Addresses are normalised before keying (port stripped, non-IP refused, IPv6 bucketed to its
    /64). The 429 carries `details.reason: 'auth_attempts'` and `retryAfterSeconds`, and both a trip
    and a store outage are counted (`auth.throttle.limited`, `auth.throttle.store_unavailable`).
    Completes the durable-auth-rate-limiting initiative, now ADR 0032.
  - **Local-runner hosts are loopback-only by default (SEC-3). BEHAVIOUR BREAK:** registering or
    calling a locally-run model endpoint on a private-LAN host (RFC1918 / ULA / mDNS `.local`) now
    requires the operator opt-in `LOCAL_MODELS_ALLOW_LAN=true` on hosted deployments; single-tenant
    local mode defaults the opt-in on. The policy binds the write boundary, the test probe and every
    run-time redirect hop, so an existing LAN row on a hosted deployment is refused instead of
    silently serving an internal-network SSRF surface. Such a row is now also reported on the
    endpoint itself (`LocalModelEndpoint.urlBlockedReason`) and its models are withheld from the
    picker, so the failure surfaces in settings rather than mid-run.
  - **BEHAVIOUR BREAK (SEC-3):** a runner base URL may no longer carry a query string, a `#`
    fragment or `.`/`..` path segments, and `*.localhost` subdomains are no longer accepted (plain
    `localhost` still is). A base URL ending in `#` made the fixed `/models` and `/chat/completions`
    suffixes inert, which turned both server-side forwards into an arbitrary-path request against
    whatever listens on loopback; endpoint URLs are now composed through one validating helper
    rather than concatenated. Every refusal carries a machine-readable
    `LocalRunnerUrlReason` the SPA maps to translated copy.

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/orchestration@0.191.0
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0
  - @cat-factory/integrations@0.121.0
  - @cat-factory/agents@0.106.7
  - @cat-factory/prompt-fragments@0.15.45
  - @cat-factory/spend@0.13.10

## 0.202.0

### Minor Changes

- 1106c93: BREAKING (public API, the last permitted break): the final pre-stability polish of `/api/v1`,
  adopted together with the stability commitment (ADR 0032). From this release the public API does
  not change without an incremental migration path and a version change.

  - `POST /api/v1/initiatives` moved to `POST /api/v1/jobs`, unifying the headless job lifecycle
    under one resource root. The SDK group `initiatives` is now `jobs`; the wire schemas renamed to
    `CreatePublicJob` / `PublicJobAccepted`.
  - `publicTask.executionId` renamed to `publicTask.runId`, matching `publicRun.runId` and
    `/api/v1/runs/:runId/...`.
  - `POST /api/v1/tasks/:taskId/start` now requires a `decide`-scope key when the resolved pipeline
    can park on a human decision, the same rule `POST /api/v1/jobs` applies. Existing `write` keys
    that started such pipelines get `403 pipeline_requires_decide_scope`.

  **Check your integrations against this last one before upgrading.** A pipeline parks in three ways,
  and the third is easy to miss: an approval gate on an enabled step, an inline review/brainstorm
  kind, or an unbounded human-wait gate (`human-review`). That third case means the shipped
  **Adaptive build** preset (`pl_full`) now needs a `decide` key, because it carries a risk-gated
  `human-review` step. The unconditional presets (`Standard build`, `Simple build`) never park and
  remain startable with a plain `write` key, as do the pipelines a workspace authored without gates
  or review kinds.

  Mint a `decide`-scope key for any integration that starts parking pipelines. The scope only widens
  what a key may set in motion; it grants no destructive capability (that is `admin`).

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/orchestration@0.190.0
  - @cat-factory/agents@0.106.6
  - @cat-factory/kernel@0.221.1
  - @cat-factory/integrations@0.120.1
  - @cat-factory/prompt-fragments@0.15.44
  - @cat-factory/spend@0.13.9

## 0.201.0

### Minor Changes

- f63145d: A deployment can now declare its capability-credential chain store-ONLY, and the operator surface
  describes the chain that was actually composed instead of asserting a default beside it.

  `capabilityCredentialEnvironmentFallback: false` on any facade (`start` / `startLocal` /
  `createWorker`) composes the per-workspace sealed store with no environment resolver behind it. That
  is the multi-tenant shape: with the fallback on, a workspace that has typed nothing silently
  authenticates its runs as whoever set the deployment's variable and bills that vendor account, which
  is the single-tenant answer the store exists to replace. The default is unchanged, because whether a
  hosted deployment should ship store-only is a product call.

  The chain is now composed once, at each facade's composition root, by `buildToolSecretChain`, which
  returns the resolver together with what it consults. The credential checklist reads that rather than
  hard-coding "the environment may still answer", so a blank row means the same thing on the surface
  and in the dispatch path. Both executor builders take that composed chain as a REQUIRED dependency:
  the only default they could have carried is the deployment environment alone, which silently drops
  the per-workspace store, and a default is only safe where the safe answer is the convenient one.

  Compatibility breaks, none of which affect a deployment using the documented facade seams:

  - `environmentFallback` on the capability-credentials view is optional rather than always present,
    and absent is a real answer: a deployment that supplied its own `ToolSecretResolver` replaced the
    chain, so whether it reads the environment is not knowable here, and both guesses fail silently in
    opposite directions.
  - The Worker's process-wide `registerToolSecretResolverFactory` is replaced by
    `registerToolSecretPolicy({ createResolver?, environmentFallback? })`.
  - `resolveToolSecrets` is required on `WorkerExecutorDeps` and `NodeContainerExecutorDeps`. Only a
    deployment assembling an executor without its facade's composition root passed neither; it now
    calls `buildToolSecretChain` itself, which is also what gets it the description the credential
    checklist renders.

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/orchestration@0.189.0
  - @cat-factory/integrations@0.120.0
  - @cat-factory/kernel@0.221.0
  - @cat-factory/agents@0.106.5
  - @cat-factory/prompt-fragments@0.15.43
  - @cat-factory/spend@0.13.8

## 0.200.0

### Minor Changes

- 7f86f07: Capability credentials get their operator surface: an Infrastructure-window tab rendering the
  checklist of what this deployment's registered tool servers and generative integrations ask for,
  joined to what this board has stored.

  It is a checklist rather than a blank key-value form because which keys exist is a property of the
  deployment's CODE: each row names who wants the value, whether it is required and when it was last
  set, so nobody reads the deployment's source to learn what to type. The three things an empty row
  can mean stay apart: nothing stored but the environment may still answer, a stored key nothing asks
  for any more (removable, and withheld while the declaration read is known to be short), and a
  declaration list that could not be read at all. `secrets.manage` hides the tab rather than disabling
  it, and so does having nothing to show, since a build registering no capability has no credential to
  type.

  Also new: `PUT /workspaces/:ws/capability-credentials/:key`, the per-key write the checklist
  performs. The whole-set PUT could not serve it: a client that never received the values can neither
  re-send the set nor express "leave the others alone", so filling in a second credential through it
  would have deleted the first. The whole-set write stays for an API caller declaring a set at once.

### Patch Changes

- 7f86f07: The capability-credential row is rev-guarded, closing two holes the per-key write opened. The row
  is ONE sealed blob holding the whole set, so a per-key save is read-modify-write over it; blind,
  two operators saving DIFFERENT keys would silently destroy each other's, with the loser's save
  still returning success. `put`/`remove` now ride a `compareAndSwap`/`deleteIfRev` pair (a new
  `rev` column on `capability_credentials`, both runtimes), reloading and re-applying on the
  winner's snapshot, 409 only on a pathologically hot row. The whole-set PUT stays a blind write:
  replacing whatever is stored is its semantics, and it bumps the stored rev in SQL so a concurrent
  per-key save's guard still trips.

  Also: a per-key save now stamps `updatedAt` on the touched key ONLY. "Last set" is a per-key fact
  the checklist renders per row, and the previous write re-stamped the whole set, falsifying every
  neighbour's date whenever any one key was saved.

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/integrations@0.119.0
  - @cat-factory/kernel@0.220.0
  - @cat-factory/agents@0.106.4
  - @cat-factory/orchestration@0.188.3
  - @cat-factory/prompt-fragments@0.15.42
  - @cat-factory/spend@0.13.7

## 0.199.0

### Minor Changes

- 87161e8: Make AWS Bedrock a selectable per-model route, resolved by a preference walk instead of a hard-coded if-chain.

  `BEDROCK_MODELS` was already a per-model allow-list and nothing consumed it but a throw-on-mismatch guard, so Bedrock was reachable only by repointing the whole deployment's routing default. That left the account model policy's `trustedProviders: ['bedrock']` half-wired: its entire purpose is to let an otherwise-blocked family through on a residency-guaranteed route, and no user could select one. A catalog entry now declares a `bedrock` flavour and becomes selectable exactly when the account's allow-list carries its model, so a single task can be pinned to Bedrock.

  **The allow-list is parsed once, by `bedrockAllowListFromEnv`, and that one value feeds both consumers.** The resolver THROWS on an id outside its list while the catalog decides what the picker offers; parsed separately, a trailing space or a re-ordered var makes the picker advertise a route that fails at dispatch. `BEDROCK_REGION` with no `BEDROCK_MODELS` deliberately contributes NO flavour: the resolver runs unconstrained, but Bedrock grants are per account and per Region, so with nothing enumerated the platform would be guessing, and a guess here surfaces models AWS rejects at call time. Bedrock stays reachable as a routing default there, exactly as before. On the Worker, which does not bundle the provider package, the capability is further gated on a registered registry that can actually serve `bedrock` (`bedrockModelsCapability`): the env vars alone don't prove the `registerModelRegistry` mix-in happened, and set-but-unregistered logs a warning naming the missing call instead of offering picker rows whose dispatch fails.

  **The catalog declares the UNPREFIXED base id and the deployment's own entry is what runs.** The id an account calls carries a geo/global inference prefix (`us.` / `eu.` / `global.` / …) that differs per Region, so any prefix baked into the catalog would be wrong for every deployment but one. `resolveBedrockModelId` matches an allow-list entry that IS the base or ends in `.<base>` and uses it verbatim. Two consequences are load-bearing: the prefix set is never enumerated (a prefix AWS adds later just works), and where an operator lists two profiles for one model the FIRST wins, so ordering the env var is how they choose between a regional and a global one. That also means `bedrockModels` is a `Set` whose ITERATION ORDER matters, built from the env string once.

  **Bedrock lags the vendors' own APIs, and the catalog says so structurally rather than in a comment.** `gpt-5.5` and `gpt-oss-120b` carry a `bedrock` flavour because Bedrock serves that same generation. Opus 4.8 is a NEW `claude-opus-4-8` entry instead of a flavour on `claude-opus`, because it is a different model rather than another route to the same one: folding it in would silently run 4.8 for a block pinned to Opus 5, and nothing downstream could tell. Llama and Nova are deliberately left unenabled: their concrete Bedrock ids could not be verified against a live account, and a base id that never matches an allow-list entry is a permanently unselectable row in everyone's picker.

  `effectiveVariant` is now a walk over `DEFAULT_PROVIDER_PREFERENCE` (`direct > bedrock > openrouter > cloudflare > subscription`), with each route supplying its `declared`/`usable`/`build` arms through an exhaustive `Record<ModelFlavor, …>`, so **a route added to the wire vocabulary fails to compile until every arm is handled**. This replaces two hand-ordered if-chains that had to be kept in step by eye. The tuple is pinned to the contracts picklist by `satisfies` in one direction and by a test in the other, because a flavour contracts gained but the tuple lacked would never be TRIED and no typecheck can see that: the resolver walks the tuple, not the union.

  **A best-effort build must still produce a ref.** A Bedrock-only entry has no other route, so returning nothing when the allow-list misses would make the resolver THROW for every deployment that has not configured Bedrock, which is most of them, and the throw would take out the whole `/models` catalog. It falls back to the base id, flagged `available: false`, which is what tells the picker it cannot run.

  **A Bedrock ref's context window cannot be keyed on the ref.** `contextWindowFor` keys on `${provider}:${model}` and a Bedrock ref carries the operator's prefixed id, so the window is stored per catalog base id and found through the same suffix match resolution uses. Missed, the LLM proxy silently stops capping requested output for every Bedrock model, which surfaces as a provider-side rejection of the whole request rather than as a misconfiguration.

  `providerCachePolicy('bedrock')` stays `none`, so the picker reports no prompt caching. Bedrock does support Anthropic-style cache breakpoints, but the hint is model-specific and we do not send it; claiming caching we have not implemented would be worse than reporting none.

  **Spend gets a bare `bedrock` rate, priced high on purpose.** Making the route selectable without it would have metered every Bedrock call at `defaultPrice`, roughly a thirtieth of an Opus-tier run's real cost: an undercount in the budget safeguard introduced by this change. It cannot be per-model yet: `priceFor` matches `provider:model` exactly and a Bedrock ref carries the operator's Region prefix, so a per-model key would silently never match. Teaching `priceFor` the same prefix-tolerant match `contextWindowFor` now uses is the follow-up, and it is also what would stop a cheap Bedrock model being metered at the frontier rate.

  **Behaviour change for deployments that already set both Bedrock vars**: a model whose only other routes are the gateway or the Cloudflare floor now resolves to Bedrock, which is the point of the feature (a first-party route beats an aggregator that resells it). A configured direct key still wins.

  Slicing note: the initiative called for the subscription-first reorder FIRST, and scoping it against the code inverted that. `ModelRouter.resolveEffectiveRef` reads a truthy `ref.harness` as proof of entitlement, and `resolveBlockModel` is built at boot from capabilities that assert every vendor, so promoting `subscription` in the tuple alone would dispatch subscription runs for workspaces holding no token; separately, the ~10 inline call sites degrade through `inlineModelRef`, which sees a ref and not a model id, so a dual-mode pin would fall back to the routing default rather than the model's own base (a GLM-pinned reviewer silently running Qwen). Both need resolution to be given facts it does not have today, which is a slice of its own rather than a preliminary commit. The default order therefore keeps `subscription` last for now, with the reasoning recorded beside the tuple, in `model-support.md` §4, and in the initiative's redirect note.

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0
  - @cat-factory/spend@0.13.6
  - @cat-factory/agents@0.106.3
  - @cat-factory/integrations@0.118.1
  - @cat-factory/orchestration@0.188.2
  - @cat-factory/prompt-fragments@0.15.41

## 0.198.0

### Minor Changes

- 96ad850: Per-workspace capability credentials: the secrets a tool server or generative binary integration
  declares are now stored per TENANT, sealed at rest, instead of only being read off the deployment's
  environment.

  An environment variable is a single-tenant answer: one process serves many workspaces, so one
  variable served them all: every tenant's runs authenticated as whoever set it, no tenant could bring
  its own vendor account, and rotating one tenant's key was a redeploy that rotated everyone's. Every
  other credential in the platform is already a per-tenant sealed row; capabilities were the subsystem
  that had not caught up.

  New: `capability_credentials` (D1 + Postgres), `CapabilityCredentialsService`,
  `createWorkspaceToolSecretResolver` / `composeToolSecretResolvers`, and a `secrets.manage`-gated
  `/workspaces/:workspaceId/capability-credentials` surface that lists which credentials the
  deployment's registered capabilities DECLARE alongside which this workspace has stored. Deleting a
  board reclaims its stored credentials with the rest of its workspace-scoped rows.

  No behaviour change for an existing deployment: the environment resolver is composed BEHIND the
  store per key, so a workspace that has stored nothing resolves exactly as before. The SPA panel is
  the next slice; the API is usable now.

- 96ad850: Close the tool-secret boundary, and give `ToolSecretResolver` a facade seam.

  **Behaviour break (deliberate).** A capability credential (a tool server's `secretKeys`, a
  generative binary integration's `credential.key`) may no longer be LOOKED UP BY an environment
  variable the platform itself reads. Such a definition names both the key it wants and the endpoint
  that key is sent to, so `{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer <value>' }` was a
  registration that booted clean and injected the deployment's master sealing key into a
  prompt-injectable agent process. It is now refused at declaration (a schema issue for a generative
  integration, a `reserved_credential_key` boot error for a tool server) and again at dispatch, where
  the capability is reported to the agent as unavailable: a tool server under its own
  `reserved_secret` reason, kept apart from `missing_secret` because the two need opposite fixes.

  **New `envName`.** The floor binds the LOOKUP key alone. A declaration that needs a specific
  variable in the process it configures sets `envName` beside its `key`
  (`{ key: 'ACME_GITHUB_TOKEN', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' }`), and that name is held
  only to the narrower toolchain rule, since it reads nothing. Without the split the reserved
  families would make the commonest MCP servers unusable with no workaround open to a deployment,
  because `GITHUB_`, `SLACK_` and `AWS_` cover names the platform does not read and a vendor's own
  SDK does. A deployment that named a platform variable as its lookup key now fails at boot rather
  than silently; a deployment that needs the vendor's name in the process keeps it via `envName`.

  **New seam.** `startLocal`, `start` and `createWorker` each take a `createToolSecretResolver`
  factory, defaulting to the platform's own chain (the per-workspace credential store in front of
  `createEnvToolSecretResolver(env)`). Reaching the port used to mean abandoning the facade and
  reassembling the boot sequence, so the per-workspace credential store the port was designed for,
  and the `allowKeys` bound its own documentation recommended, were both unreachable. On the Worker
  the option registers the resolver process-wide (`registerToolSecretResolverFactory`), because a
  Worker builds a container per entry point and container agents are dispatched by the durable
  driver, which sees no option held on the app.

  Also: the Node executor's default env resolver now reads the injected `env` rather than
  `process.env` directly, so an embedded boot or a test that supplies one is no longer bypassed.

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0
  - @cat-factory/integrations@0.118.0
  - @cat-factory/agents@0.106.2
  - @cat-factory/orchestration@0.188.1
  - @cat-factory/prompt-fragments@0.15.40
  - @cat-factory/spend@0.13.5

## 0.197.0

### Minor Changes

- 4c26c01: Split the `3d` binary modality into `3d-model` and `3d-scene`, and let a binary-output step require exact FORMATS, not only content types — checked at admission, in the brief, and against what the run delivered.

  **Breaking, deliberately: `BinaryModality` no longer has a `3d` member.** A deployment registering a 3D integration re-declares it as `3d-model`, `3d-scene`, or both; the boot validator names an unusable one, so the break is loud rather than silent. A step whose `binaryOutput.modalities` said `3d` is refused at save until re-picked — which is the honest outcome, since the whole point is that the old value did not say which of the two the step needed.

  A retired member is RENDERED as one, on both surfaces that put a modality into words. `3d` is persisted state, so it outlives the union it came from and reaches exactly the modality-uncovered refusal whose job is to name what a human must re-pick — where an exhaustive lookup with no runtime arm gave `undefined` in the backend's prose and a `TypeError` in the pipeline builder, taking down the very surface the fix is made on. Both now name the value as retired and say to re-pick, and both keep their compile-time exhaustiveness: kernel's `describeModality` routes its `default` through a `never`-typed helper, so adding a member without a case still fails the build.

  A deliverable is described on three axes, and a fact belongs to the axis that can carry it: the KIND (`modalities` — decides which generator may serve the step), the FORMAT (`mediaTypes` — providers differ, importers are exact), and everything else (the prompt). `image` earns no split on either of the first two: a step that must have a PNG says so in `mediaTypes`, and a sprite differs from a backdrop by prompt alone. An asset and a scene are the one case where neither lower axis can help — they are the same modality by the old vocabulary AND the same format, because GLB, FBX, USDZ and `.blend` each carry either one object or a whole scene graph. With no media type meaning "a scene", a step that must deliver a level could be admitted against a prop generator with nothing able to notice. Splitting the modality is the only axis left, which is exactly the bar a new member has to clear.

  Consequently the classifier answers a LIST. `modalitiesOfMediaType` returns both 3D members for every 3D container, since that is the true statement about a `.glb`, and each consumer says what it does with an ambiguous answer: boot validation passes when the sets INTERSECT (requiring every member would refuse a scene generator for declaring the only format it can emit), while a settled artifact classifies only when the answer is unambiguous (`modalityOfMediaType`, retained for that) — a guess about a file that already exists is worse than an absence, and the step's own declaration is the only thing that ever knew which was being made.

  `stepOptions.binaryOutput.modalities` is the right grain for `image` — PNG versus WebP is a genre question and belongs in a prompt — and the wrong one for 3D, where the container IS the compatibility contract. GLB, USDZ and FBX are all one modality and none substitutes for another: a Godot importer takes the first, a RealityKit pipeline the second, an art pipeline the third. A step whose mesh must load in the game could therefore be admitted against an integration that cannot emit a loadable container, with the failure arriving at the end of a paid run as an asset nobody can open — which reads as a bad generation rather than as a selection nothing checked. `binaryOutput.mediaTypes` closes that at the level where the wrong answer is a file the consumer silently cannot use.

  Every declared entry is REQUIRED, not any-of. A step delivering a GLB for the engine and an FBX an artist can open in Blender declares both and both are checked. An "any of these will do" reading was rejected because the agent is what names the container on the vendor call, and a requirement that leaves it a choice hands that decision to the party with the least basis for making it.

  A format is never translated into a modality, in either direction. `modalityOfMediaType` recognises only the formats the platform happens to know, so inference would make the strength of a requirement depend on our vocabulary — a step spelled with a brand-new container would silently lose the coarse check its neighbour keeps. Matching is exact after ONE shared reduction: both declarations come through `mediaTypeSchema`, and a settled artifact's `contentType` (the model's own prose) goes through the newly exported `normalizeMediaType`, never a second lowercasing. No synonyms are mapped, deliberately — a matcher that accepted a near-neighbour would admit a GLB where an OBJ was required.

  The coverage rule has THREE outcomes rather than two, and the third is what keeps this honest. A generator declaring no `mediaTypes` has said "only my modality is known" — a documented state, not an empty answer — so a requirement it cannot be judged against is UNVERIFIABLE (`binaryFormatCoverage`): the run is ADMITTED and the gap is stated instead, to the agent in its brief and to whoever composes the step in the picker. Refusing there would punish the honest declaration and break every integration that has not pinned its formats down; calling it covered would be the mirror mistake, a clean bill of health nobody issued on the surface that decides whether a run may start. It is the admission-side twin of `generatorsUnverified`. With nothing selected there is nobody to be silent, so a format requirement is uncovered outright and refuses under a new `media_type_uncovered` issue.

  The brief states the required formats as exact strings to request and refuses substitution in words, because the agent is the party that chooses `target_formats`; the report surface adds the one judgement admission could not make, comparing what was required against the content types the run actually declared (`undeliveredMediaTypes`), derived in code and only where there are artifacts to compare against. The picker takes the requirement as free text with the selection's declared formats offered as a hint — a control offering only what the selection declares could never express the requirement whose violation this exists to catch.

  Also: `application/x-blender` now classifies as 3D, alongside the OBJ and STL legacy types, since a `.blend` file is what a 3D deliverable looks like when the consumer is an artist rather than an engine. And `HttpBinaryGeneratorSource` now holds a served view to carrying `mediaTypes`, because it is a field admission DECIDES on: an absent one would reach the coverage rule as a crash instead of the one `UnavailableError` every route to "we do not know what is registered" ends at.

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0
  - @cat-factory/orchestration@0.188.0
  - @cat-factory/agents@0.106.1
  - @cat-factory/integrations@0.117.2
  - @cat-factory/prompt-fragments@0.15.39
  - @cat-factory/spend@0.13.4

## 0.196.0

### Minor Changes

- 924c6f9: Let a mothership-mode node read the deployment's generative binary integrations from the mothership instead of from its own build.

  `BinaryGeneratorRegistry` shipped registry-only, which meant a mothership deployment — two processes — had to register its integrations on both entry points, with the copies matching only while both ran the same build. A local node one build behind is the normal state of running one, and the resulting failure was both loud and misattributed: the pipeline builder's picker is fed from the workspace snapshot the mothership serves, so a human selects an integration from the product's own picker and every run of that step is then refused by the node with `unknown_generator` — naming a step configuration that is correct, with the half-wired deployment invisible in the message.

  The new kernel `BinaryGeneratorSource` port (`views()` + batched `documentsFor(ids)`) mirrors `FoundationalBuiltinSource` file for file: `GET /internal/binary-generators` (+ `POST .../contracts`) is machine-token gated, mounted on both facades, and reads this process's OWN registry; `HttpBinaryGeneratorSource` throws on every unreadable outcome — a transport error, a refusal, the 404 of a mothership older than the node — rather than answering with an empty set. A mothership-mode node injects it and no longer consults its own registry for a run, warning at boot naming any ids it will ignore; the registry is still boot-validated and is what the route serves when the process is itself a mothership.

  The disposition differs from the estate's in the one place that matters. Those integrations gate ADMISSION, not just prompt enrichment, so an unreachable source is re-thrown as a 503-shaped, retryable `binary_generators_unreachable` and never softened to an empty set — which would refuse correctly configured steps as `unknown_generator` for the duration of an outage. That refusal carries translated copy of its own: user-reachable 503 reasons now live in a `UNAVAILABLE_REASONS` union with an exhaustive `Record` in the SPA, because the status class's generic wording ("this deployment has not configured the capability") is the same misattribution one layer up.

  The best-effort readers keep their own dispositions. The dispatch brief injects nothing, which the trait guidance already defines as "do not attempt any upload; report it". The settled-step read-back records the artifacts and the storage-side verdict — both resolve against the workspace catalog, which an unreachable mothership says nothing about — and marks only the generative judgement withheld, via a new `BinaryOutputReport.generatorsUnverified` rendered as its own warning line. An empty `unknownGenerators` means "every claimed id checked out", so the two may not be spelled alike.

  Within one dispatch the two halves of a selection share ONE `views()` read (`memoizeBinaryGeneratorViews`), scoped to that read wave and discarded with it — one round trip instead of two, with no staleness window to reason about. The workspace snapshot's projection joins the board-load read wave rather than following it, for the same reason.

  The workspace snapshot's picker projection reads the same source, because routing only the engine would have moved the drift to the surface that OFFERS the id rather than removing it. It carries a new `binaryGeneratorsUnavailable` flag for the state a list cannot express: an empty picker is a claim about the deployment's build, and acting on it during an outage sends someone to the wrong repository. The SPA renders that as its own message and disables the selector rather than reporting the selection as invalid.

  Version floor: a node on this release needs a mothership new enough to serve the route. An older one answers 404, which surfaces as an outage rather than as a deployment that registers nothing.

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0
  - @cat-factory/agents@0.106.0
  - @cat-factory/orchestration@0.187.0
  - @cat-factory/integrations@0.117.1
  - @cat-factory/prompt-fragments@0.15.38
  - @cat-factory/spend@0.13.3

## 0.195.0

### Minor Changes

- 233e279: Register generative binary integrations (image / music / video generation APIs) in a deployment's own code, and let binary-generating agent steps select them.

  `BinaryGeneratorRegistry` is a new app-owned registry beside the foundational-service one: an integration declares the content types it produces (`image | audio | video | 3d | document`), its media types, endpoint, API contracts and the credential it needs BY NAME. A step picks from it via `stepOptions.binaryOutput.generatorIds` and states the content types it must deliver via `.modalities`; run admission refuses an unregistered id or an uncovered content type under the new `binary_output_generator_invalid` conflict reason. The agent's `.cat-context/binary-output/brief.md` now leads with a Generation section describing each integration, and the credential value reaches only that job's agent process (job body `generatorSecrets`), never a prompt or the telemetry snapshot.

  All three facades take the registry as their own DI option (`binaryGeneratorRegistry`), so a deployment registers integrations on Node and local exactly as on the Worker, and each facade boot-validates the instance it was handed. A new `registry-seams` guard derives the app-owned registry set from `CoreDependencies` and holds each one to a declared route, so the next registry cannot land threaded on one runtime and inert on another.

  The SPA follows the shapes through: the binary-output step picker offers the generative selection (from the workspace snapshot's new `binaryGenerators`, identity only — never a credential key name) and mirrors both new refusals inline, and the report names the integration that produced each artifact plus any the deployment does not register.

  Breaking, pre-1.0: `PipelineStep.binaryOutputs` gains a required `unknownGenerators` array, so reports recorded before this change no longer parse — an affected step's declaration record is re-created on its next run. `ToolSecretResolver.resolve` takes a discriminated `subject` (`tool-server` | `binary-generator`) in place of `serverId`; a deployment implementing that port per workspace must update its signature, and one passing `allowKeys` to the env-backed default must extend the list to cover its integrations' credential keys or they resolve to nothing.

- 54d531d: Count the deployment's operational EVENTS, and let the health alerts see a dead one.

  The platform-observability projection answers "how are the runs doing" by aggregating
  `agent_runs`. It structurally cannot answer what an operator asks during an incident — how often
  container dispatch is failing, whether the sweeper is re-driving more than it was, whether a queue
  is draining — because none of those are rows in a table. A new kernel `OperationalMetrics` port
  counts them, and the OTLP platform exporter ships them as delta sums beside the existing gauges.
  Wired at the sweepers, the container seam, the trace sinks, the notification webhook and every
  app-cache read; `agent_runs` gained a persisted `redrive_count`, so "was this run re-driven three
  times?" is answerable after the process (or the isolate) that did it is gone.

  `platform_health` gained three conditions. The important one is zero-throughput: every existing
  condition divides by runs and goes silent at zero, so a deployment that stopped accepting work
  read identically to a quiet healthy one. Alongside it, a dominant-failure-kind condition (100%
  `evicted` and 100% `agent` produce the same failure rate and need opposite fixes) and one that
  alerts on the sweepers themselves, since a wedged sweeper makes every other signal stale without
  making any of them fire. A sweep pass reports its rate and its failure streak through ONE call
  (`SweepHealthTracker.recordFailure`), and the Worker drives its crons through a `SweepTick` that
  is the facade-symmetric twin of Node's `startSweeper` — so both runtimes cover the same set of
  sweepers, and the tick's counters are flushed after its passes have settled rather than before.

  Also: retention pruning is now isolated per table (one sick table used to abort the whole pass,
  indefinitely, and report zeroes indistinguishable from an empty table); `/ready` round-trips
  pg-boss's own connection instead of trusting a process-local boolean, and the Worker gained a
  bindings-probing `/ready`; and every pg-boss queue is created with a dead-letter sibling whose
  depth rides the `queue.depth` gauge under `state: dead_letter`, with an hourly sweep logging the
  source queue to go and look at.

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0
  - @cat-factory/agents@0.105.0
  - @cat-factory/orchestration@0.186.0
  - @cat-factory/integrations@0.117.0
  - @cat-factory/prompt-fragments@0.15.37
  - @cat-factory/spend@0.13.2

## 0.194.0

### Minor Changes

- 87ed4f9: Give binary-output steps their two SPA surfaces: a place their stored artifacts are read, and a
  place their storage service is picked.

  `PipelineStep.binaryOutputs` has been recorded since the feature landed and nothing rendered it,
  so a deployment running a generator kind could see that a step succeeded and had no way to find
  what it delivered. The read surface is a shared section resolved from the active step in
  `ResultWindowShell` (plus the generic step-detail panel, which the shell is not involved in),
  beside the effort and pre-PR-validation sections — deliberately NOT a `presentation.resultView`
  a generator declares. The record's scope is a union the declared-view seam structurally cannot
  follow: the engine writes it when the step's KIND carries the trait **or** the STEP carries a
  selection, so a trait-carrying kind dispatched under an overriding kind records artifacts against
  a step whose own kind declares some other window. Resolving off the step instead makes the
  surface follow the record, costs a deployment no registration, and leaves a generator free to
  declare a result view for its own output rather than choosing between its output and its
  artifacts.

  The parse keeps six outcomes apart on purpose — not started, still running, no declaration, an
  unreadable one, an explicit "stored nothing", and actual artifacts — and five of them are not an
  empty list, so the surface renders the discriminant rather than a list that happens to be empty;
  state copy comes from one exhaustive `Record`, so a seventh outcome fails the typecheck instead of
  rendering a missing key. Every counted loss keeps its own line and its own number (an unknown
  service id is not a malformed entry is not a truncated tail), and the one join the report cannot
  make itself — did the artifact go through the service the step actually pointed at? — is derived
  from the step's own recorded selection, so it needs no catalog read and reads the same on a run
  whose services were withdrawn since. "Never briefed" is the section's ABSENCE, and so is a
  gated-out step's; a step not started YET resolves the other way, since where its artifacts will
  land is worth stating before it runs.

  The two unknown-service facts are DISJOINT FIELDS rather than one list plus a flag: the report's
  own `unknownServices` mixes the step's lost target with ids the agent invented, so a surface
  reading it raw labels every unknown id as the step's own storage service and drops the invented
  ones. `targetUnknown` owns the first and `unknownDeclaredServices` owns the second, so naming
  either cannot mis-state the other — the exclusion lives in the read model, where it is tested,
  not in a renderer's filter.

  For the picker, the SPA had no way to know which kinds are generators: `BINARY_OUTPUT_TRAIT`
  never left the backend. It is now projected onto the snapshot's custom-kind entry as a boolean
  beside `container` — the precedent that the snapshot carries the facts the SPA branches on, not
  the backend's trait vocabulary — and asked of the REGISTRY rather than read off the declaration,
  so a trait ASSIGNED to an existing kind projects like a declared one. The picker offers the
  RESOLVED catalog (`asset-storage`-tagged for the storage half; the whole catalog with
  `generation-context` first for the context half, since that tag is conventional and admission
  enforces only existence), because admission re-validates against that same catalog at every
  start — an id offered from a stale client copy would save clean and fail a refusal cycle later.
  It mirrors the admission refusals inline, in translated copy keyed off the same issue vocabulary,
  and stays in BOTH interface tiers: this is a required input, not an override, and hiding it in
  basic mode would leave a step that cannot be saved with no way to find out why.

  Reviewers: the load-bearing decision is the surface's PLACEMENT (shell section, not a declared
  result view) — §1.2 of the downstream proposal argued the other way and accepted "a step whose
  kind declares a different view has nowhere showing its artifacts" as a consequence; that is the
  exact case the union recording rule creates, so it is not one to accept.

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/agents@0.104.3
  - @cat-factory/integrations@0.116.4
  - @cat-factory/kernel@0.214.1
  - @cat-factory/orchestration@0.185.2
  - @cat-factory/prompt-fragments@0.15.36
  - @cat-factory/spend@0.13.1

## 0.193.1

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0
  - @cat-factory/spend@0.13.0
  - @cat-factory/agents@0.104.2
  - @cat-factory/integrations@0.116.3
  - @cat-factory/orchestration@0.185.1

## 0.193.0

### Minor Changes

- 70b4339: Serve a mothership-mode node's run telemetry back down from the mothership when its own store holds
  none. Telemetry is local-first, captured on the laptop and pruned there on a short window, with a
  finished run's rows carried up by the ingest sweep — both halves of which are about the WRITE
  direction. What that left was a node rendering two kinds of run blank: one whose local rows had been
  pruned, and (the larger case the plan under-stated) one that was never local at all. A mothership-mode
  SPA shows the whole org's board, so most runs a developer opens were driven by a hosted teammate or
  another laptop, and every one of them showed an empty observability panel, a zero token rollup and no
  web-search log — with nothing anywhere reporting a problem, because that is exactly what a run which
  spent nothing looks like.

  `POST /internal/telemetry/read` is the ingest's dual: a machine-authed, account-scoped endpoint
  serving a CLOSED table of per-method-bounded, run-scoped reads. It is its own endpoint rather than
  allow-listed persistence-RPC methods for ADR 0009's reason plus a sharper one — the persistence
  registry resolves a repository WHOLE, so admitting a telemetry repo's reads there would route its
  hot-path writes over the network, which is the entire thing the local-first bucket exists to prevent.
  `listByExecution` is deliberately absent from the table on all three sinks (no cursor, so it is the
  un-resumable bulk read the bucket forbids); the node drains the paged reads instead, which is what
  the two new kernel port methods are for. An over-cap limit is refused, never clamped, and the
  scope-bound workspace is stamped as the call's first argument rather than trusted from the caller.

  On the laptop the rule is local-wins where local is WHOLE — not merely where it is non-empty. The
  distinction is a third blank-run case: the prune deletes by capture time, so a run straddling the
  cutoff keeps its newer rows and loses its older ones, and the store then answers, with nothing
  looking missing, with a strict subset. A short list is bad and the rollup is worse, because a token
  total that is simply too low carries no hint that it is short. A subset is undetectable after the
  fact, so the prune records it as it happens and that record is what makes a local answer
  authoritative: lists stitch across the two stores on the shared keyset, while counts and the rollup
  come wholly from the mothership, since a partial local aggregate and a complete remote one cannot be
  merged. Capture is not decorated at all. A failed fallback throws rather than degrading back into the
  empty answer it was called to replace — the one hot-path caller already treats a metrics read as
  best-effort, so an outage costs a board counter and never a run, and the aggregate reads carry a
  short round-trip budget precisely because that caller awaits them on the emit path.

  A page inside its row cap can still serialize past the response backstop, so that is treated as
  routine rather than as a fault: the mothership still refuses rather than shortening (a truncated page
  is one the node would treat as complete), but under its own code, and the drain re-asks smaller on
  the same cursor, losing nothing. It terminates because the backstop is derived from the two capture
  ceilings rather than picked — a one-row page can never be refused for size.

  Compatibility break: `LlmCallMetricRepository` and `AgentContextSnapshotRepository` each gain a
  required `listRunPage` method, so an out-of-tree implementation of either port must add it. The local
  telemetry store gains a `telemetry_pruned_runs` table, created on open; an existing store simply
  starts recording from its next prune, and until then reports itself complete, which is the same
  answer it gave before.

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0
  - @cat-factory/orchestration@0.185.0
  - @cat-factory/agents@0.104.1
  - @cat-factory/integrations@0.116.2
  - @cat-factory/spend@0.12.144

## 0.192.0

### Minor Changes

- f31c644: Serve the foundational-service catalog's `builtin` tier over the mothership machine API. A
  mothership deployment is two processes, so a code-registered estate had to be registered on both
  entry points and the copies matched only while both ran the same build — with a local node one
  build behind being the normal case, and the skew silent (a run's catalog simply omits a service,
  which reads like an Architect judging it irrelevant).

  The tier is now read through the kernel `FoundationalBuiltinSource` port: the in-process registry by
  default, `GET /internal/foundational-services` (+ the batched
  `POST /internal/foundational-services/contracts`) on a mothership-mode node, which no longer consults
  its own registry and warns at boot naming any ids it ignores. The remote read throws rather than
  answering with an empty tier — on the 404 from a mothership older than the node, and on a 200 whose
  payload it cannot read — and the injected context files STATE that outage rather than being omitted
  (`FoundationalCatalogRead` / `FoundationalIndexRead` gain an `unavailable` variant), so a best-effort
  dispatch cannot turn the throw back into "no shared services are registered".

  Compatibility break (pre-1.0, no shim): `FoundationalServiceCatalogService` takes `builtins`
  (a `FoundationalBuiltinSource`) in place of `registry`; wrap a registry with
  `registryBuiltinSource(registry)`. `CoreDependencies.foundationalServiceRegistry` and the facade
  options are unchanged.

### Patch Changes

- 4ac6960: Bump both runner images and take the dependency majors that are actually safe.

  **Runner images** (`@cat-factory/executor-harness` 1.85.0, `@cat-factory/deploy-harness` 0.2.9, with the three pinned tags synced):

  - Executor: Pi `0.82.1 → 0.83.0`, Codex `0.145.0 → 0.146.0`, and the two lockstep Pi extensions `rpiv-todo`/`rpiv-web-tools` `2.1.0 → 2.3.1`. Claude Code stays at `2.1.220` — already the latest.
  - Deploy: `kubectl v1.36.2 → v1.36.3`, `helm v4.2.2 → v4.2.3` (`kustomize v5.8.1` is already the latest). `backend/docs/local-kubernetes-setup-windows.md` mirrors these pins and moves with them.
  - Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest, plus the in-range `@types/node`/`hono` refresh the harnesses sat out of the previous sweep. With the executor harness now bumped, `hono` moves to `^4.12.33` across the whole workspace rather than being held back by the single-version constraint.

  **Dependency majors** — taken: `markdown-it@14 → 15` (it now ships its own types, so `@types/markdown-it` is dropped; the instance type is a separate export from the constructor, which is the one call site that changed), `ioredis@5 → 6` (the optional multi-node Redis propagator + cache-invalidation bus), and `layered-loader@14 → 16`.

  The layered-loader bump also **retires the deep-import workaround**. Keeping `ioredis` out of the Worker's module graph used to require importing `layered-loader/dist/lib/*.js` directly, because the package root eagerly re-exported its Redis surface; 15 then added an `exports` map that closed that hatch without offering a replacement. 16 states the boundary itself, so `@cat-factory/caching` imports the Redis-free `layered-loader/core` and only the Node facade's `REDIS_URL`-gated dynamic import reaches `layered-loader/redis`. **Never import the package root from `@cat-factory/caching` — it still carries both halves.** 16 also demotes `ioredis` to an optional peer (`^6`, pairing with the bump above) resolved lazily and only when a caller passes connection options instead of a client, which we never do.

  Not taken: `typescript@6 → 7` for the frontend, because `vue-tsc` still loads `typescript/lib/tsc`, which the TS 7 Go port no longer exports — the frontend stays on 6 until vue-tsc supports it.

- 4ac6960: Refresh the dependency tree — direct and transitive — to the latest versions that satisfy the `minimumReleaseAge` supply-chain gate, staying within each dependency's compatible major.

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.37 → ^7.0.47`, `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.2x → ^4.0.27`, `@ai-sdk/openai-compatible@^3.0.14 → ^3.0.20`, `@ai-sdk/provider@^4.0.3 → ^4.0.4`, `@ai-sdk/amazon-bedrock@^5.0.32 → ^5.0.40`.
  - **Runtime deps**: `pg-boss@^12.26.3 → ^12.26.4`, `@aws-sdk/client-s3@^3.1095.0 → ^3.1101.0`, `@nuxtjs/i18n@^10.5.0 → ^10.6.0`, `@vueuse/core@^14.3.0 → ^14.4.0`.
  - **Tooling**: `wrangler@^4.114.0 → ^4.118.0`, `@cloudflare/workers-types@^5.20260726.1 → ^5.20260801.1`, `oxlint@^1.75.0 → ^1.76.0`, `oxfmt@^0.60.0 → ^0.61.0`, `knip@^6.29.0 → ^6.31.0`, `turbo@^2.10.7 → ^2.10.8`, `vue-tsc@^3.3.8 → ^3.3.9`, `@playwright/test@^1.62.0 → ^1.62.1`, `@types/node@^26.1.1 → ^26.1.2`, `@types/pg@^8.20.0 → ^8.20.3`.

  No `minimumReleaseAgeExclude` entries were added: every bump above already satisfies the gate. The `@cat-factory/executor-harness` and `@cat-factory/deploy-harness` deps are deliberately untouched, since they feed the published runner images and bumping them is a separate image-bumping change. `hono`'s declared range therefore stays at `^4.12.32` (sherif requires one version workspace-wide, and the harness declares it) while the lockfile still resolves 4.12.33 within that range.

- 874d684: Remove the two expired persistence repairs and collapse the four run-failure parsers onto one.

  The pre-#94 numeric user-id repair and the removed-failure-kind repair both carried a 2026-07-15
  removal date that has passed, so `createdBy` and `initiatedBy` now read straight through and a
  persisted failure is validated once, against the full wire schema.

  Dropping `isKnownAgentFailureKind` left the bootstrap and env-config-repair repositories — two per
  runtime — hand-rolling a weaker `typeof o.kind === 'string'` check than the execution mapper's, so
  they now share one `parseStoredAgentFailure`, exported from `@cat-factory/contracts` beside the
  schema it validates against (the runtimes' repositories no longer reach into
  `@cat-factory/server` for it, and kernel deliberately carries no valibot dependency). A
  structurally-incomplete failure record that those four stores previously surfaced (and that would
  fail the SPA's snapshot re-validation) is dropped consistently on both runtimes.

  Rows still holding a pre-#94 numeric id now surface it as-is instead of being repaired to null. A
  deployment that still carries such rows sees the whole board fail to load with "Can't reach the
  backend" — the SPA rejects the workspace snapshot — which points nowhere near the cause, so the
  remedy is worth stating: null the stale ids once
  (`UPDATE blocks SET created_by = NULL WHERE created_by ~ '^[0-9]+$'`, and the same for
  `initiatedBy` inside the `agent_runs.detail` JSON). They identify no `usr_*` user, so nothing real
  is lost.

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/agents@0.104.0
  - @cat-factory/orchestration@0.184.0
  - @cat-factory/integrations@0.116.1
  - @cat-factory/contracts@0.210.1
  - @cat-factory/spend@0.12.143
  - @cat-factory/prompt-fragments@0.15.35

## 0.191.2

### Patch Changes

- 769a3d9: Close the PR-deep-review parity gap on GitLab: `FetchGitLabClient` now implements
  `listChangedFiles`, `getPullRequestHeadRef`, `getPullRequestHeadSha` and `createReview`. All four
  are optional on the `VcsClient` port and every consumer degrades silently without them, so a
  GitLab deployment previously ran the review flow to completion while the merge track record
  classified every run `unknown` (never matching a per-class merge rule) and the selected findings
  never reached the merge request. Cross-provider conformance now asserts their presence.

  Two breaking shapes ride along, both because a provider that cannot answer must say so rather than
  answer zero:

  - **`GitHubChangedFile.additions` / `deletions` are now `number | null`.** Null means the host did
    not report a count — GitLab withholds the hunk the counts are derived from for an oversized diff,
    and these render straight into the reviewer's prompt, where `+0/-0` describes a file nobody
    touched. GitHub still reports a real `0` for a binary it cannot line-count, and the conformance
    suite pins both. A consumer folding null to `0` must now do so deliberately. GitHub's own mapper
    moves to `githubProjection.toChangedFileProjection` (`@cat-factory/integrations`) so the decision
    sits beside its GitLab counterpart rather than inline in the fetch client.
  - **`logger` is REQUIRED on the GitLab facade builders** (`buildGitLabEngineClient`,
    `buildGitLabConnectClient`, `registerGitLab`) and is kernel's `Logger` rather than a bespoke
    `{ warn }`. It was optional, and consequently no composition root passed one — leaving the page-cap
    truncation warning unreachable in production, on the very reads a review is sliced from. The local
    facade now builds its client through the shared `buildGitLabEngineClient` instead of assembling the
    same pair by hand, so it cannot miss the next thing that builder gains.

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0
  - @cat-factory/agents@0.103.0
  - @cat-factory/integrations@0.116.0
  - @cat-factory/orchestration@0.183.1
  - @cat-factory/spend@0.12.142

## 0.191.1

### Patch Changes

- be7135c: Stop the public API's `pipeline_requires_decide_scope` refusal advertising parks it cannot answer.
  The message named all four parking kinds plus the approval gate and promised a `decide`-scope key
  could answer them through `/api/v1/runs/:runId/decisions`, which is true only of a requirements
  review — so an operator following the advice minted a wider-scoped key and got a run whose only exit
  is `POST /api/v1/jobs/:id/cancel`. It is now built from the pipeline's actual park surfaces, naming
  the unanswerable ones and their real recovery. What is admitted is unchanged.

## 0.191.0

### Minor Changes

- 73708cf: Close three of the gaps `backend/docs/security-model.md` lists against the agent write path.

  **`allowInitiatorPat` turns "govern your members' PATs" from advice into an enforced control, at
  two tiers.** A run's initiator's stored personal token outranks the deployment credential, and its
  scope is whatever that person granted it — so the blast radius of a compromised run was a property
  of whoever pressed start. Off, every run authenticates as the App installation and the initiator's
  token is never decrypted. All three mint sites (both facades' container dispatch and the engine's
  GitHub client) now route through one `createResolveRunInitiatorToken` decision, and an unreadable
  settings row fails closed to the App token.

  The per-workspace switch is edited with `settings.manage`, which a member elevated on one board
  holds — so it alone could not bind the case it exists for. An **account-wide floor** sits under it:
  effective = account permits AND workspace permits, with the account tier out of a board admin's
  reach. It ships UNSET, and that default is load-bearing rather than merely cautious — a personal
  token is the right credential for someone adopting cat-factory alone inside an org that has not,
  where there is no App installation to inherit and no account admin to ask. PAT support is
  unchanged for them.

  **A stored GitHub PAT's breadth is stated when it is tested or saved.** A classic token carrying
  `repo` is called out as reaching every repository its owner can push to; unused scopes are flagged;
  a token whose scopes GitHub does not report is reported as unknown rather than passing as narrow.

  **A branch-protection preflight says where the operator checklist's first item is missing.** On
  demand, the GitHub settings panel probes each linked repository's default branch and reports three
  states — a repo it could not reach is `unknown`, not "fine" — plus whether a protected branch's rule
  was actually readable, and how many repositories a probe cap left unchecked. It answers to
  `integrations.manage` and probes with bounded concurrency: unlike its sibling reads it spends the
  installation's GitHub rate limit, which the CI gate and the merger draw on for every run.

  It reads **rulesets as well as classic branch protection**. Rulesets are how protection is enforced
  org-wide and leave no classic rule behind, so a legacy-only probe reported the best-configured
  repositories as exposed — a false alarm on a panel whose only job is naming exposed ones. The rules
  endpoint also needs no admin, so a minimally-scoped App installation now gets real detail where it
  previously got `detailUnavailable`.

  The operator checklist now names **GitHub's own org-level PAT controls first**, since they bind
  every tool a member uses and cannot be undone by them — with the caveat that they are the wrong
  instrument for individual adoption, which is what ours are for. The residual-gaps list records
  GitHub App **user-to-server tokens** as the structural fix for an unbounded initiator token
  (`auth/GitHubOAuth.ts` already implements that flow for login), so the next iteration does not
  re-derive "a PAT cannot be narrowed" as permanent.

  BREAKING for anything constructing these directly: `RunInitiatorScope` now takes a
  `{ workspaceId, initiatedBy }` scope rather than a bare user id, `MintInstallationToken`'s run
  context carries `workspaceId`, and `PatPreferringAppRegistry` takes the composed token decision
  instead of a raw `ResolveUserGitHubToken`. `currentInitiator()` is removed in favour of
  `currentCredentialScope()`.

- 876ee2d: Foundational services gain a deployment tier, honest operation indexing, and set-level contract
  validation.

  A deployment can now register its shared-capability estate in CODE, on the app-owned
  `FoundationalServiceRegistry` injected like `PipelineRegistry` / `TaskTypeRegistry`. Registrations
  resolve as the catalog's lowest-precedence `builtin` tier — no rows, so they are present from a
  workspace's first request and cannot drift from the definitions — and are validated at boot against
  the same schema and document checks the REST write boundary applies. An account or workspace row of
  the same id still wins, and either tier can suppress an inherited service: the suppression
  sub-resource is now mounted at BOTH scopes, since an account inherits the deployment tier exactly as
  a board inherits its account's.

  A contract set is validated as a SET rather than per document: a set declared as a TypeScript
  contract format must contain at least one document referencing that library, so the schema modules a
  contract imports can be registered as what they are. A `files`-mode repo source does the same for
  the modules its link explicitly names; folder and directory scans are unchanged.

  Contract MODULE operations are indexed. A `@toad-contracts/core` module is read statically
  (`method` + a literal/template `pathResolver`), and what the extractor could not read is reported
  through `omittedOperations` rather than passing as a complete list. Where a format is not read at
  all, that is now stated instead of rendering as "declares no operations".

  Kernel gains `isContractModulePath`, so a caller asking whether a file could be part of a contract
  module GRAPH reads the same extension list `detectContractFormat` branches on instead of declaring
  its own.

  The enforced capability tags (`asset-storage`, `generation-context`) moved to
  `@cat-factory/contracts` so registrants and the SPA import the same vocabulary, and the write
  boundary refuses a tag that misses one by case or separators.

  Breaking, and deliberate: the merged catalog read (`GET /workspaces/:ws/foundational-services/resolved`)
  no longer carries `ownerKind`, `sourceId`, `sourcePath`, `pinnedCommit`, `createdAt` or `updatedAt` —
  a `builtin` entry has none of them, and filling them with placeholders would read as fact. Those
  fields remain on the per-tier management read. Existing stored `toad-contract` rows keep their empty
  operation index until their next upload or repo sync re-indexes them.

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0
  - @cat-factory/integrations@0.115.0
  - @cat-factory/orchestration@0.183.0
  - @cat-factory/agents@0.102.0
  - @cat-factory/prompt-fragments@0.15.34
  - @cat-factory/spend@0.12.141

## 0.190.3

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0
  - @cat-factory/agents@0.101.0
  - @cat-factory/integrations@0.114.4
  - @cat-factory/orchestration@0.182.2
  - @cat-factory/prompt-fragments@0.15.33
  - @cat-factory/spend@0.12.140

## 0.190.2

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0
  - @cat-factory/agents@0.100.0
  - @cat-factory/integrations@0.114.3
  - @cat-factory/orchestration@0.182.1
  - @cat-factory/prompt-fragments@0.15.32
  - @cat-factory/spend@0.12.139

## 0.190.1

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0
  - @cat-factory/agents@0.99.0
  - @cat-factory/orchestration@0.182.0
  - @cat-factory/integrations@0.114.2
  - @cat-factory/prompt-fragments@0.15.31
  - @cat-factory/spend@0.12.138

## 0.190.0

### Minor Changes

- 8fbc0b5: Serve the repo-sourced Claude Skills library (ADR 0024) over the mothership-mode persistence RPC —
  catalog reads and the repo-sync surface alike — so a local node with no main database can list,
  sync and RUN a skill.

  This was not a blank panel. `skillResolver` is a hard dependency for a `skill` step (and for the
  declared `{ catalogSkillId }` capabilities of ADR 0029), so an un-routed skill catalog failed the
  dispatch, and it failed partially: a skill with no sibling resources resolved from the catalog
  alone while one with resources threw out of the resource fetch, so the feature read as wired. The
  sync half went remote too — unlike the prompt-fragment library, whose sync stays mothership-owned
  because "a mothership node has no GitHub client", a mothership node now reaches GitHub by token
  delegation, so its skill link/sync/unlink routes were live and broken rather than absent.

  Adds a `skillSource` scope rule: the sync methods carry a source id and nothing else, so nothing
  positional binds them; it resolves the source's owning account server-side (memoised, sharing its
  read with the dispatched call). The global `skillSourceRepository.listByRepo` — the push-webhook
  reverse lookup across every account — stays mothership-internal.

  Adds `accountFieldUpsert` alongside it, for a record-keyed write whose conflict key is the record's
  `id` rather than its `accountId`. `accountField` binds only the account a record DECLARES, which is
  sufficient only while the row is stored under that account — an `ON CONFLICT (id) DO UPDATE` that
  does not re-`SET account_id` instead writes whichever row already holds that id, under its own
  account. The new rule binds the stored row too, so a token scoped to one account can no longer name
  another's source id and repoint their link at a repo it controls (whose `SKILL.md` bodies the other
  tenant's next sync would fold into their catalog as agent instructions); an absent row is a create
  and still passes.

  A misconfiguration now also reports itself correctly: the persistence controller's per-request memo
  overrides are applied only for repositories the deployment actually wires, so a mothership without
  the library answers `... is not wired` instead of a scope 404 that reads as a missing row.

  `GitHubInstallationRepository` gains `listActiveForAccount`, the account-scoped form of the cron
  `listActive`. The account-tier installation lookup every repo-sourced library resolves its GitHub
  credential through read EVERY tenant's installations and filtered in JS — unexposable over an
  account-scoped machine API, and unbindable by any scope rule since the method takes no arguments.
  The narrowing ("bound to the account directly, or to one of its own boards") now runs in SQL on
  both runtimes, ordered so they pick the same row, and the resolver makes one query where it made
  two.

  Both ends of a mothership deployment must have the skill/fragment library enabled: the mothership
  reflects the skill repositories into its machine-API registry only when its own library is
  configured, exactly as it does for fragments.

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/agents@0.98.0
  - @cat-factory/integrations@0.114.1
  - @cat-factory/orchestration@0.181.1
  - @cat-factory/contracts@0.206.1
  - @cat-factory/spend@0.12.137
  - @cat-factory/prompt-fragments@0.15.30

## 0.189.0

### Minor Changes

- 5511cdc: Finish the foundational-services catalog: it now has a management surface, a way for a board to opt
  out of an inherited service, and push-driven freshness.

  The SPA gains an account-settings tab and an advanced-tier board panel: register a service with its
  uploaded API contracts, link a repo of service definitions (a folder of them, or an explicit file
  list for one named service), and — on a board — review the merged catalog an Architect is actually
  handed, expanding a contract document through the same lazy read a consumer dispatch makes. Opening
  the catalog still transfers no document body.

  A board opts out of an inherited account service through a new suppression sub-resource
  (`POST`/`DELETE /workspaces/:ws/foundational-services/:id/suppression`, plus a
  `GET /workspaces/:ws/foundational-service-suppressions` list read). It is
  deliberately not a delete: deleting removes the board's own registration and its documents, where a
  suppression destroys nothing and is reversible. Suppressing an id the catalog does not carry, or one
  the board registered itself, is refused rather than silently written.

  Repo sources now also refresh on a GitHub push webhook, alongside the periodic sweep — the same
  fan-out the skill library uses, cutting worst-case staleness from the sweep window to seconds. That
  matters more here than for skills: a stale API contract is handed to a coder as the interface to
  write against.

  Breaking: adds a `hardDelete` method to `FoundationalServiceRepository` and a `listByRepo` to
  `FoundationalServiceSourceRepository`, so an out-of-tree implementation of either port must
  implement them; `GitHubWebhookIngest` likewise gains `queueFoundationalResync`.

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0
  - @cat-factory/agents@0.97.0
  - @cat-factory/integrations@0.114.0
  - @cat-factory/orchestration@0.181.0
  - @cat-factory/prompt-fragments@0.15.29
  - @cat-factory/spend@0.12.136

## 0.188.1

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0
  - @cat-factory/orchestration@0.180.0
  - @cat-factory/agents@0.96.1
  - @cat-factory/integrations@0.113.9
  - @cat-factory/prompt-fragments@0.15.28
  - @cat-factory/spend@0.12.135

## 0.188.0

### Minor Changes

- 0b52df7: Add foundational services: a tiered (account ⊕ workspace) catalog of the shared capabilities an
  organisation already runs — file storage, notifications, audit — each with a description and its
  API contracts (OpenAPI 3.x, `@toad-contracts/core` or `@lokalise/api-contract`), supplied either by
  direct upload or by linking files/folders in a git repo that is cached and auto-refreshed on both
  runtimes.

  The Architect is folded the catalog (identity, capability tags and indexed operation names — never a
  document body) and must declare the service ids its design consumes; the Researcher and Coder are
  then handed the full API contracts of exactly those services, plus an explicit statement of anything
  the design named that the catalog does not contain.

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0
  - @cat-factory/agents@0.96.0
  - @cat-factory/orchestration@0.179.0
  - @cat-factory/integrations@0.113.8
  - @cat-factory/prompt-fragments@0.15.27
  - @cat-factory/spend@0.12.134

## 0.187.0

### Minor Changes

- 9c6ce7a: Mothership mode: carry a finished run's telemetry up to the mothership.

  Telemetry on a mothership-mode node is captured locally, which until now meant it stayed there: a
  hosted teammate opening a run a developer drove saw an empty observability panel, zero token
  rollups and no web-search log, and the rows vanished when the node's short retention window came
  round. A new machine-authed `POST /internal/telemetry/ingest` (mounted on both facades, gated and
  account-scoped exactly like the persistence RPC) accepts a bounded batch of a run's captured rows,
  and a background sweep on the node uploads each run once it has gone quiet.

  The mothership STAMPS the batch's scope-bound workspace and run onto every row it stores, so a node
  can only ever file telemetry for a run in a workspace it can already reach. Appends are idempotent
  by row id — a new `recordMany` on the three run-scoped telemetry ports, mirrored across D1, Drizzle
  and the local `node:sqlite` store — which is what makes a lost-ack chunk safely retryable.

  Note the deliberate asymmetry between `record` and `recordMany`: only the batch append ignores a
  duplicate id, because only the batch is retried. A batch over the per-request caps is refused
  rather than truncated, since the node treats a success as "this range is stored".

  That last rule is what makes the sweep's success path load-bearing, so two things follow from it.
  A node with no machine token yet rejects with the new `MachineTokenUnavailableError` instead of
  resolving an empty result, which would have read as "this run had no rows" and let the local prune
  delete telemetry that never left the laptop. And batches are budgeted by BYTES as well as row
  count, because the mothership refuses on either — a page built to the row cap alone could sit
  permanently over the body cap. A row too large to post even by itself is skipped and reported
  rather than retried into a stall.

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0
  - @cat-factory/agents@0.95.1
  - @cat-factory/integrations@0.113.7
  - @cat-factory/orchestration@0.178.1
  - @cat-factory/spend@0.12.133

## 0.186.0

### Minor Changes

- 54e6a45: Agent-kind variants: register an alternate prompt for an EXISTING kind programmatically

  `AgentKindRegistry.registerVariant({ id, baseKind, systemPrompt | promptAddition })` lets a
  deployment ship "the Coder, but test-first" without inventing an agent kind. A pipeline step
  selects one through `stepOptions.agentVariantId`, so the step still records the base kind and every
  behavioural decision — dispatch shape, guardrails, companions, gating, the palette — is unchanged;
  only the prompt differs. The engine resolves the variant in the same once-per-dispatch place as a
  per-workspace prompt override and emits it through the same field, so the engine-enforced
  directives still apply on top and a workspace override still wins as the narrower tier.

  Because the workspace wins on the same unit of text, selecting a variant is not proof it ran: the
  dispatch pins what it actually did onto `PipelineStep.promptVariant` (`full` / `addition-only` /
  `superseded` / `withdrawn`, plus a fingerprint of the text the variant contributed) and warns on
  every losing disposition. The run views and Kaizen's combo key both read that pin rather than the
  step's selection, so a step is never reported as running a variation whose text never reached it, and
  re-wording a variant under the same id starts a fresh verification streak instead of inheriting the
  previous wording's.

  Varying an INLINE-ENGINE kind (the requirements + clarity reviewers, the brainstorm stages, their
  rework editors) is refused at boot and at pipeline save rather than accepted and ignored: those kinds
  compose their prompt without a step, so the variant could never reach the model. Vary them with a
  per-workspace prompt override instead. `merger` and `on-call` are unaffected — they dispatch through
  the engine, so a variant applies to their role half.

  The two bespoke container prompts (`merger`, `on-call`) moved from `@cat-factory/server` into
  `@cat-factory/agents` alongside the inline-engine ones, and `builtInBaseSystemPrompt` is now
  `shippedBasePromptFor` exported from there.

### Patch Changes

- a7aae8a: Finish the `/api/v1` external surface: a workspace usage read, and an outbound run-lifecycle push
  so an integration stops polling.

  `GET /api/v1/usage` (a `read`-scope key) serves the current billing period as ONE resource: the
  METERED budget position the spend safeguard itself acts on — including `exceeded`, which is what
  pauses runs — plus the per-`(billing, vendor, provider, model)` breakdown behind it. Splitting it
  into two endpoints would let a caller render a breakdown against a budget read a period-roll apart.
  It reads through a new `SpendService.periodUsage`, which resolves ONE `periodStart` for both
  aggregates and still issues them concurrently: composing the response from `status()` +
  `usageBreakdown()` would have reintroduced the same skew inside one request, since each derives its
  own period from the clock.
  Rows keep their `billing` discriminator and are never summed for the caller: a `subscription` row's
  `costEstimate` is illustrative (a flat-rate plan bills nothing per token), so adding it to metered
  spend would report money nobody is billed for. Workspace tier only — the account and user budgets
  are cross-workspace, and a workspace-scoped key must never learn a sibling workspace's spend.

  The workspace's ONE registered outbound endpoint now also delivers run-lifecycle events —
  `run.started`, `run.completed`, `run.failed` — beside the notification cards it already carried,
  reaching the transport through a new kernel `RunLifecycleSink` port. This exists because the HAPPY
  path raises no notification at all: a pipeline whose `merger` merges its own PR settles with an
  empty inbox, which is exactly the outcome a CI system wants to hear about. Same row, same sealed
  secret, same SSRF guard, same retry budget: the retry/signature/redirect core moved to a shared
  `signedDelivery.ts` that both families drive, because everything interesting about a delivery is a
  property of the endpoint rather than the payload.

  **Subscribing is opt-in and empty means NONE**, deliberately the opposite of the sibling
  notification `types` filter — an endpoint registered for parked decisions must not silently start
  receiving an event per run — so an existing webhook keeps byte-for-byte its current behaviour until
  someone sets `runEvents`.

  Worth knowing when reviewing: the two edges hook different places on purpose. `run.started` fires
  from `handOffLiveRun`, the one funnel every start path ends with, and is announced LAST — after the
  block is committed and the durable runner has the run — so a slow or black-holing receiver costs the
  announcement and never the run. It is still exactly once, because the claim that precedes the
  hand-off (`insertLiveRunOrConflict`) is what mints a live run, and a start path added later inherits
  it since skipping the funnel would also skip `startRun`. The terminal edges fire from the engine's
  terminal-emit funnel, because a run reaches `done` from four independent sites and a hook at each
  would compile, pass, and drift the day a fifth is added — the cost is that a durable replay can
  re-emit a settled run, so delivery is **at-least-once** with a `<runId>:<event>` dedupe id in the
  body. **Dedupe on that id, not on the body**: a replay re-stamps `sentAt`/`occurredAt`, so two
  deliveries of one transition are not byte-identical even though everything a receiver routes on is.
  That is a considered departure from the platform's atomic-claim rule: unlike a merge or a posted
  review, a repeat here is collapsed by one id comparison, so it does not earn a claim table and the
  sweeper that would come with it.

  `docs/openapi.json` shrinks by ~17k lines in the same change, with no semantic difference beyond
  the new endpoint. The generator copied every component definition into a `$defs` block on each
  schema it inlined, so the whole component set was duplicated across ten operations and every new
  public DTO cost roughly ten times its size in the committed file. Those `$defs` resolved nothing —
  the refs are rewritten into `#/components/schemas` — and generation now asserts that every `$ref`
  names an emitted component, so a DTO that actually needs hoisting fails the build instead of
  shipping a dangling pointer.

  Schema: `notification_webhooks` gains a `run_events` JSON column (D1 migration 0072 ⇄ Drizzle),
  defaulting to `'[]'`. The webhook repository is now read on the run's terminal path, so it is
  allow-listed for mothership mode (`get`/`put`/`delete`, workspace-scoped) — an un-routed method
  there would have surfaced only as a webhook that silently never fires, since both delivery paths
  are best-effort by contract.

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/agents@0.95.0
  - @cat-factory/contracts@0.203.0
  - @cat-factory/orchestration@0.178.0
  - @cat-factory/kernel@0.201.1
  - @cat-factory/integrations@0.113.6
  - @cat-factory/spend@0.12.132
  - @cat-factory/prompt-fragments@0.15.26

## 0.185.2

### Patch Changes

- 16fd126: Split the six files over 2,000 lines along cohesive seams so the oxlint `max-lines` ceiling can
  drop to its floor: the engine's human decision surface into `StepDecisionController`, the
  dispatcher's running-poll branch tree and one-shot engine steps into `PollRunningController` /
  `OneShotStepController`, the Worker composition root into model-resolver / executor-deps /
  vcs-identity modules, provisioning auto-detection's Kubernetes half into its own module, and the
  Node schema's tenancy tables into `db/tables/identity.ts`. Every extraction is a behaviour-neutral
  move behind unchanged public surfaces.
- Updated dependencies [16fd126]
  - @cat-factory/orchestration@0.177.1
  - @cat-factory/integrations@0.113.5

## 0.185.1

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/orchestration@0.177.0
  - @cat-factory/agents@0.94.0
  - @cat-factory/kernel@0.201.0
  - @cat-factory/integrations@0.113.4
  - @cat-factory/spend@0.12.131

## 0.185.0

### Minor Changes

- 9d303f0: Make an agent kind's output-token ceiling configurable from the pipeline builder, at two tiers over
  the deployment routing default: per pipeline step (`StepOptions.maxOutputTokens`) and per workspace
  per agent kind (the new `workspace_agent_settings` store). The engine resolves the winner once per
  dispatch onto `AgentRunContext.maxOutputTokens` — narrowest tier wins — so the container, inline and
  consensus paths cannot disagree about the budget a step ran under.

  Note the ceiling is advisory on the subscription-CLI inline path (the one-shot CLIs don't all honour
  it), so it bites on the metered provider path.

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0
  - @cat-factory/orchestration@0.176.0
  - @cat-factory/agents@0.93.0
  - @cat-factory/integrations@0.113.3
  - @cat-factory/prompt-fragments@0.15.25
  - @cat-factory/spend@0.12.130

## 0.184.0

### Minor Changes

- 1cd9d73: Tell agents which system they are working on, and stop the platform standing in for it.

  A neutral task ("implement webhooks") was coming back from requirements review as a design for the
  orchestrator's own webhooks. The cause was structural rather than a bad prompt: no agent prompt named
  the block's OWN service. A step's prompt carried the pipeline, the block, and every PEER service —
  never the one the work belongs to. A container agent recovers that by reading its checkout; an inline
  reviewer cannot, so a short title arrived with no identified subject, and a model asked for concrete
  findings against an unidentified subject supplies one — commonly the most salient proper noun in the
  prompt, which is the platform's own name.

  `AgentRunContext.ownService` now carries the enclosing service frame, derived from the ancestry walk
  the repo resolution already does. It is a discriminated result, not a nullable field, because the two
  ways of having no service mean opposite things: a frame-level run has none because it IS one, while a
  loose task has none because the platform does not know — and that case is now RENDERED, not omitted.
  An omitted product reads exactly like an obvious one, which is what invited the invention.

  Three follow-on breaks in the same chain:

  - A derived subject no longer displaces the requester's words. An incorporated requirements document,
    a brainstormed direction and a clarified bug report are rendered ABOVE the original description
    instead of replacing it. Substitution is how one pass's drift became permanent — the derived text is
    authoritative on the next pass, so nothing downstream could still see what was asked for.
  - The Requirement Writer's provider-hosted web search is withheld when the system is unidentified. A
    model-composed query about a guessed product returns real sources about unrelated software, which
    reads as diligence. Each suggestion now also reports what it rests on (`groundedIn`:
    team standard / project spec / web / general practice), surfaced in the review window.
  - The inline review kinds honour per-workspace prompt overrides at last. They run as bare
    `generateText` calls, so they never reached `systemPromptFor` — the seam that applies an override —
    while the prompt editor happily accepted one and showed a baseline no code path sent. Their prompts
    are now `{ role, directives }` pairs like the bespoke container kinds, so an override replaces the
    role and cannot delete the JSON output contract or the scope rules.

  Behaviour change to be aware of when reviewing: every built-in prompt gains one appended paragraph
  (the platform is not the product), and the requirements / clarity / brainstorm prompts are reordered
  into their two halves, so all nine are version-bumped. A workspace that had saved an override for one
  of the inline kinds will find it takes effect on the next run, having previously done nothing.

### Patch Changes

- 0bffe55: Resize a service frame or module by dragging any of its borders, and drop the frame's
  "N/M implemented" tally.

  The resize grips were children of the frame's inner drop zone, which put them 16px inside the
  visible border, flush against the task canvas — two thin strips that read as scrollbars rather than
  as the frame's edge — and only the east/south borders had one at all. All eight borders and corners
  are now grips on the box itself (a shared `ResizeGrips.vue`, so the frame and the module can't
  drift), each straddling the border it moves: a 12px hit band centred on it, 24px on a coarse
  pointer, with a 2px bar that lights up on the border under the pointer and stays lit on the grabbed
  border for the whole drag. `useFrameResize` holds that border's cursor on `<body>` while dragging so
  the pointer outrunning the band no longer reads as a dropped grab, restoring it on `pointercancel`
  as well as `pointerup`. The grips are hidden outright for a read-only viewer instead of lighting up
  and no-opping.

  Dragging the north or west border moves the container's content origin, and a child's position is
  stored relative to that origin, so the contents have to be translated the other way or they slide
  with the border. `POST /blocks/:id/resize` (new) carries both halves of the geometry and does that
  in one arithmetic UPDATE via the new `BlockRepository.shiftChildPositions` (D1 + Drizzle, with
  cross-runtime conformance assertions); the SPA applies the same compensation optimistically during
  the drag and replays it inverted if the write is rejected.

  Fixes a latent bug this surfaced: `BoardService`'s frame-mount resolution looked a frame block id
  up globally (`getByFrameBlock`), while every read resolves layout from the board's own mounts. Since
  seeded boards all carry the same block ids, a deployment with two of them could resolve another
  board's service, land the write on the block row, and have every read override it with this board's
  mount. It now resolves in the same direction the snapshot does: the frame id's candidate services
  intersected with the acting board's own mounts (`mountProjection.ts`, the read half of the
  frame-geometry split `layoutWrites.ts` writes). Starting from the board rather than from the
  candidates is what keeps it routable in mothership mode — `listByFrameBlocks` is not
  account-scoped, so a colliding seeded id in another org rides the candidate list, and asking the
  persistence RPC for those services' mounts is refused closed.

  The frame header's "N/M implemented" line is gone (with the `board.frame.implemented` key, in every
  locale): each task card already shows its own status, so the frame-level tally restated that more
  coarsely and counted every task ever added to the service rather than the work in flight. The module
  and PR-ready counts stay, and the line hides entirely when there are neither.

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0
  - @cat-factory/orchestration@0.175.0
  - @cat-factory/agents@0.92.0
  - @cat-factory/integrations@0.113.2
  - @cat-factory/prompt-fragments@0.15.24
  - @cat-factory/spend@0.12.129

## 0.183.1

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/agents@0.91.0
  - @cat-factory/orchestration@0.174.0
  - @cat-factory/contracts@0.200.0
  - @cat-factory/integrations@0.113.1
  - @cat-factory/spend@0.12.128
  - @cat-factory/prompt-fragments@0.15.23

## 0.183.0

### Minor Changes

- 123ac6f: Make a PR review's finished slices durable while it runs, and let a review stuck mid-flight be resumed for only the slices that never came back.

  The reviewer fans a large diff out across parallel subagents, then folds their findings into one structured output at the very end. Until that output arrives the step holds nothing but progress counts: `prReview.slices` and `prReview.findings` are both `[]`, because `coercePrReview` runs exactly once, from the terminal result. So the entire review lived in the container's memory until its last second, and anything that killed it first — the inactivity or max-duration watchdog, an evicted container, a wedged aggregation — threw away every completed slice and left a re-run from zero as the only option.

  The measured incident makes the cost concrete: 18m05s wall clock and 25.46M input tokens, of which the final **196 seconds** were a single silent turn generating the findings JSON. During that window all nine task-list entries read complete, `findings` was still empty, and `lastActivityAt` had frozen — because the heartbeat is fed by tool-call events and subagent transcript growth, and a long single completion produces neither. A run in that state is indistinguishable from a wedged one, and nothing could recover it: `ProgressGuard` needs a tool call to evaluate anything, the inactivity watchdog is reset by any subagent transcript byte, and the 60-minute max-duration kill discards the work instead of saving it.

  The persistence half reads what was already on the wire and being discarded. A subagent's dispatch and its terminal `tool_result` both appear on the parent stream (only its intermediate turns don't), and the slice tracker was matching that `tool_result` purely to flip a `done` flag while dropping the report inside it. It now captures that report — bounded, credential-scrubbed — and publishes the whole set on the job view as each slice lands, so the engine can fold it onto `prReview.sliceReviews` continuously rather than at the finish line.

  On top of that, `POST /executions/:id/pr-review/resume` re-dispatches a review still in `reviewing` for only the unfinished slices, handing the resumed agent the already-captured reports as `.cat-context/pr-prior-review.md` and telling it to fold their findings into its aggregate rather than re-review them. Which slices remain is derived from what the platform observed — the captured reports plus the previous attempt's task list, the only place a planned-but-never-dispatched slice is named — never from the caller.

  Notes for reviewers:

  - The channel is a **whole-value latest publish**, not the drain-on-read that `followUps` and `spans` use. Those can afford to lose a poll window; this one carries the work being protected, so a dropped poll response must cost nothing. The fold is correspondingly monotonic: it never demotes a `completed` slice back to `in_progress` and never drops a report the incoming set omits, because a resumed container's tracker knows only the slices IT dispatched and forwarding that verbatim would erase the previous attempt's reports — which are the whole point.
  - **A resume bumps `prReview.resumeAttempts`, and that feeds the step's dispatch epoch.** This is the sharpest thing to check. A container-reusing transport (a warm local pool, a self-hosted runner pool) re-attaches to a known job id rather than re-running, and the reviewer step carries none of the loop counters (`test`/`gate`/`ralph`) the epoch is otherwise derived from — so without this term every resume would mint the same job id and hand the recovery straight back to the wedged job it was meant to replace.
  - **The prior-review context file is emitted by `AgentContextBuilder`, not by a preOp** beside the reviewer's existing three. Two reasons, the second decisive: the state rides the STEP, which `RepoOpContext` deliberately does not carry (it hands ops the block-scoped run context and a `RepoFiles`); and a preOp runs only once a run repo RESOLVES, which this file needs no part of, so gating on it would silently turn a resume back into a from-zero re-review wherever repo context is unwired. The alternative considered was widening `RepoOpContext` with the step — rejected as handing every op full mutable step state to serve one field. `injectedContextFiles` therefore has two producers now, and `RunRepoOpsController` APPENDS rather than assigns.
  - **`sliceReviews` is cleared once an aggregation CONSUMES the reports, but not when the reviewer returned neither slices nor findings.** Clearing there would destroy the only record of the finished slices while recording the run as a clean PR — the exact loss this channel prevents, wearing a pass as a disguise. That is also why a partial aggregation cannot strand reports: a resume is refused unless the review is still `reviewing`, so by the time findings land the reports are either folded in or deliberately retained.
  - **`reviewedHeadSha` is preserved across a resume rather than re-stamped.** It records the head the findings were computed against, and the completed slices' findings were computed against that tree. The cost is a wider drift window on a long resume, which the `post` resolution already absorbs by folding drifted findings into the summary; re-stamping would silently re-enable inline anchoring on lines that may since have shifted.
  - **The resume control is deliberately not gated on a staleness heuristic.** `lastActivityAt` freezes on a long silent turn, so the platform cannot tell a wedged review from a quiet-but-working one, and hiding the control until it thinks it can would put it out of reach in exactly the case that motivated it.
  - Wire-shape changes, no compatibility shims (pre-1.0 policy): `prReviewStepStateSchema` gains a required-with-default `sliceReviews` and `resumeAttempts` plus an optional `resumePendingSlices`, so every construction site supplies the first two. Existing rows read as an empty list / zero.
  - A **runner-pool** deployment maps the channel through a new `sliceReviewsPath` on the response manifest. A pool that leaves it unset keeps the old all-or-nothing behaviour, and unlike the other latest-value paths that is not merely a lost live view: without it a pool-backed review has nothing for the resume to work from. Local and Cloudflare container transports forward the job view verbatim and needed no change.

  Still unaddressed, and deliberately: the frozen heartbeat itself. A long single completion produces no stream events at all, so a run in its aggregation tail still reads as wedged. A synthetic beat would defeat the inactivity watchdog outright — the only thing that kills a genuinely hung agent — and real token deltas need `--include-partial-messages` plus a rework of the call aggregator's `message.id` folding. Until then the captured reports are the tell (every slice `completed` with `findings` still empty means aggregating, not stuck), and the resume is the escape hatch either way.

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/agents@0.90.0
  - @cat-factory/contracts@0.199.0
  - @cat-factory/integrations@0.113.0
  - @cat-factory/kernel@0.197.0
  - @cat-factory/orchestration@0.173.0
  - @cat-factory/prompt-fragments@0.15.22
  - @cat-factory/spend@0.12.127

## 0.182.0

### Minor Changes

- 550a7fe: Supervise an inline host-CLI run by how long it is STUCK, not by how long it works.

  `spawnCliExec` armed one 300s timer at spawn and never touched it again, so the budget bounded the
  whole run: an inline step was killed for being SLOW rather than for being stuck, with nothing a
  deployment could set to say otherwise. The observed failure is a `doc-researcher` on the ambient
  `claude` CLI killed at exactly 5 minutes having made 53 model calls, burned 2.9M tokens and run 24
  tool calls — legitimate work, mid-turn — and every retry died the same way, so the step could never
  complete. That also made it permanently unaccounted for: usage reaches `token_usage` from a call
  that COMPLETED, so a step that dies on every attempt records nothing however much it spent, which
  is what "the run shows zero model calls" actually meant.

  Two budgets now, because "hung" and "long" are different failures with opposite fixes:

  - an **idle** window (`LOCAL_INLINE_CLI_IDLE_TIMEOUT_MS`, default 300000) re-armed by every chunk on
    either stream, so it measures the gap between bytes. `stream-json` narrates a healthy `claude`
    continuously, so silence this long is a real symptom while elapsed time never was.
  - an absolute **ceiling** (`LOCAL_INLINE_CLI_MAX_TIMEOUT_MS`, default 3600000) for the run that
    narrates forever and therefore never looks idle — the one case an idle window cannot bound.

  Both still reject as a `timeout` (unchanged for callers), but they say different things: the idle
  kill names the silence it overran, the ceiling kill names the ceiling and the variable that raises
  it. The idle message drops the redundant silence clause it would otherwise restate. The FIRST kill
  wins: every trigger stays armed until the child closes, so an abort landing inside the SIGKILL
  grace period used to overwrite the reason and surface a supervised kill as a user cancellation.

  New in `@cat-factory/server`: `parseTimerEnvMs`, the validator for an env var that becomes a
  `setTimeout` delay, beside the `parseNumericEnv` it is deliberately stricter than. A plain numeric
  knob is right to accept `0` / `-1` / `1.5`; a timer budget is not, and neither is a value above
  `MAX_TIMER_DELAY_MS` (2147483647) — Node truncates a larger delay to **1ms** rather than saturating,
  so the number an operator types meaning "effectively no ceiling" is exactly the one that would kill
  every supervised run within milliseconds, while reporting the enormous ceiling it claims to have
  hit. Every unusable spelling now warns and defers to the built-in default.

  The incoherent-pair warning (a ceiling below the idle window makes the idle watchdog unreachable, so
  a stuck CLI is reported as a slow one and the operator raises the wrong number) now compares the
  EFFECTIVE budgets rather than only the explicitly-set ones — lowering just the ceiling is the likelier
  single-knob edit, and gating on both being present let exactly that case through in silence.

## 0.181.0

### Minor Changes

- 99412e2: Report infrastructure that is configured but DEAD, live — the reachability watcher deferred out of
  the `cat-factory supervise` PR (#1527), plus the wire contract and the banner it produces for.

  The infra-setup banner could only say "you never set this up". A provider that WAS set up and has
  since died looked identical to a healthy one, because the projection asks whether a connection ROW
  exists, not whether anything answers. That gap is how an outage sits unnoticed for a day: every
  testing agent fails while the board reports a perfectly healthy setup.

  ## The watcher

  `sweepInfraReachability` is a runtime-neutral sweep (Worker cron ⇄ Node interval, exactly like
  `sweepPlatformHealth`). For each board it probes the SAVED environment-provider and runner-pool
  connections through new `probeSavedConnection` methods — distinct from `testConnection`, which
  answers "would this config work" for an operator at a form and asserts config safety. Re-running
  that safety assertion against an already-persisted connection would report it as an outage the
  moment a deployment tightened its URL policy, so the probe makes none.

  Opt-in (`INFRA_REACHABILITY_WATCH`): it is the one sweep that makes an outbound call per workspace
  per pass, to infrastructure the deployment does not own. That cost profile is the operator's call.

  FOUR probe results, deliberately not two, because they need four dispositions. A probe that ANSWERED
  `ok: false`, or did not answer inside the per-probe budget, is an outage. A probe that THREW, or that
  could not be asked at all (a de-registered backend kind, an unparseable config), is INDETERMINATE and
  leaves the recorded state exactly as it was — a throw is a LOCAL fault (an unresolvable connection, a
  secret bundle that would not decrypt), and blaming the operator's cluster for our own missing key is
  the "never infer a cause from the presence of an error" trap. An area with NOTHING REGISTERED is
  neither: it is knowably not an outage, so the recorded failure is forgotten while announcing nothing
  (the honest next state is the `not_defined` setup gap the snapshot recomputes, not a "recovered"
  push). Collapsing those last two — as a `ConnectionTestResult | null` return forced — meant an
  operator who fixed a dead runner pool by UN-REGISTERING it kept the open card forever, escalating
  red, since nothing but a probe clears a record only a probe writes.

  The watcher probes exactly the areas the snapshot projection would NAG about, through the one shared
  `infraSetupAreaApplies` predicate. Gating on "is the module wired" (which the projection does not)
  was strictly looser: `agentExecutorRequiresRunnerPool` is unset on Cloudflare and false on local
  mode, so a dead-but-optional runner pool raised a card, paged Slack and pushed `unreachable` for an
  area whose banner the projection then refused to render — an outbound probe cost paid to report
  something nobody could see on reload.

  `INFRA_REACHABILITY_INTERVAL_MS` now means the same thing on both facades. The Worker's `scheduled`
  tick fires every 2 minutes for every backstop it drives, so the operator's only lever on the one
  sweep that calls out per workspace did nothing there; the sweep now runs only on the tick that opens
  a new interval window — pure arithmetic on the cron's aligned timestamp, so it stays stateless in a
  fresh isolate.

  ## Where the last-observed state lives

  The contract requires publishing on TRANSITION only, which needs durable prior state — a Worker cron
  tick runs in a fresh isolate, so in-memory would re-announce every ongoing outage every pass. Rather
  than a table, the state is the workspace's open `infra_unreachable` notification and its
  `payload.unreachableAreas`, the same way the platform-health sweep uses its card's `platformAlerts`
  set. That card is already durable, already runtime-symmetric, already routed for mothership mode and
  already read by the board snapshot — so the sweep needs one batched `listOpenByType` and the
  projection folds the same record with no extra query and no probe on the board-load path. An
  operator also gets an inbox card and a Slack route for the outage, which is the right surface for it
  anyway.

  The per-area probe REASON is not persisted there: it varies between passes, and any content change
  re-delivers the card, so it would re-toast the inbox for the whole outage. It rides the live
  transition instead — which is when someone is actually looking — and the banner RENDERS it, since a
  refused connection, a rejected token and a timeout need different fixes and the generic body cannot
  tell them apart. Absent after a reload, so it is an addition to the copy rather than the only thing
  that explains the card.

  ## The wire contract and the banner

  - `infraSetupStatusSchema` gains **`unreachable`**, riding the existing setup projection rather than
    a second "your infra is broken" surface: the consequence is identical to `not_defined` (a class of
    agents cannot run) and the same operator surface fixes it, so the banner, deep-link and i18n are
    reused.
  - `isInfraSetupHealthStatus` + `INFRA_SETUP_HEALTH_STATUSES` mark it a HEALTH state, and the banner
    honours the difference: the other three statuses are stable operator decisions, so they offer a
    permanent per-user "don't notify me again"; applying that to an outage would let one click silence
    every future occurrence. An outage is session-dismissible only and it re-nags on recurrence. BOTH
    dismissals are keyed by the CLAIM (area + kind), never by the area alone, because the two cards an
    area can raise say different things about it: silencing "you haven't configured this" must not also
    silence the outage card raised after the operator configures it and the provider then dies.
  - `applyInfraSetupTransition` (contracts) is the ONE rule about which prior state a probe verdict may
    overwrite — only a `configured` area may become `unreachable` — and both delivery paths fold
    through it: the backend's snapshot projection and the SPA store's live patch. The live patch used
    to assign unconditionally, so a pushed `unreachable` rendered a red "check that the service is
    running" banner over a `not_applicable`/`not_defined` area, which then vanished on the next reload.
    A banner that contradicts the projection is worse than a late one.
  - `WorkspaceEvent` gains **`infraSetup`**, carrying the area, the new status and the probe's reason,
    which the SPA applies as a targeted one-field patch. A coarse refresh would pay the whole snapshot
    aggregate for a one-field delta.

  ## Also fixed

  `FanOutEventPublisher` delegates method-by-method, so any event it does not name is silently dropped
  for every deployment wiring the in-org fan-out — nothing throws, the browser just never updates.
  `kaizenGradingChanged` was already being dropped that way. Both it and the new `infraSetupChanged`
  now forward, and a structural test reflects `NoopEventPublisher`'s surface so the next added event
  fails there instead of in production. `NoopEventPublisher` is in turn pinned to
  `Required<ExecutionEventPublisher>`, which closes the remaining hole: every publisher method is
  OPTIONAL, so a new event added to the port compiled fine with no implementation anywhere and would
  have slipped past a guard that reflected an incomplete Noop.

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0
  - @cat-factory/integrations@0.112.0
  - @cat-factory/agents@0.89.1
  - @cat-factory/orchestration@0.172.1
  - @cat-factory/prompt-fragments@0.15.21
  - @cat-factory/spend@0.12.126

## 0.180.0

### Minor Changes

- 1904eb8: Break loudly when a task's referenced context documents cannot reach the agent.

  A document attached to a block (or named by its description and resolved against the imported
  corpus) is the intent the agent is meant to build against, but two paths dropped one on the floor:
  a reference that resolved to a page with a blank body materialised a `.cat-context/` file holding a
  title and a URL the agent cannot open, and a corpus over the ~256 KB materialised-context budget had
  its overflow silently discarded. In both cases the run looked completely healthy while the agent
  worked from a spec nobody noticed it never read.

  Both now refuse, naming every reference that could not be delivered plus the remedy — re-import the
  page, or detach it from the task — and carrying a machine-readable `details.reason`
  (`context_document_unreadable` / `context_documents_over_budget`) so the run's failure record shows
  the cause rather than only the prose. The invariant lives in kernel
  (`domain/context-references.ts`) because the reference can vanish in two different layers and both
  must refuse in the same words. Each refusal is asserted over the content its caller actually
  renders: `hasReadableContent` where the raw body is delivered to a checkout, `contextExcerptFor`
  where an inline caller can carry only a short excerpt (a body that is pure markup is something a
  container agent at least opens, and projects to nothing for an inline reviewer).

  **Compatibility break:** a run whose task attaches an empty page, or more than ~256 KB of context,
  now fails instead of proceeding with less context than the board shows — the unreadable case on the
  first step that resolves context (`requirements-review` on the default pipelines), the over-budget
  case on the first container dispatch. That is the intended trade: the remedy is a human decision,
  and it is named in the failure.

  Both refusals now record the run failure as `preflight` rather than `agent`, since nothing ever
  reached an agent. That also fixes the KIND for every other `DomainError` a driver catches out of
  `advanceInstance` (a `github_not_connected` conflict, an unwired deploy runner), which used to be
  filed as an agent failure and sent readers looking for a transcript that does not exist.

  Two cases deliberately do NOT refuse. A URL that matches nothing imported is logged at `info`
  instead: the providers' `parseRef` implementations are host-blind (`parseNotionRef` claims any
  string carrying a UUID-shaped run; `parseConfluenceRef` any URL with a `/pages/<digits>` segment),
  so a claim is evidence of a shape rather than of a reference, and refusing would block a task whose
  description happens to link a dashboard. And a budget that omits an item from a PROMPT now states
  the omission rather than failing: `renderLinkedContext` says how many materialised items the capped
  index leaves unlisted (they are all on disk) and names the documents an inline, checkout-less
  kind's injection had no budget left for, since an unmentioned omission reads as "this is the
  complete set". Both notices are bounded, because a notice reporting a budget overrun must not be
  able to cause one.

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0
  - @cat-factory/agents@0.89.0
  - @cat-factory/orchestration@0.172.0
  - @cat-factory/integrations@0.111.2
  - @cat-factory/spend@0.12.125

## 0.179.0

### Minor Changes

- f9db6a6: Record the inline LLM calls that local mode serves from a host CLI, and stop filing run-scoped
  inline calls under a null execution id.

  The inline `llm_call_metrics` feeder was applied as the innermost provider wrap, so local mode's
  subscription-inline harness — which answers a Claude Code / Codex ref with its own
  `CliInlineLanguageModel` rather than delegating — was invisible to it. With `LOCAL_NATIVE_INLINE`
  on (the default), every inline step on a host `claude`/`codex` login recorded zero calls while the
  same step on a metered API model recorded fine. Separately, ten of the twelve inline call sites
  tagged only the workspace, so their rows landed with `execution_id = NULL`: in the store, but
  absent from every run-scoped read.

  Attribution also no longer trusts a settled run: `resolveBlockRunContext` drops the execution id
  once the run is terminal (keeping the initiator), because `block.executionId` is the block's LAST
  run rather than necessarily a live one. A stale id would report an inline call's spend against a
  finished run's rollup, and unlike a null nothing about a wrong-but-plausible id looks wrong.

  Compatibility breaks (pre-1.0, no shims):

  - `createScopedModelProviderResolver` no longer takes `instrument`, and the instrumentation and
    concurrency-limiter wraps are no longer exported individually. Apply the new
    `wrapResolverWithTelemetry(resolver, { instrument, limiter })` on top of the resolver — after any
    facade wrap that can substitute a resolved model. It owns the ORDER of the two wraps, which is
    load-bearing and which nothing in the type system holds: reversed, the composition still
    type-checks and still records every non-substituted call. Replace a `wrapResolverWithLimiter`
    call with the `limiter` field (build it with `vendorConcurrencyLimiterFromEnv`; it stays a
    pass-through when nothing is capped).
  - `createNodeModelProviderResolver` builds the BASE resolver only; its `instrument` and
    `workspaceSettingsRepository` parameters are gone, and the env-built trace-sink instrument it
    used to fall back to is now the exported `inlineInstrumentFromEnv(env, workspaceBodiesEnabled)`.
    A deployment assembling its own container composes the two — and MUST: a caller that merely drops
    the removed arguments compiles fine and silently stops instrumenting its inline calls.
  - `InlineInstrumentation` is now exported from `agents/modelProviderResolver` rather than derived
    from `ScopedModelProviderOptions['instrument']` (same shape, same import path from the package
    root).
  - `FragmentBriefService.resolveBriefs` takes its run on an options object (`{ executionId }`)
    rather than as a third positional argument.
  - `@cat-factory/agents` additionally exports `LimitedModelProvider`, so a facade wiring test can
    assert the wrapper it composed.

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/agents@0.88.0
  - @cat-factory/kernel@0.194.0
  - @cat-factory/orchestration@0.171.1
  - @cat-factory/integrations@0.111.1
  - @cat-factory/spend@0.12.124

## 0.178.2

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0
  - @cat-factory/integrations@0.111.0
  - @cat-factory/orchestration@0.171.0
  - @cat-factory/agents@0.87.2
  - @cat-factory/prompt-fragments@0.15.20
  - @cat-factory/spend@0.12.123

## 0.178.1

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0
  - @cat-factory/orchestration@0.170.0
  - @cat-factory/agents@0.87.1
  - @cat-factory/integrations@0.110.5
  - @cat-factory/spend@0.12.122
  - @cat-factory/prompt-fragments@0.15.19

## 0.178.0

### Minor Changes

- 7248b72: Open the consensus mechanism to the review agents, and make the panels a reusable, tiered library.

  A review is a judgement, which is the thing a panel of independent models is measurably better at
  than one model — but until now only the code `reviewer` among the review kinds could be run as
  one. The deep PR reviewer and the document/design/spec companions are now eligible too. What a
  panel can SEE differs by kind and is the reason the set stops where it does: `pr-reviewer` gets its
  whole input from backend-prepared context files, which the inline prompt builder now folds in, so a
  panel reads the same diff the container reviewer would; the checkout-exploring companions trade
  ground-truth depth for judgement diversity, which is why consensus stays opt-in per step and gated
  on the task estimate.

  The gating is what made the feature hard to actually use: a panel costs several model calls, so
  "run it only when the work is heavy" was already possible, but the panel itself had to be
  hand-written onto each step. A workspace now keeps a library of **consensus groups** — named
  panels (roles, perspective framings, models, strategy, synthesizer) each carrying the estimate bar
  it is worth paying for. A step names a SET of groups, and at dispatch the engine picks the most
  demanding tier the task's estimate clears, falling back to the standard single agent when none
  does. "A two-model review above 0.4 risk, the full panel above 0.8" is one step instead of three
  conditional pipelines, and the panels are shared across every pipeline in the workspace.

  Two decisions worth knowing when reading the code. The tier is selected in the ENGINE, not in the
  consensus executor, so the optional `@cat-factory/consensus` package never learns a group store
  exists and the executor still consumes one already-decided config; and the selected group's gating
  is deliberately dropped when it is materialised, because selection IS the gate — carrying it
  forward would have the executor re-decide the same question against the same estimate, where any
  future divergence silently turns a selected tier into a skipped step.

  Running a container kind as an inline panel is where this feature's sharp edge is, and three
  seams now carry that fact instead of assuming a filesystem. `dispatchDeliversCheckout` is the one
  definition of "does this dispatch hand the agent a checkout", shared by the composite executor's
  routing and by the engine, which passes it to a kind's repo hooks; the `pr-reviewer` diff renderer
  branches on it, so a panel is never handed the manifest-plus-`git diff` shape it cannot act on and
  anything that still does not fit its (larger) inline budget is named as unreviewable rather than
  passed off as reviewed; and the consensus executor appends a directive stating the participant's
  real surface, since the shipped prompts of most eligible kinds describe a machine the participant
  is not on. The prompt fold that feeds inline callers is also bounded now, and leaves the standards
  files to the system prompt, which folds them at the kind's configured verbosity.

  Also fixes a silent pre-existing bug found next door: `ExecutionService` never forwarded
  `agentPromptRepository` to the context builder, so a workspace's edited agent prompts never reached
  a dispatch. The forwarding was a hand-maintained list of ~28 field names; it now passes the
  dependency object it already has, which is why that class of omission can't recur.

  Adds a `consensus_groups` table and two `consensus_sessions` columns (the tier that fired, recorded
  by value so the transcript survives the library row being renamed or deleted) on both runtimes.
  A workspace that authors no group is byte-for-byte unaffected.

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0
  - @cat-factory/agents@0.87.0
  - @cat-factory/orchestration@0.169.0
  - @cat-factory/integrations@0.110.4
  - @cat-factory/prompt-fragments@0.15.18
  - @cat-factory/spend@0.12.121

## 0.177.0

### Minor Changes

- 4ecb25c: Record inline (non-proxied) LLM calls into `llm_call_metrics`, so an inline agent step's model
  activity is visible in-app instead of only in an external trace backend.

  `InstrumentedModelProvider` was the one LLM feeder that wrote to no repository: it called
  `traceSink.recordGeneration` and nothing else. So every inline call site — the judges, consensus,
  the requirements writer, the fragment selector, the fork chat, and the inline agent kinds
  (`doc-researcher`, `doc-outliner`, the document interviewer) — was invisible to
  `ObservabilityPanel`, to a step's token rollup and to `/api/v1/debug/*`. A run made entirely of
  inline steps reported zero model activity no matter what it spent, on the surfaces an operator
  actually opens. This is the coverage half of C2 in `docs/initiatives/observability-logging-gaps.md`
  (slice 5.6); its privacy half landed earlier.

  The provider now has a second exit, the kernel `InlineLlmCallRecorder` port, implemented by
  orchestration's `makeInlineCallRecorder` over the same `LlmObservabilityService` the proxy and the
  subscription harnesses already feed — so all three producers converge on one store rather than a
  third recording path being invented.

  Two things a reviewer should look at closely. First, the provider takes **exactly one** exit per
  call: the service behind the recorder performs the trace-sink fan-out itself, so a recorded call
  must not also be emitted to the provider's own sink — doing both would double every inline
  generation on Langfuse/OTel. Because that invariant binds two objects a facade could easily build
  from different sinks (which typechecks, and merely splits the trace), neither facade assembles the
  pair: `createInlineInstrumentation` composes both exits from one sink instance, and leaves the
  provider's `traceSink` as the fallback for a call carrying no `workspaceId` (the metric store is
  workspace-scoped, so such a call has no row to be filed under — the same deliberate fail-open the
  body gate already takes for an untagged call). Second, bodies now reach the recorder ungated: the
  service applies the identical `LLM_RECORD_PROMPTS` + `storeAgentContext` gate from the same kernel
  factory, plus `redactSecrets` and the prompt delta chain. Re-gating in the provider was rejected
  because it would withhold text the store is entitled to keep and restore the two-places-one-rule
  shape that produced C2's privacy half in the first place; instead the bodies cross as thunks and
  `record` resolves its gate before touching one, so a prompts-off deployment never serialises a
  prompt that is about to be discarded.

  **A second, pre-existing instance of C2's privacy half is fixed here too.** On both runtimes
  `makeHarnessCallRecorder`'s `LlmObservabilityService` was built with no `workspaceSettingsRepository`,
  and an absent repository makes `createStoreAgentContextGate` a constant `true` — so a subscription
  harness's full `stream-json` prompt and response were retained for a workspace that had explicitly
  opted out. It went unnoticed because that failure is silent by construction: nothing errors, the
  rows simply keep their bodies. Both facades now thread the repository. Existing rows are not
  rewritten; the fix applies from the next recorded call.

  The row mapping deliberately reports what an inline call does not know rather than filling
  proxy-shaped fields with plausible values: `turnIndex` null, `httpStatus` null, `phase` `''`,
  `streaming` false, and `upstreamMs === totalMs` so the derived overhead is a real 0. Conformance
  pins each of those on both runtimes' real stores, since each is one a store could quietly flatten.
  Anything reading these rows should expect inline calls in the unattributed `phase=""` slice —
  `backend/docs/debug-api.md` and the `investigate-telemetry` skill now say so.

  **A live bug on the existing trace-sink path is fixed on the way through:** the inline feeder read
  `finishReason` as a bare string, but the current AI-SDK spec reports it as `{ unified, raw }` — so
  every inline call has been exporting `finishReason: null`, which reads in telemetry as "the
  provider didn't say" rather than as a parse miss. It survived because the tests fed the reader a
  hand-rolled result carrying the shape the reader wanted; they now drive the SDK's own
  `MockLanguageModelV3` through a real `generateText`, which is what surfaced it. Both provider test
  suites are consolidated into the one beside the class (they had drifted into two packages).

  Behaviour note: an `InstrumentedModelProvider` built with neither exit wired now throws at
  construction. Nothing in-tree does that, and it would previously have been a silent no-op wrapper
  that still satisfied the facades' wiring assertions.

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0
  - @cat-factory/agents@0.86.0
  - @cat-factory/orchestration@0.168.0
  - @cat-factory/integrations@0.110.3
  - @cat-factory/spend@0.12.120

## 0.176.0

### Minor Changes

- 7ed2bc0: Condense long best-practice standards for the agents that re-read them every turn.

  Coding agents (`coder`, `fixer`, `ci-fixer`, `conflict-resolver`) re-send their whole system
  prompt on every turn of a long loop, so each folded standard is billed again and again. The
  two-tier `body` / `brief` split exists for exactly that, but only the code-authored built-in
  catalog could supply a brief: a managed standard — hand-authored, repo-sourced, or a living
  Confluence/Notion page, and including one that OVERRIDES a built-in id — always folded in full.
  Those are the long ones.

  A tenant can now link a short version (a field in the library editor, or a `brief:` frontmatter
  key on a repo-sourced guideline file), and a standard over ~1,500 characters with none gets one
  generated by a small model, persisted, and reused by every later dispatch. The stored brief is
  keyed by a fingerprint of the body it condensed, so an edit, a repo resync, or a re-resolved
  living document invalidates it and the next coding dispatch re-condenses — no change feed, and
  the same mechanism covers all three. Reviewer and planner kinds are untouched: they read the full
  standard, and never trigger a condensation.

  A standard that cannot be usefully shortened is a normal outcome — the generator is told to keep
  every rule even where that means returning the text near its original length — so that verdict is
  recorded against the body too, and the full standard is folded without asking again until someone
  edits it. A provider failure is deliberately not recorded, so a bad minute never disables
  condensation for a fragment. Whether a condensation is usable is judged as a proportion of the
  standard it condenses rather than a fixed length, so a very long standard condensed well is
  accepted while a short one restated at almost full length is not.

  Adds `prompt_fragments.brief` and a `fragment_briefs` table on both runtimes. No shipped built-in
  reaches the threshold, so the built-in catalog is unchanged; a deployment with no model wired
  folds full bodies exactly as before, as does every failure on the path — a brief changes how a
  standard is stated, never what it requires.

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0
  - @cat-factory/agents@0.85.0
  - @cat-factory/prompt-fragments@0.15.17
  - @cat-factory/orchestration@0.167.0
  - @cat-factory/integrations@0.110.2
  - @cat-factory/spend@0.12.119

## 0.175.0

### Minor Changes

- 9794c19: Validate a review task's target pull request when the task is created, and surface that pull
  request in the inspector.

  A `review` task carries a reference to an EXISTING pull request, and until now nothing checked it.
  A typo'd number was accepted silently and only surfaced much later as a run that dispatched a
  container, cloned the repo and found nothing to review. Creation now probes the PR through the
  same run-repo seam the review itself uses (`RepoFiles.getPullRequest`, new and optional on the
  `GitHubClient` / `VcsClient` ports, implemented for GitHub and GitLab), so the reference is checked
  against precisely the repository the reviewer will read.

  Only a POSITIVE "no such pull request" refuses — the provider's own 404, which the new port method
  reports as `null` while every other failure throws. An outage, a revoked token or a rate limit
  answers "unknown", not "absent", so those are logged and the task is created: making task creation
  depend on the provider being up would be a worse failure than the one this prevents. Same for
  every unwired case (no VCS connection, a provider that can't read a PR, a reference with no
  resolvable number) — all pass through unchanged.

  One case that looks like validation but is really a correctness fix: a pasted link belonging to a
  DIFFERENT repository is now refused (`review_pr_repo_mismatch`). The reviewer fetches the PR by
  NUMBER from the service's linked repo (ADR 0023 — a cross-repo `prUrl` is not resolved to another
  repo), so such a link previously reviewed whatever PR happened to carry that number on the linked
  repo, with nothing anywhere saying so.

  A confirmed reference is then rewritten to the provider's own URL for that PR, which is what makes
  the second half possible: the block inspector leads a review task's body with an "Under review"
  panel linking the reviewed pull request. That is the task's SUBJECT and it had no affordance at
  all before — only the Execution panel's link to the PR a run PRODUCED, which a review task never
  has. A task created while no VCS was connected keeps just the number, and the panel renders it as
  text rather than pretending to be a link.

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0
  - @cat-factory/orchestration@0.166.0
  - @cat-factory/agents@0.84.2
  - @cat-factory/integrations@0.110.1
  - @cat-factory/prompt-fragments@0.15.16
  - @cat-factory/spend@0.12.118

## 0.174.0

### Minor Changes

- 57e1195: Install a service's dependencies into the checkout before the agent's first turn.

  Agents opened a fresh shallow clone and saw manifests, not dependencies — they could read that a
  library was depended upon but not what it exposed, so they guessed at APIs, re-derived type shapes
  sitting on disk, or declined work they could have done. A service frame can now declare one
  install command (autodetected alongside its validation checks) that the harness runs against the
  checkout before the agent starts.

  It shares the `validation_configs` row with the pre-PR checks so resolution costs no extra
  round trip, but the two are threaded onto the job body under deliberately different rules: the
  checks ride only a PR-opening coding dispatch, the install rides every dispatch that gets a
  checkout — reviewers and architects most of all. Either may be declared without the other.

  Every harness mode with a checkout runs it (coding, in-place fixing, multi-repo coding, both
  explore paths, conflict resolution), through one shared seam that also keeps whatever the install
  materialises out of the agent's commits — a repo whose `.gitignore` misses its dependency
  directory would otherwise open a pull request containing the whole tree.

  The install is never a gate: a failure becomes a note in the agent's prompt and the run continues.
  The note rides every agent pass, so a validation or reproduction repair round does not spend
  itself reinstalling a tree that is already there.

  Bumps the runner image (harness `src/**`) and adds a nullable `dependency_install` column to
  `validation_configs` on both runtimes.

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0
  - @cat-factory/integrations@0.110.0
  - @cat-factory/orchestration@0.165.0
  - @cat-factory/agents@0.84.1
  - @cat-factory/prompt-fragments@0.15.15
  - @cat-factory/spend@0.12.117

## 0.173.0

### Minor Changes

- e087b40: Let a workspace rewrite any agent's system prompt from the pipeline builder, and switch back
  through every version it has run.

  The store is an append-only revision log per `(workspace, agent kind)` — the highest revision is
  live — so restoring an older prompt appends a copy of it rather than overwriting, and "back to the
  built-in" is itself a recorded revision (a null text) that keeps the workspace tracking the shipped
  prompt as it improves instead of pinning a stale copy. The composite key doubles as the concurrency
  control: a second editor's save collides and is refused as `prompt_revision_conflict` rather than
  silently winning last-write.

  An override replaces the shipped TRACK prompt only. `systemPromptFor` gained an optional `override`
  argument and still layers the engine-enforced surface directives and trait guidance on top, so a
  workspace cannot edit away the read-only guardrail or the answer-in-your-reply rule. Holding that
  takes two mechanisms, because an invariant reaches a shipped prompt by two routes and only one of
  them survives having the track prompt replaced: `restoreShippedInvariants` puts back a rule a
  built-in track prompt carried INLINE (without it, editing any kind whose deliverable is its reply —
  spec-writer, the testers, the reviewers — silently drops the answer-in-your-reply rule and the run
  fails on an empty visible reply), and `BESPOKE_CONTAINER_SYSTEM_PROMPTS` declares `merger` /
  `on-call` as a `{ role, directives }` pair since those two bypass `systemPromptFor` entirely. The
  editor SHOWS the resulting appended text (`AgentPromptDetail.appendedText`, measured from the real
  composition) rather than describing it, so the promise is checkable rather than taken on trust.

  The engine resolves the live revision once per dispatch onto
  `AgentRunContext.systemPromptOverride` and pins it to `PipelineStep.promptRevision`, which Kaizen
  folds into its `(prompt, agent, model)` combo key — an edited prompt is its own combo rather than
  inheriting a verification the shipped one earned.

  New: the `agent_prompt_revisions` table (D1 migration 0068 ⇄ Drizzle), the `AgentPromptRepository`
  kernel port (remote-bucket for mothership mode), `GET|PUT /workspaces/:ws/agent-prompts[/:agentKind]`
  gated on `settings.manage`, and the `prompt_revision_conflict` conflict reason.

  The Sandbox is the other half of this feature and is now wired to it in both directions. A
  workspace's own prompts are projected into the prompt browser as read-only `workspace` versions
  (synthesized per request from the revision log, with the live one marked), so an experiment can
  measure a candidate against the prompt that is actually running rather than only against what the
  product ships — previously the only control on offer, and silently the wrong one on any workspace
  that had edited a kind. And a version can be PROMOTED to the live prompt:
  `POST /agent-prompts/:kind/promote`, deliberately on the prompt controller so it answers to
  `settings.manage` rather than the sandbox's `integrations.manage`.

  Behaviour change worth knowing: a stored sandbox `systemText` is now the BASE (track) prompt, and
  `SandboxRunService` composes the platform's directives on top at run time through the same
  `systemPromptFor` override path production uses. Previously it sent the stored text raw, so it
  graded a prompt that is never what gets sent — tolerable while the sandbox was a closed loop, and
  not tolerable once a graded candidate can become the live prompt. Existing candidates keep their
  text; their grades shift, because they are now measured on the composed prompt.

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0
  - @cat-factory/agents@0.84.0
  - @cat-factory/orchestration@0.164.0
  - @cat-factory/integrations@0.109.6
  - @cat-factory/prompt-fragments@0.15.14
  - @cat-factory/spend@0.12.116

## 0.172.2

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/orchestration@0.163.1
  - @cat-factory/agents@0.83.1
  - @cat-factory/integrations@0.109.5
  - @cat-factory/kernel@0.185.1
  - @cat-factory/prompt-fragments@0.15.13
  - @cat-factory/spend@0.12.115

## 0.172.1

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/orchestration@0.163.0
  - @cat-factory/kernel@0.185.0
  - @cat-factory/agents@0.83.0
  - @cat-factory/integrations@0.109.4
  - @cat-factory/spend@0.12.114

## 0.172.0

### Minor Changes

- 8251a99: Give every request and every container job a correlation id.

  Both facades now mount a shared request middleware as their FIRST middleware — ahead of CORS and
  the per-request container build, so a CORS denial and the Worker's misconfiguration fallback are
  covered too. It adopts a bounded, safe `X-Request-Id` from the caller or mints one, echoes it on
  the response, puts it in **every error envelope**, binds `{ requestId, method, path }` on a
  request-scoped child logger, and emits one line per request: `info` on success, `warn` on a 4xx
  (naming the mapped error code), `error` on a 5xx. Previously only unexpected 500s were logged at
  all, so a 4xx spike — a validation regression, an RBAC denial, a conflict loop — left no
  server-side trace and a user report had nothing to join against. `/health` and `/ready` drop to
  `debug` when they succeed, so an orchestrator's probes don't bury the request stream.

  `X-Request-Id` is allow-listed inbound (so a caller that already has an id propagates it rather
  than the backend minting a second one for the same request) and newly EXPOSED outbound, so a
  browser can read it off the response.

  The **misconfiguration fallback backend** is covered on every facade. The Worker inherits the
  middleware because it serves the fallback from inside `createApp`, but Node/local swap in the
  whole `createMisconfiguredApp` — so that app mounts it itself, or the one deployment shape an
  operator is actively debugging is the only one serving requests with no id and no request line.

  Across the workflow↔container seam, `workspaceId` and `executionId` now ride the agent job body
  and the harness binds them onto its per-job logger beside `jobId` — the two halves of a run
  previously shared no id and were stitched only by a job-id naming convention. This covers EVERY
  dispatcher of the `agent` kind, not just the execution path: `ContainerRepoBootstrapper` and
  `ContainerEnvConfigRepairer` hand-build their bodies, and a bootstrap is a first-class agent run
  (same table, same retry surface), so leaving them out would have left their containers' logs
  joinable to nothing. Neither has a separate execution row, so the job id doubles as the run id.

  `ContainerAgentExecutor` gained a bound logger and logs the seam's transitions (dispatched /
  dispatch-failed / poll-failed / running at `debug` / settled). A dispatch OR poll that throws is
  now reported: those are the failure classes nothing downstream can account for, because the job
  either never gets a handle or the transport fault is recorded against no job at all.

  Only the request PATHNAME is ever logged, never the raw URL, and a client-supplied id is refused
  unless it is short and `[\w\-=]+` — both are untrusted text going straight into a log stream, and
  query strings carry the WebSocket `?ticket=` and OAuth `?code=`. An unexpected fault's STACK is
  scrubbed with `redactSecrets` in its own right, not just its message: a stack's first line is
  `Error: <message>` verbatim, so attaching it raw beside the scrubbed `err` would republish
  exactly what the scrub just removed.

## 0.171.0

### Minor Changes

- f0be8a7: Retire the three shapes that let phase 2's defects happen, without changing behaviour.

  Both durable drivers now fail a run through one shared `RunFailure` value
  (`failureFromAdvanceError` / `failureFromResult` / `failureFromDriver`) instead of positional
  arguments each assembles itself. Every one of those parameters carried a default, so a driver
  that stopped short still compiled and recorded `null` — which is how the Cloudflare driver came
  to drop `AgentFailure.reason` on every path while its runtime-neutral twin forwarded it. An
  omitted field is now a typecheck failure.

  Controllers guard through two shared total accessors, `requireCapability` and `requireUser`
  (`@cat-factory/server`'s `http/guards.ts`, the siblings of `param()`, and exported from the
  package root alongside `param`). The per-controller `requireX(c): Module | null` forced every
  route to restate `if (!x) return unavailable()`, and 51 controllers had each declared their own
  copy of the thrower to satisfy it; making the accessor total deletes the guard line at ~300 call
  sites. Each has an `assert*` twin for a route that needs a capability wired but reads nothing off
  it, so the guard never reads as a discardable no-op statement.

  `createStoreAgentContextGate` moves to `@cat-factory/kernel` (`StoreAgentContextGate`) and is
  now the single implementation of the per-workspace body-capture rule, shared by the proxied
  (`LlmObservabilityService`) and inline (`InstrumentedModelProvider`) paths. Phase 2 gave the
  inline path a gate but wrote the rule a second time in a second package, leaving the two free to
  drift apart exactly as they had.

  Breaking (pre-1.0, no migration): `createStoreAgentContextGate` is no longer exported from
  `@cat-factory/server` — import it from `@cat-factory/kernel`. Its dependency shape is unchanged.

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0
  - @cat-factory/agents@0.82.4
  - @cat-factory/orchestration@0.162.0
  - @cat-factory/integrations@0.109.3
  - @cat-factory/spend@0.12.113

## 0.170.1

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0
  - @cat-factory/orchestration@0.161.0
  - @cat-factory/agents@0.82.3
  - @cat-factory/integrations@0.109.2
  - @cat-factory/prompt-fragments@0.15.12
  - @cat-factory/spend@0.12.112

## 0.170.0

### Minor Changes

- ac832b9: Add a read-only remote run-debugging API (`/api/v1/debug/*`) so an agent outside the browser can
  diagnose a run: a keyset-paginated run index, a per-run overview (steps, per-sink availability +
  counts, SQL-aggregated LLM rollups, precomputed diagnostic signals), and bounded drill-downs into
  the run's model calls, agent-context dispatches, performed web searches and provisioning event log.

  Bodies are opt-in and byte-budgeted, sliced in SQL so an un-previewed page reads no body bytes at
  all, and every truncation reports what it left out. The surface needs only a `read`-scope public API
  key.

  Root-causing is server-side work, not client-side paging: the LLM-call list takes a `?contains=`
  body search (SQL LIKE/ILIKE, case-insensitive, wildcards literal) whose matched rows report a
  per-body `matchOffset`; point reads take `?bodyOffset=` so the middle and tail of a large body are
  reachable (every body slice now also states its `offset`); the call point read's `?view=messages`
  parses the stored prompt delta into per-message rows with independent budgets; and the overview
  gains a `failure_outside_model_calls` signal pointing a failed-run-with-clean-calls investigation
  at tool execution, which records no calls of its own.

  Spend is attributable, not just countable: every call row carries the `phase` that spent it (the
  agent's own edit loop, a pre-PR validation repair round, a reproduction-proof repair round, …) and
  its `turnIndex` within that job, and `?phase=` narrows the page in SQL like `?agentKind=` does. So
  "the pipeline did work this task never needed" is one request rather than a client-side grouping over
  the whole run. The EMPTY phase is a queryable value, not "no filter" — it selects the unattributed
  slice (an older harness image, an inline call, the un-phased proxy path), which is otherwise
  unreachable; and `turnIndex` stays `null` rather than 0 where the producing channel has no turn
  concept, so a proxied call is never faked into "the first turn".

  All four bounded reads land in the local `node:sqlite` telemetry store too, so the surface works
  unchanged in mothership mode, where telemetry is local-first and these pages never cross the machine
  RPC (routing a page over a long run would be exactly the bulk read that bucket exists to forbid).

  Compatibility break: `ProvisioningLogQuery.before` (a bare `createdAt` keyset) is replaced by a
  composite `cursor: { createdAt, id }`, and the matching `?before=` query param is removed from
  `GET /workspaces/:ws/provisioning-logs` (the SPA never sent it). The old form dropped rows sharing
  a millisecond between pages, which is the common case for a log written in bursts.

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0
  - @cat-factory/orchestration@0.160.0
  - @cat-factory/agents@0.82.2
  - @cat-factory/integrations@0.109.1
  - @cat-factory/prompt-fragments@0.15.11
  - @cat-factory/spend@0.12.111

## 0.169.0

### Minor Changes

- 22d82ac: Autodetect pre-PR validation checks from a service's repository.

  The service inspector's pre-PR validation panel gains a "Detect" button backed by
  `GET /workspaces/:ws/services/:blockId/validation-checks/detect`. It reads the repo root
  through the existing checkout-free `RepoFiles` seam and suggests check commands from what
  the repo declares — npm/composer scripts, Make/just/Task targets, and the tool configs
  checked in beside them — across node, python, go, rust, maven, gradle, dotnet, ruby, php,
  elixir and the three generic task runners.

  The endpoint writes nothing: suggestions land in the panel's unsaved rows and the operator
  saves them as before, so an unconfigured service still behaves exactly as it did.

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0
  - @cat-factory/integrations@0.109.0
  - @cat-factory/agents@0.82.1
  - @cat-factory/orchestration@0.159.2
  - @cat-factory/prompt-fragments@0.15.10
  - @cat-factory/spend@0.12.110

## 0.168.0

### Minor Changes

- e18cfa2: Error identity now survives the trip from where a failure happens to where a user reads it.

  A run that dies on a thrown error carries that error's machine-readable `details.reason` onto
  its `AgentFailure` on both runtimes — previously the Cloudflare driver dropped `reason` on every
  path (and the container post-mortem `detail` on evictions), so the SPA's remedies could never
  fire in production. The wire vocabulary gains `UnavailableError` (503), `UnauthorizedError`
  (401) and `RateLimitedError` (429), and the 113 hand-rolled error envelopes across the HTTP
  layer are migrated onto it, so a 503/401/429 can now carry a `reason` code at all.

  Breaking (pre-1.0, no migration): `POST /signup` now answers 409 (`conflict`) for an
  already-registered email and 422 (`validation`) for a rejected password, instead of flattening
  both onto 400. The LLM proxy no longer returns the raw upstream exception text on a failed
  in-process call, and every proxy error envelope now carries a `code`.

  Privacy fix: inline (non-proxied) LLM calls now honour the per-workspace `storeAgentContext`
  opt-out before shipping prompt/response bodies to an external trace sink, matching the proxied
  path. A workspace that had opted out was still exporting its inline bodies to Langfuse/OTel.

- 01d4b6c: Add `ExecutionRepository.countActiveByWorkspace`, the SQL-COUNT capacity read run admission
  control checks in front of the durable driver. It counts the same live set `listLive` projects
  (`running`/`blocked`/`paused`, scoped to `kind = 'execution'`) over the same
  `(workspace_id, kind, status)` index, so no rows cross the wire and none are reduced in JS. Also
  allow-listed on the machine persistence RPC, since the read sits on the run-start path.

  Both reads now share the new exported `LIVE_EXECUTION_STATUSES` constant on both runtimes, so the
  capacity count and the live projection cannot drift apart into a cap checked against a set the
  board disagrees with. `insertLive`'s conflict/cleanup predicates deliberately keep their literals:
  they mirror the frozen `uniq_live_execution_per_block` index, which is a different invariant.

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0
  - @cat-factory/agents@0.82.0
  - @cat-factory/orchestration@0.159.1
  - @cat-factory/integrations@0.108.1
  - @cat-factory/spend@0.12.109

## 0.167.0

### Minor Changes

- b75a08a: Stamp every `llm_call_metrics` row with the run PHASE that spent it and its TURN ordinal, so a
  run's token burn can be attributed to the slice that caused it — the agent's own edit loop, a
  pre-PR validation repair round, a reproduction-proof repair round — instead of piling into one
  figure per agent kind (token-burn instrumentation, slice 2).

  The phase comes from whoever owns the boundary, never from a downstream guess: the harness's job
  registry stamps it on each streamed call as it is emitted, and the Pi path — whose calls are
  metered server-side by the proxy — carries it on the URL Pi is pointed at
  (`${proxyBaseUrl}/phase/<phase>`, rewritten per pass), since Pi makes those requests from a config
  with no per-request header to set. The proxy therefore serves completions on a second, optional
  phase-tagged path; the plain path is unchanged and its calls are recorded as unattributed.

  The backend advertises that route on the job body (`proxyPhasePath`, the same shape as
  `webSearch`) and the harness tags the URL only when told, so an image paired with an older backend
  — a runner pool pins its own harness image, and `LOCAL_HARNESS_IMAGE` overrides the recommended
  pin — falls back to the plain path instead of posting every model call to a 404.

  `LlmCallMetric` gains `phase: string` (`''` = unattributed, a real slice of the rollup rather
  than a dropped row) and `turnIndex: number | null` (the harness's job-scoped `seq`; NULL where the
  producing channel has no turn concept, so a proxied call is never faked into "turn 0").
  `HarnessCallMetric` gains an optional `phase`, read leniently off a runner pool's envelope.
  Both telemetry stores gain the two columns (D1 `0004_llm_call_phase_turn` ⇄ a Drizzle migration);
  existing rows keep the unattributed default and are not backfilled — the table is pruned to a
  3-day window, so they churn out on their own.

- 56128e2: Mothership mode: telemetry is now local-first, so a mothership-mode run finally produces the
  observability it is supposed to.

  Previously the five telemetry repositories resolved to the remote registry, where none of their
  methods is (or should be) allow-listed: every write came back `unknown_method` — swallowed by the
  best-effort recorders — and every read came back empty, so the observability panel, the per-step
  token rollups, the web-search log and the provisioning "View logs" surfaces were blank on a
  mothership-mode node with nothing failing anywhere.

  A mothership-mode node now writes and reads its per-call LLM metrics, agent-context snapshots,
  performed web searches, provisioning log and modeled subscription quota cycles in its own
  `node:sqlite` telemetry store (`telemetry.sqlite`, override `LOCAL_MOTHERSHIP_TELEMETRY_DB`), and
  prunes it to the deployment's configured retention windows. The bucket is composed into the
  repository registry once (`createRemoteRepositoryRegistry`'s new `localFirst` map), so every
  consumer resolves it with no per-consumer wiring.

  Two boundary changes ride with it:

  - `tokenUsageRepository.record` is now remotely callable, under a new `usageRecord` scope rule. The
    spend ledger has the telemetry write profile but is the org's budget safeguard, and the spend gate
    already reads its rollups remotely — a laptop-local ledger would leave local runs invisible to the
    budget they must answer to. The rule pins the row's denormalized `accountId`/`userId` to the
    caller, so a node cannot inflate another account's or teammate's budget.
  - `llmCallMetricRepository.summarizeByExecution` is no longer remotely callable: it was a run-path
    stopgap against the mothership's telemetry store, which holds none of a laptop's calls, so it
    could only ever report zeros for the run that produced them.

  Batch-ingesting a finished run's telemetry up to the mothership (so hosted teammates can read it,
  and it survives the local prune) is the remaining half of this initiative slice.

### Patch Changes

- Updated dependencies [b75a08a]
- Updated dependencies [3057db1]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0
  - @cat-factory/integrations@0.108.0
  - @cat-factory/orchestration@0.159.0
  - @cat-factory/agents@0.81.1
  - @cat-factory/prompt-fragments@0.15.9
  - @cat-factory/spend@0.12.108

## 0.166.2

### Patch Changes

- 9d965c9: Make linking living fragments from GitHub work from a pasted URL end to end, and explain the
  link button whenever it is inert.

  Three field-reported failures on one surface, fixed together:

  - **Pasting a full GitHub URL into the repo picker found nothing** ("no repositories found
    for <url>"): the picker's realtime search feeds the provider's tokenized name search, which a
    URL never matches. Contracts gains a pure `parseRepoWebUrl` (GitHub `tree`/`blob`/`raw` and
    GitLab `/-/` shapes, subgroups included), and `GitHubSyncService.listAvailableRepos` now
    collapses a pasted URL to its `owner/name` slug AND resolves that slug with a direct
    `getRepo` point-read merged ahead of the search results — a reachable repo resolves even when
    the provider's search misses it.
  - **Bulk-import by directory URL**: the Documents tab takes a pasted GitHub file or folder URL,
    resolves the repo by slug (no search dependency), opens the tree browser at that folder, and
    the browser's multi-file mode gains per-file checkboxes plus a select-all row — so a whole
    directory of documents can be checked and linked as living fragments in one action.
  - **"Link as living fragment" disabled with no explanation**: the button now states, beside it,
    exactly what is missing (no source chosen / no repository / no files ticked / empty ref).
  - **Account-tier repo sources failed with "No GitHub installation is available for this
    scope"** even when the repo was browsable: the account-scope resolver matched only
    `installation.accountId`, which is null for a per-workspace PAT connect and a GitHub account
    id for local PAT mode's synthetic rows. The shared `createTierInstallationResolvers`
    (`@cat-factory/agents`, wired by both facades for fragments AND skills) now falls back
    through the account's own boards, via the new `WorkspaceRepository.listByAccount` (D1 ⇄
    Drizzle, conformance-asserted, and proxied in mothership mode under the `account` scope rule).

- Updated dependencies [9d965c9]
- Updated dependencies [8a9f311]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0
  - @cat-factory/agents@0.81.0
  - @cat-factory/integrations@0.107.3
  - @cat-factory/orchestration@0.158.0
  - @cat-factory/prompt-fragments@0.15.8
  - @cat-factory/spend@0.12.107

## 0.166.1

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0
  - @cat-factory/orchestration@0.157.0
  - @cat-factory/agents@0.80.1
  - @cat-factory/integrations@0.107.2
  - @cat-factory/prompt-fragments@0.15.7
  - @cat-factory/spend@0.12.106

## 0.166.0

### Minor Changes

- 65b87c1: Agent kinds can now declare CAPABILITIES: the skills they apply (procedural playbooks — bundled in
  the deployment's own package, or referenced from the account's repo-synced catalog) and the tool
  servers they may call (MCP, stdio or HTTP). Both are registered on the same app-owned
  `AgentKindRegistry` and referenced by id from any number of kinds, or attached to a BUILT-IN kind
  with `assignSkills` / `assignToolServers`. Tool-server credentials are declared by name and
  resolved at dispatch through the new kernel `ToolSecretResolver` port (both facades wire the
  deployment-environment resolver by default), so a value never reaches a prompt or the run's
  telemetry snapshot. See `backend/docs/adr/0029-agent-kind-capabilities.md`.

  BREAKING (pre-1.0, no migration): `AgentRunContext.skill` is now `skills` (an array),
  `PipelineStep.skillVersion` is now `skillVersions`, and the harness job body's `skill` field is now
  `skills` alongside the new `mcpServers`.

  OPERATORS — self-hosted runner pools must be moved to the `1.67.0` harness image. A pool still
  running an older image parses the job body with the old singular `skill` field, so the new
  `skills` array is dropped on the floor. On Pi/codex that degrades quietly (their prompt still
  carries the folded-in instructions), but a leased-credential claude-code run is told in its prompt
  that the skill "is installed for this step" while nothing was installed — a blind run rather than a
  failed one. `mcpServers` is dropped the same way, which surfaces as an agent that was promised
  tools it does not have.

  SECURITY NOTE for a deployment that installs agent packages it did not author: a tool-server
  definition names both the credential it wants and the endpoint it talks to, and the default
  `createEnvToolSecretResolver` will resolve any key off the deployment environment. On the Worker
  that is a real widening (`env` is not otherwise ambient to a registration). Pass
  `createEnvToolSecretResolver(env, { allowKeys: [...] })` to confine it.

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/orchestration@0.156.0
  - @cat-factory/contracts@0.183.0
  - @cat-factory/agents@0.80.0
  - @cat-factory/kernel@0.176.0
  - @cat-factory/integrations@0.107.1
  - @cat-factory/prompt-fragments@0.15.6
  - @cat-factory/spend@0.12.105

## 0.165.0

### Minor Changes

- b30cc6e: Make the three LLM input-token classes orthogonal in telemetry: `promptTokens` is now FRESH
  (uncached) input only, with `cacheReadTokens` and `cacheWriteTokens` carried beside it, so total
  input is their sum. A cache read is priced ~0.1x base input and a cache write 1.25-2x, so the old
  lumped `cachedPromptTokens` made a run re-writing its prefix every turn indistinguishable from one
  riding a warm cache.

  BREAKING (telemetry only, no migration path by design): `cachedPromptTokens` is dropped from
  `llmCallMetricSchema`, `llmCallActivitySchema`, `stepMetricsSchema` and the metrics export, and
  `cached_prompt_tokens` is dropped from both telemetry stores. `HarnessCallMetric.cachedInputTokens`
  becomes `cacheReadTokens` + `cacheWriteTokens`, and `inlineResult.usage` gains the same split.
  `llm_call_metrics` is pruned to a 3-day window, so rows carrying the old inclusive `prompt_tokens`
  semantics churn out on their own; `cacheHitRate` is now `(read + write) / (fresh + read + write)`
  and no longer needs its clamp. `cachedTokensFromUsage` is replaced by `readInputTokenClasses`,
  which returns all three classes from one usage payload (reconciling the inclusive and exclusive
  provider shapes internally, so no caller has to know which it is holding), and
  `ProxyCallObservation.cachedPromptTokens` becomes `inputTokens: InputTokenClasses`.

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0
  - @cat-factory/agents@0.79.0
  - @cat-factory/integrations@0.107.0
  - @cat-factory/orchestration@0.155.0
  - @cat-factory/prompt-fragments@0.15.5
  - @cat-factory/spend@0.12.104

## 0.164.0

### Minor Changes

- c47eb66: Confine every GitHub issue search to one repository, and refuse an unscoped one.

  `/search/issues` carries no scope of its own: a query with no `repo:` qualifier returns whatever
  the credential can reach. Under a GitHub App installation token that is the installation's own
  repos, so an unscoped query looked harmless — but under a PAT (local mode, and any per-workspace
  PAT connection) the same query searches every public repository on GitHub, and the issue picker
  offered strangers' issues as if they were the service's own. The repo scope is now required by
  construction rather than supplied by each caller: `buildGitHubIssueSearchQuery` takes a mandatory
  scope, `GitHubIssuesProvider.search` refuses a call without one, and the search endpoint's
  `blockId` is a required field. `buildGitHubIntakeQuery` gets the same treatment — a `bug-intake`
  schedule with no repository configured now fails its fire loudly instead of scanning all of public
  GitHub and importing whatever it found.

  The kernel port carries that requirement: `TaskSourceProvider.search`'s `scope` is now a REQUIRED
  parameter with a NULLABLE value (`TaskSearchRepoScope | null`). A repo-less source (Jira, Linear)
  states its `null`; a caller can no longer reach an unscoped search by omitting the argument, which
  is a typecheck failure. Repo-less provider implementations are unchanged — they declare fewer
  parameters.

  A reference naming ANOTHER repository is no longer resolved into the results either, so search
  results are exactly the service's own issues. Linking such an issue still works: paste its URL and
  the picker's "attach by reference" row imports it directly, which never rode the search path. A
  reference that DOES name the scoped repo is now normalised to the scope's casing before it becomes
  an external id: GitHub lookup is case-insensitive but an external id is stored verbatim, so
  `Owner/Repo#1` and `owner/repo#1` used to import as two projection rows for one issue.

  The `reason` codes these refusals carry are declared in `@cat-factory/contracts`
  (`TASK_SOURCE_READ_REASONS`) and imported by both the emit sites and the SPA, so renaming one
  fails the typecheck instead of silently degrading the SPA to the backend's untranslated prose.
  `boards_unsupported`, which the bug hunt already relied on as a bare literal on both sides, joins
  the same union.

  Wire break (pre-1.0, no migration): `POST /workspaces/:ws/task-sources/:source/search` now requires
  `blockId`, and a search from a service frame with no linked repository is refused with
  `reason: 'repo_not_linked'` rather than silently widened.

### Patch Changes

- 5abcb9e: Drain the remaining silent promise drops in the backend and stop them regrowing. Every
  `.catch(() => {})` in `backend/packages` and `backend/runtimes` now goes through
  `runBestEffort`, so a swallowed failure leaves one `warn` naming the operation with its cause
  attached, and `scripts/check-silent-catch.mjs` fails CI on a new one (a drop that genuinely needs
  no report annotates itself with `// silent-catch-ok: <reason>`). The guard counts every spelling
  of an empty handler, including a body holding only a comment — which caught two further drops:
  the mothership event relay (`HttpMachineEventClient.publish`, which additionally now treats a
  REFUSED publish as a failure rather than a delivery, so an expired machine token stops reading as
  success) and the web-search query recorder.

  `RepoOpContext` gains a required `logger`, which closes the spec-promotion hole: a tester run that
  verified requirements but promoted none used to be indistinguishable from one that had nothing to
  promote. `RunDispatcher`, `DeployerStepController` and `InitiativeLoopService` gain the logger they
  previously had no way to report through — so an issue-writeback drop, a leaked provisioning lease
  and a permanently-failing initiative tick are all visible now. `ExecutionWorkflow` binds its run
  correlation once with `logger.child` and scrubs its poll-failure causes with `redactSecrets`.

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/integrations@0.106.0
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0
  - @cat-factory/agents@0.78.0
  - @cat-factory/orchestration@0.154.0
  - @cat-factory/prompt-fragments@0.15.4
  - @cat-factory/spend@0.12.103

## 0.163.2

### Patch Changes

- bead6df: Stop two ways a run could sit wedged with nothing left to move it.

  A self-hosted runner pool that lost a job now says so. A poll that 404s (or 410s), and a scheduler
  status that names a reclaimed runner (`evicted` / `preempted` / `oomkilled` / `node_lost` / …), are
  read as the RUNNER going away rather than the job failing, so the step is re-dispatched instead of
  burning the run's whole ~70-minute poll budget and dying `timeout`. A job-level failure vocabulary
  (`error` / `cancelled` / `timeout` / …) and a success vocabulary (`completed` / `succeeded` / …)
  likewise end the poll loop honestly; a status word that matches nothing still keeps the driver
  waiting, since wrongly killing a live run is the worse mistake. A pool is asked to route stickily
  by job id, so an eviction recovery now dispatches under a FRESH id (as the deploy path already
  did) — reusing it would have routed the retry back to the job whose runner just died, making the
  recovery a no-op for pool-backed runs.

  A manifest that defines no `release` template — or no status path — reports the gap on its
  connection test in Settings, and logs it once at registration. Each gap crosses the wire as a
  code, so the SPA renders translated copy rather than backend prose.

  The merge-review and pipeline-complete notifications are now raised BEFORE the block flips to
  `pr_ready`. Raising second meant that if the card failed to raise, the run failed but the task was
  already sitting in `pr_ready` with an empty inbox: a PR-ready task with no review action and
  nothing to re-drive it.

  Breaking for anyone importing them directly: `runnersLogic.mapJobState` is replaced by
  `runnersLogic.classifyJobStatus`, which returns `{ state, evicted? }`;
  `runnersLogic.manifestWarnings` and `RunnerBackendProvider.warnings` return
  `{ code, message }` objects rather than strings. The `(container evicted or crashed)` wording every
  transport had copied is now kernel's `CONTAINER_EVICTION_ERROR`.

- Updated dependencies [bead6df]
  - @cat-factory/integrations@0.105.0
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0
  - @cat-factory/orchestration@0.153.1
  - @cat-factory/agents@0.77.1
  - @cat-factory/prompt-fragments@0.15.3
  - @cat-factory/spend@0.12.102

## 0.163.1

### Patch Changes

- Updated dependencies [a04f609]
  - @cat-factory/agents@0.77.0
  - @cat-factory/orchestration@0.153.0

## 0.163.0

### Minor Changes

- 68f0edd: Add the Bug hunt: pick a connected tracker and one of its boards, get its open and unassigned bugs
  rated on impact against implementation complexity, and confirm one candidate to adopt it as a bug
  task running the standard bug-fix pipeline. The interactive counterpart of the recurring bug-triage
  schedule; it persists nothing of its own.
- 6dbd864: Introduce a central, pino-backed structured logger behind a kernel `Logger` port, so the whole
  domain engine can log — previously only `@cat-factory/server` and the runtime facades could, which
  forced the domain packages to swallow failures silently.

  - **New**: `Logger` / `noopLogger` / `createRecordingLogger` (`@cat-factory/kernel`,
    `ports/logging.ts`), and `runBestEffort` / `describeError` (`shared/best-effort.ts`) as the
    replacement for `.catch(() => {})`. `@cat-factory/server` exports `createPinoLogger`,
    `parseLogLevel`, `setLogLevel` and `getLogLevel` alongside the process-wide `logger`.
  - **`LOG_LEVEL`** is now honoured (`process.env` on Node/local, a wrangler var on the Worker);
    it was previously read from a global nothing ever assigned.
  - **Node/local** register `unhandledRejection`/`uncaughtException` guards and subscribe to
    pg-boss's `error` event (an unhandled one on an EventEmitter throws). The guards add the
    structured line only — both still exit non-zero, matching what Node already did (since Node 15
    an unhandled rejection is raised as an uncaught exception), so process lifetime is unchanged.

  **Breaking (pre-1.0, no shims):**

  - The logger's calling convention is now **message-first**: `logger.warn(msg, fields)`, not pino's
    `logger.warn(fields, msg)`. `Logger` is the kernel port type, no longer pino's own.
  - Every ad-hoc logger interface is **removed**, not deprecated: `PrReportLogger`,
    `PlatformMetricsSweepLogger`, `GitHubDocsLogger`, `OtelLogger`, `OtlpLogger`, `LangfuseLogger`,
    `ResetLogger`, `InfraSetupLogger`, `PlatformHealthSweepLogger`, `KeyFingerprintLogger`,
    `GateWiringLogger`, `DriveLogger`, `PropagatorLogger`. Every `logger?:` dependency now takes the
    kernel `Logger`.
  - `@cat-factory/node-server` no longer exports `pinoKeyFingerprintLogger` (the shapes match, so the
    bridge is gone). `@cat-factory/orchestration`'s `Core` gains a required `logger`.
  - **`CoreDependencies.logger` is REQUIRED**, not optional. A facade or harness assembling the bag
    by hand must pass one (`noopLogger` if it does not care) or it will not typecheck — the guard
    that would have caught the Worker shipping with no logger wired at all.

  Also fixes `MergeTrackRecordService.classify` losing the repo identity when `listChangedFiles`
  throws, which permanently broke external-merge attribution for that record.

### Patch Changes

- Updated dependencies [71ea4ec]
- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/orchestration@0.152.0
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0
  - @cat-factory/agents@0.76.0
  - @cat-factory/integrations@0.104.0
  - @cat-factory/prompt-fragments@0.15.2
  - @cat-factory/spend@0.12.101

## 0.162.1

### Patch Changes

- Updated dependencies [3260f2d]
  - @cat-factory/agents@0.75.2
  - @cat-factory/orchestration@0.151.1

## 0.162.0

### Minor Changes

- 9d8fe9b: Close the lost-update race on the iterative-review stores (race-condition audit 2.5).

  A requirements / clarity / brainstorm review is ONE JSON blob holding every finding, and every mutation used to load it, edit one item and force-write the whole row back. Two writers inside that window — two people answering different findings, a dismissal landing inside the (slow) incorporation LLM call, the Requirement-Writer's fill pass racing a human accept — left only the last writer's edit. Because incorporation refuses to run while any finding is still `open`, a lost dismissal wedged the loop on a finding that was in fact settled.

  - **`rev` + `compareAndSwap` on all three review stores** (D1 migration `0065` ⇄ Drizzle): the conditional write lands only while the stored revision still matches the one the caller read, and never inserts, so a review a fresh run replaced can't be resurrected.
  - **Every read-modify-write routes through `mutateReview`** (load → apply → CAS, reloading and RE-APPLYING the mutation on the winner's snapshot when it loses), including the two paths that held a snapshot across an LLM call (`incorporate`, `reReview`) and all four recommendation paths.
  - **`deleteByBlock` + `upsert` is replaced by an atomic `replaceForBlock` / `replaceForBlockStage`**, a single conflict-targeted upsert against a new UNIQUE index on `(workspace_id, block_id[, stage])` (D1 migration `0066` ⇄ Drizzle, healing pre-existing duplicates before constraining). Two review runs for one block could previously interleave their delete/insert pairs and leave TWO live reviews, so the window loaded one while the parked run's decision keyed to the other. The racy delete method is removed from the port (and the mothership persistence allow-list) so it can't be reintroduced.
  - **A contended give-up throws `ReviewContendedError`** (new, a `ConflictError` subclass): a 409 for an HTTP caller, and a re-drive signal for the durable driver, whose incorporation cycle mutation carries the output of an LLM call the run has already paid for.

  Compatibility break (pre-1.0, no shim): the `RequirementReviewRepository` / `ClarityReviewRepository` / `BrainstormSessionRepository` ports drop `deleteByBlock`/`deleteByBlockStage` and gain `compareAndSwap` + `replaceForBlock`/`replaceForBlockStage`; the review wire shapes gain `rev`. Existing rows read as `rev = 0`, which is exactly what the new column defaults to. Migration `0066` DELETES duplicate live reviews for a block (keeping the newest, the one `getByBlock` already returned) before adding the constraint — the superseded duplicates were unreachable.

### Patch Changes

- Updated dependencies [15905ab]
- Updated dependencies [9d8fe9b]
  - @cat-factory/agents@0.75.1
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0
  - @cat-factory/orchestration@0.151.0
  - @cat-factory/integrations@0.103.3
  - @cat-factory/prompt-fragments@0.15.1
  - @cat-factory/spend@0.12.100

## 0.161.0

### Minor Changes

- 2ed7b50: Complete mothership-mode real-time in both directions, and fix the fan-out read that made every mothership-mode publish fail.

  - **Inbound event subscription (`GET /internal/events/subscribe/:workspaceId`).** A mothership-mode node can now RECEIVE org activity, not just publish it — a hosted teammate's run, or a peer laptop's, animates the local board live instead of waiting for a manual refresh. The mothership side is not a new fan-out: the machine-authed handshake is handed to the SAME per-workspace realtime transport the browser stream uses (`gateways.realtime.upgrade`), so a subscribed node is just another socket in the workspace's room and the Cloudflare Durable Object needed no change. Authorisation is the shared `authorizeMachineSubscribe` (machine-audience pin first, then capability, then the workspace → account scope with a uniform 404), reached by the Worker through the shared controller and by Node from its HTTP-server `upgrade` listener — the same split, and the same reason, as the browser stream's `?ticket=`.
  - **Demand-driven on the laptop.** `MothershipEventSubscriber` holds one upstream stream per workspace with at least one local subscriber, driven by a new room-transition seam on `NodeRealtimeHub`; an idle node holds none, and it never needs to enumerate the org's workspaces. Inbound events are broadcast to the bare hub (never back through the layered propagator, which would re-publish them upstream), and the node's stable `?cid=` is now stamped as the outbound publish's `originConnectionId` — replacing the originating tab's id, which means nothing on the mothership — so a node's own events are not fanned back down to it.
  - **The subscription keeps itself honest.** Liveness is client-driven because the two mothership runtimes disagree about who provides it: a Node mothership pings at the protocol level and reaps a dead socket, while a Cloudflare mothership's hibernating Durable Object never pings — so a half-open socket there would never fire `close` and the workspace would stay dark indefinitely while the node still believed it was subscribed. The subscriber therefore heartbeats and drops a socket that has been silent past an idle deadline, treating any inbound frame (its `"ping"` auto-answered at the Cloudflare edge, or Node's own protocol ping) as proof of life. A refused handshake is now reported rather than swallowed, rate-limited so an unbounded retry stays visible without flooding, and the reconnect backoff is jittered so a fleet doesn't retry in lockstep after a mothership restart.
  - **Fix: `workspaceMountRepository.listWorkspaceIdsMountingBlock` was not remotely callable.** `FanOutEventPublisher` calls it on EVERY engine event publish, and a mothership-mode node wires the same decorator, so the call came back `unknown_method`, the remote proxy threw, and the rejection propagated out of the run-state emit. It is now allow-listed under the `workspace` rule (it returns workspace ids only, and a service can only be mounted inside its own account). `blockRepository.countActiveInternal` is allow-listed alongside it, completing the headless public-API surface whose paginated reads were already remote.
  - The persistence allow-list moved into its own module (`persistence/rpc-allowlist.ts`) — same exported name and import path, but the initiative's fast-growing surface no longer shares a file with the stable protocol.

## 0.160.0

### Minor Changes

- cf2779a: Cut coder token/quota burn and fix subscription usage attribution.

  - **Two-tier best-practice fragments.** `PromptFragment` gains an optional `brief` body; a new `brief-standards` trait marks the high-turn code-writing implementer kinds (coder, fixer, ci-fixer, conflict-resolver) so their system prompt — re-sent on every turn of a long agentic loop — folds the condensed standard instead of the full body. Reviewer/planner kinds keep the full text. The brief is resolved ALONGSIDE the body it condenses and never re-looked-up by id, so a workspace/account-tier row that overrides a built-in id folds its own full body rather than the built-in's condensed text. Backward-safe: no `brief` / unmarked kind ⇒ the full body, unchanged. `brief` authored for every built-in fragment that can reach an implementer kind (node, react, design, migration).
  - **No-progress guard on the claude-code path.** The `ProgressGuard` that killed rabbit-holing Pi runs (no-edit probing, error-retry loops, web rabbit-holes) now also runs on the claude-code subscription harness, which previously had only the wall-clock watchdog. Its no-edit exploration allowance scales with the task-estimator's complexity when an estimator ran (conservative default otherwise), so it only ever catches absolute spiralling and never truncates a productively-editing run. Subagent dispatches (`Agent`/`Task`) are neutral to the no-edit bound, since the edits they make are invisible on the parent stream.
  - **Trimmed always-on prompt bloat.** The harness no longer appends its own spec-reading block (deduped — it now comes solely from the backend `spec-aware` trait, so a spec-aware Pi run stops carrying it twice); the blueprint orientation note is included only when the checkout (or, for a multi-repo run, one of its legs) actually ships `blueprints/`; and the spec-reading guidance now steers agents to the overview index and the relevant-and-adjacent shards in one line.
  - **Fix subscription token-usage attribution.** A container/subscription step's `token_usage` row recorded `provider='unknown'` / `model=''` because the durable poll path rebuilt a stripped job handle without the dispatch model. It now forwards `step.model`, so the row records the real provider + model.

### Patch Changes

- Updated dependencies [cf2779a]
- Updated dependencies [5e5d409]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/prompt-fragments@0.15.0
  - @cat-factory/agents@0.75.0
  - @cat-factory/kernel@0.170.0
  - @cat-factory/orchestration@0.150.1
  - @cat-factory/integrations@0.103.2
  - @cat-factory/spend@0.12.99

## 0.159.0

### Minor Changes

- 1947062: Add Reports: an account-scoped, admin-gated analytics view answering where the spend and the work go — spend per model and per agent kind, spend and run activity per board / service / task type, and a spend trend over a 24h/7d/30d/90d window with an optional single-board filter.

  New `GET /accounts/:accountId/reports` over the new kernel `ReportsRepository` port, implemented on both runtimes (D1 ⇄ Drizzle) and pinned by a cross-runtime conformance suite. Every breakdown is one SQL `GROUP BY` over the existing `token_usage` and `agent_runs` tables — no new table and no migration. Real metered cost is reported separately from the illustrative equivalent-API cost of flat-rate subscription usage, and a call whose run / service / task type cannot be resolved is surfaced as its own unattributed slice rather than dropped.

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0
  - @cat-factory/orchestration@0.150.0
  - @cat-factory/agents@0.74.1
  - @cat-factory/integrations@0.103.1
  - @cat-factory/prompt-fragments@0.14.24
  - @cat-factory/spend@0.12.98

## 0.158.0

### Minor Changes

- fb71506: Pipeline-opened pull requests now carry a reviewer briefing instead of the barebones dispatch-time text.

  A PR-opening coding agent is asked (via the new `PR_DESCRIPTION_GUIDANCE` appended to its system prompt) to end its run by writing a reviewer-facing description — the problem, the decisions made and alternatives rejected, what to look out for — to a `.cat-pr-description.md` sentinel at the checkout root (one per sibling repo in a multi-repo run, plus the workspace root as a fallback for the primary; an optional leading `# <title>` line sets the PR title when it is the file's only `#` heading, so an agent using `#` for its section headings does not rename the PR to "Problem"). The harness lifts it (secret-scrubbed, size-capped with a visible truncation note, managed-report markers stripped, kept out of the commit) onto the PR it opens, falling back to the dispatch-time text when the agent wrote none.

  A RESUMED run — whose PR is already open, so the create call answers 422 — now refreshes that PR's title and description in place, carrying the engine's managed verification-report region across. Only a real agent briefing refreshes; the generic fallback never does, so an edit a human made to a description is not clobbered.

  Because the briefing is model-authored text landing on a host-parsed surface, it crosses a text boundary first: the harness carries a conformity-pinned copy of kernel's `hostMarkdown`, defusing issue references, account mentions and issue-closing keywords, and closing any code fence the briefing left open (an unbalanced one would otherwise swallow the verification report appended to the same body). The briefing's size budget leaves that report room under the host's body limit.

  The dispatch-time fallback (`prBody`) is itself restructured as a briefing: the task, the human-chosen implementation approach with rejected alternatives when the fork-decision phase ran, and an explicit marker that no agent briefing exists — with each untrusted hole rendered through `hostMarkdown`.

### Patch Changes

- Updated dependencies [fb71506]
  - @cat-factory/agents@0.74.0
  - @cat-factory/orchestration@0.149.2

## 0.157.3

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0
  - @cat-factory/integrations@0.103.0
  - @cat-factory/agents@0.73.2
  - @cat-factory/orchestration@0.149.1
  - @cat-factory/prompt-fragments@0.14.23
  - @cat-factory/spend@0.12.97

## 0.157.2

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/orchestration@0.149.0
  - @cat-factory/agents@0.73.1
  - @cat-factory/integrations@0.102.2
  - @cat-factory/kernel@0.167.1
  - @cat-factory/prompt-fragments@0.14.22
  - @cat-factory/spend@0.12.96

## 0.157.1

### Patch Changes

- cab85c5: Add an implementation-state axis to the in-repo `spec/`, and a requirement → evidence section on the PR verification report.

  **Implementation state.** `requirementItemSchema` gains `state: 'aspirational' | 'established'`
  (default `aspirational`). Until now `spec/` could say what must be TRUE but not what is true
  YET, so an agreed-but-unbuilt requirement entered every build prompt as standing behaviour and
  drew a spurious `not_met` from the tester on unrelated runs. The group markdown now renders the
  two halves under headings that say what each means, and the Gherkin render tags aspirational
  scenarios `@aspirational` so a runner can skip them.

  **Promotion is mechanical.** A tester's first OBSERVED pass flips a requirement to
  `established`, via a deterministic post-op over the checkout-free `RepoFiles` port — not a model
  decision and not a side table. It is idempotent by content, so a replayed durable step commits
  nothing, and it only ever rewrites a group shard that round-tripped byte-for-byte: promotion
  flips a field, it never restructures the tree or drops a requirement the salvaging read could
  not reproduce. It lands on the run's PR branch, or on the base branch when the pipeline opens no
  PR.

  **Requirement → evidence.** The tester now reports `requirementVerdicts` keyed by the SPEC's own
  requirement ids (surfaced as a `# requirement: <id>` comment on each scenario), and the PR
  verification report joins them back to `spec/` to render a per-requirement table. Verdicts are
  three-valued — `met` / `not_met` / `not_covered` — so "we didn't check" and "it's broken" never
  read the same. The join reads EVERY tester step, matching what promotion does.

  BREAKING (wire): `PR_VERIFICATION_REPORT_VERSION` is bumped to `2` — the report JSON gains a
  required `requirements` section. Per the repo's pre-1.0 policy there is no compatibility shim; an
  external consumer of the machine-readable block should re-read the schema.

  Also moves `readServiceSpec` from `@cat-factory/server` to `@cat-factory/agents` (it is now read
  by three layers, and server sits above two of them) and brings the `spec-writer` system prompt
  under `PROMPT_VERSIONS`; the `build` prompt is bumped to v5.

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/agents@0.73.0
  - @cat-factory/kernel@0.167.0
  - @cat-factory/orchestration@0.148.0
  - @cat-factory/integrations@0.102.1
  - @cat-factory/prompt-fragments@0.14.21
  - @cat-factory/spend@0.12.95

## 0.157.0

### Minor Changes

- 8afa4ae: Inbound tracker webhooks: push-driven issue intake, and answering a parked requirements review
  from the ticket.

  Two asymmetries in the task-source layer close together, because they share a transport.

  **1. Intake was pull-only.** An issue entered the system when a recurring `bug-intake` schedule
  fired or a human imported it, so intake latency was the schedule interval and every idle poll cost
  a tracker API call. A new receiver — `POST /webhooks/tasks/:source/:workspaceId` — copies the
  GitHub VCS webhook path step for step: verify HMAC over the RAW body before any parse, ack 202
  fast, hand the parsed event to the facade's queue (a Cloudflare Queue on the Worker ⇄ the pg-boss
  `tracker.sync` queue on Node), and fall back to inline handling when neither is bound.

  **2. The question loop was half-duplex.** `postReviewQuestions` already posted a parked review's
  findings onto the linked issue, each with its stable id — but answers could only arrive in-app or
  over `/api/v1/runs/:runId/decisions`, so a reporter who lives in Jira had to switch surfaces.
  Those ids were designed for exactly this reply path; it is now built. This completes slice 2b of
  `docs/initiatives/headless-clarification-loop.md`.

  **A qualifying issue event FIRES the matching schedule; it does not re-implement intake.** The
  tempting shape — "the event names an issue, so import and link it" — forks a second intake path
  that would drift from `BugIntakeService`'s predicate handling, batched dedup, replace-link, pickup
  mark and block seeding. Instead a pure `issueEventMatchesIntake` predicate decides whether the
  event qualifies for a schedule's `issueIntake` config, and a match calls the same `fire` the cron
  sweeper calls. Consequences, all deliberate: the fired run may pick a **different, older** issue
  than the one that triggered it (intake is oldest-first fair queueing — the webhook drains the queue
  promptly, it does not reorder it); overlap protection is inherited, so a burst of deliveries cannot
  start a second run over a parked one; and the trigger is **non-forced**, so an on-demand schedule is
  never webhook-fired and an individual-usage model still refuses — `force` is the human run-now lever
  and a webhook has no human present. The predicate deliberately **fails open** on a field the payload
  omits: a false positive costs one no-op run, a false negative costs silent intake latency.

  **The recurring schedule is unchanged and stays on** as the reconciliation sweep for missed
  deliveries — the same webhook + sweeper duality as GitHub sync + `sweepStuckRuns`. Push is the fast
  path, never the only path.

  **Ticket replies use an explicit grammar, never natural-language guessing:**

  ```
  @cat-factory answer <itemId> <free text to end of line>
  @cat-factory dismiss <itemId>
  @cat-factory proceed | stop | extra-round
  ```

  Only lines whose first token is the trigger are interpreted, so a human can answer and discuss in
  one comment; an `answer` continues onto following lines until the next trigger. A comment with no
  trigger line is ignored entirely. Every mutation routes through the SAME service methods the SPA
  and `PublicDecisionController` call (`RequirementReviewService.replyToItem` / `setItemStatus`, then
  `executionService.requirementsReview.{incorporate,proceed,resolveExceeded}`), so the park's
  CAS/approval-id arbitration and the task's merge-preset knobs apply identically — there is no
  parallel mutation path into the engine. A reply that leaves nothing open auto-incorporates, and the
  issue gets a follow-up comment naming what was applied, what is still outstanding, and what was
  rejected and why.

  **Configuration is per connection and needs no new table.** The webhook secret rides the
  connection's existing sealed credential bag, managed through
  `GET|POST|PATCH|DELETE /workspaces/:ws/task-sources/:source/webhook` (behind `integrations.manage`)
  and returned exactly once. `POST` mints or rotates; `PATCH` edits the reply allow-list WITHOUT
  rotating, because tightening that list is what an operator does when a tracker turns out to be more
  public than they thought and answering it with a silently rotated secret would take deliveries down
  until they re-pasted it into the vendor. The workspace rides the URL path because a tracker delivery carries no
  installation id to resolve one from, and scanning every workspace's connections for one whose
  secret verifies would be a deployment-wide N+1 on every unauthenticated POST. **An unconfigured
  secret fails closed** — an empty HMAC key is one an attacker also has.

  Reply text is untrusted third-party input, and on a public repo anyone can write it. Three layers:
  the platform's own comments are refused first — by the vendor bot flag where there is one, and by
  a structural marker check everywhere, since Linear flags no bots and the default allow-list admits
  any author (an acknowledgement that could re-enter its own ingest is an unbounded comment loop, not
  a duplicate: each carries a fresh comment id, so the ingest claim cannot stop it). Then the
  connection's optional `webhookReplyAllow` list — an
  unauthorized reply is dropped **silently**, with no follow-up, because replying would confirm the
  hook exists and hand an attacker an oracle. Reply text becomes `item.reply`, the same field the SPA
  writes, capped and `redactSecrets`-scrubbed before it persists; the grammar has no verb reaching
  outside the review. Everything rendered back crosses kernel's `hostMarkdown` boundary, exactly like
  the PR verification report.

  Idempotency is an atomic claim on a new `tracker_comment_ingests` table
  (`(workspace, source, externalId, commentId)`, D1 ⇄ Drizzle), taken **before** anything is applied
  — every tracker redelivers and every queue retries, so without it one reporter comment would answer
  the same finding twice. It copies the `review_question_posts` design verbatim, including its answer
  to "what if the claimer dies": a `failed` row is re-claimable, `applied` is terminal, and a
  `pending` one is re-claimable once abandoned. A claim that ERRORS propagates rather than being read
  as "already ingested" — the apply is idempotent precisely so the queue can retry it, and swallowing
  the error would drop a reporter's answer while reporting a successful dedup. Both stores are pinned
  by a new cross-runtime parity
  suite, alongside conformance assertions that drive the whole receiver → gateway → service chain on
  each facade.

  Providers own their vendor parsing behind a new optional `TaskSourceProvider.webhook` capability
  (Jira, Linear and GitHub Issues ship one), exactly as VCS providers own theirs; a source without it
  never receives deliveries. Design, decisions and the per-slice checklist:
  `docs/initiatives/tracker-webhook-intake.md`.

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0
  - @cat-factory/integrations@0.102.0
  - @cat-factory/orchestration@0.147.0
  - @cat-factory/agents@0.72.3
  - @cat-factory/prompt-fragments@0.14.20
  - @cat-factory/spend@0.12.94

## 0.156.2

### Patch Changes

- 200fb4d: Surface the resolved repo's `owner`/`name` on `RunRepoContext`. The run-repo seam already resolves a block's repo per-frame (on both the deployer and env-self-test paths) but only exposed `repoId` (an opaque provider id), `baseBranch`, and `provider` — it dropped the GitHub `owner`/`name` it had in hand. Code environment adapters need the repo identity to resolve a per-SERVICE target (e.g. a Kargo project, whose name IS the repo name) instead of a single static default. `RunRepoContext` now carries optional `owner`/`name` (populated by both real resolvers from the resolved `RepoTarget` / coords; optional for back-compat with older callers and test fakes).
- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1
  - @cat-factory/agents@0.72.2
  - @cat-factory/integrations@0.101.4
  - @cat-factory/orchestration@0.146.2
  - @cat-factory/spend@0.12.93

## 0.156.1

### Patch Changes

- Updated dependencies [323b6cf]
  - @cat-factory/integrations@0.101.3
  - @cat-factory/orchestration@0.146.1

## 0.156.0

### Minor Changes

- f0e9bab: Public API (`/api/v1`) Tier 2: a new `GET /jobs` list, and bounded keyset pagination + filters on
  the service-task list.

  - **`GET /api/v1/jobs`** (new, `read`-scoped) lists the workspace's headless initiative jobs,
    newest first, with `?limit=` / `?cursor=` / `?status=` / `?since=`. It closes the gap where an
    integration that lost its stored job ids — a restart, a redeploy — could never re-discover its
    own in-flight runs, since `GET /jobs/:id` needs an id it no longer has. Scoped exactly like the
    single-job read: the `internal`-anchor predicate is applied **in SQL** (a join to the anchor
    block), so an external key can never enumerate the workspace's ordinary board runs.
  - **`GET /api/v1/services/:serviceId/tasks`** gains `?limit=` / `?cursor=` / `?status=`. It was
    previously unbounded: it read the ENTIRE board and filtered the service subtree in JS, so a
    large service returned every task in one response and paid a full board read per request. The
    bound, the subtree and the status filter now all live in SQL.

  **Breaking wire change:** `GET /api/v1/services/:serviceId/tasks` now returns **at most 50 tasks
  per response** (previously: all of them) and carries a new required `nextCursor` field. A caller
  that relied on one response containing every task must now page until `nextCursor` is null.
  `GET /api/v1/jobs`'s default page is 25; both accept `?limit=` up to a hard ceiling of 100.

  Pagination is **keyset, not offset** — an external caller polls, so an offset page shifts under
  concurrent inserts and a row created between two pages either repeats or is skipped and never
  seen again. The cursor is opaque on the wire and carries the `(sortKey, id)` composite, so a burst
  of runs sharing a millisecond pages correctly instead of losing the ties. A malformed cursor is a
  `400 invalid_cursor`, never a silent re-serve of page 1.

  Job ordering is chronological (`created_at DESC`). **Task ordering is by the stable block id, not
  chronological**, and there is deliberately no `since` filter on the task list: the `blocks` table
  carries no creation timestamp, so a time filter would have to be faked. See
  `docs/initiatives/public-api-expansion.md` for what adding one would cost.

  Backed by two new repository port methods — `ExecutionRepository.listInternal` and
  `BlockRepository.listServiceTasks` — implemented on **both** the D1 and Drizzle stores and pinned
  by new cross-runtime conformance assertions, so a store that ordered differently, dropped the
  `internal` join, or mishandled the keyset fails a test rather than silently mis-serving an
  integration. Each resolves its scope in ONE query (the `internal` anchor join; the frame's modules
  as a subquery rather than a bound id list, which D1's 100-parameter ceiling would reject on a
  service with ~96 modules).

  Two adjacent fixes the lists depend on:

  - `ExecutionInstance.createdAt` is now projected from the `agent_runs.created_at` COLUMN instead of
    the run's `detail` JSON, and an insert adopts the instance's own stamp. The two used to be
    separate `clock.now()` calls milliseconds apart, so a keyset cursor minted from the entity named
    a position slightly ahead of the row it pointed at — silently skipping any run inserted in that
    window whenever two starts landed in the same millisecond. The redundant `detail.createdAt` is
    gone (stale copies on existing rows are simply ignored, then dropped on the next write).
  - `BoardService.addTask` now enforces the same containment rule `canReparent` applies on a move: a
    task may only be created under a service frame or a module. A task parented to an `epic` /
    `initiative` grouping node was structurally orphaned — invisible to any reader that resolves a
    service subtree, including this task list.

  The `human-test` / `visual-confirmation` gate step-state schemas moved out of
  `contracts/src/execution.ts` into their own `human-verdict-gates.ts` module (re-exported from the
  package root, so no import path changes): merging `main` pushed `execution.ts` past the file-size
  budget, and the two human-verdict gates are the cohesive seam — they share a `rounds` history and a
  transient `pendingAction` that the polling gates' `GateStepState` does not have.

### Patch Changes

- Updated dependencies [0f7cba1]
- Updated dependencies [f0e9bab]
  - @cat-factory/orchestration@0.146.0
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0
  - @cat-factory/agents@0.72.1
  - @cat-factory/integrations@0.101.2
  - @cat-factory/prompt-fragments@0.14.19
  - @cat-factory/spend@0.12.92

## 0.155.1

### Patch Changes

- Updated dependencies [45fddb6]
  - @cat-factory/orchestration@0.145.1

## 0.155.0

### Minor Changes

- 640cadd: Judges: a registry seam for deployment-authored rubric evaluators that can block or bounce a run.

  Three engine paths already shared one shape — an LLM produces a structured assessment, the engine
  compares it to a per-task threshold, and the run advances, parks or escalates (requirements
  auto-pass, the `merger`, `on-call`). That latent "verdict gate" family is now promoted into a
  **fourth step-taxonomy bucket**: agents / polling gates / one-shot engine steps / **judges**.

  A judge step runs an LLM assessment of the run's work against a **rubric**, and the engine
  compares the verdict's score to the task's merge preset before disposing: advance, park for a
  human, **bounce** the producing step with the findings as its rework brief, or fail the run.
  Adding one is a registry entry, not a copy of the machinery — the same promise `registerGate`
  makes for polling gates.

  - **`JudgeRegistry`** (`@cat-factory/kernel`, app-owned + empty by default) threaded through
    `CoreDependencies.judgeRegistry` beside `gateRegistry`. A registration supplies only its
    differentiators: the rubric, an optional `parseVerdict`, `threshold`/`attemptBudget` read off
    the preset, `onFail` (`park` / `bounce` / `fail`) and `bounceTargets`.
  - **One generic driver** in the engine owns the state machine, threshold comparison, park,
    bounce budget, persistence and emission. All live state rides `step.judge` — no side table, so
    it is runtime-symmetric by construction.
  - **No per-facade wiring**: the verdict producer is an injectable `JudgeAssessor` whose default
    is built from the model-provider dependencies every facade already wires. An
    absent/disabled assessor makes every judge step a **pass-through**, so existing pipelines are
    byte-for-byte unchanged.
  - Two new merge-preset knobs, `judgeMinScore` (default 0.7) and `judgeMaxBounces` (default 1),
    mirrored D1 ⇄ Drizzle. The built-in presets' seed version bumps to 5, so existing workspaces
    are advised to reseed.
  - A rubric's per-workspace override is an ordinary **prompt-library fragment**
    (`JudgeRubric.fragmentId`), so the feature adds no rubric storage.
  - The verdict is a first-class section of the **PR verification report**, rendered through the
    `hostMarkdown` helpers and scrubbed like every other model-authored field.
  - A parked verdict is answerable from the SPA's new judge window **and** from
    `POST /api/v1/runs/:runId/decisions/judge/resolve` — both call the same service method.

  The `merger` is deliberately NOT rewritten onto this: it owns terminal block status and a real,
  credential-bearing merge, and stays a privileged built-in. See
  `docs/initiatives/judge-registry.md`.

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/orchestration@0.145.0
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0
  - @cat-factory/agents@0.72.0
  - @cat-factory/integrations@0.101.1
  - @cat-factory/prompt-fragments@0.14.18
  - @cat-factory/spend@0.12.91

## 0.154.0

### Minor Changes

- 968a214: Bugfix reproduction proof — the harness verification phase (Phase B)

  The container now RUNS the reproduction declaration Phase A threaded to it, so a bugfix run
  carries captured evidence that the defect was real instead of the model's own claim that it was.
  Between the agent settling and the pull request opening, the harness runs the declared check
  against two trees of the same clone and computes the verdict from the exit codes:

  - **`reproduced`** — red on the pre-fix tree, green on the tree the PR opens from. The only shape
    that is proof.
  - **`inconclusive`** — every other shape (green at base ⇒ the check does not demonstrate the
    defect; red at both ⇒ the change does not fix it, or the environment is broken), recorded
    honestly with both captured outputs and a one-line note saying which.

  **Symmetry is the safety property.** A non-zero exit at the base proves nothing on its own — a
  missing toolchain, an uninstalled dependency, or an unrelated pre-existing breakage all produce
  one. Both phases therefore run in freshly-created `git worktree` checkouts with the SAME setup
  command and the byte-identical declared test files (applied path-by-path onto the base tree, never
  a whole-tree checkout, which would drag the fix across and green it). An environmental defect
  fails both and is reported as `inconclusive`, never as proof. Red-for-the-wrong-_reason_ is not
  detected — both outputs ride the report precisely so a human can see why the base was red.

  **A failed verification is a REPAIR, not a run failure.** The captured output goes back to the
  agent — with an explicit rule against weakening the reproduction — while budget remains, and
  exhausting it degrades to `inconclusive` with the PR still opening. Deliberately a different
  disposition from pre-PR validation, which opens nothing: a red check means the WORK is broken; an
  unproven reproduction means the EVIDENCE is weak, which is a reviewer's call. A setup failure
  spends no repair rounds at all, since the agent cannot change a setup command it did not declare.

  Also in this slice:

  - The verdict reaches the engine both LIVE (`RunnerJobView.reproductionReport`, republished with a
    fresh timestamp each round so a failed verification is visible while the loop still runs) and
    terminally, on the success path, the failure path, and through a self-hosted runner pool (a new
    `reproductionReportPath` response-manifest mapping, so a pool-backed run is not left with a
    silently missing section).
  - The proof runs BEFORE the pre-PR validation loop, so validation stays the last thing to touch
    the tree and "only a green checkout opens a PR" is preserved unconditionally.
  - Per-job by construction: the worktree root is a fresh `mkdtemp` and every command, cwd and
    environment arrives as an argument, so two concurrent bugfix runs on the ONE local-native host
    process cannot check out over each other's base trees — which would surface as a false verdict
    on a pull request, not a crash. Pinned by a concurrency test.
  - A declared test file that was never `git add`ed is reported as such (the proof runs against
    committed trees, and the push would miss it too) instead of yielding a verdict computed without
    the reproduction in it.

  What the verdict will and will not claim:

  - **A green pre-fix tree no longer blames the test when the tree is not actually fix-free.** A
    resumed run's pre-fix tree is the work branch as it stood when the pass started — which, after a
    mid-run eviction, already carries that same step's committed partial fix. The check then passes
    there for a reason unrelated to the test, so the proof probes (on a green base only, memoised)
    whether the tree carries non-test work, reports that instead of "your test does not demonstrate
    the defect", and spends no repair round. An unavailable answer degrades to the plain diagnosis.
  - **Declared test paths are refused for git pathspec magic** (`:(glob)`, `*`, `?`, `[…]`) as well
    as traversal, in both the engine's sanitizer and the harness's own. `--` stops a path being read
    as a revision but not as a pathspec, so a glob would apply most of the final tree onto the base
    worktree and green it — turning a good reproduction into a false "the test does not capture the
    defect", from model-authored input.
  - **Two identical failures read as an environment problem, not an ineffective fix**, and two
    timeouts read as a watchdog kill. Neither is evidence for "the change does nothing".
  - **A timed-out tree spends no repair round**, joining setup failures and the prior-work base: in
    all three the agent is not what is wrong, so a round can only add cost.
  - **The phase carries a wall-clock ceiling** (`REPRODUCTION_TOTAL_BUDGET_MS`, 45m) on top of the
    attempt budget. Attempts multiply two full tree runs each, and the phase's own heartbeat
    deliberately stops the job inactivity watchdog from firing, so nothing else bounded it.
    Exceeding it settles `inconclusive` with its own note — a cost limit, never a verdict.
  - **The `repro-test` prompt now states that both runs happen in a fresh checkout** and that
    `setupCommand` is required when the tests need an install or build to run there. Omitting it is
    the most common way the proof ends up proving nothing.

  Both pre-PR verification phases now spawn through one shared `runCapturedCommand` seam (watchdog,
  abort handling, exit-code conventions, scrub-then-bound capture) instead of two near-verbatim
  copies, and the capture keeps a small margin so a secret straddling the rolling cut is still whole
  when it is scrubbed.

  Unconfigured means unchanged: no `reproduction` on the job body ⇒ the harness's existing path,
  byte for byte.

  Runner image bumped to `1.59.0`. The PR-report section that renders this is Phase C.

  Design + phase checklist: `docs/initiatives/bugfix-reproduction-proof.md`.

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/integrations@0.101.0
  - @cat-factory/contracts@0.169.0
  - @cat-factory/orchestration@0.144.0
  - @cat-factory/agents@0.71.0
  - @cat-factory/kernel@0.163.1
  - @cat-factory/prompt-fragments@0.14.17
  - @cat-factory/spend@0.12.90

## 0.153.1

### Patch Changes

- 829a905: Refresh dependencies (direct + transitive) and bump the coding-agent CLIs baked into the
  runner image.

  - **Runner image (`@cat-factory/executor-harness`, image tag `1.57.0`)**: Pi
    `0.80.6 → 0.82.1`, Claude Code `2.1.207 → 2.1.220`, Codex `0.144.1 → 0.145.0`, and the
    two Pi extensions `@juicesharp/rpiv-todo` / `@juicesharp/rpiv-web-tools`
    `1.20.0 → 2.1.0`. The todo extension's v2 tool result keeps the `details.tasks[]` shape
    (`subject` + `pending`/`in_progress`/`completed`/`deleted` status) that
    `parseTodoProgress` reads, so live subtask progress is unaffected. The image pins in
    `deploy/backend` (`package.json` + `wrangler.toml`) and
    `RECOMMENDED_HARNESS_IMAGE` are synced to the new tag.
  - **Workspace dependencies**: refreshed the whole lockfile within the declared ranges, so
    transitive dependencies move up too. Direct bumps include `ai` 7.0.37, `@ai-sdk/*`
    (anthropic 4.0.21, openai 4.0.20, amazon-bedrock 5.0.32), `hono` 4.12.32,
    `@hono/node-server` 2.0.12, `pg-boss` 12.26.3, `undici` 8.9.0, `wrangler` 4.114.0,
    `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` 0.18.8,
    `@aws-sdk/client-s3` 3.1095.0, `@playwright/test` 1.62.0 and `turbo` 2.10.7. Every
    version picked is the newest that already satisfies the `minimumReleaseAge` supply-chain
    gate, and the AI-SDK family stays inside the majors that pair with `workers-ai-provider`
    (`ai@^7`, `@ai-sdk/*@^4`). No third-party entries were added to
    `minimumReleaseAgeExclude`. The frontend's `typescript@^6` pin is left alone (Nuxt /
    `vue-tsc` toolchain).

- Updated dependencies [143e6bb]
- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/orchestration@0.143.1
  - @cat-factory/agents@0.70.1
  - @cat-factory/integrations@0.100.2
  - @cat-factory/kernel@0.163.0
  - @cat-factory/spend@0.12.89

## 0.153.0

### Minor Changes

- c95600b: Bugfix reproduction proof — foundation (Phase A)

  Threads a machine-verifiable reproduction declaration from a run's `repro-test` step onto the
  PR-opening coder dispatch, so a later slice's harness phase can prove the defect was real: run
  the declared check against the pre-fix tree (expect red) and the final tree (expect green).

  - **Contracts**: new `reproduction.ts` (the resolved spec, the harness report + its
    `reproduced` / `inconclusive` / `declared_infeasible` verdict, `parseReproductionReport`) and
    `PipelineStep.reproduction`, which rides the run's `detail` blob — no migration.
  - **Agents**: `reproTestOutcome` gains `command`, `setupCommand` and `alternativeVerification`
    (with the prompt updated to ask for them), and the `coder.reproductionProof` tri-state config id
    (`auto` / `always` / `off`). The task-facing descriptor is deliberately NOT contributed yet —
    the verification phase and the PR section are later slices, and `always` resolves identically to
    `auto` until the tracker-issue gating lands, so a control rendered now would offer two
    indistinguishable options and promise behaviour that does not exist. A value set by hand or by a
    deployment is already honoured.
  - **Engine**: pure `reproductionProof.logic.ts` resolves the tri-state + declaration into the
    spec `AgentContextBuilder` folds onto `AgentRunContext.reproduction`; the job body forwards it
    only on a dispatch that opens a PR; the harness verdict is recorded on the step from all three
    poll paths.
  - **Model-authored input is bounded at the resolution boundary**: the declared command and setup
    command are length-capped (over-length declines the whole spec), and each declared test path
    must be repo-relative with no `..` segment, since the harness applies them onto a base worktree.
    Every dropped path is counted onto the spec's `omittedTestPaths` and carried to the report, so a
    proof run against an incompletely rebuilt tree says so instead of implying a clean verdict.
  - **Infeasibility is structural**: a run whose reproduction step conceded dispatches no proof and
    instead records the declaration itself — the reason plus the agent's stated alternative
    verification — so "could not be reproduced" no longer reads the same as "nobody tried". A reply
    that never named an outcome is NOT treated as a concession (the schema's lenient fallback would
    otherwise publish an infeasibility claim the agent never made), and a concession with neither a
    reason nor an alternative records an explicit note rather than a blank card.

  Behaviour is unchanged for every run that is not opted in or carries no declaration: no context
  field, no job-body field, the existing harness path. Asserted on both runtimes.

  Design + phase checklist: `docs/initiatives/bugfix-reproduction-proof.md`.

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/orchestration@0.143.0
  - @cat-factory/contracts@0.168.0
  - @cat-factory/agents@0.70.0
  - @cat-factory/kernel@0.162.0
  - @cat-factory/integrations@0.100.1
  - @cat-factory/prompt-fragments@0.14.16
  - @cat-factory/spend@0.12.88

## 0.152.0

### Minor Changes

- df9ca7d: Merge track record: reviewer-effort tags, deterministic change-class classification, and
  per-class auto-merge rules on merge presets.

  The merge decision no longer runs purely on the `merger` agent's self-assessment. Every merge
  decision now persists one row in a new `merge_track_records` table (full D1 ⇄ Drizzle parity)
  carrying the run's **change class**, the merger's scores, the outcome (`pending_review` →
  `auto_merged` / `human_merged` / `external_merged` / `rejected`), and a nullable **reviewer-effort
  tag** (`none` / `minor` / `major`). Per-class rollups are single SQL aggregates behind
  `GET /workspaces/:ws/merge-track-records/rollups`.

  - **Classification** is deterministic backend TypeScript over ONE VCS call (`RepoFiles.listChangedFiles`
    → the pure `classifyChangedFiles`), so it needs no harness change or runner-image bump and works
    identically on a GitLab deployment. Classes are risk-ranked (`docs` < `test` < `dependency` <
    `config` < `source` < `schema`) and a mixed diff takes the highest-ranked class present. An
    unreadable diff yields `unknown`, which never matches a per-class rule.
  - **Per-class rules** on a merge preset: `always` auto-merge, `never` auto-merge, or fall back to the
    score ceilings — resolved with `autoMergeEnabled: false` as the master switch a rule can never
    override.
  - **Effort capture** at the existing decision points: `POST /notifications/:id/act` takes an optional
    `reviewEffort` (one-tap confirm-and-tag, preselected from whether the run's PR review recorded
    findings), `POST /workspaces/:ws/merge-track-records/:id/effort` tags out of band, and a PR merged
    directly on the provider is detected from the webhook ingest and nudged with a dismissible
    `merge_tag_request` card. Tagging is never mandatory: an untagged merge records a null tag.
  - Classification and record writes are **best-effort side channels** — a failure in any part of this
    feature can never fail or block a merge.

  A merge decision's record carries the run's **provider-neutral repo identity** (`repoId` +
  `provider`), captured from the run-repo resolution the classification already performs. That is what
  makes a record attributable: external-merge detection can only look a record up by
  `(repoId, prNumber)`, since a webhook delivery knows nothing else about the run.

  **BREAKING (backend API):** `RepoTarget` (`@cat-factory/server`) and `RunRepoContext`
  (`@cat-factory/kernel`) gain a required `repoId` plus an optional `provider`, in the neutral
  `VcsRepoRef` vocabulary. Both are produced in exactly one place each, so a deployment that builds
  its own `ResolveRepoTarget` / `ResolveRunRepoContext` must supply the id; the compiler points at
  every site.

  A contract route whose request body is ALL-optional now mounts the new `optionalJsonBody`
  middleware (`@cat-factory/server`). A declared `requestBodySchema` otherwise makes the transport
  REQUIRE a body — the validator reads `c.req.json()` before the schema is consulted — so a route that
  merely gained an optional field would start rejecting the body-less calls it had always accepted.
  `POST /blocks/:blockId/merge` and `POST /notifications/:id/act` keep working with no body at all.

  **BREAKING (wire shape):** `RiskPolicy` gains a required `classRules` field (a partial map from
  change class to `thresholds` / `always` / `never`). Per the pre-1.0 policy there is no dual-read
  shim: persisted rows take the `'{}'` column default, which resolves to "use the score ceilings" for
  every class — i.e. byte-for-byte the previous behaviour — but any external consumer of the preset
  wire shape must account for the new field. The built-in preset seeds bump to version 4, so existing
  workspaces are offered a reseed. `notificationTypeSchema` also gains `merge_tag_request`, and
  `MergeDecision.reason` gains `class_auto_merge` / `class_requires_review`; both are closed unions a
  consumer may be switching on exhaustively.

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0
  - @cat-factory/orchestration@0.142.0
  - @cat-factory/integrations@0.100.0
  - @cat-factory/agents@0.69.10
  - @cat-factory/prompt-fragments@0.14.15
  - @cat-factory/spend@0.12.87

## 0.151.0

### Minor Changes

- 600a8ad: Headless clarification loop: questions out to the linked tracker issue (slice 2a). When a run
  started through `/api/v1` parks its requirements review on open findings, its questions can now
  be posted onto the task's linked GitHub/Jira/Linear issue — each rendered with the stable finding
  id that `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply` takes — so the
  clarification reaches whoever requested the work instead of waiting in an inbox nobody headless
  can see.

  Opt-in per workspace via the new `writebackQuestionsOnPark` tracker setting, with the usual
  per-task `trackerQuestionsOnPark` override; both are exposed in the issue-tracker settings panel
  and the task inspector alongside the existing PR-open/PR-merge writeback toggles. Tasks started in
  the app are deliberately unaffected: the echo fires only for runs whose recorded intake origin is
  `public-api`, and their clarification surface remains the in-app review window.

  The post is driven from the durable execution driver, whose steps replay, so it is made idempotent
  by an atomic claim on a new workspace-scoped `review_question_posts` table keyed by
  `(workspace, review, iteration, issue)` — taken before the comment is attempted, so neither a
  replay nor a crash mid-post can double-post onto an issue a human is reading. A failed post is
  recorded with its error and retried on the next replay rather than being swallowed, and a claim
  abandoned by a poster that died mid-post is re-takeable after `REVIEW_QUESTION_POST_CLAIM_TTL_MS`
  so that iteration's questions are not silently lost. The park is committed before the outbound
  call, so a slow or unavailable tracker can never delay the state change that makes the run
  answerable.

  The comment body is model-authored text landing on a host-parsed (often public) surface, so it is
  rendered through the same untrusted-text boundary as the PR verification report — auto-link
  triggers defused so a finding cannot notify a real account or cross-link an unrelated issue, code
  fences balanced, and secrets scrubbed. That boundary moved from `@cat-factory/orchestration` into
  `@cat-factory/kernel` as the `hostMarkdown` namespace to serve both consumers.

  Breaking (pre-1.0, no migration): `TrackerSettings` gains a required `writebackQuestionsOnPark`
  field and `IssueWritebackProvider` gains a required `postReviewQuestions` method, so a deployment
  with its own implementation of either must add them; `ReviewQuestionPostRepository.claim` takes a
  claim window rather than a bare timestamp; and the `commentOnGitHubIssue` writeback seam must now
  THROW when it cannot resolve the target issue instead of returning quietly (returning is the
  seam's promise that the comment landed). New tables/columns are created by the Cloudflare D1
  migration `0062` and the generated Node Drizzle migration.

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0
  - @cat-factory/integrations@0.99.0
  - @cat-factory/orchestration@0.141.0
  - @cat-factory/agents@0.69.9
  - @cat-factory/spend@0.12.86
  - @cat-factory/prompt-fragments@0.14.14

## 0.150.0

### Minor Changes

- 3949f82: GitLab connect UI (GitLab UI-parity slice 2b). A workspace can now connect GitLab from the
  product: the source-control panel and the connect onboarding gate render a personal-access-token
  field (`components/vcs/GitLabConnect.vue`) alongside — or instead of — the GitHub App
  installation picker, showing the upstream validation error inline when a token is rejected.

  Which surfaces appear comes from a new provider-neutral capability route,
  `GET /workspaces/:ws/vcs/connect-options`, which reports what the deployment actually wired
  (`github/app`, `gitlab/pat`, both, or neither) — previously the SPA could not tell, so a
  GitLab-only deployment still offered an App picker it could not serve. The `github` store probes
  it with the connection and exposes `canConnectGitHubApp` / `canConnectGitLabPat` /
  `soleConnectProvider` / `provider`, and `disconnect()` now routes to the connected provider.

  Panel/onboarding chrome (title, icon, connection line, disconnect copy) is provider-aware:
  brand labels/icons/token URLs are shared `Record<VcsProvider, …>` constants in
  `app/utils/vcs.ts` (lifted out of `LoginScreen.vue`), and prose moved to a provider-parameterised
  `vcs.*` i18n namespace in all 10 locales. **Breaking (SPA catalog):** the GitHub-App-specific
  `github.onboarding.title` / `github.onboarding.intro` and `github.panel.confirmDisconnect` /
  `github.panel.toast.disconnected` keys are replaced by `vcs.onboarding.*` / `vcs.panel.*`, so a
  deployment overriding those keys must rename them.

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/integrations@0.98.0
  - @cat-factory/agents@0.69.8
  - @cat-factory/kernel@0.159.1
  - @cat-factory/orchestration@0.140.1
  - @cat-factory/prompt-fragments@0.14.13
  - @cat-factory/spend@0.12.85

## 0.149.1

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0
  - @cat-factory/integrations@0.97.0
  - @cat-factory/orchestration@0.140.0
  - @cat-factory/agents@0.69.7
  - @cat-factory/spend@0.12.84

## 0.149.0

### Minor Changes

- 5a58b9d: Pre-PR validation: configurable check commands run in the container before a PR is opened.

  A service frame can now declare validation commands (install / lint / test / build). After the
  coder settles, the executor-harness runs them against the checkout **before** opening a pull
  request; a failure is handed back to the agent with the captured output and the loop retries
  under a per-service attempt budget (default 3). Only a passing checkout opens a PR — an
  exhausted budget fails the step with the last captured output and opens nothing, so broken
  lint/tests never become public PR churn.

  - New per-service config store (`validation_configs`, D1 ⇄ Drizzle) resolved up the frame chain,
    managed via `GET|PUT|DELETE /workspaces/:ws/services/:blockId/validation-checks` and a new
    service-inspector panel.
  - The resolved commands ride the job body (no transport-specific wiring), so this works
    identically on the Cloudflare container, a self-hosted runner pool, and local container/native.
  - Command output is truncated and secret-scrubbed, surfaced live on the step while the repair
    loop runs and persisted on `PipelineStep.validation` for observability.
  - Unconfigured services are unaffected: no commands resolved, no loop, no job-body field.

  BREAKING for self-hosted runner pools only: a pool that wants the LIVE repair-loop view should
  map the new `validationReportPath` in its response manifest (the terminal result envelope is
  forwarded without any manifest change).

  Review follow-ups in this PR:

  - The check loop now feeds the run's inactivity watchdog. `JOB_INACTIVITY_MS` (default 10 min) is
    tighter than a single command's own watchdog (default 15 min), so a legitimately slow
    `install`/`test`/`build` previously aborted the whole run as "inactivity" instead of reporting a
    validation failure.
  - Repair prompts now name any NEW files left un-`git add`ed. The checks run against the working
    tree but only tracked edits are pushed, so an unadded file could take the loop green on work the
    pull request would never contain.
  - Checks resolve from the service frame the engine already walked to, instead of re-deriving it —
    removing two block reads from every agent dispatch.

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0
  - @cat-factory/integrations@0.96.0
  - @cat-factory/orchestration@0.139.0
  - @cat-factory/agents@0.69.6
  - @cat-factory/prompt-fragments@0.14.12
  - @cat-factory/spend@0.12.83

## 0.148.0

### Minor Changes

- 55e0a85: Headless clarification loop over the public API (slice 1). A run started through `/api/v1`
  can now include the requirements-review loop instead of being refused at admission: a new
  `/api/v1/runs/:runId/decisions` surface lists a run's parked human decisions (review findings
  with stable item ids, iteration/cap, the incorporated document; the proposed implementation
  forks) and answers them — reply, dismiss, incorporate, re-review, proceed, resolve-exceeded,
  choose a fork. Every route delegates to the SAME service methods the SPA controllers call, so
  the park's optimistic-concurrency arbitration and the task's merge-preset knobs apply
  identically whichever surface answers first.

  **Breaking:** the public-API scope ladder gains a `decide` rung between `write` and `admin`
  (`read ⊂ write ⊂ decide ⊂ admin`). Answering a parked decision — and starting a headless run
  on a pipeline that can park at all — requires it; a `write` key sees exactly the previous
  behaviour, refusal included. Existing keys keep their stored scope, so a `write` key that
  should now answer decisions must be re-minted as `decide`.

  Also in this slice: `POST /api/v1/jobs/:id/cancel` (an abandoned park can always be cleared,
  so the in-flight cap stays recoverable — there is deliberately no run-killing park timeout);
  a `decision` frame on both public SSE streams, which now stay open across a park; a new
  per-workspace outbound **notification webhook** (`GET|PUT|DELETE
/workspaces/:ws/notification-webhook`) delivered HMAC-signed as a `NotificationChannel`
  alongside in-app and Slack, so a headless caller learns of a park by push rather than
  polling; and `ExecutionInstance.intakeOrigin` (`ui` | `public-api`), recorded so slice 2 can
  push clarification questions to a tracker issue for headless-origin runs only. A UI-started
  task's behaviour is unchanged throughout.

  The webhook endpoint is held to the same SSRF guard as the other operator-supplied-URL
  integrations, at both boundaries: registration rejects a private/internal/cloud-metadata host,
  and delivery goes through the shared `safeFetch` so the guard re-runs on every redirect hop
  (a public endpoint cannot 302 the signed body at an internal target). Two new optional env
  vars, `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS`, widen
  it for a receiver on an internal host or a developer's `localhost`; they are scoped to
  webhooks alone, so they never widen the runner-pool or environment guard. One delivery is
  bounded by a total wall-clock budget rather than an attempt count, because the notification
  fan-out is awaited by the engine step that raises it. The webhook counts as an EXTERNAL
  notification channel, so under mothership mode the mothership — which holds the key its
  signing secret is sealed with — is the side that delivers it.

  Also exported: `assertSafePublicUrl`, the provider-neutral URL guard now shared by the
  environment, runner-pool and notification-webhook integrations (previously an
  environment-labelled private function), so an SSRF bypass is fixed in one place for all of
  them.

  See `docs/initiatives/headless-clarification-loop.md`.

### Patch Changes

- Updated dependencies [ddcdcd8]
- Updated dependencies [55e0a85]
  - @cat-factory/orchestration@0.138.0
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0
  - @cat-factory/integrations@0.95.0
  - @cat-factory/agents@0.69.5
  - @cat-factory/spend@0.12.82
  - @cat-factory/prompt-fragments@0.14.11

## 0.147.0

### Minor Changes

- ecd68c5: PR verification report — the ENGINE now maintains a structured verification report on each
  run's pull request, so a reviewer sees captured facts instead of the agent's own "tests pass"
  prose. It carries the `ci` gate's aggregated verdict (per-check-run names/conclusions +
  `ci-fixer` attempt count), the tester step's structured report, the `deployer` step's
  ephemeral-environment lifecycle (per-frame outcomes + teardown state), the `merger`'s scored
  assessment and the engine's resolved merge decision, run metadata (task, linked tracker issues,
  repo/provider, pipeline, per-step agent kind + resolved model), and a deep link into the run's
  observability panel — as human-readable markdown plus a fenced JSON block validated by the new
  `prVerificationReportSchema`.

  It is written as a marker-delimited region of the PR description and updated **idempotently in
  place**, so a retry or re-run rewrites it instead of appending a second copy, and the agent's own
  description is preserved. Composition happens as each step settles (an engine hook, not a new
  pipeline step), so a run that fails or parks part-way still leaves its evidence on the PR, and a
  section whose producing step didn't run says so explicitly rather than silently vanishing.

  Everything the report interpolates is agent- or human-authored, and a pull-request description is
  a PARSED, potentially PUBLIC surface, so the text boundary is explicit: every free-text field is
  scrubbed with the same `redactSecrets` the telemetry store uses, and every interpolation
  neutralises the host's auto-link triggers (`#123` / `@name` / `!123`, and a closing keyword in
  front of an issue URL — which would otherwise CLOSE that issue when the PR merges), folds
  newlines inside table cells, and balances any code fence the agent left open so the fenced JSON
  block stays extractable. Lists are capped, and what was capped is named in the report's own
  `truncations` log rather than silently shortened.

  New per-workspace setting **`publishPrVerificationReport`** (default on, mirrored D1 ⇄ Drizzle
  with a migration on both runtimes): a workspace that would rather keep its CI verdicts, test
  outcomes and environment URLs off the pull request can decline. Turning it off stops future
  writes; a report already on a PR is left as it is.

  Provider-neutral: it publishes through the facade's ENGINE VCS client, so a GitLab deployment
  gets the report on its merge-request description too. **Breaking for port implementors:**
  `GitHubClient` and `VcsClient` gain a required `getPullRequestBody` method (the read half of the
  read-splice-write upsert), and `PrVerificationReportPublisher` gains a required `resolveTarget`
  (the engine states the repo/provider the ADAPTER resolved, never the run's last dispatch — which
  on a multi-repo task is a peer repo, not the repo whose PR is being written to). Wiring is per facade (Worker ⇄ Node/local) alongside the existing
  merge/mergeability providers; with no VCS client wired the engine behaves exactly as before.
  The SPA gains a narrow boot-time deep-link replay (`?ws=…&block=…&run=…&view=observability`) so
  the report's observability link resolves.

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0
  - @cat-factory/orchestration@0.137.0
  - @cat-factory/agents@0.69.4
  - @cat-factory/integrations@0.94.1
  - @cat-factory/prompt-fragments@0.14.10
  - @cat-factory/spend@0.12.81

## 0.146.0

### Minor Changes

- 16c98f3: Mothership mode: delegate notification DELIVERY to the mothership.

  A mothership-mode local node persists its notification rows on the mothership but holds none of
  the org's external delivery credentials (the Slack bot token is sealed with the mothership's
  encryption key, which never reaches a laptop), so a `merge_review` / `ci_failed` /
  `release_regression` raised by a local run landed in the inbox and never reached the team's Slack.

  Adds the machine-authed `POST /internal/notifications/deliver`, mounted on BOTH facades behind the
  same audience pin + account scoping as the persistence RPC. The wire carries identifiers only
  (`{ workspaceId, notificationId }`) — the mothership re-reads the row from its own workspace-scoped
  store and delivers THAT, so a node can never inject forged notification text into the org's Slack.
  Each facade wires the new `ServerContainer.machineNotificationDelivery` seam with its EXTERNAL
  channels only; the in-app frame for a laptop-raised notification already arrives over the real-time
  upstream relay, so it is never double-pushed. A deployment with no external channel serves a 503.

  On the consumer side, `composeMothership` builds a `RemoteNotificationChannel` (same base URL +
  per-request machine token as the persistence RPC; a token-less node skips the round-trip) and
  `buildLocalContainer` threads it into `buildNodeContainer`'s new `notificationChannels` option, so
  it composes alongside the local in-app push with no engine change. Delivery stays best-effort: an
  unreachable mothership is logged, never propagated into the state transition that raised the row.

## 0.145.1

### Patch Changes

- Updated dependencies [1ffa4fe]
  - @cat-factory/orchestration@0.136.1

## 0.145.0

### Minor Changes

- 7c6bd77: Per-workspace GitLab PAT connect flow (backend, GitLab UI-parity slice 2a). A hosted
  deployment can now connect a workspace to GitLab by pasting a personal access token: the
  token is validated against the account's identity, sealed at rest (a new `access_token`
  column on `github_installations`, mirrored across D1 + Drizzle), and the workspace's repos
  are browsed / linked / synced through the SAME GitHub-shaped projection surface. A new
  `ProviderRoutingGitHubClient` routes each installation-keyed call to the App or GitLab client
  by the connection's stored provider, so a deployment can serve GitHub App and GitLab PAT
  workspaces side by side. New endpoints: `GET|POST|DELETE /workspaces/:ws/gitlab/connection`
  (503 until GitLab connect is wired). The connect UI is a follow-up slice.

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0
  - @cat-factory/integrations@0.94.0
  - @cat-factory/orchestration@0.136.0
  - @cat-factory/agents@0.69.3
  - @cat-factory/spend@0.12.80
  - @cat-factory/prompt-fragments@0.14.9

## 0.144.6

### Patch Changes

- 0e2799e: Close three gaps in the `human-review` PR gate:

  - **Reviewer "Request changes" summaries are no longer ignored.** The gate only reacted to
    inline review threads and plain conversation comments, so a reviewer who requested changes with
    their feedback in the review's top-level summary box (no inline line comments) was invisible —
    the run waited indefinitely for an approval that would never come. The review `body` is now read
    (`FetchGitHubClient` + the `GitHubPullRequestReview` port), surfaced on the snapshot as
    `reviewSummaries`, and folded into the gate's outstanding-feedback set so it dispatches the
    fixer like any other comment.
  - **A standing `CHANGES_REQUESTED` now blocks advancement** even when the required approval count
    is met by other reviewers (`PullRequestReviewSnapshot.changesRequested` + `isApproved`), matching
    GitHub's own merge rule so the gate can't sign off a PR GitHub would refuse to merge.
  - **Approval reduction is order-independent**: reviews are sorted by `submittedAt` before the
    "latest standing review per author" reduction, instead of trusting the API's array order.

- 239788a: Security hardening (round 2, SSRF/injection batch):

  - **SEC-2** — the inline model-provider path now routes local-runner endpoints through the
    redirect-revalidating `fetchLocalRunner` (an optional `fetch` on `openAiCompatibleResolver`), so
    an inline LLM call can't be 302'd to the cloud-metadata endpoint. Matches the proxy path.
  - **SEC-7** — the Confluence document provider reuses the shared `safeFetch`, which strips the
    Basic-auth header and body on a cross-origin redirect (the local copy that kept them is removed).
  - **SEC-9** — explicit `bodyLimit` backstops on the unauthenticated `/github/webhooks` and
    `/vcs/:provider/webhooks` raw-body reads (25 MB) and the LLM proxy `/v1/chat/completions` route
    (32 MB), so an anonymous/session caller can't pin memory before the HMAC/session check.
  - **SEC-10** — the initiative `slug` wire field is constrained to a lower-kebab grammar, so no
    `/`/`..` segment can reshape a committed `docs/initiatives/<slug>/…` path.
  - **`/vcs` fail-closed fix** — `/vcs` is added to the auth gate's `PUBLIC_PREFIXES`, so the
    provider-neutral VCS webhook receiver is reachable on an auth-enabled deployment (it verifies its
    own per-provider signature/token, like `/github`).

- Updated dependencies [0e2799e]
- Updated dependencies [696da88]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/integrations@0.93.0
  - @cat-factory/agents@0.69.2
  - @cat-factory/contracts@0.160.1
  - @cat-factory/orchestration@0.135.5
  - @cat-factory/spend@0.12.79
  - @cat-factory/prompt-fragments@0.14.8

## 0.144.5

### Patch Changes

- 770f926: Upgrade the Vercel AI SDK family to v7 (paired with `workers-ai-provider@4`) and refresh the rest of the dependency tree within the supply-chain release-age gate.

  - **AI SDK v7 / Cloudflare Workers AI**: `ai@^6 → ^7`, `@ai-sdk/openai`/`@ai-sdk/anthropic`/`@ai-sdk/provider` `^3/^4 → ^4`, `@ai-sdk/openai-compatible@^2 → ^3`, `@ai-sdk/amazon-bedrock@^4 → ^5`, and `workers-ai-provider@^3 → ^4`. This is now possible because `workers-ai-provider@4` accepts `ai@^7` peers, lifting the pin that previously held the family at v6. The only code change required is reading the AI SDK v7 usage shape (`usage.inputTokenDetails.cacheReadTokens` in place of the removed `usage.cachedInputTokens`).
  - **Dependency sweep**: within-range refresh of the tree plus targeted bumps of `@cloudflare/workers-types@^4 → ^5` (aligns with the `wrangler@4` peer), `@opentelemetry/exporter-*-otlp-http@^0.220 → ^0.221` (lockstep with the `@opentelemetry/*@2.10` SDKs), and `oxfmt`, `undici`, `pg-boss`, `@nuxtjs/i18n`, `happy-dom`, `vue-tsc`, `wrangler` and others to their latest release-age-compliant versions. The `@cat-factory/executor-harness` runner-image deps are deliberately untouched.

- Updated dependencies [770f926]
  - @cat-factory/agents@0.69.1
  - @cat-factory/integrations@0.92.1
  - @cat-factory/kernel@0.154.1
  - @cat-factory/orchestration@0.135.4
  - @cat-factory/spend@0.12.78

## 0.144.4

### Patch Changes

- ad4c999: Fix per-job state leaking across concurrent native (`LOCAL_NATIVE_AGENTS`) runs, and stop
  native runs writing into the developer's own home directory.

  Native mode already ran jobs in parallel — one long-lived harness host process starts every job
  immediately, each in its own throwaway clone. But three pieces of per-job state were staged in
  process- or HOME-globals, which are only per-job when the process is. That holds for a container
  and not for the shared native host process, whose `HOME` is the developer's own:

  - **`~/.npmrc` was written, and deleted.** Every agent job configures private-registry auth, and
    a job with no registry entries cleared the file — correct for a reused warm-pool container,
    destructive against the developer's real npm config, on essentially every native run. A native
    job now gets its own npmrc under a per-job directory, pointed at by `npm_config_userconfig` and
    seeded from the developer's file so their registries and proxy still apply. Theirs is never
    written and never removed.
  - **A repo-sourced Claude Skill was installed into `~/.claude/skills/<name>/`.** It outlived the
    run in the developer's personal setup, and two concurrent jobs carrying same-named skills from
    different repos overwrote each other. The native install now happens only into an isolated
    `CLAUDE_CONFIG_DIR`; an ambient run reads the skill from the checkout's `.cat-context/skill/`,
    the same fallback codex always used. The prompt follows: `renderSkillForHarness` now keys off
    ambient auth as well as the harness, so such a run gets the skill's instructions folded in
    rather than a pointer to an install that never happened.
  - **The Tester's secrets were set on `process.env` and restored afterwards.** Two overlapping
    Tester runs in one harness process would read each other's values, and whichever finished
    first would delete the other's mid-run. They now ride explicit child env
    (`RunOptions.agentEnv` → `SubscriptionRunOptions.extraEnv`) merged at spawn, so the agent's
    shell tools still read them as `$KEY` with no shared mutable state.

  Container behaviour is unchanged throughout.

  Two consequences of the npmrc move are handled with it: the stand-up/validation commands the
  HARNESS spawns (rather than the agent) are passed the job env explicitly, so they keep the job's
  registry auth on the native path; and the developer's own credentials, now seeded into the job's
  npmrc, are registered for output redaction alongside the job's. Note `npm_config_userconfig` is
  honoured by npm and pnpm but not yarn, so a yarn checkout on the native path sees only the
  developer's own registries.

## 0.144.3

### Patch Changes

- Updated dependencies [4ceb622]
  - @cat-factory/orchestration@0.135.3

## 0.144.2

### Patch Changes

- 45f21eb: Lint tightening: ratchet oxlint `max-lines-per-function` (product ceiling) from 632 to 400.

  Split every product function above 400 lines along cohesive, behaviour-neutral seams, clearing
  the entire >400 band. The offenders were the DI composition-root builders and other assembly
  god-functions: the Worker `buildContainer`, `buildNodeContainer`, orchestration `createCore`,
  local `buildLocalContainer`, the Worker `scheduled` cron handler, the server public-API
  `registerTaskRoutes`, and the `pipelines` / `environmentWizard` Pinia store setups. Each was
  carved into a cohesive collaborator (a sibling `container-*`/`stores/*` factory or an in-file
  registrar), following the existing extraction precedents; the two tight-budget composition roots
  (Worker + orchestration `container.ts`) used sibling-file moves so their `check-file-size`
  allowances ratchet down rather than up. The test-glob override (2453) is unchanged.

- Updated dependencies [45f21eb]
  - @cat-factory/orchestration@0.135.2

## 0.144.1

### Patch Changes

- ce1ce11: Cut the pr-reviewer's token burn, and fix slice progress reading 0% for a whole review.

  **Slice progress.** The harness derived progress from tool names the Claude Code CLI no longer
  emits: subagent dispatch is `Agent` (the shipped `sdk-tools.d.ts` has no `TaskInput` at all), and
  the plan arrives as `TaskCreate`/`TaskUpdate` rather than `TodoWrite`. Both matchers missed, so a
  437-turn parallel review reported no slices and no progress. The slice tracker now matches `Agent`
  alongside the legacy `Task`, and a new `progress.ts` reads both plan vocabularies — `TaskCreate`
  needs the tool result too, since the CLI mints the task id there.

  **Token burn.** Measured on a ~450-file review: 437 turns, 39.5M cache-read tokens. Cost is
  turns × context, so anything loaded early is re-paid on every later turn.

  - Agent kinds can now declare `standardsDelivery: 'context-files'`: their resolved best-practice
    standards are NOT folded into the system prompt. `pr-reviewer` takes this and writes them as
    one `.cat-context/standard-<id>.md` file each. Folding charged the parent for every standard on
    every turn (~3.7M tokens) while the slice subagents that actually review the code never received
    them and worked from the parent's paraphrase — so `fragmentAdherence` was rated from a summary
    rather than the standard's text. The reviewer's adherence guidance now points at those files
    (not "folded into this prompt above"), and if the standards preOp couldn't run (GitHub unwired)
    the engine falls back to folding so a review never loses its standards through both channels.
    `composeBlockSystemPrompt`'s delivery argument is now required, so no call site (consensus
    included) can silently re-fold a `context-files` kind's standards. Two standard ids that
    sanitize to the same filename no longer collide (a short id hash disambiguates), so the harness
    can't drop one.
  - `pr-diff.md` now leads with a change-shape rollup and a deterministic suggested slicing
    (`planSlices`, size-capped), and inlines patches only when the whole diff fits one pass. A
    partially-inlined large diff was carried on every turn and bypassed anyway — the slice subagents
    ran 141 git calls and referenced it once.
  - Existing review comments are grouped by file under a path index, so a slice greps its own
    threads instead of the parent reading all of them into context.
  - The reviewer prompt now states the context discipline explicitly (ranged reads, never re-read,
    never dump a whole file, don't read a slice you are about to delegate, keep slices small) and
    tells it to dispatch slice subagents on a cheaper model.

- Updated dependencies [ce1ce11]
  - @cat-factory/agents@0.69.0
  - @cat-factory/orchestration@0.135.1

## 0.144.0

### Minor Changes

- 93496b0: Stream per-call LLM telemetry while a run is in flight, and stop losing the cause of death when a local container dies mid-run.

  A `pr-reviewer` run whose container died 18 minutes in surfaced no slices and no calls — not a subagent-handling regression, but three separate gaps that together made the run unfalsifiable: its telemetry was never written, its container logs were deleted before anyone could read them, and the error it did report described a symptom of the cleanup path rather than the failure.

  - **Per-call telemetry now streams.** The harness buffers each model call as its CLI yields it and drains it on the next poll (`RunnerJobView.callMetrics`, drain-on-read like `spans`/`followUps`); `ContainerAgentExecutor.pollJob` records it immediately. It previously arrived only on the terminal `RunnerJobResult.callMetrics`, so a run that died mid-flight reported ZERO calls no matter how many tokens it had spent — precisely the run worth inspecting. Subagent calls stream too, which matters most: that is where a long review spends its tokens and where the parent stream goes quiet. A call whose tokens are not final yet is the one exception: a CLI that reports only a cumulative total is costed at the end (`attributeCumulativeUsage`), and since a streamed call is already recorded, such a call is withheld until it is complete rather than stored as a zero-token row.

  - **Recording a call twice is now a no-op instead of a duplicate row.** Each metric carries a job-scoped `HarnessCallMetric.seq` stamped by the harness and stable across both channels, so the live drain and the terminal list mint the same `<jobId>-hc-<seq>` id, and `LlmCallMetricRepository.record` ignores an id it already holds (`onConflictDoNothing` on Drizzle, `ON CONFLICT(id) DO NOTHING` on D1 — targeted at the id, so neither store silently swallows a genuinely malformed row). First write wins deliberately — an upsert would recompute a row's stored prompt delta against a chain tip that has since moved on. The executor also skips re-offering a call the live drain already stored, so the terminal write costs one round-trip per NEW call instead of re-walking the whole list. A self-hosted runner pool opts into the live channel with the new `callMetricsPath` response mapping.

  - **A promptless call can no longer break the prompt-delta chain.** `latestChainTip` now ignores rows with `messageCount === 0` (a subagent call carries no re-sendable request transcript). Those interleave with the parent's calls in record order now that telemetry streams live, and a tip that can't be chained onto made every following parent call store its whole prompt instead of a delta — losing the compression the chain exists for on exactly the subagent-heavy runs it matters most for.

  - **An exited container no longer blocks its own replacement (local mode).** `DockerRuntimeAdapter.endpoint()` let `docker port`'s non-zero exit ("no public port '8080/tcp' published for …") escape, but `find()` returns exited containers by design and `resolve()` reads an endpoint-less container as absent. The throw therefore skipped the remove-and-recreate recovery in `dispatchPerRun` and surfaced that CLI line as the run's recorded cause of death. A dead container now resolves to `undefined` per the port contract; a fault against a still-RUNNING container still throws, so the spin-up path keeps its fail-fast diagnostic.

  - **A container that dies mid-run leaves a post-mortem.** The poll now captures the container's exit state (new `ContainerRuntimeAdapter.exitState()`, including whether the runtime OOM-killed it) plus a tail of its own logs onto the failed view's `detail`, and the engine carries that through `recoverContainerEviction` onto the recorded failure. `release()` removes the container as the run settles, so this was the only surviving record of why the harness process went away — and it was being thrown away. Container logs were previously captured only on the spin-up path, never for a container that died after a healthy start. Since a re-dispatch also removes the dead container, the FIRST death's post-mortem is retained on the step (`PipelineStep.firstEvictionDetail`) and folded into the failure alongside the last one — with a crash budget of 1, the first death is usually what explains the run. The text is secret-scrubbed before it is persisted.

  Not addressed here: a PR review's `slices` are still written only when the reviewer job completes, so a killed review still shows none. That is a work-product persistence change, not an observability one.

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0
  - @cat-factory/orchestration@0.135.0
  - @cat-factory/integrations@0.92.0
  - @cat-factory/agents@0.68.4
  - @cat-factory/spend@0.12.77
  - @cat-factory/prompt-fragments@0.14.7

## 0.143.2

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0
  - @cat-factory/orchestration@0.134.0
  - @cat-factory/agents@0.68.3
  - @cat-factory/integrations@0.91.2
  - @cat-factory/prompt-fragments@0.14.6
  - @cat-factory/spend@0.12.76

## 0.143.1

### Patch Changes

- 8254367: Lint tightening: ratchet oxlint `complexity` from 40 to its step-2 target of 30.

  Refactored every function above complexity 30 along cohesive, behaviour-neutral seams (helper
  extractions / options-object bundles), including the god-file offenders: the Worker
  `buildContainer` registry resolution → a `container-registries.ts` sibling, `RunDispatcher`'s
  settled-poll branch tree → a new `PollCompletionController`, and `ExecutionService.stepInstance`'s
  re-entrancy predicate → a `reentrancy.logic.ts` sibling (both of which also shrink their host
  god-files). The executor-harness image tag is bumped (harness `src/**` changed).

- Updated dependencies [8254367]
  - @cat-factory/orchestration@0.133.2
  - @cat-factory/integrations@0.91.1
  - @cat-factory/agents@0.68.2

## 0.143.0

### Minor Changes

- 2323df1: Enable/disable + pinned default for the two credential pools (subscription tokens and
  direct-provider API keys).

  A pool can hold several credentials "for the same thing" — several subscription tokens per
  (workspace, vendor), or several API keys per (scope, provider). Previously the only lever was
  delete, and selection was pure usage-aware rotation. Now each credential carries two lifecycle
  flags, editable via a new `PATCH` endpoint (`{ enabled?, isDefault? }`):

  - **Enable / disable** — a disabled credential stays in the pool (still listed and
    re-enablable) but is never leased and no longer makes its vendor/provider "configured", so
    the model picker and pipeline-start guard treat an all-disabled provider as unconfigured.
  - **Pinned default** — one credential per group can be pinned as the preferred one; it is
    leased in preference to usage-aware rotation. At most one default per group (setting one
    clears the prior), and a disabled default is ignored (leasing falls back to rotation among
    the remaining enabled credentials).

  New wire fields `enabled` / `isDefault` on `apiKeySchema` + `vendorCredentialSchema`; new
  `PATCH /workspaces/:ws/vendor-credentials/:id`, `PATCH …/api-keys/:id` (workspace + `/me` +
  account scopes). Persisted as `enabled` / `is_default` columns mirrored across all three stores
  (D1, Drizzle/Postgres, and the local `node:sqlite` credential store), with the lease/list
  queries filtering disabled and ordering the default first. The **LLM Vendors** UI gains a
  default toggle + an enable/disable switch per credential. A new cross-runtime conformance suite
  asserts the enable/disable + default behaviour against every store.

  This is an additive, backwards-compatible schema change: existing credentials read as enabled
  and not-default, so behaviour is unchanged until an operator opts in.

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0
  - @cat-factory/integrations@0.91.0
  - @cat-factory/agents@0.68.1
  - @cat-factory/orchestration@0.133.1
  - @cat-factory/prompt-fragments@0.14.5
  - @cat-factory/spend@0.12.75

## 0.142.0

### Minor Changes

- 71bd63f: Review adherence reports + per-agent effort self-assessment, surfaced in run details.

  - **Best-practice fragments are now fed granularly.** Each selected best-practice standard is
    folded into an agent's system prompt as its OWN delimited, labelled block (carrying a stable
    id and its human title) instead of one `\n\n`-joined blob, so an agent can tell the standards
    apart and cite one by title. Fragment titles are threaded end-to-end (resolver → resolved
    fragments → prompt composer).
  - **Code + PR review agents report best-practice adherence.** The `reviewer` companion and the
    `pr-reviewer` now return a `fragmentAdherence` list — per standard, a 1..10 rating of how well
    the reviewed change/PR adheres plus the issues that standard surfaced — recorded on the step
    (`PipelineStep.fragmentAdherence`) and surfaced in run details + the PR-review window. When no
    best-practice standards were reachable, the reviewer states so explicitly.
  - **Every container agent reports effort.** Each container agent is asked to write a short effort
    self-assessment (how hard the work was, what reduced its effectiveness, the key obstacles) to a
    sentinel file the harness lifts onto the result; the engine records it (`PipelineStep.effortReport`)
    and it is shown in run details. Flows through both runtimes (verbatim on Cloudflare/local, coerced
    on the self-hosted runner pool). Requires the bumped executor-harness image.
  - **Fragment management UI.** The fragment editor gains an "auto-generate title" button (an inline
    LLM call) and inline editing of a hand-authored fragment's title / summary / body / tags.

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0
  - @cat-factory/agents@0.68.0
  - @cat-factory/orchestration@0.133.0
  - @cat-factory/integrations@0.90.0
  - @cat-factory/prompt-fragments@0.14.4
  - @cat-factory/spend@0.12.74

## 0.141.3

### Patch Changes

- Updated dependencies [da0b83b]
  - @cat-factory/agents@0.67.9
  - @cat-factory/orchestration@0.132.3

## 0.141.2

### Patch Changes

- 2cfae1e: Internal refactor (lint complexity/size ratchet — `complexity` 60 → 40): extract cohesive helpers
  from the ten functions above cyclomatic complexity 40 so each lands under the new ceiling, all
  behaviour-neutral. No public API, wire shape, or runtime behaviour changes; verified by the
  server / orchestration / agents unit suites and the node config specs (the cross-runtime
  conformance + worker suites run in CI).

  - `@cat-factory/server`: `buildRegisteredAgentBody` split into `buildCodingAgentBody` /
    `buildExploreAgentBody`; `toRunResult` into `coerceCustomResult` / `mapPushOrPrResult`;
    `ContainerAgentExecutor.pollJob`'s subscription/quota usage feedback moved into
    `recordSubscriptionUsageOnce` / `recordSubscriptionQuotaUsageOnce`; the workspace snapshot
    handler's optional-field spread ladder folded into a `definedFields` helper.
  - `@cat-factory/orchestration`: `AgentContextBuilder.buildContext`'s `block` sub-payload extracted
    into `buildBlockPayload`.
  - `@cat-factory/agents`: `coerceInitiativePlan`'s section loops extracted into
    `coerceInitiativePhases` / `coerceInitiativeItems` / `coerceInitiativeDecisions`.
  - `@cat-factory/node-server`: `buildAuthConfig`'s enablement prelude + fail-fast guards extracted
    into `resolveNodeAuthEnablement`.
  - `@cat-factory/worker`: `loadAuthConfig`'s enablement prelude extracted into `resolveAuthEnablement`.
  - `@cat-factory/executor-harness`: `parseAgentJob` split into `parseAgentOutputSpec` /
    `parseAgentPrSpec` / `assembleAgentJob`. Touches the runner image, so its tag is bumped
    (1.50.11) and the three pins re-synced.
  - `@cat-factory/local-server`: carries the re-synced `RECOMMENDED_HARNESS_IMAGE` pin.

- Updated dependencies [2cfae1e]
  - @cat-factory/orchestration@0.132.2
  - @cat-factory/agents@0.67.8

## 0.141.1

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/integrations@0.89.0
  - @cat-factory/kernel@0.150.0
  - @cat-factory/agents@0.67.7
  - @cat-factory/orchestration@0.132.1
  - @cat-factory/prompt-fragments@0.14.3
  - @cat-factory/spend@0.12.73

## 0.141.0

### Minor Changes

- 916278b: feat(frontend-extension-mechanism slice B): custom task types — a deployment-registered work
  item (an "incident", "pentest", "compliance-audit") is now a first-class create-task choice +
  card badge, symmetric with custom agent kinds, with zero host edits.

  - **Contracts.** `taskTypeSchema` / `createTaskTypeSchema` widen from a closed picklist to
    `picklist ∪ namespaced` (`<ns>:<name>`) — the shape `presentation.resultView` already uses. The
    result-view-only `NAMESPACED_RESULT_VIEW_ID_PATTERN` is generalized into a shared `primitives.ts`
    atom (`NAMESPACED_ID_PATTERN` / `isNamespacedId` / `namespacedIdSchema`) reused across every
    extension surface. New `customTaskTypeSchema` (+ `taskTypeFieldDescriptorSchema`), a sparse
    `taskTypeFields.custom` bag for descriptor values, and `workspaceSnapshot.customTaskTypes`.
  - **Kernel.** App-owned `TaskTypeRegistry` (`defaultTaskTypeRegistry()`, empty), mirroring
    `AgentKindRegistry`/`PipelineRegistry`; `defaultPipelineIdForTaskType` consults it after the
    built-in map.
  - **Orchestration.** `CoreDependencies.taskTypeRegistry` threaded into `BoardService` + re-exposed
    on `Core`; `validateRegistrations` gains task-type checks (namespaced id, `formPanel`,
    `defaultPipelineId` resolves).
  - **Server + all three facades.** Snapshot projects `customTaskTypes` (shared `WorkspaceController`);
    the Worker / Node / local facades build, install, validate, and re-export the registry (a
    `taskTypeRegistry` option on `createApp`/`start`/`startLocal`).
  - **Frontend (`@cat-factory/app`).** A `taskTypes` slot + a `useTaskTypesStore` (cloning the
    agents-store merge → `taskTypeMeta` read-model); `buildAgentCapabilitiesManifest` generalized to
    one `buildWorkspaceCapabilitiesManifest(kinds, taskTypes)` carrying both slots (agents store's
    `hydrateCustomKinds` → `hydrateCapabilities`). `AddTaskModal` merges custom types into its picker
    and renders their descriptor fields (or a `taskTypeFormPanels`-paired section) into
    `taskTypeFields.custom`; `TaskCard` shows a type badge via `taskTypeMeta` (unregistered
    namespaced types degrade to the `feature` presentation).

  Cross-runtime conformance asserts the backend round-trip on both runtimes; the `deploy/frontend`
  `acme:security` module dogfoods a CODE-shipped `acme:incident` task type end to end (e2e).

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0
  - @cat-factory/orchestration@0.132.0
  - @cat-factory/agents@0.67.6
  - @cat-factory/integrations@0.88.18
  - @cat-factory/prompt-fragments@0.14.2
  - @cat-factory/spend@0.12.72

## 0.140.7

### Patch Changes

- 1bcb223: Internal refactor (lint complexity/size ratchet — `max-lines-per-function` step 1.5, 1000 → 632):
  split the product functions above the new ceiling along cohesive seams, all behaviour-neutral. No
  public API, wire shape, or runtime behaviour changes.

  - `@cat-factory/kernel`: `seedPipelines` split into three module-level catalog builders it composes.
  - `@cat-factory/server`: `publicApiController` / `authController` split into per-route-group registrars
    (mirroring `registerCoreControllers`'s mount groups).
  - `@cat-factory/app`: the `board` Pinia store's write operations extracted into `stores/board/`
    factories (`createBoardMutations` / `createBoardRemoval`) over a shared `BoardWriteContext`.
  - `@cat-factory/node-server`: `buildNodeContainer` split into `assembleNodeCoreDependencies` +
    `projectNodeServerContainer` (the `CoreDependencies` object and the `ServerContainer` projection).
  - `@cat-factory/local-server`: `buildLocalContainer`'s `buildNodeContainer` options extracted into
    `buildLocalNodeOptions`.

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5
  - @cat-factory/agents@0.67.5
  - @cat-factory/integrations@0.88.17
  - @cat-factory/orchestration@0.131.7
  - @cat-factory/spend@0.12.71

## 0.140.6

### Patch Changes

- e86e95b: fix(board): stop the board churning on inspector edits + widen the custom-manifest picker

  Two Test Infrastructure inspector papercuts:

  - **Board no longer jumps when a Provision Type is selected.** `updateBlock` echoed its
    coarse `board` event back to the acting tab, forcing a full board re-hydrate on every
    field edit (each provision-type click). It now forwards the acting tab's
    `X-Connection-Id` and the realtime transport suppresses that self-echo — the same
    contract `moveBlock`/`reparent` already follow. The tab still applies the change from its
    REST response; every other subscriber still refreshes.
  - **The custom manifest-type picker renders full-width.** The `USelect` (and its path
    input) carried no width, so as an `inline-flex` control it and its dropdown rendered as a
    narrow box overlapping the hint text. Added `w-full` to match every other select.

- Updated dependencies [e86e95b]
  - @cat-factory/orchestration@0.131.6

## 0.140.5

### Patch Changes

- 91ea6b7: observability: forward the container agent's liveness heartbeat so a quiet-but-alive run stops looking wedged.

  A long, output-less phase — a `pr-reviewer` reading hundreds of files, say — advances the harness heartbeat but not its subtask counts. That heartbeat was dropped at the transport boundary: `ContainerAgentExecutor.pollJob` forwarded phase/progress/follow-ups but never `view.heartbeatAt`, so `agent_runs.updated_at` only moved on a progress change. A live-but-quiet run was indistinguishable from a wedged one to the DB, the stale-run sweeper (keys off `updated_at`), and the UI (a client clock off `startedAt`, not a server liveness signal). This is the observable-heartbeat gap ADR 0026 P3 named (its D2.1/D3 restored progress + the watchdog heartbeat, not the observable one).

  `RunnerJobView` now carries `heartbeatAt` (Cloudflare/local cast the harness view verbatim; the runner pool maps an optional `heartbeatPath`), `pollJob` forwards it as the running `AgentJobUpdate.lastActivityAt`, and the engine folds it onto the step's new `lastActivityAt` **throttled** (`shouldPersistActivity`, a 20s window well under the 5-min sweeper lease) — so a live-but-quiet run keeps `updated_at` fresh while a wedged run's frozen heartbeat correctly lets it go stale. The field rides the step JSON, so both runtimes persist it with no migration. The SPA surfaces "active Ns ago" in `StepRunMeta` (and thus the PR-review window), distinct from the elapsed clock. No harness change (the `heartbeatAt` field already exists), so no image bump.

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4
  - @cat-factory/orchestration@0.131.5
  - @cat-factory/integrations@0.88.16
  - @cat-factory/agents@0.67.4
  - @cat-factory/prompt-fragments@0.14.1
  - @cat-factory/spend@0.12.70

## 0.140.4

### Patch Changes

- 3999941: pr-reviewer: prefetch the reviewed PR head so the review can see the proposed code.

  A `pr-reviewer` clones only the base branch and the container agent holds no git credential of its own, so files the PR ADDS (not on the base checkout) and the head version of modified files were unreachable — the review was silently limited to the ~256 KiB of patches inlined in `.cat-context/pr-diff.md`, and the prompt's `git fetch origin pull/<n>/head` fallback fails on a private repo. On a 518-file PR that meant only ~29 files were fully reviewable.

  The engine now resolves the reviewed PR number (new `AgentCloneSpec.prHead`, set on the pr-reviewer kind) into the job's `reviewPrNumber`, and the harness fetches `pull/<n>/head` (GitHub) / `merge-requests/<n>/head` (GitLab) into `origin/pr-head` with its own token before the run — mirroring the reference-branch prefetch. The reviewer prompt + injected diff now point at `origin/pr-head` for full head file bodies. Best-effort: a failed fetch leaves the review on the base checkout + injected diff as before.

  The injected `.cat-context/pr-diff.md` also gains a per-file patch cap (32 KiB): a single oversized patch (a lockfile, a snapshot, a vendored blob) is now stubbed with an `origin/pr-head` pointer instead of being inlined, and no longer draws down the global 256 KiB budget — so one giant generated diff can't starve the many small, reviewable source patches. The head prefetch makes the stubbed files readable on demand.

  Harness (image bump): the `agent` job gains an optional `reviewPrNumber?: number`.

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3
  - @cat-factory/agents@0.67.3
  - @cat-factory/integrations@0.88.15
  - @cat-factory/orchestration@0.131.4
  - @cat-factory/spend@0.12.69

## 0.140.3

### Patch Changes

- Updated dependencies [b1d1e2c]
  - @cat-factory/prompt-fragments@0.14.0
  - @cat-factory/orchestration@0.131.3
  - @cat-factory/agents@0.67.2

## 0.140.2

### Patch Changes

- 021f2a0: Surface + remediate ENCRYPTION_KEY drift (ADR 0026 D6.2/D6.3), building on the D6.1 fingerprint
  and typed `SecretDecryptError`.

  - A new `SealedSecretInventory` kernel port (`listSealed` + `drop`) is implemented per runtime
    (D1 + Drizzle, asserted by `defineSealedSecretInventorySuite`) over `environment_connections`
    and `observability_connections`. Adding a source is a change to the inventory pair, never the
    sweep.
  - `sweepKeyDriftAndRaise` (runtime-neutral) attempts a decrypt of every sealed secret, buckets by
    `reason`, and raises ONE `key_drift` notification per affected workspace — listing the affected
    credentials by source / id / label / reason / seal time (never the value), de-duped on that set
    and auto-cleared when a workspace recovers. It runs at Node boot and on the Worker's daily cron.
  - Remediation (D6.3) is explicit + per-secret: the `key_drift` card's action drops every credential
    it lists, and a `pnpm --filter @cat-factory/node-server key-drift:drop` operator CLI drops one.
    Both flip the owning connection to needs-re-entry (env → soft-delete, observability → row delete)
    and state that restoring the previous ENCRYPTION_KEY recovers the values instead — never automatic.
  - Adds the `key_drift` notification type (contracts) + its inbox card copy across all locales.

- 021f2a0: Detect ENCRYPTION_KEY drift at boot via a master-key fingerprint (ADR 0026 D6.1), and make a
  decrypt failure classifiable (D6.2 foundation).

  - A non-secret `HKDF(masterKey, "cat-factory:key-fingerprint")[:8]` fingerprint is persisted
    once in a new `key_fingerprint` singleton table (D1 + Drizzle, mirrored per runtime) and
    recompared on every boot: the Node facade checks right after `migrate()`, and the Worker on
    its daily cron. A mismatch logs a definitive "the key changed since secrets were last
    sealed" signal before any request touches a stale secret, instead of the old stream of
    opaque per-request decrypt errors.
  - `SecretCipher.decrypt` now throws a typed `SecretDecryptError` carrying a
    `reason: 'key-mismatch' | 'corrupt'` discriminant, so a drift sweep can bucket a failure
    without parsing message text.

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2
  - @cat-factory/integrations@0.88.14
  - @cat-factory/agents@0.67.1
  - @cat-factory/orchestration@0.131.2
  - @cat-factory/prompt-fragments@0.13.48
  - @cat-factory/spend@0.12.68

## 0.140.1

### Patch Changes

- Updated dependencies [90a0c1b]
  - @cat-factory/orchestration@0.131.1

## 0.140.0

### Minor Changes

- a14fe03: PR deep-review: add per-finding **Dismiss** and **Challenge** actions to the review window.

  Dismiss drops a finding entirely (pruning it from the selection); the run stays parked. Challenge
  dispatches a new read-only `challenge-investigator` agent kind against a single finding — with an
  optional specific concern, or a generic "dig deeper + validate" prompt — which re-examines it
  against the full source and reaches a verdict: `upheld` (kept as written), `amended` (kept and
  actually strengthened/clarified), or `retracted` (auto-deselected, struck through, and no longer
  actionable — nor re-challengeable). A challenge whose investigator job fails settles the finding
  `failed` and re-parks the review rather than failing the whole run, so a crashed second opinion
  never nukes the human's in-flight curation. The investigator is its own agent kind, so it can be
  pointed at a different (stronger) model than the reviewer via a per-kind model-preset override. All
  state rides `step.prReview` / `step.pendingChallenge` (no side table), so it stays runtime-symmetric;
  the cross-runtime conformance suite asserts dismiss, challenge-retract, challenge-uphold-strengthen,
  challenge-uphold-as-is, and challenge-investigator-failure.

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/agents@0.67.0
  - @cat-factory/orchestration@0.131.0
  - @cat-factory/integrations@0.88.13
  - @cat-factory/kernel@0.148.1
  - @cat-factory/prompt-fragments@0.13.47
  - @cat-factory/spend@0.12.67

## 0.139.0

### Minor Changes

- 8053837: PR deep-review `post`: guard against comment position drift when the PR branch is updated
  after a review starts. The reviewer's dispatch now captures the PR head sha
  (`reviewedHeadSha`), and the `post` resolution re-reads the current head before publishing:
  if the branch moved, every finding is folded into the summary comment instead of being
  anchored to a line number that may have shifted, so comments can't land on the wrong code.
  Adds an optional `pullRequestHeadSha` read to the `GitHubClient`/`VcsClient`/`RepoFiles`
  ports (best-effort; the check is inert where a provider can't read it).

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/orchestration@0.130.0
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0
  - @cat-factory/agents@0.66.7
  - @cat-factory/integrations@0.88.12
  - @cat-factory/prompt-fragments@0.13.46
  - @cat-factory/spend@0.12.66

## 0.138.16

### Patch Changes

- 511076d: Make the `pr-reviewer` agent comment-aware. A second preOp injects the PR's existing review threads (prior review rounds, human reviewers, other bots) as `.cat-context/pr-existing-comments.md` via a new optional `RepoFiles.listReviewThreads`, and the reviewer prompt now de-dups against them — skip issues already raised, focus on what is new or still unaddressed. Reuses the `listReviewThreads` read already implemented for the `human-review` gate (forwarded by `vcsBackedGitHubClient`, so GitLab gets it for free); passes through unchanged when the client can't read threads.
- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3
  - @cat-factory/agents@0.66.6
  - @cat-factory/integrations@0.88.11
  - @cat-factory/orchestration@0.129.11
  - @cat-factory/spend@0.12.65

## 0.138.15

### Patch Changes

- Updated dependencies [1614e62]
  - @cat-factory/agents@0.66.5
  - @cat-factory/orchestration@0.129.10

## 0.138.14

### Patch Changes

- 7f54858: Make the PR deep-review `post` resolution observable, partial-tolerant, and retryable — and fix its root-cause 422.

  Previously `post` submitted the selected findings as ONE atomic `COMMENT` review. GitHub rejects the whole review if any inline comment anchors a line outside the PR diff ("Line could not be resolved"), so a single bad finding failed all of them; the run then failed with the error visible only after closing the window, which read as a stuck "Posting…" spinner.

  Now:

  - **Root cause fixed.** The engine parses the PR diff (`computeCommentableLines`) and folds any finding whose line isn't in the diff into the summary comment instead of sending an inline comment GitHub would reject.
  - **Per-comment posting + observability.** `RepoFiles.createReview` (and the underlying `GitHubClient`/`VcsClient` port) now posts each inline comment individually and returns a per-comment `CreateReviewResult`, so anchorable comments land while the rest are reported. The outcome is recorded on `step.prReview.postReport` (how many of how many posted, per-finding failures + reasons, folded count), which the deep-review window renders.
  - **No more stuck spinner; retry only the posting.** A partial or failed post re-parks the review at `awaiting_selection` carrying the report (instead of failing the whole run), so the human sees what happened and can retry ONLY the posting — `post` skips findings already posted (`postedFindingIds`) so a retry never double-posts — or switch to `fix`/`finish`.

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2
  - @cat-factory/orchestration@0.129.9
  - @cat-factory/agents@0.66.4
  - @cat-factory/integrations@0.88.10
  - @cat-factory/prompt-fragments@0.13.45
  - @cat-factory/spend@0.12.64

## 0.138.13

### Patch Changes

- 26f7c18: Lint ratchet: `max-statements` from its pinned baseline (157) down below 60 (no behavioural
  change).

  Every function above 50 statements is split along a cohesive seam so the `.oxlintrc.json`
  `max-statements` ceiling can drop from 157 to 50. All extractions are behaviour-neutral (moved
  code verbatim into well-named helpers, destructured at the top so the remaining bodies are
  unchanged; verified by the package unit suites and the cross-runtime conformance suites on real
  Postgres/workerd in CI):

  - **`createUiModals`** (`app/stores/ui/modals.ts`, 157): the flat bag of modal refs + open/close
    handlers is grouped into cohesive sub-factories (`createHealthAdvisoryModals`,
    `createDocumentTaskModals`, `createIntegrationPanelModals`, `createSettingsModals`,
    `createInfraModals`, `createAiOnboardingModals`, `createMiscModals`) composed behind the shared
    hub came-from markers; the returned public surface is unchanged.
  - **the LLM proxy handler** (`server/modules/llmProxy/LlmProxyController.ts`, 108): the workers-ai
    ceiling, the in-process dispatch, upstream resolution (local runner vs the DB-backed key pool),
    and the response relay are extracted into `applyWorkersAiCeiling` / `dispatchInProcess` /
    `resolveUpstreamTarget` / `relayUpstream` behind a per-call `ProxyCallContext`.
  - **`registerCoreControllers`** (`server/app.ts`, 77): the controller mounts split into
    `registerRootControllers` / `registerWorkspaceControllers` / `registerWebhookControllers`
    (exact mount order preserved).
  - **`resolveAuxiliaryRepos`** (`server/agents/ContainerAgentExecutor.ts`, 75),
    **`checkEntityCallScope`** (`server/persistence/rpc.ts`, 63), and the screenshot handler
    (`server/modules/artifacts/HarnessArtifactController.ts`, 51) are split along their existing
    seams.
  - **`provisionRecipe`** (`integrations/modules/compose/ComposeEnvironmentProvider.ts`, 94):
    decomposed into `preflightRecipe` / `readRecipeComposeFiles` / `materializeRecipeEnvFiles` /
    `runComposeBuildAndUp` / `runRecipeStepsAndGate` / `resolvePreviewUrl`. `bringUp`
    (`SharedStackService.ts`, 60), `buildKubernetesRecommendation` /
    `detectFrontendConfig` (`environments/*-detect.logic.ts`, 58/52) split similarly.
  - **`buildNodeContainer`** (`node/container.ts`, 63), the stale-run sweeper `tick`
    (`node/execution/pgBossRunner.ts`, 54), `bootServer` (`node/server.ts`, 53), and
    `buildLocalContainer` (`local/container.ts`, 51) extract cohesive sub-builders / sweeper
    closures.
  - **the coder container callbacks** (`executor-harness/src/coding-agent.ts`, 67/63) extract
    `prepareCodingCheckout` / `finalizeCodingRun` / `prepareMultiRepoCheckouts` /
    `pushMultiRepoLegs`. The harness image tag is bumped accordingly.
  - **orchestration**: `createCore` (`container.ts`, 71), the `RunDispatcher` step handlers
    (66/60), `SandboxRunService` (59), and `CompanionController` (56) split along cohesive seams.

- Updated dependencies [26f7c18]
  - @cat-factory/orchestration@0.129.8
  - @cat-factory/integrations@0.88.9

## 0.138.12

### Patch Changes

- e4efb5f: Lint ratchet: `complexity` step 1 (141 → 60; no behavioural change).

  Every function above cyclomatic-complexity 60 is split along a cohesive seam so the
  `.oxlintrc.json` `complexity` ceiling can drop from its pinned baseline (141) to the first
  real step (60). All extractions are behaviour-neutral (verified by the server + orchestration
  unit suites and the node/local config tests; the cross-runtime conformance suites cover the
  `FakeAgentExecutor` + config paths on real Postgres/workerd in CI):

  - **`loadNodeConfig`** (`node/config.ts`, 141): the giant `AppConfig`-assembly function is
    decomposed into cohesive per-section builders (`resolveProviderCaps`, `buildAgentRouting`,
    `buildGithubConfig`, `buildAuthConfig`, `buildEmailConfig`, `buildEnvironmentsConfig`,
    `buildRunnersConfig`, `buildRetentionConfig`, `buildLangfuseConfig`, `buildOtelConfig`,
    `buildExecutionConfig`).
  - **`dispatchPersistenceCall`** (`server/persistence/rpc.ts`, 101): the scope-rule enforcement
    switch is lifted into `checkCallScope`, then split again into `checkEntityCallScope` (the
    block/service/user/owner resolver kinds) + a shared `checkOwnerPairScope`, keeping the two
    switches jointly exhaustive over `ScopeRule`.
  - **`buildJobBody`** (`server/agents/ContainerAgentExecutor.ts`, 75): the multi-repo fan-out /
    conflict-resolver / merger-combined-diff / reference-repo+branch resolution is extracted into
    `resolveAuxiliaryRepos`.
  - **`FakeAgentExecutor.run`** (conformance, 68): the decision/blueprints/spec-writer/companion
    cluster moves into `runProducerKinds`.
  - **`buildNodeContainer`** (`node/container.ts`, 64): the app-owned registry resolution + EKS
    registration moves into `resolveNodeAppRegistries`.
  - **`buildLocalContainer`** (`local/container.ts`, 66): the provider-agnostic PAT/VCS-client/
    repo-origin resolution moves into `resolveLocalVcs`.
  - **`pollAgentJobInner`** (`orchestration/RunDispatcher.ts`, 61): the running-poll fold becomes
    `applyRunningFold` and the gate-helper re-probe becomes `reprobeGateAfterHelper`.

- Updated dependencies [e4efb5f]
  - @cat-factory/orchestration@0.129.7

## 0.138.11

### Patch Changes

- 972a1bd: Lint ratchet: complete `max-params` (20 → 6, its final target; no behavioural change).

  Refactored every function above the target from a long positional list to a bundled
  argument, walking the `.oxlintrc.json` ceiling down 20 → 10 → 8 → 6:

  - **DI builders → dependency objects:** the Node `buildNodeContainerExecutor`
    (`NodeContainerExecutorDeps`), the Worker `selectAgentExecutor` / `buildContainerExecutor`
    (a shared `WorkerExecutorDeps`), `buildResolveTransport`, and `selectEnvConfigRepairer`.
  - **Loop-invariant step context → one object:** the deployer fan-out (`DeployerFanOut`
    threaded through `advanceDeployerFrames` / `settleDeployerFrame` / `settleDeployerFailure` /
    `completeDeployerStep`), the companion `applyAssessment` grading bundle, the Tester
    `failTester` failure bundle, and the gate `dispatchGateHelper` helper bundle.
  - **`ExecutionService.start(...)` trailing options → `RunStartOptions`** (new
    `runStartOptions.ts`, keeping `ExecutionService.ts` under the `max-lines` ceiling), updated
    at every call site.
  - **Callback / identity bundles:** `GitHubSyncService.syncResource` handlers,
    `RequirementReviewService.runWriterForChunk` (resolved model + grounding),
    `EnvironmentConnectionService.runProviderValidate` repo target, `SkillSourceService.syncSkillDir`
    dir descriptor, and the executor-harness `streamCli` CLI descriptor.

  The executor-harness bump republishes the runner image (its `streamCli` refactor touches
  `src/**`); the three image-tag pins + `RECOMMENDED_HARNESS_IMAGE` are synced to `1.50.1`.

- Updated dependencies [972a1bd]
  - @cat-factory/orchestration@0.129.6
  - @cat-factory/integrations@0.88.8
  - @cat-factory/agents@0.66.3

## 0.138.10

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1
  - @cat-factory/integrations@0.88.7
  - @cat-factory/agents@0.66.2
  - @cat-factory/orchestration@0.129.5
  - @cat-factory/spend@0.12.63

## 0.138.9

### Patch Changes

- Updated dependencies [2d97b16]
  - @cat-factory/orchestration@0.129.4
  - @cat-factory/agents@0.66.1

## 0.138.8

### Patch Changes

- Updated dependencies [8b6fa53]
  - @cat-factory/orchestration@0.129.3

## 0.138.7

### Patch Changes

- a10bfdf: Implement the follow-ups from the PR-review run investigation (#1261): the parked PR-review
  approve bug, misleading token surfacing, and session-transcript retention.

  - **PR-review "Review & approve" now opens the findings-selection window.** A parked
    `pr-reviewer` step carries both a pending approval and `prReview.status`, so every board /
    pipeline / inspector surface funnelled its generic approval button into the prose panel (wrong
    endpoint, no findings UI) instead of `PrReviewWindow`. `dispatchStepView` now special-cases a
    step carrying `prReview` (mirroring the `consensus` case) and `pr-reviewer` is modelled in the
    frontend catalog with `resultView: 'pr-review'`, so the existing approval button routes
    correctly. A dedicated "Review findings" chip (mirroring the fork-decision chip) is added to the
    pipeline rail and the inspector.

  - **Container token usage records the real model.** The durable poll path
    (`ContainerAgentExecutor.pollJob`) folds `handle.model` onto the result, so `spend.record` /
    `token_usage` records the actual `provider:model` instead of `unknown` / `""`.

  - **Token surfaces separate fresh vs cached input.** A long agentic run re-sends its whole
    transcript every turn, so the raw prompt-token sum is ~all cache reads and reads as a blow-up.
    The step-metrics bar and the observability panel now show FRESH (uncached) input as the headline
    with the cached prefix called out separately (a new `freshPromptTokens` helper).

  - **Session transcripts are retained for 3 days.** Both subscription runners
    (`runClaudeCode` / `runCodex`) deleted the isolated config home — with the CLI session
    transcripts — in `finally`. A new `retainSessionTranscripts` lifts ONLY the transcript subtree
    (`projects/` / `sessions/`) out to a retention root before the credential-bearing home is
    deleted, and prunes on a 3-day TTL (overridable via `HARNESS_TRANSCRIPT_TTL_MS` /
    `HARNESS_TRANSCRIPT_ROOT`). The credential at the home root is still removed.

- a10bfdf: Hand the `pr-reviewer` the PR diff up front to cut token burn.

  A deep PR review used to clone the base branch and reconstruct the diff by hand (many `git diff`
  runs + grep passes), and each agentic turn re-sends the whole growing transcript — so the
  discovery turns dominated the run's token cost. A new `pr-reviewer` preOp now computes the
  changed-file list + per-file patches on the backend (via the previously-dormant
  `GitHubClient.listChangedFiles`) and injects them as `.cat-context/pr-diff.md`, so the agent plans
  its slices from a prepared artifact instead of rebuilding the diff.

  Backend-only and runtime-symmetric (rides the shared `ContainerAgentExecutor` + the HTTP-only
  `RepoFiles` port), no harness image bump. New seams: `RepoFiles.listChangedFiles?` (forwarded from
  the wired client), and `RepoOpResult.contextFiles` → `AgentRunContext.injectedContextFiles` so a
  preOp can hand the agent context files up front. The full base clone + git fallback stay, so a
  deployment without the capability (or an unresolvable PR) passes through unchanged. See
  `docs/initiatives/pr-review-turn-reduction.md`.

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0
  - @cat-factory/agents@0.66.0
  - @cat-factory/orchestration@0.129.2
  - @cat-factory/integrations@0.88.6
  - @cat-factory/spend@0.12.62

## 0.138.6

### Patch Changes

- Updated dependencies [7aab031]
  - @cat-factory/orchestration@0.129.1
  - @cat-factory/agents@0.65.5

## 0.138.5

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/orchestration@0.129.0
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1
  - @cat-factory/agents@0.65.4
  - @cat-factory/integrations@0.88.5
  - @cat-factory/spend@0.12.61
  - @cat-factory/prompt-fragments@0.13.44

## 0.138.4

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/orchestration@0.128.0
  - @cat-factory/agents@0.65.3
  - @cat-factory/integrations@0.88.4
  - @cat-factory/kernel@0.145.1
  - @cat-factory/prompt-fragments@0.13.43
  - @cat-factory/spend@0.12.60

## 0.138.3

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0
  - @cat-factory/orchestration@0.127.0
  - @cat-factory/agents@0.65.2
  - @cat-factory/integrations@0.88.3
  - @cat-factory/prompt-fragments@0.13.42
  - @cat-factory/spend@0.12.59

## 0.138.2

### Patch Changes

- Updated dependencies [2138e45]
  - @cat-factory/integrations@0.88.2
  - @cat-factory/orchestration@0.126.1

## 0.138.1

### Patch Changes

- 54c44bb: feat: add a selectable `purpose` classifier to pipelines (`build` / `document` / `review` / `research` / `planning`)

  Pipelines now carry an explicit use-case classifier instead of it being inferred from their steps. It is chosen in the pipeline builder (a new selector), stamped on every built-in preset in `seedPipelines()`, and persisted in a new `pipelines.purpose` column (mirrored D1 ⇄ Drizzle).

  Two surfaces key off it, sharing the pure predicates in `@cat-factory/contracts` (`pipelineAllowedForTaskType`, `purposeAllowsAgentCategory`):

  - **Task pickers** — a `document` task now offers ONLY document pipelines (the add-task modal, the task run-settings default, and the focus-view run menu), and the add-task form defaults a document task to the `pl_document` writing pipeline. Every other task type is unrestricted.
  - **Builder palette** — selecting a non-`build` purpose hides the Implementation and Testing agent kinds (a document/review/research/planning pipeline writes no product code and runs no tests).

  Every built-in pipeline's `version` is bumped so existing workspaces are offered a reseed that stamps the new `purpose`. Breaking-change note (pre-1.0, no back-fill): a pipeline persisted before this change reads as unclassified — shown everywhere except a document task — until it is reseeded (built-ins) or re-saved with a purpose (custom).

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0
  - @cat-factory/orchestration@0.126.0
  - @cat-factory/agents@0.65.1
  - @cat-factory/integrations@0.88.1
  - @cat-factory/prompt-fragments@0.13.41
  - @cat-factory/spend@0.12.58

## 0.138.0

### Minor Changes

- 0abcf31: Add an authored `description` to pipelines and preview a pipeline's steps + description when
  selecting one.

  Pipelines now carry an optional prose `description` (seeded for every built-in, editable on custom
  pipelines in the builder), persisted alongside the step list on both runtimes (D1 + Postgres). The
  pipeline pickers — in the add-task modal and the inspector run settings — are replaced with a rich
  master–detail picker: hovering an option reveals that pipeline's description and its ordered agent
  steps (with human-gated steps flagged), so you can see exactly what a pipeline does before choosing
  it.

  Every built-in pipeline's catalog `version` is bumped by one so existing workspaces are offered a
  reseed that adopts the new descriptions (fresh workspaces get them on seed).

- 6709dc4: Migrate the last module-global plugin registries to app-owned DI (the registry-DI initiative):
  pipelines, VCS providers, provider tokens, and agent traits now ride the composition root's
  injected instances instead of a process-wide `Map`, removing the `clear*()` test cruft and the
  phantom-`Map` hazard for separately-published adapter packages (e.g. `@cat-factory/gitlab`).

  **Breaking (pre-1.0, no back-compat):** the following free functions are removed in favour of the
  app-owned registry instances a facade injects:

  - **Pipelines** (`@cat-factory/kernel`): `registerPipeline` / `registerPipelines` /
    `registeredPipelines` / `clearRegisteredPipelines` / `mergeRegisteredPipelines` →
    `PipelineRegistry` (`register` / `registerMany` / `registered` / `merge`) + `defaultPipelineRegistry()`.
    `seedPipelines(registry?)` now takes the registry (the no-arg form returns the built-in catalog).
  - **VCS providers** (`@cat-factory/kernel`): `registerVcsProvider` / `getVcsProvider` /
    `resolveVcsProvider` / `requireVcsProvider` / `isVcsProviderRegistered` / `registeredVcsProviders` /
    `clearVcsProviders` → `VcsProviderRegistry` + `defaultVcsRegistry()` (a required `ServerContainer`
    field, so facade parity is type-enforced). `@cat-factory/gitlab`'s `registerGitLab` now takes the
    registry as its first argument.
  - **Provider tokens** (`@cat-factory/kernel`): `wireProvider` / `getProvider` / `isProviderWired` /
    `requireProvider` / `clearProviders` → `ProviderRegistry` + `defaultProviderRegistry()`, read by the
    gate machine's `GateContext` (which gains `isProviderWired`). The `@cat-factory/gates` `wireX` /
    `applyGateProviders` / `warnUnwiredGates` handles take the registry as their first argument;
    `clearGateProviders` is no longer needed by a facade (a fresh registry per build starts empty).
  - **Agent traits** (`@cat-factory/agents`): `registerAgentTrait` / `registerAgentTraits` /
    `registeredAgentTrait` / `clearRegisteredAgentTraits` / `assignAgentTraits` /
    `clearAssignedAgentTraits` are folded onto the app-owned `AgentKindRegistry`
    (`registerTrait` / `registerTraits` / `traitDefinition` / `assignTraits` / `assignedTraitsFor`);
    `traitsFor` / `hasTrait` / `traitGuidanceFor` keep their signatures. `@cat-factory/consensus`'s
    `registerConsensusTraits` now takes the registry as its first argument.

- a53bbf7: Attach repo files as task context via a repository picker. When a repo-backed
  document source (GitHub / GitLab) is selected in the context-document picker, the
  user now searches for a repository (reusing the shared server-side repo search),
  then picks one or more files from it — either by searching the whole tree by path
  or by browsing it with the monorepo directory browser, which now supports
  multi-pick in file mode. Backed by a new recursive repo-tree read (`listTree` on
  the VCS/GitHub client ports, `GET /github/repos/:id/files`) so file search is a
  single cached call per repo instead of walking the tree level-by-level.

### Patch Changes

- 009bc97: Surface the real cause when a task attachment can't be linked, instead of a bare
  "1 attachment could not be linked".

  - The context-linking path no longer swallows the error: `linkPending` now returns
    each failure with the server's own message, HTTP status, backend code, and the backend
    `details` bag, and the add-task toast shows the specific reason (e.g. a GitHub
    permission/visibility error) with a one-click "Copy details" button that puts a full
    diagnostic report on the clipboard (including the upstream GitHub status, kept distinct
    from the mapped HTTP status).
  - `GitHubDocsProvider` classifies a failed doc read (403 no-access, primary/secondary
    rate-limit, 404/not-found, other) into a specific, actionable domain error carrying the
    repo coordinates + HTTP status, and logs it with full context — so a permission problem
    is no longer masked as an opaque 500 and is diagnosable server-side.
  - `GitHubApiError` now retains the `rateLimited` (`x-ratelimit-remaining: 0`) signal
    structurally, so a GitHub PRIMARY rate-limit (reported as a 403, not a 429) is
    classified as a rate-limit rather than a spurious "missing read access" permission error.
  - Added a reusable `copyAction` toast-action helper on `useCopyToClipboard`.

- Updated dependencies [009bc97]
- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/integrations@0.88.0
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/orchestration@0.125.0
  - @cat-factory/agents@0.65.0
  - @cat-factory/prompt-fragments@0.13.40
  - @cat-factory/spend@0.12.57

## 0.137.10

### Patch Changes

- Updated dependencies [4dbf0fc]
  - @cat-factory/orchestration@0.124.2

## 0.137.9

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0
  - @cat-factory/integrations@0.87.0
  - @cat-factory/agents@0.64.2
  - @cat-factory/orchestration@0.124.1
  - @cat-factory/spend@0.12.56

## 0.137.8

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0
  - @cat-factory/orchestration@0.124.0
  - @cat-factory/agents@0.64.1
  - @cat-factory/integrations@0.86.6
  - @cat-factory/spend@0.12.55

## 0.137.7

### Patch Changes

- 37c642f: Migrate the `blueprints` and `spec-writer` container agent kinds onto the public
  `registerAgentKind` seam (refactoring-candidates.md #5, the manifest-driven agent-kind
  strangler).

  Their role/system prompts, structured shape hints, and per-kind user-prompt builders
  (`blueprintUserPrompt` / `specWriterUserPrompt`) move from `@cat-factory/server`'s
  `agents/prompts.ts` down into `@cat-factory/agents` (`agents/kinds/spec-blueprints.ts`),
  where each is registered as a read-only structured `container-explore` kind (blueprints
  clones the PR branch; spec-writer clones the per-block work branch with
  `failOnUnusableFinal`). Their kind-id constants (`BLUEPRINTS_AGENT_KIND` /
  `SPEC_WRITER_AGENT_KIND`) now live next to the definitions and are re-exported by
  orchestration's `ci.logic.ts` for the engine's existing call sites — the same pattern the
  inline reviewer/brainstorm ids use.

  The generic `registry.agentStep(...)` dispatch path in the server's `buildKindBody` now
  renders their job body, so **both cases are deleted from `buildMigratedBuiltInBody`** and
  the pair are removed from `CompositeAgentExecutor`'s hard-coded `CONTAINER_KINDS` set
  (container routing now derives from `registry.requiresContainer()`). Their result coercion
  still keys off their id in `toRunResult` (`blueprintService` / `spec`), and their
  deterministic render/commit post-ops stay in the engine's built-in map (their commit branch
  is resolved specially), so engine behaviour is unchanged.

  Because their prompts now resolve through `systemPromptFor`/`userPromptFor` like any
  registered kind, the surface-driven directives and declared traits are applied centrally
  rather than being bypassed by the old bespoke constant: the observable prompt change is that
  both kinds now carry the standard read-only guardrail (matching every other
  `container-explore` kind), `blueprints` now also carries its declared `spec-aware` guidance,
  and both fold in the block's selected best-practice fragments — the enrichment every other
  kind already received. Both the final-answer directive AND the read-only guardrail are now
  applied once from the surface (removed from the hand-written constants): `SPEC_WRITER_SYSTEM_PROMPT`
  no longer restates the write-prohibition the central `READ_ONLY_GUARDRAIL` owns, matching
  `BLUEPRINT_SYSTEM_PROMPT` (which never hand-embedded one) so read-only has a single source of truth.

- Updated dependencies [37c642f]
  - @cat-factory/agents@0.64.0
  - @cat-factory/orchestration@0.123.8

## 0.137.6

### Patch Changes

- ea64461: Migrate the `initiative-analyst` and `initiative-planner` container agent kinds onto the
  public `registerAgentKind` seam (refactoring-candidates.md #5, the manifest-driven
  agent-kind strangler).

  Their role/system prompts, structured shape hint, and per-kind user-prompt builders
  (`initiativeAnalystUserPrompt` / `initiativePlannerUserPrompt`, now exported) move from
  `@cat-factory/server`'s `agents/prompts.ts` down into `@cat-factory/agents`
  (`agents/kinds/initiative.ts`), where each is registered with an `agent` `AgentStepSpec`
  (`container-explore`, base-branch clone; the planner structured with
  `failOnUnusableFinal`). The generic `registry.agentStep(...)` dispatch path in the server's
  `buildKindBody` now renders their job body, so **both cases are deleted from
  `buildMigratedBuiltInBody`** and the pair are removed from `CompositeAgentExecutor`'s
  hard-coded `CONTAINER_KINDS` set (container routing now derives from
  `registry.requiresContainer()`).

  Because their prompts now resolve through `systemPromptFor`/`userPromptFor` like any
  registered kind, the surface-driven directives (the read-only guardrail +
  final-answer-in-reply) are applied centrally rather than hand-embedded in the constants —
  the only observable prompt change is that the two read-only explore kinds now carry the
  standard read-only guardrail, matching every other `container-explore` kind. Behaviour is
  otherwise unchanged; the planner's result coercion still keys off its id in `toRunResult`
  (folding that onto the definition is the remaining slice).

- Updated dependencies [ea64461]
  - @cat-factory/agents@0.63.0
  - @cat-factory/orchestration@0.123.7

## 0.137.5

### Patch Changes

- 6ad20d0: Fix the N+1 in linked-context resolution: `AgentContextBuilder` batch-resolves the tracker
  issues a task's description names explicitly via a new `TaskRepository.listByRefs` port
  method (one chunked-`IN` read per source, keyed by `(source, externalId)` refs) instead of a
  `taskRepo.get` point-read per reference inside `Promise.all`. Implemented on both facades (D1
  `D1TaskRepository` ⇄ Drizzle `DrizzleTaskRepository`) with a cross-runtime conformance
  assertion. The `'jira'`/`'github'` source literals are de-hardcoded out of the engine into
  `extractReferences`' typed `taskRefs`, the single place a reference shape binds to a task
  source.

  The new port method is also added to the mothership persistence-RPC allow-list
  (`@cat-factory/server`), since `AgentContextBuilder` invokes `listByRefs` on every
  container-agent dispatch — without the entry a no-Postgres mothership node fails every run
  with `unknown_method`.

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1
  - @cat-factory/integrations@0.86.5
  - @cat-factory/orchestration@0.123.6
  - @cat-factory/agents@0.62.13
  - @cat-factory/spend@0.12.54

## 0.137.4

### Patch Changes

- d675cc5: Workspace-RBAC security follow-ups (SEC-RBAC-0, SEC-RBAC-5):

  - SEC-RBAC-0 (High): the account-tier document-fragment routes now re-authorize the
    body/query-supplied `viaWorkspaceId` before fetching through that workspace's stored
    document-source credentials — it must belong to the addressed account AND be accessible to the
    caller, else 404. Closes a cross-tenant confused-deputy that let an account member drive another
    workspace's stored Confluence/Notion/GitHub secret as a fetch oracle.
  - SEC-RBAC-5 (Low): the auth gate returns a 404 (not an opaque 500) when the `:workspaceId` path
    segment is malformed percent-encoding.

- Updated dependencies [edfd2f8]
  - @cat-factory/orchestration@0.123.5

## 0.137.3

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/orchestration@0.123.4
  - @cat-factory/contracts@0.148.1
  - @cat-factory/agents@0.62.12
  - @cat-factory/integrations@0.86.4
  - @cat-factory/spend@0.12.53
  - @cat-factory/prompt-fragments@0.13.39

## 0.137.2

### Patch Changes

- efa3345: chore(deps): in-range dependency sweep + transitive upgrade and dedupe

  Update all dependencies within their existing semver ranges across the
  workspace (including the harness packages), run a transitive upgrade and
  `pnpm dedupe`, and re-adopt `@modular-vue/journeys@1.2.0` now that its neutral
  engine (`@modular-frontend/journeys-engine@1.8.0`) is published.

  - The Vercel AI SDK stays on `ai@6` / `@ai-sdk/*@3`: the newest
    `workers-ai-provider` (3.3.1) still peer-requires `ai@^6`, so a v7 bump
    remains blocked (moves within the pinned majors only).
  - `@modular-frontend/core` is pinned to a single `0.3.0` via a pnpm override:
    the 1.8.0 journeys engine hard-depends on `0.3.0` while the sibling
    `@modular-vue/*` bindings still range `^0.2.0`, which otherwise bundles two
    copies and splits the `JourneyRuntime` type. 0.3.0 is a strict superset
    (adds `discard`). Drop the override once the bindings widen their peer range.
  - `@cat-factory/executor-harness` runtime deps (`hono`, `@hono/node-server`)
    moved within range, so the runner-image tag is bumped and the three pins are
    re-synced (image publish/deploy is a maintainer follow-up).

- Updated dependencies [efa3345]
  - @cat-factory/agents@0.62.11
  - @cat-factory/integrations@0.86.3
  - @cat-factory/kernel@0.139.3
  - @cat-factory/orchestration@0.123.3
  - @cat-factory/spend@0.12.52

## 0.137.1

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/orchestration@0.123.2
  - @cat-factory/agents@0.62.10
  - @cat-factory/integrations@0.86.2
  - @cat-factory/kernel@0.139.2
  - @cat-factory/prompt-fragments@0.13.38
  - @cat-factory/spend@0.12.51

## 0.137.0

### Minor Changes

- 7c3d245: Workspace RBAC (slice 7): close the enforcement side doors.

  - **`/me/environment-handlers/:workspaceId`** — this per-user infra-override surface is mounted
    at `/` and previously bypassed the workspace gate entirely (any signed-in user could address any
    workspace id). It now resolves access through the SAME shared `loadWorkspaceAccess` the gate uses
    and requires `runs.execute`: a caller with no access at all gets a 404 (existence stays hidden,
    exactly as the gate hides a board), while a caller who sees the board but lacks the capability
    gets a 403. Authorization runs before the local-only service-availability 503, so the verdict is
    identical on every facade regardless of whether the handler service is wired.
  - **WS event-stream ticket gains `userId`** — the ticket minted at `POST …/events/ticket` now
    carries the minting user for audit. Verification stays membership-blind (the claim is never
    consulted on upgrade); it is provenance only, absent in dev-open.
  - **`public_api_keys.created_by_user_id`** (both runtimes: D1 migration `0054` ⇄ Drizzle column) —
    a minted public-API key records the acting user for audit + UI attribution, surfaced on the wire
    (`PublicApiKey.createdByUserId`) and in the API-tokens panel ("created by …"). Minting is already
    gated under `secrets.manage` (slice 6). A key is a workspace-scoped SERVICE credential that
    intentionally outlives its minter's access — the column is never an authorization input (no FK),
    so revocation stays an explicit admin action.

  The cross-runtime RBAC conformance suite gains assertions for the side-door 404/403 and the
  `created_by_user_id` round-trip on both stores.

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/integrations@0.86.1
  - @cat-factory/agents@0.62.9
  - @cat-factory/orchestration@0.123.1
  - @cat-factory/prompt-fragments@0.13.37
  - @cat-factory/spend@0.12.50

## 0.136.0

### Minor Changes

- bae59a7: Platform-operator observability: threshold alerting (initiative slice 5). A periodic,
  runtime-symmetric sweep (Worker cron ⇄ Node interval) evaluates each account's aggregate
  run-health projection — the same read the operator dashboard renders, so no new SQL — against
  operator-configured thresholds (failure rate, p99 run duration, live backlog depth) and raises a
  new `platform_health` notification through the existing NotificationChannel seam (in-app + Slack)
  when one is crossed, auto-clearing when the account recovers. The card de-dupes on the firing
  reason set, so a persistently-unhealthy deployment re-notifies only on state change, not every
  sweep. Opt-in via `PLATFORM_ALERTS=true` (thresholds/window/interval tunable via
  `PLATFORM_ALERTS_*`). Adds block-less `NotificationRepository.findOpenByType` (single-workspace
  dedup) and `listOpenByType` (batched across workspaces, so the sweep avoids a point-read per
  workspace) lookups (D1 ⇄ Drizzle + conformance) and threads `platform_health` through the Slack
  transport and the SPA notification inbox (routable/action labels localized in all 10 locales).

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/orchestration@0.123.0
  - @cat-factory/integrations@0.86.0
  - @cat-factory/agents@0.62.8
  - @cat-factory/prompt-fragments@0.13.36
  - @cat-factory/spend@0.12.49

## 0.135.0

### Minor Changes

- f444062: Workspace RBAC (slice 6): admin-tier enforcement across the settings / integrations / secrets
  route groups.

  Adds `requireWorkspacePermission(perm)` — a method-shaped Hono middleware mounted once at the top
  of each admin controller — so every WRITE it serves requires the group's `WorkspacePermission`
  (`settings.manage` / `integrations.manage` / `secrets.manage`) while GET/HEAD reads stay open to
  any resolved role (`workspace.read`). It runs before the handler's service-availability guard, so
  an unauthorized member gets a clean 403 without learning whether the underlying integration is
  wired, and — being co-located with the controller mount rather than a central path→permission
  table — a newly added route inherits the correct gate automatically.

  Applied whole-controller (each admin controller maps to exactly one permission):
  `settings.manage` covers workspace settings, board rename/description/delete, tracker settings,
  model presets, risk/merge presets, the workspace-scoped prompt-fragment library, and
  observability / release-health / incident-enrichment config; `integrations.manage` covers the
  GitHub / Slack / environments / runner-pool / task-source / document-source surfaces, package
  registries, shared stacks, sandbox, bootstrap + reference architectures, and preview;
  `secrets.manage` covers vendor credentials, workspace API keys, public-API keys, and test secrets.
  `WorkspaceController.update`/`delete` gate per-handler (the controller also serves the ungated
  `POST /workspaces` create + the `workspace.read` snapshot GET). The cross-runtime conformance
  suite asserts a plain member is refused these writes (403) while the account admin is not.

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/orchestration@0.122.0
  - @cat-factory/integrations@0.85.4
  - @cat-factory/agents@0.62.7
  - @cat-factory/kernel@0.138.1
  - @cat-factory/prompt-fragments@0.13.35
  - @cat-factory/spend@0.12.48

## 0.134.0

### Minor Changes

- c47dfe1: Workspace RBAC (slice 5): the member-management API.

  Adds the workspace-membership roster + access-mode management surface that lets an account
  admin restrict a board to an explicit member list. New `WorkspaceMemberService`
  (`@cat-factory/workspaces`) owns `list` / `add` / `setRole` / `remove` + `setAccessMode`,
  built in `createCore` whenever the workspace-member repository is wired (both facades wire it;
  absent ⇒ the controller reports 503). The one rule beyond wire validation is that a member must
  already belong to the board's owning account — a `restricted` board narrows WITHIN an account,
  never grants across it — so scoping an outsider is a `ValidationError` (422).

  Legacy (`account_id IS NULL`) boards are no longer a supported dead end: rather than refusing
  member management, the service AUTO-HEALS the board by adopting it into its owner's account (the
  new `WorkspaceRepository.linkAccount` port, mirrored on D1 and Drizzle), then proceeds — an
  unscoped board is invisible to resolution's account tier, so a roster/restriction on it would
  otherwise be a silent no-op. The adopt target is the owner's SOLE account (on a legacy board the
  owner is the only principal that can reach member management); if that is ambiguous (no owner, or
  the owner belongs to several accounts) the write is a `ValidationError` (422) telling the caller
  to link the board explicitly. The heal also (re)asserts the owner's `admin` member row so a
  follow-up flip to `restricted` can't lock the owner out. `add` now preserves an existing member's
  original grant metadata (`createdAt`/`addedBy`) on a re-add instead of re-stamping it (the upsert
  updates only `role`), and `list` 404s a non-existent board.

  New routes under `/workspaces/:ws` (`@cat-factory/contracts` + `@cat-factory/server`):
  `GET/POST/PATCH/DELETE /members` and `PUT /access-mode`. The roster GET is open to any resolved
  role (`workspace.read`, satisfied by the gate resolution itself); every write requires
  `members.manage`, enforced by the new `requirePermission(c, permission)` helper
  (`http/workspaceAccess.ts`) — it consumes the access the gate published (never re-derives
  membership), allows the dev-open path, and throws `ForbiddenError` (403) on insufficiency.

  Every roster/access-mode write invalidates the board's `workspaceAccess` cache group right after
  it commits (the group-invalidation slice 4 deferred to the member service), so a live grant,
  role change, or access-mode flip is visible on the immediately-following request rather than
  riding the TTL. Cross-runtime conformance asserts the full lifecycle over HTTP — restrict → add
  viewer → promote to member → remove — with live cache coherence on each step, plus the
  `members.manage` 403s and the only-account-members 422, identically on D1 and Postgres.

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/orchestration@0.121.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/agents@0.62.6
  - @cat-factory/integrations@0.85.3
  - @cat-factory/prompt-fragments@0.13.34
  - @cat-factory/spend@0.12.47

## 0.133.0

### Minor Changes

- 5924903: Public API: notification inbox (`/api/v1/notifications`).

  The external `/api/v1` surface gains the notification inbox, completing the operational tail
  of the task lifecycle so an external CI/bot can resolve the human-gated ends of a run:

  - `GET /api/v1/notifications` (read) — list the workspace's open notifications.
  - `POST /api/v1/notifications/:id/act` (admin) — run the notification's typed side-effect:
    merge the PR for real (`merge_review` / `pipeline_complete`) or retry the run
    (`ci_failed` / `test_failed`). It requires an `admin`-scoped key because it can perform a
    real GitHub merge. Only these automated-action types are actionable headlessly; a
    notification that parks a run on an interactive human decision has no automated action and
    is refused (`409 notification_not_actionable`) — dismiss it instead. An `act` that would
    retry a run on an individual-usage model is likewise refused
    (`409 individual_model_unsupported`), matching the task retry endpoint (a headless key has
    no personal-credential unlock).
  - `POST /api/v1/notifications/:id/dismiss` (write) — dismiss a card without acting on it.

  Every route is scoped to the key's workspace via the existing per-key scope ladder
  (`read` ⊂ `write` ⊂ `admin`) and delegates to the same `NotificationService` the SPA inbox
  uses — no new persistence or machinery, so it is runtime-symmetric by construction and
  covered by the cross-runtime conformance suite. The merge/retry side-effect is now shared
  between the SPA and public controllers. The OpenAPI spec (`docs/openapi.json`) is regenerated.

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/agents@0.62.5
  - @cat-factory/integrations@0.85.2
  - @cat-factory/kernel@0.137.1
  - @cat-factory/orchestration@0.120.2
  - @cat-factory/prompt-fragments@0.13.33
  - @cat-factory/spend@0.12.46

## 0.132.0

### Minor Changes

- 74c21ab: feat: repo-sourced Claude Skills — freshness automation (slice 4)

  Keep a running pipeline from ever executing a stale skill, without the management
  surface having to resync by hand (docs/initiatives/repo-skills.md, final slice):

  - **Push-webhook fan-out.** A verified `push` webhook to a repo that skill sources are
    linked to now enqueues a targeted `skill-source-resync` job per affected source, so its
    skills are refreshed shortly after the upstream change. One indexed
    `SkillSourceRepository.listByRepo(owner, name)` lookup (new port method, D1 ⇄ Drizzle
    with a conformance assertion; the `skill_sources(repo_owner, repo_name)` index was
    already in place) drives the fan-out; the enqueue rides the existing GitHub-sync queue
    through a new `GitHubWebhookIngest.queueSkillResync` seam (Cloudflare Queue ⇄ Node
    pg-boss), and the async consumer runs `SkillSourceService.sync` for the one source
    (a source unlinked between enqueue and processing is swallowed, not retried forever).
  - **Dispatch-time self-verifying probe.** At skill-step dispatch, `SkillRunResolver` now
    probes the source dir's head commit; if it advanced since the last sync it re-syncs so
    the run uses current instructions. It never fails the run — any probe/re-sync error
    degrades to the last-synced record (a run may be at most one push behind, never broken),
    and it's a no-op on the common unchanged path (one `latestCommitSha` read).

  Together with the push fan-out this is the layered freshness story: the webhook keeps the
  account catalog warm, and the dispatch probe is the correctness backstop for deployments
  with no sync queue (local/dev) or a missed delivery. Backend-only; no harness/image change.

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0
  - @cat-factory/agents@0.62.4
  - @cat-factory/integrations@0.85.1
  - @cat-factory/orchestration@0.120.1
  - @cat-factory/spend@0.12.45

## 0.131.0

### Minor Changes

- 27f0ea2: Expose the deployment-level (platform-operator) observability aggregates via OpenTelemetry.

  A periodic, runtime-symmetric sweep (Worker `scheduled` cron ⇄ Node interval, like the
  retention sweeps) now pushes the same run-health projection the operator dashboard renders —
  run outcomes by status, the failure-kind taxonomy, live/parked depth, and the avg/min/max +
  p50/p90/p99 duration percentiles — to any OTLP/HTTP backend as OpenTelemetry **gauge**
  metrics (`cat_factory.platform.*`), per account (the bounded tenant scope) and stamped with
  the projection's `generatedAt`. The OTel backend builds trends from the gauge series, so the
  sweep exports the shortest trailing window (`1h` default).

  `@cat-factory/observability-otel` gains a fetch-based `PlatformMetricsOtelExporter`
  (`createPlatformMetricsOtelExporter`) — the workerd-safe transport used on BOTH runtimes
  (the platform push is a stateless snapshot POST, so it needs no SDK, mirroring the Langfuse
  sink's fetch-on-both shape). The runtime-neutral `sweepPlatformMetrics` driver + the
  `distinctAccountIds` account enumeration live in `@cat-factory/orchestration`.

  Opt-in on top of the base OTel exporter (it adds recurring DB rollup load): off unless
  `OTEL_ENABLED=true` + an endpoint AND `OTEL_PLATFORM_METRICS=true`. `OTEL_PLATFORM_METRICS_WINDOW`
  (`1h`/`24h`/`7d`) and, on Node, `OTEL_PLATFORM_METRICS_INTERVAL_MS` tune it. A deployment
  that hasn't opted in emits nothing and runs no sweep.

### Patch Changes

- Updated dependencies [27f0ea2]
  - @cat-factory/orchestration@0.120.0

## 0.130.0

### Minor Changes

- f5ddc02: Public API: per-key permission scopes + task deletion.

  Inbound public-API keys now carry a `scope` on the `/api/v1` surface — an inclusive ladder
  (`read` ⊂ `write` ⊂ `admin`) the controller enforces per endpoint: reads need `read`,
  non-destructive mutations (create/start/stop/retry/edit a task, start an initiative run)
  need `write`, and destructive operations need `admin`. A valid key whose scope is too low
  gets `403 insufficient_scope` (distinct from the `401` an unknown key gets).

  This unblocks the first destructive endpoint: `DELETE /api/v1/tasks/:taskId` (admin-scoped)
  deletes a task and its run history, completing the Tier-1 task lifecycle.

  The workspace token UI gains a scope selector on create; a minted key defaults to `write`.

  Breaking (pre-1.0, external surface): `publicApiKeySchema` gains a required `scope` field
  and the `public_api_keys` table gains a `scope` column (D1 ⇄ Drizzle). Existing keys backfill
  to `write` — they keep every capability the surface shipped before scopes existed but do not
  auto-gain the new destructive power, which must be minted `admin` explicitly.

### Patch Changes

- 576f2e0: Workspace RBAC (slice 4): cache the effective-access resolution behind the app cache seam.

  The shared auth gate resolves a caller's effective workspace access on every
  `/workspaces/:ws/*` request (three reads: the board access row, the caller's account roles,
  their member row). This adds a `workspaceAccess` slice to the kernel `AppCaches` port
  (`@cat-factory/caching`) so `loadWorkspaceAccess` reads through it — grouped by workspace id,
  keyed by user id, with both a denial and a missing board cached as values (negative caching).
  A cache hit costs zero repository reads.

  Coherence is invalidation-driven, after each write commits: a board delete drops the
  workspace group (`WorkspaceService.delete`), and account-tier membership writes
  (`AccountService.addMember` / `setMemberRoles`, `InvitationService.accept`) drop everything
  (`invalidateAll` — the deliberate coarse fallback for a rare management action, since a new
  membership can change access to many boards). The roster + access-mode write paths added by
  the member-management API (a later slice) invalidate the same workspace group on their own
  writes.

  The slice follows the established seam rules: the `DEFAULT_APP_CACHES_PROFILE` enables it with
  a short 60s TTL (a freshness backstop; invalidation is the real coherence story), while the
  Worker's `ISOLATE_SAFE_APP_CACHES_PROFILE` keeps it **pass-through** — the resolution reads our
  own mutable D1 state and a Worker isolate has no cross-isolate invalidation bus, so a TTL'd
  entry could keep granting access after a peer isolate revoked a member. Cross-runtime
  conformance asserts an account-membership grant is visible on the immediately following request
  (the cached denial is dropped) on both D1 and Postgres.

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/integrations@0.85.0
  - @cat-factory/orchestration@0.119.0
  - @cat-factory/agents@0.62.3
  - @cat-factory/prompt-fragments@0.13.32
  - @cat-factory/spend@0.12.44

## 0.129.2

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/orchestration@0.118.0
  - @cat-factory/agents@0.62.2
  - @cat-factory/integrations@0.84.12
  - @cat-factory/spend@0.12.43
  - @cat-factory/prompt-fragments@0.13.31

## 0.129.1

### Patch Changes

- e618bf5: feat: repo-sourced Claude Skills — frontend (slice 3)

  Surface the account's repo-sourced Claude Skills in the SPA
  (docs/initiatives/repo-skills.md):

  - **Snapshot skills list.** The workspace snapshot now carries the account's skill
    catalog as lightweight `{ id, name, description }` summaries (one cached account read,
    shared across the account's workspaces), attached by the shared `WorkspaceController`
    and hydrated into a `skills` store. Best-effort — an unwired library or read failure
    degrades to no options rather than breaking the board load.
  - **Per-step skill picker.** The generic `skill` palette block (already surfaced via
    `customAgentKinds`) gets a per-step picker in the pipeline builder bound to
    `stepOptions[i].skillId`, with inline hints when no skills exist, a step has no skill
    selected (mirroring the backend save/start rejection), or a picked skill has left the
    catalog (renamed/unlinked source).
  - **Account Skills management UI.** A new "Skills" tab in Account settings lists the
    synced catalog and manages linked repo sources (link via the GitHub repo/dir picker or
    manual entry, check-for-changes, resync, unlink), mirroring the fragment library's
    repo-sources surface. The GitHub-integration and library opt-in gates degrade the UI
    cleanly (503 → hidden/notice) rather than erroring.
  - Full i18n in all locales (en/de/es/fr/he/it/ja/pl/tr/uk).

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/agents@0.62.1
  - @cat-factory/integrations@0.84.11
  - @cat-factory/kernel@0.134.1
  - @cat-factory/orchestration@0.117.1
  - @cat-factory/prompt-fragments@0.13.30
  - @cat-factory/spend@0.12.42

## 0.129.0

### Minor Changes

- 32a0720: feat: repo-sourced Claude Skills — executable pipeline step (slice 2)

  Make a synced repo-sourced Claude Skill runnable as a pipeline step
  (docs/initiatives/repo-skills.md):

  - **One generic `skill` agent kind** (`container-coding`, `noChangesTolerated`,
    `pr-or-work` clone), parametrized per step by a new `stepOptions.skillId` — not a
    dynamic kind per skill. Pipeline save (and run-start re-validation) rejects a `skill`
    step that names no skill.
  - **`SkillRunResolver`** resolves the picked skill at dispatch: the persisted
    instructions from the account catalog plus the sibling resource bodies fetched at the
    skill's immutable pinned commit (per-file + total caps; oversized/binary files are
    referenced by repo path instead). The run never depends on a live GitHub fetch — a
    fetch failure degrades a resource to a path reference rather than failing the run.
    Wired into the engine as `skillResolver` in `AgentContextBuilder` (a skill step
    dispatched with the library unconfigured fails loudly rather than running blank), and
    the run step is pinned with `skillVersion: { skillId, commit, sha }`.
  - **Harness-aware rendering** in `ContainerAgentExecutor`: the resolved skill travels as
    a dedicated top-level `skill` job-body field (never a context file). The
    executor-harness materialises it natively into `CLAUDE_CONFIG_DIR/skills/<name>/` for
    the claude-code subscription harness (so the CLI loads it), and under
    `.cat-context/skill/` for the Pi/codex harnesses (whose prompt carries the folded-in
    instructions).
  - Bumps `@cat-factory/executor-harness` (native claude-code skills write) and the pinned
    runner image tag in the Node/local facades.

- be6e109: Workspace RBAC (slice 3): resolve effective workspace access in the shared auth gate.

  `mountAuthGate` now resolves a signed-in caller's effective workspace role once (via the
  new `loadWorkspaceAccess` helper over the kernel `resolveWorkspaceAccess` decision) and
  publishes it on the request context as `workspaceAccess`. A denied board returns the
  existing 404 shape (existence is never leaked); a resolved-but-insufficient write hits the
  **viewer write floor** — any non-GET method requires at least `member`, with the read-only
  `POST /workspaces/:ws/events/ticket` mint allowlisted — returning `403 forbidden`. The
  account-admin escape hatch and the legacy owner-only board are preserved byte-for-byte.

  `WorkspaceVisibility` is extended (unrestricted account boards, an admin-account escape
  hatch, an explicit-membership branch, and legacy-owned boards) and enforced SQL-side in
  both the D1 and Drizzle `listVisible`; `AccountService.accessibleAccountScopes` derives the
  member/admin account sets from the single existing membership read. `GET /workspaces`
  annotates each board with the caller's effective `viewerRole` via one batched member-row
  read, and the board snapshot (GET + create) carries the resolved `access` (role +
  permissions). `WorkspaceService.create` auto-enrolls the creator as a workspace admin. The
  `workspace_members` repository is now wired into both runtime facades' containers. Cross-
  runtime conformance asserts the 404 invisibility, the viewer floor + ticket allowlist, the
  escape hatch, and list filtering over the real HTTP gate on both D1 and Postgres.

### Patch Changes

- 54e117e: GitLab UI parity (pre-slice): carry a `provider` VCS discriminator on the repo/connection
  projection.

  The GitLab-parity SPA work (provider-aware labels, icons, host/URL shapes) needs a
  `provider: VcsProvider` (`'github' | 'gitlab'`) it can read off the data. This adds that
  field to the `GitHubRepo` / `GitHubConnection` / `GitHubAvailableRepo` wire types and the
  kernel `GitHubInstallation`, and persists it symmetrically on both runtimes' projection
  tables (D1 migration `0051_vcs_provider.sql` + a Drizzle migration + both sets of mappers).
  The tables keep their GitHub names — the entity-rename fold is separate, acknowledged Phase-1
  work.

  `provider` is a per-connection fact: a connection records it (`GitHubInstallationService.connect`
  → `'github'`; local mode's `AutoProvisioningInstallationRepository` → the deployment's provider,
  `'gitlab'` for a GitLab-PAT deployment), and the repos reached through it inherit it (the sync
  service stamps `installation.provider`, the bootstrapper and CLI `linkRepo` stamp their own).
  Rows written before the column default to `'github'`. A cross-runtime conformance suite
  (`defineVcsProviderSuite`) asserts the round-trip on both stores. No SPA behaviour changes yet;
  this unblocks the presentation-switch slices.

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0
  - @cat-factory/orchestration@0.117.0
  - @cat-factory/integrations@0.84.10
  - @cat-factory/prompt-fragments@0.13.29
  - @cat-factory/spend@0.12.41

## 0.128.0

### Minor Changes

- 6564507: Add platform-operator observability: a deployment-level operator dashboard.

  A new `PlatformMetricsRepository` kernel port exposes SQL rollups over `agent_runs`
  (run outcomes, failure-kind taxonomy, live/parked depth, duration stats, and a
  time-bucketed outcome trend), scoped to an account and implemented on both the D1
  (Cloudflare) and Drizzle (Postgres/Node) stores with cross-runtime conformance. The
  admin-gated `GET /accounts/:accountId/observability/platform` endpoint returns a
  windowed (1h / 24h / 7d) projection, surfaced in the SPA as an operator dashboard
  panel (outcome tiles + success rate, an outcome-trend sparkline, the failure
  breakdown, live depth, and duration stats), reachable from the sidebar by account
  admins. Fully internationalized.

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/orchestration@0.116.0
  - @cat-factory/agents@0.61.2
  - @cat-factory/integrations@0.84.9
  - @cat-factory/spend@0.12.40
  - @cat-factory/prompt-fragments@0.13.28

## 0.127.1

### Patch Changes

- b12d7a8: feat(rbac): workspace-RBAC vocabulary + membership persistence (initiative slices 1–2)

  Lay the foundation for workspace-level access control below the account tier — no enforcement
  yet (that is a later slice), just the shared vocabulary and the persistence both facades need.

  - **Contracts**: `workspaceRoleSchema` (`admin | member | viewer`), `workspacePermissionSchema`
    (the seven-permission capability catalog), `workspaceAccessModeSchema` (`account | restricted`),
    and the `WorkspaceMember` wire shape; `workspaceSchema` gains an optional `accessMode`.
  - **Kernel**: `domain/workspace-access.ts` — the static `WORKSPACE_ROLE_PERMISSIONS` map plus the
    pure `resolveWorkspaceAccess` / `workspaceRoleAtLeast` / `permissionsForRole` helpers (with a
    decision-table test); a new `ForbiddenError` (`DomainErrorCode 'forbidden'`, mapped to 403); and
    the `WorkspaceMemberRepository` port (batch-shaped: `getRolesForUserInWorkspaces`,
    `removeByAccountMembership`) plus `WorkspaceRepository.accessRowOf` / `setAccessMode`.
  - **Persistence (both runtimes)**: a new `workspace_members` table + a `workspaces.access_mode`
    column (D1 migration `0052_workspace_rbac.sql` ⇄ Drizzle), the D1 and Drizzle repository impls,
    and a cross-runtime conformance suite asserting the roster CRUD, the batched role annotation, the
    account-membership cascade, and the access-mode round-trip on both stores. The default access
    mode is `account`, so every existing board is unchanged (no data migration).

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/agents@0.61.1
  - @cat-factory/integrations@0.84.8
  - @cat-factory/orchestration@0.115.1
  - @cat-factory/prompt-fragments@0.13.27
  - @cat-factory/spend@0.12.39

## 0.127.0

### Minor Changes

- 5b1cbbf: feat: repo-sourced Claude Skills library — data + sync core (slice 1)

  Land the persistence + sync foundation for the repo-sourced Claude Skills
  initiative (docs/initiatives/repo-skills.md):

  - New account-tier tables `skill_sources` + `account_skills` (D1 migration 0052
    ⇄ Drizzle schema + migration), with matching kernel ports
    (`SkillSourceRepository`, `AccountSkillRepository`) and both D1 and Drizzle
    repositories, asserted by a new cross-runtime conformance suite.
  - A shared `repo-source-sync` helper extracted from the fragment library's sync
    mechanics (commit-pin-before-read, id-keyed tombstone sweep, invalidate-only-on-
    change, the status probe) plus a shared frontmatter parser; `FragmentSourceService`
    is refactored onto it, and the new `SkillSourceService` reuses it for the
    directory-per-skill (`<skill>/SKILL.md` + resources) sync unit.
  - `SkillCatalogService` (the account skill-catalog read) backed by a new
    `AppCaches.skillCatalog` cache slice (pass-through on the Worker, like
    `fragmentCatalog`).
  - Contracts + an account-scoped `SkillLibraryController` (list skills; link / list /
    sync / status / unlink sources), wired into all runtime facades. Opt-in behind the
    existing prompt-library flag.

  `RepoContentEntry` gains an optional `size` (populated from the GitHub contents API)
  so the skill resource manifest can record file sizes.

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0
  - @cat-factory/agents@0.61.0
  - @cat-factory/orchestration@0.115.0
  - @cat-factory/integrations@0.84.7
  - @cat-factory/spend@0.12.38
  - @cat-factory/prompt-fragments@0.13.26

## 0.126.0

### Minor Changes

- 1869ad3: Add a "Ralph loop" task type: a persistent retry-until-done coding loop whose exit condition is
  a programmatic validation command the harness runs against the checkout (exit 0 = done), bounded
  by a per-task iteration budget and surviving restarts.

  Each iteration is a fresh-context container-coding run that works the task spec; the harness then
  runs the task's configured `ralph.validationCommand` (bounded timeout, redacted output tail) and
  reports the verdict on the run result — never a model self-report. The engine (`RalphController` +
  a `ralph-verdict` step-completion interceptor, modelled on the Tester→Fixer loop) re-dispatches a
  fresh iteration on a failing verdict until it passes or the `ralph.maxIterations` budget (default 10) is spent, then hands off to a human. Loop state rides the persisted `step.ralph` (no
  migration), so a mid-loop run is re-driven from where it was by both durable drivers + sweepers.

  - New `ralph` agent kind (the reusable loop-body primitive) + the `pl_ralph` pipeline
    (`ralph → conflicts → ci → merger`) + a `ralph` task type (a one-click creation entry point).
  - The validation command + iteration budget are per-task agent config; `AgentConfigDescriptor`
    gained `text`/`number` control types for them.
  - Cross-runtime conformance coverage (loop completes / exhausts / refuses to start unconfigured)
    and pure-logic unit tests.

  Breaking: none (pre-1.0; `taskType` / `step.ralph` / the descriptor types are additive). The
  executor-harness image is bumped for the new in-container validation capability.

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0
  - @cat-factory/orchestration@0.114.0
  - @cat-factory/integrations@0.84.6
  - @cat-factory/prompt-fragments@0.13.25
  - @cat-factory/spend@0.12.37

## 0.125.0

### Minor Changes

- 06a094a: Grow the external public API (`/api/v1`) into a complete task-lifecycle surface: edit a task
  (`PATCH /tasks/:taskId`), stop (`POST /tasks/:taskId/stop`) and retry (`POST /tasks/:taskId/retry`)
  its run, read a rich run projection with per-step status/subtasks/failure/PR branch
  (`GET /tasks/:taskId/run`), stream it live over SSE (`GET /tasks/:taskId/events`), and discover
  startable pipelines (`GET /pipelines`). Each is key-authenticated, double-scoped to the key's
  workspace and to real board tasks, and delegates to the existing service methods; retry reuses the
  individual-usage-model refusal. The OpenAPI spec (`docs/openapi.json`) is regenerated to cover them.

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/agents@0.59.2
  - @cat-factory/integrations@0.84.5
  - @cat-factory/kernel@0.129.2
  - @cat-factory/orchestration@0.113.2
  - @cat-factory/prompt-fragments@0.13.24
  - @cat-factory/spend@0.12.36

## 0.124.0

### Minor Changes

- 6dc444e: feat(mothership): expose member-display user reads over the persistence RPC

  A mothership-mode local node delegates org/durable state to the mothership, but the account members
  panel could not enrich its roster with real display details — `userRepository.get`/`listByIds` were
  not remotely callable, so names/emails/avatars came back empty. This allow-lists those two
  member-display reads.

  - A new scope-rule pair **`user`/`userList`** in the persistence RPC (`src/persistence/rpc.ts`).
    A userId is neither an account nor a workspace, so it is bound by CO-MEMBERSHIP: a user's display
    record is readable iff they are a member of one of the machine token's in-scope accounts, resolved
    server-side from the account rosters via a new `resolveAccountMemberIds` dispatch resolver (bounded
    by the token's account scope, not the requested user list — no N+1). A user in no in-scope account
    fails closed (404, no existence leak), like every other entity scope.
  - The shared `PersistenceController` wires `resolveAccountMemberIds` from
    `membershipRepository.listByAccount`, so both facades (Node + Cloudflare mothership) pick it up.

  Safe because the reads carry only the presentational `UserRecord` (id/name/email/avatarUrl/createdAt);
  the password `secret` lives on `UserIdentityRecord`, reachable only via `getIdentity`/`listIdentities`,
  which — with the `update` profile write and `findByIdentity`/`findByEmail` — stay off the machine API
  (the account-lifecycle / login surface). See `docs/initiatives/mothership-mode.md`.

  The `@cat-factory/node-server` patch is a test-only change: its mothership-allowlist drift guard moves
  `userRepository.get`/`listByIds` out of `pending` to reflect the new remote surface.

## 0.123.1

### Patch Changes

- bd0a42a: refactor(server): finish the generic row-mapper adoption (refactoring candidate #2)

  The last two hand-enumerated read mappers in `persistence/mappers.ts` — `rowToWorkspace` and
  `rowToPipeline` — now derive from a declared field table instead of a hand-written object
  literal, via a small read-only path (`makeRowReader` + the `readScalar` / `readNullable` /
  `readJson` / `readOptJson` / `readFlag` / `readOptScalar` builders). Both are read-only in this
  module (their repos bind columns positionally on write), so they declare only the READ
  direction rather than a full three-way `FieldMapper`. `rowToExecution` stays deliberately
  bespoke (its tolerant `detail` JSON envelope isn't a column-per-field shape). Pure refactor,
  no behaviour change; the flag / version / availability / optional-JSON read semantics are
  pinned by new `test/mappers.spec.ts` cases.

## 0.123.0

### Minor Changes

- 745de02: feat(mothership): real-time upstream publish (the outbound half of PR 2's real-time both directions)

  A mothership-mode local node runs the engine on the laptop but delegates org/durable state to the
  mothership. Until now its engine events (a run advancing, a board change, a notification) never
  reached the mothership's real-time fan-out, so a hosted teammate watching the same shared board
  couldn't see the local node's activity live. This adds the upstream channel.

  - `@cat-factory/server`: a new machine-authed `POST /internal/events/publish` endpoint
    (`eventsRelayController`) + the `MachineEventRelay` seam on `ServerContainer` + the
    `HttpMachineEventClient`. Mounted on both facades; account-scoped and default-deny exactly like
    the persistence RPC (a workspace outside the token's scope is a uniform 404). The verbatim-forwarded
    payload is size-capped (413 above the ceiling) so a compromised node can't inject an unbounded frame.
  - `@cat-factory/node-server`: `LocalMachineEventRelay` delivers a relayed event into the facade's
    own real-time sink (the hub / layered propagator); attached whenever a realtime sink is wired.
  - `@cat-factory/worker`: `DurableObjectMachineEventRelay` delivers a relayed event into the
    per-workspace `WorkspaceEventsHub` Durable Object — the symmetric Cloudflare side.
  - `@cat-factory/local-server`: `MothershipWebSocketPropagator` (a `WebSocketPropagator` adapter,
    reusing the existing cross-node seam) forwards the local node's engine events upstream; it is
    layered over the hub in mothership mode so every event fans to the laptop's own SPA AND the
    mothership.

  Scope: this is the OUTBOUND direction only. The INBOUND subscribe leg (the local node receiving org
  events raised on the mothership / by peer laptops) is a distinct, runtime-shaped follow-up — see
  `docs/initiatives/mothership-mode.md`.

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/orchestration@0.113.1
  - @cat-factory/kernel@0.129.1
  - @cat-factory/agents@0.59.1
  - @cat-factory/integrations@0.84.4
  - @cat-factory/spend@0.12.35

## 0.122.0

### Minor Changes

- 1b90387: Mothership mode: expose the Slack integration management surface over the persistence RPC.

  Adds a new `accountField` persistence-RPC scope rule (the account-owned mirror of `workspaceField`,
  binding on an `upsert(record)`'s `accountId` field) and allow-lists the Slack settings repositories
  so the connect / route / member-map panels persist in mothership mode:
  `slackConnectionRepository` (`getByAccount`/`upsert`/`softDelete` — the bot token rides a sealed
  `tokenCipher`, so only ciphertext crosses the machine API), `slackSettingsRepository`
  (`getByWorkspace`/`upsert`) and `slackMemberMappingRepository` (`getByAccount`/`upsert`). The Node
  facade routes the three Slack repos through the `pickRepoSource` seam inside `selectNodeSlackDeps`,
  so both the management services and the `SlackNotificationChannel` read the remote-backed repos.
  `slackConnectionRepository.getByTeam` (the global inbound-OAuth teamId lookup) stays
  mothership-internal, and mothership-side Slack delivery for a hosted teammate remains a later
  secrets-delegation slice.

## 0.121.0

### Minor Changes

- 995249b: feat(spike): timeboxed research spike tasks — kind, pipeline, findings document, PR + review delivery

  Spike tasks now run as a real timeboxed investigation that produces a findings document
  instead of falling through to a full code-and-PR build:

  - A built-in read-only `spike` agent kind (`container-explore`, structured findings + a prose
    `summary`, opened in the `generic-structured` result view). Its backend post-op renders the
    findings to `docs/research/<slug>.md` (honouring `taskTypeFields.targetPath`) via the
    checkout-free `RepoFiles` port — no harness change.
  - Findings are delivered as a PULL REQUEST by default (`pl_spike`: `requirements-review`(off) →
    `spike` → `conflicts` → `ci` → `human-review` → `merger`): the post-op commits to a work branch
    and opens a PR that the review/merge tail lands, so protected base branches are respected and
    review comments are handled by the existing `human-review` gate + `fixer`. A `pl_spike_direct`
    pipeline keeps the fast, no-PR path (commit straight to base) for unprotected repos. `spike →
pl_spike` is the task-type default, so a spike no longer dispatches a coder.
  - New reusable engine seam: a `RepoOp` may open a pull request and return its ref, which the
    engine records as `block.pullRequest` (the same linkage a container-coding step produces), so a
    deterministic backend-rendered artifact can flow through the normal conflicts/CI/human-review/
    merge tail. `RepoFiles.openPullRequest` (and the underlying `GitHubClient`/`VcsClient` ports)
    now return the PR web `url` (`OpenedPullRequest`), provider-agnostically.
  - A no-PR completion path in the engine: a task run that opened no pull requests now finishes
    `done` (like a frame-level run) instead of stalling at `pr_ready` behind a `pipeline_complete`
    notification whose confirm threw `no_pr_to_merge`. This benefits every PR-less pipeline.
  - Spike creation collects research criteria (research question, success criteria, options to
    compare, target path) alongside the time-box; all are folded into the spike prompt (the
    time-box as a scope-discipline directive). New copy is translated across all locales.

  A repo-less spike (GitHub unwired, or a docs-only spike) settles on `step.custom` — the findings
  render is skipped rather than failing the run; a rejected direct commit is best-effort (the
  findings already live on the step), while a PR-mode open failure is surfaced.

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/orchestration@0.113.0
  - @cat-factory/integrations@0.84.3
  - @cat-factory/spend@0.12.34
  - @cat-factory/prompt-fragments@0.13.23

## 0.120.0

### Minor Changes

- 9e9127f: Expose basic board workloads on the external public API (`/api/v1`), and generate an OpenAPI 3
  spec for that surface.

  New key-authenticated endpoints, each scoped to the key's workspace:

  - `GET /api/v1/services` — list the workspace's services.
  - `POST /api/v1/services/:serviceId/tasks` — create a task under a service.
  - `GET /api/v1/services/:serviceId/tasks` — list a service's tasks.
  - `GET /api/v1/tasks/:taskId` — get a task's status.
  - `POST /api/v1/tasks/:taskId/start` — start (run) a task. Refused for a task on a subscription-only
    individual-usage model (no headless personal-credential unlock), or one whose enclosing service is
    archived (`409 service_archived` — an archived service's tasks stay readable but not start-able).
    The response re-reads the task after start, so it reflects the run's authoritative status.

  Reads project a `Block` onto small `publicTask` / `publicService` resources — board/engine
  internals are never leaked. Added on `BoardService`: `listServices`, `addServiceTask`,
  `getServiceTask`, `listServiceTasks` (no new repository ports or migrations — both runtimes get
  the behaviour through the shared server + orchestration layers).

  Also adds a generated `docs/openapi.json` (OpenAPI 3.1) for the whole `/api/v1` surface, produced
  from the Valibot contracts (`pnpm gen:openapi`) and guarded against drift in CI (`pnpm check:openapi`).

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/orchestration@0.112.0
  - @cat-factory/agents@0.58.1
  - @cat-factory/integrations@0.84.2
  - @cat-factory/kernel@0.128.1
  - @cat-factory/prompt-fragments@0.13.22
  - @cat-factory/spend@0.12.33

## 0.119.0

### Minor Changes

- d68e3a8: Add opt-in OpenTelemetry (OTLP) observability. A new `@cat-factory/observability-otel`
  package implements the kernel `LlmTraceSink` port and exports LLM generations (+ container
  tool spans) and metrics to any OTLP/HTTP backend — a workerd-safe fetch exporter on the
  Cloudflare Worker facade and the official `@opentelemetry/*` SDK exporter on Node, kept
  conformant by a shared mapping layer + a conformity test.

  - **kernel:** new `CompositeTraceSink` + `composeTraceSinks` so multiple external trace
    destinations (Langfuse and/or OTLP) fan out through the single sink slot.
  - **server:** new `OtelConfig` on `AppConfig`.
  - **worker / node-server:** wire the OTLP exporter (fetch on the Worker, SDK on Node)
    everywhere the Langfuse sink is wired, composed alongside Langfuse. Enabled with
    `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` (`OTEL_EXPORTER_OTLP_HEADERS` /
    `OTEL_SERVICE_NAME` optional).
  - **cli:** advertise the `OTEL_*` vars in the generated `.env`.

  Refinements: the Node facade shares ONE trace-sink instance across the core, the container
  executor and the inline model-provider (so the SDK exporter's batch processors/timers aren't
  duplicated) and flushes + shuts it down on graceful shutdown (via `LlmTraceSink.shutdown` /
  `CompositeTraceSink` fan-out) so the final batch isn't dropped. Metric data points carry only
  the low-cardinality `gen_ai.*` dimensions — the unbounded workspace id stays on spans, off
  metrics — to keep metric-backend cardinality bounded.

- b414f34: PR deep-review: resolve a parked review by fixing or posting the selected findings.

  The `pr-review` window now offers two terminal resolutions alongside `Finish`, both acting on
  the human's curated finding selection:

  - **Fix** re-dispatches the `pr-reviewer` step as a Fixer (`FIXER_AGENT_KIND`) that clones the
    reviewed PR's head branch, commits fixes addressing the selected findings, and pushes back onto
    it (no new PR).
  - **Post** publishes the selected findings as a single advisory (`COMMENT`) inline PR review — each
    line-anchored finding as an inline comment, the rest folded into the review body.

  Two new optional VCS reads/writes back these resolutions — `getPullRequestHeadRef` and
  `createReview` on the neutral `VcsClient` + `GitHubClient` ports (GitHub-implemented, omitted on
  GitLab), surfaced to the engine through the checkout-free `RepoFiles` seam. All review state stays
  on `step.prReview` (no side table); a cross-runtime conformance assertion covers both resolutions.

  Scoped to a same-repo, non-fork PR (the reviewer's existing limitation); a cross-repo `prUrl` and
  fork PRs remain a tracked follow-up. See `backend/docs/adr/0023-pr-deep-review.md`.

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/agents@0.58.0
  - @cat-factory/orchestration@0.111.0
  - @cat-factory/integrations@0.84.1
  - @cat-factory/spend@0.12.32
  - @cat-factory/prompt-fragments@0.13.21

## 0.118.0

### Minor Changes

- a552283: PR deep-review: park a review run on its findings for a human to select which to act on.

  The read-only `pr-reviewer` no longer finishes a review task the moment it returns. Its
  sliced, prioritized findings are now recorded onto the run's `pr-reviewer` step
  (`step.prReview`) and the run PARKS for a human to visually SELECT which findings matter
  through a dedicated multi-select window (findings grouped by slice, severity badges), then
  resolve. A `pr_review_ready` inbox card (routable to Slack) is raised on park. A clean PR
  (no findings) passes through and finishes as before.

  All review state rides the step (no side table), so D1 ⇄ Drizzle parity is free; a
  cross-runtime conformance assertion covers the park → select → resolve loop. The two
  terminal resolutions — feed the selected findings to a Fixer, or post them as inline PR
  review comments — are the tracked follow-up; this ships the slicing → park → multi-select
  loop with a neutral `finish` resolution.

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0
  - @cat-factory/orchestration@0.110.0
  - @cat-factory/integrations@0.84.0
  - @cat-factory/prompt-fragments@0.13.20
  - @cat-factory/spend@0.12.31

## 0.117.0

### Minor Changes

- 55cae97: Add a **Review** task type for deep-reviewing an existing open pull request.

  A `review` task defaults to the new `pl_review` pipeline, which runs a built-in read-only
  `pr-reviewer` agent: it slices the PR's diff into cohesive chunks, reviews each within a
  bounded context (so token usage scales on huge PRs), and returns prioritized findings
  rendered in the generic structured result view. The create-task form gains a Review type
  with a target-PR field and an optional review focus.

  Foundations for the tracked follow-ups (human finding-selection + fix/inline-comment
  resolutions): a new provider-neutral `VcsClient`/`GitHubClient.listChangedFiles` method
  (implemented for GitHub), and a no-PR terminal path so read-only pipelines that open no PR
  finish cleanly as `done` instead of stranding on a confirm-and-merge notification.

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0
  - @cat-factory/orchestration@0.109.0
  - @cat-factory/integrations@0.83.3
  - @cat-factory/prompt-fragments@0.13.19
  - @cat-factory/spend@0.12.30

## 0.116.1

### Patch Changes

- Updated dependencies [d38d6c2]
  - @cat-factory/integrations@0.83.2
  - @cat-factory/orchestration@0.108.1

## 0.116.0

### Minor Changes

- f7e7139: Make `type: 'library'` frames behave correctly end-to-end (P0 of the library-frame-support
  initiative). Previously picking `library` at import/bootstrap changed almost nothing: build
  pipelines dispatched a deployer (a no-op at best) and an EXPLORATORY tester against a running
  system that a published package doesn't have, and an infra-needing library's suite failed on a
  missing DB because the harness's in-container compose stand-up was dormant.

  Behaviour now ADAPTS to the frame, not to a copy of the pipeline catalog — via a single pure
  capability profile shared by the engine + prompts:

  - **`frameProfile(type)` (contracts)** — a table beside `visual-pipeline.ts` mapping a frame's
    block `type` to `{ deployable, liveTestable, hasUi, testPosture }`. `library` ⇒ not deployable,
    not live-testable, no UI, `suite` posture; `frontend`/`service` keep their deployable/exploratory
    defaults; any other type defaults to the service profile. The resolved frame `type` is carried on
    `AgentRunContext.service.type` so the deployer/tester paths and prompts can consult it.
  - **Deployer no-ops on a library frame** regardless of its `provisioning` (a declared compose path
    on a library is repo-local TEST infra, not an environment): the runtime deploy loop records a
    library skip with an explanatory step output, and the run-start deployer-config /
    deployer-before-consumer / tester-infra gates pass through — so a library never demands a
    workspace environment handler.
  - **Tester runs in suite posture on a library frame** (`TESTER_SYSTEM_PROMPT` +
    `testerEnvironmentSection`): run the unit + integration suite, assess public-API coverage against
    the change, and author the missing tests — instead of exploratory testing of a running system.
  - **Local test infra revived for libraries** (`testerInfraSpec`): a library frame emits
    `{ environment: 'local', composePath }` when it declares a repo/package-local compose file — which
    brings the harness's dormant `standUpInfra` DinD path back to life on localhost — else
    `{ environment: 'local', noInfraDependencies }` and the tester self-manages test deps via the
    repo's `pretest:ci`/`test:ci`/`posttest:ci` lifecycle scripts. No harness image change (the
    `composePath` wire shape already exists).

  Cross-runtime conformance asserts the whole thing: a deploy+test pipeline on a task under a real
  `library` frame runs the deployer as a library no-op (provider never reached, no environment) and
  the tester to completion — even when the frame declares a `docker-compose` path.

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0
  - @cat-factory/orchestration@0.108.0
  - @cat-factory/integrations@0.83.1
  - @cat-factory/prompt-fragments@0.13.18
  - @cat-factory/spend@0.12.29

## 0.115.1

### Patch Changes

- Updated dependencies [3f3031a]
  - @cat-factory/orchestration@0.107.10

## 0.115.0

### Minor Changes

- ca9ea20: Make Kubernetes provisioning auto-detection work across monorepo layouts, and stop it
  false-positive-detecting a service's source directory as a deploy target.

  The detector (`detectKubernetesProvisioning`) previously treated ANY YAML with a
  `kind` + `apiVersion` as a Kubernetes manifest, and only looked for shared per-service
  manifest slices as immediate children of a short, flat root list (`deploy`/`k8s`/
  `kubernetes`/`manifests`/…). On a real Kustomize monorepo (source nested two levels deep,
  a Backstage `catalog-info.yaml` in every service dir, manifests under
  `deployment/k8s/base/services/<svc>` + `overlays/<env>/<svc>`) that produced two failures:
  it confidently recommended deploying the service's SOURCE folder as "raw manifests" (the
  `catalog-info.yaml` decoy), and it never found the real shared manifests. This reworks the
  heuristics to be layout-agnostic while staying deterministic and checkout-free:

  - **Manifest classifier.** A YAML doc counts as a manifest only when its API group is
    Kubernetes-shaped — core / `*.k8s.io` / kustomize / a known operator-CRD group — and NOT
    on a non-Kubernetes denylist (Backstage `backstage.io`, …). This kills the source-dir
    false positive across every Backstage-catalogued repo, and correctly disambiguates a
    Kustomize `Component` from a Backstage `Component`.
  - **Kustomize Component awareness.** A `kind: Component` slice isn't independently
    deployable; when it's the chosen source the detector resolves and recommends the overlay
    that aggregates it (via `components:`), or keeps it with a clear warning when none does.
  - **Generalized monorepo slice discovery.** A bounded, layered breadth-first search descends
    from a broadened set of deploy roots (adds `deployment`/`ops`/`gitops`/`argocd`/`flux`/…)
    THROUGH the structural layers (`base`/`services`/`apps`/`overlays/<env>`/`components`) to
    find THIS service's slice however deep it's nested, matching by exact / case-insensitive /
    affix (`<prefix>-<svc>`) name. Only the service's own matched slice(s) are surfaced —
    no more flooding the picker with every sibling — and a same-named terraform `infra/<svc>`
    sibling is not mistaken for a manifest slice.
  - **Escape hatches** (deployment `ENVIRONMENTS_DETECTION_CONVENTIONS`): `manifestDirs` adds
    house-named deploy roots, and `serviceManifestPaths` pins explicit `{service}`/`{env}`
    path templates that resolve the service→manifests mapping deterministically before the
    heuristic search — a one-line config that makes an exotic layout resolve exactly.

  Existing behaviour for colocated / simple layouts is unchanged. The stack-recipes pilot
  golden was regenerated: the consumer's Backstage `catalog-info.yaml` no longer produces a
  spurious "Kubernetes manifests also exist" note (the intended, documented drift).

### Patch Changes

- Updated dependencies [ca9ea20]
  - @cat-factory/integrations@0.83.0
  - @cat-factory/orchestration@0.107.9

## 0.114.0

### Minor Changes

- e5cd022: Speed up the "add service from an existing repo" picker's typeahead, which stalled for
  ~17s per keystroke when a broad personal access token (PAT) backed the results.

  The personal-repo branch re-walked the viewer's entire `GET /user/repos` set — up to ten
  sequential GitHub pages — on every keystroke and only applied the query as an in-memory
  filter afterwards, with nothing cached. Three changes:

  - **Cache the enumeration.** New `AppCaches.viewerRepos` slice (grouped/keyed by user id):
    the picker's typeahead now filters a cached complete set in memory instead of forcing a
    fresh full walk per keystroke. Invalidated when the user's stored `github_pat` changes;
    a short (60s) TTL backstops repos created straight on GitHub. Pass-through on the Worker's
    isolate-safe profile (external state, not self-verifying), so it caches on Node/local
    where the PAT picker is the primary flow.
  - **Parallelize the cold walk.** `FetchGitHubClient.listReposForToken` reads page 1, learns
    the page count from its `Link: rel="last"` header, and fetches the remaining pages
    concurrently — turning ~10 serial round-trips into ~2.
  - The blank browse-all path (and its fail-closed access-projection refresh) is unchanged and
    stays uncached.

  No repos are dropped: a literal GitHub `/search/repositories` call was deliberately avoided
  because it can't reproduce the enumeration's `owner,collaborator,organization_member`
  affiliation scope and would bury a low-star private repo in global results.

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/integrations@0.82.0
  - @cat-factory/orchestration@0.107.8
  - @cat-factory/agents@0.54.12
  - @cat-factory/spend@0.12.28

## 0.113.9

### Patch Changes

- 6c4bcef: fix(infra-setup): stop the false "test environment not configured" nag in local mode, and make the remaining nag actionable

  Local mode on a Docker-family runtime stands the Tester's dependencies up with the
  zero-config in-container `local-compose` backend, so a missing ephemeral-environment
  _provider_ connection is not actually a setup gap there. The infra-setup projection
  now gates the `ephemeralEnvironments` area on a new
  `ephemeralEnvironmentsRequireProvider` container flag (derived from the deployment's
  test-env capability via `testEnvHasZeroConfigDefault`) — exactly like
  `agentExecutorRequiresRunnerPool` gates the executor area — so the banner stays quiet
  where docker-compose already works and only fires where a provider is genuinely
  mandatory (the Worker, stock Node, and local Apple `container`).

  Where the nag still applies, its copy now tells the user what to do: open Test
  environments and connect a Kubernetes cluster or a custom HTTP environment provider.

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/integrations@0.81.20
  - @cat-factory/agents@0.54.11
  - @cat-factory/orchestration@0.107.7
  - @cat-factory/prompt-fragments@0.13.17
  - @cat-factory/spend@0.12.27

## 0.113.8

### Patch Changes

- b34ab46: Classify errors by structured fields, not strings, on three more paths (error-message initiative I5/I6/I7).

  - **I7 — installation-token-gone:** the App token mint now throws a named
    `InstallationTokenMintError` carrying the HTTP `status` as a field, wrapped once at the mint site
    in `GitHubAppAuth`. The stale-installation reconcile (`reconcileStaleRepos`) classifies via the
    `installationTokenMintStatusOf` extractor — an `instanceof` check deliberately specific to the mint
    error, so a repo-level 404 can never be mistaken for a gone installation — and the log-level check
    reads the repo-level `GitHubApiError.status` structurally too. Both errors throw in-process, so
    there is NO message-regex fallback (we target current installations only). The elaborated C3 remedy
    text is free to change without breaking the tombstone decision.
  - **I5 — delete the string-fallback classifiers:** with the structured `RunnerJobView.evicted` field
    and the harness `failureCause` now minted by every in-repo transport, the superseded error-string
    fallbacks are removed — `classifyAgentFailure` / `classifyBootstrapFailure` / `classifyRepairFailure`
    are gone (the sites default to the coarse `agent`), and `evictionKindOf`'s string fallback (plus
    `isTransientEviction` and the exported `TRANSIENT_EVICTION_MARKER`) is dropped in favour of reading
    the `evicted` field directly. `isContainerEvictionError` is kept for the dispatch-time eviction
    throw, which carries no job view. Backend/runtime-only; no executor-harness image change.
  - **I6 — first-wrap-point rule:** codified (the named boundaries — git stderr, pg driver errors,
    kubectl/k3s stderr — already conformed): third-party text is classified once, where it enters the
    system, into a named error with a machine field; nothing downstream re-parses the prose.

- Updated dependencies [b34ab46]
  - @cat-factory/orchestration@0.107.6

## 0.113.7

### Patch Changes

- 90a7fb3: Parallelize the real-time fan-out publisher and the GitHub sync fan-out (performance
  optimizations tracker items 12 & 14).

  Two hot paths forwarded independent work serially. Both now run their independent forwards
  concurrently; no behaviour or wire-shape change.

  - **Item 14 — `FanOutEventPublisher`:** a live change to a service mounted on N boards
    re-published the event to each mounting workspace with a `for (…) await inner.x(ws)` chain
    (N serial Durable Object round-trips per state transition on the Worker). Each method now
    `Promise.all`s the per-target forwards, so a shared service pays one round-trip's latency,
    not N. The forwards were already independent and best-effort.
  - **Item 12 — `GitHubSyncService`:** `syncRepo` fetched its branches / PRs / issues / commits
    serially and fanned each projection out to the linking workspaces one-at-a-time. The four
    independent cursor resources (each on its own installation-scoped cursor, no cross-kind
    ordering) now fetch+upsert in one concurrent wave (checks still waits on the branch head it
    needs), and each resource's per-workspace projection writes fan out via `Promise.all` — so a
    repo shared by N workspaces costs one write's latency per resource, not N. The data-scaled
    `resyncWorkspace` (per repo) and `backfillInstallation` (per workspace) loops move from
    serial to **bounded** concurrency via `p-map`, deliberately capped (4 repos / 3 workspaces in
    flight) so a large installation backfills in parallel without an unbounded burst of concurrent
    GitHub reads tripping the provider's secondary rate limits.

  Also standardizes bounded-concurrency fan-out on `p-map` instead of hand-rolled limiters: the
  existing in-tree `mapLimit` in `readServiceSpec` (`@cat-factory/server`) is replaced with `p-map`
  too, so there's one blessed helper. The `@cat-factory/agents` `Semaphore` stays (it is a shared
  FIFO permit/mutex, not a bounded map — `p-map` doesn't cover that shape); only its comment is
  corrected.

  Pure orchestration changes in the shared packages (used identically by both runtime facades);
  no persistence or conformance surface. Pinned by new unit tests for the concurrent forwards and
  the concurrent resource wave / workspace fan-out / bounded loops.

- Updated dependencies [90a7fb3]
  - @cat-factory/integrations@0.81.19
  - @cat-factory/orchestration@0.107.5

## 0.113.6

### Patch Changes

- Updated dependencies [c1028cc]
  - @cat-factory/orchestration@0.107.4

## 0.113.5

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/agents@0.54.10
  - @cat-factory/integrations@0.81.18
  - @cat-factory/orchestration@0.107.3
  - @cat-factory/spend@0.12.26
  - @cat-factory/prompt-fragments@0.13.16

## 0.113.4

### Patch Changes

- 2c7ca2e: Reuse the already-loaded list instead of looping point-reads on four engine/board paths
  (performance-optimizations initiative — items 15, 16, 17, 18). No behaviour change; each
  collapses a per-item repository read into one batched read or a reused list.

  - **`autoStartDependents` (item 15)** now resolves every dependent's pipeline from a single
    `pipelineRepository.listByWorkspace` indexed into a `Map`, instead of a `get` per dependent
    in the loop (the board "Run" default already came from the first pipeline).
  - **`InitiativeLoopService.spawn` (item 16)** loads the pipeline catalog once per tick and
    checks each spawned item's pipeline against that `Set`, instead of a `pipelineRepository.get`
    per eligible item.
  - **`BoardScanService.reconcileBlueprint` / `spawnBlueprint` (item 17)** insert missing modules
    through a new batched `BoardService.addModules` seam (resolve + list the board once for the
    whole batch), instead of `addModule` re-listing the entire board per module. `addModule` now
    delegates to it.
  - **Block delete (item 18)** — `teardownForBlockTree` returns the workspace block list it loaded
    (it deletes only run records, never blocks) and `removeBlock` accepts it via a new `preloaded`
    option, reusing it when it was loaded for the block's home workspace (the common locally-owned
    delete) and re-listing only for a mounted shared service homed elsewhere. Removes the second
    full board read the DELETE path used to pay. New shared `PreloadedBlocks` kernel type.

- Updated dependencies [2c7ca2e]
  - @cat-factory/orchestration@0.107.2
  - @cat-factory/kernel@0.123.1
  - @cat-factory/agents@0.54.9
  - @cat-factory/integrations@0.81.17
  - @cat-factory/spend@0.12.25

## 0.113.3

### Patch Changes

- 85bf0ef: Warn when a numeric env knob is set to a non-numeric value (error-message initiative A8).

  Numeric knobs are read as `num(env.SOME_VAR) ?? default`. A garbage value (`JOB_MAX_POLLS=abc`,
  a stray unit like `30s`, a trailing comma) used to coerce silently to `undefined`, so the
  caller's `?? default` swallowed the typo with no signal — the operator saw the built-in default
  in effect and no clue their override was ignored.

  - New shared `parseNumericEnv(name, value)` in `@cat-factory/server` emits ONE structured
    warning (var name, rejected value, docs link) when a PRESENT value is not a finite number,
    before falling back to the default. An unset/blank var stays silent (the default is the
    intended behaviour there), and a valid value is unchanged.
  - Both facades' local `num()` helpers (Node `config.ts` + `execution/config.ts`, Worker
    `infrastructure/config/utils.ts` — the Worker's `retentionMs` too) now delegate to it, so the
    warning reads identically across runtimes. The message lives in one shared place per the
    "keep the runtimes symmetric" rule.
  - The two knobs read at every model-config site (`AGENT_DEFAULT_TEMPERATURE`,
    `AGENT_MAX_OUTPUT_TOKENS`) are now parsed ONCE per facade and reused, so a single garbage value
    emits one warning rather than one per read site.
  - Node's retention days now go through a local `retentionMs` helper mirroring the Worker's,
    including the `days >= 0` clamp — a negative override falls back to the default on both facades
    instead of yielding a negative window on Node only.

## 0.113.2

### Patch Changes

- 17c6808: Log an elaborate operator remedy when a webhook delivery is rejected for a bad signature
  (error-message initiative C2). Both receivers — GitHub's `/github/webhooks` (HMAC over the raw
  body via `X-Hub-Signature-256`) and the neutral `/vcs/:provider/webhooks` (GitLab's
  `X-Gitlab-Token`) — keep returning the deliberately terse `401 Invalid signature` to the external
  caller, but now emit one structured `logger.warn` naming the likely setup mistake and exactly
  where to fix it. The shared `describeWebhookSignatureRejection` (`server/src/webhooks/signatureLog.ts`,
  unit-tested) tailors the message to the sub-case — no deployment secret configured (`*_WEBHOOK_SECRET`
  unset), no signature header present (the provider-side secret isn't set), or a mismatched
  signature (the two secrets differ) — and links `docs/github-integration.md#authentication` /
  `docs/vcs-providers.md#setup`. It carries no secret material, only env-var names and the
  provider settings field to compare against.

## 0.113.1

### Patch Changes

- e4c5abe: Type the harness failure-cause wire and consolidate its classifiers (error-message initiative I4).
  The kernel now owns the structured cause vocabulary — `HARNESS_FAILURE_CAUSES` /
  `HarnessFailureCause` / `isHarnessFailureCause` / `failureKindFromHarnessCause`
  (`kernel/src/domain/harness-failure.ts`), kept in step by hand with the dependency-free container
  payloads (executor-harness `FailureCause` plus deploy-harness `DeployFailureCause`, hence the
  `deploy` member) — and the three job-view ports carry the union instead of a bare string
  (`RunnerJobView.failureCause`, the failed `AgentJobUpdate` variant, `PreviewView.failureCause`).
  The mapper's internal `Record<HarnessFailureCause, 'timeout' | 'agent'>` is the drift guard: a new
  union member without a mapping fails the typecheck.

  The three per-flow copies of the cause switch are deleted in favour of that one kernel mapper:
  orchestration's `agentFailureKindFromCause` (a module export of `job.logic.ts`, now removed —
  `RunDispatcher` calls the kernel mapper), the bootstrapper's `bootstrapFailureKindFromCause`, and
  the repairer's `repairFailureKindFromCause`. Each flow keeps its own error-string regex purely as
  the no-cause fallback. `HttpRunnerPoolProvider` now narrows the pool's dot-path-mapped cause
  through `isHarnessFailureCause` (an unknown free-form value degrades to the regex fallback instead
  of riding the wire untyped), and the conformance `FakeAgentExecutor.pollFailCause` option is typed
  to the union. Container eviction stays outside the union (a transport signal —
  `RunnerJobView.evicted`). No executor-harness image bump: the harness sources are untouched.

- e4c5abe: Classify env-config-repair failures from the harness's STRUCTURED cause (error-message initiative
  I3). `ContainerEnvConfigRepairer.pollRepair` ignored the already-plumbed `RunnerJobView.failureCause`
  and classified a non-eviction failure purely by regex-matching the free-text error string. It now
  prefers the shared kernel mapper `failureKindFromHarnessCause(view.failureCause)` (the same mapper
  the execution and bootstrap paths classify through — see the I4 changeset), with the
  `classifyRepairFailure` error-string regex demoted to the fallback for an older harness image that
  reports no cause. The completed-with-error path likewise routes through the mapper instead of a flat
  `'agent'` default, so both failure sites classify identically to the bootstrap/execution paths. No
  executor-harness image bump (the signal is minted by in-repo transports).
- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/orchestration@0.107.1
  - @cat-factory/integrations@0.81.16
  - @cat-factory/agents@0.54.8
  - @cat-factory/spend@0.12.24

## 0.113.0

### Minor Changes

- 1e684b7: Add a "Test environment creation" diagnostic to the service inspector. A developer can now
  run the whole ephemeral-environment lifecycle against a throwaway branch — create branch →
  provision → tear down → delete branch — and see the live stage plus the final success/failure
  (and the stage it failed at), with guaranteed cleanup even on error.

  Modelled as a durable, observable run (its own `environment_test_runs` table on both facades)
  driven by a Cloudflare Workflow on the Worker and pg-boss on Node, with live `envTest` events
  pushed to the SPA. Adds the `RepoFiles.deleteBranch` port method (implemented once in the shared
  server layer) so the throwaway branch is reclaimed through the existing checkout-free seam.

  The always-cleans-up contract is enforced on every path: the branch is persisted before
  dispatch (a dispatch failure can't orphan it), a failed deploy view releases the runner and
  finalizes so cleanup tears down partial infra, a stop mid-provision aborts the in-flight
  deploy job, and the run's synthetic environment-registry row is always reclaimed. The
  provisioning config is pinned on the run record at dispatch, terminal writes are guarded
  (`updateIfRunning`, first-writer-wins vs the stop button), and both runtimes gain an env-test
  stale-run sweep plus self-finalization on poll-budget exhaustion so a run whose driver dies
  can never show `running` forever. The SPA store reconciles snapshots and live events by
  `updatedAt` so a stale refresh can't regress or drop a run's state.

  Schema change (no backwards-compatible migration, per project policy): a new
  `environment_test_runs` table is added to both the D1 (`0050_environment_test_runs.sql`) and
  Postgres/Drizzle schemas.

- 1e684b7: Mothership-mode GitHub support + remote persistence for environment self-test runs.

  **GitHub token delegation.** The mothership now serves a machine-authed
  `POST /internal/github/installation-token` (mounted on both facades, like the persistence
  RPC): a mothership-mode local node presents its machine token and an installation id, the
  call is rate-limited per node (fixed window on the token's signed `nodeId`) and
  account-scoped off the installation's own account binding (live row + `accountId` in the
  token scope, uniform 404 otherwise), and the mothership's GitHub App mints a short-lived
  installation token **repo-scoped via `repository_ids`** to the live App-linked
  `github_repos` projection for that installation (`user_pat`-linked rows excluded; no
  linked repos ⇒ 404) — never an installation-wide token, and never served from or written
  into the engine's unscoped token cache. Every mint/denial/failure is audit-logged with
  the node + user ids (the new kernel port method backing the scoping read is
  `RepoProjectionRepository.listByInstallation`, mirrored D1 ⇄ Drizzle). A mothership-mode
  local node with no `GITHUB_PAT` now consumes these tokens through the new
  `DelegatedAppTokenSource` — wiring the push/clone token mint AND a full `FetchGitHubClient`
  (gates, merge, repo-link, `resolveRunRepoContext`/RepoFiles) off the org's GitHub App, with
  the App private key never leaving the mothership. An explicitly configured PAT still wins;
  `GITHUB_PAT` is now optional in mothership mode.

  **Environment self-test remote persistence.** The `environment_test_runs` store is now on
  the mothership persistence allow-list (`get`/`update`/`listRunningByWorkspace` workspace-
  scoped, record-based `insert` bound on the run's `workspaceId` field), so a mothership-mode
  node persists and lists its self-test runs remotely instead of failing with
  `unknown_method`. Its former blocker — the self-test's GitHub branch create/delete — is
  served by the delegation endpoint above. A FULL mothership-mode self-test still waits on
  the provisioning writes (`environmentRegistryRepository.insert`/`update`, the
  secrets-delegation slice); until then the run fails cleanly at the provisioning stage with
  cleanup.

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/orchestration@0.107.0
  - @cat-factory/integrations@0.81.15
  - @cat-factory/agents@0.54.7
  - @cat-factory/prompt-fragments@0.13.15
  - @cat-factory/spend@0.12.23

## 0.112.10

### Patch Changes

- 5a3fe5d: Elaborate the two `REDIS_URL` failure modes (error-message initiative A7).

  - **`ioredis` missing** (REDIS_URL set, optional dep not installed): both Node Redis consumers
    (real-time cross-node propagation and distributed cache invalidation) now throw the shared
    `missingIoredisProblem` — a `ConfigValidationError` naming `REDIS_URL`, the install-or-unset
    remedy, and the docs — instead of a bare `Error` deep in boot, so it lands on the misconfigured
    fallback screen. A `REDIS_URL` entry is added to the server `ENV_HELP` registry.
  - **Bus unreachable** (REDIS_URL set, Redis down): a best-effort, timeout-bounded boot probe
    (`warnIfRedisUnreachable`, mirroring local mode's `probeGitHubPat`) now logs ONE elaborate,
    credential-free warning naming the host, the silent degradation, how to verify
    (`redis-cli -u <REDIS_URL> ping`), and the docs — instead of ioredis retrying silently while
    cross-node realtime and cache coherence are quietly degraded. Never blocks or crashes boot.

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8
  - @cat-factory/integrations@0.81.14
  - @cat-factory/agents@0.54.6
  - @cat-factory/orchestration@0.106.8
  - @cat-factory/spend@0.12.22

## 0.112.9

### Patch Changes

- 3ce997d: Structured container-eviction signal (error-message initiative I1). A container eviction is now
  carried on a typed `RunnerJobView.evicted` field (`'crash'` | `'transient'`, the new
  `ContainerEvictionKind`) minted by every runner transport (Cloudflare, the shared local
  `harnessHttp`, the local container/pool/process/native-routing transports, and Kubernetes/EKS),
  forwarded through `AgentJobUpdate`, and read by the execution / bootstrap / env-config-repair
  consumers via the new `evictionKindOf` extractor. The `(container evicted or crashed)` sentinel +
  the transient marker are PRESERVED as the fallback for an older producer, so nothing that still
  matches the string breaks — the structured field is simply the load-bearing signal now, replacing
  the regex as the primary classification channel.
- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/orchestration@0.106.7
  - @cat-factory/integrations@0.81.13
  - @cat-factory/agents@0.54.5
  - @cat-factory/spend@0.12.21

## 0.112.8

### Patch Changes

- 67dccb6: perf(caching): route workspace-settings and spend budget reads through the app cache seam (perf-tracker items 7 & 9)

  Replaces `SpendService`'s three homebrew `{ value, expiresAt }` TTL `Map`s (pricing /
  account limit / user limit) and the uncached `WorkspaceSettingsService.get` with three new
  `AppCaches` slices — `workspaceSettings`, `accountBudgetLimit`, `userBudgetLimit` — so these
  slow-moving reads are coherent across a horizontally-scaled Node deployment (a budget/settings
  edit invalidates every replica via the notification bus instead of leaving peers stale for the
  TTL). The workspace-settings row is now read through a single shared slice by
  `WorkspaceSettingsService`, `SpendService`'s pricing overlay, and
  `LlmObservabilityService.bodiesEnabled`, so one invalidation on `WorkspaceSettingsService.update`
  covers them all. The slices are pass-through on the Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate bus).

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/spend@0.12.20
  - @cat-factory/orchestration@0.106.6
  - @cat-factory/agents@0.54.4
  - @cat-factory/integrations@0.81.12

## 0.112.7

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/agents@0.54.3
  - @cat-factory/contracts@0.127.1
  - @cat-factory/integrations@0.81.11
  - @cat-factory/kernel@0.121.5
  - @cat-factory/orchestration@0.106.5
  - @cat-factory/prompt-fragments@0.13.14
  - @cat-factory/spend@0.12.19

## 0.112.6

### Patch Changes

- e68c958: feat(errors): UI-first remedies for runner-backend / runner-pool / Datadog failures (D2/D3/D4)

  Continues the error-message-coverage initiative through Section D — runtime provider failures now
  name their fix (the UI location first) and link the relevant docs, instead of surfacing a terse,
  opaque condition.

  - **D3 — `No runner backend available for workspace 'X'`** (both the Node and Cloudflare transport
    resolvers) now throws a `ConflictError` carrying the machine `reason` `agent_backend_unconfigured`
    instead of a plain `Error`. Synchronously it is a clean 409; on the async dispatch path
    `classifyDispatchFailure` lifts the reason onto the run's `AgentFailure`, so the SPA renders the
    existing "Agent backend not configured" title + jump (no new locale keys) rather than the
    misleading "container failed to start". The remedy names the UI path first (Settings → Self-hosted
    runner pool) and links `backend/docs/runner-pool-integration.md` via the new `DOCS.runnerPool`
    entry. The load-bearing `No runner backend available for workspace '<id>'` prefix is preserved.
  - **D2 — runner-pool provider errors** (`RunnerPoolApiError`: a scheduler non-2xx, a missing
    manifest secret, an OAuth-token rejection) now append a shared UI-first remedy naming where the
    pool is registered / re-tested, while preserving the raw `<method> → <status>` / `Missing secret`
    detail ahead of it (still greppable + still matched by the transport's DispatchError re-wrap).
  - **D4 — Datadog auth failure**: a `401`/`403` from the Datadog API now appends a UI-first remedy
    pointing at Integrations → Observability connection (the keys are UI-configured — no env var for
    this connection), preserving the raw `HTTP <status>` diagnostic. A non-auth status (5xx / mapping
    error) is unchanged.

  `@cat-factory/integrations` keeps its own `docs.ts` (repo-doc + vendor-URL helpers) since it sits
  below the server layer and cannot import `@cat-factory/server`'s `config/docs.ts`.

- Updated dependencies [e68c958]
  - @cat-factory/integrations@0.81.10
  - @cat-factory/orchestration@0.106.4

## 0.112.5

### Patch Changes

- e61c980: perf(dispatch): fan out independent dispatch I/O in one wave (perf item 4)

  `ContainerAgentExecutor.buildJobBody` resolved the per-dispatch inputs one after another —
  installation-token mint → work-branch ensure → auth → package registries → tester secrets →
  web-search availability — so every step dispatch (and every tester→fixer re-dispatch epoch)
  paid ~6 serial GitHub/DB round-trips of latency. Once the repo target is resolved these are
  mutually independent, so they now run in a single `Promise.all` wave (the repo-scoped token
  mint + work-branch ensure alongside the workspace/block-scoped auth / registries / secrets /
  web-search). The apriori/work-branch resolution moved into a `resolveWorkBranchReady` helper so
  it fits the wave with unchanged behaviour. The best-effort `agentContextObservability.record`
  stays awaited (with a swallowing `catch`) — it runs after the container job is already
  dispatched, so it is off the container's critical path, and a bare fire-and-forget `void` would
  be silently dropped on the Worker once the isolate hibernates on the next durable sleep. Per-kind
  job-body shapes are byte-identical.

## 0.112.4

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/orchestration@0.106.3
  - @cat-factory/integrations@0.81.9
  - @cat-factory/agents@0.54.2
  - @cat-factory/spend@0.12.18

## 0.112.3

### Patch Changes

- 6fc42ed: Elaborate GitHub App authentication failures (error-message coverage initiative, items A3/C3). A
  malformed `GITHUB_APP_PRIVATE_KEY` and a failed installation-token mint used to surface opaquely —
  long after boot, deep in a pipeline — instead of naming the cause and the fix.

  - **A3** — new shared validator `requireGitHubAppPrivateKey` (`@cat-factory/server`
    `config/problems.ts`) checks the App private key's SHAPE at config load whenever the App is
    configured: present, a PKCS#8 PEM (not the PKCS#1 key GitHub hands out), with a base64-decodable
    body. A malformed key now fails on the misconfigured screen with the exact `openssl pkcs8 -topk8`
    conversion remedy and a docs link, rather than as an opaque `crypto.subtle.importKey` rejection or
    an `atob` `InvalidCharacterError` at the first token mint. Wired into BOTH facade config loaders
    (Node `loadNodeConfig`, Worker `loadGitHubConfig`) for the default and privileged App keys, with a
    new `GITHUB_APP_PRIVATE_KEY` `ENV_HELP` entry so the message reads identically across facades.
    `GitHubAppAuth.importKey` additionally wraps the residual "valid base64 but not a real key" case
    (which slips past the shape check) with the same actionable message.
  - **C3** — `GitHubAppAuth.mintInstallationToken` now throws an elaborated message via the exported
    `explainInstallationTokenMintFailure`: 401 → wrong/rotated App private key; 404/410 → the App was
    uninstalled or the workspace points at a stale installation (reconnect GitHub); 403 → rejected /
    rate-limited (check App id + key + clock). The load-bearing first line
    (`Failed to mint installation token for <id> (HTTP <status>)`) is preserved verbatim so the
    stale-installation reconcile regexes still classify correctly — the cause + remedy is only
    appended. Unit-tested for both the elaboration and the regex compatibility.

  No behaviour changes beyond error message text and boot-time validation of an already-required key.

## 0.112.2

### Patch Changes

- edad6e6: feat(engine): batch the notification-escalation settings read (audit item 8)

  The periodic notification-escalation sweep loaded every workspace's settings with a `get`
  point-read inside the per-workspace loop — an N+1 that runs every couple of minutes on both
  facades, and one the perf-item-9 settings cache can't fix (that slice is pass-through on the
  Worker's own-mutable-D1-state profile). Adds a batched `listByWorkspaceIds` (chunked `IN`) to
  the `WorkspaceSettingsRepository` port, mirrored in both the D1 and Drizzle repos, plus
  `WorkspaceSettingsService.getMany` (defaults-filled) which `escalateStaleNotifications` now
  calls ONCE before the loop. A `defineWorkspaceSettingsSuite` cross-runtime parity assertion
  (seed → get → batched read, absent workspace absent, empty input → empty map) runs against
  both facades' real stores; the batch read stays mothership-internal (a global sweeper read).

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/orchestration@0.106.2
  - @cat-factory/agents@0.54.1
  - @cat-factory/integrations@0.81.8
  - @cat-factory/spend@0.12.17

## 0.112.1

### Patch Changes

- 3b3bdc8: Elaborate credential-decryption failure messages (error-message coverage initiative, items
  E1/E2). A wrong personal-subscription password and a corrupt/truncated stored secret used to
  surface as opaque Web Crypto errors instead of an actionable remedy.

  - **E1** — `WebCryptoPersonalSecretCipher.open` (`@cat-factory/server`) now wraps the AES-GCM
    authentication failure the same way the system cipher already wraps a rotated-key failure: the
    opaque `DOMException` ("The operation failed for an operation-specific reason") becomes "The
    personal password does not match the one this subscription was sealed under — re-enter it, or
    remove and re-add the subscription.", preserving the original as `cause`.
    `PersonalSubscriptionService.unlock` keeps its `wrong_password` reason (the 428 flow the SPA
    drives) and now carries a clean, self-sufficient message rather than nesting the raw cipher
    text in parentheses.
  - **E2** — the malformed-envelope guards in both ciphers (`WebCryptoSecretCipher.decrypt` and
    `WebCryptoPersonalSecretCipher.open`) now name the likely causes (truncated/corrupted column,
    or a value written under a different scheme/key) and the re-enter/re-seal remedy, instead of a
    terse `Invalid secret envelope`. The integrity-check failure (magic prefix absent after a
    successful GCM decrypt) is distinguished from a wrong password as corruption/tampering. The
    envelope parse (structure check + base64url decode) is wrapped as a unit, so a corrupt/undecodable
    segment inside an otherwise well-structured envelope also yields the actionable message rather
    than leaking a bare `atob` `InvalidCharacterError`.

  Also fixes a test-config gap: `@cat-factory/server`'s vitest `include` omitted the co-located
  `src/**/*.test.ts` unit tests (the crypto ciphers, provider capabilities, …), so those suites
  silently never ran; the glob now covers both `test/*.spec.ts` and `src/**/*.test.ts`.

  No behaviour changes beyond error message text.

- Updated dependencies [3b3bdc8]
  - @cat-factory/integrations@0.81.7
  - @cat-factory/orchestration@0.106.1

## 0.112.0

### Minor Changes

- d1a4129: Complete the implementation-fork decision phase with grounded CHAT (PR 2 of the initiative).
  Before the Coder writes code, a human parked on the surfaced forks can now ask questions about
  them and get a grounded, comparative answer before deciding. Each human turn is answered by an
  inline LLM in the durable driver (no container re-dispatch) over the fixed proposal grounding +
  the thread; a `maxChatTurns` budget bounds spend, and with no chat model wired the chat degrades
  to a canned "chat unavailable" reply so pick / custom still work. Adds the
  `POST /executions/:id/fork-decision/chat` endpoint, the `fork-chat` prompt (v1), the
  `ForkChatService`, the `pendingForkChat` re-entry protocol, the window chat thread, and the
  cross-runtime + e2e coverage. The fork-decision initiative tracker is converted to ADR 0022.

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/agents@0.54.0
  - @cat-factory/orchestration@0.106.0
  - @cat-factory/integrations@0.81.6
  - @cat-factory/kernel@0.121.2
  - @cat-factory/prompt-fragments@0.13.13
  - @cat-factory/spend@0.12.16

## 0.111.0

### Minor Changes

- df7a489: De-duplicate the GitHub reconcile pass across the two facades, and make every Node
  periodic sweep non-overlapping through a single seam.

  **Reconcile hoist (audit item 4).** `reconcileStaleRepos` and its two gone-installation
  classifiers were duplicated verbatim between the Worker's `sync-consumer.ts` and the Node
  `githubReconcile.ts` (the Node copy's own comment said "Mirrors the Worker's classification"),
  with no shared test — so a change to one would silently diverge (one runtime stops tombstoning
  dead installations while the other keeps working). The pass now lives once in
  `@cat-factory/server` (`reconcileStaleRepos` + `GitHubReconcileDeps`), and each facade supplies
  only its per-repo driver: the Worker enqueues on `GITHUB_SYNC_QUEUE` (or direct-syncs when
  unbound), Node direct-syncs inline. The classifiers moved verbatim (their regex→structured-code
  conversion is tracked separately as error-message-coverage I7). The 30-minute staleness window
  is now the shared exported `GITHUB_RECONCILE_STALE_MS` (previously defined independently per
  facade), and all reconcile logs — the per-repo lines AND the Worker's cron summary — now use a
  single `sweep: 'github-reconcile'` field on both facades. The Worker's queue-less direct-sync
  fallback also builds its DI container once per pass instead of once per stale repo.

  **Non-overlapping Node sweepers (audit item 6).** The DB-heavy `initiativeLoop`, `recurring`,
  and notification-escalation sweeps ran unguarded `setInterval` timers, so a pass that outlasted
  its interval could be stacked — and two concurrent `runDue` passes could both observe "no active
  run" and double-spawn. All eight Node sweeps (kaizen, github-reconcile, initiative loop,
  recurring, notification escalation, environment TTL, and both retention sweeps) now go through
  one `startSweeper` helper built on `toad-scheduler`: `preventOverrun` is the non-overlap guard,
  `runImmediately` the run-once-first behaviour, and the `AsyncTask` error handler the best-effort
  logging (each sweep names its task, so scheduler-surfaced errors identify their sweep), and
  `unref` keeps the sweep timers from holding the process alive — the same contract as the
  hand-rolled `setInterval(...).unref()` timers this replaced. A new sweeper physically cannot
  forget the guard. Adds a `toad-scheduler` (^4.1.0) dependency to `@cat-factory/node-server`.

## 0.110.5

### Patch Changes

- 473e849: Classify VCS (GitHub / GitLab) HTTP failures with cause + fix + doc links (error-message coverage
  initiative, items C1/C4/C5/C6). The `fetch`-based clients used to throw the same bare status dump
  for any non-2xx (`GitHub GET <url> → 401: <body>`), so a revoked token, an exhausted rate limit,
  and a missing scope all read identically.

  - Adds a shared kernel helper `describeVcsApiError` (`@cat-factory/kernel` `domain/vcs-errors.ts`)
    that maps `{ provider, status }` to a remedy. It PRESERVES the raw
    `<Provider> <method> <url> → <status>: <body>` first line (detectors still surface it and it stays
    greppable) and APPENDS a cause + remedy sentence: 401 → token revoked/expired (reconnect the App,
    or refresh `GITHUB_PAT` in local mode); 403 + rate-limit headers / 429 → rate limited, wait for
    the reset (App has a higher limit than a PAT); 403 → missing permission/scope + where to grant it;
    404 → repo/installation not visible to the token. GitLab gets the same shapes, GitLab-flavoured
    (`api` scope, Developer/Maintainer role). Kernel sits below the server layer so it keeps its own
    `VCS_DOC_URLS` (per the doc-URL convention) linking `backend/docs/github-integration.md` /
    `github-operations.md` / `vcs-providers.md`.
  - **C1/C6** — `FetchGitHubClient` (REST `request()` + PAT `requestWithToken()`) and
    `FetchGitLabClient.request()` / `provisioning.ts` now build their `*ApiError` message through the
    helper. Error identity still rides the structured `status` field, so classification is unchanged.
  - **C5** — `Installation X not found on any configured App` now explains the App was likely
    uninstalled or the workspace points at a stale installation, and to reconnect GitHub.
  - **C4** — `No connected GitHub repository found for workspace 'X'` (`ContainerAgentExecutor`) is now
    a `ConflictError` carrying the existing `github_not_connected` reason (was a plain `Error` → 500),
    with a UI-first remedy pointing at the GitHub connect / repo-linking flow. The SPA already maps
    that reason to a translated title.
  - **C4 (async run path)** — the durable dispatch previously caught EVERY `startJob` throw and framed
    it as a container `dispatch` failure ("The container failed to start."), so a `github_not_connected`
    precondition reached the board mislabeled and lost its `reason`. `classifyDispatchFailure`
    (`job.logic.ts`) now distinguishes a pre-dispatch domain precondition (any `DomainError`) as a
    `preflight` failure that keeps its own actionable message and propagates its `reason`, so
    `AgentFailureCard` titles it with the same translated "GitHub not connected" string the 409 toast
    uses (no new locale keys) and shows the remedy in the detail.

  No behaviour changes beyond error identity (C4's 409 + `preflight` classification on the async path)
  and message text.

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/orchestration@0.105.6
  - @cat-factory/agents@0.53.6
  - @cat-factory/integrations@0.81.5
  - @cat-factory/spend@0.12.15

## 0.110.4

### Patch Changes

- f4482c7: Reclaim a deleted board's binary artifacts (screenshots + reference images) — BOTH the
  metadata rows AND the heavy blob bytes — so they no longer leak forever.

  The artifact retention sweeps only ever iterate LIVE workspaces (`listVisible`), and
  `binary_artifacts` is deliberately excluded from the SQL workspace-delete cascade (dropping
  the metadata row without the bytes would strand the blob in object storage forever — the row
  is the only handle on its key). So before this change, deleting a board orphaned both the
  metadata rows and their backing R2 / S3 / filesystem bytes with nothing to reclaim them —
  unbounded object-storage cost with no surfacing.

  `BinaryArtifactStore` gains `deleteByWorkspace(workspaceId)` (backed by new
  `listByWorkspace` / `deleteByWorkspace` metadata-store methods, mirrored D1 ⇄ Drizzle),
  reusing the same fail-safe blobs-first-then-rows ordering as `pruneOlderThan`: a blob whose
  delete throws keeps its metadata row so a later retry can still reach the bytes rather than
  orphaning them. `WorkspaceService.delete` now purges through this port (best-effort — a
  storage outage can't wedge the board delete) before the row cascade runs. The cross-runtime
  binary-artifact conformance suite asserts the reclaim removes every artifact's rows + bytes,
  scoped to the workspace, on both D1 and Postgres. (system-audit-improvements initiative,
  item 3.)

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/agents@0.53.5
  - @cat-factory/integrations@0.81.4
  - @cat-factory/orchestration@0.105.5
  - @cat-factory/spend@0.12.14

## 0.110.3

### Patch Changes

- cc6d554: Elaborate the model-provisioning failure messages with cause + fix + doc links (error-message
  coverage initiative, items B1–B4). Each terse throw now names the condition, the likely cause,
  the exact remedy (UI-first where the setting is UI-configurable, the env var otherwise), and links
  `backend/docs/model-support.md` / `docs/environment-variables.md`.

  - **B1** — `Unsupported model provider: X` (`CompositeModelProvider.resolve`) now explains that the
    provider has no credentials configured, names the workspace AI provider key pool as the primary
    fix for the UI-configurable direct providers and the deployment env vars (`CLOUDFLARE_*`,
    `BEDROCK_REGION`) as the alternative, and lists the currently-registered providers as a diagnostic.
  - **B2** — `Unsupported Bedrock model: X` now names the `BEDROCK_MODELS` allow-list, echoes the
    models it currently permits, and tells the operator to add the id or pick an allowed one.
  - **B3** — LiteLLM selected without a base URL gets a dedicated remedy naming `LITELLM_BASE_URL`
    (an operator-hosted gateway has no public default), instead of the generic "no base URL" message.
  - **B4** — `No base URL configured for OpenAI-compatible provider 'X'` now names the
    `${PROVIDER}_BASE_URL` var and the workspace key pool. The inline model resolver and the container
    LLM proxy share one helper (`openAiCompatibleBaseUrlError`) so both surfaces read identically.

  Adds a small `providers/docs.ts` doc-URL module to `@cat-factory/agents` (it sits below the server
  layer, so it cannot use `@cat-factory/server`'s `config/docs.ts`); `@cat-factory/provider-bedrock`
  imports it. No behaviour changes beyond the message text.

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4
  - @cat-factory/orchestration@0.105.4

## 0.110.2

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/agents@0.53.3
  - @cat-factory/integrations@0.81.3
  - @cat-factory/orchestration@0.105.3
  - @cat-factory/spend@0.12.13

## 0.110.1

### Patch Changes

- dbfe2e8: Boot-time structured warnings for three previously-silent misconfigurations (error-message
  coverage initiative, items A5/A9/A10). Each is a single greppable WARN naming the offending
  var, its consequence, and a doc link — behaviour is unchanged (the conditions were, and stay,
  non-fatal); they were just invisible until the first dispatch failed.

  - **A5** — the Node facade's container agent executor is disabled when a prerequisite is
    missing (`PUBLIC_URL`, `AUTH_SESSION_SECRET`, a runner backend, or a GitHub token source),
    but the service still boots "healthy" and repo-operating steps (coder/mocker/tester/merger/…)
    failed only at dispatch, deep in a request. It now logs at boot exactly which prerequisite is
    missing, so the gap is visible up front (the Worker already throws a `configProblem` here).
  - **A9** — an unrecognised `LOCAL_CONTAINER_RUNTIME` value silently fell back to `docker`; the
    local preflight now names the rejected value, the accepted set
    (`docker`/`podman`/`orbstack`/`colima`/`apple`), and the fallback taken.
  - **A10** — a half-set `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` pair silently disabled
    Cloudflare Workers AI (over REST) on the Node facade; config load now names which half is set
    and which is missing.

  Adds a `localMode` section anchor to `@cat-factory/server`'s `ENV_VARS_ANCHORS` so the A9
  warning deep-links the local-mode env-var docs.

## 0.110.0

### Minor Changes

- 8d65179: Boot-time configuration validation for three previously-opaque failures (error-message
  coverage initiative, items A2/A4/A6):

  - **A2** — the system `ENCRYPTION_KEY` is now validated at config load on every facade
    (present, valid base64, decoding to a full AES-256 key) via a shared
    `requireEncryptionKey` helper in `@cat-factory/server`, wired into the Node and Worker
    config loaders and reused by local mode. A malformed key fails with an actionable,
    doc-linked message on the misconfigured screen instead of lazily deep inside the first
    cipher build (a bare "must decode to at least 32 bytes" or an opaque `atob` error).
  - **A4** — the Cloudflare Worker's primary `DB` binding is guarded by `requireDb` at
    container build, mirroring `requireTelemetryDb`, so an unbound/misnamed binding fails
    fast with a `[[d1_databases]]` remedy rather than NPE-ing deep in the first repository
    call.
  - **A6** — an invalid `DB_SCHEMA` / `DB_MIGRATIONS_SCHEMA` on the Node facade now throws a
    `ConfigValidationError`, so it reaches the "backend misconfigured" fallback screen
    instead of hard-crashing the process with an opaque message.

- a5dcf7d: Prune resolved notifications on the retention sweep. The `notifications` table was
  never pruned on either facade (upsert/escalate only, no delete), so resolved
  (acted/dismissed) cards accumulated without bound on a table read on the snapshot hot
  path. A new `NotificationRepository.deleteResolvedOlderThan(cutoff)` port method
  (mirrored D1 ⇄ Drizzle) is wired into both facades' retention sweeps under a new
  `RetentionConfig.notificationsMs` window (`NOTIFICATION_RETENTION_DAYS`, default 90
  days). Only terminal rows past the window are deleted — `open` cards (the actionable
  inbox) are never touched. Covered by a new cross-runtime notification conformance
  suite. (system-audit-improvements initiative, item 1.)

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0
  - @cat-factory/agents@0.53.2
  - @cat-factory/integrations@0.81.2
  - @cat-factory/orchestration@0.105.2
  - @cat-factory/spend@0.12.12

## 0.109.0

### Minor Changes

- 5072999: Boot-time configuration problems now carry a documentation link. Each `ENV_HELP`
  entry embeds a stable in-repo doc URL (built through a new centralized `DOCS`
  helper in `@cat-factory/server`), the operator log appends a `Docs:` line, and the
  "backend misconfigured" screen renders a "View documentation" link per problem.
  This establishes the doc-URL convention for the error-message coverage initiative
  (item A1).

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/agents@0.53.1
  - @cat-factory/integrations@0.81.1
  - @cat-factory/kernel@0.118.1
  - @cat-factory/orchestration@0.105.1
  - @cat-factory/prompt-fragments@0.13.12
  - @cat-factory/spend@0.12.11

## 0.108.0

### Minor Changes

- 4f936de: Add the optional implementation-fork decision phase on the Coder step. Before the Coder
  writes code, a read-only `fork-proposer` explore agent can aggressively surface the materially
  different ways to implement a task; the run parks for a human to pick a proposed fork or enter
  their own approach, and the chosen approach is folded into the Coder's prompt as a binding
  directive. The phase is gated per-task by a tri-state (`auto`/`always`/`off`) and, in `auto`,
  by an estimate gate on the workspace risk policy (`riskPolicy.forkDecision`, disabled by
  default). All state rides the run's coder step (`step.forkDecision`), so it is
  runtime-symmetric across the Cloudflare and Node facades (D1 ⇄ Drizzle: the new
  `merge_threshold_presets.fork_decision` column). This slice ships propose → park → choose →
  Coder plus the single-path auto-advance; grounded chat about the forks lands in a follow-up.

  Breaking: the built-in merge-threshold preset catalog version is bumped (Balanced /
  Manual review only → v3) to seed the new `forkDecision` gate; workspaces are advised to reseed.
  The `build` Coder prompt is bumped to v4 and a new `fork-proposer` v1 prompt is added.

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/agents@0.53.0
  - @cat-factory/orchestration@0.105.0
  - @cat-factory/integrations@0.81.0
  - @cat-factory/prompt-fragments@0.13.11
  - @cat-factory/spend@0.12.10

## 0.107.10

### Patch Changes

- 4b8fc5f: Apriori branches (slice 3): reference mode.

  A task can now attach pre-existing branches of its PRIMARY repo as READ-ONLY reference points
  (a spike / prototype / prior-art branch) that the consumer agents may inspect but never commit
  to. See `docs/initiatives/apriori-branches.md`.

  - **Harness** (image bump): the `agent` job gains an optional `referenceBranches?: string[]`.
    After the primary checkout each named branch is fetched into its `origin/<b>` tracking ref
    (`git fetch --no-tags origin +refs/heads/<b>:refs/remotes/origin/<b>`), best-effort per
    branch (a vanished branch is warned + skipped, never fatal) — the only place with git
    network credentials, since the primary clone is shallow single-branch and the agent has none.
    Wired into the single-repo coding + explore flows and the multi-repo primary legs.
  - **Backend**: `ContainerAgentExecutor` lifts the task's `reference` apriori branches for the
    consumer kinds (`coder` / `spec-writer` / `doc-writer` / `architect` / `analysis`), PROBES
    each at dispatch and DROPS a missing one (asymmetric with a missing WORKING branch, which
    fails loudly), and renders a "Reference branches" system-prompt section (read via
    `git log origin/<b>`, two-dot `git diff origin/<b>`, `git show origin/<b>:<path>`, or a
    `git worktree`) that forbids committing to or pushing them. The section + `referenceBranches`
    ride both the coding and explore job bodies.

## 0.107.9

### Patch Changes

- Updated dependencies [e254ef5]
  - @cat-factory/orchestration@0.104.1

## 0.107.8

### Patch Changes

- 127fe3e: Apriori branches (slice 2): working mode.

  A task's single optional `working` apriori branch now drives the run — the agents start from
  and keep committing into that pre-existing branch instead of minting `cat-factory/<blockId>`,
  and the PR opens from it, the CI gate polls it, and the merger merges it. See
  `docs/initiatives/apriori-branches.md`.

  - **Context**: the engine lifts the block's `aprioriBranches` verbatim onto the agent run
    context (`AgentRunContext.aprioriBranches`), a pure projection like `referenceRepos`.
  - **Work-branch swap**: `ContainerAgentExecutor.buildJobBody` and the two `RunDispatcher`
    repo-op sites (`resolveRepoOpBranch` + the spec-writer `builtInRepoOpBranch`) resolve the
    work branch as `resolveAprioriWorkingBranch(...) ?? cat-factory/<blockId>`, so every
    downstream builder (`newBranch` / `pushBranch` / explore fallback / PR head) rides the
    user's branch. The base-branch rejection is a single shared `resolveAprioriWorkingBranch`
    helper (`@cat-factory/contracts`) so the executor and dispatcher rejections can't drift.
  - **Probe, never create**: an apriori working branch must already exist — it is probed
    (`ensureWorkBranch(..., { create: false })`, or a checkout-free `headSha`), and a missing
    branch fails the dispatch loudly rather than being silently created off base. A working
    branch equal to the repo base is rejected.
  - **Merge teardown guard**: `GitHubPullRequestMerger` only deletes a merged head branch when
    it is a platform `cat-factory/*` branch — a user-provided apriori branch is never torn down
    (reusing a merged apriori branch on a later task intentionally resumes it).
  - **Conformance**: a cross-runtime assertion that a custom kind's post-op commits onto the
    task's apriori working branch instead of `cat-factory/<blockId>` on both stores.

- Updated dependencies [127fe3e]
  - @cat-factory/orchestration@0.104.0
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/agents@0.52.9
  - @cat-factory/integrations@0.80.6
  - @cat-factory/prompt-fragments@0.13.10
  - @cat-factory/spend@0.12.9

## 0.107.7

### Patch Changes

- 774908c: Perf: project live execution runs instead of loading every run's `detail` (performance-optimizations item 3).

  - New `ExecutionRepository.listLive(workspaceId)` port method returns a lean
    `{ id, blockId, status }` projection of a workspace's LIVE runs (`running`/`blocked`/`paused`)
    without decoding the heavy serialized `detail` column. Implemented on both the D1 and Drizzle
    repos and asserted by the cross-runtime conformance suite.
  - `ExecutionService`'s per-service task-concurrency dispatch guard and `resumePaused` now use
    `listLive` instead of `listByWorkspace`, which previously loaded and JSON-decoded EVERY
    historical run in the workspace just to keep the handful of live rows — so the cost now scales
    with concurrency, not unbounded run history.
  - Adds the supporting `idx_agent_runs_ws_kind_status` index on `(workspace_id, kind, status)` to
    both runtimes (D1 migration `0048_agent_runs_ws_kind_status.sql` ⇄ Drizzle schema + migration).
  - Exposes `listLive` on the mothership-mode persistence allow-list (workspace-scoped read).

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/orchestration@0.103.1
  - @cat-factory/agents@0.52.8
  - @cat-factory/integrations@0.80.5
  - @cat-factory/spend@0.12.8

## 0.107.6

### Patch Changes

- 08a7da2: Apriori branches (slice 1): data model + write-boundary + persistence.

  A task (`Block`) can now name pre-existing branches of its primary target repo via a new
  optional `aprioriBranches` field — an array of `{ name, mode: 'reference' | 'working' }`.
  `reference` branches are read-only context; the single optional `working` branch is the one
  the run keeps building inside (later slices). See `docs/initiatives/apriori-branches.md`.

  - **Contracts**: `aprioriBranchSchema` + `AprioriBranch`, the `aprioriWorkingBranch` /
    `aprioriReferenceBranches` helpers, an `isSafeGitBranchName` git-ref-safety check, the new
    `blockSchema` field, and `aprioriBranches` on `updateBlockSchema` (capped at 20). Re-exported
    from `@cat-factory/kernel`.
  - **Persistence**: a shared `apriori_branches` JSON text column mirroring `reference_repos`
    (empty-array-is-NULL) — D1 migration `0048_apriori_branches.sql` ⇄ Drizzle schema column +
    generated migration, picked up by both stores through the shared `blockFields` mapper.
  - **Write boundary**: `BoardService.updateBlock` drops the field on non-task blocks and enforces
    the cross-entry invariants via `aprioriBranchesError` — at most one `working` entry, no
    duplicate names, the working entry frozen once a PR exists, and no working entry on a
    multi-repo (`involvedServiceIds`) task.
  - **Conformance**: a cross-runtime round-trip asserting the column survives PATCH + snapshot
    read on both stores, clears to absent, and rejects the invalid shapes.

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/orchestration@0.103.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/agents@0.52.7
  - @cat-factory/integrations@0.80.4
  - @cat-factory/prompt-fragments@0.13.9
  - @cat-factory/spend@0.12.7

## 0.107.5

### Patch Changes

- 87f835a: Perf: cut redundant GitHub reads on the gate-poll path (performance-optimizations item 2).

  - `FetchGitHubClient` memoizes a repo's numeric id per `(installationId, owner, repo)` in a
    process-level map (the mapping is immutable, same justified pattern as `ownerAppCache`), so
    the `/repos/{owner}/{repo}` backfill behind `listBranches`/`listIssues`/`listCommits`/
    `listCheckRuns` runs once instead of on every call.
  - `GitHubCiStatusProvider` resolves a PR head via one exact `branchHeadSha` ref lookup instead
    of paging the branch's commit list just to read `items[0]`.
  - `PatPreferringAppRegistry` resolves the run initiator's PAT once per `runWithInitiator`
    scope (one gate probe / merge boundary) via a per-scope memo, instead of a fresh DB read +
    decrypt on every GitHub `request()` the probe fans out.

## 0.107.4

### Patch Changes

- 6b968bb: fix(notifications): claim a notification atomically before acting (race-audit 3.1)

  Acting on a human-actionable notification (confirm+merge a `merge_review`/`pipeline_complete`,
  retry a `ci_failed`/`test_failed`) now atomically claims the open card (`open` → `acted`)
  BEFORE running its side effect, so two concurrent acts — a double-click, two members' inboxes,
  an HTTP retry — can no longer both fire the merge/retry. The new
  `NotificationRepository.claimForAction` is a single conditional `UPDATE … WHERE status='open'
RETURNING *` (the `PasswordResetTokenRepository.consume` shape) mirrored on both runtimes
  (D1 ⇄ Drizzle); only the writer that wins the flip runs the side effect. A failing side effect
  reverts the card to `open` so the action stays retryable, without the double-fire window.

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/orchestration@0.102.8
  - @cat-factory/agents@0.52.6
  - @cat-factory/integrations@0.80.3
  - @cat-factory/spend@0.12.6

## 0.107.3

### Patch Changes

- Updated dependencies [a650396]
  - @cat-factory/orchestration@0.102.7

## 0.107.2

### Patch Changes

- eeadc97: Share services across boards, archive services with unfinished tasks, and stop board deletion from
  orphaning or destroying shared services.

  - **Importing a repo that already backs an org service now MOUNTS the shared service** onto the
    current board (one shared subtree + task list) instead of failing with "already linked". Two teams
    in one organization can therefore work on the same service. Re-adding a repo already on the board
    is an idempotent no-op; a repo whose service lives on another board becomes addable (it mounts).
  - **Deleting a board no longer destroys a service another board still mounts.** The delete cascade
    now RE-HOMES each shared service (its blocks + run history) to a surviving mounting board, so it
    lives on there. A service no other board mounts is still fully reclaimed, so its repo is
    re-addable — mirrored across the Cloudflare (D1) and Node (Drizzle) facades (new
    `WorkspaceRepository.delete(id, rehome)` + `WorkspaceMountRepository.listByServiceIds`).
  - **Board (workspace) deletion reclaims its account-owned services** (the un-shared ones). A dangling
    service — account-scoped, looked up by `(installation_id, repo_github_id)` — used to keep the SAME
    repo from being re-added on any other board. The cascade removes the workspace's un-shared homed
    services, every board's mount of them, this board's own mounts, and its environments.
  - **Services with unfinished tasks can no longer be deleted — they are archived instead.**
    Archiving hides a service (its frame + whole subtree) from the board while preserving every row;
    it can be restored at any time with no expiry. New `POST /blocks/:id/archive` and
    `POST /blocks/:id/restore` endpoints, an `archived` column on `blocks` (both runtimes), an
    `archivedServices` list in the workspace snapshot, and inspector/toolbar affordances in the SPA.
    An archived shared service is now correctly hidden on every board that mounts it (not just its
    home) and restorable from any of them.
  - The acting tab now drops a deleted service from its local catalog after the delete commits, so a
    repo becomes re-addable immediately without waiting for a full refresh (the tab is not echoed its
    own board event).

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/orchestration@0.102.6
  - @cat-factory/agents@0.52.5
  - @cat-factory/integrations@0.80.2
  - @cat-factory/spend@0.12.5
  - @cat-factory/prompt-fragments@0.13.8

## 0.107.1

### Patch Changes

- cb7fd14: Validate the personal-subscription password cache against an 8h expiry buffer on every
  gated action (start / confirm / retry), so the user is prompted to re-enter early — while
  they are present at the action — instead of the key lapsing mid-pipeline and surfacing as a
  broken run that asks for a retry.

  - Frontend (`@cat-factory/app`): a cached key with under 8h of runway left is withheld on
    the first attempt of a gated action, so the server's existing `428 credential_required`
    gate re-challenges and the modal refreshes the full window. The mid-run confirm actions
    (resolve decision / approve step / request changes / resolve-exceeded) now flow through
    the same `withCredential` prompt path as start/retry.
  - Backend (`@cat-factory/server`): **behavior change** — the run-interaction endpoints
    (resolve decision / approve / request changes / resolve-exceeded) now hard-gate for
    individual-usage runs (mint a fresh activation via `personalGateForRun`, 428 when the
    password is needed but absent/withheld) instead of a silent best-effort re-mint, so an
    early re-entry can be surfaced mid-run. The `remintActivations` helper is removed.
  - `@cat-factory/integrations`: removed the now-unused `PersonalSubscriptionService.refreshActivations`.
  - `@cat-factory/kernel` + the runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`,
    `@cat-factory/local-server`): dropped the now-dead `SubscriptionActivationRepository.refresh`
    port method and its D1 / Drizzle / SQLite implementations — its only caller
    (`refreshActivations`) is gone, so activations are now only ever minted at full TTL via
    `activateForRun`, never TTL-extended in place.

- Updated dependencies [cb7fd14]
  - @cat-factory/integrations@0.80.1
  - @cat-factory/kernel@0.117.1
  - @cat-factory/orchestration@0.102.5
  - @cat-factory/agents@0.52.4
  - @cat-factory/spend@0.12.4

## 0.107.0

### Minor Changes

- be54a32: Subscription quota-cycle tracking, Part B1 (usage-and-quota-tracking): model "how much of a
  subscription's quota cycle is left" for the flat-rate harnesses (Claude Code / Codex / GLM /
  pooled Kimi & DeepSeek), which the spend ledger excludes.

  Adds the `SubscriptionQuotaProvider` port + `SubscriptionQuotaCycleRepository` and the
  `subscription_quota_cycles` table (mirrored across D1 and Drizzle/Postgres), plus
  `RegistrySubscriptionQuotaProvider` — a vendor-neutral composite (mirroring
  `RegistryReleaseHealthProvider`) that folds each finished subscription run's tokens into rolling
  `5h` + `weekly` windows anchored at first observed use, and reports the cycle either from a real
  per-vendor adapter or the MODELED fallback (persisted counters measured against per-vendor config
  ceilings). The adapter registry is empty today — the real Claude/GLM reads land in Part B2 (an
  executor-harness image bump), so every vendor currently reports modeled. `ContainerAgentExecutor`
  records usage for BOTH pooled runs (scope = the leased pool token) and personal runs (scope = the
  run initiator); it's wired into every facade, and covered by a cross-runtime conformance suite.
  Modeled numbers are illustrative and NEVER billed — the metered-only spend gate is unchanged.

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/integrations@0.80.0
  - @cat-factory/agents@0.52.3
  - @cat-factory/orchestration@0.102.4
  - @cat-factory/spend@0.12.3

## 0.106.3

### Patch Changes

- Updated dependencies [51869b8]
- Updated dependencies [2924e32]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/spend@0.12.2
  - @cat-factory/orchestration@0.102.3
  - @cat-factory/agents@0.52.2
  - @cat-factory/integrations@0.79.3

## 0.106.2

### Patch Changes

- @cat-factory/orchestration@0.102.2

## 0.106.1

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/orchestration@0.102.1
  - @cat-factory/kernel@0.115.1
  - @cat-factory/agents@0.52.1
  - @cat-factory/integrations@0.79.2
  - @cat-factory/spend@0.12.1

## 0.106.0

### Minor Changes

- b83bcc8: Requirements review: auto-recommend answers for findings that don't need a business decision.

  The requirements reviewer now classifies each finding it raises as `autoAnswerable` — answerable
  confidently from universal engineering/product best practice or the context already provided
  (vs. needing a genuine business/product decision). For the `autoAnswerable` findings, the
  Requirement Writer AUTO-generates a grounded recommendation and it is auto-accepted as the
  finding's **default answer** (pre-filled, editable, dismissable), so the human only hand-answers
  the findings that genuinely need their input. Findings needing a business decision are left blank
  and flagged "needs your input"; the human still drives incorporation. The reviewer prompt is
  bumped to `requirement-review@v3`.

  The behaviour is configurable per pipeline step: a new **auto-recommendation** toggle on the
  `requirements-review` step in the pipeline builder (**on by default**). Disabling it reverts to
  the fully-manual flow (answer or request recommendations for every finding).

  This introduces the extensible per-step **`stepOptions`** seam — a single JSON bag
  (`pipelines.step_options`, parallel to `agentKinds`) that is the going-forward home for new
  per-step pipeline parameters, replacing the "one array + one column per knob" pattern
  (`autoRecommend` is its pilot field). See `docs/initiatives/pipeline-step-options.md` for
  folding the legacy per-step arrays (`gates`/`thresholds`/`enabled`/`consensus`/`gating`/
  `followUps`/`testerQuality`) into it.

  Persistence: a new nullable `step_options` column on `pipelines`, mirrored across the D1 and
  Drizzle stores (no data migration — absent ⇒ all defaults). Requirement-review items and
  recommendations gain optional `autoAnswerable` / `auto` fields (stored in the existing JSON
  columns, no migration).

- b83bcc8: Requirements review UX + per-task risk policy rename + document default pipeline.

  **Requirements review — per-finding recommendation guidance & inline recommendations.** Each
  finding now has an explicit 3-way selector (Answer / Dismiss / Recommend) in place of the old
  button row. Typing an answer marks the finding "You answered"; choosing **Recommend** carries
  whatever you typed over as **per-finding guidance** that steers the Requirement Writer's
  suggestion (shown on-screen as guidance, not saved as the answer). Recommendations now render
  **inline inside their source finding card** — generating spinner, the ready suggestion with
  accept/reject/re-request — instead of a separate section below. The request-recommendations wire
  contract changes from `{ itemIds, note }` to `{ items: [{ itemId, note? }] }` so each finding in a
  batch can steer the Writer differently.

  **Auto-recommendation on every round.** Auto-recommendation now also runs after an off-path
  re-review (not only the pipeline-driven incorporation cycle), so every iteration round that
  introduces new questions gets its auto-answerable findings pre-answered.

  **"Merge threshold preset" renamed to "Risk policy".** The per-task/per-workspace preset governs
  merge ceilings, CI-fixer attempts, requirement/tester iteration caps and release-health watch — a
  broader risk-management surface than "merge". It is renamed to **Risk policy** across the wire
  contracts, kernel/domain types, services, HTTP routes (`/workspaces/:ws/merge-presets` →
  `/risk-policies`), repositories, and the SPA (store/util/panel/i18n). `Block.mergePresetId` →
  `Block.riskPolicyId`. Iteration caps stay on the policy (per your risk-management model) — no
  functional change. The physical DB table/column names are retained internally (mapped to the new
  domain names), so there is no data migration.

  **Document tasks default to the document pipeline.** A `taskType: 'document'` task now defaults to
  the document-authoring pipeline (`pl_document`) instead of the full-build pipeline, which produces
  no code and needs no spec/tests. Overridable per task as before.

- a0c6934: Token-usage tracking for BOTH metered API traffic and flat-rate subscription harnesses
  (usage-and-quota-tracking initiative, Part A). The `token_usage` spend ledger gains a
  `billing` discriminator (`metered` | `subscription`) + `vendor` column, and subscription
  harness usage (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) — previously kept out of
  the ledger entirely — is now recorded durably for reporting. The budget gate is unchanged:
  every spend rollup (`status` / `isOverBudget` / the account & user tiers) filters
  `billing = 'metered'`, so a flat-rate quota call is counted for the usage report but never
  inflates spend or trips a budget.

  New `GET /workspaces/:ws/usage` returns the current period's usage broken down by
  `(billing, vendor, provider, model)`, surfaced in a new "Usage" tab in Workspace Settings
  (both metered and subscription usage, with per-model progress bars). Subscription cost is
  illustrative (the equivalent metered-API cost), never billed.

  D1 migration `0044_usage_billing.sql` ⇄ the Drizzle schema + generated migration; the
  cross-runtime conformance suite pins the metered-vs-subscription split on both stores. No
  data migration — existing rows default to `metered`.

  (The `@cat-factory/executor-harness` bump is a test-only type fix — its fake
  `TokenUsageRepository` gains the new `usageBreakdownForWorkspace` method; nothing in the
  runner image changed.)

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0
  - @cat-factory/orchestration@0.102.0
  - @cat-factory/spend@0.12.0
  - @cat-factory/integrations@0.79.1
  - @cat-factory/prompt-fragments@0.13.7

## 0.105.0

### Minor Changes

- 0f3c88b: feat(testing): sealed sensitive test credentials, delivered to the Tester out of band

  Add a SEALED per-service store for sensitive testing credentials (e.g. a third-party API
  token a Tester needs), the sibling of the non-sensitive test-credential pools. Values are
  encrypted at rest by the facade `SecretCipher` (info tag `cat-factory:test-secrets`, mirroring
  `observability_connections`) and delivered to the Tester container **out of band**: decrypted at
  dispatch, carried on a dedicated job-body field the agent-context snapshot allow-list omits, and
  injected by the harness as container environment variables the agent reads (`$KEY`). The tester
  prompt advertises only each secret's key + description (never the value). Per service frame,
  resolved up the frame chain like release-health config; mirrored across both runtimes (D1 +
  Drizzle) with a cross-runtime conformance assertion.

  New API: `GET|PUT|DELETE /workspaces/:ws/services/:blockId/test-secrets` (values write-only).

  This is Slice C of the tester-environment-access initiative; the Test Data Seeder agent
  (Slice D) is a tracked follow-up. See docs/initiatives/tester-environment-access.md.

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/agents@0.51.0
  - @cat-factory/integrations@0.79.0
  - @cat-factory/orchestration@0.101.0
  - @cat-factory/prompt-fragments@0.13.6
  - @cat-factory/spend@0.11.24

## 0.104.2

### Patch Changes

- ed77be6: Initiative-preset registry → app-owned DI (slice 5 of the custom-initiative-definitions
  initiative; registry-DI-migration "Initiative presets" row). The module-global initiative-preset
  registry is replaced by an app-owned `InitiativePresetRegistry` instance the composition root news,
  threads through `CoreDependencies`, and re-exposes on `Core` — mirroring the agent-kind registry.
  This removes the shared process state and the external-adapter module-identity gotcha: a deployment
  registers its own presets by reference on the instance the facade injects.

  BREAKING: the free `@cat-factory/kernel` exports `registerInitiativePreset`,
  `registerInitiativePresets`, `getInitiativePreset`, `allInitiativePresets`,
  `initiativePresetDescriptors`, and `clearRegisteredInitiativePresets` are removed. Use the new
  `InitiativePresetRegistry` class (kernel) + `defaultInitiativePresetRegistry()` factory
  (`@cat-factory/agents`, preloads the built-in generic / docs-refresh / tech-migration presets)
  instead, and inject it via the facade's composition seam — `createApp({ overrides: {
initiativePresetRegistry } })` on the Worker, or the `initiativePresetRegistry` option on `start()`
  / `startLocal()`. `registerDocsRefreshPreset` / `registerTechMigrationPreset` now take the registry
  as a parameter (no bottom-of-module self-registration). No data migration — pre-1.0, no back-compat.

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/agents@0.50.0
  - @cat-factory/orchestration@0.100.2
  - @cat-factory/contracts@0.121.2
  - @cat-factory/integrations@0.78.8
  - @cat-factory/spend@0.11.23
  - @cat-factory/prompt-fragments@0.13.5

## 0.104.1

### Patch Changes

- 7ee2530: Internal cleanup: prune dead/needless exports flagged by knip (no runtime behaviour
  change). ~110 findings resolved — genuinely-dead symbols deleted (e.g. the unused
  `ENVIRONMENT_ANALYSIS_PIPELINE_ID` / `INITIATIVE_BREAKDOWN_PIPELINE_ID` pipeline-id
  constants, `isCiStatusProviderWired`, `parseApiKeyProvider`, unused re-export members of
  the runtime facade barrels), and the `export` keyword dropped from symbols only used
  inside their own module (repository classes, config constants, helper types). Also tidied
  stale `knip.jsonc` baseline entries (removed no-longer-needed `ignore` / `ignoreDependencies`
  and dead entry-glob patterns).

  The residual knip warnings are now all DELIBERATE: the neutral `VcsClient` port type
  re-export barrel, the Worker config-type barrel, the `providerEndpoints` base-URL group,
  and a couple of types that must stay exported for declaration emit. Since backwards
  compatibility is a non-goal pre-1.0, the removed exports (which nothing imported) are
  dropped outright rather than deprecated.

- Updated dependencies [7ee2530]
  - @cat-factory/agents@0.49.3
  - @cat-factory/integrations@0.78.7
  - @cat-factory/kernel@0.112.1
  - @cat-factory/orchestration@0.100.1
  - @cat-factory/spend@0.11.22

## 0.104.0

### Minor Changes

- f25d5e2: Complete the two deferred service-connections Phase 4 multi-repo follow-ups.

  **Conflict-resolver peer targeting.** The `conflicts` gate now ESCALATES a conflict on a
  connected involved service's PEER repo (previously it declined escalation and fast-failed the run
  to a manual give-up). The gate still tags which repo conflicted (`conflictTarget`); the engine
  threads that onto the dispatched `conflict-resolver`'s context, and the container executor points
  the (single-repo) resolver at THAT peer repo — resolving its target, cloning its PR (work) branch,
  and merging the peer's base in — instead of always the task's own service. An own-repo conflict is
  unchanged (no `frameId` ⇒ the own service is the implicit target). Handles the peer-only case (own
  service unchanged, so no own PR) by pinning the resolve branch to the shared work branch.

  **Merger combined-diff.** The `merger` now scores the COMBINED cross-repo change on a multi-repo
  task instead of only the own-repo diff. Driven by the PRs that actually exist
  (`block.peerPullRequests`), it clones each peer PR's repo as a read-only sibling checkout at its PR
  branch (full history) alongside the own service, and a "Multi-repo pull request" prompt section
  plus the reworked merger prompts instruct it to diff each repo against its base and return ONE
  blended complexity/risk/impact assessment covering the whole change. The read-only multi-repo
  explore harness path gained per-peer `cloneBranch` selection and honours the job's `full` flag (a
  new container capability — the executor-harness image is bumped), so the bug-investigator's
  base-branch fan-out is unchanged while the merger checks each peer out at its PR head.

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/orchestration@0.100.0
  - @cat-factory/agents@0.49.2
  - @cat-factory/integrations@0.78.6
  - @cat-factory/spend@0.11.21

## 0.103.1

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/orchestration@0.99.1
  - @cat-factory/agents@0.49.1
  - @cat-factory/integrations@0.78.5
  - @cat-factory/kernel@0.111.1
  - @cat-factory/prompt-fragments@0.13.4
  - @cat-factory/spend@0.11.20

## 0.103.0

### Minor Changes

- 63f7881: Code Commenter is now a business-as-usual step in the full build pipelines, keeping in-source
  comments relevant and up to date on every task instead of only on a dedicated standalone run.

  - **Full pipelines gain a `code-commenter` step** (`pl_full` and `pl_fullstack`, versions bumped
    for the reseed): it runs right after the `reviewer` clears the implementation and edits comments
    only — adding why-not-what comments, updating ones that have drifted from the code, and deleting
    noise comments that merely restate what the code already says — with no behaviour change. The
    existing `ci` step is the backstop that proves the comment-only diff is behaviour-neutral before
    `merger` ships it.
  - **One parametrized agent serves both use-cases.** A new adaptive clone mode `pr-or-work`
    (`AgentCloneSpec.branch`) makes the Code Commenter amend the block's existing PR in place when
    there is one (the BAU pipeline case — the well-commented code ships in the coder's own PR) and
    fall back to branching off base and opening its own PR when there is none (a standalone
    `pl_code_comments` run or an initiative-framed sweep of a legacy codebase). It is
    `noChangesTolerated`, so a run that finds the comments already in good shape is a clean
    non-event rather than a failure. No new agent kind, no executor-harness image change.
  - The Code Commenter's prompt now actively **maintains** existing comments (fix/remove stale ones,
    strip redundant ones) rather than only adding new ones, and scopes a BAU run to the files the
    pull request changes.
  - **Hardening:** `agentPresentationSchema.description` is now required and non-empty
    (`minLength(1)`, like `label`/`icon`/`color`). The SPA renders a registered kind's description
    verbatim in the pipeline builder palette with no fallback, so a blank one would have surfaced as
    an empty description on a first-class palette block; this makes that impossible at the wire
    boundary. Every existing agent kind already ships a description, so nothing changes for them.

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0
  - @cat-factory/orchestration@0.99.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/integrations@0.78.4
  - @cat-factory/spend@0.11.19
  - @cat-factory/prompt-fragments@0.13.3

## 0.102.1

### Patch Changes

- bcc843d: Initiatives: an initiative preset's per-agent-kind `promptAddition` now reaches the
  runs SPAWNED by that initiative (a task's coder / tester / custom kind), not only the
  initiative's own planning run. The `AgentContextBuilder` resolves the preset's steering
  for any block carrying `initiativeId` (gated on it, so plain tasks pay nothing), and a
  shared `initiativePresetSection` renderer folds the `## Initiative preset:` steering into
  the standard-phase, generic custom-kind, and planning prompts alike — including a custom
  kind that supplies its own user prompt (the steering is folded in ahead of it). This is the vehicle
  for an org to attach standing role/task methodology to built-in agents without forking
  them (slice 1 of the custom-initiative-definitions initiative). No behaviour changes for
  non-initiative runs — their prompts stay byte-for-byte identical.
- Updated dependencies [bcc843d]
  - @cat-factory/orchestration@0.98.1
  - @cat-factory/agents@0.48.5
  - @cat-factory/kernel@0.110.1
  - @cat-factory/integrations@0.78.3
  - @cat-factory/spend@0.11.18

## 0.102.0

### Minor Changes

- a2db337: Planning-interview questions gain the same answer surface as requirements review, via a shared
  clarification-item abstraction (see `docs/initiatives/clarification-items.md`).

  A planning question can now be marked **not relevant** (dismissed — it stops blocking Continue and
  the interviewer is told not to re-ask it) and the human can ask the interviewer to **recommend** a
  suggested answer (drafted inline, adopted with "use this answer"). These reuse a new shared
  `ClarificationItem` component rather than cloning the requirements UI. `InitiativeQa` gains
  `status` + `recommendation`; no DB migration (the initiative persists as a JSON blob, so both
  runtimes pick up the fields for free). The initiative board card also pulses while its interview is
  awaiting answers, matching how a review gate surfaces attention on a task card.

### Patch Changes

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/orchestration@0.98.0
  - @cat-factory/agents@0.48.4
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/integrations@0.78.2
  - @cat-factory/prompt-fragments@0.13.2
  - @cat-factory/spend@0.11.17

## 0.101.2

### Patch Changes

- Updated dependencies [35636d5]
  - @cat-factory/agents@0.48.3
  - @cat-factory/orchestration@0.97.2

## 0.101.1

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/agents@0.48.2
  - @cat-factory/integrations@0.78.1
  - @cat-factory/orchestration@0.97.1
  - @cat-factory/spend@0.11.16

## 0.101.0

### Minor Changes

- 8728bf7: Capture per-run diagnostics on `agent_runs` for after-the-fact investigation. Each run now
  records a `diagnostics` object (riding in the run's `detail` JSON, like `notes`/`frontendBindings`)
  with the most recent container-step dispatch context — `agentKind`, resolved `model`, the `repo`
  (owner/name/baseBranch/provider), the **execution backend** (`local-native` vs `local-container`
  vs `runner-pool` vs `cloudflare-container` — the datum that distinguishes a native host-process run
  from a sandboxed container), and the control-plane host `platform`. The backend is reported by the
  runner transport (a new optional `RunnerTransport.backend` / `RunnerJobView.backend`, stamped by
  the shared job client; the native/container router stamps its per-job leg).

  Also preserves the harness's fine-grained failure `cause` (`git` / `api` / `no-usable-output` /
  `no-changes`) on the failure's machine-readable `reason` instead of collapsing it to the coarse
  `agent` kind — so a push/clone failure reads as `git`, not a generic agent error, without grepping
  the transcript. No schema migration (the diagnostics ride in the existing `detail` column; the
  cause rides on the existing `failure.reason`); mirrored across both runtimes with a cross-runtime
  conformance round-trip assertion.

- 7157908: Model presets now support reseeding, mirroring pipelines and merge presets, plus a new
  built-in "Claude Opus 4.8" preset (everything `claude-opus`).

  - Built-in model presets carry stable catalog ids (`mdp_kimi` / `mdp_glm` / `mdp_claude`)
    and a monotonic `version`. The workspace snapshot ships `modelPresetCatalogVersions`, and
    `POST /workspaces/:ws/model-presets/:id/reseed` restores a built-in to the current catalog
    (adopt an update, repair drift, or materialise a new built-in that appeared). The SPA gains
    a once-per-session "model preset updates" advisory (reseed / add) like the pipeline and
    merge-preset ones.
  - The seeded workspace DEFAULT preset is now a deployment fact: Cloudflare and Node default to
    Kimi K2.7 (Cloudflare-runnable on the bare baseline), local mode defaults to Claude Opus 4.8
    (local runs subscription models via the ambient CLI / a leased personal credential). The
    deployment default is applied only at first seed, so a user's later manual default choice is
    always preserved.

  Breaking (pre-1.0, no migration): model presets gain a nullable `version` column
  (D1 `0043_model_preset_versioning`; Drizzle migration). Workspaces seeded before this change
  hold the old index-based preset ids (`mdp-seed-0/1`); they are treated as custom presets, and
  the three stable built-ins are offered via the reseed advisory rather than migrated in place.

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/orchestration@0.97.0
  - @cat-factory/integrations@0.78.0
  - @cat-factory/agents@0.48.1
  - @cat-factory/prompt-fragments@0.13.1
  - @cat-factory/spend@0.11.15

## 0.100.2

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0
  - @cat-factory/orchestration@0.96.3

## 0.100.1

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0
  - @cat-factory/prompt-fragments@0.13.0
  - @cat-factory/orchestration@0.96.2

## 0.100.0

### Minor Changes

- cb088c7: Cap concurrent inline (non-container) LLM calls to a subscription/shared-pool vendor so a burst
  can't overwhelm it. A new `VendorConcurrencyLimiter` + `LimitedModelProvider` decorator
  (`@cat-factory/agents`) gates each resolved subscription-vendor model behind an in-process
  per-vendor semaphore, keyed by `subscriptionVendorForRef(ref)`. It is applied as the outermost
  resolver wrap in every facade via `wrapResolverWithLimiter` (`@cat-factory/server`), mirroring the
  existing `InstrumentedModelProvider` shape, so no inline call site changes. Both the buffered
  (`wrapGenerate`) and streaming (`wrapStream`) inline paths are gated — a stream holds its permit
  until it ends — and a queued call whose request is aborted releases its slot instead of
  head-of-line blocking. Only the five subscription vendors (`claude`/`codex`/`glm`/`kimi`/`deepseek`)
  are capped; API-key vendors and Cloudflare pass through untouched.

  Configured by `LLM_SUBSCRIPTION_MAX_CONCURRENCY` (default 3 per vendor; a
  `LLM_SUBSCRIPTION_MAX_CONCURRENCY_<VENDOR>` overrides that one vendor and always wins). Any value
  `<= 0` is uncapped, so setting the default to `0` uncaps every vendor that has no explicit
  per-vendor override (to turn the feature off entirely, leave the per-vendor overrides unset too).
  The limiter is
  in-process only — one per Node process (per container/tenant) or per Worker isolate, which is the
  scope of a single inline fan-out (a consensus panel, the requirements recommendation writer, a
  sandbox sweep). It bounds in-flight concurrency, not requests-per-minute, and does not coordinate
  across replicas/isolates; global rate-limiting stays out of scope. Because inline subscription
  refs are degraded to a pool/API-key provider before resolve on Node/Worker, the cap primarily
  bites in local mode (the prewarmed-container inline subscription backend keeps the ref) and is a
  wired pass-through elsewhere.

### Patch Changes

- b3bd653: Make `HARNESS_SHARED_SECRET` a mandatory, stable local-mode secret and a required runner-transport parameter.

  Local mode previously let the runner transports mint a RANDOM `HARNESS_SHARED_SECRET` per process when the env var was unset. That value is the inbound-auth secret between the orchestrator and its agent containers, so after a restart, polls against a container still running from before the restart failed auth (not mapped to eviction) and the run flapped instead of re-attaching.

  Now:

  - `applyLocalDefaults` REQUIRES `HARNESS_SHARED_SECRET` (min 16 chars) and fails loudly at boot with a clear, actionable error when it is missing/blank/too-short, exactly like `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`.
  - `sharedSecret` is now a REQUIRED constructor argument on `LocalContainerRunnerTransport`, `LocalProcessRunnerTransport`, and `LocalPreviewTransport` — the random per-process fallback is gone. The `*FromEnv` factories read it via the new `requireHarnessSharedSecret(env)`.
  - `pnpm secrets` (deploy/local) now emits `HARNESS_SHARED_SECRET` alongside the other two, and `deploy/local/.env.example` documents it.

  BREAKING (local mode): a local deployment with no `HARNESS_SHARED_SECRET` set now fails at boot instead of running with an unstable per-process secret. Set a stable value (via `pnpm secrets`) before upgrading.

- Updated dependencies [cb088c7]
  - @cat-factory/agents@0.46.0
  - @cat-factory/orchestration@0.96.1

## 0.99.8

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0
  - @cat-factory/orchestration@0.96.0

## 0.99.7

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1
  - @cat-factory/orchestration@0.95.3

## 0.99.6

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0
  - @cat-factory/prompt-fragments@0.12.0
  - @cat-factory/orchestration@0.95.2
  - @cat-factory/integrations@0.77.8
  - @cat-factory/spend@0.11.14

## 0.99.5

### Patch Changes

- Updated dependencies [4a7fca0]
  - @cat-factory/prompt-fragments@0.11.0
  - @cat-factory/agents@0.43.1
  - @cat-factory/orchestration@0.95.1

## 0.99.4

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/orchestration@0.95.0
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0
  - @cat-factory/integrations@0.77.7
  - @cat-factory/spend@0.11.13

## 0.99.3

### Patch Changes

- Updated dependencies [cd60892]
  - @cat-factory/orchestration@0.94.0

## 0.99.2

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0
  - @cat-factory/orchestration@0.93.1
  - @cat-factory/integrations@0.77.6
  - @cat-factory/spend@0.11.12

## 0.99.1

### Patch Changes

- Updated dependencies [f7f9a9e]
  - @cat-factory/orchestration@0.93.0

## 0.99.0

### Minor Changes

- b35e1a0: Technological-migration initiative — slice T1: preset phase templates (contract + planner prompt fold).

  A generic, declarative capability that lets an initiative preset shape its plan's phase
  structure; the migration preset (a later slice) is its first consumer, and `preset_generic`
  declares no template and stays byte-for-byte free-form.

  - **contracts**: `InitiativePresetDescriptor` gains an optional `phaseTemplate: { phases:
[{ id, title, goal, required? }], allowAdditionalPhases? }`. `id`/`title`/`goal` reuse the exact
    clamps of `initiativePhaseSchema` (so a template phase matches a planned phase by id); phase ids
    must be unique and the array non-empty. Pure serialisable wire data (like `policyDefaults`), so
    it rides the workspace snapshot and a future SPA create-time preview needs zero per-preset work.
  - **kernel**: `AgentRunContext.initiative.preset` now carries an optional `phaseTemplate` and its
    `promptAddition` is optional — a preset may contribute a template, steering, or both.
  - **orchestration** (`AgentContextBuilder`): the preset-context resolver surfaces the descriptor's
    `phaseTemplate` and returns the preset context when EITHER a per-kind `promptAddition` OR a
    `phaseTemplate` is present (neither ⇒ absent, so the generic planning prompt is unchanged).
  - **server** (planner prompt fold): when the resolved preset declares a template, the initiative
    **planner** prompt renders a generic "Required plan shape" section — phase ids VERBATIM, titles,
    goals, order, and whether extra phases are allowed. Generic code that never branches on a preset
    id; no template ⇒ the free-form planner prompt is byte-for-byte today's, and the analyst prompt
    (a prose step) never renders the plan shape.

  Ingest normalization/enforcement of the template shape is the following slice (T2); this slice
  lands the contract + the prompt fold only.

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0
  - @cat-factory/integrations@0.77.5
  - @cat-factory/contracts@0.118.0
  - @cat-factory/orchestration@0.92.0
  - @cat-factory/spend@0.11.11
  - @cat-factory/prompt-fragments@0.10.27

## 0.98.3

### Patch Changes

- 8f7af8e: Make ephemeral-environment provisioning DETECTION more universal — so it adapts to repos that
  follow different conventions than the stack-recipes pilot (different names, paths, tech stack). The
  changes are additive in the sense that detection can only ever surface MORE — it never removes or
  changes an existing detection, and a repo with no monorepo service-container dirs resolves exactly
  as before. Note the one behavioural change below: the env-template scan now also looks one level into
  `services/*`/`apps/*`/`packages/*`, so a monorepo that keeps per-service templates there will now
  surface them as low-confidence, user-confirmed `recipe.envFiles` where it previously surfaced none.

  - **Injectable detection conventions (deployment config).** A deployment can extend the built-in
    compose file names/dirs, seed dirs, and env-template dirs via the `ENVIRONMENTS_DETECTION_CONVENTIONS`
    JSON env var, threaded additively (built-ins always win; canonical compose names stay
    highest-priority) through `CoreDependencies.detectionConventions` into BOTH the service-provisioning
    detector (`EnvironmentConnectionService`) and the shared-stack detector (`SharedStackService`). New
    `parseDetectionConventions` + `EnvironmentsConfig.detectionConventions` (`@cat-factory/server`,
    parsed by both facades) and the exported `DetectionConventions` type (`@cat-factory/integrations`).
  - **Env-template detection now scans one level into monorepo service-container dirs** (`services/*`,
    `apps/*`, `packages/*`), so a per-service `*-dist`/`.example` template outside the compose dir (the
    pilot's documented `services/app/` gap) is surfaced — still bounded by the existing read budget.
    This is on by default (not gated behind conventions), so any monorepo with a compose file AND
    per-service templates newly gets those as `recipe.envFiles`; they are low-confidence and confirmed
    in the wizard before anything is materialized.
  - **The environment setup wizard elevates the "run deep analysis" nudge** when a repo ships its own
    imperative bring-up CLI/Makefile the deterministic scan can't read (`@cat-factory/app`), pointing the
    user at the LLM analyst — the intended universality mechanism for stack-specific imperative steps.

- Updated dependencies [8f7af8e]
- Updated dependencies [8f7af8e]
  - @cat-factory/integrations@0.77.4
  - @cat-factory/orchestration@0.91.1

## 0.98.2

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/orchestration@0.91.0
  - @cat-factory/contracts@0.117.0
  - @cat-factory/agents@0.40.13
  - @cat-factory/integrations@0.77.3
  - @cat-factory/kernel@0.104.4
  - @cat-factory/prompt-fragments@0.10.26
  - @cat-factory/spend@0.11.10

## 0.98.1

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/agents@0.40.12
  - @cat-factory/integrations@0.77.2
  - @cat-factory/kernel@0.104.3
  - @cat-factory/orchestration@0.90.1
  - @cat-factory/prompt-fragments@0.10.25
  - @cat-factory/spend@0.11.9

## 0.98.0

### Minor Changes

- bc77f89: Initiative presets — slice 3: create/planning integration.

  - **contracts**: `createInitiativeSchema` gains optional `presetId` + `presetInputs` (validated
    against the resolved descriptor at create and frozen on the entity). New
    `probeInitiativePresetContract` (`POST /workspaces/:ws/initiative-presets/:presetId/probe`,
    body `{ frameId }` → the detected `InitiativePresetInputs`). The workspace snapshot gains
    `initiativePresets: InitiativePresetDescriptor[]`. New pure helpers
    `sanitizeInitiativePresetInputs` (reduce a form to its known, visible fields) and
    `renderInitiativePresetValue` (option-label-aware value rendering), shared by the create flow.
  - **orchestration** (`InitiativeService.create`): resolves + validates the preset (an unknown id
    or an invalid form is a create-time `ValidationError`, so nothing is written), and — only when a
    preset resolves — persists `presetId` + the SANITIZED `presetInputs` (known, currently-visible
    fields only, so a hidden field's unvalidated value can never freeze, and a form posted with no
    `presetId` is dropped). For a `skip`-interview preset it seeds the `qa` digest from the filled
    form (one answered exchange per visible, filled field via the new pure `seedPresetInterviewQa`)
    and templates the goal (the human's description wins, else the preset's stated purpose). Absent
    `presetId` ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`AgentContextBuilder`): an initiative planning step's context now folds in the
    preset `{ label, promptAddition }` resolved for the RUNNING kind — set ONLY when that kind has
    steering — so the analyst/planner prompts carry the preset's per-kind steering. The generic
    preset registers no steering, so the generic planning prompt is unchanged.
  - **kernel**: `AgentRunContext.initiative` gains an optional `preset` sub-object carrying the
    preset `label` + the per-kind `promptAddition` (the frozen form reaches the prompt via `qa`).
  - **server**: the shared `WorkspaceController` attaches `initiativePresets`
    (`initiativePresetDescriptors()`) to the snapshot on both the create + read handlers (so both
    facades advertise it), and `InitiativeController` serves the probe endpoint — resolving the
    frame's repo through the existing `resolveRunRepoContext` seam and running the preset's `detect`
    hook, returning `{}` (descriptor defaults) whenever GitHub is unwired / the frame has no linked
    repo / the preset has no probe hook, so it never blocks create. The initiative planning prompts
    render the folded-in preset steering.
  - **app**: the SPA hydrates `initiativePresets` from the snapshot and starts planning with the
    initiative's preset descriptor's `planningPipelineId` (the generic/absent preset keeps
    `pl_initiative`) instead of a hardcoded id. A NAMED preset that hasn't hydrated resolves to
    `null` (not the generic pipeline), so "Run planning" stays disabled rather than silently
    launching the interviewer over an already-seeded skip-interview initiative.

  Conformance: a shared assertion that both facades advertise the built-in generic preset on the
  snapshot (create + read), binding `pl_initiative` and the interviewer.

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/orchestration@0.90.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11
  - @cat-factory/integrations@0.77.1
  - @cat-factory/prompt-fragments@0.10.24
  - @cat-factory/spend@0.11.8

## 0.97.2

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/orchestration@0.89.0
  - @cat-factory/integrations@0.77.0
  - @cat-factory/contracts@0.115.0
  - @cat-factory/agents@0.40.10
  - @cat-factory/kernel@0.104.1
  - @cat-factory/prompt-fragments@0.10.23
  - @cat-factory/spend@0.11.7

## 0.97.1

### Patch Changes

- Updated dependencies [a869ae9]
  - @cat-factory/orchestration@0.88.0

## 0.97.0

### Minor Changes

- 6198b08: Missing mandatory env vars / bindings now produce human-readable, actionable startup errors AND a
  graceful degraded backend instead of an opaque crash.

  - **Shared structured config errors.** A new `ConfigValidationError` (carrying a list of
    `ConfigProblem { key, summary, remedy }`) plus a canonical `ENV_HELP` description table and a
    `requireEnv` helper live in `@cat-factory/server`. Every facade's startup throw for a mandatory
    variable (`DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, a configured auth provider,
    `TELEMETRY_DB`, `AGENT_MODELS`, the container-executor prerequisites) now routes through it, so the
    message reads the same across Node, local, and the Worker and always says what the variable is for
    and how to fill it. A `ConfigProblem` never carries a secret value.

  - **Graceful misconfiguration fallback backend.** Instead of exiting (which left the SPA on a generic
    "can't reach the backend" panel with no clue what was wrong), a facade that hits a
    `ConfigValidationError` at boot now serves a minimal fallback app (`createMisconfiguredApp`) on the
    normal port: `GET /auth/config` returns an auth-disabled config carrying the problem list, `/health`
    stays 200 (`status: misconfigured`, so an orchestrator doesn't crash-loop it), and every other route
    503s with the structured problems. Wired symmetrically in all three runtimes — Node/local
    `serveMisconfigured`, the Worker's per-request build (which recovers automatically once bindings are
    fixed).

  - **Dedicated frontend error screen.** The SPA's boot handshake now recognises the `misconfigured`
    field and renders `BackendMisconfiguredScreen` — a per-variable list of name + meaning + remedy with
    a reload button — instead of the login/board. Fully translated across all locales.

- 37d1517: Cache the checkout-free `RepoFiles` reads an agent's pre/post-ops run against a run's
  branch (caching-layer initiative, slice 4). A new `AppCaches.repoFiles` group cache serves
  the `getFile`/`listDirectory` idempotency byte-compares the `blueprints`/`spec-writer`
  post-ops issue every run and durable-driver replay, replacing a live GitHub contents-API
  round-trip per file. It is wired only on the `makeResolveRunRepoContext` (pre/post-op) path;
  the environments repo-validation and doc-quality reads stay live.

  - Grouped per `(installation, owner, repo, branch)` via the new kernel `repoFilesCacheGroup`
    helper and keyed per path (`f:`/`d:` prefixes), so one branch's reads drop together.
  - Self-verifying: each entry remembers the branch head sha it reflects, so an entry entering
    its refresh window re-validates with a single cheap `branchHeadSha` compare (bump on an
    unmoved branch, background reload otherwise) instead of re-fetching every file. A sha-pinned
    read is immutable (no probe). The head sha a cold batch stamps is read once per branch
    (memoised), so caching N files costs one extra head read, not N.
  - Coherence: the owning `commitFiles` self-invalidates the branch group after it commits, and
    the `push` webhook drops a branch it saw move out-of-band (an agent container's git push or a
    human PR-branch edit). Stays enabled on the Worker's isolate-safe profile (like the
    document-body cache, the head-sha probe re-validates without a cross-isolate bus) and in local
    mode (single-node, so `commitFiles` self-invalidation is already fully coherent).

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/integrations@0.76.0
  - @cat-factory/orchestration@0.87.0
  - @cat-factory/agents@0.40.9
  - @cat-factory/prompt-fragments@0.10.22
  - @cat-factory/spend@0.11.6

## 0.96.0

### Minor Changes

- 14eac27: Add an account-wide model-family allow/block policy. An account admin can constrain which
  LLM families their teams run (block/allow lists over families like DeepSeek, Qwen, Claude,
  OpenAI), gated to the Cloudflare / remote-Node / mothership runtimes (never plain local
  mode). The policy is evaluated against `(family, effective-route provider)`, so a
  residency-guaranteed route (`trustedProviders`, e.g. Bedrock) can exempt an otherwise-blocked
  family — data-residency risk is a property of the serving route, not the model weights.
  Region-grouped built-in presets (USA / Europe / China / Other) ship as apply-in templates.

  Stored on the existing per-account settings config blob (no migration). Enforced through a
  single choke point (`ProviderCapabilities`): the `/models` catalog flags blocked models
  (`available: false` + `policyBlocked: true`) and the pipeline start guard refuses them
  (`model_policy_blocked`). The per-account policy read is cached via a new `accountModelPolicy`
  slice of the app cache seam (`AppCaches`), invalidated on the account-settings write.

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/orchestration@0.86.0
  - @cat-factory/agents@0.40.8
  - @cat-factory/integrations@0.75.1
  - @cat-factory/prompt-fragments@0.10.21
  - @cat-factory/spend@0.11.5

## 0.95.0

### Minor Changes

- ecbcbec: Add repo autodetection to the shared-stacks definition screen. A new **Autodetect** button on
  the shared-stack form reads the repo at the entered clone URL — checkout-free, over the
  workspace's VCS connection (no clone, no host daemon) — and prefills the compose-shaped fields
  from a non-binding recommendation the user reviews before saving:

  - **`composeFiles`** — the base compose file plus any `<stem>.override.ya?ml` auto-merge family
    (the common single self-contained `docker-compose.yml` case resolves to just that one file).
  - **`managedNetworks`** — the `external: true` networks the compose references, which a shared
    stack is responsible for creating + owning (the `acme-net` shape). A self-contained stack that
    defines its dependencies internally declares no external network, so this stays empty.
  - **`composeProfiles`** — the `COMPOSE_PROFILES` the file declares.
  - A suggested **name** from the repo basename (only when the field is empty).

  New wire contract `POST /workspaces/:ws/shared-stacks/detect` (`detectSharedStackContract` +
  `sharedStackRecommendationSchema`), served by `SharedStackService.detect`, which reuses the
  deterministic compose scan (`detectSharedStack`) the environment provisioning detector already
  runs. Detection is a pass-through (`detected: false`) when no VCS connection is wired, and a
  genuine read fault surfaces as an actionable error. Nothing is persisted.

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/integrations@0.75.0
  - @cat-factory/orchestration@0.85.0
  - @cat-factory/agents@0.40.7
  - @cat-factory/prompt-fragments@0.10.20
  - @cat-factory/spend@0.11.4

## 0.94.3

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/integrations@0.74.0
  - @cat-factory/orchestration@0.84.0
  - @cat-factory/agents@0.40.6
  - @cat-factory/kernel@0.101.2
  - @cat-factory/prompt-fragments@0.10.19
  - @cat-factory/spend@0.11.3

## 0.94.2

### Patch Changes

- Updated dependencies [6a701ef]
  - @cat-factory/integrations@0.73.6
  - @cat-factory/orchestration@0.83.2

## 0.94.1

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/orchestration@0.83.1
  - @cat-factory/integrations@0.73.5
  - @cat-factory/agents@0.40.5
  - @cat-factory/prompt-fragments@0.10.18
  - @cat-factory/spend@0.11.2

## 0.94.0

### Minor Changes

- c66362f: Remove the `ENVIRONMENTS_ENABLED` deployment flag; the ephemeral-environment
  integration now assembles wherever the shared `ENCRYPTION_KEY` is set, the same
  "always on where the key is present" model as the document/task sources.

  The flag was a footgun: it defaulted off and its only effect was to make the whole
  integration silently inert (auto-detect 503ing with `unavailable`) even when the real
  prerequisites — an encryption key plus a registered per-workspace connection — were
  present. Whether a workspace provisions anything is already governed by whether it
  connects a provider and whether its pipeline includes a `deployer`/`tester` step, so to
  keep environments out of a pipeline you simply omit those steps. `EnvironmentsConfig`
  drops its `enabled` field and the module gates on `encryptionKey` presence in all three
  runtimes.

  Breaking: `ENVIRONMENTS_ENABLED` is no longer read; remove it from deployment config
  (setting it has no effect). The inspector's dedicated "ephemeral environments aren't
  enabled" auto-detect panel is removed with it, since that off state no longer exists.

## 0.93.0

### Minor Changes

- f596090: Record successful step outputs in the step-detail "execution history", not just failures.

  A restart-from-step resets the chosen step and every later one, dropping their `output`;
  previously that successful work was lost and the per-step history could only ever show
  errors. The run now keeps an `outputHistory` — the positive complement of `failureHistory`
  — capturing the successful outputs a restart superseded (attributed by step index, bounded
  in count + per-entry size, riding the run's `detail` JSON with no schema migration). The
  step-detail overlay renders a merged, newest-first timeline of these superseded outputs and
  the failed attempts. A plain retry (which re-runs only unfinished steps) records nothing.

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/orchestration@0.83.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/integrations@0.73.4
  - @cat-factory/prompt-fragments@0.10.17
  - @cat-factory/spend@0.11.1

## 0.92.0

### Minor Changes

- 9ea1e77: Tiered spend budgets (account / workspace / user) with operator hard caps.

  Budgets are now tracked and enforced across three tiers: the existing per-workspace
  monthly limit, a per-account limit, and a per-user limit. A run pauses when any applicable
  tier is exhausted. All three tiers are configurable and visible in the Budget settings
  screen.

  Two new environment variables (`BUDGET_MAX_MONTHLY_PER_ACCOUNT`,
  `BUDGET_MAX_MONTHLY_PER_USER`), read by the Node and Cloudflare config loaders, set
  operator hard ceilings on the account/user tiers; the UI cannot exceed a configured cap and
  shows it on the budget screen. See `docs/environment-variables.md` and
  `docs/initiatives/tiered-budgets.md`.

  Breaking (pre-1.0, no data migration): the `token_usage` ledger gains nullable
  `account_id`/`user_id` columns (existing rows are unattributed and excluded from the new
  account/user rollups until re-metered); `TokenUsageRecord`, `RecordUsageInput`, and
  `SpendPricing` gained fields; `SpendService.isOverBudget` now takes an optional tier scope.
  A new `user_settings` table and `GET/PUT /user-settings` endpoint carry the user-tier
  budget.

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/spend@0.11.0
  - @cat-factory/orchestration@0.82.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/integrations@0.73.3
  - @cat-factory/prompt-fragments@0.10.16

## 0.91.0

### Minor Changes

- e66accb: Stack recipes & shared stacks (slice 7): make the Deployer the sole docker-compose provisioner + the environment setup wizard scaffolding.

  **Deployer becomes the single docker-compose provisioner (the compose-centralization follow-up owed by this slice).** Now that the setup wizard can save a `docker-compose` handler, docker-compose is provisioned by the single Deployer step through a workspace handler, exactly like `kubernetes`/`custom` — the in-container (DinD) bring-up is retired from the run-mode decision:

  - `decideTesterInfra` (`tester-infra.logic.ts`): `docker-compose` is handler-based (drops the `localTestInfraSupported`/`hasComposePath` inputs and the `limited-local`/`compose-unconfigured` reasons).
  - `needsDeployerBeforeConsumer` + `ExecutionService.assertTesterInfraConfigured`'s `needsHandler` now cover `docker-compose`, so a compose chain that reaches a tester with no resolvable handler is refused at run start (fail-fast, same as k8s/custom) instead of dead-ending.
  - `testerInfraSpec` (`@cat-factory/server`): `docker-compose` targets the Deployer-provisioned env (`environment: 'ephemeral'`); the `local`/`composePath` branch is gone.
  - (The harness's in-container `docker compose up` is now unreachable and retired in a later image-bumping slice.)

  **Environment setup wizard.** The guided detect → review → preflight → save flow the compose-centralization depends on: `EnvironmentSetupWizard.vue` (stepper shell over the `environmentWizard` store — detection, opt-in deep analysis via `pl_environment_analysis` with live provenance-merged review, compose-file/profile/seed candidate pickers, a raw-recipe editor, the preflight checklist, save the workspace compose handler + the frame recipe, and an optional trial provision with live provisioning logs), a docker-compose service-inspector nudge, a SideBar entry, the mount in `pages/index.vue`, and the `environmentWizard` i18n namespace across all 8 locales. Backed by the `preflights` API + store (`POST /workspaces/:ws/preflights/run`) and the `provisionEnvironment` API. (The `data-testid`-only e2e spec is deferred — it needs a fake `ProvisioningRepoReader` e2e seam so detection returns a canned recommendation with GitHub off; tracked in the slice-7 checklist.)

  Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test with no configured compose handler is now refused at run start rather than falling back to an in-container compose bring-up.

  Review follow-ups in the same slice: the `environmentWizard` store now fully resets per-frame state when re-targeted (`selectFrame` no longer leaves a prior frame's `saved`/service/port behind), resolves the analyst run by preferring a live/succeeded instance over a bare `.at(-1)` (so a retry's dead predecessor can't mask the successful run), validates the exposed port before registering the handler, and surfaces a real (non-503) preflight failure instead of swallowing it. The now-dead `localTestInfraSupported` dependency (its only reads were removed with the DinD path) is dropped from `CoreDependencies`/`ExecutionService` and the local facade's wiring, and the stale DinD doc comments on `assertTesterInfraConfigured` / `testerInfraSpec` are corrected.

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/orchestration@0.81.0
  - @cat-factory/contracts@0.108.1
  - @cat-factory/agents@0.40.2
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1
  - @cat-factory/prompt-fragments@0.10.15
  - @cat-factory/spend@0.10.109

## 0.90.3

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1
  - @cat-factory/orchestration@0.80.1

## 0.90.2

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/orchestration@0.80.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/spend@0.10.108
  - @cat-factory/prompt-fragments@0.10.14

## 0.90.1

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/orchestration@0.79.1
  - @cat-factory/prompt-fragments@0.10.13
  - @cat-factory/spend@0.10.107

## 0.90.0

### Minor Changes

- 6f9d935: Stack recipes & shared stacks (slice 6): preflight prerequisite checks with guided remediation.

  A stack recipe can now declare machine `prerequisites: PreflightRef[]` — automated PROBE + human REMEDIATION checks for the inherently-manual one-time machine setup a complex compose repo needs (docker daemon reachable, free disk / RAM, container-registry login state, VPN reachability, mkcert CA, hosts-file entries, an env-file secrets marker). They are re-run at provision start: a failing REQUIRED check fails the provision fast with its copy-paste remediation in the provisioning log, instead of a mystery deep inside a 40-image pull (a non-required check is advisory — a warning). A `POST /workspaces/:ws/preflights/run` endpoint runs an arbitrary set of checks for the setup wizard's live re-check.

  - Contracts: `PreflightCheckId` / `PreflightParams` / `PreflightRef` / `PreflightResult` (`preflights.ts`) + `prerequisites` on `stackRecipeSchema`; the `runPreflightsContract` route.
  - Kernel: the runtime-bound `PreflightHostProbes` seam + `PreflightProbeOutcome`, and a `runPreflights` seam on `ProvisionEnvironmentRequest`.
  - Integrations: `PreflightService` (runtime-neutral orchestration over the probe seam) + provision-start enforcement in `ComposeEnvironmentProvider`.
  - Server: `PreflightController`.
  - Local facade: `createDockerPreflightProbes` (the host probes over the docker CLI + `node:*`), wired only where the compose runtime is (a Docker-family host daemon). The probes are runtime-bound (local facade only, the documented compose exception); the declaration + API are runtime-neutral and the recipe rides the existing `provisioning` blob, so there is no migration. On the Worker / plain Node the preflight API 503s and a recipe that declares prerequisites fails loudly at provision.

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/integrations@0.72.0
  - @cat-factory/orchestration@0.79.0
  - @cat-factory/agents@0.39.4
  - @cat-factory/prompt-fragments@0.10.12
  - @cat-factory/spend@0.10.106

## 0.89.0

### Minor Changes

- 5490103: Surface web search on container agent run details, and store/display performed search queries as telemetry.

  - Container steps now carry a `search` availability fact (`{ available, provider }`), resolved backend-side at dispatch from the run's account web-search keys (else the deployment default). The observability drill-down shows whether web search was available and which provider (Brave / SearXNG) served the run — a static per-run fact, not gated by prompt-recording.
  - New `agent_search_queries` telemetry sink records every web search a container agent performs through the backend search proxy (query, provider, result count), gated by the same double switch as agent-context snapshots (`LLM_RECORD_PROMPTS` + the workspace `storeAgentContext` setting) and pruned on the same telemetry retention window. Mirrored across the D1 (Cloudflare) and Drizzle/Postgres (Node) stores with a cross-runtime conformance suite, and surfaced on demand via `GET /workspaces/:ws/executions/:executionId/search-queries` in a new "Web search" observability view.

### Patch Changes

- e5b9462: Show a step's failure trail on its step-detail overlay. The step-detail overlay now has an "Execution history" toggle that reveals the prior failed attempts recorded for that specific step (plus the current failure when the run is presently failed at it): the run-level "previous errors" history narrowed to one step. Each `AgentFailure` now carries the `stepIndex` it failed at (stamped by the engine's failure funnel), so the trail can be attributed per step.
- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/orchestration@0.78.0
  - @cat-factory/integrations@0.71.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/prompt-fragments@0.10.11
  - @cat-factory/spend@0.10.105

## 0.88.0

### Minor Changes

- accb8ec: feat(docs): attach read-only reference repositories to a document-authoring task

  Let a document-type task carry a list of **reference repositories** the `doc-writer` agent clones
  READ-ONLY while it drafts, so it can reuse existing solutions in those repos as a reference. The
  writer is already containerized (`container-coding`), so no interim step is needed — the reference
  repos become extra sibling checkouts it may read but can never write to.

  - **Read-only by construction.** Reference repos flow through a NEW `referenceRepos` block field,
    separate from the writable `involvedServiceIds`/`fanOutMultiRepo` path. The harness job spec
    carries no branch/PR fields for a reference, the multi-repo coder clones it at its base branch
    with no work branch, and the push phase skips it — three independent layers, so a reference repo
    is structurally impossible to push to. Its clone URL is host-allowlisted like every other repo.
  - **Any accessible repo, by name fragment.** A reference need not be a board service or in the
    workspace's synced projection: the inspector picker reuses the SAME server-side, debounced repo
    search as the add-service modal (extracted into a shared `useRepoSearch` composable), so any repo
    the workspace's VCS connection or the signed-in user's PAT can reach can be attached.
  - **Provider-neutral by construction.** The `ReferenceRepo` identity mirrors the kernel's VCS
    vocabulary (`repoId` / `owner` / `name` / `defaultBranch` / `connectionId`, per `VcsRepoRef` /
    `VcsConnectionRef`) rather than GitHub-specific names, and the clone URL + provider come from the
    deployment-level `ResolveRepoOrigin` seam the primary already rides — so a GitLab deployment
    clones references from GitLab with no extra wiring.
  - **Deduped against the primary.** A reference pointing at the doc task's own repo (or a duplicate
    attachment) is dropped by the shared sibling-checkout key, so it can't collide with an existing
    clone directory and fail the run.
  - **Symmetric persistence.** New `reference_repos` JSON column on `blocks`, mirrored across the D1
    and Drizzle stores with a cross-runtime conformance round-trip assertion.

  Bumps `@cat-factory/executor-harness` (new read-only reference-leg support in the coding harness) —
  the runner image tag pins and `RECOMMENDED_HARNESS_IMAGE` are bumped in lockstep.

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/orchestration@0.77.0
  - @cat-factory/agents@0.39.2
  - @cat-factory/integrations@0.70.1
  - @cat-factory/prompt-fragments@0.10.10
  - @cat-factory/spend@0.10.104

## 0.87.0

### Minor Changes

- cd435d1: Shared stacks (stack-recipes-and-shared-stacks initiative, slice 4): a workspace-scoped,
  long-lived compose stack a per-PR consumer environment attaches to over an external network
  (the acme-shared-services shape). Adds the `SharedStack` contract + `SharedStackRepository`
  port, the D1 ⇄ Drizzle `shared_stacks` table with a cross-runtime conformance round-trip, a
  `SharedStackService` lifecycle (CRUD everywhere + host-Docker `ensureUp`/`teardown` on the local
  facade, reusing the compose recipe-runner), the `GET|POST|PATCH|DELETE /workspaces/:ws/shared-stacks`
  (+ `ensure-up`/`teardown`) controller, and a "Shared stacks" panel in the Infrastructure window.
  Bringing a stack up is local-facade-bound (host daemon), the documented compose exception to
  runtime symmetry; persistence stays fully symmetric.

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/integrations@0.70.0
  - @cat-factory/orchestration@0.76.0
  - @cat-factory/agents@0.39.1
  - @cat-factory/prompt-fragments@0.10.9
  - @cat-factory/spend@0.10.103

## 0.86.0

### Minor Changes

- c435c09: Local mode ships an on-by-default self-hosted SearXNG web-search upstream.

  Web search for container agents is a backend proxy (`/v1/web-search/search`) that resolves its
  upstream from the run's per-account settings — so local mode previously had no web search until a
  developer hand-entered keys. This adds a **deployment-level trusted default upstream** the proxy
  falls back to when the account has none, and wires a self-hosted SearXNG as that default in local
  mode (on by default, disable with `LOCAL_WEB_SEARCH=off`).

  - **server**: `SearxngWebSearchUpstream` gains a `trusted` flag that trusts only the deployment's
    own configured origin (its base URL — which may be loopback/LAN — and same-origin redirects)
    while a CROSS-origin redirect stays SSRF-guarded, so a trusted-but-compromised upstream can't
    pivot to an internal/metadata host; redirect/credential-stripping/byte-cap protection is
    unchanged. New `createDefaultWebSearchUpstream(...)` (trusted counterpart to
    `createWebSearchUpstream`). `ServerContainer` gains optional `defaultWebSearchUpstream`, which
    `WebSearchProxyController` uses as the fallback when the account resolves no upstream (the
    account path still wins and stays SSRF-guarded; neither ⇒ the unchanged empty-result degrade).
  - **node-server & worker**: both facades build the default from `WEB_SEARCH_BRAVE_API_KEY` /
    `WEB_SEARCH_SEARXNG_URL` / `WEB_SEARCH_SEARXNG_API_KEY`, surface it on the container, and
    advertise Pi's `web_search` tool whenever a default exists (or the account has keys). A stock
    Node **or Cloudflare** deployment can now set a deployment-wide default (Brave or a public
    self-hosted SearXNG); each facade carries a proxy-fallback parity test.
  - **local-server**: `applyLocalDefaults` points `WEB_SEARCH_SEARXNG_URL` at the local SearXNG
    (`http://localhost:8080`) unless `LOCAL_WEB_SEARCH=off`; the `deploy/local` docker-compose gains a
    pinned `searxng` service (behind a `web-search` profile) + a `settings.yml` enabling the JSON API.

  The only Cloudflare-specific gap is the loopback-SearXNG story (no localhost container on workerd),
  which is inherently local-only; the runtime-neutral Brave/public-SearXNG default is now symmetric.

## 0.85.0

### Minor Changes

- 076d02f: feat(documents): interactive document-review sessions (doc-task WS5)

  Between the outline and the draft, a document-authoring run now converses with the requester
  instead of a single binary approve/revise gate. A new inline `doc-interviewer` step (inserted
  after `doc-outliner` in `pl_document`, replacing the outline's human gate) asks a small batch of
  clarifying questions about scope, audience and structure, parks the run on the standard durable
  decision-wait while the human answers through a dedicated window, and iterates (up to a round
  cap) until it synthesizes a refined **authoring brief** the `doc-writer`/`doc-finalizer` start
  from (folded into their context via the agent-context builder).

  The park/answer/resume/advance spine is now a shared `InterviewGateController<TEntity>`
  parameterized by an `InterviewGateKind` strategy; both the document interviewer and the
  interactive-planning (initiative) interviewer ride it, so the two gates can't drift. A document
  task has no owning entity row, so its transcript is persisted in its own `doc_interview_sessions`
  table — mirrored across D1 ⇄ Drizzle with a cross-runtime conformance assertion. The interview
  window is wired through the universal result-view seam (`doc-interview`) and updates live over a
  new `docInterview` workspace event. Pass-through when no interviewer model is wired, so document
  pipelines run unchanged.

  Hardening: a re-run of a document task now clears the block's prior session before interviewing
  (so it starts clean instead of reusing a stale, already-converged one), the converged brief is
  folded only into the two kinds that consume it (`doc-writer`/`doc-finalizer`), and a non-final
  interviewer pass that returns neither questions nor a brief fails the run loudly instead of
  silently skipping the interview with an empty brief.

  Breaking: `pl_document` bumps to version 3 (the reseed offer), and its step indices shift (the
  interviewer is inserted at index 2), so in-flight runs on the old shape should be restarted.

### Patch Changes

- 77bc73c: Update dependencies to the latest versions within the supply-chain release-age
  window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
  that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
  `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
  `@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
  `@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
  `pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
  `@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
  is held at `4.x` because `wrangler@4` peers on `^4`.
- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/agents@0.39.0
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/orchestration@0.75.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/spend@0.10.102
  - @cat-factory/prompt-fragments@0.10.8

## 0.84.3

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/orchestration@0.74.3
  - @cat-factory/prompt-fragments@0.10.7
  - @cat-factory/spend@0.10.101

## 0.84.2

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0
  - @cat-factory/orchestration@0.74.2

## 0.84.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/integrations@0.67.1
  - @cat-factory/orchestration@0.74.1
  - @cat-factory/prompt-fragments@0.10.6
  - @cat-factory/spend@0.10.100

## 0.84.0

### Minor Changes

- 773695b: feat(documents): workspace-linked template + exemplar documents per DocKind (doc-task WS1 items 2–4)

  A workspace can now point a document kind at its OWN template and example documents, reusing
  the existing documents integration end-to-end (no new fetch machinery). A single `role`
  (`template` | `exemplar`) + `docKind` tag on the projected `documents` row — sitting alongside
  the block-scoped `linkedBlockId` anchor — models both:

  - **Template** (singular per kind): its parsed section headings REPLACE the built-in skeleton
    for that kind. Resolved through one shared seam (`resolveDocTemplate`) that BOTH the
    doc-authoring prompts (via the engine-resolved `block.docTemplateBody`) and the `doc-quality`
    gate provider go through, so the writer and the gate never check against different sections.
  - **Exemplars** (multi-valued per kind): "good examples to emulate" surfaced to the author
    agents alongside a new set of built-in curated exemplars.

  The `documents` table gains nullable `role`/`doc_kind` columns (D1 migration ⇄ Drizzle schema +
  generated migration), with new `DocumentRepository` role methods mirrored across both stores and
  asserted by the cross-runtime conformance suite. The Node facade's Drizzle migration is the
  merge node that collapses the two pre-existing divergent snapshot leaves. New workspace-scoped
  routes (`GET`/`POST /document-role-links`, `POST /document-role-links/remove`) back a
  per-DocKind template/exemplar management panel in the Integrations hub (i18n in all 8 locales).

  Breaking (pre-1.0, acceptable): the `documents` projection wire shape gains `role`/`docKind`
  fields; stale rows simply carry nulls.

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/agents@0.38.0
  - @cat-factory/integrations@0.67.0
  - @cat-factory/orchestration@0.74.0
  - @cat-factory/prompt-fragments@0.10.5
  - @cat-factory/spend@0.10.99

## 0.83.2

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1
  - @cat-factory/orchestration@0.73.1
  - @cat-factory/prompt-fragments@0.10.4
  - @cat-factory/spend@0.10.98

## 0.83.1

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/orchestration@0.73.0
  - @cat-factory/integrations@0.66.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/spend@0.10.97
  - @cat-factory/prompt-fragments@0.10.3

## 0.83.0

### Minor Changes

- f4c321e: feat(documents): add the `doc-quality` gate (WS4) to the forward document pipelines

  A new deterministic polling gate `doc-quality`, authored through the public `registerGate`
  seam in `@cat-factory/gates`, is inserted into `pl_document` (after `doc-finalizer`) and
  `pl_document_quick` (after `doc-reviewer`). It reads the drafted document on the PR head
  checkout-free via a new `DocQualityProvider` (wired per facade over `RepoFiles`) and checks
  — against the WS1 template (`docTemplateFor`, the single source of truth) — that every
  required section is present, no leftover placeholders remain, the heading hierarchy is sane,
  and in-repo relative links resolve. On a red verdict it escalates to a new `doc-fixer`
  container helper that repairs the document on the PR branch; a green document advances with
  nothing spun up. Both doc pipelines' `version` is bumped (reseed offer).

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0
  - @cat-factory/integrations@0.65.3
  - @cat-factory/orchestration@0.72.1
  - @cat-factory/spend@0.10.96

## 0.82.0

### Minor Changes

- 13a284f: Bug-triage pipeline (phase G): the `repro-test` Reproduction Test Automation agent. A new
  structured `container-coding` agent kind writes one or more tests that fail for the reported
  reason and commits them onto the run's shared work branch (seeding it for the coder, which opens
  the one PR containing both the reproduction test and the fix) — or concedes `not_reproducible`
  without failing the run. Conceding and reproduced outcomes both advance to the coder; a
  post-completion resolver folds the `{ outcome, testPaths, notes }` assessment into the step
  output so the coder reads it, and a `BUG_FIX_GUIDANCE` prompt fragment reframes the coder's
  objective around the pre-existing failing test (fix the issue, don't merely make the test pass).

  Enabling changes: `AgentStepSpec` gains `opensPr` / `noChangesTolerated` (container-coding) so a
  kind can seed the work branch without opening a PR and tolerate a no-op; the executor-harness
  coding path now parses a structured JSON outcome (`custom`) alongside the pushed commit; the
  harness image is bumped to `1.34.9`. The runtime-neutral `@cat-factory/server` package keeps its
  Web-standard `src` surface (no `@types/node`) while typing the one cross-runtime Node built-in it
  uses (`AsyncLocalStorage`) via a local ambient shim, with node-using tests typechecked under a
  separate project.

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0
  - @cat-factory/orchestration@0.72.0
  - @cat-factory/integrations@0.65.2
  - @cat-factory/spend@0.10.95

## 0.81.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/integrations@0.65.1
  - @cat-factory/kernel@0.86.1
  - @cat-factory/orchestration@0.71.1
  - @cat-factory/prompt-fragments@0.10.2
  - @cat-factory/spend@0.10.94

## 0.81.0

### Minor Changes

- 49b498a: Bug-triage pipeline, Phase D — issue-intake foundations (ports + persistence).

  The plumbing the upcoming `bug-intake` step (Phase E) drives: a predicate search across the
  three task-source vendors, the per-schedule intake configuration, the "taken by cat-factory"
  pickup writeback, and the replace-link that keeps a recurring block's issue context from
  accumulating across fires. No engine step yet — this phase is ports, vendor implementations,
  and persistence only.

  - **`TaskSourceProvider.searchIssues` + `IssueIntakeQuery`** (kernel port): open issues on one
    vendor board matching every predicate (title fragment / labels / issue type), oldest-first,
    deduped against the already-worked exclusion list. Predicates are pushed into the vendor
    query wherever expressible — Jira compiles ONE JQL (`statusCategory != Done`, `issuetype`,
    `labels`, `summary ~`, `issuekey NOT IN`, `ORDER BY created ASC`; excluded ids validated
    against the key shape so a malformed id can't inject), GitHub compiles search qualifiers
    (`repo:` `is:open` `type:` `label:` `in:title`, the title fragment quoted as a literal phrase
    so it can't inject a qualifier) with the API's `created-asc` sort (a new `order` param on
    `GitHubClient.searchIssues`, honoured by the GitLab-backed client too) and filters the
    exclusion list case-insensitively from a bounded, paged overscan, Linear compiles a GraphQL
    `IssueFilter` (team, state type not completed/canceled, per-label `labels.some`,
    `title.containsIgnoreCase`) asked for oldest-created-first, also paged so a run of
    already-worked issues at the front can't starve the pickup.
  - **`PipelineSchedule.issueIntake`** (contracts + both runtimes, kept symmetric): the
    schedule-scoped intake config (`source`, per-vendor `board` scope, `predicates`, the GitHub
    `inProgressLabel`) as a new `pipeline_schedules.issue_intake` JSON column — D1 migration
    `0038_schedule_issue_intake.sql` ⇄ Drizzle schema + generated migration — parsed/serialized
    by shared `@cat-factory/server` mapper helpers so the column can't drift, accepted on
    schedule create/update (PATCH is tri-state: omitted = unchanged, null = clear), and pinned
    by a cross-runtime conformance round-trip. Requiring it when the pipeline carries a
    `bug-intake` step is Phase E's schedule validation.
  - **`IssueWritebackProvider.onIssuePickedUp`**: comments "Taken by cat-factory" (+ run link)
    on the block's linked issue(s) and marks them in-progress — Jira transitions into the
    `indeterminate` status category (`pickDoneTransition` generalized into
    `pickTransitionByCategory`), Linear transitions to the team's `started` state (the Linear
    state pickers generalized into `pickStateIdByType`), GitHub applies the schedule's
    `inProgressLabel` (default `in-progress`) via a new `GitHubClient.applyIssueLabel` that
    creates the label — with the required colour — when absent.
    Best-effort per issue like the existing hooks, and deliberately NOT gated on the workspace
    writeback settings — claiming the issue is intake semantics. Wired in both facades.
  - **`TaskLinkService.replaceForBlock`** + `TaskRepository.unlinkAllFromBlock`: detach every
    issue linked to the reused block in ONE batched write (D1 ⇄ Drizzle), then link the newly
    picked issue — so linked context never accumulates across recurring fires.

- 49b498a: Bug-triage pipeline, Phase F — structured, multi-repo investigation + clarification.

  The `bug-investigator` is upgraded from a thin prose role into a STRUCTURED, read-only,
  multi-repo `container-explore` kind whose triage drives the downstream `clarity-review` gate,
  and the gate learns to seed itself from that triage instead of running its own first LLM pass.
  Same kind id, so the existing `pl_bugfix` preset inherits the upgrade.

  - **Structured `bug-investigator`** (`@cat-factory/agents`): registered via the public
    `registerAgentKind` seam (the `security-auditor` shape) with a lenient valibot
    `bugInvestigation` schema — `clarity` (`clear` | `needs_clarification`), `summary`, ranked
    `rootCauseHypotheses`, `affectedRepos`, `suggestedReproductions`, and `questions`
    (non-empty only when clarification is needed). Its structured object lands on `step.custom`
    (rendered by the stock `generic-structured` view); a built-in post-completion resolver renders
    a prose digest onto `step.output` so downstream steps read the investigation via `priorOutputs`.
    The old prose ROLE entry is removed.
  - **Read-only multi-repo checkouts** (`@cat-factory/server` + `@cat-factory/executor-harness`,
    image bump): the multi-repo fan-out gate now also fires for `bug-investigator`, and the
    container-explore job body threads `peerRepos` + the multi-repo prompt section. The harness
    gains a read-only `runMultiRepoExplore` path — it clones the primary repo PLUS every connected
    involved-service repo as SIBLING checkouts, runs the agent once at the workspace root, and
    makes NO edits / commits / PR (a read-only peer carries no `newBranch`/`pr`) — so a
    cross-service bug is traced across every repo it touches. `PeerRepoSpec.newBranch` is now
    optional (present for the coding fan-out, absent for the read-only one).
  - **Clarity gate seeding + auto-pass** (`@cat-factory/orchestration`): when a structured
    investigator ran upstream, the `clarity-review` gate seeds DETERMINISTICALLY from its triage —
    no reviewer LLM — auto-passing on `clarity === 'clear'` (advance, no human park, no
    notification) and seeding one blocking finding per `question` on `needs_clarification` (park
    for a human, exactly as an LLM reviewer pass would). Because the seed needs no model, the gate
    now activates whenever the clarity store is wired, and the review/incorporate/re-review LLM
    paths degrade gracefully when unwired. Mirrors the requirements-review auto-pass pattern.
  - **Tracker echo on park** (`@cat-factory/kernel` port + `@cat-factory/integrations`): a new
    best-effort `IssueWritebackProvider.postQuestions` echoes the open questions as a comment on
    the block's linked tracker issue when the gate parks — answers still arrive in-app (the tracker
    comment is an echo, not a channel). Not gated on the workspace writeback settings, and a
    tracker outage never fails the run.
  - **Conformance**: a two-facade suite drives the investigator → clarity gate flow — `clear`
    auto-passes straight through to the next step with the digest recorded, and
    `needs_clarification` parks one finding per question then resumes on dismiss-all + proceed.

  The runner image is bumped for the read-only multi-repo explore path; the three hand-maintained
  image-tag pins are synced.

- c20a69a: feat(initiatives): slice 4 — follow-ups & polish

  Complete the Initiatives feature: a settling spawned-task run's forward-looking
  follow-ups (and, on failure, its real cause) are harvested onto the initiative
  tracker at the terminal emit; a human promotes an open follow-up into a new
  `pending` tracker item or dismisses it, retries/skips/re-scopes items, and retunes
  the execution policy — all over the existing rev-CAS single-writer path. No new
  persistence or facade wiring: the curation state rides the initiative `doc` blob
  (D1 ⇄ Drizzle parity unchanged), and the harvest reuses the in-hand run instance
  so it costs no extra read.

- 49b498a: Registry DI migration — the agent-kind registry becomes app-owned (no module global).

  Continues the [registry-DI initiative](docs/initiatives/registry-di-migration.md): the
  plugin-style agent-kind registry (`registerAgentKind` into a module-level `Map`) is replaced by
  an app-owned **`AgentKindRegistry`** instance the composition root news once
  (`defaultAgentKindRegistry()`, pre-loaded with the built-in `bug-investigator` / document /
  initiative kinds), threads through the single `CoreDependencies` object, and re-exposes on the
  `Core` + `ServerContainer` for the HTTP snapshot projection. Module identity stops mattering, the
  external-adapter "phantom Map" gotcha is gone, and tests get a fresh instance instead of
  `clearRegisteredAgentKinds()`. This also fixes the phase-F worker-shard conformance flake at its
  root: the shared suite's `clearRegisteredAgentKinds()` used to wipe the built-in kinds for the
  rest of a single-module run.

  **BREAKING** — the free module-global seams are removed from `@cat-factory/agents` (and the
  facade re-exports): `registerAgentKind`/`registerAgentKinds`, `registered*` (`registeredAgentKind`,
  `registeredAgentStep`, `registeredKindRequiresContainer`, `registeredSystemPrompt`,
  `registeredUserPrompt`, `registeredConfigContributions`, `registeredPreOps`, `registeredPostOps`,
  `registeredAgentPresentation`, `registeredStructuredOutput`, `registeredWebResearchHint`,
  `registeredAgentTuning`, `registeredAgentKinds`), and `clearRegisteredAgentKinds`. Instead export
  the `AgentKindRegistry` class + `defaultAgentKindRegistry()` factory; the pure prompt/catalog fns
  (`systemPromptFor`/`userPromptFor`/`traitsFor`/`hasTrait`/`agentTuningFor`/`configContributionsFor`/
  `configContributionCatalog`/`webResearchGuidanceFor`/`isInlineModelStep`) now take a `registry`
  argument, and a deployment registers custom kinds **by reference** on the instance it injects into
  `buildContainer` / `start()` / `startLocal()` (the `agentKindRegistry` seam), exactly like the
  backend-registries pilot. The runtimes stay symmetric and the cross-runtime conformance suite
  injects a pre-loaded registry to assert a custom kind resolves identically on every facade.

  Also fixes a warm-pool bug in the executor-harness: the read-only multi-repo explore fan-out
  (`runExploreMode`) was gated on `!job.persistentCheckout`, so a `bug-investigator` dispatched to a
  warm local pool (which injects `persistentCheckout: true` on every job) silently dropped its peer
  repos and only saw the primary. The guard is dropped — `runMultiRepoExplore` uses its own
  ephemeral workspace, so the flag is harmlessly ignored.

- 49b498a: Service connections Phase 3 — multi-repo coding. The implementer now fans a cross-service
  change out across every connected involved-service repo, not just the task's own. A new
  `resolveRepoTargets` resolves the task's own repo PLUS each involved service's repo, deduped
  by repo (two services in one monorepo collapse into a single checkout with both
  subdirectories noted; a service co-located in the primary's own repo rides the own-service
  PR). `ContainerAgentExecutor` builds a `peerRepos` job body + a "Multi-repo workspace" prompt
  section for the `coder` kind and works at the repo root so it can reach every involved
  subtree. The executor-harness clones each peer repo as a SIBLING checkout under one workspace
  root, runs the agent once across all of them, and opens one PR per repo it actually changed.
  The own-service PR stays on `block.pullRequest`; the peer PRs are recorded on the new
  `block.peerPullRequests` (`AgentRunResult.peerPullRequests` → engine → JSON column, mirrored
  on D1 + Drizzle), with an `allPullRequests(block)` helper for the multi-repo-aware readers.
  Peer clone URLs are host-allowlisted exactly like the primary. Bumps the runner image
  (`peerRepos` job field + sibling-checkout flow).
- 49b498a: Service connections Phase 4 (= bug-triage Phase C) — multi-PR gates + merge-all. The `ci`,
  `conflicts` and `merger` tail now operate across ALL of a multi-repo task's pull requests
  (own-service + peer-service repos from Phase 3), not just the own PR — no runner-image change
  (the ci-fixer reuses the existing sibling-checkout harness path via a widened `peerRepos` job
  body).

  - **CI gate** aggregates check runs across every PR: a red check in ANY repo fails the gate,
    the failing repo(s) are named, and `step.gate.headShas` tracks each PR head. The `ci-fixer`
    helper now fans out across the sibling checkouts (the `coder`-only multi-repo dispatch is
    widened to `ci-fixer`) so one fixer round covers every failing repo. `CiStatusReport` becomes
    per-PR (`repos: RepoCiStatus[]`).
  - **Conflicts gate** probes mergeability per PR (`MergeabilityReport.repos`); any PR still
    computing keeps polling, the first conflicted repo is recorded on `step.gate.conflictTarget`.
    The conflict-resolver stays single-repo.
  - **Merger** merges every PR in provider-before-consumer order (`orderPrsForMerge`), stopping at
    the first failure. The task is `done` only when ALL PRs merged; a mid-sequence failure
    (cross-repo merges are non-atomic) leaves the block `blocked` and raises an enumerated
    `merge_review` notification (`payload.mergedRepos` / `unmergedRepos`, decision reason
    `merge_partial`). `PullRequestMerger.mergeForBlock` becomes `mergePullRequests(prs)` returning
    a `MergeAllOutcome`.
  - Cross-runtime conformance asserts multi-repo CI aggregation + escalation on both runtimes;
    the merge-all ordering + provider fan-out are unit-tested.
  - A partially-merged multi-repo task (block left `blocked`) is now replay-idempotent: a
    durable-driver retry no longer re-merges the already-merged PRs (which threw and downgraded
    the block to `pr_ready` + raised a duplicate card).
  - A conflict on a PEER repo no longer burns the conflict-resolver attempt budget on the
    own-repo resolver (which can't reach it): the gate declines escalation (`GateProbe.escalatable`)
    and goes straight to the manual-resolution give-up. Own-repo conflicts are unchanged.

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/integrations@0.65.0
  - @cat-factory/orchestration@0.71.0
  - @cat-factory/agents@0.34.0
  - @cat-factory/prompt-fragments@0.10.1
  - @cat-factory/spend@0.10.93

## 0.80.0

### Minor Changes

- 1f6d9fc: Cache the workspace GitHub repo projection through the app caching seam
  (caching-layer initiative, slice 3). A new `AppCaches.repoProjection` group cache
  (grouped and keyed by workspace id) serves the whole-projection re-list that the
  block→repo resolver (`buildResolveRepoTarget`) runs on every agent dispatch and
  every durable poll tick, replacing a live `repoProjectionRepository.list` per
  resolution with a per-workspace cached read.

  Coherence is invalidation-driven: every projection write drops the workspace
  group after it commits — `GitHubSyncService` (repo link / monorepo-flag / the
  exact-set write + tombstone / the link-time full re-stamp, fanned out per
  workspace), `BoardService.addServiceFromRepo` (the monorepo-flag write on the
  import-existing-repo path), `WebhookService` (the `installation_repositories`
  removed tombstone), and `ContainerRepoBootstrapper` (projecting a freshly
  bootstrapped repo). `GitHubSyncService.syncRepo` only invalidates on a `full`
  (link-time) pass — an incremental resync re-stamps `syncedAt` alone, which the
  resolver never reads, so invalidating there would only churn the cache. The
  installation lookup and the tree-depth-bounded block ancestry walk stay live, so
  a block reparent or a service repo-link change needs no cache invalidation.

  The cache is pass-through on the Cloudflare Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate invalidation bus), so the Worker reads the
  projection live. Local mode is likewise pass-through: it seeds the projection via
  the out-of-process `link-repo` CLI and runs single-node with no invalidation bus,
  so an in-memory TTL'd entry could serve a pre-link projection. So the cache is
  active on the multi-node-capable Node facade only. Absent a cache (tests /
  harnesses) every resolve lists live, unchanged.

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0
  - @cat-factory/integrations@0.64.0
  - @cat-factory/orchestration@0.70.1
  - @cat-factory/agents@0.33.1
  - @cat-factory/spend@0.10.92

## 0.79.4

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/prompt-fragments@0.10.0
  - @cat-factory/agents@0.33.0
  - @cat-factory/orchestration@0.70.0

## 0.79.3

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/kernel@0.84.0
  - @cat-factory/integrations@0.63.0
  - @cat-factory/agents@0.32.0
  - @cat-factory/orchestration@0.69.1
  - @cat-factory/spend@0.10.91

## 0.79.2

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0
  - @cat-factory/orchestration@0.69.0
  - @cat-factory/integrations@0.62.1
  - @cat-factory/spend@0.10.90

## 0.79.1

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/integrations@0.62.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/orchestration@0.68.1
  - @cat-factory/prompt-fragments@0.9.55
  - @cat-factory/spend@0.10.89

## 0.79.0

### Minor Changes

- 6edcce0: Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

  - **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
    (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
    App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
    (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
  - **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
    is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
    internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
    per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
    and cleared when they remove their PAT — no live GitHub call on the snapshot path.
  - **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
    Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
    optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
    `GitHubAvailableRepo.personal` wire fields.

  **Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
  — the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
  linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
  now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
  `projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
  dropped; repos remain reachable through their `Service`.

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/integrations@0.61.0
  - @cat-factory/orchestration@0.68.0
  - @cat-factory/agents@0.30.4
  - @cat-factory/prompt-fragments@0.9.54
  - @cat-factory/spend@0.10.88

## 0.78.0

### Minor Changes

- ef57cb1: Bug-triage pipeline, Phase A — pipeline `availability` (one-off / recurring / both).

  A library pipeline can now declare HOW it may be launched, so a recurring-only pipeline (the
  upcoming `pl_bug_triage`) can't be started as a manual one-off, and a one-off-only pipeline can't
  be attached to a schedule. Absent means `'both'` (unrestricted) — pre-1.0, no migration/back-fill,
  existing rows read unchanged.

  - **Contract**: `pipelineSchema` gains `availability?: 'one-off' | 'recurring' | 'both'` (+ the
    `PipelineAvailability` type, re-exported from kernel); `createPipeline`/`updatePipeline` accept
    and persist it.
  - **Persistence** (both runtimes, kept symmetric): `availability` is a new `pipelines.availability`
    column — D1 migration `0037_pipeline_availability.sql` ⇄ Drizzle schema + generated migration —
    read/written by the shared `rowToPipeline` mapper and both repos, so the field round-trips
    instead of being silently dropped on save.
  - **Server enforcement** (the pickers are convenience, not the gate): `ExecutionService.start`
    gains an `origin: 'manual' | 'recurring'` option (default `'manual'`), and a start-only
    `assertPipelineLaunchable` gate rejects a manual start of a recurring-only pipeline (and a
    scheduled fire of a one-off-only one). `RecurringPipelineService.fire` passes `'recurring'`; its
    `create`/`update` reject attaching a one-off-only pipeline to a schedule. A retry/restart
    re-drives an already-validated run, so it never re-checks the launch constraint. A pipeline
    carrying an ENABLED `bug-intake` step must be `'recurring'` (validated at builder save + start;
    a disabled step imposes no requirement). The schedule-attach check delegates to the same gate
    (one rule, one `ValidationError`), and `clone` re-runs it so an un-launchable copy can't be
    minted. Editing a pipeline to `'one-off'` while a schedule still references it is rejected
    (`ConflictError`) rather than silently breaking every future fire.
  - **SPA pickers**: the manual-start surfaces (add-task modal, board/inspector Run menus, task
    run-settings default) filter out `'recurring'`-only pipelines, and the recurring-pipeline modal
    filters out `'one-off'`-only ones — composed with the existing `pipelineAllowedForFrame`
    predicate.

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/orchestration@0.67.0
  - @cat-factory/agents@0.30.3
  - @cat-factory/integrations@0.60.2
  - @cat-factory/prompt-fragments@0.9.53
  - @cat-factory/spend@0.10.87

## 0.77.0

### Minor Changes

- 1d738f7: feat(recurring): on-demand (manual-only) recurring tasks that can use individual-usage subscriptions

  A recurring pipeline can now be flagged **on-demand**: it has no cadence and is never
  fired by the sweeper — it runs ONLY when a person triggers it via "run now". Because a
  human is present at every fire, an on-demand schedule's block MAY target an individual-usage
  subscription model (Claude / Codex / GLM), unlocked per run-now with the initiator's personal
  password exactly like a manual task start. A cadence schedule still refuses individual-usage
  models (no one is present to unlock them unattended).

  - New `onDemand` flag on `PipelineSchedule` + `createScheduleSchema` (recurrence is now
    optional — an on-demand schedule needs none). Persisted as an `on_demand` column on both
    runtimes (D1 migration `0037` ⇄ Drizzle), with `listDue` filtering `on_demand = 0` so the
    sweeper skips them. Cross-runtime conformance asserts the flag round-trips and run-now fires.
  - `RecurringPipelineService.fire` exempts on-demand schedules from the individual-usage
    refusal and threads the run-now initiator + credential-activation closure into the run;
    the run-now controller resolves the personal-credential gate (428 when a password is needed).
  - Frontend: an "on-demand" toggle in the add-recurring modal (hides the cadence editor), an
    on-demand inspector view (no cadence/pause, just run-now), and run-now now rides the cached
    personal password through the credential modal. i18n in all 8 locales.

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/orchestration@0.66.0
  - @cat-factory/agents@0.30.2
  - @cat-factory/integrations@0.60.1
  - @cat-factory/kernel@0.79.1
  - @cat-factory/prompt-fragments@0.9.52
  - @cat-factory/spend@0.10.86

## 0.76.0

### Minor Changes

- 47a2975: Initiatives slice 3 — the execution loop.

  An approved initiative plan now RUNS: a new `InitiativeLoopService` drives each `executing`
  initiative — reconciling its spawned tasks, spawning the next wave just-in-time, and completing
  the initiative once every tracker item settles.

  - **The loop** (`orchestration/modules/initiative/InitiativeLoopService.ts`): per-initiative
    `tick` = reconcile (fold each spawned task block's status back onto its item — done + PR link /
    `pr_open` / `blocked` + deviation, one batched block read, no N+1) → complete (all items settled
    → initiative + anchor block `done`, tracker re-commit, notify) → spawn (create task blocks for
    the eligible `pending` items — current phase, deps met, phase not halted — up to the concurrency
    cap, each pipeline chosen by the policy's estimate→pipeline rules). Spawning is CLAIM-FIRST (a
    rev-CAS write records the pre-generated block id before any side effect), so a concurrent ticker
    never orphans a double-spawn. A per-service task-limit conflict leaves the item `pending` for the
    next sweep; a missing pipeline (deleted after ingest) records a deviation + notification and
    blocks the item — the sweep never throws.
  - **Blocked = halt the phase, notify.** A blocked item stops new spawns in its phase (and keeps the
    phase current, so the initiative never advances past it) and raises the new `initiative`
    notification type; in-flight siblings finish. A human retries/skips the item to unblock.
  - **Both cron seams + terminal pokes.** `runDue` is wired into the Worker `scheduled` handler and a
    Node one-minute interval sweeper (symmetric). A settling child run pokes its owning initiative's
    loop immediately (`RunStateMachine.emitInstance` on a terminal run, `ExecutionService.finalizeMerge`
    on a merge), so work advances without waiting for the next sweep.
  - **Controls.** Pause / resume / cancel endpoints + `InitiativeService` CAS transitions; the sweep
    skips a non-`executing` initiative. The tracker window gains a live progress bar and the inspector
    the loop controls (`initiative.inspector.pause/resume/cancel`, all locales).
  - **`listExecuting()` now returns `{ workspaceId, initiative }[]`** (the entity carries no workspace
    id) — mirrored in the D1 + Drizzle repos and asserted, with the persisted loop-state round-trip,
    by the cross-runtime conformance suite.

  No new persistence (the `initiatives` table already exists on both facades) — so no D1/Drizzle
  migration and no executor-harness image bump.

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/integrations@0.60.0
  - @cat-factory/orchestration@0.65.0
  - @cat-factory/agents@0.30.1
  - @cat-factory/prompt-fragments@0.9.51
  - @cat-factory/spend@0.10.85

## 0.75.2

### Patch Changes

- 0477068: Mothership mode: widen the persistence-RPC allow-list to four more repository surfaces (the
  prompt-fragment library + two account-onboarding reads) so mothership-mode local nodes can drive
  them against a hosted mothership. Adds two new scope rules, `owner` (an `(ownerKind, ownerId)`
  positional pair) and `ownerField` (the same as record fields on `upsert`), which resolve a
  `workspace` owner to its account and take an `account` owner as the accountId directly — so a
  machine token scoped to one account can never read/write another tenant's rows.

  - `promptFragmentRepository` — the tenant-scoped prompt-fragment library management surface
    (`listByOwner`/`get`/`softDelete` via the `owner` rule, `upsert` via `ownerField`). Rows carry no
    secrets and both tiers are member-level (account-tier routes guard on `requireMember`, not
    `requireAdmin`). The `sourceId`-keyed `listBySource` (repo-sync fan-out) stays mothership-internal.
  - `fragmentSourceRepository` — the fragment-source library list + link (`listByOwner` via `owner`,
    `upsert` via `ownerField`). The `sourceId`-keyed `get`/`updateSyncState`/`softDelete` stay off —
    they back the repo-sync the mothership owns (its source service needs a GitHub client a mothership
    node lacks). Node routes both fragment repos through the `pickRepoSource`/`if (remoteRepos)` seam
    ONLY when the library is configured, so the module isn't spuriously turned on in mothership mode.
  - `invitationRepository.listByAccount` — the account members panel's pending-invite read (member-level,
    `account` rule). Invite `create`/`setStatus` (admin-gated) + the pre-auth `findByTokenHash`/`get`
    accept-invite lookups stay off.
  - `emailConnectionRepository.getByAccount` — the email-settings panel read (member-level, `account`
    rule). Its provider key rides a sealed `apiKeyCipher` blob (the repo never decrypts), so no
    plaintext crosses the machine API. Connect/disconnect (`upsert`/`softDelete`, admin-gated) stay off.

## 0.75.1

### Patch Changes

- 4a59f45: Mothership mode: widen the persistence-RPC allow-list to three more repository surfaces so
  mothership-mode local nodes can drive them against a hosted mothership.

  - `runnerPoolConnectionRepository` (whole repo) — the self-hosted runner-backend connection
    settings panel (`getByWorkspace`/`softDelete` via the `workspace` rule, the record-based
    `upsert` via `workspaceField`). Credentials ride a sealed `secretsCipher` blob, so no plaintext
    crosses the machine API (the observability/environment-connection precedent).
  - `binaryArtifactMetadataStore` (metadata surface) — the visual-confirmation gate's artifact
    metadata (`insert` via `workspaceField`; `get`/`listByExecution`/`countByExecution`/`listByBlock`/
    `delete` via `workspace`). The blob BYTES stay per-account local; only the metadata is proxied,
    and the retention sweep stays mothership-internal. It is folded into both facades' reflected
    `repositories` registry (it isn't a `CoreDependencies` member).
  - `serviceRepository.listByFrameBlocks` — the batched board-composition / frame-deletion read, via
    the `blockList` scope kind.

## 0.75.0

### Minor Changes

- b928904: Service connections Phase 2 — multi-env provisioning. A `deployer` step now fans out over
  the task's own service frame PLUS each connected involved-service frame, provisioning one
  ephemeral environment per frame (dispatched provider-before-consumer, parked between), each
  keyed per `(blockId, frameId)` so the fan-out no longer clobbers itself. Already-ready peers
  are injected into a later provision as `{{input.peerEnvUrls}}`, the agent context gains
  `involvedServices` (title + connection description + the peer's live env URL, read-time
  stale-filtered), and the Tester infra spec gains a `peerEnvironments` map so a cross-service
  integration test can reach a peer's real environment.

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/orchestration@0.64.0
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/integrations@0.59.0
  - @cat-factory/agents@0.30.0
  - @cat-factory/prompt-fragments@0.9.50
  - @cat-factory/spend@0.10.84

## 0.74.0

### Minor Changes

- 7fa7578: Initiatives slice 2 — interactive planning.

  The Initiative Planning pipeline (`pl_initiative`) now interviews the human and analyses the
  codebase before the planner drafts, so the plan is grounded in the stakeholder's intent and the
  real code. The pipeline becomes
  `[initiative-interviewer → initiative-analyst → initiative-planner → approval gate → initiative-committer]`
  (catalog `version` bumped to 2, so workspaces get the reseed offer).

  - **`initiative-interviewer`** — a new inline LLM gate that asks clarifying questions about goals,
    scope and constraints, PARKS the planning run on a durable decision-wait while the human answers
    through a dedicated planning Q&A window, then synthesizes the agreed goal / constraints / non-goals
    brief. It is **entity-native**: the questions, answers and brief live directly on the `initiatives`
    entity (its `qa` + new `interview` fields) via the CAS `mutate` — no new table. Reuses the shared
    `RunStateMachine` park/answer/resume spine (the review-gate model). Passes through when no
    interviewer model is wired, so pipelines run unchanged.
  - **`initiative-analyst`** — a new container-explore agent that reads the repo and writes a prose
    codebase analysis onto the entity (`analysisSummary`), grounding the plan.
  - The **planner** and **analyst** prompts now fold in the interview brief + analysis (threaded onto
    the agent context for `initiative`-level runs).
  - New endpoints (`POST /blocks/:blockId/initiative-planning/{answer,continue,proceed}`), store
    actions and the `initiative-planning` result-view window; the inspector surfaces an "Answer
    planning questions" button while the interviewer is parked. `initiative.planning.*` copy added to
    all locales.

  Runtime-symmetric with no facade changes (the interviewer resolves its model exactly like the
  requirements reviewer, from the routing default already wired in both runtimes) and no new
  persistence — so no D1/Drizzle migration and no executor-harness image bump.

### Patch Changes

- f372f4e: Mothership mode: allow-list the ephemeral-environment connection management surface.

  The environment provider-connection + per-type infra-handler settings panels
  (`EnvironmentController` → `EnvironmentConnectionService`: connect / list / disconnect a
  backend, register / test / re-secret / unregister a per-type engine handler) are now
  functional in mothership mode, alongside the workspace-defined custom-manifest-type catalog
  the infra configurator reads + edits.

  - Newly allow-listed in `REMOTE_PERSISTENCE_METHODS`: the whole `environmentConnectionRepository`
    (`listByWorkspace`/`getByWorkspaceAndType`/`softDelete` via the `workspace` rule, the
    record-based `upsert` via the `workspaceField` rule) and the whole `customManifestTypeRepository`
    (`listByWorkspace`/`remove` via `workspace`, `upsert` via `workspaceField`). Member-level,
    workspace-scoped — the same policy as the observability / other settings panels.
  - Safe to expose like the observability connection: the connection record carries handler secrets
    as a **sealed** `secretsCipher` blob (the repo returns it verbatim; sealing/decryption live in
    the service under the local key), so no plaintext credential crosses the machine API and the
    mothership only ever stores ciphertext. Custom-manifest-type rows carry no secrets.
  - `customManifestTypeRepository` (built directly over `db` by `selectNodeEnvironmentsDeps`) is now
    routed through the `pickRepoSource`/`remoteRepos` seam in `buildNodeContainer` so it resolves
    from the remote registry when there is no Postgres (`environmentConnectionRepository` was already
    routed).

  Deliberately still off (a later secrets-delegation slice): actually provisioning an environment
  (`environmentRegistryRepository.insert`/`update`) + decrypting a remotely-sealed access cipher.
  Server-only allow-list change + one routing line, symmetric by construction.

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/orchestration@0.63.0
  - @cat-factory/agents@0.29.1
  - @cat-factory/integrations@0.58.1
  - @cat-factory/prompt-fragments@0.9.49
  - @cat-factory/spend@0.10.83

## 0.73.1

### Patch Changes

- 6917962: mothership: allow-list the VCS / GitHub projection read surface

  In mothership mode the SPA's VCS board panels (repos / branches / pull requests / issues) were not
  functional over `/internal/persistence`: the projection reads `GitHubService` (`container.github`)
  serves straight from the local projections came back `unknown_method`. This widens
  `REMOTE_PERSISTENCE_METHODS` with those reads, each workspace-scoped on arg0 (the existing
  `workspace` rule — no new scope machinery), read-only and member-level (the GitHub read endpoints
  mount under `/workspaces/:workspaceId`, not admin-gated):

  - `repoProjectionRepository.list` — the repos panel.
  - `branchProjectionRepository.listByRepo` — a repo's branches.
  - `pullRequestProjectionRepository.listByWorkspace` — the pull-requests panel.
  - `issueProjectionRepository.listByWorkspace` — the issues panel.
  - `githubInstallationRepository.getByWorkspace` — the run path's installation lookup (see below).

  `repoProjectionRepository.list` is ALSO on the run path — `resolveRepoTarget` walks the
  `github_repos` projection to find a block's repo on EVERY container-agent dispatch. But it reads
  `githubInstallationRepository.getByWorkspace` FIRST (returning null when GitHub isn't connected),
  so closing the run-path gap for real (non-fake-executor) runs needs BOTH reads: with only `list`
  allow-listed the resolver still failed one call earlier on the un-remoted installation read. Its
  other deps — `blockRepository.get`, `serviceRepository.getByFrameBlock` — are already remote, so
  adding `getByWorkspace` + `list` genuinely closes it (the merge-gate integration test uses the
  `FakeAgentExecutor`, which bypasses repo resolution, so the gap didn't surface there).

  Still off the SPA path (a later GitHub sync + repo-write slice): the projection WRITE surface —
  `upsertMany` (the sync/webhook ingest; the mothership owns GitHub sync, since the App + webhooks
  live there), the board-linkage writes `repoProjectionRepository.linkBlock` / `setMonorepo`, the
  installationId-keyed sync cursors, `tombstoneMissing`, and the per-repo `listByRepo` variants the
  panels don't drive. `repoProjectionRepository.get` stays off too: it backs only
  `GitHubService.resolve` for the repo-WRITE endpoints (create-branch / open-PR / merge / comment),
  and exposing it alone would let create-branch/open-PR do the real GitHub write and THEN fail on the
  un-remoted `upsertMany` projection refresh — a worse failure than today's clean pre-write refusal.

  Still off on the installation repo: only the workspace-scoped `getByWorkspace` the run path needs
  is opened; its installationId-keyed reads, the token/sync writes, the webhook fan-out, and the
  cron `listActive` stay off (the same later GitHub sync + repo-write slice).

  The projection repos + the installation repo are already routed through the `pickRepoSource`/
  `sourced` seam, so a mothership-mode node already sources them from the full-surface remote registry
  when `db` is undefined — an allow-list change only, symmetric by construction (the dispatcher
  reflects over each facade's registry).

## 0.73.0

### Minor Changes

- 55661f4: Add a public, key-authenticated external API (`/api/v1`) whose first use-case is "break down an
  initiative": an external system picks a public, inline pipeline and posts a brief, and the platform
  runs it headlessly and persists the result in the DB for asynchronous retrieval (poll
  `GET /api/v1/jobs/:id` or stream `GET /api/v1/jobs/:id/events` over SSE). Nothing is committed to
  GitHub — the run uses an inline agent (`initiative-breakdown`) with no container/repo.

  - Inbound public-API keys (`public_api_keys`, mirrored D1 ⇄ Drizzle) are revocable and stored as a
    one-way peppered hash (`HMAC-SHA256(secret, ENCRYPTION_KEY)`) — never plaintext, never
    recoverable. Managed per-workspace via `GET|POST|DELETE /workspaces/:ws/public-api-keys`; the raw
    key is shown once on create.
  - Runs are anchored on a headless `internal` block excluded from every board projection, so the
    external runs never appear in the UI.
  - Requires `ENCRYPTION_KEY` (the HMAC pepper); the surface 503s when unconfigured.

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0
  - @cat-factory/integrations@0.58.0
  - @cat-factory/orchestration@0.62.0
  - @cat-factory/prompt-fragments@0.9.48
  - @cat-factory/spend@0.10.82

## 0.72.0

### Minor Changes

- ca5c3e8: Initiatives (slice 1 of 4): the long-running, multi-task counterpart to a task — see
  `docs/initiatives/initiatives-feature.md` for the full multi-slice plan.

  - **New `initiative` block level** — a container block under a service frame (created via the
    new "Create initiative" button in the frame header, next to add-task/import-task). Tasks a
    later slice's execution loop spawns link back via the new `blocks.initiative_id` membership
    column (epic-style). D1 migration `0035_initiatives.sql` ⇄ Drizzle schema, shared mapper.
  - **New `initiatives` entity + store** — the DB row is the source of truth (phases, items with
    planner-authored estimates + dependencies, the execution policy with estimate→pipeline rules,
    decisions / deviations / follow-ups / caveats), guarded by a `rev` compare-and-swap so the
    loop has a single logical writer. Mirrored D1 ⇄ Drizzle repositories with a cross-runtime
    conformance suite (CRUD, doc round-trip, CAS conflict, `blocks.initiative_id`).
  - **Initiative Planning pipeline skeleton (`pl_initiative`)** — `initiative-planner` (a
    read-only structured container explore that drafts the multi-phase plan, gated for human
    approval) + `initiative-committer` (a deterministic engine step that flips the entity to
    `executing` and commits the rendered tracker to `docs/initiatives/<slug>/` — canonical
    `initiative.json` + human `tracker.md` + `version.json`, hash-short-circuited and
    replay-safe, following the blueprint artifact pattern). A bidirectional guard in the
    engine's shared `assertRunnable` makes `pl_initiative` the ONLY pipeline runnable on an
    initiative block (and vice versa), across start/retry/restart.
  - **API + snapshot + realtime** — `POST/GET /workspaces/:ws/initiatives` (+ by-block read),
    the snapshot's optional `initiatives` field, and a new `initiative` WorkspaceEvent pushed
    from both runtimes' publishers.
  - **Frontend** — the Create Initiative modal + frame-header button, the initiative board card,
    an inspector body (run planning / open tracker) and the read-only Initiative Tracker window
    (`initiative-tracker` result view), with the `initiative.*` i18n namespace across all 8
    locales.

  Later slices add the interactive planning interview, the execution loop (just-in-time task
  spawning with estimate-gated pipeline selection), and follow-up/deviation harvesting.

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0
  - @cat-factory/orchestration@0.61.0
  - @cat-factory/integrations@0.57.2
  - @cat-factory/prompt-fragments@0.9.47
  - @cat-factory/spend@0.10.81

## 0.71.2

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1
  - @cat-factory/orchestration@0.60.4

## 0.71.1

### Patch Changes

- 803fa76: mothership: allow-list the Kaizen grading read surface

  In mothership mode the Kaizen SCREEN (`KaizenController` → `KaizenService.getOverview` /
  `listForExecution`) was not functional over `/internal/persistence`: the run-path grade
  reads/writes (`kaizenGradingRepository.getByStep`/`upsert`,
  `kaizenVerifiedComboRepository.getByKey`) were remotely callable, but the screen's list reads
  came back `unknown_method`, so a mothership-mode SPA could not display the grading history, the
  verified-combo library, or a run's per-step grading status. This widens
  `REMOTE_PERSISTENCE_METHODS` with the screen's reads, each workspace-scoped on arg0 (the existing
  `workspace` rule), read-only and member-level (the Kaizen endpoints are not admin-gated):

  - `kaizenGradingRepository.listByWorkspace` — the Kaizen screen's bounded grading history.
  - `kaizenGradingRepository.listByExecution` — the run-window per-step grading status.
  - `kaizenVerifiedComboRepository.listByWorkspace` — the verified-combo library.

  Still off the SPA path: the internal-only single-grade `kaizenGradingRepository.get` (the service
  never calls it), the background-sweep reads (`listPending`/`claim`, kind-spanning cron), and the
  combo `upsert` (the streak/verified write) — kaizen GRADING itself is best-effort in mothership
  mode until the Phase 5 telemetry/local-first sync, but the screen that VIEWS prior grades now reads
  them over the RPC. These are core repositories (`createDrizzleRepositories`), so a mothership-mode
  node already sources them from the full-surface remote registry (`composeMothership`) when `db` is
  undefined — an allow-list change only, symmetric by construction (the dispatcher reflects over each
  facade's registry).

## 0.71.0

### Minor Changes

- b216fdc: Fragment GitHub-source staleness is now a lightweight commit-version check.

  The full fragment bodies were already cached on our side; the "check for changes"
  probe previously re-listed the whole source directory and hashed every blob sha.
  It now reads only the source directory's current head commit sha and compares it to
  the commit the source was last synced to — a single cheap GitHub/GitLab call, no
  directory listing or file reads.

  Breaking (pre-1.0, no migration): `FragmentSource`/`FragmentSyncResult` now expose
  `lastSyncedCommit` instead of `lastSyncedSha`, and `FragmentSourceStatus` is
  `{ changed, lastSyncedCommit, remoteCommit }` (the per-file `changedCount`/`remoteSha`
  are gone — the resync badge is now a plain "changes available" indicator). A new
  `latestCommitSha` port method is added to `GitHubClient` and `VcsClient`. The physical
  `fragment_sources.last_synced_sha` column is unchanged and reused to store the commit
  sha, so no database migration is required; existing rows re-derive their commit on the
  next sync.

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/integrations@0.57.1
  - @cat-factory/orchestration@0.60.3
  - @cat-factory/spend@0.10.80
  - @cat-factory/prompt-fragments@0.9.46

## 0.70.0

### Minor Changes

- 7fd6a19: Import-from-repo picker: find and link accessible repos in realtime instead of enumerating the whole installation and filtering in memory. The old path listed every installation repo (capped at a bounded page count) then substring-filtered client-of-the-cap — so on a wide App install a repo beyond that window returned "no matches" for a repo you actually had access to, and every keystroke re-fetched all pages. Two new `GitHubClient` primitives fix it end to end: `searchInstallationRepos` issues one bounded, account-scoped GitHub search per query, and `getRepoById` point-reads the picked repo by id when linking it (so a repo surfaced by search from beyond the enumeration cap links instead of spuriously 409-ing). Blank-query browse-all is unchanged; PAT (local) and GitLab connections filter their bounded token listing. When an installation has no resolvable account to scope the GitHub search to, the App adapter filters its own bounded listing rather than running an unscoped global search (which would surface arbitrary, unlinkable public repos).

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/integrations@0.57.0
  - @cat-factory/agents@0.26.18
  - @cat-factory/orchestration@0.60.2
  - @cat-factory/spend@0.10.79

## 0.69.1

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/orchestration@0.60.1
  - @cat-factory/agents@0.26.17
  - @cat-factory/integrations@0.56.5
  - @cat-factory/prompt-fragments@0.9.45
  - @cat-factory/spend@0.10.78

## 0.69.0

### Minor Changes

- b78adf5: Private package registries: workspace-scoped npm registry credentials (npm private
  orgs + GitHub Packages) that agent containers use to resolve private dependencies on
  checkout.

  - **Storage**: one `package_registry_connections` row per workspace (D1 migration 0034
    ⇄ Drizzle mirror) holding a single sealed JSON array of entries
    (`{ id, ecosystem: 'npm', vendor: 'npmjs' | 'github-packages', scopes, token }`,
    cipher tag `cat-factory:package-registries`) plus a non-secret summary (vendor +
    scopes + token tail). Ecosystem-discriminated so pip/maven/cargo are later additive.
  - **API**: `GET|POST /workspaces/:ws/package-registries`, `DELETE …/:entryId`
    (`PackageRegistriesController`, 503 when the module is unwired). Tokens are
    write-only — the list view never returns them; edit = delete + re-add. Only one
    entry per vendor is allowed (a 409 otherwise): the harness renders a single
    host-keyed `_authToken` per registry, so a duplicate token would be silently
    dropped — put every scope for a vendor on its one entry. Tokens are validated as a
    single opaque printable-ASCII string (no spaces/control characters) so a token can't
    inject extra `~/.npmrc` lines.
  - **Dispatch**: `ContainerAgentExecutor` + `ContainerRepoBootstrapper` accept a
    `resolvePackageRegistries` seam (wired in both facades from the same store) and
    forward the decrypted entries as a `packageRegistries` field on every container job
    body, like `ghToken`. The registry host is derived backend-side from the fixed
    vendor set. A resolution failure fails the dispatch rather than silently running
    without auth. The agent-context snapshot's allow-list projection excludes the field.
  - **UI**: a "Private package registries" panel in the Integrations hub
    (`PackageRegistriesPanel.vue`) — vendor preset + scopes + write-only token, entries
    listed from the redacted summary.
  - **Conformance**: a new suite section asserts add → redacted list → decrypted
    dispatch resolution → remove identically on D1 and Postgres.

### Patch Changes

- 36f4cf6: Frontend UI-test bindings: surface how each backend binding resolves + a non-fatal run-start note.

  - **Shared resolution helpers moved to `@cat-factory/contracts`** (next to `frontendOriginsForService`)
    so the SPA and the backend share ONE source of truth: `resolveFrontendBindings`,
    `indexLiveServiceEnvUrls`, `boundServiceFrameIds`, the `ResolvedFrontendBinding`/`LiveEnvHandle`
    types, and a new pure `buildFrontendRunNotes`. Orchestration re-exports them, so existing importers
    are unchanged.
  - **Inspector resolved-binding visibility**: `FrontendConfig.vue` now shows, live, how each backend
    binding resolves — `envVar → a bound service's live ephemeral URL | mocked (WireMock)` — mirroring
    what a UI-test run resolves, plus a warning for duplicate env vars. Backed by a new lightweight
    `environments` store over `GET /workspaces/:ws/environments`.
  - **Run/step detail projection + run-start note**: the engine stamps BOTH the resolved bindings
    (`ExecutionInstance.frontendBindings`) and the non-fatal advisories (`ExecutionInstance.notes`:
    duplicate env vars, or a partial-live set where some bound services fall back to WireMock) on the
    run ONCE at start — the SPA-visible mirror of the harness's own `buildInfraNotes`. A `tester-ui`
    step's detail projects the FROZEN start-time bindings (so a finished run shows what it actually
    drove against, not a live re-resolution that could disagree with the co-located note after the
    envs are torn down); the run-start note shows on any step detail of a frontend-frame run. Both
    ride in the run's `detail` JSON (no migration) and round-trip identically on D1 ⇄ Postgres.

  No wire/behaviour break: the notes field is optional, the moved helpers are re-exported, and a
  non-frontend run is unaffected.

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/orchestration@0.60.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/integrations@0.56.4
  - @cat-factory/prompt-fragments@0.9.44
  - @cat-factory/spend@0.10.77

## 0.68.2

### Patch Changes

- e0aab3f: Connections between services, phase 1 of the service-connections initiative (see
  `backend/docs/service-connections.md` + `docs/initiatives/service-connections.md`):

  - **Service connections**: a `service`-type frame carries `serviceConnections` — directed
    consumer→provider edges to the other services it uses, each with an optional
    description ("sends transactional email via it"). Stored as a JSON column on the block
    (D1 migration `0034` ⇄ Drizzle), validated at the `updateBlock` write gate (no
    self-connection, no duplicates, targets must be service frames; cycles are deliberately
    legal), pruned when a connected frame is deleted, and drawn as emerald consumer→provider
    edges on the board. A new inspector panel on service frames edits the connections and
    shows the reverse "Used by" list.
  - **Per-task involved services**: a task carries `involvedServiceIds` — the connected
    services directly involved in it beyond its own service, picked (in the task's run
    settings) from the frame's connection neighbors in either direction. Validated at the
    write gate against the neighbor set; a selection whose connection was later removed is
    badged stale in the UI and dropped on the next change. Later phases use the selection
    to provision every involved service as an ephemeral environment and to let the coding
    agent change every involved repo (multi-repo sibling checkouts) — designed in the
    docs, not yet implemented.
  - Cross-runtime conformance now round-trips both JSON columns and asserts the write-gate
    rejections on both stores.

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/orchestration@0.59.2
  - @cat-factory/agents@0.26.15
  - @cat-factory/integrations@0.56.3
  - @cat-factory/prompt-fragments@0.9.43
  - @cat-factory/spend@0.10.76

## 0.68.1

### Patch Changes

- 0d51638: Harden three server-side SSRF surfaces:

  - **Local-runner allow-list** no longer treats a DNS hostname that merely starts with `fc`/`fd`
    (e.g. `fc2.com`) as a private IPv6 ULA — the ULA/loopback tests are now gated behind an
    "is IPv6 literal" check and the classification reuses the vetted kernel `ip-host` primitives.
  - **Runner-pool provider** (`HttpRunnerPoolProvider.execute`/`oauthToken`) and the shared
    `probeConnection` now follow redirects by hand and re-run the SSRF guard on every hop, so a
    permitted scheduler host can't 302 the secret-bearing dispatch body to an internal/metadata
    target. Factored the per-hop `safeFetch` + capped-read helpers into a shared module reused by
    the environment provider. `safeFetch` additionally drops the request body and strips
    credential headers (`authorization`/`cookie`/`proxy-authorization`) on any **cross-origin**
    redirect hop, so a permitted host also can't bounce the secrets to a _different_ public host
    (re-establishing the cross-origin credential stripping the platform `fetch` would have done,
    which the manual `redirect: 'manual'` follower had bypassed).
  - **Account-configured SearXNG web-search URL** is now validated (public host, http/https, no
    private/internal/metadata target) both at the write boundary and with per-hop revalidation on
    fetch.

- 0d51638: Boundary hardening:

  - **Local mode** now enforces a minimum strength on the required crypto secrets at config
    load: `AUTH_SESSION_SECRET` must be ≥32 characters (local mode defaults the auth gate open,
    so a weak secret would leave session/proxy/machine tokens forgeable) and `ENCRYPTION_KEY`
    must decode to a full 32-byte key (surfaced early instead of deep in the first cipher build).
  - **GitHub webhook verifier** fails closed when the webhook secret is unset (previously it would
    import an empty HMAC key and compare), matching the GitLab verifier.
  - **CORS** no longer reflects an arbitrary Origin by default outside development: an unset
    `CORS_ALLOWED_ORIGINS` reflects any origin only when `ENVIRONMENT` is an explicitly
    recognised development value (`development`/`dev`/`test`/`testing`/`local`/`e2e`). An
    unset, unknown, or production `ENVIRONMENT` default-denies (fails safe), so a deployment
    that forgets BOTH `ENVIRONMENT` and `CORS_ALLOWED_ORIGINS` no longer silently reflects.
    An explicit `*` still opts into reflect-all.

- 0d51638: Secret-handling hardening:

  - **LLM telemetry** (`LlmObservabilityService`) now scrubs credential shapes from the
    prompt/response/reasoning bodies AND the `errorMessage` with a shared `redactSecrets`
    (promoted to `@cat-factory/kernel`, reused by the provisioning-log path) BEFORE anything is
    stored or fanned out to an external trace sink (Langfuse). `errorMessage` is kept as
    diagnostic metadata even when bodies are dropped and is fanned out ungated, so it is
    scrubbed too (an upstream 4xx/5xx string can echo an auth header). Prompt/response/reasoning
    body capture is additionally gated on the per-workspace `storeAgentContext` toggle (numeric
    telemetry is always recorded). Also fixed a latent O(n²) regex backtrack in the URL-userinfo
    redaction rule that a large prompt could trigger.
  - **Signed tokens** (`HmacSigner`) now derive an independent HKDF-SHA256 subkey per audience
    (`session`/`oauth-state`/`llm-proxy`/`ws`/`machine`), so a token class is cryptographically
    isolated rather than sharing one raw HMAC key. Key derivation is bounded to that fixed
    audience set — `verify` selects the key from the token's attacker-controlled claimed `aud`
    before the MAC check, so an unrecognised (or absent) audience falls back to the raw-secret
    base key rather than deriving+caching a fresh subkey, preventing an unbounded key-cache /
    per-request-HKDF DoS from a flood of junk-audience tokens. Breaking: any tokens signed before
    this change no longer verify (pre-1.0, no migration — clients re-authenticate).

- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
  - @cat-factory/integrations@0.56.2
  - @cat-factory/kernel@0.70.1
  - @cat-factory/orchestration@0.59.1
  - @cat-factory/agents@0.26.14
  - @cat-factory/spend@0.10.75

## 0.68.0

### Minor Changes

- eb67d40: Record per-call LLM telemetry for the Claude Code and Codex subscription harnesses,
  so their calls appear in the same `llm_call_metrics` store (and the "Model activity"
  observability panel) as the proxy-metered Pi harness.

  These harnesses talk direct to the vendor and bypass the LLM proxy, so the harness now
  lifts per-call metrics off each CLI's event stream: Claude Code (`stream-json --verbose`)
  carries full request/response bodies, per-turn tokens, model, and finish reason; Codex
  (`exec --json`) is thinner — flat assistant text plus per-turn token counts, with no
  request transcript (a CLI limitation). The executor records these into the SAME
  `LlmObservabilityService` the proxy uses (with zero per-HTTP timing, since the CLIs don't
  expose it), wired symmetrically on the Cloudflare and Node facades. Captured bodies are
  credential-scrubbed and honour the existing `LLM_RECORD_PROMPTS` switch. Telemetry is
  recorded on failed runs too (not only successful ones), so a token-spending run that
  ends with no changes / unusable output stays observable, and each row is minted a
  deterministic id off the job id so a durable-driver replay re-records idempotently.

  Also tightens `LLM_RECORD_PROMPTS`: it now empties the response and reasoning bodies as
  well as the prompt when recording is off (previously only the prompt was suppressed),
  so a deployment that opts out of retaining prompts no longer retains model replies
  either.

  Bumps the executor-harness runner image (harness `src/**` changed).

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0
  - @cat-factory/orchestration@0.59.0
  - @cat-factory/agents@0.26.13
  - @cat-factory/integrations@0.56.1
  - @cat-factory/spend@0.10.74

## 0.67.0

### Minor Changes

- 5ce03c6: Frontend-config inspector: add repo autodetection, a frontend-directory field, clearer serve-mode
  help, and collapsible field groups.

  - **Detect from repo**: a new deterministic, checkout-free detector proposes a frontend config
    (package manager from the lockfile, install command, build script + output dir from
    package.json/framework markers, serve mode/script, and backend-binding env-var names from dotenv
    examples). Exposed as `POST /workspaces/:ws/environments/detect-frontend-config`
    (`detectFrontendConfig` on the environments connection service) and surfaced in the panel as a
    non-binding preview the user reviews and applies (backend bindings are appended, never
    overwriting existing service links).
  - **Frontend directory**: `FrontendConfig.directory` scopes a monorepo frontend's build/serve to a
    subdirectory (threaded into the harness job-body builder).
  - **Serve mode**: replaced the single hint with per-mode descriptions and a note distinguishing it
    from the separate env-injection axis.
  - **Grouping**: the panel's fields are now collapsible sections (Build / Serve / Mocking / Env
    injection / Backend bindings / Preview), collapsed by default.

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/integrations@0.56.0
  - @cat-factory/agents@0.26.12
  - @cat-factory/kernel@0.69.8
  - @cat-factory/orchestration@0.58.1
  - @cat-factory/prompt-fragments@0.9.42
  - @cat-factory/spend@0.10.73

## 0.66.7

### Patch Changes

- 7f9d215: Fix critical/high race conditions from the July 2026 audit:

  - **Spend-resume on Cloudflare (1.1):** a spend-paused run's `ExecutionWorkflow`
    instance no longer returns (going terminal). It now stays alive **parked on a
    `waitForEvent`** (like a human-decision wait, not a busy sleep-loop), so a long pause
    no longer accretes unbounded durable steps. `/spend/resume` wakes it immediately via a
    new `WorkRunner.signalResume` (a `spend-resume` event), and a 24h re-check chunk
    auto-resumes it when the monthly budget frees — instead of the terminal-instance-id
    trap that let the cron sweeper force-fail the "resumed" run.
  - **Spend-resume on Node/local (parity):** Node/local now auto-resume spend-paused runs
    when the monthly budget frees, via a new `agentRunRepository.listPausedExecutions`
    polled by the reclaim sweeper (gated on `isOverBudget`, so a still-exhausted workspace
    causes no churn) — matching the Cloudflare facade. Covered by a conformance assertion.
  - **BootstrapWorkflow re-drive (1.2):** past the poll-read tolerance the workflow no
    longer returns (going terminal, which made the sweeper force-fail a merely-busy
    container). It keeps the instance alive and keeps polling, so a long clone/install
    recovers.
  - **One live execution run per block (2.1):** a new partial unique index on live
    execution rows per block (D1 migration `0033` ⇄ Drizzle) plus an **atomic**
    `ExecutionRepository.insertLive` that deletes the block's terminal rows (and the
    caller's own `replaceId`) and inserts the new run **in one transaction** (D1
    `db.batch` / Drizzle `transaction`). `start`/`retry`/`restartFromStep` no longer
    `deleteByBlock` first, so a genuinely-concurrent double start is rejected with a 409
    instead of the pre-delete wiping a concurrent winner and creating two live runs — two
    drivers, two containers — on one branch. Covered by cross-runtime conformance
    assertions (terminal cleanup + `replaceId` supersede).

- Updated dependencies [7f9d215]
- Updated dependencies [05d1b08]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/orchestration@0.58.0
  - @cat-factory/integrations@0.55.0
  - @cat-factory/agents@0.26.11
  - @cat-factory/spend@0.10.72

## 0.66.6

### Patch Changes

- 4955639: Fix five bugs in how best-practice prompt fragments are managed and applied:

  - **Code-aware helper agents now receive the service fragments.** `ci-fixer`, `fixer`
    and `on-call` are dispatched off their HOSTING step (a `ci`/`post-release-health`
    gate, the tester, the human-test/visual-confirmation loops), and the fragment fold
    keyed off that step's kind — so the helpers never received the service's standards
    despite being marked `code-aware`. `AgentContextBuilder.buildContext` now takes an
    explicit `agentKind` override and every helper dispatch passes it; the on-call job
    body additionally folds the resolved fragments into its bespoke system prompt
    (previously bypassed). A stale `step.selectedFragmentIds` is also cleared when a
    re-dispatch resolves to nothing, so observability can't over-report.
  - **Tier tombstones now stick on the run path.** `resolveBodiesForRun` used to fall
    back to the static pool for any id missing from the merged catalog — which is
    exactly what a tombstone does to a built-in, so suppressing a fragment a service
    had selected silently resurrected it. The fallback is gone; a missing id is dropped.
  - **Deployment-registered fragments join the tenant catalog.** The library's built-in
    tier now reads the UNIVERSAL pool (shipped catalog + `registerPromptFragment`
    entries, lazily) instead of the raw shipped array, so a registered override of a
    built-in id actually reaches runs and the resolved catalog, and registered
    fragments can be tier-shadowed/tombstoned like any built-in.
  - **Repo-source resync no longer mishandles renames and id edits.** The tombstone
    sweep is keyed by the fragment ids the current tree produces, not by stale paths:
    renaming a file that pins an explicit frontmatter `id` no longer tombstones the
    fragment the rename just updated, and changing a file's explicit `id` in place now
    retires the old id instead of leaving a live duplicate forever. The GitHub
    installation is also resolved once per sync instead of once per file, and the
    requirement writer's fragment grounding resolves through the merged tenant catalog
    when the library is wired.
  - **The SPA pickers now offer the merged catalog.** The per-service / per-block /
    workspace-default fragment pickers loaded only the static built-in pool, so
    managed, repo-sourced and document-backed fragments could be authored but never
    attached (and a managed id set via API rendered no chip). The fragments store now
    loads the workspace's resolved catalog (falling back to the static pool when the
    library is off), invalidates on library edits, and unknown selected ids render as
    removable chips instead of disappearing. The catalog is per-board, so a workspace
    switch now invalidates it and the task inspector reloads it on mount — otherwise the
    task picker kept showing the previous board's fragments.

  Review follow-ups: `AgentContextBuilder` now clears a stale `step.selectedFragmentIds`
  on the non-code-aware and error paths too (not only when a code-aware resolve is empty);
  the requirement-writer grounding resolves the merged catalog once (reused for titles and
  bodies) instead of twice; a repo-source RENAME of an explicit-id file inherits the
  fragment's `version`/`createdAt` by id instead of resetting them; and the source `status`
  count no longer double-counts a pure rename.

- Updated dependencies [4955639]
  - @cat-factory/agents@0.26.10
  - @cat-factory/orchestration@0.57.7

## 0.66.5

### Patch Changes

- 4a7a3f1: Preserve a task run's error trail across retries. A failed run's `failure` is now
  appended to a new `failureHistory` on the fresh attempt (persisted in the shared
  `agent_runs.detail`, so both runtimes get it with no migration), and cleared on the
  running attempt — so the top failure banner disappears the moment the task restarts
  while every previous error stays viewable in a "previous errors" history on the task
  inspector. Applies to both retry (resume-from-failure) and restart-from-step.
- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/orchestration@0.57.6
  - @cat-factory/agents@0.26.9
  - @cat-factory/integrations@0.54.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/prompt-fragments@0.9.41
  - @cat-factory/spend@0.10.71

## 0.66.4

### Patch Changes

- 6347d0e: `GitHubPullRequestMerger` now logs (at warn) when the best-effort delete of a merged work
  branch fails, instead of swallowing it silently. A skipped delete is what strands a
  resumable-but-empty branch that a later re-dispatch then fails to open a PR for — so making
  it observable is the diagnostic hook for that class of stuck run.
- 6439181: mothership: allow-list the bootstrap / reference-architecture / env-config-repair management surface

  In mothership mode the repo-bootstrap flow and the env-config-repair retry/stop path were only
  partially remotely callable over `/internal/persistence`: the board-load reads
  (`bootstrapJobRepository.listByWorkspace`/`listByServices`, `envConfigRepairJobRepository.listByWorkspace`)
  were exposed, but the single-job reads and the write methods the flows drive came back
  `unknown_method`, so a mothership-mode SPA could list bootstrap/repair runs but not start a
  bootstrap, poll a single job's card, retry a failed run, or stop a running one. This completes the
  `AgentRunController` retry/stop surface for those two run kinds (the execution-run branch landed
  earlier) and makes the bootstrap modal + reference-architecture library functional. It widens
  `REMOTE_PERSISTENCE_METHODS`, each with a correct scope rule:

  - `bootstrapJobRepository.get`/`update` — the board-card poll (`GET .../bootstrap/jobs/:id`) and the
    retry/stop patches. Workspace-scoped on arg0 (the `workspace` rule).
  - `bootstrapJobRepository.insert` — the record-based start/retry write. Bound by the `workspaceField`
    rule on the job's `workspaceId` FIELD (the row is stored under — and later read by — that
    workspace). The record's sibling ids (`blockId`, `referenceArchitectureId`) are not re-validated
    over the RPC: a foreign `referenceArchitectureId` is harmless because the retry run re-resolves it
    via the workspace-scoped `referenceArchitectureRepository.get`, which 404s a cross-workspace id.
  - `referenceArchitectureRepository.get`/`listByWorkspace`/`update`/`softDelete` — the reference-arch
    library the bootstrap modal reads + edits and that a retry re-resolves its base repo from.
    Workspace-scoped on arg0; the record-based `insert` binds on the record's `workspaceId` field.
  - `envConfigRepairJobRepository.get`/`update` — the repair retry (reads the prior failed job before
    starting a fresh one) and stop (patches the running job). Workspace-scoped on arg0; `insert` binds
    on the job's `workspaceId` field.

  Each method is member-level (none of the bootstrap / reference-arch / env-config-repair endpoints is
  admin-gated) and workspace-scoped, matching the block/pipeline mutation policy. These are the
  non-core repositories the Node/local facade routes through the `pickRepoSource` seam, which already
  sources them from the full-surface remote registry when `db` is undefined — so this is an allow-list
  change only, symmetric by construction (the dispatcher reflects over each facade's registry).
  Round-trip + cross-account-scope + missing-workspaceId (fail-closed) unit tests for every new method
  are in `packages/server/test/persistenceRpc.spec.ts`; the static drift guard
  (`runtimes/node/test/mothership-allowlist.spec.ts`) moves them out of `pending` — the whole
  `bootstrapJob` (bar the serviceId-keyed `listByService` + the `blockServiceId` helper),
  `referenceArchitecture`, and `envConfigRepairJob` repos are now remote.

## 0.66.3

### Patch Changes

- 6243bea: Scope the "create task from a GitHub issue" picker's already-imported list to the
  target service's repo. The quick-pick list of imported issues was filtered only by
  source and free text, so it leaked in issues from every repo in the workspace even
  though the live search was already repo-scoped. `listTasks` now accepts an optional
  `blockId` that resolves the service's linked repo (via the same `resolveRepoTarget`
  the search uses) and drops GitHub issues from other repos; repo-less sources (Jira,
  Linear) are unaffected. The picker fetches its own repo-scoped list rather than
  reading the shared workspace-wide store.
- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/integrations@0.54.2
  - @cat-factory/agents@0.26.8
  - @cat-factory/kernel@0.69.5
  - @cat-factory/orchestration@0.57.5
  - @cat-factory/prompt-fragments@0.9.40
  - @cat-factory/spend@0.10.70

## 0.66.2

### Patch Changes

- fc8df61: Fix a cross-tenant access hole on the fragment-source routes: `unlink`/`status`/`sync`
  resolved the source by its id alone, so an authenticated member of one account/workspace
  could read, resync or delete another tenant's fragment source by addressing its id under
  their own prefix. `FragmentSourceService.unlink/sync/status` now take the addressed
  `(ownerKind, ownerId)` and 404 when the source belongs to a different owner (breaking
  signature change for direct callers of those three methods).
- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7
  - @cat-factory/orchestration@0.57.4

## 0.66.1

### Patch Changes

- 2a91615: Frontend↔backend ephemeral-stack wiring (slice 6a of the frontend-preview initiative):

  - **Reverse CORS origin injection.** A `deployer` step now passes `inputs.frontendOrigins` — the
    comma-joined browser origins (`http://localhost:<servePort>`) of every `frontend` frame that
    binds the service being provisioned (the reverse of the frontend's `backendBindings`). A
    backend manifest folds it into its CORS allow-list via `{{input.frontendOrigins}}` (HTTP-manifest
    provider) or `{{frontendOrigins}}` (Kubernetes native adapter, flat scope), so an ephemeral
    frontend can reach an ephemeral backend. Derivation is automatic (`frontendOriginsForService`,
    a single workspace block-list read — no N+1); the CORS env-var mapping stays operator-authored,
    and the backend must be re-provisioned to pick up a newly-linked frontend. The served port is
    resolved through the shared `resolveFrontendServePort` (contracts) — the same reserved-port
    sanitization the harness infra spec uses — so a `servePort` set to a reserved in-container port
    (8080/8089) injects the port the app is actually served on (4173), not the raw value.
  - **Binding-resolution correctness.** `resolveFrontendBindings` now dedupes a repeated `envVar`
    deterministically (last non-empty binding wins, matching the injected env map) instead of leaving
    it to insertion order. New `duplicateBindingEnvVars` predicate (contracts) surfaces the collision
    for the inspector + run-start notes (a follow-up slice); it is advisory, not a schema reject
    (bindings persist per-blur with an allowed empty `envVar`).

  Runtime-neutral (all facades). The inspector visibility panel + run-detail projection (6b) and the
  deterministic local preview host port (6c) are tracked follow-ups in
  `docs/initiatives/frontend-preview-ui-testing.md`.

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/orchestration@0.57.3
  - @cat-factory/integrations@0.54.1
  - @cat-factory/agents@0.26.6
  - @cat-factory/kernel@0.69.4
  - @cat-factory/prompt-fragments@0.9.39
  - @cat-factory/spend@0.10.69

## 0.66.0

### Minor Changes

- 67d3876: feat(github): search available repos server-side in the "add service from repo" picker.
  The picker no longer prefetches the entire installation repo list on open (slow for a wide
  App install or PAT with hundreds of repos, and it blocked filtering until the whole list
  loaded). Instead the user types at least 3 characters and the (debounced) query is sent to
  `GET /github/available-repos?q=…`, which returns only the `owner/name` matches. The `q`
  param is optional, so the repo-link management panel's browse-all is unchanged. The now-moot
  manual "refresh list" button is removed (each search hits GitHub live).

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/integrations@0.54.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/kernel@0.69.3
  - @cat-factory/orchestration@0.57.2
  - @cat-factory/prompt-fragments@0.9.38
  - @cat-factory/spend@0.10.68

## 0.65.2

### Patch Changes

- 63cf6de: Performance: batch reads, parallelize independent awaits, and push work into SQL on hot paths.

  - `GET /workspaces/:id` (the board-load endpoint) now fetches its ~15 independent snapshot
    ingredients concurrently instead of serially, so its latency is the slowest read rather
    than the sum of every round-trip; the create-workspace route parallelizes its spend +
    infra-setup reads the same way.
  - Agent-context reference lookups (Jira keys / GitHub refs / URLs) run concurrently on the
    per-step dispatch path; run-start model-default resolutions run concurrently per agent kind.
  - New batched port methods, mirrored on both runtimes with conformance coverage:
    `BlockRepository.findByIds` (cross-workspace dependency resolution — one chunked query
    instead of a point-read per id, also allow-listed for mothership mode),
    `NotificationRepository.escalateStaleOpen` (the escalation sweep is now one
    `UPDATE … RETURNING` statement instead of a load-filter-upsert loop), and
    `GitHubInstallationRepository.listByInstallationIds` (connect-UI annotation).
  - GitHub webhook fan-out resolves linked workspaces via the existing batched
    `linkedWorkspaces` read instead of a per-workspace point-read on every delivery.
  - The Node Drizzle GitHub projections write chunked multi-row upserts (matching the D1
    twins' `db.batch`) instead of one round-trip per row, and their list reads run
    `ORDER BY`/`LIMIT` in SQL (NULLS LAST for D1 parity) instead of sorting full result
    sets in JS.
  - `autoStartDependents` hoists the invariant workspace-pipeline read out of its loop and
    stops re-fetching blocks it already holds.
  - Session/WS-ticket/machine-token verification reuses a memoized `HmacSigner` per secret,
    so `crypto.subtle.importKey` no longer runs on every request (`signerFor` export).
  - The Cloudflare Workflows drivers (execution / bootstrap / env-config-repair) build the
    DI container once per wake instead of once per `step.do` poll tick.

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/orchestration@0.57.1
  - @cat-factory/contracts@0.80.1
  - @cat-factory/integrations@0.53.2
  - @cat-factory/agents@0.26.4
  - @cat-factory/spend@0.10.67
  - @cat-factory/prompt-fragments@0.9.37

## 0.65.1

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/orchestration@0.57.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/integrations@0.53.1
  - @cat-factory/prompt-fragments@0.9.36
  - @cat-factory/spend@0.10.66

## 0.65.0

### Minor Changes

- dcc8b32: Browsable frontend preview — transport dispatch + `PreviewService` + controller + stop (slice 5c of
  the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  Wire the harness `preview` mode (slice 5b) end to end: a `frontend` frame can now be built and
  served on a HOST-reachable URL for a browsable preview, and stopped again. New pieces:

  - A new optional `PreviewTransport` kernel port — the per-runtime half that publishes a served
    app's port to an ephemeral host port and keeps the container alive past the build job. The local
    facade wires the real one over its Docker/Podman/OrbStack/Colima/Apple adapter (a second
    published port read back with `docker port` / the container IP); the Worker never wires it.
  - A runtime-neutral `PreviewService` (start / get / stop) that persists the running preview like an
    ephemeral `environments` row keyed by the `frontend` frame (reusing the existing table + soft-delete
    stop path — no new migration), plus a `PreviewController` mounting
    `GET|POST|DELETE /workspaces/:ws/frames/:frameId/preview`, gated server-side on the
    `frontendPreview.supported` capability (503 on the Worker).
  - The cross-runtime conformance suite drives the full start → serve → stop lifecycle on both Postgres
    runtimes with a fake transport, pinning the ephemeral-env-row persistence parity.

  Notes:

  - `frontendPreview.supported` now tracks whether a preview transport is actually wired: a stock Node
    build (runner pool, no host-port-publish primitive) advertises `false`, so the SPA never offers a
    Start button that would 503; local mode (and any facade injecting a `previewTransport`) advertises
    `true`.
  - Preview rows share the `environments` table but carry a dedicated `preview` discriminator (outside
    `provisionTypeSchema`), so the environment subsystem filters them out of its generic listing +
    block-resolution paths — a preview never leaks into the deployer-env UI or tester env resolution.
  - `PreviewService.get` re-polls a `ready` preview so a vanished/evicted container stops reporting a
    stale, unreachable URL (it flips to `failed`); a healthy preview whose URL merely can't be
    re-derived keeps its authoritative persisted URL.

  Local/node differentiator; the SPA surface (the clickable URL + a stop button on the frame inspector)
  lands in slice 5d. The harness is unchanged (no runner-image bump).

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/orchestration@0.56.0
  - @cat-factory/integrations@0.53.0
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/prompt-fragments@0.9.35
  - @cat-factory/spend@0.10.65

## 0.64.4

### Patch Changes

- Updated dependencies [16ee6cc]
- Updated dependencies [16ee6cc]
  - @cat-factory/orchestration@0.55.1
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/agents@0.26.1
  - @cat-factory/integrations@0.52.2
  - @cat-factory/prompt-fragments@0.9.34
  - @cat-factory/spend@0.10.64

## 0.64.3

### Patch Changes

- 6da6637: mothership: allow-list the shared-service mount management surface

  In mothership mode the org-catalog / shared-service mounting flow (`ServiceMountService` /
  `ServiceMountController` — mount / unmount / re-layout a shared account service onto a workspace
  board) was not fully remotely callable over `/internal/persistence`: the reads that badge the
  catalog (`workspaceMountRepository.listByWorkspace` / `countByServiceIds`) were exposed, but the
  single-service read the mount flow performs and the mount write/update/remove methods came back
  `unknown_method`, so a mothership-mode SPA could display the catalog but not mount from it. This
  widens `REMOTE_PERSISTENCE_METHODS` to the write surface, each with a correct scope rule:

  - `serviceRepository.get(serviceId)` — the single-service read behind `ServiceMountService.mount`
    (the cross-org guard that a service is mounted only within its own account). Bound by a NEW
    `service` scope kind (a single serviceId → owning account, the single-id form of `serviceList`),
    reusing the controller's existing service→account resolver — no controller change. The dispatched
    `get` is routed through the same per-request `listByIds` memo the scope check already reads, so a
    mount precheck resolves the service in ONE query, not two.
  - `workspaceMountRepository` — `get` / `update` / `remove` (arg0 = workspaceId → the `workspace`
    rule) and the record-based `upsert(mount)` (bound by a NEW `serviceMount` scope kind).

  Each is member-level (the mount endpoints are not admin-gated) and workspace-scoped. The cross-org
  mount invariant ("a service can only be mounted within its own organization") is enforced at the
  RPC layer, not only in the bypassed service layer: the `serviceMount` rule binds `upsert` on the
  mount's `workspaceId` FIELD (out-of-scope workspace → refused) AND requires the mounted `serviceId`
  to be owned by the SAME account as that workspace. So a raw `upsert` can never plant a cross-org
  mount — including for a machine token that spans several accounts (a user in multiple orgs, where a
  workspace-only check would let one org's service be mounted onto another org's board). Board
  composition (`blockRepository.listByServices` / `serviceRepository.listByIds`) stays account-scoped
  as a second line of defence. The real-time fan-out reads (`listByService` /
  `listWorkspaceIdsMountingBlock`) and the frame-deletion batch cleanup (`removeByServices`) stay off
  the SPA path. These are core repos, so a mothership-mode node already sources them from the
  full-surface remote registry — no `pickRepoSource` routing change, just the allow-list plus the two
  new scope kinds. Server-only, symmetric by construction (the dispatcher reflects over each facade's
  registry). Round-trip + cross-account-scope tests cover every new method (incl. the `service` kind's
  fail-closed edges and the `serviceMount` rule's cross-org / multi-account denials); the static drift
  guard moves them out of `pending`.

## 0.64.2

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0
  - @cat-factory/orchestration@0.55.0
  - @cat-factory/integrations@0.52.1
  - @cat-factory/prompt-fragments@0.9.33
  - @cat-factory/spend@0.10.63

## 0.64.1

### Patch Changes

- Updated dependencies [08be94c]
  - @cat-factory/orchestration@0.54.1

## 0.64.0

### Minor Changes

- e0aa45e: Self-contained frontend UI-test infra (slice 3 of the frontend-preview + in-context
  UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A `tester-ui` running on a task under a `type: 'frontend'` frame now builds and serves the
  frontend, stands WireMock up for its OTHER backend upstreams, and drives the UI tests against
  the two together — all as localhost processes in the one container (no Docker-in-Docker), so
  it works on Cloudflare and Apple `container` too.

  - **Harness**: a new `frontend` variant of the tester infra spec (`kind: 'frontend'`) that
    installs, builds (injecting the resolved backend URLs at build time, or a `window.env` shim
    for runtime injection), starts WireMock seeded from the frontend repo's mappings dir, serves
    the built app, health-checks it, and points the agent at it. The `ui` image gains pnpm/yarn
    (corepack), a static file server (`serve`), and a headless JRE + WireMock standalone
    (executor-harness image bumped to 1.28.0).
  - **Backend**: `AgentRunContext` carries a resolved `frontend` slice (the frame's
    `frontendConfig` plus its backend bindings resolved to concrete upstreams — a bound service's
    live ephemeral env URL for the service under test, else a WireMock mock). The engine's
    `testerInfraSpec` turns it into the harness spec, and the tester-infra start gate refuses a
    frontend UI test only when it binds a live-backend `service` with none actually live (a
    mock-only / no-backend frontend passes — WireMock + the static server fully stand it up).
    Empty-envVar bindings are filtered.
  - **Hardening** (review follow-ups): the harness's WireMock / serve child processes get an
    `'error'` listener (a spawn failure is captured, not an uncaught crash of the job server),
    WireMock is now health-checked alongside the served app (a dead mock becomes a prompt note,
    not a test-time ECONNREFUSED), reserved env-var names (`PATH`, `NODE_OPTIONS`, …) are dropped
    from the injected build env, and a configured `servePort` that collides with a reserved
    in-container port (8080 harness job server, 8089 WireMock) falls back to the default. The
    inspector's servePort placeholder now shows 4173. Shared `pathExists` / log-capture helpers
    are de-duplicated in the harness. The frontend UI-test gate's batch env read
    (`environmentRegistryRepository.listByWorkspace`) is added to the mothership remote-persistence
    allow-list so the gate resolves in mothership mode.
  - **Hardening (second review round)**: the frontend stand-up now feeds the run's inactivity
    watchdog with a heartbeat while it installs/builds/serves — a real frontend's `install` +
    `build` can exceed the 10-min inactivity window, and the (activity-silent) stand-up would
    otherwise be killed mid-build with a misleading "likely hung". `serveMode: 'command'` now also
    forwards the resolved backend URLs (`env`) to the serve process, so a runtime-reading
    dev/preview server sees them (previously only `PORT` was passed). Reserved env-var names are
    now also dropped in the backend infra-spec builder (defence in depth, not just the harness).
    The `mockMappingsPath` docs + inspector hint clarify WireMock's `--root-dir` layout (stubs go
    in a `mappings/` subfolder), and the env-injection hint notes the build-tool prefix caveat
    (e.g. Vite only exposes `VITE_*`). The UI-tester prompt flags a live-backend CORS failure as an
    infra gap rather than an app defect.
  - **Hardening (third review round)**: the frontend stand-up now runs in the run's SERVICE
    SUBTREE (`workDir`), not the clone root — a monorepo frontend's `package.json` / `outputDir` /
    `mocks/` live under its own subdirectory, so installing, building, serving and seeding WireMock
    from the repo root would have targeted the wrong directory (the docker-compose stand-up still
    runs at the root, where its repo-relative `composePath` resolves). The harness now bounds
    frontend `servePort` / `wiremockPort` to 1..65535 at its untrusted-body boundary (an
    out-of-range port can never bind, so it falls back to the default). The reserved-env filter —
    in BOTH the harness parse and the backend infra-spec builder — grows the `NODE_EXTRA_CA_CERTS`
    / `BASH_ENV` / `ENV` / `SHELL` / `IFS` names plus the `npm_config_*` and `GIT_*` FAMILIES, so a
    binding that reconfigures the package manager, git, or the TLS trust store during the build is
    dropped rather than injected. Runtime env injection under `serveMode: 'command'` now warns
    (the `window.env` shim is only served in static mode; the forwarded `env` covers the command
    server), and a failed shim write is logged instead of silently swallowed. `AgentContextBuilder`
    gains `resolveServiceFrame` so the frontend-config resolution reuses the frame row the walk
    already loaded instead of re-fetching it. Fixes the `Lint & format` failure (an unnecessary
    `?? {}` empty-fallback spread in the serve env).
  - **Hardening (fourth review round)**: the reserved-env family filter (`npm_config_*` / `GIT_*`)
    now matches **case-insensitively** in BOTH the harness parse and the backend infra-spec builder —
    npm reads its config env with a case-insensitive `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY`
    (upper/mixed case) is honoured just like `npm_config_registry`; a case-sensitive prefix match
    would have let the upper-cased form slip through and reconfigure the package manager during the
    build. The frontend serve/WireMock health-check now also aborts an in-flight probe on the run's
    own abort signal (not just the per-attempt timeout). The stale `envInjectionHint` translation is
    synced across all locales, and the missed-translation class is now guarded in CI (see the app
    note). The agent prompt-note assembly and the frontend `installCommand` are extracted as pure
    helpers with unit coverage.

  `@cat-factory/app`: sync the `envInjectionHint` hint across all locales (the `en` update noting
  the build-tool prefix caveat, e.g. Vite only exposes `VITE_*`, had been left untranslated). A new
  CI **locale-parity guard** now fails a PR that changes an `en.json` message key without changing
  the same key in every other locale, so translations can't silently go stale.

  BREAKING (pre-1.0): the harness `AgentInfraSpec` is now a discriminated union
  (`service` | `frontend`); the default backend-service tester shape is unchanged.

- f21279e: Warn when required infrastructure is undefined. The workspace snapshot now carries an
  `infraSetup` projection (computed server-side in `WorkspaceController` from whatever the
  deployment actually wired) that tracks three areas explicitly as `not_defined` /
  `configured` / `not_applicable`:

  - **Ephemeral environments** (all runtimes that wire the environments integration) —
    `not_defined` when no environment provider connection is registered, so testing agents
    that need a live environment can't run.
  - **Agent executor** (stock/remote Node only — Cloudflare has built-in per-run containers, and
    local mode runs agents in per-run HOST containers) — `not_defined` when no self-hosted runner
    pool is registered, so NO container agents can run. This area fires only where the pool is the
    SOLE executor (the new `agentExecutorRequiresRunnerPool` container flag, set by the Node facade
    when it uses the default pool transport); Cloudflare and local both wire the runner surface but
    keep a built-in executor, so the pool is optional there and the area is `not_applicable` — a bare
    `!!container.runners` check would otherwise falsely nag on every local deployment.
  - **Binary storage** (remote Node only — Cloudflare binds R2, local defaults to a filesystem
    store) — `not_defined` when the account selected no content-storage backend, so UI
    screenshots / reference images have nowhere to live.

  The SPA surfaces each `not_defined` area as a loud, per-area setup banner with a deep-link
  into the relevant configuration. Dismissing a banner asks whether to hide it just for this
  session (re-nags next load) or permanently — "I'm OK with the limitations, don't notify me
  again" — the latter persisted per-user in localStorage.

  The advisory top-of-board banners (AI-readiness, provider-config, infra-setup) now render in a
  single shared, click-through column so concurrent prompts on a fresh deployment stack vertically
  instead of drawing on top of each other. The `RunnerPoolConnectionService` and
  `EnvironmentConnectionService` gain a `hasConnection` presence probe (no secret decrypt) that the
  projection uses on the hot board-load path.

  Each area probe is additionally bounded by a timeout and its swallowed faults are logged, so a slow
  or misconfigured backend read degrades that area to `not_applicable` (advisory-only, never 500s or
  stalls the board load) while staying diagnosable. The banner's permanent-dismissal `localStorage`
  key + the infra-setup area list are exported from `@cat-factory/contracts`
  (`INFRA_SETUP_DISMISSED_STORAGE_KEY` / `INFRA_SETUP_AREAS`) so the SPA and the e2e seed share one
  source of truth, and the stacked banner cards announce through a single polite live region instead
  of one assertive alert each.

- 6c51e31: Run inline LLM steps through the ambient Claude Code / Codex CLI in local mode, and refuse to
  start a pipeline whose model preset can't satisfy every step.

  - **Local inline harness execution**: with native agents enabled (`LOCAL_NATIVE_AGENTS`), the
    inline steps (requirements reviewer, brainstorm, task-estimator, inline document kinds) now run
    on the developer's ambient `claude`/`codex` subscription CLI as a host subprocess — the inline
    analogue of the existing container ambient-auth path. Previously a subscription-only preset
    (e.g. Claude Opus) degraded these inline steps to the routing default and failed against an
    unconfigured provider (the confusing "requirements reviewer (qwen:qwen3-max) failed" error).
    Implemented via a new AI-SDK `CliInlineLanguageModel` (`@cat-factory/agents`) wired into the
    local model provider; `inlineModelRef` now keeps an ambient-eligible harness ref instead of
    degrading it. The consensus executor (an inline path) threads the same predicate, so a
    subscription-only consensus participant model is kept inline in local mode too.
  - **Preset satisfiability guard**: the pipeline-start guard now checks INLINE steps against
    inline-usability, not just container-usability. A subscription-only model that satisfies the
    container agents but can't run the inline reviewers (and this deployment has no inline harness)
    is refused up front with a new `preset_unsatisfiable` conflict reason and an actionable message,
    instead of failing mid-run. The SPA maps the new reason to a translated toast.

  Breaking: `inlineModelRef` gains an optional third `opts` argument; the `ConflictReason` wire
  union gains `preset_unsatisfiable`.

### Patch Changes

- 9e93fe8: feat(frontend): `frontendPreview` infrastructure capability + preview-toggle gate (slice 5a of the
  frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A browsable frontend preview keeps a built app served on a host-reachable URL, which needs a
  long-lived host serve — so it is a genuine local/node differentiator. The Worker only runs the
  self-contained UI-test container (built, tested, and torn down with the run), so it cannot host one.
  Until now the `frontendConfig.previewEnabled` toggle (shipped as scaffolding in slice 2) was offered
  on every runtime and read by nothing.

  This lands the capability that makes the toggle honest, and gates it in the SPA where a preview can't
  run. The long-lived build+serve-kept-alive mechanic itself is the remaining slice 5b.

  - **New capability axis** on the `/auth/config` `infrastructureCapabilities` descriptor:
    `frontendPreview: { supported: boolean }`, built by the shared `buildInfrastructureCapabilities`
    so all three facades emit the same shape. Value is a per-facade differentiator — Worker `false`,
    Node + local `true`.
  - **SPA gate**: `FrontendConfig.vue` reads `infrastructure.frontendPreview.supported` (defaulting
    true until the auth handshake resolves) and disables the `previewEnabled` checkbox with an
    explanatory hint (`inspector.frontendConfig.previewUnsupported`, translated across every locale)
    when unsupported. The stored config is left untouched, so a `previewEnabled` flag authored on
    local/node is simply inert when served from the Worker (no migration; pre-1.0 breakage rules).
  - **Conformance** pins that the axis is present + boolean on every facade (its value is a
    differentiator); the Worker `auth.spec` pins `false`, the Node `auth-gate.spec` pins `true`.

- 456a992: mothership: allow-list the advanced review / structured-dialogue session surface

  In mothership mode the clarity-review (bug-report triage), brainstorm (structured dialogue) and
  consensus (multi-strategy orchestration) session repositories were not fully remotely callable over
  `/internal/persistence`, so a mothership-mode SPA could run/re-read the board-load view of a review
  but could not persist or replace one as its window iterates (the write/delete methods came back
  `unknown_method`). This widens `REMOTE_PERSISTENCE_METHODS` to their full read+write surface,
  mirroring the requirements-review surface already exposed — member-level and workspace-scoped (none
  of the review endpoints is admin-gated):

  - `clarityReviewRepository` — `get` / `upsert` / `deleteByBlock` (`getByBlock` was already exposed).
  - `brainstormSessionRepository` — `get` / `upsert` / `deleteByBlockStage` (`getByBlockStage` was
    already exposed).
  - `consensusSessionRepository` — `get` / `getByStep` / `getByBlock` / `upsert` (new repo entry).
  - `requirementReviewRepository` — `deleteByBlock`, the pre-review-run drop that completes the repo.

  Every method takes the workspaceId as arg0 (the `upsert(workspaceId, review)` signature carries it
  positionally, so the existing `workspace` rule binds it — resolve the owning account, reject
  out-of-scope as 404). These are core repos, so a mothership-mode node already sources them from the
  full-surface remote registry — no `pickRepoSource` routing change, just the allow-list. Server-only,
  symmetric by construction (the dispatcher reflects over each facade's registry). Round-trip +
  cross-account-scope tests cover every new method; the static drift guard moves them out of `pending`.

- 1d2684f: mothership: allow-list the post-release-health / observability settings surface

  In mothership mode the observability connection, per-block release-health config, and
  incident-enrichment connection repositories were not remotely callable over
  `/internal/persistence`, so a mothership-mode SPA could not manage the post-release-health
  flow's settings panels (every call came back `unknown_method`). This widens
  `REMOTE_PERSISTENCE_METHODS` to their full management surface, member-level and workspace-scoped
  (the controllers mount under `/workspaces/:workspaceId`, none is admin-gated) — matching the
  settings-panel policy already exposed:

  - `observabilityConnectionRepository` / `incidentEnrichmentConnectionRepository` — `get` +
    `delete` via the `workspace` rule (arg0 = workspaceId), `upsert(record)` via a new
    `workspaceField` scope rule.
  - `releaseHealthConfigRepository` — `getByBlock` / `listByWorkspace` / `delete` via `workspace`,
    `upsert(record)` via `workspaceField`.

  The new `workspaceField` scope rule binds a call whose workspaceId is a FIELD of the record arg
  (not a positional arg): the write targets exactly `record.workspaceId`, so binding on it means a
  record can only be persisted into an in-scope workspace; a missing/non-string field or an
  out-of-scope workspace is refused as 404. Server-only allow-list change, symmetric by construction
  (the dispatcher reflects over each facade's registry). Round-trip + cross-account-scope tests cover
  every new method; the static drift guard moves them out of `pending`.

  Scope: this makes the settings PANELS functional end-to-end (persist + read back the redacted
  summary). It does NOT yet make a saved observability connection drive a post-release-health gate
  probe in mothership mode — decrypting the sealed connection cipher at gate-probe time is the later
  secrets-delegation slice.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [ab7d589]
- Updated dependencies [6c51e31]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/integrations@0.52.0
  - @cat-factory/orchestration@0.54.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/prompt-fragments@0.9.32
  - @cat-factory/spend@0.10.62

## 0.63.3

### Patch Changes

- 3135ae8: Make GitLab a first-class auth identity on the hosted (Cloudflare Worker + Node) path.

  **Wire hosted PAT sign-in into the Cloudflare Worker.** The Worker now registers the PAT-login
  identity registry (`vcsIdentity`) like the Node facade — GitHub always, GitLab when a GitLab
  connection is configured (`GITLAB_TOKEN` / `config.gitlab.enabled`) — so a user can sign in by
  pasting their own GitHub **or** GitLab PAT at `/auth/pat`. Previously the Worker wired none,
  leaving it OAuth-only; since GitLab has no OAuth browser flow, a GitLab user had no way to sign
  in to a Worker deployment at all, even though its engine already gated CI and merged on GitLab.
  `/auth/config` now advertises `patLogin.providers` accordingly, so the SPA renders the PAT form.

  **Implement `GitLabIdentityResolver.resolveOrgs`.** A hosted deployment admits a pasted PAT only
  when the account's login, an org/group it belongs to, or its email domain is allowlisted. Only
  `GitHubIdentityResolver` implemented `resolveOrgs`, so `isPatIdentityAllowed`'s org branch was
  skipped for GitLab — a GitLab account could be a primary identity via `AUTH_ALLOWED_LOGINS` or
  `AUTH_ALLOWED_EMAIL_DOMAINS`, but never `AUTH_ALLOWED_ORGS`. The resolver now enumerates the
  user's GitLab **group** memberships (`GET /groups?min_access_level=10`, lowercased full paths, so
  only groups the user actually belongs to admit), bringing group-based admission to parity with
  GitHub org admission.

  **Bound and diagnose PAT-login org/group admission.** Both `resolveOrgs` implementations
  (GitHub `/user/orgs`, GitLab `/groups`) now follow `Link: rel="next"` pagination up to a ~1000-entry
  cap (and `logger.warn` on truncation, wired from each facade — Node included), so a user whose only
  allowlisted org/group sat past the first 100 is no longer wrongly denied. When org enumeration fails
  because a token can authenticate `/user` but lacks the broader org/group-read scope
  (`read:org` / `read_api`), the `/auth/pat` 403 now hints at the missing scope instead of a flat
  "not allowed", and a hosted deployment's missing-token prompt tells the user to paste their PAT
  rather than to set an env var they don't control.

  Comment-only touches to `@cat-factory/server`'s `AuthController`, the kernel `VcsIdentityRegistry`
  doc, and the SPA login screen to correct the now-stale "hosted facades are OAuth-only" notes.

## 0.63.2

### Patch Changes

- 39534d6: Mothership mode: allow-list `agentRunRepository.getRef`, so the board's run controls (retry /
  stop a failed or running run) are functional for execution runs in a no-Postgres mothership-mode
  local node.

  Wiring fix (both facades): `agentRunRepository` is the one repo surfaced on the container OUTSIDE
  `CoreDependencies`, so the mothership `repositories` registry (`ServerContainer.repositories`,
  reflected by `/internal/persistence`) was built from `dependencies` alone and did not carry it —
  a remote `getRef` call came back `Repository 'agentRunRepository.getRef' is not wired`. Both
  `buildNodeContainer` and the Cloudflare `buildContainer` now fold it into the registry explicitly,
  so either facade acting as a mothership serves the retry/stop `getRef` read.

  `AgentRunController` (`POST /workspaces/:ws/agent-runs/:id/{retry,stop}`) resolves a run's KIND via
  `agentRunRepository.getRef(workspaceId, id)` before dispatching to the matching service. That read
  was the last thing on the execution-run retry/stop path still coming back `unknown_method` over
  `/internal/persistence`. It is now allow-listed, workspace-scoped on arg0 (reusing the existing
  `workspace` rule — resolve the owning account, reject out-of-scope as 404). Every downstream
  read+write the execution retry/stop services make (`executionRepository.get`/`deleteByBlock`/
  `upsert`/`markFailed`, `blockRepository.update`, `pipelineRepository.get`, the budget/binary-storage
  prechecks) was already exposed on the run/start path, so `getRef` is the only new entry.

  The bootstrap + env-config-repair retry BRANCHES read their own repos (`bootstrapJobRepository.get`,
  `referenceArchitectureRepository.get`, …) and stay `pending` — a later slice. The sweeper-only
  `agentRunRepository.listStale`/`liveRunIds` stay mothership-internal.

  Server-only allow-list change, symmetric by construction (the dispatcher reflects over each facade's
  registry). Round-trip + cross-account-scope + off-allow-list unit tests cover it; the static
  allow-list drift guard moves `getRef` out of `pending`; and the fake-mothership integration test
  asserts the retry endpoint resolves a run's kind over the real RPC and 404s an unknown run id.

## 0.63.1

### Patch Changes

- eab2b60: Mothership mode: allow-list the workspace-scoped settings / preset / recurring-schedule
  management WRITE methods, so the settings panels are functional (not read-only) in a
  no-Postgres mothership-mode local node.

  Previously only the board-load READS of these repositories were remotely callable over
  `/internal/persistence`, so a mothership-mode SPA could display settings but not save them
  (every write came back `unknown_method`). Newly allow-listed — each takes the workspaceId as
  arg0, reusing the existing `workspace` scope rule, and each is member-level (none is
  admin-gated), matching the block/pipeline mutation policy already exposed:

  - `workspaceSettingsRepository.upsert`, `trackerSettingsRepository.put`,
    `serviceFragmentDefaultsRepository.set` — the workspace settings panels' saves.
  - `mergePresetRepository` / `modelPresetRepository` `get` + `remove` — completing both
    preset libraries' CRUD (`list`/`getDefault`/`upsert` were already exposed).
  - `pipelineScheduleRepository` `get`/`upsert`/`remove`/`insertRun`/`updateRun`/`listRuns` —
    the recurring-pipeline management surface (`RecurringPipelineService` CRUD + `runNow`,
    which fires in-process). The sweeper-only `listDue`/`pruneRunsBefore` and the serviceId-keyed
    `listByService` stay mothership-internal.

  Server-only allow-list change, symmetric by construction (the dispatcher reflects over each
  facade's registry). Round-trip + cross-account-scope tests cover every new method; the static
  allow-list drift guard moves them out of `pending`.

## 0.63.0

### Minor Changes

- 762fe66: Add a first-class `frontend`-frame configuration. A frontend frame now carries a
  `frontendConfig` (package manager, install/build/serve knobs, WireMock mappings path,
  preview toggle) plus `backendBindings` that map each env var the frontend reads to an
  upstream: a bound service frame's ephemeral environment, or a WireMock stub. The bindings
  double as board links, drawn as frontend→service edges on the canvas. New inspector panel
  (`FrontendConfig.vue`), the `frontend_config` JSON column mirrored across D1 and Drizzle
  with a cross-runtime conformance round-trip, and `frontendConfig` on the update-block input.

  Second slice of the frontend-preview + in-context UI-testing initiative
  (docs/initiatives/frontend-preview-ui-testing.md).

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/integrations@0.51.4
  - @cat-factory/kernel@0.66.1
  - @cat-factory/orchestration@0.53.2
  - @cat-factory/prompt-fragments@0.9.31
  - @cat-factory/spend@0.10.61

## 0.62.3

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/orchestration@0.53.1
  - @cat-factory/agents@0.24.15
  - @cat-factory/integrations@0.51.3
  - @cat-factory/spend@0.10.60
  - @cat-factory/prompt-fragments@0.9.30

## 0.62.2

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/orchestration@0.53.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/integrations@0.51.2
  - @cat-factory/prompt-fragments@0.9.29
  - @cat-factory/spend@0.10.59

## 0.62.1

### Patch Changes

- d4d4cbc: Make credential-decryption failures actionable and isolate them.

  Previously, a stored secret sealed under a rotated/regenerated `ENCRYPTION_KEY` surfaced as
  the opaque Web Crypto `OperationError` ("The operation failed for an operation-specific
  reason") with no context — e.g. an inline requirements-review run failed at step 0 with that
  bare message and no detail, because the reviewer leases + decrypts the workspace's provider
  API keys before any LLM call (outside its own error-wrapping).

  - `WebCryptoSecretCipher.decrypt` now rethrows an actionable error on an AES-GCM auth failure,
    naming `ENCRYPTION_KEY` and the likely key-rotation cause, preserving the original as `cause`.
  - `ApiKeyService.lease` wraps a decrypt failure with the offending provider + key id.
  - `createScopedModelProviderResolver.forScope` no longer lets ONE provider's undecryptable key
    sink the whole scoped provider: it registers a deferred-failure resolver for that provider, so
    calls targeting a different, healthy provider still resolve and only a call that actually needs
    the broken provider fails (with the real cause).

- Updated dependencies [d4d4cbc]
  - @cat-factory/integrations@0.51.1
  - @cat-factory/orchestration@0.52.1

## 0.62.0

### Minor Changes

- 3643708: Custom manifest types can now declare an optional `defaultManifestPath` and `fixerPrompt`.
  A `custom` service prefills its manifest path from the type's default on selection, and
  "Detect from repo" resolves the path monorepo-aware (keep an accurate current value; else
  the exact default within the service subtree/repo root; else, for a bare filename, one level
  deep; else pre-fill the default location). A new **Generate / fix manifest** button (shown
  only when the type defines a `fixerPrompt`) dispatches the fixer coding agent — reusing the
  durable `env-config-repair` run — to create the manifest at the entered path or fix it when
  invalid, after best-effort `validateRepo`. Adds the `default_manifest_path` / `fixer_prompt`
  columns to `custom_manifest_types` on both runtimes (D1 + Drizzle).

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/integrations@0.51.0
  - @cat-factory/orchestration@0.52.0
  - @cat-factory/agents@0.24.13
  - @cat-factory/prompt-fragments@0.9.28
  - @cat-factory/spend@0.10.58

## 0.61.0

### Minor Changes

- 70e321b: Mothership mode: mint the machine token from a whitelisted login and cache it locally, so
  `LOCAL_MOTHERSHIP_TOKEN` is now a headless/CI override instead of a hard requirement.

  A mothership (either facade) serves `POST /auth/machine-token`, which exchanges the caller's
  mothership SESSION for a `machine`-audience token scoped to the user's accounts (derived from
  `accountService.listForUser`; a `requestedAccountIds` hint may only NARROW that set, never widen
  it). The single production mint helper `mintMachineToken` (`@cat-factory/server`) replaces the
  hand-rolled test copy.

  The local facade adds a `node:sqlite` machine-token cache and a local-only
  `POST /local/mothership/connect` proxy: the SPA signs the user into the mothership (OAuth),
  captures the returned session from the redirect fragment, and hands it to its own node, which
  exchanges it for the opaque machine token (cached locally), mints a LOCAL session for the same
  user, and returns it so the SPA is signed in. `composeMothership` now resolves the token per
  request (env override → unexpired cached token → none), so a token-less node boots inert and the
  SPA can drive the login rather than the boot throwing. The login screen gains a "Sign in via
  mothership" affordance behind `localMode.mothership` (i18n across all locales).

  A mothership now honours a post-login `redirect` back to a loopback host (`localhost`,
  `127.0.0.0/8`, `::1`) in `pickPostLoginRedirect`, so the "Sign in via mothership" round-trip lands
  back on the local node without an operator allowlisting every dev port (a redirect to the caller's
  own machine is not a token-exfiltration vector). A failed connect exchange now surfaces an error on
  the login screen instead of silently returning to the sign-in button, and each connect lets the
  mothership assign the node id (a reconnect as a different user never inherits the previous user's
  id).

  Config: `AUTH_MACHINE_TOKEN_TTL_MS` (default 30 days) sets the machine-token lifetime on both
  facades.

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/agents@0.24.12
  - @cat-factory/integrations@0.50.2
  - @cat-factory/kernel@0.63.4
  - @cat-factory/orchestration@0.51.7
  - @cat-factory/prompt-fragments@0.9.27
  - @cat-factory/spend@0.10.57

## 0.60.3

### Patch Changes

- 37c488f: Internal refactor of mothership-mode code (no behaviour change): share one `node:sqlite` open
  helper between the local credential store and work queue, make `statusForPersistenceError` a
  lookup table, inline the trivial mothership db-path wrappers, bind `pickRepoSource` through a
  local `sourced` helper (collapsing the repeated `remoteRepos`/`db` wiring, including the five
  GitHub projection repos) in the Node container, and centralize the mothership-vs-Postgres
  persistence decision in the local container behind a single `resolveLocalPersistence` helper.

## 0.60.2

### Patch Changes

- Updated dependencies [b744822]
- Updated dependencies [c40736e]
  - @cat-factory/integrations@0.50.1
  - @cat-factory/orchestration@0.51.6

## 0.60.1

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/integrations@0.50.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/kernel@0.63.3
  - @cat-factory/orchestration@0.51.5
  - @cat-factory/prompt-fragments@0.9.26
  - @cat-factory/spend@0.10.56

## 0.60.0

### Minor Changes

- 91f876b: Mothership-mode tech-debt cleanup (functionality-preserving): rename the persistence
  allow-list export `PILOT_PERSISTENCE_METHODS` → `REMOTE_PERSISTENCE_METHODS` (it is the
  functional surface, no longer a pilot) and drop the unused `accountField` `ScopeRule` kind
  that was defined but never allow-listed or exercised. Also refresh stale comments/docs that
  predated the Phase-3 merge gate (which is now MET): the `MothershipComposition.repos` JSDoc,
  the `buildNodeContainer` `db: undefined` service-matrix note, and the mothership-mode tracker
  banner. No runtime behavior change.

### Patch Changes

- Updated dependencies [79a0f48]
  - @cat-factory/integrations@0.49.0
  - @cat-factory/orchestration@0.51.4

## 0.59.2

### Patch Changes

- 2e1354f: Improve the Kubernetes per-type engine configurator:

  - **k3s feedback** — picking the `local-k3s` engine now prefills the engine form's loopback
    defaults (API server `https://127.0.0.1:6443`, label, skip-TLS) and shows a hint banner that
    explains the prefill and how to mint a ServiceAccount token, instead of leaving the form
    unchanged. Switching back to `remote-kubernetes` clears those local-only defaults. k3s/k3d/kind
    share the same loopback defaults, so they remain one preset rather than separate options.
  - **Test connection** — the Kubernetes engine form (workspace + per-user override) gains a working
    "Test connection" button. A new `POST /workspaces/:ws/environments/handlers/test` endpoint lowers
    the engine config to a backend config and reaches the apiserver with the supplied token (nothing
    persisted), reusing the existing connection-probe path. Reported as `{ ok, message }`.

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/integrations@0.48.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/orchestration@0.51.3
  - @cat-factory/prompt-fragments@0.9.25
  - @cat-factory/spend@0.10.55

## 0.59.1

### Patch Changes

- Updated dependencies [66a8c71]
  - @cat-factory/integrations@0.48.1
  - @cat-factory/orchestration@0.51.2

## 0.59.0

### Minor Changes

- b4c7e60: Provisioning auto-detection now prioritizes the option matching the user's selected
  provision-type tab.

  The "Detect from repo" affordance sends the currently-selected tab (`kubernetes` vs
  `docker-compose`) as a new optional `prefer` field on `POST /environments/detect-provisioning`.
  The detector honors it: on the `docker-compose` tab a compose file wins when present (even if
  Kubernetes manifests also exist, surfaced as a low-confidence "switch to kubernetes" hint),
  falling back to the other kind when the preferred one isn't found. With no preference (or any
  non-compose tab) it keeps the historical kubernetes-first order, so existing behavior is
  unchanged unless a caller opts in.

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/integrations@0.48.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/kernel@0.63.1
  - @cat-factory/orchestration@0.51.1
  - @cat-factory/prompt-fragments@0.9.24
  - @cat-factory/spend@0.10.54

## 0.58.0

### Minor Changes

- f568a8c: Add a built-in "Manual review only" merge-threshold preset and reseeding for the
  merge-preset catalog (mirroring pipelines).

  - "Manual review only" sets a new `autoMergeEnabled: false` flag, so the `merger` step
    never auto-merges a task using it — every PR is routed to a human `merge_review`
    notification regardless of the assessment scores. The flag is editable on any preset via
    a toggle in the Merge thresholds settings.
  - Built-in merge presets now carry a stable id (`mp_balanced`, `mp_manual_review`) and a
    monotonic `version`. The workspace snapshot ships `mergePresetCatalogVersions`, and the
    SPA surfaces a once-per-session startup advisory when a built-in preset is outdated or a
    new built-in appeared upstream, offering a one-click reseed
    (`POST /workspaces/:ws/merge-presets/:id/reseed`).

  Breaking (pre-1.0, no migration): `merge_threshold_presets` gains `auto_merge_enabled`
  (default on) and `version` columns (D1 + Drizzle). First read of a workspace's presets now
  seeds the whole built-in catalog (Balanced + Manual review only), not just the default.

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/orchestration@0.51.0
  - @cat-factory/agents@0.24.8
  - @cat-factory/integrations@0.47.1
  - @cat-factory/spend@0.10.53
  - @cat-factory/prompt-fragments@0.9.23

## 0.57.0

### Minor Changes

- 41203db: Per-service provision types (slice 11): auto-detect a recommended Kubernetes provisioning
  config from a service's repo.

  A deterministic, pure-TS heuristic detector reads a service's repo checkout-free over the
  `RepoFiles` port and proposes a NON-BINDING recommended provisioning config. High-confidence
  facts are inferred deterministically (renderer from a `kustomization.yaml`; the URL source from
  the manifest kinds — `Ingress`/`Gateway`/`HTTPRoute`/`LoadBalancer Service`; a pinned namespace;
  `generatorEnvFile` secret injections with keys read from a `.env.example`; image overrides
  defaulting the tag to `{{branch}}`); ambiguous ones (which `overlays/*` is the ephemeral one,
  helm releases from a `helmfile.yaml`/`Chart.yaml`) are surfaced as candidates with a hint
  rather than guessed. The user always confirms/edits — nothing is applied silently.

  - Contracts: `provisioningRecommendationSchema` + `detectServiceProvisioningSchema` +
    `detectServiceProvisioningContract` (`POST /workspaces/:ws/environments/detect-provisioning`).
  - `EnvironmentConnectionService.detectServiceProvisioning` runs the detector over the
    workspace-bound `RepoFiles`; new `provision-detect.logic.ts` with unit tests.
  - Frontend: a "Detect from repo" affordance in the service inspector's test-infra section that
    prefills `block.provisioning` + surfaces the per-field confidence notes, overlay candidates,
    and engine-level URL/namespace suggestions; new i18n keys across all 8 locales.

  No migration (detection is pure repo introspection — nothing persisted).

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/integrations@0.47.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/kernel@0.62.4
  - @cat-factory/orchestration@0.50.1
  - @cat-factory/prompt-fragments@0.9.22
  - @cat-factory/spend@0.10.52

## 0.56.1

### Patch Changes

- 3ec9c90: Widen the mothership-mode persistence allow-list (`PILOT_PERSISTENCE_METHODS`) to cover the
  org/durable repository methods the run lifecycle exercises — merge-preset `getDefault`, service
  `getByFrameBlock`, notification/requirement-review `get`, requirement-review `upsert`, kaizen
  grade `getByStep`/`upsert`, the kaizen run-path LLM-metric summary, and the env-config-repair +
  kaizen-combo run-path reads — each bound by a scope rule (admin-gated and sweeper methods stay
  mothership-internal). This is what makes a no-Postgres mothership-mode node drive a full run
  to a persisted terminal state over the remote RPC.

  Adds a cross-runtime `[mothership]` conformance configuration (the shared suite's execution
  group run against a real in-process Node mothership) and a static allow-list completeness guard,
  so a new Drizzle repository or method that isn't proxied — or is mis-scoped — fails a test
  instead of a developer's first board load.

## 0.56.0

### Minor Changes

- cb9e2e3: Per-service provision types (Phase 2, slice 10): facade wiring for the async, container-backed
  Kubernetes deploy lifecycle + the local-mode native-CLI deploy transport. A `deployer` step whose
  manifests need rendering (kustomize/helm/Gateway-API) now stands its environment up in a real
  deploy container (or, locally, the host CLIs) on every runtime — slice 9's `deployJobClient` /
  `resolveDeployCloneTarget` seams are no longer unwired. The synchronous raw-manifest REST path is
  unchanged.

  - **Cloudflare Worker**: a new `DeployContainer` Durable Object (per-run, the separate
    deploy-harness image — `kubectl`/`kustomize`/`helm`) bound as `DEPLOY_CONTAINER`, with its
    `[[containers]]` block + binding + a `v4` migration in both wranglers and the class exported from
    the worker entry. The `image: 'deploy'` dispatch routes here while agent jobs stay on
    `ExecutionContainer`. `selectDeployDeps` wires a deploy-dedicated `RunnerJobClient` (over the
    deploy namespace) + `resolveDeployCloneTarget` when the binding + GitHub App are present.
  - **Node**: wires the default pool-backed `deployJobClient` (`new RunnerJobClient(resolveTransport)`)
    - a `resolveDeployCloneTarget` built from the App token mint, both overridable by a sibling facade.
      The self-hosted runner pool now forwards the `image` dispatch option (the generic
      `RunnerPoolTransport` + `HttpRunnerPoolProvider` expose it as a first-class `{{input.image}}`
      variable, and the native Kubernetes runner config gains an `imageDeploy` variant) so a pool pulls
      the deploy-harness image for `image: 'deploy'`.
  - **Local**: a new `NativeCliDeployTransport` (`LOCAL_DEPLOY_RUNTIME=native|container`). `native`
    (default) runs the deploy harness as a host process driving the developer's own
    `kubectl`/`kustomize`/`helm`; `container` runs the deploy image per job, keyed by its own job id so
    it never collides with the run's agent container. The clone target is inherited from Node's default
    (PAT mint + GitLab-aware origin).
  - **Shared**: `@cat-factory/server` exports `makeResolveDeployCloneTarget` (compose a deploy clone
    resolver from a repo-target walk + token mint, with a per-facade clone-URL override).
  - **Conformance**: the cross-runtime suite drives the engine's async render path on every facade —
    it forwards the provider's `deploy` kind + `image: 'deploy'` option through the wired client, polls
    a stubbed view, and finalizes — asserting the finalized record round-trips through each facade's
    real registry repo to an identical `ProvisionedEnvironment` on D1 and Postgres. (The per-facade
    transport selection is out of this runtime-neutral suite's scope; only local's selection has a
    dedicated unit test today.)

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/integrations@0.46.0
  - @cat-factory/orchestration@0.50.0
  - @cat-factory/agents@0.24.6
  - @cat-factory/kernel@0.62.3
  - @cat-factory/prompt-fragments@0.9.21
  - @cat-factory/spend@0.10.51

## 0.55.2

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/integrations@0.45.0
  - @cat-factory/orchestration@0.49.0
  - @cat-factory/agents@0.24.5
  - @cat-factory/kernel@0.62.2
  - @cat-factory/prompt-fragments@0.9.20
  - @cat-factory/spend@0.10.50

## 0.55.1

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/orchestration@0.48.2
  - @cat-factory/agents@0.24.4
  - @cat-factory/integrations@0.44.1
  - @cat-factory/kernel@0.62.1
  - @cat-factory/prompt-fragments@0.9.19
  - @cat-factory/spend@0.10.49

## 0.55.0

### Minor Changes

- f9678df: Mothership mode (Phase 3 slice 1): widen the persistence-RPC allow-list to the workspace-scoped
  board-load read surface. `PILOT_PERSISTENCE_METHODS` now exposes the reads a `GET /workspaces/:id`
  snapshot assembles — `workspaceMountRepository.listByWorkspace`, `workspaceSettingsRepository.get`,
  `mergePresetRepository.list`, `modelPresetRepository.list`, `serviceFragmentDefaultsRepository.get`,
  `pipelineScheduleRepository.list`/`getByBlock`, `trackerSettingsRepository.get`,
  `notificationRepository.listOpen`, `bootstrapJobRepository.listByWorkspace`,
  `tokenUsageRepository.totalsSinceForWorkspace`, and the per-block reviews
  (`requirementReviewRepository.getByBlock`, `clarityReviewRepository.getByBlock`,
  `brainstormSessionRepository.getByBlockStage`).

  Every newly-listed method takes the workspaceId as arg0, so they reuse the existing `workspace`
  scope rule (resolve the owning account; reject anything outside the machine token's scope as 404).
  Reads only — no new mutation is exposed, and the admin-gated mutations / global sweeper reads stay
  excluded. No registry change was needed: the dispatcher already reflects over the full
  `CoreDependencies` object, so allow-listing a method is enough. Round-trip + cross-account-scope
  tests for every newly-listed method are in `packages/server/test/persistenceRpc.spec.ts`.

  Still a DRAFT-gated initiative (see `docs/initiatives/mothership-mode.md`): the cross-service +
  entity-id-keyed reads (which need a new scope kind), routing the direct-db stores through the
  remote registry, and the fake-mothership integration test remain before the mothership boot can
  ship.

- f9678df: Mothership mode (Phase 3 slice 2): widen the persistence-RPC allow-list to the cross-service
  entity-id-keyed board-composition reads, via two new scope kinds that resolve the entity's owning
  account server-side before the scope check.

  - `serviceList` (arg0 = `serviceIds[]`): resolve each service's owning account; EVERY requested id
    must be in scope (a missing or out-of-scope service fails closed as 404); an empty list is a
    no-op read that binds no service. Exposes `serviceRepository.listByIds`,
    `blockRepository.listByServices`, `executionRepository.listByServices`,
    `bootstrapJobRepository.listByServices`, `pipelineScheduleRepository.listByServices`, and
    `workspaceMountRepository.countByServiceIds`.
  - `block` (arg0 = blockId, no workspace arg): resolve the block's home workspace, then that
    workspace's account. Exposes `blockRepository.findById`.
  - `serviceRepository.listByAccount` reuses the existing `account` rule, so the `null` (auth-disabled,
    unscoped) org listing is refused over a scoped machine token.

  The two resolvers (`resolveBlockAccountId`, `resolveServiceAccountIds`) are wired in
  `PersistenceController` and the dispatcher fails closed when a kind's resolver is absent. Round-trip,
  cross-account-scope, unknown-id, and empty-list tests for every newly-listed method are in
  `packages/server/test/persistenceRpc.spec.ts`.

  `subscriptionActivationRepository.deleteByExecution` is deliberately NOT exposed: per the per-repo
  bucket checklist it is the local-sqlite bucket, not the remote surface.

  Still a DRAFT-gated initiative (see `docs/initiatives/mothership-mode.md`): routing the direct-db
  stores through the remote registry when `db` is undefined, and the fake-mothership integration test,
  remain before the mothership boot can ship.

- f9678df: Mothership mode (Phase 3 slice 4): the fake-mothership functional integration test — the merge
  gate's exit criteria — plus the agent-context run-path repo surface it surfaced.

  New test `runtimes/local/test/mothership-integration.spec.ts` boots a stock Node mothership
  (`buildNodeContainer` over real Postgres) on a 127.0.0.1 loopback and a no-Postgres mothership-mode
  `buildLocalContainer` whose `CoreRepositories` are the RPC-backed remote registry pointing at it,
  then asserts the two things the build-only tests can't: a board **loads** over the remote
  persistence RPC, and a run **drives to a persisted terminal state** (`done`) over it, with the
  execution read back straight from the mothership's Postgres. Only the agent executor is faked; the
  whole persistence path is real, so an un-allow-listed method, a mis-scoped call, or an unrouted
  direct-db store fails the test instead of a developer's first board load.

  Standing it up surfaced that `AgentContextBuilder` resolves a block's linked docs/tasks and its
  provisioned environment on EVERY agent dispatch — so those feature-flagged sub-helper repos are on
  the board-load + run path, not off it as previously assumed. Fixes:

  - `@cat-factory/node-server`: in mothership mode (`db` undefined) route the context-builder
    run-path repos — `documentRepository`, `taskRepository`, `environmentRegistryRepository` /
    `environmentConnectionRepository` — from the remote registry (the sub-helpers built them directly
    over the absent `db`). Their connect/provision surfaces stay db-direct (off the run path).
  - `@cat-factory/server`: widen `PILOT_PERSISTENCE_METHODS` to the run/board methods the path
    exercises, each workspace-scoped: `documentRepository.{listByBlock,get,getByUrl}`,
    `taskRepository.{listByBlock,get,getByUrl}`, `environmentRegistryRepository.{getByBlock,get}`, the
    run-start `modelPresetRepository.getDefault`, the board-load lazy default-preset seeds
    `mergePresetRepository.upsert` / `modelPresetRepository.upsert`, and the completion notification
    raise + inbox transitions `notificationRepository.{findOpenByBlock,upsertOpenForBlock,upsert}`.
    (`*.getByUrl` resolves a URL named in a block's description, and `notificationRepository.upsert`
    backs block-less raises + inbox act/dismiss/escalate — both squarely on the same run/post-run
    path as the reads they sit next to, so omitting them would fail any task whose description
    contains a link, or any inbox action after a run.) Round-trip + cross-account-scope unit tests
    for each are added to `persistenceRpc.spec.ts`, and the integration test patches a task with a
    URL + Jira/GitHub refs and enables the environment integration so these reads round-trip over the
    RPC end-to-end (not just in the unit suite).

  Still DRAFT-gated (`docs/initiatives/mothership-mode.md`): decrypting a remotely-sealed provisioned
  environment's access cipher needs the mothership's key (a later secrets-delegation slice); the
  kaizen-grading, LLM-metric and subscription-activation calls a run also makes degrade as best-effort
  no-ops over the remote (telemetry is Phase 5 local-first; activation is the local-sqlite bucket); and
  the remaining sub-helper surfaces (fragments / slack connect/provision) are follow-ups.

- f9678df: Mothership mode: the no-Postgres local boot SPINE (initiative slice 1b). A local node can now
  boot with `LOCAL_MOTHERSHIP_URL` set and NO local database: it composes the remote (RPC-backed)
  org repositories + a local `node:sqlite` credential store (sealed with the LOCAL key; the
  mothership's `ENCRYPTION_KEY` never reaches the machine) and drives runs with an in-process work
  runner instead of pg-boss.

  NOT yet functional end-to-end — keep the mothership PR a DRAFT. The pilot allow-list exposes only
  the six core domain repositories remotely, but a board load and a run reach many more org repos
  (mounts, settings, presets, notifications, projections, …) plus stores still built from the
  now-absent local `db`, so those paths currently throw. Routing the full repository surface through
  the remote registry + widening the server allow-list (with the per-method account/role scope rules
  that boundary needs) is the gating phase in `docs/initiatives/mothership-mode.md`; this work must
  not merge until that phase lands. See the tracker for the per-repo task list.

  - `@cat-factory/server`: `createRemoteRepositoryRegistry(client)` — a drift-proof, full-surface
    remote repository set (a `Proxy` that lazily forwards any accessed repository to one RPC), so a
    mothership-mode node backs its entire `CoreRepositories` surface remotely with no per-repo
    wiring. The server-side allow-list still gates which repo+method actually executes.
  - `@cat-factory/node-server`: `buildNodeContainer` now tolerates `db: undefined` — the per-user
    Postgres services (subscriptions, user secrets, OpenRouter catalog) turn themselves off, the
    API-key pool + local-model endpoints accept injected repositories, and the composite `repos`
    is required in that mode. Re-exports the execution driver + realtime pieces the local
    mothership boot reuses.
  - `@cat-factory/local-server`: `composeMothership` wires the remote repos + the local credential
    store; `buildLocalContainer` composes them with `db: undefined`, injects the credential repos,
    and drives runs with the new in-process `WorkRunner` (the no-pg-boss analogue, serialized per
    execution); `startLocal()` takes the dedicated no-Postgres boot path automatically when
    `LOCAL_MOTHERSHIP_URL` is set.
  - `@cat-factory/contracts`: `localModeConfig.mothership` is surfaced to the SPA so the UI can
    label what is stored locally vs delegated to the mothership.

  Login-based machine-token minting also lands later (a static `LOCAL_MOTHERSHIP_TOKEN` is used for
  now). Pre-1.0, no back-compat: the standard siloed-Postgres local mode is unchanged when
  `LOCAL_MOTHERSHIP_URL` is unset.

### Patch Changes

- f9678df: Mothership Phase 3 review fixes:

  - `ExecutionService.start` now clears a replaced block's prior per-run subscription activation
    best-effort (try/catch), mirroring the terminal cleanup in `RunStateMachine.emit`. In mothership
    mode `subscriptionActivationRepository` is remote and `deleteByExecution` is not yet allow-listed
    (it throws `unknown_method`), so the previously-unguarded call would break re-running any block;
    the TTL sweep reclaims the stale row as the backstop.
  - The persistence RPC controller memoises the `block` / `serviceList` scope reads
    (`blockRepository.findById` / `serviceRepository.listByIds`) per request, so when the request
    also dispatches that same read it reuses the resolver's result instead of issuing a second
    identical query.

- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/orchestration@0.48.1
  - @cat-factory/kernel@0.62.0
  - @cat-factory/integrations@0.44.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/prompt-fragments@0.9.18
  - @cat-factory/spend@0.10.48

## 0.54.0

### Minor Changes

- 9bb75b0: Per-service provision types (slices 3 + 4): the deployer engine step + run-details recording,
  and the per-type handler controllers + container wiring.

  Slice 3 — engine step:

  - The `deployer` step now resolves the SERVICE frame's declared `provisioning` and routes to the
    workspace handler for its type (merging the service's manifest source). A service declaring
    `infraless` records a no-op step output (nothing provisioned); an undeclared service falls
    through to the legacy single-connection path. The resolved provision type + engine are recorded
    on the `EnvironmentRecord` (success and failed paths) and surfaced on the step output
    (`Provision type:` / `Engine:` lines + `model: environment:<engine>:<providerId>`).
  - `EnvironmentProvisioningService.provision` gains an `initiatedBy` arg and a
    `resolveUserHandlerOverrides` seam: in local mode the run initiator's per-user handler
    overrides layer over the workspace handlers.

  Slice 4 — controllers + wiring:

  - New per-type infra handler HTTP surface on `EnvironmentController` (workspace-scoped): a batched
    `GET …/environments/handlers` bundle (handlers + custom-type catalog), `POST …/handlers`,
    `PATCH …/handlers/:provisionType/secrets`, `DELETE …/handlers/:provisionType`, plus custom-type
    CRUD (`PUT|DELETE …/environments/custom-types/:manifestId`).
  - New **local-mode-only** `EnvironmentUserHandlerController` mounted at the root
    (`GET /me/environment-handlers/:workspaceId`, `PUT|DELETE …/:provisionType`), backed by the new
    `EnvironmentUserHandlerService`. The service + per-user overrides are wired ONLY by the local
    facade (Worker/Node 503 the controller and ignore user overrides), enforced purely by container
    wiring.
  - `customManifestTypeRepository` is wired on all three facades (workspace catalog CRUD);
    `environmentUserHandlerRepository` only on the local facade.
  - The handler validation/lowering is extracted to a shared `buildInfraHandlerFields` helper used by
    both the workspace and per-user stores. Cross-runtime conformance asserts the per-type handler
    CRUD + custom-type CRUD + the `infraless` deployer no-op on every facade.

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/integrations@0.43.0
  - @cat-factory/orchestration@0.48.0
  - @cat-factory/agents@0.24.2
  - @cat-factory/kernel@0.61.1
  - @cat-factory/prompt-fragments@0.9.17
  - @cat-factory/spend@0.10.47

## 0.53.0

### Minor Changes

- 15c5894: feat(auth): remote node mode — surface the unauthenticated state and support PAT sign-in.

  - A remote facade (node service / Worker) has no anonymous tier, so once the auth handshake
    resolves with no signed-in user the SPA now routes to the login screen — even when the
    backend reports auth "disabled" (a dev-open / unconfigured remote). Previously this dropped
    the user onto a board where every per-user action silently failed with no sign-in affordance.
    An unreachable backend still falls through to the board's own error UI.
  - Source-control PAT sign-in now works on the remote node facade: a user pastes their own
    GitHub/GitLab PAT and is resolved to the account it belongs to. A hosted PAT login is held
    to the SAME login/org/domain allowlist as GitHub OAuth (admit when the login, an org it
    belongs to, or its email domain is allowlisted; fail closed when none are configured). Local
    mode keeps its configured-token, allowlist-exempt flow. `GET /auth/config` advertises the
    available PAT providers and the login screen renders a PAT option alongside OAuth/password;
    when a remote deployment has no sign-in method at all the screen explains that instead of
    showing a blank card.
  - New `TESTING_NO_AUTH` escape hatch (test-only, refused in a production-like ENVIRONMENT):
    a stronger `AUTH_DEV_OPEN` that both leaves the API open AND advertises (via `GET
/auth/config`) that the SPA may render the board anonymously instead of gating to login. The
    e2e suite opts into it; `AUTH_DEV_OPEN` on its own keeps the SPA's login gate, since a
    dev-open remote still has no anonymous tier.

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/integrations@0.42.1
  - @cat-factory/orchestration@0.47.1
  - @cat-factory/prompt-fragments@0.9.16
  - @cat-factory/spend@0.10.46

## 0.52.0

### Minor Changes

- f383515: Per-service provision types (slice 2c — tester collapse). **Breaking:** the per-task/per-service
  `local` vs `ephemeral` Tester toggle is gone. A service's declared `provisioning` config now
  drives the Tester's infra entirely, so these are removed (BC is a non-goal — stale rows/columns
  are simply dropped):

  - the `Block` fields `defaultTestEnvironment`, `testComposePath`, `noInfraDependencies` (folded
    into `provisioning.type` / `provisioning.composePath`) — dropped from the contract, the shared
    block mapper, and the D1 (`0026_drop_tester_env_columns.sql`) + Drizzle block columns;
  - the `tester.environment` agent-config descriptor (`@cat-factory/agents`) and its prompt/job-body
    consumers — the Tester's run mode is now derived from the service's provision type;
  - the `delegateTestEnvToProvider` workspace setting (+ its D1/Drizzle column) and the local-facade
    `resolveTesterFallbackDefault` / `resolveRequireEnvironmentProvider` wiring.

  The start-time Tester gate is rewritten: it passes for an `infraless` (or undeclared) service,
  refuses a `docker-compose` service on a runtime that can't nest containers OR with no compose
  path declared (`tester_infra_unsupported` — "limited mode" / "nothing to stand up"), and requires
  a resolvable workspace handler for a `kubernetes`/`custom` service (`provision_type_unhandled`, via
  the new `EnvironmentConnectionService.resolveHandlerForType` /
  `EnvironmentProvisioningService.canProvision` seam). The Tester's run mode (the `infra` job spec +
  the prompt run-mode line, kept in lock-step) is derived from the provision type AND the run's
  provisioned environment: a service that actually provisioned an env URL (e.g. via a `deployer`
  step) tests against it regardless of declared type, and an undeclared service runs with no infra.
  The agent-executor `service` context carries `provisioning` instead of the three legacy fields. The
  service inspector replaces the local/ephemeral toggle with a provision-type selector.

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0
  - @cat-factory/agents@0.24.0
  - @cat-factory/orchestration@0.47.0
  - @cat-factory/integrations@0.42.0
  - @cat-factory/spend@0.10.45
  - @cat-factory/prompt-fragments@0.9.15

## 0.51.3

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/integrations@0.41.1
  - @cat-factory/orchestration@0.46.1
  - @cat-factory/spend@0.10.44
  - @cat-factory/prompt-fragments@0.9.14

## 0.51.2

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0
  - @cat-factory/integrations@0.41.0
  - @cat-factory/orchestration@0.46.0
  - @cat-factory/agents@0.23.3
  - @cat-factory/spend@0.10.43
  - @cat-factory/prompt-fragments@0.9.13

## 0.51.1

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/integrations@0.40.1
  - @cat-factory/kernel@0.57.1
  - @cat-factory/orchestration@0.45.3
  - @cat-factory/spend@0.10.42

## 0.51.0

### Minor Changes

- bd23c46: Add the mothership-mode persistence-RPC spine (the pilot core of the mothership-mode
  initiative). A new machine-token audience (`TOKEN_AUDIENCE.machine`) and a reflective
  `POST /internal/persistence` endpoint let a mothership-mode local node forward its
  org/durable repository calls to a hosted mothership: the controller reflects over a
  facade-attached repository registry (`ServerContainer.repositories`) and enforces a per-repo
  method allow-list plus per-call account scoping (an out-of-scope call is a 404, no existence
  leak). The client side ships `createRemoteRepositories` — a `Proxy`-backed `CoreRepositories`
  subset whose wire envelope round-trips `undefined`/`null`, writes a mutated `execution.rev`
  back in place (the optimistic-concurrency contract), and re-throws `DomainError`s. The
  endpoint 503s on any facade that has not attached its repository registry, so existing
  deployments are unaffected.

### Patch Changes

- 1952d6b: Per-service provision types (slice 1 — additive foundation). Adds the
  `provisionType`/`infraEngine`/`serviceProvisioning`/`infraHandlerConfig` and
  custom-manifest-type contracts, a `provisioning` field on the service-frame `Block`
  (persisted as a JSON column on both runtimes and settable via the block update endpoint),
  and `provisionType`/`engine` fields on the environment handle. Introduces the per-user
  infra handler override table (`environment_user_handlers`, local-mode) and the workspace
  custom-manifest-type catalog (`custom_manifest_types`) — mirrored across D1 and Drizzle
  with a cross-runtime conformance suite — plus `provision_type`/`engine` columns on the
  `environments` registry. No behaviour is wired yet; the single→multi reshape of
  `environment_connections`, the resolver, and the UI follow in later slices. See
  `docs/initiatives/per-service-provision-types.md`.
- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/integrations@0.40.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/orchestration@0.45.2
  - @cat-factory/prompt-fragments@0.9.12
  - @cat-factory/spend@0.10.41

## 0.50.3

### Patch Changes

- Updated dependencies [2ac148d]
  - @cat-factory/integrations@0.39.0
  - @cat-factory/orchestration@0.45.1

## 0.50.2

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/orchestration@0.45.0
  - @cat-factory/contracts@0.58.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/integrations@0.38.1
  - @cat-factory/kernel@0.56.1
  - @cat-factory/prompt-fragments@0.9.11
  - @cat-factory/spend@0.10.40

## 0.50.1

### Patch Changes

- 1ff013f: Add fail-fast guards that surface invalid state early and loudly instead of letting it
  flow silently into the domain.

  - **Persistence read boundary** (`@cat-factory/server`): a new `decode` helper
    (`decodeEnum`/`decodeEnumOr`/`decodeJson`/`tryDecodeRow`/`tryDecodeRows` + `DataIntegrityError`)
    re-asserts the Valibot wire contract at row→domain mapping time, replacing erased
    `as SomeType` casts. Wired through the shared mappers (block status/level, `depends_on`,
    and `rowToExecution` — which now rejects an empty `block_id` and an out-of-bounds
    `currentStep`) and, symmetrically across both runtimes, the agent-run kind, notification
    type/status/severity, and subscription vendor reads. A corrupt enum/JSON now logs with
    row context and throws a 500 (engine-critical) or degrades (cosmetic) rather than
    smuggling a fake-valid value downstream. Snapshot-facing list reads (block + execution
    `listByWorkspace`/`listByService`/`listByServices` on both runtimes) decode through
    `tryDecodeRows`, so one corrupt row is logged and dropped instead of failing the whole
    board load — the single-row `get`/`getByBlock` point reads keep the loud throw.
  - **Execution engine** (`@cat-factory/orchestration`): `disposeReview` rejects a
    non-positive iteration cap / sub-1 counter; `StepGraph.loopCompanionProducer` replaces
    `companion!`/`steps[-1]!` force-unwraps with diagnostic guards.
  - **Gates** (`@cat-factory/gates`): `warnUnwiredGates(logger)` logs (once per gate per
    process) any built-in gate left as a silent pass-through, so a deployment that forgot to
    wire the GitHub App no longer auto-merges without checking CI. Called at both facades'
    container build.

  Scope notes: lower-severity source-kind casts and deep JSON-blob shape validation are
  deliberately deferred (the primitives are in place to extend to them). No guards were
  added inside the durable drive path (e.g. `finalizeBlock`) where a throw would wedge the
  retry loop, and the intentional Node-vs-Cloudflare container-executor fail-mode asymmetry
  is left unchanged.

- Updated dependencies [1ff013f]
  - @cat-factory/orchestration@0.44.1

## 0.50.0

### Minor Changes

- f9a173f: Fix three concurrency hazards in the backend with database-native primitives.

  - **Optimistic concurrency on execution runs.** `agent_runs` gains a monotonic `rev`
    column; the execution repo's `upsert` bumps it on every write and a new
    `compareAndSwap` performs a guarded conditional write. The in-place human-action handlers
    (resolve decision / request changes / reject / request-human-review-fix / resume-paused)
    now go through a `mutateInstance` retry helper, so a double-submit or a write that raced
    the durable driver is re-applied on fresh state instead of silently clobbering the other
    writer (lost update). (`retry` / `restart-from-step` mint a fresh run id, so the same-row
    hazard is structurally absent there.)
  - **Atomic API-key pool lease.** The non-transactional `listForPool → chooseToken →
markLeased` is replaced by a single atomic select-and-mark (`leaseLeastUsed`: Postgres
    `FOR UPDATE SKIP LOCKED`; D1 a single serialised write), so two concurrent dispatches
    can no longer grab the same key before usage is recorded.
  - **Notification open-card dedup.** A partial unique index on
    `(workspace_id, block_id, type) WHERE status='open'` plus an atomic
    `upsertOpenForBlock` replaces the racy `findOpenByBlock` read-before-write, so two
    concurrent raises can't stack duplicate open cards. `upsertOpenForBlock` returns the
    CANONICAL persisted row, so when a concurrent raise wins the insert the loser delivers
    and returns that row's id rather than a phantom id (which would show a duplicate inbox
    card and 404 when acted on).

  BREAKING (pre-1.0, no data migration): `agent_runs` adds a non-null `rev` column and the
  `notifications` table adds a partial unique index, mirrored across the D1 and Drizzle
  migrations. The `ExecutionRepository`, `ProviderApiKeyRepository` and
  `NotificationRepository` ports each gain a method.

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0
  - @cat-factory/orchestration@0.44.0
  - @cat-factory/integrations@0.38.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/prompt-fragments@0.9.10
  - @cat-factory/spend@0.10.39

## 0.49.6

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/orchestration@0.43.4
  - @cat-factory/integrations@0.37.1
  - @cat-factory/agents@0.22.5
  - @cat-factory/spend@0.10.38

## 0.49.5

### Patch Changes

- 0dd9532: Internal refactor: extract the per-kind harness job-body builders (`buildKindBody`,
  `buildRegisteredAgentBody` and `buildMigratedBuiltInBody`) out of
  `ContainerAgentExecutor.ts` into a dedicated `jobBody.ts` module as free functions over a
  shared `KindBodyParts`, re-imported at the single `buildJobBody` call site. The existing
  `containerAgentJobBody.spec.ts` snapshots (driven through the public `startJob`) stay
  byte-identical. Pure code move — no behaviour, API, or wiring change.

## 0.49.4

### Patch Changes

- 21b2096: Make the environment-backend and runner-backend registries app-owned (DI) instead of
  module-global Maps. This is the pilot for the registry-DI migration
  (`docs/initiatives/registry-di-migration.md`): the composition root now constructs each
  registry instance via `createBackendRegistries()` and injects it through
  `CoreDependencies`; a deployment registers a custom backend by reference
  (`registry.register(provider)`), so registration no longer depends on the adapter and
  server sharing the same `@cat-factory/integrations` module instance.

  BREAKING (`@cat-factory/integrations`): the module-global free functions
  `registerEnvironmentBackend` / `environmentBackend` / `registeredEnvironmentBackendKinds`
  / `environmentBackendKinds` / `findRepairCapableProvider` and their runner-backend
  equivalents (`registerRunnerBackend` / `runnerBackend` / `registeredRunnerBackendKinds`
  / `runnerBackendKinds`) are removed. Use the new `EnvironmentBackendRegistry` /
  `RunnerBackendRegistry` classes (methods `register` / `get` / `kinds` / `labelled`, plus
  `findRepairCapable` on the env registry), the `defaultEnvironmentBackendRegistry()` /
  `defaultRunnerBackendRegistry()` factories, or the unified `createBackendRegistries()`.

- Updated dependencies [21b2096]
  - @cat-factory/integrations@0.37.0
  - @cat-factory/orchestration@0.43.3
  - @cat-factory/contracts@0.56.1
  - @cat-factory/agents@0.22.4
  - @cat-factory/kernel@0.55.3
  - @cat-factory/prompt-fragments@0.9.9
  - @cat-factory/spend@0.10.37

## 0.49.3

### Patch Changes

- 123336c: Internal refactor: extract the per-kind prompt material (the blueprint/spec-writer/merger/
  on-call system prompts, the structured-output shape hints, and the
  `blueprintUserPrompt`/`specWriterUserPrompt`/`mergerUserPrompt`/`onCallUserPrompt`/
  `testerInfraSpec`/`prBody` builders) out of `ContainerAgentExecutor.ts` into a dedicated
  `prompts.ts` module, with co-located characterisation tests. Pure code move — no behaviour,
  API, or wiring change.

## 0.49.2

### Patch Changes

- 4ec514a: Internal refactor: extract the runner-output → engine-result normalisation (`toRunResult`
  and its per-kind coercions) out of `ContainerAgentExecutor.ts` into a dedicated
  `containerAgentResult.ts` module, with co-located characterisation tests. Pure code move —
  no behaviour, API, or wiring change.

## 0.49.1

### Patch Changes

- ad5d3e0: Collapse the Infrastructure settings into one flat backend list per tab. The "Agent
  containers" and "Test environments" tabs each now show a single radio list of concrete
  destinations (built-in · Kubernetes cluster · custom HTTP pool/provider) with a one-line
  description, instead of stacking a "where it runs" radio above a separate "runner/environment
  backend" dropdown. Selecting a cluster/pool reveals its connect form inline.

  Adds a low-config **Local Kubernetes (k3s)** preset (local mode, agent containers) that
  prefills the Kubernetes runner form for a local k3s cluster — the operator only pastes a
  ServiceAccount token. To support it, the Kubernetes runner form gains the
  `insecureSkipTlsVerify` toggle, and the infrastructure capability descriptor surfaces the
  local deployment's executor image (`suggestedExecutorImage`, from `LOCAL_HARNESS_IMAGE`) so
  the preset's image is prefilled. No backend behavior change was needed — the Kubernetes
  apiserver validator already permits loopback hosts and self-signed TLS.

  Also moves the manifest editor's "currently stored secrets" indication next to the secret
  inputs so it's clear whether a value is already saved.

  BREAKING (pre-1.0, internal): removes the `settings.providerConnection.backend.*` and
  `settings.providerConnection.advancedManifest.*` i18n keys (the old in-form backend
  dropdown + collapsed-manifest disclosure are gone).

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/agents@0.22.3
  - @cat-factory/integrations@0.36.1
  - @cat-factory/kernel@0.55.2
  - @cat-factory/orchestration@0.43.2
  - @cat-factory/prompt-fragments@0.9.8
  - @cat-factory/spend@0.10.36

## 0.49.0

### Minor Changes

- 4897078: Make the ephemeral-environment AND self-hosted runner-pool backend registries extensible to
  custom third-party kinds, so a single-tenant / self-hosted deployment can register a bespoke
  provider **programmatically** (an import side effect via `registerEnvironmentBackend` /
  `registerRunnerBackend`), mirroring custom agent kinds. This restores the capability the
  removed `buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`
  deployment-wide injection used to provide, and serves both single- and multi-tenant.

  - **Contracts (breaking, additive):** `environmentBackendConfigSchema` /
    `runnerBackendConfigSchema` gain a generic custom-kind member (a lower-kebab `kind` slug,
    guarded to exclude the reserved built-ins, carrying the subsystem manifest body), so a
    custom kind's connect config validates with no new variant. The workspace snapshot gains
    `environmentBackendKinds` / `runnerBackendKinds`, and the describe routes accept an optional
    `kind` query. Existing `manifest`/`kubernetes` rows still parse — no migration.
  - **Registries:** `EnvironmentBackendProvider` / `RunnerBackendProvider` `kind` is now an open
    `string` with an optional `displayLabel`; new `environmentBackendKinds()` /
    `runnerBackendKinds()` accessors. `describeProvider(workspaceId, kind?)` can describe a
    registered kind before it is connected.
  - **Frontend:** the provider-connect backend-kind selector is snapshot-driven (built-in
    fallback) instead of a hardcoded `manifest`/`kubernetes` list; a custom kind's flat-form /
    manifest-editor save is tagged with its slug.
  - A custom kind requires a per-workspace connection (the encrypted-secret + `providerConfig`
    anchor) exactly like the built-ins. The `runnerPoolProvider` facade option is unchanged and
    remains the HTTP-pool override for the manifest backend, NOT the custom-kind seam.

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/integrations@0.36.0
  - @cat-factory/agents@0.22.2
  - @cat-factory/kernel@0.55.1
  - @cat-factory/orchestration@0.43.1
  - @cat-factory/prompt-fragments@0.9.7
  - @cat-factory/spend@0.10.35

## 0.48.4

### Patch Changes

- d5a0637: Close the GitLab-vs-GitHub provider parity gaps so a GitLab deployment behaves like a GitHub
  one across every runtime facade.

  - **Facade parity (the showstopper):** the engine's CI / mergeability / PR-review gate
    providers, the PR merger, the branch updater and the checkout-free `RepoFiles` resolvers are
    now wired from a GitLab-backed client on the **Node and Cloudflare** facades too — previously
    only local mode bridged GitLab into the gates, so a stock GitLab-only Node/CF deployment did
    not gate on real CI or merge for real. Both facades now build the engine VCS client via the
    shared `buildGitLabEngineClient` (GitHub App wins when both are configured).
  - **Review provider:** `FetchGitLabClient` now implements the human-review reads
    (`getPullRequestBaseRef`, `listRequestedReviewers`, `listPullRequestReviews` +
    `getRequiredApprovingReviewCount` from GitLab approvals, `listReviewThreads` /
    `replyToReviewThread` / `resolveReviewThread` over resolvable MR discussions, plus
    `listIssueComments`).
  - **Branch update:** new optional `VcsClient.rebasePullRequest` / `GitHubClient.rebasePullRequest`
    — GitLab has no server-side merge-branch-into-branch endpoint, so the conflicts / human-testing
    gate's "pull latest base" action advances a GitLab MR branch by rebasing it; `GitHubBranchUpdater`
    prefers rebase when the client exposes it and falls back to `mergeBranch` (GitHub) otherwise.
  - **Conformance:** the cross-provider VCS client suite now asserts GitHub and GitLab normalise the
    human-review gate inputs identically and exposes the correct branch-advancing capability per
    provider; a reusable `FakeVcsClient` drives the real gate / merge / branch-update providers
    through the GitLab-backed adapter.
  - **Rebase verdict robustness:** the GitLab MR-rebase poll now sleeps before each status read (so
    a not-yet-started async rebase is never mistaken for a finished one) and decides the outcome by
    whether the source-branch head actually advanced, ignoring the persisted `merge_error` field
    (shared with merge attempts) unless the branch did not move. Covered by poll-transition,
    stale-`merge_error`, conflict and up-to-date tests.
  - **Accurate required-approval count:** `getRequiredApprovingReviewCount` now reads the effective
    per-MR `approvals_required` (it accounts for the rule on the MR's target branch) when the PR
    number is known, falling back to the project default; the port carries the PR number alongside
    the branch (GitHub still reads branch protection and ignores it).
  - **Node facade wiring:** the GitLab-backed engine client feeds only the gate / merge / RepoFiles
    seams; GitHub-issue-specific consumers (the GitHub Issues task source, issue writeback) stay
    gated on a real GitHub client, so a GitLab-only Node deployment no longer offers a
    non-functional "GitHub Issues" task source (parity with the Worker).

- 915861c: Surface the Tester's in-container docker-compose dependency stand-up logs on the test report
  window.

  A `local`-infra Tester stands the service's dependencies up inside its container with
  `docker compose up --wait` before running. Until now that command's output was written only
  to the harness's own logs — so when the dependencies failed to come up (a port clash, an
  image pull-auth failure, a healthcheck timeout, a service that exits immediately) the run
  showed an opaque failure and the single highest-signal artifact for diagnosing it was
  unreachable from the UI. This was flagged as the natural follow-up to the container-lifecycle
  observability work (the orchestrator-side provisioning logs can't see it — the stand-up runs
  _inside_ the container).

  - **Harness.** `standUpInfra` now captures the `docker compose up` stdout+stderr (on success
    _and_ failure), redacts credentials (the shared `redact` now also scrubs credential-named
    `KEY=value` / `KEY: value` assignments — e.g. a dependency echoing `POSTGRES_PASSWORD=…` —
    which are neither a token shape nor a known value), tail-bounds it, and returns an
    `infraSetup` record
    (started / compose path / duration / logs / error) on the agent result.
  - **Propagation.** The record rides the existing `RunnerJobResult` → `AgentRunResult` path
    (forwarded verbatim by both transports) and the engine persists it on the Tester step as
    `step.test.infraSetup`, refreshed on each Tester round.
  - **UI.** The test report window's Infrastructure section now shows a "Dependency stand-up"
    panel — the outcome, the compose file, how long it took, the verbatim error on failure, and
    the captured stand-up logs behind a toggle.
  - **Parity.** The cross-runtime conformance suite asserts the record round-trips onto
    `step.test.infraSetup` identically on D1 and Postgres.

  Bumps the `@cat-factory/executor-harness` image to `1.26.0` (the harness `src/` changed) and
  the matching tag in `deploy/backend`.

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0
  - @cat-factory/orchestration@0.43.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/integrations@0.35.4
  - @cat-factory/spend@0.10.34
  - @cat-factory/prompt-fragments@0.9.6

## 0.48.3

### Patch Changes

- Updated dependencies [b76f303]
  - @cat-factory/orchestration@0.42.1

## 0.48.2

### Patch Changes

- 48a3df6: Surface the per-run container's live lifecycle in a container agent's details, and bring
  the API Tester window to parity with the Coder.

  Previously a container-backed step showed a "Spinning up container…" badge that simply
  **vanished** once the container was up, leaving a blank "working" state — you couldn't tell
  whether the agent was still preparing the checkout or already making model calls, and there
  was no way to see which container the run was on or whether it was up / errored / gone.

  - **Live phase.** The executor-harness now exposes its current lifecycle phase
    (`starting` → `clone` → `agent` → `push`) on the running job view — the same marker that
    already drove the stuck-run breadcrumb. The engine threads it through
    (`RunnerJobView` / `AgentJobUpdate`) onto the step so the details show WHAT the container
    is doing: "Preparing workspace" vs "Agent running" vs "Pushing changes".
  - **Container identity + address.** The transport now attaches the container's id (the
    Cloudflare Durable Object id; the local Docker container id) and, where one exists, its
    reachable URL (the local host URL) — so a run's details name WHERE it runs.
  - **Explicit lifecycle status.** Steps carry a `container` projection
    (`starting` / `up` / `errored`, with `destroyed` derived once the run's container is
    reclaimed), so the details say whether the container is spinning up, running, errored, or
    gone — instead of inferring it from a run-level failure.
  - **API Tester parity.** The Tester result window now reuses the same observability the
    Coder's step detail shows — the container lifecycle (status / phase / id / url), the
    ephemeral environment status, and the run's infrastructure attempts + logs — alongside its
    test report, instead of the report alone. The Tester (and the human-test / visual-confirm
    gate helpers) now surface the cold-boot `starting` window before the agent comes up, like
    the Coder, rather than jumping straight to "running".
  - **The legacy `startingContainer` boolean is removed** in favour of the richer `container`
    projection everywhere (no dual-signal path): every container-backed step — including the
    gate helpers — now reports its lifecycle through `container`. (Stale persisted steps simply
    drop the field; backwards compatibility is a non-goal.)

  Bumps the `@cat-factory/executor-harness` image to `1.24.0` (and the matching tag in
  `deploy/backend`).

- 48a3df6: Fix the Tester→Fixer loop, make fixer runs inspectable, and let the Tester abort a run.

  Three related issues in the API/UI Tester flow:

  - **The Tester never actually re-ran after a Fixer round, so the step was marked "done"
    regardless of the outcome.** The harness keys each job by `run + agentKind` and re-attaches
    to an existing entry rather than re-running (replay idempotency). A container-reusing
    transport (a warm local pool / a self-hosted runner pool) keeps that registry alive across
    rounds — reclaiming a pooled member does NOT destroy it — so a re-dispatched Tester
    re-attached to its FIRST round's completed job and silently replayed the stale report. Each
    re-dispatch within a run now carries a per-round **dispatch epoch** folded into the harness
    job id (`AgentRunContext.dispatchEpoch`), so the re-test always runs anew. Also covers the
    CI/conflicts gate fixer loops, which share the same re-dispatch shape. Defensively, a report
    with any failed outcome can no longer be greenlit (a failed check is treated as a blocker).
    The conformance suite now models a pooled container so the loop is exercised faithfully.

  - **Fixer companion runs were opaque.** A Tester step now keeps an append-only `attemptLog`
    of its fixer rounds (what each round was handed + how it ended), rendered as an inspectable
    timeline in the test report window instead of only a bare "N/M fix" count.

  - **The Tester can now ABORT a run instead of looping the fixer.** When the change cannot be
    meaningfully tested — its ephemeral environment never came up, a required dependency is
    missing — the Tester sets `abort: { reason }` on its report (or the engine auto-aborts when
    the step's ephemeral environment is in a `failed` state). The run stops, the block is left
    blocked (retryable), and a human-actionable notification is raised — the fixer is NOT
    dispatched, since it cannot provision infrastructure.

  This is a breaking change to the persisted Tester step state and the test-report wire shape
  (new `attemptLog` / `abort` fields); per the project's pre-1.0 policy, stale in-flight runs
  may simply break rather than migrate.

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0
  - @cat-factory/orchestration@0.42.0
  - @cat-factory/agents@0.22.0
  - @cat-factory/integrations@0.35.3
  - @cat-factory/spend@0.10.33
  - @cat-factory/prompt-fragments@0.9.5

## 0.48.1

### Patch Changes

- Updated dependencies [614e985]
  - @cat-factory/integrations@0.35.2
  - @cat-factory/orchestration@0.41.4

## 0.48.0

### Minor Changes

- 0577404: feat: move infrastructure configuration into its own top-level navbar menu. Agent-container execution + Tester environments + (local mode) the warm-container pool / checkout reuse now live in a dedicated tabbed "Infrastructure" window reached from the navbar, instead of being buried in the Integrations hub and a separate "Local mode" entry. The old bare "delegate to runner pool" toggle is replaced by a clear execution-backend selector that reflects the backends available for THIS deployment (local Docker host / Cloudflare Containers / self-hosted runner pool) and which is active — driven by a new symmetric `infrastructure` capability descriptor on `GET /auth/config` (set by every facade; asserted by the cross-runtime conformance suite). The raw-JSON runner manifest editor is kept but collapsed behind an "Advanced: custom API-based scheduler" disclosure, since the common backends don't need it.

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/integrations@0.35.1
  - @cat-factory/kernel@0.53.1
  - @cat-factory/orchestration@0.41.3
  - @cat-factory/prompt-fragments@0.9.4
  - @cat-factory/spend@0.10.32

## 0.47.0

### Minor Changes

- 69558f9: Add a Kubernetes-based ephemeral-environment provider, selected per workspace through an
  env-backend registry that mirrors the runner-pool backends.

  The ephemeral-environment connection is now discriminated by a `kind` field (`manifest` =
  the generic BYO HTTP management API, `kubernetes` = native per-PR namespaces), resolved
  through a `registerEnvironmentBackend` provider-registry seam — so a native backend is a
  single registry entry + a config variant + a UI form, with no new table/service/controller.

  The Kubernetes backend applies an operator-authored set of k3s/Kubernetes manifests into a
  per-PR namespace over the kube-apiserver (server-side apply), reusing the Kubernetes runner
  backend's shared apiserver client (Bearer ServiceAccount token + custom-CA TLS). Manifests
  are read checkout-free from either the PR repo (co-located) or a separate repo; the URL is
  derived from an ingress host template or read back from an applied Service/Ingress
  LoadBalancer (k3s Traefik / ServiceLB). It is wired symmetrically into the Cloudflare and
  Node facades (the Worker rejects a custom-CA config it can't honor), and local mode can
  point at a developer-run local k3s (its env URL-safety policy is widened to loopback/LAN).
  See `backend/docs/local-k3s-environments.md`.

  BREAKING (pre-1.0):

  - The `environments/connection` register/test wire shape now takes a discriminated `config`
    instead of a bare `manifest`, and the `environment_connections` table gains a `kind`
    column (existing rows backfill to `manifest`).
  - The `EnvironmentProvider` provision request gains optional `runRepo` / `resolveRepoFiles`
    seams (additive).
  - The deployment-wide environment-provider injection option
    (`buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`) is
    removed — native adapters register via `registerEnvironmentBackend` instead.

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0
  - @cat-factory/integrations@0.35.0
  - @cat-factory/orchestration@0.41.2
  - @cat-factory/agents@0.21.16
  - @cat-factory/prompt-fragments@0.9.3
  - @cat-factory/spend@0.10.31

## 0.46.3

### Patch Changes

- 29d8b5d: Harness error handling & observability: structured failure cause, stuck-run diagnosis, and transient API retry.

  - **Structured failure cause.** The executor-harness now reports a structured `failureCause`
    (`inactivity-timeout` | `max-duration` | `agent` | `git` | `api` | `no-usable-output` |
    `no-changes`) and an extended `detail` on a failed job view, alongside the existing one-line
    `error`. The backend prefers the structured cause to classify a failure (→ `AgentFailureKind`
    / `BootstrapFailureKind`) and falls back to the existing error-string regex when it's absent
    (older image, or a manifest pool that doesn't map the cause), so the change is backward
    compatible. The fallback now matches the bootstrap path's regex on BOTH the agent and
    bootstrap paths (a watchdog timeout classifies as `timeout`, not a generic `agent`). A `git`
    operation or an upstream `api` call that fails carries its real cause rather than `agent`.
    The Node/self-hosted runner pool forwards the structured cause/detail too (new optional
    `failureCausePath`/`detailPath` on the pool response manifest), so it isn't Cloudflare-only.
    Container eviction stays facade-detected (the harness never emits the eviction marker). The
    watchdog phrases are centralized so they can't drift from the regex that still reads them.
  - **Stuck-run diagnosis.** An inactivity kill now reports which phase was hung and the last tool
    that ran (e.g. "...likely hung in agent phase; last tool bash 40s ago"), with a per-phase
    timing breakdown in `detail` and on the failure log. A per-job child logger binds the run's
    correlation fields (jobId/repo/branch/kind) onto every line.
  - **Transient API retry.** Opening a PR/MR now retries a transient upstream failure (5xx / 429 /
    network) with bounded, abort-aware exponential backoff (honoring `Retry-After`), so a momentary
    blip no longer fails an otherwise-complete run. The 422/409 "already exists" success paths are
    unaffected.
  - **Surfaced silent degradation.** Checkpoint-push failures, dropped follow-up lines, malformed
    Pi JSONL records, and SIGKILL escalation are now logged at warn with counts instead of being
    swallowed. A final non-newline-terminated Pi event is flushed so its progress/span isn't lost.

  Bumps the `@cat-factory/executor-harness` image to `1.22.0` (and the matching tag in
  `deploy/backend`).

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/orchestration@0.41.1
  - @cat-factory/integrations@0.34.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/spend@0.10.30
  - @cat-factory/prompt-fragments@0.9.2

## 0.46.2

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/integrations@0.34.0
  - @cat-factory/orchestration@0.41.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/prompt-fragments@0.9.1
  - @cat-factory/spend@0.10.29

## 0.46.1

### Patch Changes

- e0f1149: Design-context sources: add Zeplin, generalize the abstraction, drop the Claude Design backend connector.

  - **New source: Zeplin** (`source='zeplin'`, per-workspace Bearer PAT) — a real server-fetchable
    REST handoff source exposing screens, components and design tokens. On by default; a no-op until a
    workspace connects it.
  - **De-Figma-shaped abstraction:** Figma and Zeplin now map into a shared, source-neutral
    `DesignContext` model rendered by `renderDesignContext` (`integrations/documents/design.logic.ts`).
    The per-source prompt fragments collapse into a single `design.context` fragment.
  - **Breaking — Claude Design backend connector removed.** Its only real read path is login-bound
    (Claude Code's `DesignSync` / `/design-sync`, via the user's claude.ai login), so a headless
    multi-tenant backend can never authenticate. The provider, the `'claude-design'` source value, the
    descriptor `credentialScope` field, and the entire per-user `user_document_connections` store
    (D1 + Drizzle tables, repositories, kernel ports, scope-aware `DocumentConnectionService`) are
    removed — all document sources are workspace-scoped again. The supported Claude Design workflow is
    now: `/design-sync` into the repo → commit → agents read it as checkout files. Stale
    `user_document_connections` rows are dropped (D1 migration `0020`, Drizzle drop migration); per the
    pre-1.0 policy there is no data migration.

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/integrations@0.33.0
  - @cat-factory/prompt-fragments@0.9.0
  - @cat-factory/orchestration@0.40.2
  - @cat-factory/agents@0.21.13
  - @cat-factory/spend@0.10.28

## 0.46.0

### Minor Changes

- fc324d2: Add Kubernetes support for executor containers via a universal "agent runner backend"
  abstraction.

  The self-hosted runner pool is generalized into a discriminated runner-backend
  connection (a new `kind` field): `manifest` (the existing BYO HTTP scheduler pool) and
  `kubernetes` (new), with a `registerRunnerBackend` provider-registry seam so future
  backends (Nomad, EKS, …) are a single registry entry + a config variant + a UI form — no
  new table, service, controller, or integration window.

  The Kubernetes backend (`KubernetesRunnerTransport`, target k8s 1.35+) runs one bare Pod
  per run and reaches the per-pod executor-harness through the kube-apiserver **pod-proxy
  subresource** (Bearer ServiceAccount token), so the orchestrator needs only HTTPS to the
  apiserver — no in-cluster networking or per-run Service — and full `RunnerJobView`
  fidelity is preserved with zero executor-harness changes. It is wired symmetrically into
  both the Cloudflare and Node facades (and local mode via Node), and surfaced in the
  existing runner-backend Integrations window via a backend-type selector.

  BREAKING (pre-1.0): the `runner-pool/connection` register/test wire shape now takes a
  discriminated `config` instead of a bare `manifest`, and the `runner_pool_connections`
  table gains a `kind` column (existing rows backfill to `manifest`). The
  `executor-harness` image is unchanged (no image/tag bump).

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/integrations@0.32.0
  - @cat-factory/orchestration@0.40.1
  - @cat-factory/agents@0.21.12
  - @cat-factory/prompt-fragments@0.8.9
  - @cat-factory/spend@0.10.27

## 0.45.0

### Minor Changes

- e3b3540: feat(environments): durable, asynchronous environment-provider config-repair agent

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  re-validation still fails) and the caller passed `allowAgentFallback`, the engine dispatches a
  coding agent that fixes the provider's config file in an existing repo and pushes the fix back.
  That repair is now a **durable, asynchronous, observable run** — modelled exactly on the
  "bootstrap repo" flow — instead of being awaited synchronously inside the `bootstrapRepo` HTTP
  request (a ~20-minute in-request poll loop that could not survive on the Cloudflare Worker).

  - The repair is its own `kind='env-config-repair'` run in the unified `agent_runs` table (no DB
    migration — the table is kind-scoped), driven durably by **Cloudflare Workflows**
    (`EnvConfigRepairWorkflow`) ⇄ **Node pg-boss** (`env-config-repair.advance` queue), and
    re-driven by the existing cron / stale-run sweeper on either runtime. Local mode inherits the
    pg-boss driver via `buildNodeContainer`.
  - `ContainerEnvConfigRepairer` (`@cat-factory/server`) is reworked into the kernel
    `EnvConfigRepairer` port (`startRepair`/`pollRepair`/`stopRepair`) — dispatch returns
    immediately; the durable runner polls. It still dispatches a plain `coding` job (no `bootstrap`
    block, no PR, no force-push), distinct from the repo-bootstrap flow.
  - `bootstrapRepo` now **starts** the repair run and returns immediately with `usedAgent:true`,
    `repairJobId`, and `ok:false` (pending); the new `EnvConfigRepairService` re-validates the repo
    on completion (via a callback into `EnvironmentConnectionService`, where the decrypted secrets +
    manifest config live) and records the terminal `ok`/`issues`. In PR mode the fix is targeted at
    the config PR branch, not the target branch.
  - The run is observable: progress/outcome is pushed as an `env-config-repair` workspace event and
    carried on the workspace snapshot (`envConfigRepairJobs`); the SPA holds it in the agentRuns
    store and rides the unified `agent-runs` retry/stop endpoints (the new kind supports both —
    retry re-starts a fresh run from the failed job's coords). There is no board block — a repair is
    surfaced only on the infrastructure-providers surface that triggered it.
  - Wired symmetrically across the Cloudflare, Node and local facades, with a cross-runtime
    conformance assertion (`driveEnvConfigRepair` + a fake `EnvConfigRepairer`) that drives a repair
    to `succeeded` with the post-repair validation recorded on both D1 and Postgres. Gated on the
    container prerequisites plus a provider that supports `describeRepairAgent`, so a stock
    deployment running the generic manifest provider is unchanged.
  - The original bootstrap `inputs` (which shape the repair agent's prompt) are persisted on the
    run record (internal, never on the wire), so a retry re-dispatches a fresh run with the SAME
    prompt context via `EnvConfigRepairService.retry` instead of dropping them.

  Breaking (pre-1.0, no migration): the `dispatchConfigRepair` /
  `CoreDependencies.dispatchEnvConfigRepair` seam is replaced by the `EnvConfigRepairer` /
  `EnvConfigRepairRunner` / `EnvConfigRepairJobRepository` ports + `Core.envConfigRepair`; any
  in-flight synchronous repair shape is obsolete.

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0
  - @cat-factory/integrations@0.31.0
  - @cat-factory/orchestration@0.40.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/prompt-fragments@0.8.8
  - @cat-factory/spend@0.10.26

## 0.44.0

### Minor Changes

- 704c99e: Fill the gaps in Linear support:

  - **Connection pagination**: the Linear task source now walks the `children` and
    `comments` GraphQL connection cursors, so an epic with more than one page of
    sub-issues imports its full child set (no longer silently capped at ~50) — matching
    the Jira provider's epic-children pagination.
  - **Team picker for ticket filing**: a new `GET /workspaces/:ws/task-sources/linear/teams`
    endpoint lists the connected workspace's Linear teams, and the issue-tracker settings
    UI offers a searchable (typeahead) team picker instead of requiring a hand-pasted team
    UUID.
  - **OAuth connect flow**: Linear can now be connected via OAuth ("Connect with Linear")
    in addition to a personal API key. The OAuth app credentials (client id / secret /
    redirect URL) are configured **per account in the UI** (account Deployment settings,
    sealed in the DB and resolved dynamically — mirroring the Slack OAuth model), NOT via
    env vars, so an admin can set/rotate them without a redeploy. Absent ⇒ only the manual
    API-key path is offered. The exchanged access token is stored as the connection and
    used as a `Bearer` token across import, search, ticket filing and PR writeback.
  - **Search exact-ref match**: pasting a Linear issue identifier or URL into search now
    resolves and surfaces that exact issue first (de-duped against the term hits), like the
    GitHub Issues source.

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/integrations@0.30.0
  - @cat-factory/contracts@0.46.0
  - @cat-factory/orchestration@0.39.2
  - @cat-factory/agents@0.21.10
  - @cat-factory/kernel@0.47.2
  - @cat-factory/prompt-fragments@0.8.7
  - @cat-factory/spend@0.10.25

## 0.43.0

### Minor Changes

- 2961b05: Meaningfully widen GitLab support in local mode — a `GITLAB_PAT` deployment now drives the
  real agent workflow, not just sign-in:

  - **`@cat-factory/gitlab`** adds `asGitHubClient(...)`, a `VcsClient`→`GitHubClient` adapter so
    any provider-neutral VCS client (e.g. `FetchGitLabClient`) satisfies the legacy `GitHubClient`
    port the engine's CI gate, merger and repo-read paths still consume.
  - **`@cat-factory/server`** resolves a run's repo origin (clone URL + provider) through an
    injectable `resolveRepoOrigin` seam and stamps the provider onto the dispatched job, instead
    of hardcoding a `github.com` clone URL. The default stays GitHub, so the Worker/Node facades
    are unchanged; a GitLab deployment supplies a GitLab origin so containers clone the right host
    and open merge requests. Without this the clone URL was always github.com, so a GitLab repo
    could never be cloned by an agent container.
  - **`@cat-factory/node-server`** threads `resolveRepoOrigin` through `NodeContainerOptions` to
    the container executor (default GitHub), so a sibling facade can supply a GitLab origin.
  - **`@cat-factory/local-server`** wires a GitLab PAT symmetrically to the GitHub PAT: the agent
    containers' git clone/push token falls back to `GITLAB_PAT`; the CI gate, mergeability, real
    merge and repo-link flows read through a PAT-backed `FetchGitLabClient` (adapted to
    `GitHubClient`); the agent containers clone the configured GitLab host + open merge requests
    (via `resolveRepoOrigin`); and the GitLab host is added to the harness clone/push allow-list
    (`GITHUB_ALLOWED_HOSTS`) so the container doesn't reject the GitLab clone URL. A GitLab-only
    local deployment is now a first-class source-control backend. Set `GITLAB_API_BASE` for a
    self-managed instance. The boot warning and the cross-provider `vcs-conformance` test cover
    both providers.
  - **`@cat-factory/executor-harness`** opens a GitLab **merge request** (not a GitHub PR) when the
    job's `repo.provider` is `gitlab` (set authoritatively by the server, so a self-managed GitLab
    on an arbitrarily-named host is routed correctly), falling back to host inference from the
    clone URL. The REST base + project path are derived from the host, and an already-open MR is
    reused on a resumed run. The GitHub path is unchanged. (The runner image must be republished
    for this to take effect in a deployed worker.)

## 0.42.1

### Patch Changes

- Updated dependencies [5ad45de]
  - @cat-factory/orchestration@0.39.1

## 0.42.0

### Minor Changes

- 3d0b85c: feat(environments): wire the live environment-provider config-repair agent (PR #416 increment 2)

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  post-commit re-validation still fails) and the caller passed `allowAgentFallback`, the engine now
  dispatches a coding agent that clones the target repo at the write branch, fixes the provider's
  config file in place, and pushes the fix back onto the same branch — then `EnvironmentConnectionService`
  re-validates.

  - New `ContainerEnvConfigRepairer` (`@cat-factory/server`) dispatches a plain `coding` job via the
    shared `RunnerJobClient`/`RunnerTransport` (no `bootstrap` block, no PR) and awaits it. It is
    distinct from the repo-bootstrap flow — it never reinitialises history or force-pushes.
  - The `dispatchConfigRepair` / `CoreDependencies.dispatchEnvConfigRepair` seam now returns `void`
    (it only pushes the fix); re-validation moved into `EnvironmentConnectionService`, where the
    decrypted secrets + manifest config live.
  - Wired symmetrically across the Cloudflare and Node facades (local inherits via `buildNodeContainer`),
    gated on the container prerequisites plus an injected provider that supports `describeRepairAgent`,
    so a stock deployment running the generic manifest provider is unchanged.

### Patch Changes

- Updated dependencies [3d0b85c]
  - @cat-factory/integrations@0.29.0
  - @cat-factory/orchestration@0.39.0

## 0.41.1

### Patch Changes

- c2ec53b: Local mode: env-PAT sign-in that's remembered across restarts.

  Local-mode sign-in is now purely **provider selection** — a "Sign in with configured
  GitHub/GitLab PAT" button for whichever of `GITHUB_PAT` / `GITLAB_PAT` is set in env. The
  paste-a-token textarea is **removed**: a pasted token only ever resolved an identity (it never
  became the operational clone/push token, which comes from env), so it was a dead-end. When
  neither PAT is configured, the login screen shows an informational notice (with scopes-preset
  token-creation links) instead of an empty form; email/password sign-in is unchanged.

  The chosen provider (a non-secret label — never the token) is remembered in `localStorage`, so
  on a later load the SPA silently re-mints a session from the env PAT without showing the login
  screen. Logout clears it (so logout sticks, no re-login loop); a transient/expiry 401 keeps it
  so the next load re-mints rather than bouncing to the login screen. The PAT never leaves the
  server.

  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are now **required** in local mode (no longer
  auto-generated per process). The per-process auto-generation was the original cause of "re-enter
  the PAT every restart" — a fresh session secret each boot invalidated the persisted session, and
  a fresh encryption key orphaned credentials sealed at rest. Boot now **fails loudly** with an
  actionable message when either is unset. A new `pnpm secrets` script in `deploy/local` prints
  both in the correct format (cross-platform, no `openssl` needed) to paste into `.env`.

  **Breaking (pre-1.0, no migration):**

  - the `localMode.patLogin.available` field is removed from the auth-config wire shape; only
    `configured` + `setupUrls` remain.
  - local mode no longer auto-generates `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`; both must be set
    in the environment (generate via `pnpm secrets`).

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/agents@0.21.9
  - @cat-factory/integrations@0.28.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/orchestration@0.38.1
  - @cat-factory/prompt-fragments@0.8.6
  - @cat-factory/spend@0.10.24

## 0.41.0

### Minor Changes

- 4b5d267: Environment provider repo-config lifecycle: validate + bootstrap (+ agent-repair seam)

  Adds optional `EnvironmentProvider` capabilities so a native adapter (e.g. a future Kargo
  adapter) can manage its config file inside the deployed repo:

  - `validateRepo` — mechanical repo-config validation, run on-demand
    (`POST /environments/connection/validate-repo`) and as a provision pre-flight gate that
    fails synchronously before `provider.provision()` instead of as an async failed environment.
  - `describeBootstrapInputs` + `bootstrapProviderConfiguration` — mechanically generate the
    config file from UI-collected variables; the engine commits it (idempotent; optional PR) and
    re-validates (`POST /environments/connection/bootstrap-repo`).
  - `describeRepairAgent` — agent-repair prompt + dispatch seam (the live engine dispatch is
    scaffolded but not yet wired; see `backend/docs/env-lifecycle.md`).

  All repo I/O flows through the existing VCS-neutral `RepoFiles` abstraction, so the provider
  never sees a VCS host or token (GitHub today, GitLab later). The provider descriptor now
  carries `supportsRepoValidation` / `supportsRepoBootstrap` / `bootstrapInputs`. The generic
  `HttpEnvironmentProvider` implements none of these, so manifest-driven providers are unchanged.

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/integrations@0.28.0
  - @cat-factory/orchestration@0.38.0
  - @cat-factory/agents@0.21.8
  - @cat-factory/spend@0.10.23
  - @cat-factory/prompt-fragments@0.8.5

## 0.40.3

### Patch Changes

- 0784fe0: ExecutionService split (take 2), phase 5: group the gate-window actions into per-feature
  sub-facades. The dedicated review/test windows drove a parked gate through ~30 near-identical
  3-line delegations on `ExecutionService` (`reviewRequirements` / `incorporateClarity` /
  `proceedBrainstorm` / `confirmHumanTest` / `approveVisualConfirm` / …), bloating its public
  surface. They are now grouped into cohesive sub-facades exposed as getters on the still-injected
  `executionService` — `.requirementsReview` / `.clarityReview` / `.brainstorm` / `.humanTest` /
  `.visualConfirm` — and the matching server controllers call through them
  (`executionService.requirementsReview.review(...)` etc.). The composition roots are untouched
  (the single `executionService` is still what every facade injects), so the runtimes stay
  symmetric. No behaviour change.
- Updated dependencies [0784fe0]
- Updated dependencies [0784fe0]
  - @cat-factory/orchestration@0.37.3

## 0.40.2

### Patch Changes

- Updated dependencies [5e54936]
- Updated dependencies [5e54936]
  - @cat-factory/orchestration@0.37.2

## 0.40.1

### Patch Changes

- Updated dependencies [cc101a7]
  - @cat-factory/orchestration@0.37.1

## 0.40.0

### Minor Changes

- 8727f2b: Filesystem blob backend + UI-managed, per-account content storage.

  - New `FilesystemBinaryBlobBackend` (Node/local) stores binary artifacts (UI-tester
    screenshots, reference designs) on disk under a base path (default `.file-storage`,
    git-ignored). Added `'fs'` to `BinaryArtifactStorageKind`.
  - Content-storage configuration moves entirely into the UI, scoped per **account**
    (Account → Deployment settings), stored in `account_settings` (no DB migration; the
    S3 access keys are sealed in the existing secrets blob). The blob backend is now
    resolved per request/run from the account's settings via the new
    `makeResolveBinaryArtifactStore` seam (`@cat-factory/server`), replacing the static
    `binaryArtifactStore` on the container with a `resolveBinaryArtifactStore(workspaceId)`.
  - Available backends per runtime: **Node/local** offer `fs` / `s3` / `db`, **Cloudflare**
    offers `r2` only (S3 is deliberately not offered on the Worker — the AWS SDK does not belong
    in the Worker bundle). Defaults when an account hasn't configured storage: **local** defaults
    to the filesystem backend (works out of the box); **Node** defaults to off (storage requires
    explicit configuration); **Cloudflare** defaults to its R2 bucket.

  BREAKING: the env-var content-storage configuration is removed — `BINARY_STORAGE_BACKEND`,
  `S3_ARTIFACT_*`, and `AppConfig.binaryStorage`/`BinaryStorageConfig` no longer exist.
  Configure storage per-account in the UI instead. Switching an account's backend orphans its
  previously-stored artifacts (no migration of existing bytes), which is acceptable pre-1.0.

- 56e6ce6: Local mode: sign in with a source-control PAT (GitHub or GitLab) or email/password.

  Local mode previously ran fully anonymous (dev-open, no user), so per-user features —
  personal subscriptions, your own API keys — failed with 401 ("Sign in to manage …") with
  no way to sign in. Local mode now establishes a real identity:

  - A new provider-agnostic `VcsIdentityResolver` port (kernel) turns a raw PAT into a
    neutral identity (the provider's stable numeric user id — the SAME subject GitHub OAuth
    uses, so a PAT login and an OAuth login resolve to one canonical user). GitHub and GitLab
    resolvers ship in `@cat-factory/server` / `@cat-factory/gitlab`; adding an Nth provider is
    one more resolver entry, no endpoint or UI changes.
  - A new `POST /auth/pat` endpoint (served only where resolvers are wired — local mode)
    mints a session for the account a PAT belongs to. The local login screen offers one-click
    "Continue with GitHub/GitLab" when a `GITHUB_PAT`/`GITLAB_PAT` is configured, an inline
    "paste a PAT" form otherwise, and email/password sign-in (enabled by default in local
    mode, with open signup on the developer's own machine).
  - The SPA now requires sign-in in local mode (anonymous use can't store per-user
    credentials); the session is honored even though the API otherwise runs dev-open.
  - `'gitlab'` is now an identity provider. Identities remain collision-safe via the
    `(provider, subject)` key: a GitHub user and a GitLab user with the same numeric id, and
    a password account (keyed on email), are always distinct.

  Also adds a guard on the per-user credential forms (personal subscriptions, your own API
  keys): when there is genuinely no signed-in user (a non-local deployment running with auth
  disabled), the inputs are blocked with a clear notice instead of accepting data that can't
  be saved.

  BREAKING (local mode only): existing anonymously-created local boards have no owner, so
  after upgrading they become inaccessible once sign-in is required — recreate them under
  your signed-in account. (Pre-1.0, no data migration.)

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/orchestration@0.37.0
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0
  - @cat-factory/integrations@0.27.0
  - @cat-factory/agents@0.21.7
  - @cat-factory/spend@0.10.22
  - @cat-factory/prompt-fragments@0.8.4

## 0.39.8

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/integrations@0.26.5
  - @cat-factory/orchestration@0.36.5
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5
  - @cat-factory/agents@0.21.6
  - @cat-factory/prompt-fragments@0.8.3
  - @cat-factory/spend@0.10.21

## 0.39.7

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/agents@0.21.5
  - @cat-factory/integrations@0.26.4
  - @cat-factory/kernel@0.45.4
  - @cat-factory/orchestration@0.36.4
  - @cat-factory/prompt-fragments@0.8.2
  - @cat-factory/spend@0.10.20

## 0.39.6

### Patch Changes

- 7d219ab: Allow the `X-Connection-Id` request header in CORS so the SPA can reach the backend.

  The SPA sends `X-Connection-Id` on every API call (the per-tab connection id for real-time
  self-echo suppression), but the Worker's CORS preflight only allow-listed
  `Content-Type, Authorization, X-Personal-Password`. The browser's preflight asked permission
  for `x-connection-id`, the response omitted it, so the browser dropped every cross-origin
  request with "CORS Missing Allow Header" and the board failed to load ("Can't reach the
  backend"). curl/server-side callers were unaffected because they don't send the header.

  Move the allow-list to a single shared `CORS_ALLOWED_HEADERS` constant in
  `@cat-factory/server` (now including `X-Connection-Id`) and use it in both runtime facades.
  The Node facade previously passed no `allowHeaders` and so let Hono echo the requested
  headers, which silently masked the drift; it now uses the same explicit list as the Worker.

## 0.39.5

### Patch Changes

- ab146e5: Suppress the real-time self-echo for board moves/reparents so dragging a task several
  times in quick succession is reliable. The SPA now tags every request with a stable
  per-tab connection id (`X-Connection-Id`) and the realtime WebSocket connect with the
  matching `?cid=`; the board `move`/`reparent` controllers forward it through
  `BoardService` to `boardChanged`, and both realtime hubs (the Cloudflare
  `WorkspaceEventsHub` Durable Object and the Node `NodeRealtimeHub`) skip delivering the
  coarse `board` event back to the connection that caused it. The originating client keeps
  its optimistic state plus its own authoritative REST response instead of refreshing off
  its own move (a mid-flight snapshot of which carried a stale position, snapping the block
  back). Other subscribers still receive the event and refresh.
- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/orchestration@0.36.3
  - @cat-factory/agents@0.21.4
  - @cat-factory/integrations@0.26.3
  - @cat-factory/spend@0.10.19

## 0.39.4

### Patch Changes

- 1a349b5: Drop persisted agent failures carrying a removed kind so a stale row can't brick the board.

  `decision_timeout` was removed from the `AgentFailure` kind picklist when human decisions
  stopped being timeout-limited. A run that failed before then still carries the obsolete kind
  in its persisted failure JSON, which violates the now-closed picklist. Because the server
  ships rows without validating them against the contract, one stale failure made the SPA's
  response validation reject the entire workspace snapshot ("Can't reach the backend").

  The three failure-column parsers (the shared execution mapper plus both runtimes' bootstrap
  repositories) now drop a failure whose kind is no longer known, via the new shared
  `isKnownAgentFailureKind` predicate. The run's `status` + `error` string still describe what
  happened. This repair is temporary and marked for removal after the 2026-07-15 migration
  grace cutoff.

## 0.39.3

### Patch Changes

- 80e5fc9: Repair pre-#94 numeric user ids on read so a stale row can't brick the board.

  PR #94 re-keyed user ids (block `createdBy`, execution `initiatedBy`) from the GitHub
  numeric id to the canonical `usr_*` string with no data migration. The wire contract now
  types these as `string | null`, and the server ships rows without validating them against
  the contract, so a single pre-#94 row made the SPA's response validation reject the entire
  workspace snapshot and the board failed to load with "Can't reach the backend".

  The shared row→domain mapper (used by both the D1 and Drizzle stores) now drops a
  non-string legacy id to null on read. The stale number is an old GitHub id that matches no
  `usr_*` user, so dropping it loses nothing real. This repair is temporary and marked for
  removal after the 2026-07-15 migration grace cutoff.

## 0.39.2

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/contracts@0.43.1
  - @cat-factory/integrations@0.26.2
  - @cat-factory/kernel@0.45.2
  - @cat-factory/orchestration@0.36.2
  - @cat-factory/prompt-fragments@0.8.1
  - @cat-factory/spend@0.10.18

## 0.39.1

### Patch Changes

- Updated dependencies [5363166]
- Updated dependencies [5363166]
  - @cat-factory/orchestration@0.36.1
  - @cat-factory/kernel@0.45.1
  - @cat-factory/agents@0.21.2
  - @cat-factory/integrations@0.26.1
  - @cat-factory/spend@0.10.17

## 0.39.0

### Minor Changes

- eab73b8: feat(documents): add Claude Design as a per-user design-context document source

  Implements the Claude Design half of the design record in
  `backend/docs/figma-claude-design-context.md`. Claude Design becomes a new
  `DocumentSourceProvider` (`source='claude-design'`) that reuses the whole documents
  integration (link plumbing, controller, `.cat-context/` materialization, prompt
  fragment), with a deterministic design-system normalizer that turns a project's
  `_ds_manifest.json` / `@dsCard`-marked component HTML + CSS custom properties into the
  same `### Components` / `### Design tokens` Markdown shape the Figma provider emits — so
  it earns its place over a plain HTML upload.

  Auth is a **personal per-user PAT**, supported on every runtime: a new descriptor flag
  `credentialScope: 'user'` routes such a source to a new per-user
  `user_document_connections` store (D1 ⇄ Drizzle, encrypted at rest under a distinct HKDF
  info), keyed by the acting user and never shared with the workspace. `DocumentConnectionService`
  becomes scope-aware; the import path threads the acting user. Workspace-scoped sources
  (Notion/Confluence/GitHub/Figma/Linear) are unchanged. The acting user falls back to the
  empty user id ONLY when auth is disabled (dev-open / single-user local mode) so those
  deployments still connect; when auth is enabled the controller fails closed with a 401
  rather than silently using the shared empty-user bucket.

  Claude Design is **opt-in**, not on by default: its credentialed project-read API is
  still provisional (the read is claude.ai-login-bound, no per-user service token yet), so
  it is excluded from the default `DOCUMENT_SOURCES` set and must be enabled explicitly
  (`DOCUMENT_SOURCES=…,claude-design`) once the API is real — every other source stays on
  by default.

  Also hoists the host-pinned `safeFetch`/SSRF guard/capped-read into a shared
  `documents/http.ts` reused by Figma and Claude Design. Wired symmetrically into both
  facades and gated by a new cross-runtime conformance case (per-user connect → list →
  disconnect).

- eab73b8: feat(documents): add Figma as a design-context document source

  Implements the Figma half of the design record in
  `backend/docs/figma-claude-design-context.md`. Figma becomes a new
  `DocumentSourceProvider` (`source='figma'`) authenticated by a per-workspace
  personal access token, reusing the whole documents integration (connection table,
  sealing, link plumbing, controller, `.cat-context/` materialization). `fetchDocument`
  renders a frame/file's layout tree, text, components-used and (Enterprise-gated)
  design tokens to Markdown, with a best-effort rendered-preview URL on a reference
  line. Wired symmetrically into both the Cloudflare and Node facades (and the
  `DOCUMENT_SOURCES` allow-list), gated by a cross-runtime conformance case. Adds the
  `design.figma-context` prompt fragment for frontend agents. (Claude Design ships in a
  companion changeset.)

  Also makes a URL pasted into a block description auto-match its imported document by the
  document's stable `(source, externalId)` — canonicalised through the providers'
  `parseRef` (`AgentContextBuilder.documentUrlResolver`) — instead of by exact URL-string
  equality, which silently failed for a real Figma share link (title path segment, dash
  node id, `&t=` tracking params) whose canonical stored `url` omits that noise.

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0
  - @cat-factory/integrations@0.26.0
  - @cat-factory/orchestration@0.36.0
  - @cat-factory/prompt-fragments@0.8.0
  - @cat-factory/agents@0.21.1
  - @cat-factory/spend@0.10.16

## 0.38.1

### Patch Changes

- Updated dependencies [67c7196]
  - @cat-factory/orchestration@0.35.1

## 0.38.0

### Minor Changes

- e641417: Add a document-authoring pipeline and a richer document task definition.

  **Reviewers now read the real repository.** The `reviewer` (code) and `doc-reviewer`
  companions run as read-only container reviewers: they clone the producer's PR branch and
  read the ACTUAL changed files / committed document with tools before rating, instead of
  grading the producer's summary reply (a review of a summary is worthless). They are
  dispatched through the same async container path the coder/merger use and return their
  verdict as structured JSON, resolved by the same threshold / rework-loop / human-gate
  handling as before. Inline companions (`architect-companion` / `spec-companion`) are
  unchanged. A container companion is gated on a wired sandbox like any other container kind.

  A new forward-authoring track produces an in-repo Markdown document (PRD / RFC / design
  doc / ADR / technical reference / runbook / research report) shipped as a pull request —
  distinct from the reverse-documentation kinds (`documenter` / `business-documenter` /
  `blueprints`) that describe existing code. Four new agent kinds are registered through the
  public `registerAgentKind` seam — `doc-researcher` and `doc-outliner` (inline), `doc-writer`
  (container-coding, opens the PR coder-style) and `doc-finalizer` (container-coding, polishes
  on the PR branch) — plus a `doc-reviewer` companion that loops the writer back for rework.

  Two built-in pipelines are seeded: `pl_document` (research → outline [human gate] → write →
  AI review loop [human gate] → finalize → conflicts → ci → merger) and `pl_document_quick`.

  The `document` task type gains a wider `docKind` set (`prd`/`rfc`/`adr`/`design`/`technical`/
  `api`/`runbook`/`research`/`reference`/`other`) and optional `audience`, `targetPath` and
  `outlineHints` fields, threaded into the agent context so the document agents specialise their
  prompts. No new persisted tables — the committed Markdown is the durable artifact.

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/orchestration@0.35.0
  - @cat-factory/integrations@0.25.2
  - @cat-factory/prompt-fragments@0.7.41
  - @cat-factory/spend@0.10.15

## 0.37.0

### Minor Changes

- bbafec9: Add `@cat-factory/gitlab`: the opt-in GitLab VCS provider, the proof-of-concept
  second backend for the provider-neutral VCS abstraction. It implements the
  neutral `VcsClient` (repo/branch/MR/issue/CI reads + writes over the GitLab REST
  v4 API), a `VcsWebhookVerifier` + `VcsWebhookMapper` (constant-time
  `X-Gitlab-Token` check; `Merge Request`/`Issue`/`Push`/`Pipeline` hooks →
  neutral events), and a `VcsProvisioningClient`, and registers itself via
  `registerGitLab()` → `registerVcsProvider('gitlab')`. Depends only on
  `@cat-factory/kernel` + `@cat-factory/contracts`. Also refines the kernel
  `VcsWebhookMapper` port to take the resolved connection as a parameter.

  The provider is now WIRED into all runtime facades (single-token model, mirroring
  local-mode's PAT): a `GITLAB_TOKEN` (+ optional `GITLAB_API_BASE` /
  `GITLAB_CONNECTION_ID` / `GITLAB_WEBHOOK_SECRET`) enables it, the Worker + Node
  facades call `registerGitLab()` at container build (local inherits Node), and a
  new provider-neutral webhook receiver `POST /vcs/:provider/webhooks`
  (`@cat-factory/server`) verifies the signature against the registered
  `VcsWebhookVerifier`, maps the delivery via the registered `VcsWebhookMapper`, and
  hands the neutral event to the optional `VcsWebhookSink` kernel port. Adds a
  `GitLabConfig` to `AppConfig` and `vcsWebhookSink` to the server container.

  Bug fixes to the GitLab adapter: mergeability now prefers `detailed_merge_status`
  and only maps a genuine `conflict` to the `dirty` state the conflicts gate
  escalates on (a non-conflict block — CI pending, unresolved discussions, behind
  target — no longer spuriously spawns a conflict-resolver); `commitFiles` pins the
  commit parent via `start_sha` when `baseSha` is given; `getFileContent` resolves
  the project default branch instead of an unreliable `HEAD`; listing truncation at
  the page cap is now surfaced via an optional logger; the webhook mapper takes an
  injected `Clock` (deterministic timestamps) and reads the issue author.

  NOT yet migrated: the existing execution consumers (`resolveRepoTarget`, the
  CI/mergeability/merger/repo-files providers, the `github_*` projection
  persistence) still key on the GitHub installation id — projecting a neutral
  webhook event into provider-aware persistence is the remaining strangler step.

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/agents@0.20.3
  - @cat-factory/integrations@0.25.1
  - @cat-factory/orchestration@0.34.1
  - @cat-factory/spend@0.10.14

## 0.36.3

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/integrations@0.25.0
  - @cat-factory/orchestration@0.34.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/kernel@0.42.2
  - @cat-factory/prompt-fragments@0.7.40
  - @cat-factory/spend@0.10.13

## 0.36.2

### Patch Changes

- Updated dependencies [6903cd7]
  - @cat-factory/orchestration@0.33.0

## 0.36.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/integrations@0.24.1
  - @cat-factory/orchestration@0.32.1
  - @cat-factory/prompt-fragments@0.7.39
  - @cat-factory/spend@0.10.12

## 0.36.0

### Minor Changes

- 32c653f: Add a runtime-neutral binary-artifact storage abstraction (the foundation for the
  visual-confirmation gate's UI screenshots + reference design images).

  - New kernel port `BinaryArtifactStore` with a split, mix-and-match seam: a per-runtime
    `BinaryArtifactMetadataStore` (the queryable metadata) + a pluggable `BinaryBlobBackend`
    (the bytes — the "custom adapter interface"), composed by `createBinaryArtifactStore`.
  - Adapters: D1 metadata + R2 blob backend (Cloudflare — D1 can't hold large values, so
    bytes always go to R2); Drizzle/Postgres metadata + a Postgres `bytea` blob backend
    (Node/local, size-guarded); and a new opt-in `@cat-factory/provider-s3` package
    implementing the blob backend over an S3 (or S3-compatible) bucket.
  - Metadata table `binary_artifacts` mirrored D1 ⇄ Drizzle; a Node-only
    `binary_artifact_blobs` `bytea` table backs the `db` backend (no D1 equivalent).
  - `AppConfig.binaryStorage` selects the backend (`db` | `r2` | `s3`); wired in all three
    facades and surfaced on the request container. New workspace-scoped artifact API
    (upload reference / stream blob / list a run's artifacts). Cross-runtime conformance
    suite `defineBinaryArtifactsSuite` asserts store parity on both runtimes.

- 32c653f: Add the Visual Confirmation gate and split the tester into an API + UI tester.

  - **Tester split:** the `tester` kind is renamed to `tester-api` (general/API exploratory
    testing) and a new `tester-ui` kind drives a real browser (Playwright), captures a
    non-redundant screenshot of each distinct view, uploads them to the binary-artifact
    store, and reports them under `TestReport.screenshots[]`. Both share the Tester→Fixer
    loop and the `tester.environment` infra choice (`isTesterKind`). The UI tester dispatches
    with `image:'ui'` so a transport can route it to a dedicated Playwright/browser image.
  - **Visual Confirmation gate** (`visual-confirmation`): a park-on-decision engine gate
    (modelled on `human-test`) that gathers the UI tester's screenshots + the human-uploaded
    reference design images (paired by view) and parks for a person to review actual-vs-reference.
    The human approves (advance), requests a fix (dispatches the Tester's `fixer`, then re-parks),
    or recaptures. Raises a `visual_confirmation_ready` notification; passes through when no
    binary-artifact store is wired. New `pl_visual` pipeline (`… tester-ui → visual-confirmation
→ merger`) and the `GET /blocks/:id/artifacts` + visual-confirmation action endpoints.
  - Cross-runtime conformance covers the gate's no-store pass-through and the artifact store's
    `listByBlock`.

  BREAKING: the `tester` agent kind is renamed to `tester-api`. Per this repo's pre-1.0 policy
  (no backwards-compatibility shims), any persisted state that still names `tester` simply stops
  matching: a saved/custom pipeline referencing `tester` is detected as outdated and reseeded from
  the catalog, and an execution that is parked mid-`tester` at upgrade time will no longer be
  recognised by the tester gate (re-run the task). New runs are unaffected — the seeded pipelines
  all use `tester-api`.

  NOTE: the dedicated UI-tester container image (Playwright/Chromium) and the per-kind image
  routing into it (a second Cloudflare container class; image-per-step on the local/pool
  transports) are a deploy-time follow-up — the `image:'ui'` dispatch seam is in place. Until that
  routing AND the harness env-passthrough (`ARTIFACT_UPLOAD_URL`/`ARTIFACT_UPLOAD_TOKEN` + a
  Playwright driver) land, `tester-ui` has no browser and the `pl_visual` gate runs in MANUAL mode
  (a human uploads references + screenshots and reviews them), which is why `pl_visual` is flagged
  `experimental`.

- 32c653f: Harden + complete the Visual Confirmation gate / binary-artifact storage after review.

  - **Security (artifact serving):** the artifact upload + blob endpoints now pin the content
    type to a raster-image allow-list (`png`/`jpeg`/`webp`/`gif`, SVG/HTML rejected `415`) at the
    write boundary, and serve blobs with `X-Content-Type-Options: nosniff` + a clamped
    `Content-Type`/`Content-Disposition` — closing a stored-XSS vector where an attacker-controlled
    type could be served inline same-origin. Shared `imageArtifacts.ts` keeps the workspace upload
    and the in-container ingest paths consistent.
  - **Configurable artifact retention (new):** a per-workspace `artifactRetentionDays` setting
    (default 14, bounded 1–3650), editable in the workspace settings panel. A daily Cloudflare cron
    / hourly Node timer sweep prunes each workspace's screenshots + reference images past its window
    — BOTH the metadata rows and the bytes (`BinaryArtifactStore.pruneOlderThan`), so the store no
    longer grows unbounded. Mirrored D1 ⇄ Drizzle (migration `0018` / a generated Drizzle migration)
    and asserted by the cross-runtime binary-artifacts conformance suite.
  - **tester-ui ingest seam (backend half):** `ContainerAgentExecutor` injects an `artifactUpload`
    `{ url, token }` into the `tester-ui` job body, reusing the run's existing container session
    token + proxy base URL, and a new container-token-authed `POST ${proxyBaseUrl}/artifacts/ingest`
    route stores the bytes as a run-scoped `screenshot`. (The UI-tester image routing + harness env
    passthrough remain the deploy-time follow-up — see the handover doc.)
  - **Gate UX:** a `request-fix` that can't dispatch (no PR branch / no async executor) now surfaces
    a reason + records a failed round instead of silently re-parking; after a fix the gate flags that
    the shown screenshots predate it (recapture to refresh); the unused `headSha` placeholder is
    dropped; and the gate window revokes its cached screenshot object URLs on unmount.

### Patch Changes

- 32c653f: Second review pass on the Visual Confirmation gate / binary-artifact storage — hardening + a
  gap-closing follow-up:

  - **Retention no longer orphans bytes.** `BinaryArtifactStore.pruneOlderThan` now keeps a
    metadata row whenever its blob delete fails (instead of dropping the row and orphaning the
    bytes forever), so the next sweep retries it; the all-succeeded path still collapses to one
    bulk delete.
  - **Upload size guarded before buffering.** Both the workspace upload and the in-container
    ingest endpoints reject a grossly oversized body from `Content-Length` BEFORE reading it into
    memory (`exceedsRequestSizeLimit`), with the exact per-file 16 MiB ceiling still enforced after
    parsing.
  - **Per-run screenshot ceiling.** The container ingest route caps a single run at 100 uploaded
    screenshots (`429` past it), so a runaway/compromised container can't fill the blob store.
  - **Consistent content-type posture.** The harness ingest now rejects a recognised non-image
    type (`415`) instead of silently storing it mislabelled as PNG, matching the workspace upload
    endpoint; a typeless upload still defaults to PNG.
  - **Tighter human-upload scoping.** The workspace artifact endpoint ignores any client-supplied
    `executionId` (reference images are block-scoped and precede any run; run-scoped captures come
    through the token-authed ingest, where the run is derived from the verified token).
  - **`created_at` retention index** added on `binary_artifacts` (D1 `0017` + a generated Drizzle
    migration) so the per-workspace prune is an indexed range delete.
  - **`pl_visual` flagged experimental** (`labels: ['experimental']`): until UI-tester image
    routing + harness env-passthrough land, the gate runs in manual mode — the label keeps the
    pipeline discoverable without implying automatic screenshot capture.
  - Removed the unused `capturing` phase from `visualConfirmStepStateSchema` (the auto re-capture
    loop it anticipated is still deferred), and added a cross-runtime conformance test for the
    gate's request-fix → fixer → re-park → approve loop.

  Note (breaking, already in this PR): the `tester` agent kind was renamed to `tester-api` (with a
  new browser-driven `tester-ui` sibling). Per the project's pre-1.0 no-backwards-compat policy,
  custom pipelines/blocks persisted with the old `tester` kind are not migrated and will need to be
  re-pointed at `tester-api`.

- 32c653f: Third review pass on the Visual Confirmation gate / binary-artifact storage:

  - **Frontend build fix.** `VisualConfirmationWindow.vue` still referenced the `capturing`
    phase that round 2 removed from `visualConfirmStepStateSchema` (a TS2353 excess-property
    on `PHASE_LABEL` and a TS2367 no-overlap comparison in `working`), which broke
    `nuxt typecheck`. Dropped both.
  - **Reference re-upload now wins.** `VisualConfirmationController.gatherPairs` kept the
    OLDEST reference image per view (`?? ref.id`), so a human re-uploading a corrected
    reference for a view they already populated never saw it. References are now assigned
    last-writer (newest), matching the oldest-first `listByBlock` ordering.
  - **Upload buffering is now actually bounded.** The `Content-Length` precheck was
    bypassable by a chunked / header-less body, after which `formData()` buffered the whole
    request into memory before the per-file ceiling ran. Both upload routes (workspace +
    in-container ingest) now wrap the body in `hono/body-limit`, which counts bytes as the
    stream is read, so a missing/spoofed `Content-Length` can't buffer past the ceiling.
  - **Per-run screenshot cap holds under concurrency.** The container-ingest cap was a
    check-then-act race; concurrent ingests could each pass it before any row landed. A
    post-insert reconcile now rolls back (deletes) any insert that lands in the overflow
    tail, so the store is bounded to exactly the cap per run without dropping earlier shots.
  - **Removed the vestigial `headSha`** from `visualConfirmStepStateSchema` (and its
    `begin()` initializer) — it was always null and never read; round 1 claimed it was
    dropped but it wasn't.
  - **Reuse:** the harness ingest route now uses the exported `bearerToken` helper instead
    of a fourth private copy of the `Bearer` parser.

- 32c653f: Review round 4 (visual-confirmation gate / binary artifacts):

  - **Don't load the AWS SDK unless S3 is actually used.** `@cat-factory/provider-s3` now imports
    `@aws-sdk/client-s3` lazily (on the first S3 operation) instead of at module load, so a
    Node/local deployment running the `db` (or no) blob backend no longer pays the SDK's load cost
    even though the facade statically imports `S3BinaryBlobBackend` to wire its container.
  - **Guard Approve when the gate flags its screenshots as unreliable.** The visual-confirmation
    window now requires an explicit "I've reviewed this manually" acknowledgement before Approve is
    enabled whenever the gate set a `degradedReason` (no capture happened, a fix failed, or a fix
    landed AFTER the shown screenshots) — so a stale/empty gallery can't be approved in one blind
    click.
  - **Cheaper per-run upload cap.** The harness screenshot ingest precheck uses an indexed
    `countByExecution` (no row materialise) and only runs the post-insert overflow reconcile when the
    insert could actually cross the cap, so the steady-state upload is one COUNT + one insert.
  - **Serve a blob in a single metadata read** via `BinaryArtifactStore.getBlobWithMetadata`.
  - **Drop dangling screenshot refs.** The gate validates the agent-reported screenshot `artifactId`s
    against what the run actually uploaded, so a fabricated id or one removed by the retention sweep
    renders as "not captured" rather than a 404 image.
  - Make the UI-tester prompt honest: it now only instructs an upload when `ARTIFACT_UPLOAD_URL` is
    provided to the run (manual mode otherwise), and treats the reference-design directory as
    optional.

  The new `countByExecution` / `getBlobWithMetadata` store methods are mirrored D1 ⇄ Drizzle and
  asserted by the cross-runtime binary-artifacts conformance suite.

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/orchestration@0.32.0
  - @cat-factory/integrations@0.24.0
  - @cat-factory/spend@0.10.11
  - @cat-factory/prompt-fragments@0.7.38

## 0.35.0

### Minor Changes

- b5231b0: Make prompt-caching a first-class, visible capability and add per-kind progress-guard
  leniency.

  **Caching capability + observability.** `providerCachePolicy` moves to the kernel
  (`domain/cache-policy.ts`, re-exported from `@cat-factory/agents`) so the model catalog
  can derive a per-flavour `ModelOption.cachesPrompts` from the effective provider — the
  same model reads `false` on its cache-less Cloudflare/Workers-AI flavour and `true` once
  a direct key upgrades it to its caching `direct` flavour. The already-recorded
  `cachedPromptTokens` is now aggregated per agent kind in `summarizeByExecution` (D1 +
  Drizzle, kept symmetric) and surfaced as `cachedPromptTokens` + a derived `cacheHitRate`
  on the step rollup and the LLM-metrics export.

  **Vendor-selection UI.** The model picker shows a `Prompt caching` / `No prompt caching`
  badge per flavour, the API-keys panel notes which direct keys enable caching, and the
  step metrics bar shows a cached-token split when present — so a user can see (and act on)
  the hot path running cache-less. Shipped model defaults are intentionally NOT changed;
  extending `providerCachePolicy` to more providers (Moonshot / OpenRouter / LiteLLM) is
  gated on benchmark evidence (see `backend/docs/prompt-caching.md`).

  **Per-kind guard leniency.** The container progress guard can now be loosened per agent
  kind via an optional `guardLimits` job-body field (clamped per knob in the harness;
  merged over the env/built-in defaults — loosen-only, never tighten). A data-driven
  `agentTuningFor` seam (`@cat-factory/agents`, plus an `AgentKindDefinition.tuning` hook
  for custom kinds) supplies the profile, which `ContainerAgentExecutor` folds into the
  dispatch body. Initial profiles give `conflict-resolver` more error headroom and the
  research-heavy kinds a higher consecutive-web cap, so a legitimately-progressing run is
  not killed for its normal pattern. Output-token ceilings are unchanged.

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0
  - @cat-factory/orchestration@0.31.0
  - @cat-factory/integrations@0.23.5
  - @cat-factory/prompt-fragments@0.7.37
  - @cat-factory/spend@0.10.10

## 0.34.0

### Minor Changes

- 6d829bb: Make invalid-state pipelines more robust. On app open, a startup advisory surfaces pipelines that
  reference a nonexistent agent kind or have an invalid shape (delete a custom one, reseed a built-in)
  and built-in pipelines whose seeded definition is newer than the stored copy (reseed to adopt it).

  Built-in pipelines now carry a per-pipeline `version` (persisted on both runtimes via a new D1
  migration and a Drizzle column), the snapshot ships the current catalog versions
  (`pipelineCatalogVersions`), and a new `POST /workspaces/:ws/pipelines/:id/reseed` endpoint restores a
  built-in's canonical definition while preserving its labels/archive state.

  BREAKING: existing workspaces' persisted built-in pipelines have no stored `version`, so they read as
  "update available" once until reseeded — intentional adoption of the now-versioned definitions.

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0
  - @cat-factory/orchestration@0.30.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/integrations@0.23.4
  - @cat-factory/prompt-fragments@0.7.36
  - @cat-factory/spend@0.10.9

## 0.33.0

### Minor Changes

- 714b7c9: Add "forgot my password" self-service reset for password-based logins.

  A user can request a reset link by email (`POST /auth/forgot-password`) and set a new
  password via a one-time, expiring token (`POST /auth/reset-password`). Tokens are stored
  hashed (SHA-256), single-use, and mirror the invitation flow; the reset email is sent
  through a new deployment-level **system** email sender configured via
  `EMAIL_SYSTEM_PROVIDER` / `EMAIL_SYSTEM_FROM` / `EMAIL_SYSTEM_API_KEY` (when unset, the
  link is logged for local/dev). The request endpoint never reveals whether an email is
  registered.

  Schema addition (both runtimes): a new `password_reset_tokens` table (D1 migration
  `0017_password_reset_tokens.sql` ⇄ a Drizzle Postgres migration). No data migration is
  needed — the table starts empty.

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0
  - @cat-factory/orchestration@0.29.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/integrations@0.23.3
  - @cat-factory/prompt-fragments@0.7.35
  - @cat-factory/spend@0.10.8

## 0.32.2

### Patch Changes

- efbd910: Fix the SPA error handling broken by the `@toad-contracts/*` migration.

  The contract client (`sendByApiContract`) reports a contract-declared non-2xx as a plain
  `{ statusCode, headers, body }` value (not an `Error`), with the `{ error: { code, message,
details } }` envelope under `body`. The old `$fetch` threw an ofetch `FetchError` with the
  body under `data` and was always an `Error`. Several handlers still read the old shape, so:

  - `parseCredentialError` returned `null` for every 428, so the personal-subscription
    password modal never opened and individual-usage runs (Claude/Codex/GLM) could not be
    started or retried.
  - `parseConflict` returned `null` for every 409, so run-control conflict toasts lost their
    tailored guidance (including the `providers_unconfigured` "Configure AI" jump).
  - `instanceof Error` message extraction across many catch blocks rendered `"[object Object]"`
    for declared 4xx/5xx, and the login/account/tracker-probe handlers dropped the server's
    message.

  `sendContract` now wraps a bare non-2xx into a real `ApiError` (an `Error` carrying
  `statusCode`, the parsed `body`, and the server's message), and a shared
  `apiErrorEnvelope` / `apiErrorStatus` reads the envelope from either client shape. The
  provisioning-logs query now validates through the contract schema so an invalid query
  returns the standard `{ code: 'validation' }` 400 like every other route. `@cat-factory/contracts`
  gains a `singleStringParam` helper that collapses the one-key path-param schemas the route
  files each re-declared (typing preserved).

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/agents@0.18.3
  - @cat-factory/integrations@0.23.2
  - @cat-factory/kernel@0.38.1
  - @cat-factory/orchestration@0.28.3
  - @cat-factory/prompt-fragments@0.7.34
  - @cat-factory/spend@0.10.7

## 0.32.1

### Patch Changes

- 692ccb4: Refactor the shared block row<->domain mappers to a field-map-driven factory.

  `rowToBlock` / `blockInsertValues` / `blockPatchToColumns` were three hand-enumerated
  functions kept in sync by eye — a new persisted column meant 3–4 coordinated edits and a
  renamed column only surfaced at runtime. They now derive all three directions from a single
  `blockFields` table (one `FieldMapper` per column, with `scalarField` / `optField` /
  `optJsonField` / `optBoolIntField` builders that default the column to the snake_case of the
  property). The genuinely divergent columns (the `position`/`size` composites, the tri-state
  `technical`, and `serviceFragmentIds`/`agentConfig` whose insert vs patch emptiness rules
  differ) stay spelled out inline. Behaviour is unchanged — the existing mapper test suite is
  preserved and extended to cover the tri-state, length-clear, and insert-only columns.

- Updated dependencies [692ccb4]
  - @cat-factory/agents@0.18.2
  - @cat-factory/orchestration@0.28.2

## 0.32.0

### Minor Changes

- a4ea607: Adopt `@toad-contracts/*` for end-to-end typed, validated API contracts.

  The HTTP boundary is now a single source of truth. Each route is defined once with
  `defineApiContract` in `@cat-factory/contracts` (`src/routes/*`) and consumed by both
  sides: the backend mounts it with `@toad-contracts/hono`'s `buildHonoRoute` (method,
  path and request validation derived from the contract; the handler's `c.req.valid(...)`
  inputs and `c.json(body, status)` return are type-checked against it), and the SPA calls
  it with `@toad-contracts/frontend-http-client`'s `sendByApiContract` over `wretch`
  (runtime-validating every response). The frontend wire-type mirror in
  `frontend/app/app/types/*` no longer hand-redefines shapes — it re-exports the inferred
  types from `@cat-factory/contracts`, so backend and frontend can't drift.

  Breaking / notable:

  - `@cat-factory/server` no longer exports `jsonBody`, and drops the
    `@hono/valibot-validator` dependency (request validation now comes from the contract
    via `buildHonoRoute`); request-validation failures still return the same
    `{ error: { code: 'validation', issues } }` 400 envelope, mapped centrally in
    `handleError`.
  - `updateBlockSchema` now accepts `responsibleProductUserId` (it was silently dropped on
    the wire despite the domain block carrying it and the mapper persisting it).
  - The runtime-internal endpoints that are not request/response JSON APIs (the WebSocket
    event stream, the LLM/web-search proxies, the GitHub webhook, the Slack OAuth callback)
    are intentionally left on plain Hono routing.
  - The wire-returned shapes that the kernel ports also describe (`ProvisionedRepo`,
    `AgentContextSnapshot`/`AgentContextFile`/`AgentContextFragment`) now have their single
    source of truth in `@cat-factory/contracts` valibot schemas; the `@cat-factory/kernel`
    ports re-export the inferred types, so the route contract and the port can't drift. The
    `/auth/config` `localMode` field is now a real schema (`localModeConfigSchema`) instead
    of `v.unknown()`, and `AppConfig.localMode` derives its type from it.

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/integrations@0.23.1
  - @cat-factory/orchestration@0.28.1
  - @cat-factory/prompt-fragments@0.7.33
  - @cat-factory/spend@0.10.6

## 0.31.0

### Minor Changes

- 76543fa: Add a **Human Review gate** — an opt-in pipeline step (`human-review`, pipeline `pl_pr_review`
  "Build & PR review") that watches a task's PR for a human code review on GitHub and loops the
  existing `fixer` agent to address feedback:

  - Advances once the PR meets GitHub's required approvals (read from branch protection) with no
    unresolved review threads.
  - Dispatches the `fixer` to address outstanding review threads (immediately when approved; after a
    per-task grace window otherwise), then resolves each handed thread on GitHub via the GraphQL
    review-thread API so the next probe sees it cleared. A reviewer re-opening a thread re-triggers a fix.
  - Waits indefinitely for the human (re-arming, never auto-failing), surfacing a `human_review`
    notification while it waits.
  - A human can request a freeform fix at any time from the gate window
    (`POST /workspaces/:ws/blocks/:blockId/human-review/request-fix`), dispatched immediately.

  Built as a registry gate in `@cat-factory/gates` (new `PullRequestReviewProvider` port +
  `GitHubPullRequestReviewProvider`, wired in every facade) reusing the generic gate driver, plus
  small generic engine seams: `pollExhaustion: 'rearm'`, a `GateDefinition.onHelperComplete` side-effect
  hook, and a `pendingFix` manual-inject path. Adds a per-task `humanReviewGraceMinutes` merge-preset
  knob (D1 ⇄ Drizzle migration). The cross-runtime conformance suite asserts the gate on every runtime.

  Review hardening:

  - Branch-protection's required-approval count is read against the PR's **actual base branch**
    (`pulls/{n}.base.ref`), not the repo default — so a PR into a stricter protected branch is gated
    against its own rule instead of silently defaulting to 1.
  - A **stalled fixer** (no progress on an unchanged head while feedback is outstanding) now raises a
    `human_review` notification instead of waiting silently/invisibly forever.
  - The awaiting-approval `human_review` card carries the run's `executionId`, so the inbox deep-links
    into the gate window (the "request a fix here" affordance) instead of merely selecting the block.
  - The thread-resolve reconcile is scoped strictly to threads the gate itself handed the fixer
    (retained until confirmed resolved) — a **third-party review bot's** open thread is never silently
    closed, and its feedback isn't mistaken for the fixer's own.
  - `requestHumanReviewFix` rejects (409) when the gate has no review provider / async executor wired,
    instead of accepting a request it would silently drop.
  - The static branch-protection read is cached on the gate state after the first probe, so an
    indefinite wait no longer re-reads it every poll.

  **Breaking:** `FIXER_AGENT_KIND` moved from `@cat-factory/orchestration`'s `ci.logic` to
  `@cat-factory/kernel` (re-exported from `ci.logic` for existing call sites); the `merge_threshold_presets`
  table gains a non-null `human_review_grace_minutes` column.

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0
  - @cat-factory/agents@0.18.0
  - @cat-factory/orchestration@0.28.0
  - @cat-factory/integrations@0.23.0
  - @cat-factory/spend@0.10.5
  - @cat-factory/prompt-fragments@0.7.32

## 0.30.0

### Minor Changes

- 17adf4c: Local mode: warm container pool + checkout reuse, and optional native (host-process)
  execution of the developer's installed Claude Code / Codex CLI.

  **Warm pool + persistent checkout (default off = unchanged):** the local runner transport
  can keep idle harness containers warm and lease one — preferring a member that already holds
  the run's repo — instead of cold-starting a container per run. A leased member reuses a
  stable per-repo checkout (`git reset --hard` + a keep-list clean sweep that preserves
  dependency caches like `node_modules`, then `fetch` + switch branch) rather than cloning from
  scratch. New harness job field `persistentCheckout` drives this; it is set only by the local
  pool transport, so every other runtime keeps the ephemeral fresh-clone path byte-for-byte.
  Pooling is Docker-family only (the new `capabilities.pooling`); Apple `container` keeps the
  per-run path.

  **Configured in the UI + DB, not env:** the warm-pool sizing (size / pre-warm / max / idle
  timeout) and the per-repo checkout-reuse knobs (workspace root + dep-cache keep list) are a
  new per-deployment singleton (`local_settings`, Postgres/Drizzle only — local-mode-only, so
  no D1 mirror) exposed through a dedicated **"Local mode"** settings panel
  (Integrations → Local mode), served by a new `GET|PUT /local-settings` controller wired only
  on the local facade (503 elsewhere). This REPLACES the env vars `LOCAL_POOL_SIZE`,
  `LOCAL_POOL_MIN_WARM`, `LOCAL_POOL_MAX`, `LOCAL_POOL_IDLE_TTL_MS`, `HARNESS_WORKSPACE_ROOT`,
  `HARNESS_CLEAN_KEEP` (no longer read). The container transport forwards the checkout knobs to
  the harness container as `HARNESS_*` env. Breaking: those env vars are dropped — set the
  values in the UI instead.

  **Native execution (`LOCAL_NATIVE_AGENTS`, default off):** an allow-list of subscription
  harnesses (`claude-code,codex`) to run as a host process (new `LocalProcessRunnerTransport`)
  driving the developer's OWN installed `claude` / `codex` CLI with its ambient login (new
  harness `ambientAuth` mode) — no leased credential, no personal-credential gate for those
  vendors. Native applies ONLY to a listed harness's NATIVE vendor (Anthropic `claude` /
  OpenAI `codex`): a non-native vendor that reuses the `claude-code` harness (GLM/Kimi/DeepSeek
  carries its own base URL) and proxy/`pi` models are NOT run unsandboxed on the host — they
  keep the sandboxed per-run container path (so they still lease their real credential and
  still need `LOCAL_HARNESS_IMAGE`). Gated, local-facade-only, with the explicit no-sandbox /
  own-subscription trade documented. Requires `LOCAL_HARNESS_ENTRY`. The Tester's local
  docker-compose infra is reported unsupported in native mode for now (host-compose +
  git-worktree isolation are a follow-up phase).

  Breaking: none (all paths default off). The executor-harness image is bumped (1.16.0) for
  the new `persistentCheckout` / `ambientAuth` handling.

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/integrations@0.22.0
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/orchestration@0.27.1
  - @cat-factory/agents@0.17.2
  - @cat-factory/prompt-fragments@0.7.31
  - @cat-factory/spend@0.10.4

## 0.29.1

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/orchestration@0.27.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/integrations@0.21.7
  - @cat-factory/prompt-fragments@0.7.30
  - @cat-factory/spend@0.10.3

## 0.29.0

### Minor Changes

- 9f7ee39: Add "Requirements brainstorm" and "Architecture brainstorm" agents — structured-dialogue
  gates that PROPOSE options with explicit trade-offs and let a human converge on a direction,
  rather than doing all the work themselves or expecting the work done upfront.

  - One shared, stage-discriminated engine (`BrainstormService` over the existing
    `IterativeReviewService`), driven through the generic `ReviewGateController`. Two agent kinds
    (`requirements-brainstorm`, `architecture-brainstorm`) reuse it via a stage-bound repository
    adapter.
  - Persistence: a new `brainstorm_sessions` table keyed per (block, **stage**) — a block may hold
    a live requirements AND a live architecture session at once — mirrored across both runtimes
    (D1 + Drizzle/Postgres) with a cross-runtime conformance suite.
  - Handoffs (DB session state → next stage's prompt): `requirements-brainstorm` → the
    requirements review (its converged direction becomes the reviewed subject);
    `architecture-brainstorm` → the architect (surfaced additively as a prior output).
  - Pipelines: both steps are added to `pl_full` and `pl_fullstack` but **disabled by default**
    (opt-in per pipeline) — existing runs are unchanged.
  - Frontend: a shared brainstorm window (option cards with trade-offs → choose/steer/dismiss →
    incorporate → re-run), wired through the result-view seam, the workspace stream, and the
    palette catalog.

  Breaking: adds a new required table on both runtimes (`brainstorm_sessions` D1 migration +
  Drizzle migration) and a new optional `ExecutionEventPublisher.brainstormSessionChanged` event.
  No data migration — pre-1.0, stale state is acceptable.

  The brainstorm iteration cap reuses the merge preset's `maxRequirementIterations` /
  `maxRequirementConcernAllowed` knobs (no new preset field).

- 81b60d4: Add the future-looking **Follow-up companion** to the Coder agent.

  As the Coder works it now surfaces forward-looking items — genuine loose ends, useful
  side-tasks it is deliberately not acting on, and clarifying questions — by appending them
  to a `.cat-follow-ups.jsonl` sentinel file in its working directory. The executor-harness
  tails that file and streams the items **out** on the job view (drain-on-read, like tool
  spans), so a blinking **Follow-up companion** chip on the Coder step lights up the moment
  the first item appears — while the container is still running.

  A human triages each item at any point: file a follow-up as a tracker issue (GitHub Issues
  / Jira, via the existing `TicketTrackerProvider`), send it back to the Coder to address
  after delivering the key task, answer a question, or dismiss it. The pipeline's following
  steps do not start until **every** item is decided: an undecided follow-up or unanswered
  question parks the run at the Coder's completion (a new `followup_pending` notification).
  Once all are decided the engine loops the Coder for the queued / answered items (within a
  per-step budget) before advancing. The companion is enabled by default on Coder steps and
  disableable per step in the pipeline builder.

  This is pure engine + run-step state (no new table) so it is runtime-symmetric across the
  Cloudflare and Node facades — the cross-runtime conformance suite asserts the park →
  decide → loop → advance behaviour on both. Wire contracts (`followUpItem` /
  `followUpsStepState`, the `followup_pending` notification, the `follow-ups` result view),
  the `streamFollowUps` harness job flag + `RunnerJobView.followUps` channel (with an
  optional pool-manifest `followUpsPath`), and the `FOLLOW_UP_GUIDANCE` Coder prompt fragment
  are added across the stack.

  Bumps the executor-harness image (new src) — publish + redeploy to roll it out.

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/orchestration@0.26.0
  - @cat-factory/integrations@0.21.6
  - @cat-factory/prompt-fragments@0.7.29
  - @cat-factory/spend@0.10.2

## 0.28.1

### Patch Changes

- 4dd6e97: Fix: container agent (and repo-bootstrap) runs on **OpenRouter** and **LiteLLM** models
  were rejected at start with `'openrouter' is not supported` even though the LLM proxy
  already forwards both (their base URLs resolve in `resolveOpenAiCompatibleUpstream`). The
  proxyability guard hardcoded only `qwen`/`deepseek`/`moonshot`/`openai`/`workers-ai` and
  was duplicated (out of step) across `ContainerAgentExecutor` and `ContainerRepoBootstrapper`.
  Replaced both copies with a single shared `isProxyableProvider` in `@cat-factory/agents`,
  derived from `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` (so every OpenAI-compatible direct
  provider — including OpenRouter) plus the operator-hosted `litellm` gateway and the per-user
  local runners, so the start guard and the proxy can no longer disagree.
- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/orchestration@0.25.1

## 0.28.0

### Minor Changes

- ea59e91: Add the Kaizen agent: a post-run, continuous-improvement reviewer (toggleable per
  workspace, never a pipeline-builder step) that grades each completed agent step on how
  smooth/efficient vs confused/chaotic the interaction was and recommends prompt/model
  improvements.

  - After a run completes, the engine schedules a grading per completed agent step
    (skipping verified combos); a background sweep (Cloudflare cron / Node interval) runs
    the inline LLM grade. The grader's model is configured in Model Configuration like
    every other agent (the hidden-from-palette `kaizen` kind).
  - A `(promptVersion, agentKind, model)` combo that grades strongly (>=4) with no
    recommendations five times in a row is marked **verified** and is no longer graded.
  - New persisted tables `kaizen_gradings` + `kaizen_verified_combos` (D1 ⇄ Drizzle parity,
    asserted by a new cross-runtime conformance suite) and a per-workspace `kaizenEnabled`
    setting (a new `workspace_settings.kaizen_enabled` column).
  - New read API (`GET /workspaces/:ws/kaizen`, `GET /workspaces/:ws/executions/:id/kaizen`),
    a `kaizen` real-time event, a Kaizen screen (grading history + verified combos), and
    per-step grading status (scheduled/running/complete + results) inside the run window —
    never on the board.
  - A step with neither a provided-context snapshot nor any recorded LLM calls (e.g. prompt
    recording is off deployment-wide) is settled `failed` rather than graded blind, so a
    guessed grade can't advance a combo toward a bogus `verified`.
  - The Worker Kaizen sweep gains an in-isolate re-entrancy guard (mirroring the Node
    sweeper) so overlapping passes don't race the per-combo streak update.

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0
  - @cat-factory/orchestration@0.25.0
  - @cat-factory/integrations@0.21.5
  - @cat-factory/prompt-fragments@0.7.28
  - @cat-factory/spend@0.10.1

## 0.27.2

### Patch Changes

- 18f6b3b: Security hardening across three surfaces.

  Local-runner SSRF: the server-side fetches to a user-supplied runner base URL (the "Test
  connection" probe and the run-time LLM proxy forward) now follow redirects manually and
  re-validate every hop against the loopback/LAN allow-list, so a reachable runner can no
  longer `302` the server into the cloud-metadata endpoint or a public host. `localRunnerUrlError`
  also rejects URLs with embedded credentials. New `fetchLocalRunner` helper in
  `@cat-factory/integrations`.

  Harness inbound auth: the Cloudflare container transport now sends the `x-harness-secret`
  header and injects `HARNESS_SHARED_SECRET` into each per-run container's env when the secret
  is configured, matching the harness server and the local Docker transport. Unset leaves the
  harness open as before (it is only reachable via DO-internal addressing). The self-hosted
  runner pool reaches the harness through its own control plane, so its secret is configured
  pool-side.

  GitHub API requests in the executor harness now build the PR-lookup query with
  `URLSearchParams` and encode the owner/name path segments, so a branch or owner containing
  `&`/`#` can't split the query or inject a parameter.

- Updated dependencies [18f6b3b]
  - @cat-factory/integrations@0.21.4
  - @cat-factory/orchestration@0.24.2

## 0.27.1

### Patch Changes

- 4849c66: Two follow-ups to the agent-context observability feature:

  - **Worker:** the daily retention `scheduled` handler now fails fast with the same clear
    "TELEMETRY_DB binding is required" error as the request-path container build (via a
    shared `requireTelemetryDb` helper) instead of producing an opaque NPE deep in a
    telemetry repo when the binding is unbound.
  - **Server:** the agent-context snapshot now strips any embedded `user:pass@` userinfo
    from the stored injected-doc URLs and the tester's ephemeral `environmentUrl`, upholding
    the allow-list's "never a credential-bearing URL" promise even when an operator's
    environment-provider mapping populates a credentialed URL.

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/spend@0.10.0
  - @cat-factory/orchestration@0.24.1
  - @cat-factory/agents@0.15.2
  - @cat-factory/integrations@0.21.3
  - @cat-factory/prompt-fragments@0.7.27

## 0.27.0

### Minor Changes

- 765cc42: Capture the complete context provided to each container agent as observability, in an
  isolated telemetry store.

  - New `agent_context_snapshots` table records, per container-agent dispatch, the fully
    fragment-composed system + user prompts, the best-practice fragment bodies folded in,
    and the full content of the files injected into the container (`.cat-context/*`) — the
    gap the per-call LLM telemetry can't see (the agent reads those files via tools). The
    snapshot is a redacted allow-list projection of the dispatched job (never any token or
    credential-bearing URL). Recorded best-effort at dispatch by `ContainerAgentExecutor`
    via the new `AgentContextObservabilityService`, gated by the deployment prompt-recording
    switch (`LLM_RECORD_PROMPTS`) AND a new per-workspace `storeAgentContext` setting
    (on by default; a toggle in Workspace settings). Surfaced on demand via
    `GET /workspaces/:ws/executions/:executionId/agent-context` and a "Provided context"
    view in the observability panel.
  - Telemetry now lives in an isolated store, separate from the transactional domain
    (append-heavy/high-volume/short-retention write profile). `llm_call_metrics` and the new
    `agent_context_snapshots` table both move there: a dedicated `telemetry` Postgres schema
    on Node (same connection) and a separate, **required** `TELEMETRY_DB` D1 database on
    Cloudflare. Both ride the existing `LLM_CALL_METRICS_RETENTION_DAYS` retention window.

  BREAKING (pre-1.0, no migration provided): the Cloudflare Worker now requires a
  `TELEMETRY_DB` D1 binding (provision with `wrangler d1 create cat_factory_telemetry` and
  add the `[[d1_databases]]` entry pointing `migrations_dir` at
  `telemetry-migrations`). `llm_call_metrics` is dropped from the main D1 / `public` schema;
  existing rows are not migrated.

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0
  - @cat-factory/orchestration@0.24.0
  - @cat-factory/agents@0.15.1
  - @cat-factory/integrations@0.21.2
  - @cat-factory/spend@0.9.5
  - @cat-factory/prompt-fragments@0.7.26

## 0.26.1

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/orchestration@0.23.0
  - @cat-factory/integrations@0.21.1
  - @cat-factory/spend@0.9.4
  - @cat-factory/prompt-fragments@0.7.25

## 0.26.0

### Minor Changes

- a639189: Observability for ephemeral-environment and container provisioning.

  - **Unified provisioning event log.** A new append-only log records every attempt to
    spin up / tear down throwaway infrastructure — ephemeral environments
    (provision/teardown/status) and the runner-pool / per-run containers
    (dispatch/release/poll-failure) — with the outcome and the verbatim provider/runtime
    error on failure. Surfaced via `GET /workspaces/:ws/provisioning-logs` and a "View
    logs" button in the ephemeral-environment provider and self-hosted runner-pool config
    panels.
  - **Env lifecycle in run details.** An agent run's step now carries the ephemeral
    environment it runs against (spinning up / running / shut down / errored + URL/expiry
    - exact error), shown in the step detail (notably for the Tester).
  - **Container-start failures.** When a container/runner never accepts the job, the run
    details now say "Container failed to start" and show the exact provider/runtime error
    (a `dispatch`-kind failure) instead of a generic "Run failed". A run's step detail also
    has an "Infrastructure attempts" drawer (filtered by execution id) that surfaces that
    run's container/runner/env spin-up + tear-down attempts.
  - **Secret redaction.** The verbatim provider/runtime error and structured detail are
    scrubbed at the single recorder choke point before they are persisted/served — bearer
    tokens, `Authorization`/`x-api-key` header echoes, credentialed URLs, and recognisable
    token shapes (`sk-`/`ghp_`/`AKIA`/JWT) are replaced with `[REDACTED]` while the
    surrounding context (field name, URL host, token scheme) is kept for diagnosis.

  **Breaking / operational:** the provisioning log lives in a PHYSICALLY SEPARATE store to
  isolate its high write churn. The Cloudflare Worker needs a new `PROVISIONING_DB` D1
  binding (its own `migrations-provisioning` dir — create the database and apply its
  migrations); when absent, the feature is simply off. The Node service uses a dedicated
  `provisioning` Postgres schema, created with `CREATE SCHEMA IF NOT EXISTS` by `migrate()`
  on boot (the DB role needs `CREATE` on the database — the same privilege the app already
  uses to create its `public` tables). Retention is governed by `PROVISIONING_LOG_RETENTION_DAYS`
  (default 14). Catching a container dispatch error at the dispatch site means a transient
  dispatch blip is now a terminal `dispatch` failure (retry from the failure card) rather
  than relying on a Workflows step retry.

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0
  - @cat-factory/integrations@0.21.0
  - @cat-factory/orchestration@0.22.0
  - @cat-factory/agents@0.14.9
  - @cat-factory/spend@0.9.3
  - @cat-factory/prompt-fragments@0.7.24

## 0.25.1

### Patch Changes

- ed3a673: Requesting Requirement-Writer recommendations is now asynchronous, like every other
  requirements-review operation. The request returns at once with `pending` placeholder
  recommendations and the user is handed back to the board; the Writer runs per finding in
  the durable driver (signalled through the parked requirements gate, mirroring the
  incorporate flow), filling each placeholder (`pending` → `ready`) with live progress and
  raising a notification when the batch is ready. The review window shows "N / M ready" plus
  per-finding "generating…" placeholders, and the board's "Recommending…" badge is now driven
  by server state (a `pending` recommendation), so it survives closing the window. A finding's
  typed answers are flushed before the request and preserved across the async cycle, so the
  user's explicit answers are still there when they return to confirm recommendations.
  Re-requesting a single recommendation rides the same async path; rejecting one now reopens
  its source finding so it can be answered manually. No schema migration (recommendation
  status lives in the existing JSON column) and no prompt/image change.
- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/orchestration@0.21.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/integrations@0.20.1
  - @cat-factory/kernel@0.28.1
  - @cat-factory/prompt-fragments@0.7.23
  - @cat-factory/spend@0.9.2

## 0.25.0

### Minor Changes

- 69d2270: Surface the Sandbox (the parallel prompt/model testing surface) end to end. Previously
  only the domain logic (`@cat-factory/sandbox`), wire contracts and kernel ports existed,
  with no way to use the feature; this wires the full stack:

  - **Services** (`@cat-factory/orchestration`): `SandboxService` (prompt-version lineage,
    fixture library with lazy builtin seeding, experiment definitions) + `SandboxRunService`
    (the run-driver + judge — expands an experiment matrix into cells, runs each inline
    candidate against the prompt-version's system text + the fixture input, grades it with a
    judge model against the task rubric, and records the deterministic objective findings
    score). Assembled as the `sandbox` core module when its repositories are wired.
  - **HTTP API** (`@cat-factory/server`): `SandboxController` mounts the prompt/fixture/
    experiment CRUD + `POST /sandbox/experiments/:id/launch`. 503 when unconfigured.
  - **Persistence**: the Sandbox gets its **own database** per runtime for blast-radius
    isolation — a dedicated `SANDBOX_DB` D1 database on the Cloudflare Worker (its own
    `sandbox-migrations/` lineage) and a dedicated `sandbox` Postgres schema on Node
    (Drizzle). Both runtimes contribute the repositories via a single sandbox-owned
    `Partial<CoreDependencies>` mixin, so neither facade enumerates them. Cross-runtime
    conformance asserts parity.
  - **Frontend** (`@cat-factory/app`): a Sandbox window (opened from the sidebar +
    command palette) to clone/version prompts, browse graded fixtures, and define + run
    experiments with a scored results grid.

  BREAKING (deployment): the Cloudflare Worker reads an optional new `SANDBOX_DB` binding;
  without it the Sandbox API answers 503 (the rest of the product is unaffected). To enable
  it, provision a second D1 database and point the binding + its `migrations_dir` at the
  package's `sandbox-migrations/` (see `deploy/backend/wrangler.toml`). On Node the
  `sandbox` schema is created automatically by the boot migrator.

  Container/repo fixtures (a real checkout) are not yet supported by the in-product run
  driver and are refused at launch; the builtin fixtures are all inline.

  Run-driver hardening: a relaunch clears the prior result grid first (new
  `SandboxRunRepository`/`SandboxGradeRepository.removeByExperiment`, mirrored on D1 +
  Drizzle) instead of accumulating duplicate cells; the experiment's terminal status is
  derived from whether any cell was actually graded (`failed` when every candidate failed OR
  every grade failed — never a misleading `done` over a grid of unscored cells, and never
  left `running`); the token budget must be ≥ 1 (a `0` budget is rejected at create rather
  than silently failing every cell) and is documented as a soft cap enforced between cells;
  the judge model defaults to the deployment routing default (no hardcoded vendor) and
  requires an explicit `judgeModel` when none is configured (the experiment builder now
  exposes a judge-model picker so a deployment with no default still has recourse); an
  unparseable / empty / reasoning-only judge reply is now recorded as a grading **error** on
  the cell rather than silently flooring every dimension to the minimum (which read as a
  confident bottom-of-scale grade); the judge-reply JSON extractor — now the single robust
  `extractJson` promoted to `@cat-factory/kernel` and shared by the requirements reviewer, the
  document planner and the Sandbox judge (replacing two weaker object-only copies) — is
  string-literal aware, scans forward past any leading bracket whose span isn't valid JSON
  (so prose like `I weighed [the auth flow]: {…}` no longer defeats extraction for the
  object-returning reviewers), and falls back past a leading non-JSON code fence. The judge
  prompt appends the shared `FINAL_ANSWER_IN_REPLY` directive like the other parsed-reply
  agents, and the provider-for-scope resolution the Sandbox shares with the reviewers is now
  one `resolveScopedModelProvider` kernel helper instead of two copies. The Sandbox window now surfaces a
  non-503 load failure (with a retry) instead of rendering an empty, healthy-looking panel.
  The fixture↔kind mapping the UI filters by now lives on the `@cat-factory/sandbox` catalog
  (`SandboxAgentKindMeta.fixtureKinds`) instead of a parallel frontend switch. Concurrent
  launches of the same experiment are now serialised by an atomic
  `SandboxExperimentRepository.claimForRun` (a conditional transition to `running`, mirrored on
  D1 + Drizzle): only the winner clears + re-expands the result grid, so two simultaneous
  launches can't duplicate the grid or race the grid-clearing deletes, and the grid setup runs
  inside the terminal-status `finally` so a failure there can't strand the experiment
  `running`. The matrix cell cap is surfaced on the overview (`maxCells`) so the builder gates
  on the SAME limit instead of re-encoding the literal. NOTE: the run-driver still executes the
  matrix inline in the launch request (bounded by the cell cap + token budget); a durable
  fan-out (Workflows / pg-boss) for large matrices remains a follow-up.

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/orchestration@0.21.0
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/integrations@0.20.0
  - @cat-factory/agents@0.14.7
  - @cat-factory/prompt-fragments@0.7.22
  - @cat-factory/spend@0.9.1

## 0.24.0

### Minor Changes

- 3546e3d: Move operator/integration config out of environment variables into encrypted, UI-editable
  DB settings. DB is now the source of truth — the moved env vars are **removed** (no
  fallback), so the listed vars below no longer have any effect.

  **Per-workspace budget (Workspace settings → Budget).** A workspace's spend currency,
  monthly limit, and per-model price overrides now live on the `workspace_settings` row.
  The spend safeguard resolves each workspace's effective pricing (base table + overrides)
  behind a short-TTL cache, scoping the budget gate to the workspace's own usage
  (`SpendService.status`/`isOverBudget` now take a `workspaceId`; new
  `TokenUsageRepository.totalsSinceForWorkspace`). **Behaviour change:** spend is metered +
  gated per workspace, not deployment-wide; a workspace with no budget inherits the built-in
  default (~100 EUR/month). Removes env: `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`,
  `SPEND_MODEL_PRICES`. A budget of `0` is intentional ("no PAID spend"): metered runs are
  refused **up front** at start/retry with a clear `409` (not just a silent mid-run pause),
  while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS (flat-rate quota) keep
  running since they incur no metered cost — so `0` is the "local-/subscription-only" setting.
  The over-budget exemption (previously subscription-only) now also covers local-runner steps,
  inline and container alike. The hot-path per-workspace rollup is indexed
  (`idx_token_usage_workspace` on `(workspace_id, created_at)`, both runtimes).

  **Per-workspace incident enrichment (service inspector → Post-release health).** PagerDuty

  - incident.io credentials are sealed in a new per-workspace `incident_enrichment_connections`
    table (one grouped blob) and resolved/decrypted at enrichment time by a new
    `WorkspaceIncidentEnrichmentProvider`. Removes env: `PAGERDUTY_API_TOKEN`,
    `PAGERDUTY_FROM_EMAIL`, `INCIDENTIO_API_KEY`. The write API is three-state per provider
    group (omit ⇒ keep, `null` ⇒ clear, value ⇒ set) so one vendor can be removed without
    wiping the other.

  **Per-account integration secrets (Account settings → Deployment integrations, admin only).**
  The Slack app OAuth credentials and the container web-search upstream keys (Brave /
  SearXNG) now live in a new per-account `account_settings` table (one sealed secrets blob,
  HKDF tag `cat-factory:account-settings`), behind an admin-gated
  `GET|PUT /accounts/:id/settings`. Resolved dynamically: Slack OAuth at connect time, the
  web-search upstream per run (off the container session's account id). The executor now
  advertises the container `web_search` tool to a run **only when its account actually has
  keys** (so an agent is never handed a tool that always fails); a run with no upstream gets
  an empty result set rather than a hard `503`. Removes env:
  `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `WEB_SEARCH_BRAVE_API_KEY`,
  `WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_SEARXNG_API_KEY` (the env-built upstream + its
  `createWebSearchUpstreamFromEnv`/`gateways.webSearch` fallback are deleted, not just
  unwired). (`SLACK_ENABLED` still gates Slack module assembly; the new tables/services
  assemble whenever `ENCRYPTION_KEY` is set.)

  **Hardening.** Re-sealing a partial settings/credentials write now **refuses** (clear `409`)
  when the stored blob can't be decrypted (e.g. after an encryption-key change) instead of
  silently dropping the un-edited secret group on the re-seal.

  New tables mirror across both runtimes (D1 migrations 0012–0014 ⇄ Drizzle schema +
  generated migration) with cross-runtime conformance assertions for the budget +
  incident-enrichment round-trips. `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and the GitHub
  App/OAuth secrets stay in env (bootstrap/auth). Retention windows, inline-web-search
  toggles, Langfuse keys, and execution timeouts intentionally remain env-configured.

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0
  - @cat-factory/spend@0.9.0
  - @cat-factory/integrations@0.19.0
  - @cat-factory/orchestration@0.20.0
  - @cat-factory/agents@0.14.6
  - @cat-factory/prompt-fragments@0.7.21

## 0.23.6

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/orchestration@0.19.2
  - @cat-factory/agents@0.14.5
  - @cat-factory/integrations@0.18.3
  - @cat-factory/spend@0.8.26

## 0.23.5

### Patch Changes

- a0d5efc: Fix the bootstrap write-permission pre-flight (`FetchGitHubClient.canPush`), which
  never passed for a GitHub App installation (only for local-mode PATs).

  Two bugs:

  1. Wrong source of truth. The check read the repo object's `permissions.push`, which
     reflects a user/collaborator role. A GitHub App installation token isn't a
     collaborator, so that field is empty for it and `push` is never true regardless of
     the grant. The authoritative signal for an App is its granted `contents` scope from
     the token mint response. `canPush` now consults `installationPermissions` (added to
     the `AppTokenSource` seam) and treats `contents: 'write'` as pushable, keeping the
     repo-object role as the path for user/PAT tokens.

  2. Stale token. Installation tokens bake in their grant at mint time and are cached
     in-memory for ~1h, so a token minted before the user granted access kept reporting
     the old grant — a retry right after adding the App would still fail. `canPush` now
     mints a fresh token and rechecks on a negative answer (failure path only). The fresh
     mint also replaces the cached entry the container's push token reads, so a real grant
     fixes the push too. `installationToken` gains an optional `{ forceRefresh }` across
     `AppTokenSource` / `GitHubAppRegistry` / `GitHubAppAuth`.

## 0.23.4

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/spend@0.8.25
  - @cat-factory/agents@0.14.4
  - @cat-factory/integrations@0.18.2
  - @cat-factory/orchestration@0.19.1

## 0.23.3

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
  - @cat-factory/orchestration@0.19.0
  - @cat-factory/agents@0.14.3
  - @cat-factory/integrations@0.18.1
  - @cat-factory/spend@0.8.24

## 0.23.2

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/integrations@0.18.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/orchestration@0.18.1
  - @cat-factory/prompt-fragments@0.7.20
  - @cat-factory/spend@0.8.23

## 0.23.1

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/orchestration@0.18.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/integrations@0.17.1
  - @cat-factory/spend@0.8.22

## 0.23.0

### Minor Changes

- 6ff1f10: Link Confluence/Notion/GitHub documents as **living** best-practice fragments.

  A team can now link an external document (a Confluence page, a Notion page, or a
  GitHub file — any connected Document source) as a prompt-fragment whose guidance is
  **re-resolved from the source at the moment an agent run uses it**, rather than a
  one-time snapshot. Edit the upstream doc and the next agent run follows the new
  version — no re-import. The body is cached on the fragment as a last-resolved
  snapshot and refreshed on a short TTL (default 5 min); if the source is unreachable
  the run falls back to the cached body, so resolution never blocks a run. Available
  at both the account and workspace tiers; an account-tier link fetches through a
  chosen workspace's connection — recorded on the fragment so every consuming
  workspace re-resolves through that same connection at run time, not its own.

  New surface: `POST /:scope/document-fragments` (link a document as a fragment) and
  `POST /:scope/prompt-fragments/:id/refresh` (force an immediate re-resolve), a
  "Documents" tab in the fragment-library manager with a "Live · <source>" badge, and
  a `documentRef`/`resolvedAt` provenance block on `PromptFragment`.

  As part of this, run-time fragment-id resolution now goes through the merged tenant
  catalog (built-in ∪ account ∪ workspace) instead of only the built-in static pool,
  so **managed (DB-authored) fragments also reach a run** — previously only built-in
  ids resolved at run time. Behaviour is unchanged when the prompt-fragment library is
  not configured.

  Persistence: `prompt_fragments` gains `doc_source` / `doc_external_id` /
  `doc_via_workspace_id` / `resolved_at` columns on both runtimes (a D1 migration and
  a Drizzle migration); stale pre-existing rows simply carry nulls.

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0
  - @cat-factory/integrations@0.17.0
  - @cat-factory/orchestration@0.17.0
  - @cat-factory/prompt-fragments@0.7.19
  - @cat-factory/spend@0.8.21

## 0.22.0

### Minor Changes

- 04befe8: Business-only specs + an explicit `technical` task label.

  **Business-only spec-writer + "no new specs" outcome.** The spec-writer now captures
  ONLY business requirements. For a purely technical task (a refactor / non-functional /
  internal change with no externally-observable behaviour) "no new specs" is a valid
  outcome: the writer returns `{"noBusinessSpecs": true}`, the baseline spec is left
  untouched (`specPostOp` commits nothing), and the new `AgentRunResult.noBusinessSpecs`
  channel carries the determination. The spec-companion corroborates or disputes it via a
  new optional `technicalCorroborated` verdict on `companionAssessmentSchema` (a disputed
  "no specs" claim loops the writer back as before). The spec-writer prompts are updated
  accordingly (no version bump — they are not under prompt-version control).

  **Explicit `technical` label on a task.** Blocks gain an optional `technical` field
  (`true`/`false`/unset), persisted on both runtimes (D1 column ⇄ Drizzle column + generated
  migration; shared block mapper). A human sets it at creation (a "Technical task" checkbox)
  or via a tri-state inspector toggle (unset / technical / business). An explicit `false`
  (business) is forwarded to the spec-writer, which is then required to produce specs (it is
  told not to claim "no business specs"); `true` tells it the empty outcome is expected.
  Left unset, the engine infers the label from the settled spec phase — `noBusinessSpecs`
  (writer) combined with `technicalCorroborated` (companion) — both when the spec-companion
  converges automatically AND when a human proceeds past its iteration cap. Once a concrete
  label is recorded it is authoritative and not re-inferred (whether set by a human or a
  prior inference); a human re-opens it to inference by clearing it to "unset". When a task
  is technical the implementer treats the task definition / incorporated requirements as the
  primary source of truth and the committed specs as a regression-spotting reference; the
  `build` prompt is bumped to v3 and carries the per-task signal (only the implementer — not
  the architect/reviewer — acts on it).

  Breaking: none for existing data (the new columns default to "not determined").

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0
  - @cat-factory/orchestration@0.16.0
  - @cat-factory/integrations@0.16.1
  - @cat-factory/prompt-fragments@0.7.18
  - @cat-factory/spend@0.8.20

## 0.21.0

### Minor Changes

- be182e8: Hybrid linked-context delivery to agents, and deterministic reference resolution.

  Linked documents and tracker issues now reach a container agent as a cheap in-prompt
  summary index plus their full bodies materialised into a `.cat-context/` directory in the
  checkout (kept out of the agent's commits via a local git exclude), so the agent reads only
  what it needs on demand — replacing the previous 280-char document excerpt. Inline (no-
  checkout) agent kinds instead get the budgeted full body injected into the prompt.

  The engine also resolves references named explicitly in a block's description or its
  incorporated requirements (Jira keys like `PROJ-123`, fully-qualified GitHub `owner/repo#123`,
  and URLs) against the already-imported corpus, folding those high-confidence items into the
  context set. Each reference is resolved by a **point lookup** (a keyed `get`, or a new
  `getByUrl` repository method) rather than scanning the whole workspace corpus per step. Bare
  `#123` refs are intentionally not resolved: a workspace can hold many repos, so a bare number
  is ambiguous — name the issue as `owner/repo#123` (or by URL) to pull it in. There is no
  speculative relationship graph and no live fetching: everything is prepared backend-side,
  which is required because the container harness cannot reach Jira/Confluence/GitHub itself.

  Documents gain a `content_hash` column (D1 + Drizzle) so a re-import whose body AND title/url
  are unchanged is a no-op, preserving the existing projection and block link; a renamed/moved
  page still re-projects.

  Breaking (pre-1.0): `AgentRunContext.block.contextDocs` items now carry `summary` + `body`,
  `contextTasks` items carry `summary`, and `DocumentRecord` carries `contentHash`. The
  `DocumentRepository`/`TaskRepository` ports gain a `getByUrl` method (implemented on both the
  D1 and Drizzle stores). The executor-harness image gains an optional `contextFiles` job field;
  bump the runner image tag.

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0
  - @cat-factory/integrations@0.16.0
  - @cat-factory/orchestration@0.15.0
  - @cat-factory/spend@0.8.19

## 0.20.0

### Minor Changes

- 2c24da8: Add a **human-testing gate** (`human-test`) pipeline step. When reached it spins up an
  ephemeral environment and PARKS for a person to validate the change in the live URL before
  the run continues. From the dedicated window the human can confirm (tear the env down +
  advance), submit findings to dispatch the Tester's `fixer` (then the env rebuilds for
  re-testing), pull latest main into the PR branch + redeploy (a clean merge rebuilds the env; a
  conflict dispatches the `conflict-resolver`), or recreate / destroy the env on demand. Falls
  back to a degraded manual mode (no live env, still parks for confirmation) when no
  ephemeral-environment provider is wired.

  New opt-in pipeline `pl_human_review` (`coder → reviewer → human-test → conflicts → ci →
merger`) and a palette block; existing default pipelines are unchanged.

  Adds a `GitHubClient.mergeBranch` (the repo Merges API) and a `BranchUpdater` port behind the
  "pull main" action, wired from the GitHub client on every facade (Worker / Node / local), plus
  a `human_test_ready` notification type (in-app + Slack-routable). Both runtimes wire the gate
  identically and the cross-runtime conformance suite asserts the park → request-fix → confirm
  flow.

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0
  - @cat-factory/orchestration@0.14.0
  - @cat-factory/integrations@0.15.0
  - @cat-factory/agents@0.11.16
  - @cat-factory/prompt-fragments@0.7.17
  - @cat-factory/spend@0.8.18

## 0.19.0

### Minor Changes

- 4120ac5: Nested tasks (epics) + a first-class task dependency graph.

  **Epics** are a new non-structural block level (`level: 'epic'`). An epic groups tasks
  that may live under different services/modules via the tasks' new `epicId` membership
  link (independent of `parentId`, so deleting an epic clears membership but never deletes
  the member tasks). The board draws an epic node linked to all its members, and the epic
  inspector shows the full member tree grouped service → module → task. Add one via
  `POST /workspaces/:ws/epics`; assign/detach a task via `POST /blocks/:id/epic`.

  **Importing a Jira epic / GitHub parent issue** spawns the epic + its children onto the
  board in one shot (`POST /workspaces/:ws/task-sources/:source/epics/spawn`, or the "As
  epic" button in the issue-import modal): an epic node, a board task per child issue
  (joined to the epic), and `dependsOn` edges seeded from the issues' **"blocked by" /
  "depends on"** links. Jira links come from `issuelinks` + `parent`/`subtasks` + epic
  children (JQL); GitHub children come from native **sub-issues** and dependency links are
  parsed from the issue body (`Blocked by #12`, `Depends on owner/repo#34`). The
  `GitHubClient` port gains `listSubIssues` + a `parentRef` on issue detail.

  **Dependency enforcement** is now hard and server-side: `ExecutionService.start()` refuses
  (409) to start a task while any block it `dependsOn` is unfinished — enforced for manual,
  recurring, auto-start and direct-API starts alike. Adding a dependency edge that would
  close a **cycle** is rejected (422).

  **Auto-start**: a preceding task carries an `autoStartDependents` toggle (task inspector).
  When it merges, the engine automatically starts every task that depends on it whose other
  dependencies are also done — skipping any on an individual-usage model (which can't unlock
  unattended).

  **Board UX**: a drag-to-connect handle on task cards creates dependency edges directly on
  the canvas (drag from the prerequisite onto the dependent); the dependency-edge overlay
  also draws epic→member membership links.

  Persisted on both runtimes (D1 migration `0010_epics_dependencies` ⇄ Drizzle
  `epic_id` / `auto_start_dependents` columns); the cross-runtime conformance suite asserts
  the epic + membership round-trip, the cycle rejection, and the dependency start gate on
  each store.

  Breaking (pre-1.0, acceptable): the `blocks` table gains `epic_id` / `auto_start_dependents`
  columns and the `level` enum gains `epic`; no migration shims.

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/orchestration@0.13.0
  - @cat-factory/integrations@0.14.0
  - @cat-factory/agents@0.11.15
  - @cat-factory/prompt-fragments@0.7.16
  - @cat-factory/spend@0.8.17

## 0.18.0

### Minor Changes

- 25efe48: Add UI-configurable provider config + per-user GitHub PAT, with provider self-describe and connection-test.

  - Providers self-describe the config they expect (`describeConfig`) and can be connection-tested (`testConnection`) before saving — added as optional methods on the `EnvironmentProvider` and `RunnerPoolProvider` kernel ports, implemented by the generic HTTP adapters (secret-key fields from the manifest + an authed probe), and surfaced via new `GET …/environments/provider`, `POST …/environments/connection/test`, `GET …/runner-pool/provider`, `POST …/runner-pool/connection/test` endpoints. The SPA renders the descriptor fields generically.
  - New generic, `kind`-discriminated per-user secret store (`user_secrets`, mirrored D1 ⇄ Drizzle) with `UserSecretService` + a kind registry (first kind: `github_pat`). User-scoped `GET/POST/DELETE /user-secrets` + `…/test`; a "My GitHub token" entry under Integrations → Source control.
  - A run you initiate now prefers YOUR stored GitHub PAT over the deployment's GitHub App / env token for the container push token AND the engine CI-gate + merge reads (resolved by the run initiator via an ambient `RunInitiatorScope`), falling back to the existing source when you have none. Wired symmetrically across the Cloudflare, Node and local facades.

  Breaking: none for existing data. The local-mode `GITHUB_PAT` env var still works as a fallback.

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0
  - @cat-factory/integrations@0.13.0
  - @cat-factory/orchestration@0.12.0
  - @cat-factory/agents@0.11.14
  - @cat-factory/prompt-fragments@0.7.15
  - @cat-factory/spend@0.8.16

## 0.17.2

### Patch Changes

- c7b8012: Improve the requirements-review experience.

  **Auto-save answers (no button).** The requirements-review window no longer has a "Save
  answer" button: an answer is seeded into its textarea from the recorded reply and persisted
  on blur (and flushed before incorporate/proceed), so a value just needs to be typed.

  **"Recommend something" + the Requirement Writer.** A finding can now be marked for a
  grounded recommendation instead of being answered or dismissed. A new second companion of
  the requirements reviewer — the **Requirement Writer** (an inline LLM call, `WRITER_SYSTEM_PROMPT`
  `requirement-writer@v1`) — produces a suggested answer per finding, grounded in this
  precedence order: the block's **best-practice fragments** (team/org standards — checked
  FIRST; a match is flagged as the "current standard" and surfaced with a badge), then the
  in-repo `spec/` + `tech-spec/` (via the checkout-free `RepoFiles` port), then web search
  (provider-hosted on Anthropic/OpenAI models; gateway-RAG wiring lands separately).
  Recommendations are NOT AI-reviewed — the human accepts (it becomes the finding's answer,
  folded into the next incorporation), rejects, or re-requests with a "do it differently"
  note. Recommendations are a first-class collection on the review that survives the re-review
  item churn.

  - Contracts: `recommend_requested` item status, `RequirementRecommendation` +
    `recommendations[]` on `RequirementReview`, and the request schemas.
  - Persistence (both runtimes): a `recommendations` JSON column on `requirement_reviews`
    (new D1 migration `0009` ⇄ Drizzle column + generated migration).
  - Service: `RequirementReviewService.recommend` / `acceptRecommendation` /
    `rejectRecommendation` / `reRequestRecommendation`, with optional `resolveRunRepoContext`
    - best-practice-fragment resolver deps (degrade gracefully when unwired).
  - Controller: `POST /blocks/:blockId/requirement-review/recommend` and the
    `…/recommendations/:recId/{accept,reject,re-request}` routes.

  **Board progress for the review companions.** While the review is incorporating, re-reviewing
  or recommending, the board task card / mini-pipeline / inspector now show a spinning stage
  label (`Recommending…` added alongside the existing `Incorporating…` / `Re-reviewing…`).

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13
  - @cat-factory/orchestration@0.11.1
  - @cat-factory/integrations@0.12.4
  - @cat-factory/prompt-fragments@0.7.14
  - @cat-factory/spend@0.8.15

## 0.17.1

### Patch Changes

- aa06003: Service-level default test environment. A service frame now carries a
  `defaultTestEnvironment` (docker-compose **local** vs **ephemeral**) that a task is
  spawned with; each task can still override it per-task via its `tester.environment`
  agent config. The engine resolves the effective environment at run time (task pin →
  service default → built-in `ephemeral`) and materialises it onto the run context, so
  the Tester job body, the prompt and the start-time infra gate all agree. Set the
  default in the service inspector's Test infrastructure panel; the task inspector shows
  the inherited value and labels it "inherited from service" until overridden.

  The cloud-provider and instance-size controls are now explained as **hints for
  ephemeral-environment provisioning** and tucked into a collapsed-by-default section.

  Persisted on both runtimes (D1 migration `0009_default_test_environment` ⇄ Drizzle
  `default_test_environment` column); the cross-runtime conformance suite asserts the
  inheritance + per-task override on each.

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/orchestration@0.11.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/agents@0.11.12
  - @cat-factory/integrations@0.12.3
  - @cat-factory/prompt-fragments@0.7.13
  - @cat-factory/spend@0.8.14

## 0.17.0

### Minor Changes

- 208c933: Pre-flight write access before a repo bootstrap. Bootstrapping ends in a force-push,
  but a public target the GitHub App can _read_ (not in the App's selected-repos list,
  or the App lacking `contents:write`) passes the existing existence/emptiness checks
  and only fails deep inside the container with a `403` on `git push`. The bootstrapper
  now verifies the installation actually has push access up front (new
  `GitHubClient.canPush`, reading the token's effective `permissions.push`) and fails
  fast with an actionable error — "grant the App write access to this repository, or use
  a GitHub PAT" — before any board frame is created.

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/integrations@0.12.2
  - @cat-factory/orchestration@0.10.9
  - @cat-factory/spend@0.8.13

## 0.16.1

### Patch Changes

- 494fb34: Finish the Task-5 strangler: migrate the last two built-in agents (conflict-resolver and
  repo bootstrap) onto the single, manifest-driven `agent` harness kind, then delete every
  bespoke per-kind handler and collapse the dispatch surface. The harness is now a generic
  LLM-over-a-checkout runner with **one** kind — WHAT each agent does is decided entirely by
  the backend and carried as job data.

  **conflict-resolver** now dispatches `kind: 'agent'` `mode: 'coding'` with a `mergeBase`
  (full clone of the PR branch). `handleAgent`'s coding flow merges `origin/<mergeBase>` in to
  surface the conflicts, leads the prompt with the actual conflict hunks it discovers, then
  completes the merge commit and pushes back onto the same branch (no new PR) — refusing to
  push a half-resolved tree. Routed through `buildMigratedBuiltInBody`; the bespoke
  `/resolve-conflicts` body + handler are gone.

  **bootstrap** now dispatches `kind: 'agent'` `mode: 'coding'` with a `bootstrap` spec
  (`{ target, reference?, reinit, forcePush, fromScratch? }`). `handleAgent` clones the
  reference architecture (or scaffolds from an empty dir), runs the agent, guards against a
  no-op, then force-pushes a fresh single-commit history to the separate target repo's default
  branch (lifted `reinitAndPush` / `producedRepoContent`). `ContainerRepoBootstrapper` builds
  the generic body; its `linkRepoToBlock` post-op already lives in `pollBootstrapJob`.

  **Harness cleanup (image bump).** Deleted the bespoke handlers (`blueprint`/`spec`/`explore`/
  `merger`/`on-call`/`tester`/`ci-fixer`/`fixer`/`conflict-resolver`/`bootstrap`/`handleRun`),
  collapsed `server.ts`'s `KINDS` to `{ agent }`, and stripped the bespoke job types + parsers
  from `job.ts` (keeping `parseAgentJob` + the shared helpers + `BootstrapTargetSpec`). The
  executor-harness image is bumped (1.13.0 → 1.14.0; deploy tag + `wrangler.toml`).

  **Kernel (breaking, pre-1.0).** `RunnerDispatchKind` collapses to the single member
  `'agent'`, and `RunnerJobResult` is slimmed to `prUrl` / `branch` / `summary` / `error` /
  `defaultBranch` / `pushed` / `custom` / `usage` (the per-kind `service`/`spec`/`assessment`/
  `onCallAssessment`/`report`/`resolved` channels are removed — every structured agent returns
  its doc on `custom`, coerced kind-aware in `toRunResult`). The transports default to
  `kind: 'agent'`; the runner-pool result coercion passes only `custom` through.

  Two fixes ride along. (1) `toRunResult` now surfaces an opened PR (`prUrl`) **before** the
  in-place-fixer `pushed` branch — the migrated coder returns BOTH `pushed: true` and `prUrl`,
  so the previous ordering silently dropped its structured `pullRequest` (the worker test only
  passed because its fake omitted `pushed`). (2) The local transport ran the per-run container
  privileged off `kind === 'test'`, which never matched after the tester migration; the
  container is per-RUN (created by the run's first step, not the tester), so it now runs
  privileged whenever `privilegedTestJobs` is enabled (gated by the `localDind` capability).

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1
  - @cat-factory/integrations@0.12.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/orchestration@0.10.8
  - @cat-factory/spend@0.8.12

## 0.16.0

### Minor Changes

- 0ac64b8: Add a "Create task from issue" button on service frames, and scope issue search to
  the service's repo.

  A service frame header now carries a ticket button (shown when a tracker is offered)
  that opens the tracker-issue modal pinned to that service: the new task is created in
  that frame, and the issue search is scoped to the service's linked GitHub repository
  instead of the whole installation. The same repo scoping applies to the
  attach-an-issue-as-context picker in the add-task form.

  Within a scoped GitHub search:

  - a pasted issue URL (or `owner/repo#n` / `owner/repo/issues/n`) resolves to that exact
    issue and is offered first instead of being fuzzy-matched — but only within the
    searching workspace's own GitHub App installation, so a URL naming another account is
    never fetched across tenants;
  - a bare issue number (`11`) resolves against the service's repo and is offered first;
  - free-text hits are restricted to the service's repo (`repo:owner/name`).

  A service is always created from (or with) a repo, so a GitHub search scoped to a block
  now REQUIRES that link: if the service isn't linked to a repo the search is refused with
  a clear error rather than silently widening to the whole installation. The
  block→service→repo resolver (`resolveRepoTarget`) is surfaced on the request container in
  both runtime facades so the shared task-search controller can resolve the scope.

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/integrations@0.12.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/orchestration@0.10.7
  - @cat-factory/spend@0.8.11
  - @cat-factory/prompt-fragments@0.7.12

## 0.15.1

### Patch Changes

- 7d1f829: Migrate the `tester` built-in agent onto the generic, manifest-driven `agent` harness kind,
  continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers, the
  coder, blueprints, and spec-writer).

  `ContainerAgentExecutor` now routes `tester` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the PR
  head branch (it makes NO commits) instead of the bespoke `/test` body. The agent returns ONLY
  its structured JSON report; `toRunResult` coerces that `custom` result into the `testReport`
  channel the engine's `TesterController` greenlights-or-loops the fixer on. The conservative
  coercion the harness `/test` handler used to apply — defaulting every field safely and honouring
  a greenlight ONLY when no blocking (high/critical) concern is open — now runs backend-side in
  `coerceTestReport` (and the engine re-applies it defensively). The role prompt and the
  run-mode / ephemeral-URL guidance come from the standard `roleSystemPrompt` + `userPromptFor`,
  which already carry them, so the harness adds none.

  The tester needs its docker-compose dependencies stood up for the run, so the generic
  `agent` explore flow grows an optional `infra` spec (`{ environment, noInfraDependencies?,
composePath?, environmentUrl? }`): `handleAgent`'s explore mode stands the local
  docker-compose infra up before the agent runs and tears it down afterward (lifted from the
  bespoke tester handler), folding a stand-up-failure note into the prompt so a missing Docker
  daemon is non-fatal. An `ephemeral` run manages no infra (the env is already deployed and its
  URL reaches the agent through its prompt). This is a harness `src/**` change, so the
  executor-harness image is bumped (1.13.0; deploy tag + `wrangler.toml`).

  Two regressions the migration introduced are fixed here. (1) The report's `environment` (which
  env the suite ran in, echoed to the UI) was authoritatively set from the task config by the old
  `/test` handler; the migrated `coerceTestReport` only read it from the model's JSON, so it was
  near-always dropped. The harness now stamps `environment` onto the structured result from the
  job's `infra` spec (the authoritative source), so it's deterministic again regardless of what the
  model emits. (2) A `local` service with no infra dependencies lost the precise "nothing was stood
  up — run the suite directly" guidance and was told its infra had been stood up on localhost;
  `testerEnvironmentSection` now restores the no-dependencies run-mode line for those services.

  The dead `/test` harness handler (and the other migrated kinds' handlers) is removed in the
  later harness-cleanup sweep. The cross-runtime conformance suite already covers the generic
  `agent` explore + structured-result path on both runtimes.

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8
  - @cat-factory/orchestration@0.10.6

## 0.15.0

### Minor Changes

- fde0437: Add a first-class **Issue tracker** settings panel (Workspace settings → Issue tracker,
  also linked from the Integrations hub) plus a **live "Check setup" diagnostic** so a
  workspace can both configure issue tracking in one place and see _why_ a source isn't
  working.

  **Panel (frontend).** One discoverable home that gathers what used to be scattered:

  - **Filing tracker** — select where the tech-debt recurring pipeline files its ticket
    (GitHub Issues / Jira / none). Previously only reachable buried inside the tech-debt
    recurring-pipeline modal, so a workspace had no obvious way to designate GitHub Issues.
  - **Linking sources** — the per-workspace on/off toggle for each task source, making
    explicit that filing and linking are independent.
  - **Writeback** — the comment-on-PR-open / close-on-merge toggles, folded in from the old
    standalone "Issue writeback" tab (`IssueTrackerWritebackPanel` is removed).

  **Live "Check setup" (backend, all runtimes).** A new
  `POST /workspaces/:ws/task-sources/:source/diagnostics` endpoint actually authenticates
  against the source and reads a slice of its issues API, returning a classified verdict —
  `ready` / `not_installed` / `not_connected` / `auth_failed` / `forbidden` / `unreachable` /
  `error` — with an actionable message. For GitHub Issues it escalates three probes
  (validate the App credentials → mint the installation token + list repos → read issues on a
  repo) so a 403 pinpoints the most common misconfiguration: the GitHub App lacks the
  **Issues** permission. For Jira it probes `/myself` and distinguishes a rejected token (401)
  from a forbidden account (403). The panel also now surfaces the previously-swallowed probe
  error (e.g. "503 — integration disabled / ENCRYPTION_KEY not set", "500 — backend not
  migrated") instead of a blanket "install integration first".

  Adds an optional `diagnose` capability to the `TaskSourceProvider` port (kernel), implemented
  by the GitHub and Jira providers and orchestrated by `TaskConnectionService.diagnose`
  (integrations), the `taskSourceDiagnosticSchema` wire contract (contracts), and the
  controller endpoint (server). Runtime-neutral — wired through the existing `tasks` module on
  Cloudflare, Node, and local — with a cross-runtime conformance assertion (gate-on-connection
  then delegate-to-provider). A provider without `diagnose` falls back to a static verdict
  from availability.

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/integrations@0.11.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/orchestration@0.10.5
  - @cat-factory/prompt-fragments@0.7.11
  - @cat-factory/spend@0.8.10

## 0.14.1

### Patch Changes

- 77b7d31: Migrate the `spec-writer` built-in agent onto the generic, manifest-driven `agent` harness
  kind, continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers,
  the coder, and blueprints).

  `ContainerAgentExecutor` now routes `spec-writer` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the
  per-block WORK branch (`cat-factory/<blockId>` — the coder's branch, created from base when
  absent; the spec-writer runs BEFORE the coder, so it seeds that branch) instead of the
  bespoke `/spec` body. The agent now READS the baseline spec from its own checkout under
  `spec/` (the harness no longer pre-injects it) and returns ONLY the complete spec doc as JSON;
  `toRunResult` coerces that `custom` result into the `spec` channel (via `coerceSpecDoc`) the
  engine already strict-validates + ingests. The `SPEC_WRITER_SYSTEM_PROMPT` is updated to point
  the agent at `spec/overview.md` + the `spec/modules/**` shards, and a new `specWriterUserPrompt`
  carries the task increment + the read-the-baseline / reuse-the-taxonomy guidance the harness
  `buildUserPrompt`/`renderTaxonomyInventory` used to inject.

  The deterministic SHARD + commit of the in-repo `spec/` artifact that used to live in the
  executor-harness `/spec` handler now runs as a BACKEND built-in post-op (`specPostOp`,
  `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is keyed by the engine's
  own built-in op map in `ExecutionService` — deliberately NOT the agent-kind registry, so the
  built-ins never leak into `customAgentKinds` / the SPA palette. It reproduces the harness
  reconcile exactly: the canonical `service.json` / `overview.md` / `modules/<m>/<g>.{json,md}`
  shards are always rewritten and a removed module/group's shards are PRUNED (the deletion
  channel); the Gherkin `features/<m>/<g>.feature` files are SEEDED-ONCE (committed only when
  absent, never clobbering a polished one); and the pre-sharding monolithic artifacts
  (`spec/spec.json` / `rules.md` / `version.json`) + old flat `features/*.feature` files are
  dropped on sight. Idempotent: the spec has no `version.json` manifest, so the post-op
  byte-compares each rendered shard to the branch and makes NO commit when everything matches
  and there is nothing to seed or prune (durable-driver replay re-commits nothing).

  Because the spec doc is handed onward to be sharded + committed, the migrated kind opts into
  a new `output.failOnUnusableFinal` flag (kernel `AgentOutputSpec`) so the generic explore
  handler FAILS the run LOUDLY when the agent's final answer is cut off at the output ceiling
  (or empty) — restoring the bespoke `/spec` handler's `unusableFinalAnswerCause` gate, which
  the generic `handleAgent` path lacked, so a truncated reply can no longer be laundered into a
  half-baked spec by the structured repair. This is a harness change, so the executor-harness
  image is bumped to `1.12.0` (the `deploy/backend` `image:publish` tag + `wrangler.toml` are
  bumped to match). The dead `/spec` handler is removed in a later sweep step.

  Cross-runtime conformance asserts the post-op shards + commits the `spec/` artifact onto the
  work branch via `RepoFiles` on both runtimes.

  Also fixes a facade-parity gap in the self-hosted runner-pool result coercion
  (`HttpRunnerPoolProvider.coerceRunnerResult`): the generic `agent`-kind structured channel
  `custom` was missing from the pass-through allow-list, so a migrated kind's doc
  (blueprints / spec-writer / merger / on-call) was silently dropped on a runner-pool backend
  while the Cloudflare/local transports — which return the harness view verbatim — kept it.
  `custom` now passes through, and a regression test covers it.

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/orchestration@0.10.4
  - @cat-factory/kernel@0.13.4
  - @cat-factory/integrations@0.10.4
  - @cat-factory/spend@0.8.9

## 0.14.0

### Minor Changes

- 82d771e: Add a "View Requirements" button to a selected service in the inspector that opens a
  structured navigation window over the service's prescriptive spec tree (modules → feature
  groups → requirements + Given/When/Then acceptance criteria + domain rules). When the spec
  is present on the service repo's default branch, a toggle switches to the rendered Gherkin
  scenarios.

  A new read-only endpoint `GET /workspaces/:ws/blocks/:blockId/spec` reassembles the sharded
  `spec/` artifact off the repo default branch via the existing checkout-free `RepoFiles`
  resolver (`resolveRunRepoContext`), now surfaced on the `ServerContainer` and wired
  symmetrically on both runtime facades. It returns `{ present: false }` when GitHub is not
  connected or no spec exists yet, so the window shows an empty state rather than erroring.

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/agents@0.11.5
  - @cat-factory/integrations@0.10.3
  - @cat-factory/kernel@0.13.3
  - @cat-factory/orchestration@0.10.3
  - @cat-factory/prompt-fragments@0.7.10
  - @cat-factory/spend@0.8.8

## 0.13.2

### Patch Changes

- ce27690: Migrate the `blueprints` built-in agent onto the generic, manifest-driven `agent` harness
  kind, and add a checkout-free file-DELETION channel the migration needs.

  `ContainerAgentExecutor` now routes `blueprints` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent (cloning the PR
  branch when one is open, else the default branch — exactly its old `prBranch ?? baseBranch`
  clone) instead of the bespoke `/blueprint` body. The agent now returns ONLY the service →
  modules tree as JSON; `toRunResult` coerces that `custom` result into the `blueprintService`
  channel (via `coerceBlueprintService`) the engine already reconciles onto the board.

  The deterministic render + commit of the in-repo `blueprints/` artifact that used to live in
  the executor-harness `/blueprint` handler now runs as a BACKEND built-in post-op
  (`blueprintPostOp`, `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is
  keyed by the engine's own built-in op map in `ExecutionService` — deliberately NOT the
  agent-kind registry, so the built-ins never leak into `customAgentKinds` / the SPA palette.
  The post-op is idempotent (the `version.json` content hash short-circuits an unchanged tree,
  so a durable-driver replay re-commits nothing) and prunes a removed module's stale deep-dive
  file — the checkout-free analogue of the harness wiping `blueprints/` before writing.

  To support that prune, `commitFilesSchema` / `CommitFilesInput` (and the `RepoFiles` /
  `GitHubClient` `commitFiles` impl in `FetchGitHubClient`) gain an optional `deletions:
string[]`: paths removed in the same commit, built into the Git Data tree as `sha: null`
  entries against the base tree. Additive and non-breaking (absent ⇒ a pure add/update commit).

  The already-shipped executor-harness image serves this via its generic `handleAgent`
  explore-structured handler, so **no image bump is required**. One intentional, low-risk delta:
  the blueprint explore body now carries the shared web-tools fields like every other explore
  agent (gated by `webSearchProxyEnabled`), and the agent reads any existing blueprint from its
  own checkout rather than the harness pre-injecting the baseline tree into the prompt.

  The now-dead `/blueprint` harness handler is removed in a later step of the sweep (which
  bumps the executor image), once parity is confirmed on CI. The cross-runtime conformance
  suite gains an assertion that a `blueprints` step's post-op renders + commits the
  `blueprints/` artifact via `RepoFiles`, identically on both runtimes.

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/orchestration@0.10.2
  - @cat-factory/integrations@0.10.2
  - @cat-factory/prompt-fragments@0.7.9
  - @cat-factory/spend@0.8.7

## 0.13.1

### Patch Changes

- c8bd144: Migrate the next batch of built-in agents — `coder`, `ci-fixer`, `fixer`, `merger` and
  `on-call` — onto the generic, manifest-driven `agent` harness kind, continuing the
  strangler started with the read-only kinds.

  `ContainerAgentExecutor` now routes these through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` (which gained an optional `userPrompt` override) instead of their
  bespoke per-kind bodies:

  - `coder` dispatches `kind: 'agent'` in `mode: 'coding'` (clone the work branch, push it,
    open a PR). `runCodingAgent` already does branch-resume + checkpointing, so this is
    behaviour-equivalent to the old `/run` body.
  - `ci-fixer` / `fixer` dispatch `mode: 'coding'` against the PR branch with
    `noChangesIsError: false` (in-place fixers — a no-op is a clean non-event), matching the
    old `/ci-fix` / `/fix-tests` bodies.
  - `merger` / `on-call` dispatch `mode: 'explore'` with structured output (full clone). The
    conservative JSON coercion that used to live in the harness `/merge` and `/on-call`
    handlers now runs backend-side: `toRunResult` is kind-aware and maps the agent's `custom`
    result into `mergeAssessment` / `onCallAssessment` via `coerceMergeAssessment` /
    `coerceOnCallAssessment`, so the engine's merge resolver and post-release-health gate see
    exactly the same assessment shape as before.

  The already-shipped executor-harness image serves all of these via its generic `handleAgent`
  handler (explore-structured + coding-on-PR/coding-with-PR), so no image bump is required.
  Two intentional, low-risk deltas: the merger/on-call explore bodies now carry the shared
  web-tools fields like every other explore agent (gated by `webSearchProxyEnabled`), and the
  merger's container-side `diffExaminable` guard is replaced by the backend coercion's
  conservative-on-garbage defaults (documented in `coerceMergeAssessment`).

  The now-dead `/run`, `/ci-fix`, `/fix-tests`, `/merge` and `/on-call` harness handlers are
  removed in a later step of the sweep (which bumps the executor image), once parity is
  confirmed on CI.

  Three correctness fixes to the kind-aware mapping itself:

  - The poll site (`ExecutionService.pollAgentJob`) now threads `step.agentKind` into the
    `pollJob` handle. `toRunResult`'s kind-aware coercion keys off `handle.agentKind`, which
    the engine previously never supplied at poll time — so the merger/on-call coercion was
    dead code and `mergeAssessment` / `onCallAssessment` were never set, leaving the merge
    gate and post-release-health gate with no assessment.
  - `clamp01` no longer coerces `null` / `''` / `false` / `[]` to a finite `0` (via `Number()`):
    those now fall back to the conservative default (`1` for the merger → routes to human
    review), so a garbage/null score can't silently read as "trivial/safe" and auto-merge.
  - The coerced `rationale` falls back to a stable `"No rationale provided."` when both the
    agent rationale and the run summary are empty, instead of an empty string.

- Updated dependencies [c8bd144]
  - @cat-factory/orchestration@0.10.1
  - @cat-factory/kernel@0.13.1
  - @cat-factory/agents@0.11.3
  - @cat-factory/integrations@0.10.1
  - @cat-factory/spend@0.8.6

## 0.13.0

### Minor Changes

- 5c915fd: Replace the deployment-level `TASK_SOURCES` env allow-list with a per-workspace,
  UI-driven on/off toggle for each task source (Jira / GitHub Issues), persisted in DB.

  A source is now offered to a workspace when it is **available** AND **enabled**:

  - Availability is intrinsic, not a deployment switch. Jira is always registered (its
    credentials are per-workspace, entered in the UI) and is available once connected.
    GitHub Issues registers whenever the GitHub integration is configured and is available
    once the workspace has installed the GitHub App — it rides that App, so there is nothing
    to "connect" (the credentialless connect path now returns a clear error).
  - `enabled` is the new per-workspace toggle (defaults to on). A workspace can disable
    GitHub Issues to use GitHub repos without offering their issues, or park a connected
    Jira without disconnecting it. A disabled source is hidden from the import/link UI and
    its import/search endpoints are refused (409).

  New surface:

  - `task_source_settings` table, mirrored D1 (migration `0008_task_source_settings.sql`)
    ⇄ Drizzle (`taskSourceSettings` + generated migration), behind a new
    `TaskSourceSettingsRepository` kernel port.
  - `GET /workspaces/:ws/task-sources` now returns each source's descriptor plus
    `available` + `enabled`; `PUT /workspaces/:ws/task-sources/:source/enabled` toggles it.
  - The SPA settings modal hosts the toggle, and import entry points key off the offered
    (available + enabled) set instead of raw connections.

  BREAKING: the `TASK_SOURCES` env var (Cloudflare `wrangler.toml` / Node `.env`) and
  `TasksConfig.sources` are removed. Delete `TASK_SOURCES` from any deployment config —
  which sources a workspace uses is now controlled in the app, not by the operator.

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0
  - @cat-factory/integrations@0.10.0
  - @cat-factory/orchestration@0.10.0
  - @cat-factory/agents@0.11.2
  - @cat-factory/prompt-fragments@0.7.8
  - @cat-factory/spend@0.8.5

## 0.12.1

### Patch Changes

- 22d7fff: Migrate the read-only built-in agents (`architect`, `analysis`, `bug-investigator`) onto
  the generic, manifest-driven `agent` harness kind — the first step of the strangler that
  converts every built-in to the custom-agent model.

  `ContainerAgentExecutor` now dispatches the read-only kinds through `buildRegisteredAgentBody`
  with a synthesized `container-explore` step, so they ride `kind: 'agent'` in `mode: 'explore'`
  (the SAME path a deployment's registered `container-explore` kind takes) instead of the
  bespoke `explore` dispatch kind. The job body is byte-identical to the old `/explore` body
  (same branch resolution, prompts and web-tools) bar the harness-internal temp-dir label, and
  the prose result maps to `output` exactly as before — a behaviour-preserving reroute, not a
  behaviour change. The already-shipped executor-harness image serves this via its generic
  `handleAgent` handler, so no image bump is required.

  The now-dead `/explore` harness handler (`handleExplore` / `parseExploreJob` / the `explore`
  dispatch kind) is removed in a follow-up once parity is confirmed on CI.

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1
  - @cat-factory/orchestration@0.9.1

## 0.12.0

### Minor Changes

- 128e12e: Custom agents: live pre/post-op execution + data-driven palette + generic result view.

  Registered custom agent kinds now run end to end. A kind's deterministic backend hooks
  fire around its agent step: `ExecutionService` runs its `preOps` before dispatch and its
  `postOps` after the result is recorded, over a per-run, checkout-free `RepoFiles` bound to
  the run's repo. The binding is a new optional engine dependency `resolveRunRepoContext`
  (`CoreDependencies` / `ExecutionServiceDependencies`), composed from a facade's wired
  `GitHubClient` + the executor's `resolveRepoTarget` via the new
  `makeResolveRunRepoContext` (`@cat-factory/server`) and wired symmetrically across ALL
  three facades (Worker `selectGitHubDeps`, Node `githubGateDeps`, local via
  `buildNodeContainer`). When GitHub isn't connected the hooks are skipped, so pipelines run
  unchanged without the feature. `runRepoOps` moved to `@cat-factory/agents` so the
  orchestration engine drives the hooks without importing the server HTTP layer. New kernel
  ports: `RunRepoContext` + `ResolveRunRepoContext`. The cross-runtime conformance suite
  asserts a registered kind's pre-op read + post-op commit on both D1 and Postgres.

  Frontend: the workspace snapshot now carries `customAgentKinds` (kind + presentation +
  container flag), which the SPA merges into its palette catalog
  (`useAgentsStore().registerCustomKinds`) so a registered kind is a first-class palette
  block + result view instead of the generic fallback. A `container-explore` structured
  kind's `result.custom` JSON is recorded on the step (new `PipelineStep.custom`) and
  rendered read-only by a new shared `generic-structured` result view — a custom agent gets
  a usable result window with no bespoke UI.

  The built-in agents are not yet migrated to this model (their rendering still lives in the
  executor-harness); that strangler conversion is sequenced as follow-up work. See
  `backend/docs/custom-agents.md` and the `@cat-factory/example-custom-agent` worked example.

- 4de2f5f: Declutter settings/navbar and make post-release health a pluggable observability integration.

  **Frontend**

  - Workspace settings is now a single tabbed window: **Merge thresholds**, **Issue writeback**
    and **Default service best practices** moved from standalone modals into tabs (their navbar/
    command-bar entries now deep-link to the tab). Fixed the **Mode** select clipping its options.
  - Removed the **Add a block** button and **all** "Add &lt;type&gt; block" command-bar commands
    (services come from Bootstrap / Add-from-repo, tasks from the add-task flow); dropped the
    unsupported `external` / `environment` block types.
  - The new-task form now shows **Context documents** and **Context issues** sections (inspector-
    style) **ungated** — the _Attach_ button is disabled with a tooltip until the relevant
    integration is connected. (`ContextPicker.vue` removed.)
  - Post-release health is no longer a Datadog-named window: the **connection** is an
    **Observability** entry in the Integrations hub (`ObservabilityConnectionPanel`, provider
    picker — Datadog today), and the per-service **monitor/SLO mapping** moved into the **service
    inspector** (`ServiceReleaseHealthConfig`, keyed by the selected frame — no manual block-id
    entry, disabled with a hint until a connection exists).

  **Backend — pluggable observability (Datadog = one adapter)**

  - The `ReleaseHealthProvider` is now served by `RegistryReleaseHealthProvider`, a registry of
    per-vendor adapters; the Datadog logic became `DatadogObservabilityAdapter`. Adding a second
    provider is a new registry entry — the gate, service, routes and persistence are vendor-neutral.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - Persistence: the `datadog_connections` table is **dropped** and replaced by
    `observability_connections` (`provider` discriminator + a single sealed `credentials` JSON blob
    - a non-secret `summary`), mirrored D1 ⇄ Drizzle. Existing connections must be re-entered.
  - Kernel: `DatadogConnectionRecord`/`DatadogConnectionRepository` →
    `ObservabilityConnectionRecord`/`ObservabilityConnectionRepository` (+ `ObservabilityProviderKind`).
  - Contracts: `upsertDatadogConnectionSchema` / `datadogConnectionViewSchema` →
    `upsertObservabilityConnectionSchema` / `observabilityConnectionViewSchema` (now `{ provider,
credentials }` / `{ connected, provider, summary }`), plus `observabilityConnectionSummary`.
  - HTTP: `GET|PUT|DELETE /workspaces/:ws/datadog/connection` → `…/observability/connection`.
  - Config/env: `DATADOG_ENABLED` → `OBSERVABILITY_ENABLED`; `AppConfig.datadog` → `AppConfig.releaseHealth`
    (`DatadogConfig` → `ReleaseHealthConfig`); the sealed-secret domain tag `cat-factory:datadog` →
    `cat-factory:observability`.

  Note: the cross-runtime conformance suite does not yet cover the observability connection CRUD
  (it never covered the Datadog connection either); both facades wire the same repos/cipher/provider
  and ship mirrored D1 + Drizzle migrations.

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/orchestration@0.9.0
  - @cat-factory/integrations@0.9.0
  - @cat-factory/spend@0.8.4
  - @cat-factory/prompt-fragments@0.7.7

## 0.11.1

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/integrations@0.8.3
  - @cat-factory/kernel@0.11.1
  - @cat-factory/orchestration@0.8.1
  - @cat-factory/spend@0.8.3

## 0.11.0

### Minor Changes

- 1e31cbc: Replace per-agent-kind model defaults with named **model presets**.

  A workspace now keeps a library of model presets instead of a single per-agent-kind
  default map. A preset is one `baseModelId` applied to every agent kind plus optional
  per-kind `overrides`, so "everything Kimi K2.7" is a base with no overrides. Two
  built-ins are seeded for every workspace: **Kimi K2.7** (the default — every agent runs
  on Kimi K2.7) and **GLM-5.2**. A task selects a preset via the new `Block.modelPresetId`
  (the inspector's "Model preset" picker + the new-task form); changing it affects only
  steps that haven't started yet. Resolution precedence is unchanged in spirit: a block's
  pinned model wins, else the task's selected/default preset's mapping for the kind, else
  the env routing.

  - `@cat-factory/contracts`: new `model-presets.ts` (`ModelPreset`, create/update schemas);
    `Block.modelPresetId`; `addTask`/`updateBlock` accept `modelPresetId`; the snapshot
    carries `modelPresets` instead of `modelDefaults`. The `model-defaults` contract is removed.
  - `@cat-factory/kernel`: new `ModelPresetRepository` port (replaces `ModelDefaultsRepository`),
    `DEFAULT_MODEL_PRESETS` seed + `modelForKindFromPreset` helper; `resolveWorkspaceModelDefault`
    resolvers gain an optional `modelPresetId` argument throughout.
  - `@cat-factory/orchestration`: `ModelPresetService` (CRUD + lazy seeding, replaces
    `ModelDefaultsService`) and `resolvePresetModelForKind`; the execution engine threads the
    block's preset into model resolution, the personal-credential gate and the start guard.
  - `@cat-factory/agents`: `StepModelInputs.modelPresetId` + the resolver signature.
  - `@cat-factory/server`: `ModelPresetController` (`GET|POST|PATCH|DELETE
/workspaces/:ws/model-presets`, replaces the model-defaults controller); the block mappers
    persist `model_preset_id`; the snapshot lists `modelPresets`.
  - `@cat-factory/worker` / `@cat-factory/node-server`: the `model_presets` table (D1 migration
    `0006` ⇄ Drizzle) + `blocks.model_preset_id`, replacing `workspace_model_defaults`.

  BREAKING (pre-1.0, no migration): the `workspace_model_defaults` table, the
  `/model-defaults` endpoint, and the snapshot's `modelDefaults` field are removed. Existing
  per-agent-kind default maps are dropped; workspaces fall back to the seeded built-in presets.

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0
  - @cat-factory/orchestration@0.8.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/integrations@0.8.2
  - @cat-factory/prompt-fragments@0.7.6
  - @cat-factory/spend@0.8.2

## 0.10.0

### Minor Changes

- d0081e1: Shard the in-repo `spec/` artifact by a module → feature taxonomy to kill merge churn.

  The spec-writer no longer commits a single monolithic `spec/spec.json` (+ `overview.md`
  / `rules.md` / `version.json`); every spec run rewrote those whole files, so two task
  branches that both touched the spec conflicted hard on merge. The spec is now SHARDED:
  a tiny `spec/service.json`, an `spec/overview.md` index, and one canonical
  `spec/modules/<module>/<group>.json` (+ a human `<group>.md`) per feature group, with
  the Gherkin `spec/features/<module>/<group>.feature` files nested to match. A group's
  file bytes depend only on that group, so concurrent branches editing different
  features never touch the same file.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - `@cat-factory/contracts`: `SpecDoc` gains a two-level taxonomy — `modules: SpecModule[]`
    where each module holds `groups`, and each group carries BOTH its `requirements` and the
    domain `rules` scoped to it. The top-level `SpecDoc.groups`/`SpecDoc.rules`,
    the `SpecVersion`/`version.json` manifest, and the `SPEC_JSON_PATH`/`SPEC_RULES_PATH`/
    `SPEC_VERSION_PATH` path constants are removed; `SPEC_SERVICE_PATH`/`SPEC_MODULES_DIR`
    are added. `renderSpecForReview` walks the new shape. An existing repo's monolithic
    `spec.json` / `rules.md` / `version.json` (and any old flat `features/*.feature` files)
    are DELETED on the next spec run — the sharded layout is written fresh; no migration.
  - `@cat-factory/executor-harness`: sharded deterministic render + on-disk reassembly
    read-back + orphan-shard pruning (a removed/renamed module or group is deleted, not
    resurrected) + a one-time prune of the pre-sharding monolithic/flat artifacts;
    `version.json` dropped (no-op detection is now per-file via the commit).
    Content-derived (not positional) rule ids keep a group file byte-stable. The spec-writer
    prompt + reassembled-baseline now carry an EXISTING-taxonomy inventory and steer the
    agent to slot new requirements/rules into the closest existing module + feature (reusing
    exact names) rather than spawning near-duplicate domains/groups. Ships in the **1.9.0**
    runner image already pinned in `deploy/backend` (no further tag move needed).
  - `@cat-factory/agents`: the runtime-neutral `repo-ops/render.ts` mirror is reworked to
    the same sharded layout (`renderSpecVersionFile`/`nextSpecVersion`/`canonicalSpecJson`/
    `hashSpec` for the spec removed); `SPEC_AWARE_GUIDANCE` points readers at
    `spec/modules/<module>/<feature>.{md,json}`.
  - `@cat-factory/server`: `SPEC_WRITER_SYSTEM_PROMPT` describes the module → feature →
    {requirements, rules} structure, the no-catch-all rule, and the taxonomy-reuse rule.

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/agents@0.9.0
  - @cat-factory/integrations@0.8.1
  - @cat-factory/kernel@0.10.1
  - @cat-factory/orchestration@0.7.7
  - @cat-factory/prompt-fragments@0.7.5
  - @cat-factory/spend@0.8.1

## 0.9.0

### Minor Changes

- ae29687: OpenRouter: dynamic multi-tenant catalog + flavour unification.

  **Flavour unification.** A catalog model can now carry an `openrouter` flavour alongside
  `cloudflare`/`direct`/`subscription`. `effectiveVariant` resolves in the precedence
  direct → openrouter → cloudflare (the subscription override still wins in `ModelRouter`),
  so the SAME logical model routes through OpenRouter when only an OpenRouter key is
  configured, and through its native vendor when that key is present. The standalone
  `openrouter-*` catalog entries are folded into their native twins: `deepseek`, `gpt-5.5`
  and `claude-opus` gain an `openrouter` route; Gemini 3 Pro becomes a curated `gemini`
  entry. **Breaking (pre-1.0, acceptable):** the catalog ids `openrouter-claude-opus`,
  `openrouter-gpt`, `openrouter-deepseek`, `openrouter-gemini-pro` and `openrouter-llama`
  are removed — a block pinned to one falls through to default routing.

  **Dynamic catalog.** A workspace can now browse OpenRouter's live `/models` and enable a
  subset in the UI (the new "OpenRouter models" panel), rather than a hardcoded handful.
  Enabled models surface in the per-workspace picker as `openrouter:<slug>` entries with
  their live context window and price (overlaid onto the spend table, so budgets meter
  accurately). Persisted in a new generic per-workspace `provider_model_catalog` table
  (D1 ⇄ Drizzle, keyed by `(workspace_id, provider)` so future gateways like LiteLLM reuse
  it), behind the new kernel `ProviderModelCatalogRepository` port and the
  `OpenRouterCatalogService` (refresh leases the workspace's pooled OpenRouter key). New
  routes: `GET|PUT /workspaces/:ws/openrouter/catalog`, `POST /workspaces/:ws/openrouter/refresh`.
  Cross-runtime conformance asserts the enabled-subset round-trip + catalog surfacing on
  both D1 and Postgres.

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/spend@0.8.0
  - @cat-factory/integrations@0.8.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/orchestration@0.7.6
  - @cat-factory/prompt-fragments@0.7.4

## 0.8.0

### Minor Changes

- 5c20968: Add the generic, manifest-driven `agent` harness kind + its backend dispatch.

  - `@cat-factory/executor-harness`: a single generic `agent` job kind (`parseAgentJob` +
    `handleAgent`) that runs an LLM over an optional checkout in one of two modes —
    `explore` (read-only; returns prose, or a parsed `custom` JSON object) or `coding`
    (clone/edit/commit/push, optionally open a PR), built on the existing
    `runAgentInWorkspace`/`runCodingAgent`/`resolveStructuredOutput` primitives. It holds no
    per-agent-kind logic; the bespoke kinds remain during migration. **Image bump** (the
    deploy tag moves to `1.9.0` so the new kind rolls out).
  - `@cat-factory/kernel`: `RunnerDispatchKind` gains `'agent'`; `RunnerJobResult` and
    `AgentRunResult` gain a generic `custom` channel for a structured agent's output. The
    `GitHubClient` port gains `branchHeadSha` — an exact single-ref head lookup that stays
    correct on repos with more branches than one `listBranches` page (the create-vs-commit
    signal `RepoFiles.headSha` relies on).
  - `@cat-factory/server`: `ContainerAgentExecutor` dispatches any registered kind that
    declares an `agent` step through the generic `agent` kind (`buildRegisteredAgentBody`)
    and maps `custom` results; built-in kinds are unchanged. New `RepoFiles` implementation
    (`makeRepoFiles`/`makeResolveRepoFiles`, a checkout-free facade over the `GitHubClient`
    Git Data API) + a `runRepoOps` helper — the substrate the pre/post-op engine wiring will
    use next.

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/integrations@0.7.5
  - @cat-factory/orchestration@0.7.5
  - @cat-factory/spend@0.7.5

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/orchestration@0.7.4
  - @cat-factory/integrations@0.7.4
  - @cat-factory/prompt-fragments@0.7.3
  - @cat-factory/spend@0.7.4

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/spend@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/integrations@0.7.3
  - @cat-factory/orchestration@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/contracts@0.7.2
  - @cat-factory/integrations@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/orchestration@0.7.2
  - @cat-factory/prompt-fragments@0.7.2
  - @cat-factory/spend@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/contracts@0.7.1
  - @cat-factory/integrations@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/orchestration@0.7.1
  - @cat-factory/prompt-fragments@0.7.1
  - @cat-factory/spend@0.7.1

## 0.7.0

### Minor Changes

- e0e89a7: Document- and task-source integrations are now **always on** instead of opt-in, and
  credential encryption is consolidated onto a single shared key.

  The `DOCUMENTS_ENABLED` / `TASKS_ENABLED` flags are gone — tenants connect their own
  Notion/Confluence/Jira sources interactively through the task-creation modal, so there
  is no service-level toggle to forget. A missing encryption key now **fails loudly at
  config load** rather than silently dropping the feature from the UI.

  **Breaking — single encryption key.** The per-integration `DOCUMENTS_ENCRYPTION_KEY`,
  `TASKS_ENCRYPTION_KEY`, `ENVIRONMENTS_ENCRYPTION_KEY` and `RUNNERS_ENCRYPTION_KEY` env
  vars are **removed**. One shared **`ENCRYPTION_KEY`** now backs all four integrations
  (the cipher already domain-separates per integration via its HKDF `info` tag, so a
  single master key is safe). Deployments must set `ENCRYPTION_KEY`; the always-on
  document/task sources refuse to boot without it, and the opt-in environment/runner
  integrations read it too. The Node facade serves task sources only (it ships no
  document providers yet), so it requires `ENCRYPTION_KEY` but no document-source wiring.

- 3d9a9d8: Requirements incorporation + re-review now run asynchronously instead of freezing the
  review window.

  Previously, clicking "Incorporate answers" fired two sequential LLM calls (fold the answers,
  then re-review) inside the HTTP request, locking the user in the modal until the round
  resolved. Now the request records the human's intent on the parked run, signals the durable
  driver, and returns at once with the review in a new transient `incorporating` status. The
  fold + re-review run in the same durable driver the rest of the pipeline uses (where the
  initial reviewer pass already runs), so the user goes straight back to the board. They are
  summoned again — via the existing `requirement_review` notification — only when the
  re-review raises new findings (`ready`) or hits the iteration cap (`exceeded`); a converged
  re-review (`incorporated`) just advances the pipeline with no interruption.

  - **Engine.** The `requirements-review` gate is now re-entrant: a parked gate carrying a
    `pendingIncorporation` marker re-evaluates on wake, runs `incorporate()` + `reReview()`,
    then advances or re-parks. New `ExecutionService.incorporateRequirements` validates the
    findings are settled, flags the review `incorporating`, and signals the driver. An
    off-path inspector review with no parked run still incorporates inline (there is no driver
    to offload to).
  - **Live event.** New optional `ExecutionEventPublisher.requirementReviewChanged` +
    `{ type: 'requirements' }` `WorkspaceEvent`, so an open window/inspector tracks the status
    transitions live (Cloudflare pushes via the DO hub; Node reconciles on poll, as today).
  - **API.** Incorporation moves to the block-scoped `POST
/blocks/:blockId/requirement-review/incorporate` (was the reviewId-scoped
    `/requirement-reviews/:reviewId/incorporate`) and returns the `incorporating` review
    rather than `{ review }`.
  - **Conformance.** A new cross-runtime assertion proves the async-incorporate route is
    mounted on every facade and refuses incorporation while a finding is unanswered.

  Breaking (pre-1.0, no migration): the new `incorporating` review status, the `requirements`
  event variant, the transient `pendingIncorporation` field on a pipeline step, and the moved
  incorporate endpoint are new wire shapes. Old clients and any in-flight review rows on the
  old endpoint shape simply break; stale state is acceptable per the no-backwards-compat
  policy.

- 3bc8c79: Capture the model's reasoning / "thinking" trace in LLM observability. A reasoning
  model (e.g. `@cf/moonshotai/kimi-k2.7-code`) can spend its whole output budget in a
  separate reasoning channel and return an empty completion — previously those output
  tokens were unaccounted for (`response_text` empty, no trace), which made an empty
  spec-writer/blueprint failure undiagnosable. The LLM proxy now records `reasoningText`
  alongside `responseText`: the Workers AI in-process path reads it from the AI SDK
  (`generateText`'s `reasoningText`), and the OpenAI-compatible buffered + streamed paths
  read `reasoning_content` / `reasoning`. Stored in the new `reasoning_text` column
  (`llm_call_metrics`, D1 migration `0002_llm_reasoning_text` ⇄ Drizzle), surfaced in the
  metrics export and the Observability panel, and used as the Langfuse trace output when
  the response text is empty.

  Breaking: the `llm_call_metrics` table gains a non-null `reasoning_text` column (old
  rows default to `''`).

- 8d11833: Companion agents + acceptance-test rework (the structured spec replaces the
  client-only scenario surface), plus a vocabulary split so "requirements" (the
  linked-prose context review) and "spec" (the structured in-repo document) are no
  longer the same word.

  - **Companion agents.** A companion grades a prior producer step's output, returns
    an overall quality rating (0..1), and — below the step's threshold (default 0.8) —
    loops the producer back for automatic rework BEFORE a human is asked, failing the
    run (`companion_rejected`) once the rework budget is spent. Companions declare an
    allow-list of target kinds and are placed as their own chain step in the pipeline
    builder (with a per-step `thresholds` array, parallel to `gates`). Built-ins:
    `architect-companion`, `spec-companion`, and `reviewer` reframed as the coder's
    companion. Wired into `ExecutionService` (`evaluateCompanion` + a unified rework
    revision path shared with the human "request changes" flow).
  - **Companion-gated requirements rework.** The per-block requirements review's
    rework step is now gated by a quality companion: below threshold the reworked doc
    is NOT accepted (the review stays `ready`), and the companion's challenge is
    surfaced in the review window and fed into the next rework. Persisted on
    `requirement_reviews.companion` (D1 migration 0036 + Drizzle).
  - **Acceptance tests via the spec.** The client-only scenarios store/UI is removed;
    the structured Given/When/Then acceptance scenarios live in the service spec
    (authored by the `spec-writer`, reviewed on its gated step) and are derived into
    Gherkin. The redundant `acceptance` polish agent is dropped; `playwright` still
    writes the runnable tests. `spec-writer`'s prompt now treats complete
    acceptance-scenario coverage as a first-class deliverable.
  - **`architect` is now a container agent** that explores the repo (read-only, like
    `analysis`) before proposing. Both read-only kinds share one reusable execution
    path: a new harness `/explore` endpoint (dispatch kind `explore`) clones the branch,
    runs the agent read-only and returns its prose report/proposal — making no commit,
    opening no PR, and (unlike `/run`) NOT treating an edit-free run as a failure. A
    shared read-only guardrail is appended to their system prompts.
  - **Companion rework correctness.** When a companion loops a producer back, EVERY step
    between the producer and the companion is now reset and re-run (clearing stale
    container job handles), so an intermediate container step re-dispatches fresh work
    instead of re-attaching to its evicted job. The automatic rework budget now counts
    only automatic attempts (`companion.attempts`); a human "request changes" on a
    companion's gate re-runs the producer without consuming it.
  - **Rename: requirements → spec** for the structured family. In-repo `requirements/`
    → `spec/` (`spec.json`, `spec/features/*.feature`; legacy `requirements/`
    relocated on first run); `RequirementsDoc` → `SpecDoc`; `requirements-writer` →
    `spec-writer`; the pipeline analyst `requirements` → `requirements-review`;
    `pl_requirements` → `pl_spec`. The context-review family (`RequirementReview*`,
    `requirement_reviews`) keeps the `requirements` name.

  The harness image changed (the `/requirements` endpoint + `requirements/` paths
  became `/spec` + `spec/`), so `@cat-factory/executor-harness` and the
  `deploy/backend` image tag are bumped to 1.0.6 and must be re-published + rolled out.

- 8065fed: Make the CI / conflicts gates observable. The gate window now shows the run id
  (copyable, with a jump into observability), a per-attempt history of every
  ci-fixer / conflict-resolver run (what each tried and how it ended), and — for
  the conflicts gate — the resolver's own account of which files it left
  conflicting (GitHub's API exposes mergeability as a single bit, so this comes
  from the resolver, plus a link to inspect the PR on GitHub). Failing CI checks
  now link straight to their GitHub run logs.

  Mechanically: `GateStepState` gains an append-only `attemptLog`; the engine
  records each gate-helper attempt when its job finishes (previously discarded the
  moment the gate re-probed) and sets the conflicts gate's `lastFailureSummary`
  from the resolver's output. `CiCheck` / `gateFailingCheckSchema` /
  `githubCheckRunSchema` carry the check run's `html_url` so the UI can link to it
  (populated on the live check-runs read; not persisted to the projection). The
  conflict-resolver result mapping now surfaces the still-conflicting file list
  (its `error`) instead of dropping it.

  Also tightens the conflict-resolver prompt: lockfiles (`package-lock.json`,
  `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, …) must be regenerated via the package
  manager rather than hand-merged — large generated files are what exhausted the
  resolver's context window and left big conflict sets unresolved.

- 385bd93: Add an optional consensus-orchestration framework + a core Task Estimator.

  A new opt-in `@cat-factory/consensus` package lets an eligible agent step run through
  a multi-model **consensus** process — a specialist panel, a debate, or ranked
  voting/scoring — to produce a higher-quality result of the same shape the single-actor
  agent would have (a polished document, an aggregate of observations, an estimate). It
  integrates via the `AgentExecutor` seam: a `ConsensusAgentExecutor` wraps the standard
  composite and delegates to it when a step isn't consensus-enabled or gating marks the
  task ineligible. Eligibility is surfaced through a new group of assignable capability
  traits (`specialist-panel-capable` / `debate-capable` / `ranked-voting-capable`); the
  pipeline builder shows an "Enable Consensus" toggle (strategy, participants + models,
  optional risk/impact gating) on eligible steps. Each session persists a full transcript
  (`consensus_sessions`, both runtimes) rendered in a dedicated Consensus Session window
  and streamed live via a new `consensus` workspace event; every sub-call flows to
  `llm_call_metrics`. Wired per facade behind `CONSENSUS_ENABLED` (off ⇒ unchanged).

  A new **core** `task-estimator` agent rates a task's Complexity/Risk/Impact (0..1) after
  requirements are clarified; the engine persists it on `block.estimate` (new column on
  both stores) and the inspector shows the ratings. It gates the expensive consensus step
  and is useful standalone for triage.

  BREAKING (pre-1.0, no migration): `Block` gains `estimate`, the pipeline + pipeline-step
  shapes gain `consensus`, `AgentRunContext` gains `consensus` + `block.estimate`, and the
  `WorkspaceEvent` union + `ExecutionEventPublisher` gain a consensus variant. Stale rows /
  shapes simply re-create.

- 0972696: Surface external context sources in the add-task popup, with search + a new GitHub
  repo-doc source.

  The task-creation popup gains a `ContextPicker`: pick a connected source
  (Confluence, Notion, GitHub repo docs, Jira, GitHub issues), then **search its
  catalogue by title/content**, paste a page/issue URL, or pick something already
  imported — chosen items are imported and linked to the new task as agent context
  when it's created. Previously the popup could only tick already-imported items and
  there was no in-UI way to reach the catalogue.

  - **Search** is a new optional capability on the document/task source providers
    (`search?(credentials, query)`), exposed as `POST
/workspaces/:ws/{document,task}-sources/:source/search`. Implemented for
    Confluence (CQL), Notion (`/v1/search`), Jira (JQL), GitHub issues
    (`/search/issues`) and GitHub docs (`/search/code`). The `GitHubClient` port
    gains `searchIssues` / `searchCode`. Descriptors advertise `searchable` so the UI
    knows when to offer a search box.
  - **GitHub repo docs** are a new `github` document source: link a Markdown/text
    file from a repo (README, RFC, architecture note) by URL or `owner/repo:path`, or
    by code-search. Like GitHub issues it reuses the workspace's installed GitHub App
    (no credentials of its own) and is wired only when the GitHub integration is on.

- e9b9356: Create board tasks directly from imported GitHub issues or Jira tickets.

  Previously an imported issue could only be attached to an _existing_ task block as
  agent context. The task-source integration now also materialises an issue as a
  brand-new board task: `TaskLinkService.createTaskFromIssue` seeds a leaf block
  (title `KEY: summary`, description = a source-reference line + the issue body)
  inside a chosen service frame or module via `BoardService.addTask`, then links the
  issue to the new task so every agent step still sees the full issue (description,
  comments, metadata) as context. The issue stays the source of truth — re-importing
  refreshes it. Backed by `POST /workspaces/:ws/tasks/create-block`
  (`{ source, externalId, containerId }` → `{ block, task }`). In the UI, the
  task-source import modal gains a "create tasks in" container picker and a per-issue
  "Create task" action.

  The new task carries `createdBy` (the signed-in user, threaded through the widened
  `BoardWritePort.addTask`) for notification routing, the container is resolved in the
  request workspace so the workspace-scoped issue link always resolves at execution
  time, and creating a second task from an already-linked issue is refused (`409`)
  rather than silently re-pointing the single issue→block link. The shared
  cross-runtime conformance suite now asserts the whole create-task-from-issue flow
  (seeded over a deterministic task source) against BOTH the Cloudflare/D1 and the
  Node/Postgres facades.

  Also closes two cross-runtime parity gaps in the task-source layer so the feature
  works identically on both facades:

  - **GitHub issues as a task source now work on the Node runtime.** The
    runtime-neutral `GitHubIssuesProvider` (it depends only on the `GitHubClient` /
    `GitHubInstallationRepository` ports) moved from the Cloudflare package into the
    shared `@cat-factory/integrations`, the Node facade wires it whenever a GitHub
    client is available (the App is configured) — mirroring the Worker's
    `config.github.enabled` gate — AND `github` was added to the Node facade's
    task-source allow-list (it had been omitted, so the provider could never register).
    Previously only the Worker offered GitHub issues.
  - **Jira search now works on the Node runtime.** The duplicated per-runtime
    `JiraProvider` was hoisted into the shared `@cat-factory/integrations` (it is a thin
    runtime-neutral `fetch` shell, like `GitHubIssuesProvider`), so both facades now
    compose the SAME class — including `search()`, which the legacy Node copy had
    silently dropped.

- e8005ba: Datadog post-release-health gate + Agent-On-Call.

  After a release ships, a new **`post-release-health`** polling gate watches the team's
  Datadog **monitors/SLOs** over a monitoring window. It reuses the existing gate machinery
  (`ci`/`conflicts`): a clean window advances with nothing spun up; a regression escalates —
  Datadog credentials stay on the backend and never enter containers.

  The gate is **opt-in**: it is NOT in any default pipeline. A user adds it deliberately in
  the pipeline builder, and it only appears in the palette — and is only accepted by the
  backend — once the workspace has an **observability integration connected** (today a
  Datadog connection). `PipelineService` rejects a `create`/`update` that adds an enabled
  `post-release-health` step otherwise.

  - **No blind revert.** On a regression the gate dispatches an **`on-call`** container agent
    that clones the base branch (the merged release; the work branch is deleted on merge),
    locates the merged commit and correlates its diff with the regression evidence (alerting
    monitors/SLOs + recent error logs), returning a JSON assessment (culprit confidence +
    `revert`/`hold`/`monitor` recommendation). It makes no commits and reverts nothing — the
    engine raises a **`release_regression`** notification for a human to decide. The gate only
    engages once the PR actually merged, attributes only post-release alerts (not pre-existing
    ones) to the release, and honours the full configured watch window even when it outlasts a
    single poll budget.
  - **Datadog connection + monitor/SLO mapping** are per-workspace (keys sealed at rest under
    a `cat-factory:datadog` cipher, write-only), managed in a new settings panel and the
    `GET|PUT|DELETE /workspaces/:ws/datadog/connection` + `/release-health-configs/:blockId`
    API. The gate maps a run's repo to its service-frame config (monitor + SLO ids + env tag).
  - **Merge-preset knobs**: `releaseWatchWindowMinutes` (default 30) and `releaseMaxAttempts`
    (default 1) bound the watch window + on-call dispatches.
  - **Incident enrichment (optional, additive):** PagerDuty / incident.io are NOT used to
    re-alert (they already page off the same monitors/SLOs) — instead the on-call
    investigation is posted onto an incident they already opened (annotate, never duplicate),
    behind a new `IncidentEnrichmentProvider` port. Slack + the in-app inbox carry the
    human-facing `release_regression` notification.
  - Runtime-symmetric: D1 (`datadog_connections`, `release_health_configs` + the two preset
    columns) ⇄ Drizzle/Postgres, wired in both the Cloudflare Worker and Node/local facades.
  - New harness route `POST /on-call`; the executor-harness image is bumped to `1.7.1`.

  **Breaking (pre-1.0, acceptable):** `merge_threshold_presets` gains two columns — stale rows
  are re-seeded with the defaults.

- 084bf43: Widen the env-provisioning + runner-pool surface so an external orchestration adapter
  (e.g. an in-house PR-environment platform) can be written on top of our ports and wired
  into a stock facade build, without forking the facades.

  - `EnvironmentProvider` provision requests now carry a typed `provisionContext`
    (branch / PR number+url / repo owner+name, derived from the block's PR ref) and the same
    values are flattened into `{{input.*}}` for the manifest path. The deployer step supplies
    it. A PR-environment provider needs the git ref + repo to target the right environment.
  - New `UrlSafetyPolicy` (kernel) + `resolveUrlSafetyPolicy` (server): the env + runner-pool
    URL/host guard is now policy-driven. The default stays strict (https-only, no
    private/internal hosts); a TRUSTED operator can widen it per facade to reach an internal
    platform on a private/VPN host. The two integrations are scoped **independently** — each
    resolves its own policy from its own config slice, so widening one (`ENVIRONMENTS_*`) does
    not widen the other's (`RUNNERS_*`) SSRF guard. Config: `ENVIRONMENTS_ALLOW_URL_HOSTS` /
    `ENVIRONMENTS_ALLOW_HTTP_URLS` and `RUNNERS_ALLOW_URL_HOSTS` / `RUNNERS_ALLOW_HTTP_URLS`
    (Node env vars + the matching Worker `[vars]`).
  - The Node facade's `buildNodeContainer` gains a documented `environmentProvider` seam (the
    Worker injects via `buildContainer`'s `overrides`); a custom adapter replaces the default
    manifest-driven `HttpEnvironmentProvider` while the env repos + secret cipher still wire
    from config. The local facade inherits the seam through `buildNodeContainer`.

  No backwards-incompatible changes: every addition is optional and defaults to today's
  behaviour.

- 8eed38c: Make the GitHub controllers runtime-neutral and move them into `@cat-factory/server`.
  The workspace-scoped GitHub controller and the public webhook/setup-callback
  controller now delegate their out-of-band work to two new gateways —
  `GitHubBackfillScheduler` (full-installation backfill) and `GitHubWebhookIngest`
  (webhook + incremental repo resync) — and read the install-state HMAC secret from
  config. `StateSigner` moves to the shared package. The Worker supplies
  `WorkflowsBackfillScheduler` (Cloudflare Workflows) and `CfGitHubWebhookIngest`
  (the sync Queue), each falling back to inline handling when its binding is absent.
  Behaviour on the Worker is unchanged.
- db77061: Add an **individual-usage restricted mode** for subscriptions licensed for personal
  use only (`claude`, `glm` and `codex` — see their terms of service). Such vendors are no
  longer poolable on a workspace; instead each user stores their OWN credential and only
  that user's runs may use it.

  - **Per-user, double-encrypted storage.** A personal subscription's token is sealed
    under a key derived from the user's personal **password** (PBKDF2 → AES-GCM, never
    stored) and then encrypted again with the system key, so it cannot be recovered
    without BOTH the system key AND the password. New `personal_subscriptions` table on
    both runtimes (D1 migration `0039` ⇄ Drizzle), `PersonalSubscriptionService`, and
    `GET/POST/DELETE /personal-subscriptions` (user-scoped).
  - **One password per user.** All of a user's individual-usage subscriptions must share a
    single personal password (enforced at store time), since a run unlocks every vendor it
    touches with one password. Passwords are restricted to printable ASCII so they are
    HTTP-header-safe.
  - **Per-run activation, short TTL, transparently extended.** At task start/retry the user
    supplies their password — carried on the ambient `X-Personal-Password` header (never a
    body field), cached client-side (~40h) so it usually rides along transparently — to mint a
    short-lived (~12h), system-encrypted, per-run activation (`subscription_activations`
    table) that the asynchronous container steps lease, so the whole step chain authenticates
    without the user present. The activation is **re-minted from the cached password on each
    interaction** (resolve a decision / approve a step / retry), so an actively-tended run
    never lapses under the short TTL; the user is only re-prompted once the password cache
    expires. Activations are deleted when the run finishes (or its block's run is replaced)
    and swept on TTL expiry.
  - **No recurring runs.** A recurring schedule whose block resolves to an individual-usage
    model — by pin **or** workspace per-kind default — is refused at fire time (it can't be
    unlocked unattended).
  - **Gating.** Starting/retrying a run that resolves to individual-usage model(s)
    requires a signed-in user with the stored subscription(s); a missing password returns
    `428 credential_required` so the client prompts. The gate mirrors dispatch's model
    precedence (block pin → workspace per-kind default) across the pipeline's steps, so a
    block with no pin but an individual-usage workspace default is gated up-front instead
    of failing at dispatch. The container executor leases the initiator's activation and
    fails clearly (retryable) if it has lapsed. Expiry/renewal is surfaced in advance.

  **Breaking (no migration — backwards compatibility is a non-goal here):** `glm` and `codex`
  join `claude` as individual-only, and individual-only vendors are no longer poolable on ANY
  workspace. Any existing **pooled** `claude`/`glm`/`codex` workspace tokens become orphaned
  (no longer leased or listed) — reconnect them as personal subscriptions.

  See `backend/docs/individual-subscription-usage.md` for the full model + safeguards.

- 57d70fa: Issue-tracker writeback: comment on a task's linked tracker issue when its PR
  opens, and comment + close the issue as resolved when the PR merges.

  Two independent toggles configured at the **workspace** level (on the existing
  tracker settings) and overridable **per task** in the inspector
  (`commentOnPrOpen`, `resolveOnMerge`; each task override is `inherit`/`on`/`off`).
  The linked issue(s) come from the existing task projection (`linkedBlockId`), so
  writeback targets whatever GitHub/Jira issue is attached to the task. All writeback
  is best-effort — a tracker outage never fails a run.

  GitHub issues close natively (`state_reason: completed`); Jira issues transition to
  the first status in their standard **Done** category (no manual status mapping). The
  new `IssueWritebackService` mirrors `TicketTrackerService`'s per-facade seams and is
  wired on both the Cloudflare and Node runtimes; the `GitHubClient` port gains a
  `closeIssue` method.

  **Breaking (pre-1.0, no migration):** the `tracker_settings` table gains
  `writeback_comment_on_pr_open` / `writeback_resolve_on_merge` columns and `blocks`
  gains `tracker_comment_on_pr_open` / `tracker_resolve_on_merge` (D1 migration `0005`
  ⇄ a generated Drizzle migration). Both default to off/inherit, so existing data is
  unaffected.

- 918764f: Extend the Langfuse observability with **tool spans**: each container agent's tool
  calls now surface as spans under its run's trace, alongside that run's LLM generations
  (both are children of the one run trace, keyed by the execution id).

  The harness buffers a compact, metadata-only `ToolSpan` (`{tool, startedAt, endedAt,
ok}` — never tool args/results) per completed Pi tool call and returns the batch on its
  existing `GET /jobs/{id}` poll with **drain-on-read** semantics (each poll returns the
  spans since the last poll and clears the buffer). No new network from the container, no
  hot-path work — only in-memory accumulation bounded to one poll interval, so OOM risk is
  nil. `ContainerAgentExecutor.pollJob` forwards each drained batch to the trace sink as
  spans under the run trace (`jobId === executionId`, the same trace id the LLM
  generations use). Best-effort and fully isolated — a sink failure never affects the job
  lifecycle.

  Bumps the `@cat-factory/executor-harness` image tag (1.2.0 → 1.3.0); a deploy is needed
  to roll out the harness change. The self-hosted runner-pool path (arbitrary,
  manifest-driven APIs) gracefully yields no tool spans; the Cloudflare-container and
  local-Docker paths carry them through automatically.

- 918764f: Add optional, opt-in **Langfuse** LLM observability. A new fetch-based
  `@cat-factory/observability-langfuse` package implements a runtime-neutral
  `LlmTraceSink` (new kernel port) against Langfuse's ingestion API — no Node SDK or
  OpenTelemetry, so it runs unchanged on BOTH the Cloudflare Worker (workerd) and Node
  facades.

  Proxied container-agent calls and inline (non-proxied) calls — requirements
  review/rework, document planner, fragment selector, the inline agent — flow through the
  SAME sink path: the orchestration `LlmObservabilityService` fans every recorded proxied
  call out as a generation, and an `InstrumentedModelProvider` wraps every resolved model
  so inline `generateText` calls surface the identical `LlmGenerationEvent`. Calls are
  grouped under one trace per run (`executionId`); inline single-shot calls become their
  own standalone trace.

  Off unless `LANGFUSE_ENABLED=true` and both keys are set; wired symmetrically in both
  runtime containers. Honours the existing `LLM_RECORD_PROMPTS` switch (prompt/response
  bodies are omitted from Langfuse too when disabled). The sink never throws into the LLM
  path — failures are swallowed and logged. The existing local metric store, spend gating
  and board rollups are unchanged; Langfuse is an additive external sink, not a
  replacement.

- fe0b7f8: Live model-activity: push per-call LLM activity over the workspace event stream.

  The "Model activity" panel fetched once when it opened and never updated, so a running
  step's calls only appeared on a manual reopen — and when a durable driver was evicted
  mid-run the board badge (which rides the poll loop) froze too, making a stalled driver
  look identical to a wedged agent. But the proxy records every call the moment it
  returns, independent of the execution driver, so the data was live the whole time;
  only the read side was stale.

  The proxy now emits a compact `llmCall` event per model call, sourced where the metric
  is already recorded:

  - New `LlmCallActivity` contract + `llmCall` `WorkspaceEvent` variant — the per-call
    summary (id, run, agent kind, provider/model, tokens, finish reason, ok/status, the
    latency split) WITHOUT the prompt/response bodies, so the stream payload stays small.
  - `ExecutionEventPublisher` gains an optional `llmCallObserved`; the proxy mints the
    call id (so the live row and the persisted metric share it) and pushes through the
    same realtime publisher execution events use. `DurableObjectEventPublisher` fans it
    to the `WorkspaceEventsHub` on Cloudflare; `FanOutEventPublisher` forwards it; Node's
    no-op publisher leaves it inert until Node gains a real-time transport. The emit is
    best-effort and fires even when the persistence sink is off.
  - SPA: `useWorkspaceStream` folds the event into the observability store, so an open
    panel updates in real time and keeps updating during a driver eviction. Live-appended
    rows carry no bodies; the panel lazy-loads those (by id) from the persisted metrics
    endpoint when a row is expanded.

  Both runtimes' real Hono apps are covered by a proxy-emit integration test asserting
  the identical compact activity event (each over its own app), so the shared controller's
  emit can't silently work on one runtime and not the other. The Cloudflare-specific
  publish leg — `DurableObjectEventPublisher.llmCallObserved` fanning the event to a live
  socket as an `llmCall` `WorkspaceEvent` — has its own dedicated hub spec.

- f73652c: LLM key management overhaul: DB-backed, multi-scope, pooled provider API keys;
  opt-in Cloudflare AI; provider-gated pipelines; account roles.

  - **Direct-provider API keys move from env to the DB** (BREAKING). The
    OpenAI/Anthropic/Qwen/DeepSeek/Moonshot keys that were read from
    `*_API_KEY` env vars are now onboarded via the UI and stored encrypted (the
    shared `WebCryptoSecretCipher`, HKDF info `cat-factory:provider-api-keys`).
    They are pooled and leased with usage-aware rotation, and scoped to an
    **account, workspace, or user** — within a workspace the candidate pool merges
    the workspace's keys, its owning account's keys, and the run initiator's own
    user keys. Operators must re-enter their keys via the app after upgrading.
  - **Cloudflare Workers AI is no longer assumed available.** It becomes a separate
    opt-in provider lib (like `provider-bedrock`), explicitly registered per
    deployment (the Worker `AI` binding; Node REST account/token). The unconditional
    `workers-ai` fallback is removed, so a bare deployment exposes no models until a
    key is added or the Cloudflare lib is enabled.
  - **Model selectability is derived from what is configured**, and starting a
    pipeline is blocked when any step's canonical model has no usable provider
    (no direct key, no subscription, no registered registry).
  - **Account roles** (admin / developer / product, combinable) layered on the
    membership model: only admins may modify org-account settings; a product member
    can be set as a task's responsible person and is notified when requirement review
    raises findings.

- db336b1: LLM observability for container-based agent execution.

  Every container agent talks to models only through the runtime-neutral LLM proxy, so
  that single chokepoint now records one rich metric per call — the full prompt and
  response, token usage, how close the call ran to its output-token limit (truncation),
  and the latency split between transport/proxy overhead and actual model execution —
  plus errors and warnings (non-2xx, in-process failures, spend-gate refusals,
  `finish_reason: length`/`content_filter`).

  - New `LlmCallMetricRepository` kernel port + `LlmObservabilityService`
    (orchestration), composed only when a metric repository is wired (default-off, so
    tests and unconfigured facades are unaffected). Persisted on both runtimes: a new
    D1 table (`llm_call_metrics`, migration 0026) and a Drizzle/Postgres table, kept in
    lock-step by a cross-runtime conformance repository-parity suite.
  - The proxy is instrumented across the buffered, streaming, and in-process (Workers
    AI) paths; recording is scheduled off the response path so it never adds latency.
  - The execution engine rolls the per-run, per-agent-kind aggregates onto each
    pipeline step (`step.metrics`) and ships them over the existing execution event, so
    the board shows tokens, an output-limit headroom bar, a transport-vs-execution split
    and error/warning badges live — on the step cards, the pipeline timeline and the
    step-detail overlay. A new drill-down panel (`GET …/executions/:id/llm-metrics`)
    lists every call with its full prompt + response, and an LLM-friendly JSON export
    (`…/llm-metrics/export`) bundles totals + per-agent insights + every call (with
    derived ratios) for handing a run straight to a model to analyse.
  - The full request/response bodies make the table heavy, so it is pruned aggressively
    by the retention cron — default 3 days (`LLM_CALL_METRICS_RETENTION_DAYS`).

- 8807f5c: Run agents on locally-hosted LLMs (Ollama, LM Studio, llama.cpp, vLLM, or any
  custom OpenAI-compatible server). Each user configures their own runners in
  Settings → "My local runners" (a runner lives on that person's machine), stored
  per-user in the DB with on-the-fly connection validation that probes the runner's
  `/v1/models` and lists the installed models to enable. The enabled models appear
  in the picker as the `direct` flavour and need no API key — the LLM proxy resolves
  the run initiator's endpoint and skips the DB key lease (new optional
  `LlmUpstreamEndpoint.apiKey` signal / keyless local branch), and inline LLM calls
  register the user's runners as keyless resolvers. Resolution is by the run
  initiator, exactly like personal subscriptions.

  New per-user `local_model_endpoints` table mirrored across both runtimes (D1
  migration `0002` ⇄ Drizzle), a user-scoped `GET|PUT|DELETE /local-model-endpoints`

  - `POST /local-model-endpoints/test` API, and a cross-runtime conformance
    assertion for the store (CRUD + bearer-key encryption round-trip + enabled-models
    JSON). Container kinds (coder/tester/merger/…) and the inline reviewer/planner all
    run on the local model. Breaking only in the pre-1.0 sense: a new table is added,
    no migration of existing data is needed.

  Because the user-supplied base URL is forwarded server-side (the test probe + the
  LLM proxy), it is constrained to a loopback/LAN allow-list (`localRunnerUrlError`):
  `localhost`, `*.local`, and RFC1918/ULA private addresses are accepted, while public
  hosts and the link-local cloud-metadata endpoint (`169.254.169.254` / `fe80::`) are
  rejected at the write boundary and the probe (anti-SSRF). Model usability is gated on
  the specific enabled model id (`localModels` capability), not merely the runner being
  configured, so a stale pin to a since-disabled model is caught at the pipeline-start
  guard.

- 0b21ff3: Add a local-mode runtime facade (`@cat-factory/local-server`) so a developer can run
  the whole product on their own machine. It is the Node.js facade
  (`@cat-factory/node-server`: shared Hono app + Drizzle/Postgres + pg-boss) with two
  local differentiators: agent jobs run as per-job local Docker/Podman containers (the
  new `LocalDockerRunnerTransport` — the local analogue of the Worker's per-run
  Cloudflare Container and an org's self-hosted runner pool, driven through the same
  `RunnerTransport` port), and GitHub is reached via a personal access token (`GITHUB_PAT`)
  instead of a GitHub App. `startLocal()` boots the service; `buildLocalContainer()` is
  the composition root. The agent containers clone, push branches and open real PRs on
  github.com with the PAT; pipelines run end to end locally.

  To support this cleanly, `@cat-factory/node-server` gained composition seams used by
  the local facade (all default to the existing Node behaviour): `buildNodeContainer`
  now accepts an injected `resolveTransport`, `mintInstallationToken` and `githubClient`,
  and `start()` accepts an injected `buildContainer` and a `host` bind address (else
  `HOST` from the env, else all interfaces — so a deployment can keep the service off the
  LAN). It also re-exports `createApp`. The local facade runs the shared cross-runtime
  conformance suite (with a fake agent executor) so it can't drift from the Node and
  Cloudflare facades.

  The runtime-neutral fetch-based GitHub client and the CI / merge / mergeability
  providers (`FetchGitHubClient`, `GitHubCiStatusProvider`, `GitHubMergeabilityProvider`,
  `GitHubPullRequestMerger`) move from the Cloudflare runtime into `@cat-factory/server`
  (re-exported from the Worker for existing imports — no behaviour change), so every
  facade can gate on real CI and merge for real. `FetchGitHubClient` now accepts any
  `AppTokenSource` (the App registry or a static PAT). Local mode wires these from a
  PAT-backed client, so a local pipeline gates on real GitHub Actions CI and merges the
  PR for real. The Node facade now also wires these gates when a GitHub App is configured
  — it builds a `FetchGitHubClient` from its own shared App registry — so a stock
  Node-with-App deployment gates on real CI and merges for real too (parity with the
  Worker; previously only local mode did).

  Local-mode robustness: the Docker transport is now constructed lazily, so the service
  boots (to serve the board + inline kinds) even without `LOCAL_HARNESS_IMAGE` — only
  repo-operating kinds then fail, loudly. On boot it reaps per-job containers orphaned by
  a previous crash, and on re-dispatch it removes any lingering container for the same job
  id before starting a fresh one. The `linkRepo` helper clears a stale installation row
  for the workspace before upserting (robust against the `github_installations`
  workspace-unique index), and local mode warns when the auth gate is left open on a
  network-reachable bind.

- a691853: Monorepo support: select a subset of a repo's services and pin each to a subdirectory.

  A linked GitHub repository can now be flagged a **monorepo** (`github_repos.is_monorepo`,
  D1 migration `0044` ⇄ Drizzle), which lets it back **more than one** board service —
  each pinned to its own subdirectory (`services.directory`). The "Add service from repo"
  modal gains a monorepo toggle and a **directory browser** (`GET
/workspaces/:ws/github/repos/:id/tree`, served from GitHub's contents API via
  `GitHubSyncService.listRepoDirectory`) so you can explore the repo and pick the
  directory of the service you want — and add several (a subset of the repo's services).
  `PATCH /workspaces/:ws/github/repos/:id` sets the monorepo flag.

  The chosen subdirectory is **fed to the agents that build the service** when the repo is
  a monorepo: `buildResolveRepoTarget` resolves a frame's service (so multiple frames can
  target one repo) and returns its `serviceDirectory`, which flows through the container
  job body into the harness. The implementation agents — **coder, mocker and ci-fixer**
  (everything routed through `runCodingAgent`) — run with their working directory set to
  that subtree and are told, in their AGENTS.md context, that they're in a monorepo and to
  scope their work (and build/test commands) to it. The cross-cutting agents keep operating
  at the repo root by design: the **conflict-resolver** and **merger** act on the whole
  merge / diff, and the **blueprint** and **requirements** agents write repo-root artifacts.
  Non-monorepo repos keep the historical whole-repo behaviour.

  Known limitation: the in-repo blueprint (`blueprints/`) and requirements (`requirements/`)
  artifacts are still written at the repo root, so two services backed by the same monorepo
  share — and would overwrite — those files. Per-service artifact paths are a follow-up.

- c664fe6: Run container agent steps on the Node service via a self-hosted runner pool, so the
  Node facade no longer silently degrades repo-operating kinds (coder, mocker,
  playwright, blueprints, ci-fixer, conflict-resolver, merger) to useless one-shot LLM
  calls.

  The container-execution machinery is now shared, not Worker-only:

  - `@cat-factory/server` hosts the runtime-neutral `CompositeAgentExecutor`,
    `ContainerAgentExecutor` and `RunnerJobClient`, plus the Web-Crypto
    `WebCryptoSecretCipher` and GitHub-App auth (`GitHubAppAuth` / `GitHubAppRegistry`).
  - `@cat-factory/integrations` hosts the manifest-driven runner-pool transport
    (`HttpRunnerPoolProvider` / `RunnerPoolTransport`).
  - `@cat-factory/server` also hosts the runtime-neutral `buildResolveRepoTarget` (the
    security-sensitive block→service→repo ancestry walk, with its no-"first-repo"-fallback
    policy), so the Worker and Node service single-source it instead of keeping two
    hand-copied resolvers that could drift. Each facade just binds its own repositories.
  - `@cat-factory/worker` keeps thin re-export shims at the old paths (no API change).

  `@cat-factory/node-server` wires a `CompositeAgentExecutor` (inline + container) whose
  container executor dispatches to a workspace's registered runner pool
  (`RunnerPoolTransport`), resolving the run's repo + minting a short-lived GitHub
  installation token exactly as the Worker does. New Postgres tables
  (`runner_pool_connections`, `github_installations`, `github_repos`) mirror the D1
  schema. It activates when `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, `PUBLIC_URL`,
  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are configured; otherwise inline
  kinds still work and container kinds fail loudly rather than faking success.

- 7d5e060: Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
  features that worked on the Worker but `503`'d on the Node + local facades (their
  repositories were never wired) now work identically on all three, each landed with
  a cross-runtime conformance assertion.

  - **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
  - **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
    (the blueprint reads; the `blueprints` pipeline step already ran on Node).
  - **Document sources** — `document_connections`/`documents` + repos; the Confluence /
    Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
    so both facades compose the same providers.
  - **Ephemeral environments** — `environment_connections`/`environments` + repos;
    `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
    `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
  - **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
    `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
    full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
    webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
    `@cat-factory/server`.
  - **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
    `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
    `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
    Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
    yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
    self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
    kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
    serves it just like the local Docker transport — so a real bootstrap run dispatches +
    pushes for real on Node, not just on local.
  - **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
    `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
    `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
    `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
    `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
    tenant fragment catalog feeding every agent run works identically on all three.

  The Worker keeps the same behaviour (it gains the new conformance assertions and the
  shared promoted classes). **Breaking on Node/local:** these features now require their
  new tables — boot-time `migrate()` applies them; there is no data to preserve.

  The Node/local Drizzle migration lineage was re-baselined to a single fresh
  `drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
  folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
  green again. Safe because no deployed database depends on the old lineage.

  Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
  gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
  queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
  and GitHub rate-limit telemetry (Node keeps the no-op repository).

- 75bd29d: Implement the real-time WebSocket transport on the Node + local facades, closing the
  last "Worker-only" runtime gap for live board updates. Previously the SPA's
  `ws://…/workspaces/:ws/events` handshake had no server on Node/local (the realtime
  gateway returned null and `@hono/node-server` doesn't upgrade on its own), so the
  browser logged a perpetual `connection refused` and only got updates by reconnect-time
  snapshot refresh.

  - New `runtimes/node/src/realtime.ts`: `NodeRealtimeHub` (in-memory per-workspace
    subscriber registry), `NodeEventPublisher` (mirrors the Worker's
    `DurableObjectEventPublisher` event shapes), and `attachRealtime` — a `ws` server bound
    to the HTTP `upgrade` event. The SPA speaks raw WebSocket (not socket.io), so the
    client is unchanged across runtimes; `@hono/node-ws` was rejected because its
    `upgradeWebSocket` middleware can't compose with the shared, `Response`-returning
    `EventsController`.
  - `start()` creates the hub, wires it into `buildNodeContainer` (as the engine's
    `executionEventPublisher`, decorated with `FanOutEventPublisher` so a shared service's
    events reach every mounting board, plus an `InAppNotificationChannel` composed
    alongside Slack), and attaches it to the HTTP listener. Local mode inherits all of
    this through `buildLocalContainer`'s pass-through, so a developer running locally now
    gets live execution/bootstrap/notification updates.
  - Ticket mint/verify is extracted into the shared `@cat-factory/server`
    `auth/wsTicket.ts` (`mintWsTicket`/`authorizeWsUpgrade`), used by both the Worker's
    `EventsController` and the Node upgrade handler so both handshakes authorise
    identically. `InAppNotificationChannel` is promoted from the Worker into
    `@cat-factory/server` so both facades deliver in-app notifications through one class.

  Single-process only for now: a multi-replica Node deployment would need a shared bus
  (Postgres `LISTEN/NOTIFY`) in front of the in-memory hub. The Worker's behaviour is
  unchanged (it gains the shared ticket/channel helpers).

- 4a08935: Add **OpenRouter** and **LiteLLM** as model providers. Both are OpenAI-compatible, so
  they reuse the existing inlined `openAiCompatibleResolver` path (no new dependency, no
  dedicated package) and work for both inline engine calls and container coding agents via
  the LLM proxy. Keys are onboarded per workspace/user through the UI key pool like the
  other direct vendors; their base URLs are deployment config — OpenRouter defaults to the
  public gateway (`OPENROUTER_BASE_URL` override optional), while LiteLLM is operator-hosted
  so `LITELLM_BASE_URL` is required to enable it. Ships curated, direct-only catalog entries
  (OpenRouter: Claude Opus, Gemini 3 Pro, GPT-5.5, DeepSeek, Llama 3.3; LiteLLM: a generic
  gateway-default entry) with approximate pricing/context, overridable via
  `SPEND_MODEL_PRICES`.

  Catalog selectability now also gates on a **resolvable base URL**: an OpenAI-compatible
  provider (everything but `openai`/`anthropic`) is only offered once its base URL resolves,
  so a LiteLLM model stays unselectable — and a pipeline using it is blocked at start —
  until `LITELLM_BASE_URL` is set, instead of passing the guard and throwing "No base URL
  configured" mid-run. Wired symmetrically into both facades' capability resolution.

  **Wire change:** `apiKeyProviderSchema` is widened with `'openrouter'` and `'litellm'`.

- 2796a42: Make recording of complete prompts in LLM observability optional, governed by a new
  `LLM_RECORD_PROMPTS` environment variable.

  The LLM observability sink keeps the full prompt sent to the model with each metric.
  That prompt text can contain sensitive content (source, secrets), so some deployments
  must not retain it. `LlmObservabilityService` now takes a `recordPrompts` flag (default
  true, preserving current behaviour); when it is false the numeric telemetry (tokens,
  timing, finish reason, message/tool counts) is still recorded but the prompt body is
  stored empty and the delta-chain read is skipped entirely.

  - New `ObservabilityConfig.recordPrompts` on the shared `AppConfig` contract, threaded
    through `CoreDependencies.recordLlmPrompts` into the service.
  - Both runtime facades read `LLM_RECORD_PROMPTS` (any value other than `false` keeps
    recording on): the Cloudflare Worker via a new `loadObservabilityConfig`, the Node
    service via `loadNodeConfig`. Documented in `deploy/backend/wrangler.toml` and
    `deploy/node/.env.example`.

- 70e8ef0: Real-time fan-out for shared services.

  A shared service can appear on several workspaces' boards, but the engine pushes a live
  change (run progress, bootstrap, notification) to only the workspace it addresses — so the
  other boards saw the update only on reload. `FanOutEventPublisher` (a decorator over the
  per-workspace publisher) resolves the changed block's service and re-publishes the event to
  **every** workspace that mounts it, so all boards update live.

  - `WorkspaceMountRepository.listWorkspaceIdsMountingBlock(workspaceId, blockId)` (D1 + Drizzle)
    resolves the fan-out's target workspaces — the service owning the block and the boards that
    mount it — in a single join.
  - The Cloudflare facade wraps its `DurableObjectEventPublisher` with `FanOutEventPublisher`.
    Best-effort and self-isolating (the persisted row stays the source of truth); a block with
    no service, or a coarse block-less `boardChanged`, falls back to the originating workspace.

- 70e8ef0: Frontend for in-org shared services.

  The board can now mount org services, shows which frames are shared, and lays them out
  per-board.

  - The workspace snapshot carries `mounts` (the services this board mounts, with the
    per-board frame layout) and `serviceCatalog` (the org's services it can mount from, each
    annotated with `mountCount`). `Service` gains a derived `mountCount`.
  - SPA: a `services` Pinia store (mounts + catalog + mount/unmount/updateLayout), hydrated from
    the snapshot; an **"Add service"** menu on the board toolbar that mounts an org service; a
    **"Shared"** badge on a frame mounted on more than one board; and a frame drag now writes
    the **per-board mount layout** (so moving a shared frame doesn't move it on other boards).

- 70e8ef0: Make in-org shared boards fully interactive, and tighten the shared-service model.

  A workspace that MOUNTS a service from another workspace can now edit it like its own: a
  shared service's blocks live in one home workspace, and board mutations resolve them there
  (authorized by the mount) instead of 404ing on the workspace-scoped lookup.

  - `BlockRepository.findById` (D1 + Drizzle) resolves a block by id across the org; `BoardService`
    uses it so `updateBlock`, `moveBlock`, `addTask`, `addModule`, `removeBlock`,
    `toggleDependency` and `reparent` act on the shared copy at its home workspace. A frame move
    writes the requesting board's mount layout (per-workspace), leaving the shared block untouched.
  - Cross-service `reparent` across two services homed in **different** workspaces moves the
    subtree's block rows (and any executions on them) to the destination service's home, re-stamped
    with the destination service — preserving the "a service's blocks live in its home" invariant.
  - **Every** top-level frame now registers as an account-owned service via the shared
    `registerServiceForFrame` helper — including **seeded demo boards** and **repo bootstrap**, which
    previously created unshareable, unbadged frames.
  - Executions and bootstrap runs now stamp `service_id` from their block at write time (D1 +
    Drizzle), so a shared service's **live** runs surface on every board that mounts it — not just
    pre-migration rows. `BootstrapJobRepository.listByService` + `BootstrapService.listJobs` compose
    a mounted service's in-flight bootstrap into the snapshot.
  - Real-time `boardChanged` now carries the affected block, so `FanOutEventPublisher` fans
    structural changes (module materialised, run cancelled, bootstrap finished) out to every
    mounting board live, not just on reload.
  - `services.frame_block_id` is now UNIQUE (D1 + Drizzle), enforcing the 1:1 frame↔service mapping.
  - Removed N+1s on the snapshot hot path (`composeBoard`) and the GitHub sync fan-out
    (`linkedWorkspaces`).

  The Node facade wires the service repos into the engine but, lacking a real-time transport,
  does not yet decorate its publisher with `FanOutEventPublisher` (noted in its container).

- 70e8ef0: Batch the shared-service read paths (remove N+1 queries) + fan-out and mount-UI polish.

  Composing a board from the services it mounts fired one query **per mounted service** on
  several hot paths. They now issue a single chunked `IN (…)` query instead:

  - New batched repository ports `ExecutionRepository.listByServices`,
    `BootstrapJobRepository.listByServices`, `PipelineScheduleRepository.listByServices`
    (D1 + Drizzle), mirroring the existing `BlockRepository.listByServices`. Used by the
    workspace snapshot (executions), `BootstrapService.listJobs`, and
    `RecurringPipelineService.list`.
  - Frame deletion now clears a doomed service's mounts off every board and deletes the
    services in two batched queries (`WorkspaceMountRepository.removeByServices` +
    `ServiceRepository.deleteMany`) instead of a `listByService` + per-mount/per-service loop.
  - The real-time fan-out resolves its target workspaces in a **single join**
    (`WorkspaceMountRepository.listWorkspaceIdsMountingBlock`) rather than a `serviceIdOf`
    followed by a `listByService` on every event; `FanOutEventPublisher` no longer needs a
    block repository.
  - Mounting a service from the toolbar now surfaces failures (e.g. cross-org) as a toast
    instead of silently swallowing the error, and new mounts lay out on a 5-wide grid instead
    of stacking on the diagonal.
  - Every dynamically-built `IN (…)` D1 query now chunks through a single grounded constant
    (`D1_MAX_IN_PARAMS` / `chunkForIn`). Cloudflare D1 rejects a statement with more than 100
    bound parameters, so the previous 500-wide chunks were over the real ceiling, and the
    workspace snapshot's `countByServiceIds` (the org catalog's mount counts) didn't chunk at
    all — it threw `D1_ERROR: too many SQL variables` once an account owned enough services.

- 70e8ef0: In-org shared services: schema + domain foundation.

  Introduce the account-owned **service** as the canonical board unit and the
  **workspace mount** that places it onto a workspace's board, so the same service
  can appear on several workspaces in one org without duplicating its subtree, state
  or sync. This is the first (additive) increment:

  - New wire types `Service` + `WorkspaceMount` (`@cat-factory/contracts`) and the
    `ServiceRepository` / `WorkspaceMountRepository` ports (`@cat-factory/kernel`).
  - New `services` + `workspace_services` tables on both runtimes (D1 migration
    `0030`; Drizzle migration for Postgres), with an idempotent backfill that turns
    every existing top-level frame into an account-owned service mounted into its
    current workspace at its current board position.
  - D1 + Drizzle implementations of the two repositories.
  - A `service_id` column denormalised onto `blocks` + `agent_runs` (D1 migration
    `0031`; Drizzle migration), backfilled via a recursive CTE from each block's
    top-level frame, in preparation for re-keying the board's physical scope.
  - A **mount API**: every newly created service frame is registered as an
    account-owned service and mounted onto its workspace; `GET /workspaces/:ws/services`
    (mounts), `GET /workspaces/:ws/services/catalog` (the org's services),
    `POST|DELETE /workspaces/:ws/services/:serviceId` (mount/unmount — within the same
    org only), `PATCH …/layout` (per-workspace frame layout). Backed by the new
    `ServiceMountService` (orchestration `services` module) wired into both runtimes.

  - **Board composition**: a workspace's board snapshot is now composed from the
    services it mounts — its own blocks plus the full subtree of any service mounted
    from another workspace in the same org, so a shared service renders identically on
    every board (one physical copy ⇒ one shared task list + state). Each externally
    mounted frame is positioned by this workspace's mount (the per-workspace layout
    override), while a locally homed frame keeps its own movable position. Block inserts
    stamp `service_id` (the frame's service for a frame; the enclosing frame's service
    for tasks/modules) so the subtree is `listByService`-discoverable everywhere.

  Sync deduplication, real-time fan-out to all mounting workspaces, and the frontend
  land in follow-up increments.

- b287996: Give every pipeline step its own runner job id so sibling steps in one run can't read
  back each other's results.

  Every container step of a run was dispatched and polled under the bare execution id,
  which is ALSO the per-run container's address. The harness keys its per-kind job
  registries by that id and `GET /jobs/{id}` checks them in a fixed order, so two steps
  that ran close enough together to share the still-warm container collided: a poll for
  one step returned another step's finished result. The visible symptom was an
  `architect` (`/explore`) step returning the `spec-writer`'s (`/spec`) document verbatim
  with no model call of its own — and, latently, `blueprints`/`mocker` reading back the
  `coder`'s result.

  The fix separates the two conflated identifiers into an explicit `RunnerJobRef`:

  - **`runId`** — the run (execution). On backends that share one container across a run
    (the Cloudflare per-run Container, the local Docker container) this addresses that
    container, and `release` reclaims it.
  - **`jobId`** — the job itself, now UNIQUE PER STEP (`<executionId>-<agentKind>`). The
    harness registers and polls each step's job by it, so siblings never alias.

  `RunnerTransport.dispatch`/`poll`/`release` and `RunnerJobClient` now take the ref;
  `AgentJobHandle` carries the `runId` so the poll/stop site can re-address the per-run
  container. The Cloudflare and local transports key the container by `runId` (one
  container per run, reclaimed as a unit) and read the harness job by the per-step
  `jobId`; a self-hosted pool, being per-job, keys on `jobId` (which already kept its
  steps distinct). Single-job flows (repo bootstrap/scan) use the same value for both.
  The engine reclaims a run by its id and passes the in-flight step's job id so a pool can
  cancel exactly it.

  Breaking: `RunnerTransport` implementers now receive a `RunnerJobRef` instead of a bare
  job-id string. The local container label moves from `cat-factory.jobId` to
  `cat-factory.runId`.

- f49fa30: Give container agents (coder, ci-fixer, mocker, blueprints, analysis, …) `web_search` /
  `web_fetch` via the `@juicesharp/rpiv-web-tools` Pi extension installed in the
  executor-harness image — without putting a search-provider key in the sandbox.

  The backend hosts a SearXNG-compatible **web-search proxy** at `${proxyBaseUrl}/web-search`
  (`webSearchProxyController`, mounted under the LLM proxy's public `/v1`). A container
  authenticates with the SAME short-lived, model-locked session token it uses for the LLM
  proxy; the facade verifies it and runs the search server-side through the `webSearch`
  runtime gateway, under the deployment's own provider key. Two upstreams ship: Brave
  (`WEB_SEARCH_BRAVE_API_KEY`, the recommended one-key path, what Claude Code uses) and a
  reverse proxy to a self-hosted SearXNG (`WEB_SEARCH_SEARXNG_URL` [+ `_API_KEY`]). Both
  runtime facades wire it from env, so it works on Cloudflare (where per-run container env
  vars can't be injected) and on the Node self-hosted runner pool alike — no provider
  secret ever enters the container, matching the LLM-proxy posture.

  When the proxy is configured, `ContainerAgentExecutor` sets `webSearch: true` on the
  coding/ci-fixer job body; the harness then points rpiv-web-tools' SearXNG provider at the
  proxy (the token as its bearer) and surfaces a kind-aware usage nudge (via
  `@cat-factory/agents`' `webResearchGuidanceFor`). Self-hosted runner pools may still
  configure a provider key directly in the container env (auto-detected as before); an
  explicit `WEB_SEARCH_PROVIDER` pin now requires that provider's credential to be present
  so the agent is never told about a tool that would error. The two web tools count as
  read-only exploration for the no-edit guard, but a dedicated cap
  (`JOB_MAX_CONSECUTIVE_WEB_CALLS`, default 25) stops a search rabbit-hole.

  Changes the image, so the harness version (its GHCR image tag) bumps.

- b156b4b: Pipeline-builder + default-models UI polish.

  Pipeline builder: saved pipelines no longer render every agent-kind icon inline
  (which overflowed the narrow panel) — each is a collapsed row showing its name and
  step count that expands to the full ordered step list on click. Draft steps now
  truncate their label so the per-step controls (gate / reorder / remove) always stay
  reachable, and a "Configure models" button opens the default-models settings panel
  straight from the builder. The left-nav action buttons are unified on the
  primary-soft style of "Build a pipeline".

  Default-models panel: restyled from a light modal into the dark full-screen window
  used by the agent-output review overlay (readable regardless of the OS colour-mode
  preference), with a filter box that narrows every kind's model picker. A kind left
  on its deployment default now names the model that default actually resolves to
  ("Model · Provider (default)") instead of the opaque "Deployment default".

  To support that, the workspace snapshot now carries `deploymentModelDefaults` — the
  deployment's env-routing defaults as `provider:model` refs (`default` plus the
  per-kind `byKind` overrides) — derived in the shared workspace controller from
  `config.agents.routing`, so it is identical across the Worker and Node facades. A
  cross-runtime conformance assertion guards that both surface it.

- 7cf2a2d: Improve the pipeline builder experience:

  - **Grouped, collapsible agent palette** — archetypes are now organized into
    meaningful categories (Review & triage, Design & research, Implementation,
    Testing, Documentation, Gates & observability) that collapse/expand, with the
    collapsed state remembered across builder opens.
  - **Pipeline labels + archive/unarchive** — pipelines (built-in and custom) carry
    free-form labels and an archived flag for organizing the library: filter by
    label, hide archived behind a toggle, and archive without deleting. Exposed via
    a new `PATCH /workspaces/:ws/pipelines/:id/organize` endpoint (the only mutation
    a read-only built-in accepts). New `pipelines.labels` / `pipelines.archived`
    columns mirror across D1 and Drizzle/Postgres.
  - **Dependent companions are now gated toggles on their producer** — the three
    companions (reviewer→coder, architect-companion→architect, spec-companion→
    spec-writer) leave the free palette and are attached to their producer step in
    the builder. Each can be optionally **gated on the task estimate** (run only when
    complexity/risk/impact ≥ a threshold, OR across axes) via a new per-step
    `gating` array; a gated step is transparently skipped at runtime when the
    estimate falls below the bar. A pipeline with any enabled gating **requires a
    `task-estimator` earlier in the chain** or it refuses to save/start. Gating is
    additionally restricted to **companion steps** (skipping a producer would starve
    its downstream steps) and **requires at least one axis threshold** (an enabled gate
    with none would always skip); both are enforced by the shared `validatePipelineShape`
    at save, clone, and run start. A companion must now run **immediately after** an
    enabled producer it can review — `validatePipelineShape` enforces strict adjacency
    (over the enabled subset) on every facade, matching the builder, which surfaces
    companions as toggles attached to their producer. A pipeline that slips another step
    between a producer and its companion is rejected at save / clone / run start.

  **Breaking (pre-1.0, no migration):** the `Pipeline` wire shape gains optional
  `gating`, `labels`, and `archived` fields, and `PipelineStep` gains `gating` /
  `skipped`. The built-in pipelines are unchanged in behaviour.

- 2d66d34: Pipeline builder: clone pipelines, edit custom ones, and disable steps without
  removing them.

  - **Clone any pipeline** (built-in or custom) into a new, editable copy:
    `POST /workspaces/:ws/pipelines/:id/clone` (`PipelineService.clone`). The copy is
    never `builtin`, so this is how a read-only default template is "made editable".
    The builder shows a Clone action on every saved pipeline.
  - **Edit a custom pipeline in place**: `PATCH /workspaces/:ws/pipelines/:id`
    (`PipelineService.update`, new `PipelineRepository.update` on both stores). The
    builder loads a custom pipeline into the draft and saves changes back to the same id
    (preserving its catalog position). Built-in catalog pipelines are **read-only** —
    the API rejects both editing and deleting them (422) and the UI offers Clone
    instead (no edit/delete affordance on a built-in); pipelines now carry a `builtin`
    flag (true for the `seedPipelines()` catalog) to drive this.
  - **Disable a step without removing it**: a new per-step `enabled[]` array (parallel
    to `agentKinds`, like `gates`/`thresholds`). A step flagged `enabled[i] === false`
    is kept in the saved pipeline (and can be toggled back on) but skipped at run start —
    `ExecutionService` builds the run only from the enabled steps, reading gates/
    thresholds by each kind's original index so they stay aligned. A pipeline must keep
    at least one step enabled, and an enabled companion must still have an enabled
    producer to grade (disabling a producer while leaving its companion on is rejected).
    The builder adds an enable/disable toggle and dims disabled steps.

  Persistence: new `enabled` + `builtin` columns on the `pipelines` table, mirrored on
  both runtimes — folded into the squashed baselines (D1 `0001_init.sql` ⇄ the Drizzle
  schema + a regenerated migration) rather than a standalone migration. Cross-runtime
  conformance asserts a disabled step is skipped at run on every facade.

- 1a0686f: Close a runtime-parity gap: the privileged GitHub App tier (ADR 0005 — repo
  provisioning / create-repo) now works on the Node and local facades, not just the
  Cloudflare Worker. Previously `loadNodeConfig` never parsed `github.privilegedApp`
  and the Node container never built the privileged registry entry or wired
  `repoProvisioningClient`, so a Node deployment with a privileged App configured
  silently fell back to the manual repo-creation flow.

  `FetchGitHubProvisioningClient` moves into the runtime-neutral `@cat-factory/server`
  package (next to `FetchGitHubClient`, which already lived there); the Worker keeps a
  thin re-export at its old path. The Node config loader now reads
  `GITHUB_PRIVILEGED_APP_ID` + `GITHUB_PRIVILEGED_APP_PRIVATE_KEY`, and the Node
  container builds the privileged App auth + the provisioning client under the same
  condition the Worker does.

  **Breaking:** a privileged App is wired on Node only when BOTH
  `GITHUB_PRIVILEGED_APP_ID` and `GITHUB_PRIVILEGED_APP_PRIVATE_KEY` are set; a half-set
  env leaves the tier unconfigured (parity with the Worker).

- 3a12f15: Add prompt caching for container-agent model calls, plus the observability to prove
  it works, and unify how both AI-call paths treat a provider's cache.

  - **Shared cache policy** (`@cat-factory/agents`): `providerCachePolicy` is the single
    source of truth for how each provider caches (`auto-prefix` for OpenAI/DeepSeek/Qwen,
    `explicit-anthropic`, or `none`). Both the in-container proxy path and the inline
    AI-SDK path consult it instead of hard-coding provider ids.
  - **Proxy** (`@cat-factory/server`): routes a run's calls to the same cached prefix via
    `prompt_cache_key` (keyed on the execution id) on providers that support it — the big
    win, since a container agent re-sends its whole growing prefix every turn. It also
    fixes the misleading `requestMaxTokens` metric to record the EFFECTIVE output ceiling
    (it previously logged the client's value before the Workers-AI floor override, so it
    read as `null`).
  - **Measure the hit rate**: `LlmCallMetric` gains `cachedPromptTokens` (read across the
    `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` field names), so the
    dashboard shows cached vs total prompt tokens per call. D1 migration `0028` + a Drizzle
    migration add the column.

  Note: the inline path's calls are single-shot (no growing prefix), so caching there is
  marginal; full inline-call observability (recording inline LLM calls through the same
  sink) is a follow-up.

- 8eed38c: Introduce the runtime "gateway" seam (`container.gateways`) and use it to make the
  real-time event-stream controller runtime-neutral. `EventsController` moves into
  `@cat-factory/server` and delegates the WebSocket upgrade to a `RealtimeGateway`
  the facade supplies — on the Worker, `DoRealtimeGateway` forwards to the
  per-workspace `WorkspaceEventsHub` Durable Object. This lets a non-Worker facade
  provide its own real-time transport (e.g. a WebSocket hub) without touching the
  controller. Behaviour on the Worker is unchanged.
- 37baa7f: Scheduled recurring pipelines on services.

  A service (a `frame` block) can now carry **recurring pipelines** that re-run a
  pipeline on a cadence — primarily **Dependency updates** and **Tech debt**. A
  schedule runs every `intervalHours`, optionally constrained to an allowed window
  (weekdays + an hour-of-day range, in a chosen IANA timezone), and owns one reused
  on-board task block inside the service that each fire runs the pipeline against
  (skipping any fire while a run is still in flight). Run history is kept ~1 week and
  surfaced in the inspector.

  - **Tech-debt pipeline** adds two agent kinds: a read-only `analysis` container
    agent that audits the repo, then a special non-LLM `tracker` step that files a
    **GitHub issue or Jira ticket** from the analysis before implementation. The
    tracker is a per-workspace selection (`GET|PUT /workspaces/:ws/tracker-settings`);
    `GitHubClient` gains `createIssue`. The runtime-neutral `TicketTrackerService`
    resolves each **tenant's own** connected integration (it is injected with a
    `fileGitHubIssue` filer + a `resolveJiraConnection` resolver, never shared/env
    credentials): on Cloudflare it files GitHub issues through the workspace's GitHub
    App installation against the service's repo, and Jira tickets (markdown→ADF) using
    the workspace's encrypted `task_connections`. Two new seed pipelines:
    `pl_dep_update`, `pl_tech_debt`.
  - **Per-tenant tracker on the Node facade**: both trackers now work on Node, each
    resolving the **workspace's own** integration. Jira: the task-source integration is
    wired on Node (always on; requires the shared `ENCRYPTION_KEY`) — a Drizzle
    `task_connections`/`tasks` store + the runtime-neutral Jira provider — so each tenant
    connects its own Jira through the existing UI (credentials encrypted at rest). GitHub:
    the filer mints a short-lived token from that workspace's own GitHub App installation
    (reusing the per-tenant App infra) and resolves the service's repo from the
    `github_repos` projection — no shared/env credentials.
  - **Persistence + scheduling are symmetric across runtimes**: D1 migration
    `0029_recurring_pipelines.sql` ⇄ Drizzle schema + generated migration; the
    Cloudflare `scheduled` cron fires due schedules (and prunes run history) ⇄ a Node
    `setInterval` sweeper does the same. New ports `PipelineScheduleRepository` /
    `TrackerSettingsRepository` with D1 + Drizzle implementations; the cross-runtime
    conformance suite covers schedule CRUD, `runDue`, and the tracker setting.
  - **UI**: an "Add recurring pipeline" button on the service frame (mirroring "Add
    task") opens a per-frame modal (pipeline + cadence editor; the tracker choice is
    surfaced inline for the tech-debt pipeline). The schedule's block shows a recurring
    badge on the board; selecting it reveals the cadence, run-now/pause, and run
    history in the inspector.

- 553a67d: Remove the standalone "scan repository" command — repository decomposition is now
  only the `blueprints` pipeline agent.

  The manual scan was a separate, UI-exposed operation backed by a synchronous
  Cloudflare-Container-only `RepoScanner` (which had no live harness route) plus a
  `repo_blueprints` persistence store. It duplicated what the `blueprints` agent kind
  already does — decompose a repo into the canonical service → modules tree and
  reconcile it onto the board — except the agent runs through the shared
  `RunnerTransport`, so it already works identically on Cloudflare Containers and on a
  self-hosted runner pool. Keeping the standalone command was the last
  Cloudflare-vs-pool parity gap (and dead code on Cloudflare). Removing it closes the
  gap by deletion.

  Removed:

  - **Ports:** `RepoScanner` (+ `ScanRepoRequest` / `ScannedBlueprint`) and
    `RepoBlueprintRepository` (+ `RepoBlueprintRecord`).
  - **Contracts:** `scanRepoSchema` / `ScanRepoInput`, `scanRepoResultSchema` /
    `ScanRepoResult`, and `repoBlueprintSchema` / `RepoBlueprint`. The blueprint **tree**
    schemas (`BlueprintService` / `BlueprintModule` / `blueprintSource`), the in-repo
    `blueprints/` artifact constants, `parseBlueprintService`, and `BoardScanSpawnResult`
    stay — the `blueprints` pipeline uses them.
  - **HTTP:** the entire `BoardScanController` — `POST /board-scan/scans` and the
    `GET|DELETE /board-scan/blueprints[/:id]` read endpoints.
  - **Service:** `BoardScanService` is now purely the engine's `BlueprintReconciler`
    (`reconcileBlueprint` + its spawn fallback); `scan` / `canScan` / the blueprint
    CRUD / the persisted-blueprint deps are gone. It is wired unconditionally (it needs
    only the board service + block repository).
  - **Persistence:** the `repo_blueprints` table (D1 `0001_init` + Drizzle schema, with
    a generated Postgres drop migration), `D1RepoBlueprintRepository`,
    `DrizzleRepoBlueprintRepository`, and `ContainerRepoScanner`.

  No data migration is provided (pre-1.0; backwards compatibility is a non-goal): an
  existing `repo_blueprints` table is simply orphaned/dropped. The executor harness is
  unchanged — its self-contained blueprint coercion stays — so the runner image is not
  affected.

- 4026793: Requirements review: react to findings + a rework agent that feeds downstream steps.

  The requirements-review flow is now wired into the UI and reworks the requirements
  instead of overwriting the block description:

  - **New review window** (`RequirementsReviewWindow.vue`) modelled on the polished
    prose review window: a human reacts to the reviewer's structured findings —
    answering the relevant ones, dismissing the irrelevant — then runs the
    **requirements-rework** agent. Triggered from the inspector's "Review
    requirements" button (open-finding count badge). The old dormant
    `RequirementReviewModal` is removed.
  - **Rework, not overwrite.** `incorporate()` no longer rewrites
    `block.description`. It folds the answers into ONE standard-format requirements
    document (new versioned `REWORK_SYSTEM_PROMPT`: SHALL statements + MoSCoW +
    Given/When/Then acceptance + domain rules) stored on the review, and returns
    `{ review }`. It runs even with **zero findings**, so every task can carry a
    clean, writer-ready spec.
  - **Downstream consumption.** When a block has an incorporated review,
    `ExecutionService` feeds that reworked document to **every** agent step in place
    of the original description and drops the (already-folded-in) linked docs/tasks;
    the requirements-writer aggregates the reworked text per task instead of the raw
    description. The rework call rejects a length-truncated document instead of
    persisting a silently-incomplete spec.
  - **Both runtimes, enforced.** The requirements feature is wired on the Node facade
    too — a `requirement_reviews` Postgres table (Drizzle schema + migration) and
    `DrizzleRequirementReviewRepository`, plus the review/model deps in the Node
    container — so the review/rework API and the agent-context substitution behave
    identically on Cloudflare and Node. The cross-runtime conformance suite asserts the
    substitution against both stores so the parity can't silently drift.
  - **Frozen description.** Once a task's requirements are reworked, the inspector
    freezes its raw description (read-only, tucked behind an expander) and puts the
    standardized requirements in focus — the description is no longer what agents read.

- 36018cb: Restart a pipeline run from a chosen step.

  Both the run's step-detail overlay (`AgentStepDetail`) and each step on the pipeline
  timeline (`PipelineProgress`, a hover-revealed side button) now offer **"Restart from
  here"**: re-run the pipeline from that step onward — even on a finished run — resetting
  the chosen step plus every later step's iteration counters (companion attempts,
  gate/test attempts, eviction recoveries) and re-driving a fresh run. The steps
  BEFORE the chosen one are preserved verbatim, so their outputs (and resolved
  decisions) still reach the restarted step as its `priorOutputs` handoff context.

  Unlike retry (which resumes at the first FAILURE), restart rewinds to an arbitrary
  human-picked step, so it can re-run steps that already completed. A block's
  incorporated requirements are deliberately NOT touched — they live on the
  requirement-review record, not the run — so a restarted `spec-writer`/`coder`
  still receives the incorporated requirements document (or the base description when
  none was generated). Restarting AT the `requirements-review` gate itself re-runs the
  reviewer, which mints a fresh iteration-1 review (its `review()` replaces the prior
  one) — exactly the "reset the iterations counter from this step" semantics.

  Backed by `POST /workspaces/:ws/executions/:executionId/restart` (`{ fromStepIndex }`,
  `restartFromStepSchema`) → `ExecutionService.restartFromStep`, which tears down any
  still-live driver/container for the run it replaces (so restarting a RUNNING run
  never orphans a container or a parked Workflows/pg-boss driver), then mints a new run
  id and re-drives like a retry. Like start/retry, an individual-usage (Claude/GLM/
  Codex) block needs the initiator's personal password (prompted, then retried, on a
  428). Runtime-neutral (shared `@cat-factory/server` + orchestration), so both facades
  get it; a cross-runtime conformance assertion pins the restart + the requirements
  handoff on every runtime.

- d65c979: Unify the approval gate into the conclusions reader, with GitHub-style review.

  The dedicated approval modal is gone. A pending gate now opens the same polished
  step-detail reader (ToC side nav, rendered markdown), in a new **approval mode**:
  the reviewer can comment on individual blocks of the agent's output (click a block —
  the rendered markdown carries `data-src-start/end` source ranges so the comment
  quotes that block's verbatim raw markdown), leave overall freeform feedback, then
  **Approve** (advance), **Request changes** or **Reject**.

  - **Request changes** re-runs the step with both the freeform feedback and the
    per-block comments folded into the agent's prompt (`AgentRunContext.revision`
    gains `comments`; `requestStepChangesSchema` now takes `feedback?` + `comments?`,
    requiring at least one).
  - **Reject** stops the run entirely — a terminal `rejected` failure
    (`agentFailureKindSchema`), so the board's shared failure banner + retry surfaces
    it (block → `blocked`). New `POST /executions/:id/steps/:approvalId/reject`
    (`ExecutionService.rejectStep`).
  - `stepApprovalSchema` gains the `rejected` status and a persisted `comments` array
    (`stepReviewCommentSchema`). No migration: approvals live in the execution
    `detail` JSON.

  - **Approve with corrections** opens an inline editor over the conclusions; the
    human's edits become the approved proposal carried forward (the existing
    `approveStep` proposal override — no backend change). Manual edits are a distinct
    mode and can't be combined with per-block comments / request-changes — they only
    happen _together with_ approving.

  The review surface is responsive — a right-side rail on wide screens, a bottom
  sheet below `lg` — so a pending gate is always actionable. Reject uses a two-step
  inline confirm (no native dialog). `requestStepChanges`/`rejectStep` reject a stale
  gate id whose step is already being re-run (`changes_requested`) so a double-submit
  can't dispatch duplicate work.

  Cross-runtime conformance gains assertions for reject and comment-driven re-runs.

- 7157fd7: Rework run timing, add task types, and add a per-service running-task limit.

  **Run timing.** A run parked waiting for a human is no longer auto-failed after a
  fixed timeout — it waits indefinitely. The old `decision_timeout` machinery is gone
  (the Cloudflare driver re-arms its `waitForEvent` instead of failing; the Node driver
  drops the decision-timeout queue/worker; the `decision_timeout` failure kind is
  removed). Instead, notifications carry a `severity` and a periodic sweep escalates any
  open notification from `normal` (yellow) to `urgent` (red, "Overdue") once it has
  waited past the workspace's `waitingEscalationMinutes` threshold. Every human-input
  park now also guarantees an open notification, so a waiting run is never silently
  stuck. **Breaking:** the `decision_timeout` agent-failure kind is removed.

  **Task types.** Tasks gain a `taskType` (`feature` / `bug` / `document` / `spike` /
  `recurring`) chosen at creation, plus small per-type fields (e.g. a bug's severity /
  repro, a spike's time-box). `recurring` is created through the existing recurring-
  pipeline schedule flow, which now also accepts a free-text prompt for its reused task.

  **Per-service running-task limit.** A new per-workspace settings object
  (`waitingEscalationMinutes` + a task-limit policy) caps how many tasks may run
  concurrently under one service — off, a single shared bucket, or one bucket per task
  type. Starting a task over the limit is refused with a human-readable 409. Managed via
  `GET|PUT /workspaces/:ws/settings` and a new Workspace settings panel. Persisted in a
  new `workspace_settings` table on both runtimes (D1 ⇄ Drizzle), with cross-runtime
  conformance assertions for the task type round-trip and the limit enforcement.

- 8eed95b: Service-scoped best-practice prompt fragments, delivered by agent traits.

  A service (frame block) now owns an explicit selection of best-practice / guideline
  fragments — its programming standards — chosen from the **universal fragment pool**.
  That pool is the built-in catalog plus any fragments a deployment registers at startup
  via the new `registerPromptFragment` seam in `@cat-factory/prompt-fragments` (mirroring
  `registerAgentKind` / the model-provider registry); `GET /prompt-fragments` serves the
  merged pool. A workspace can also configure a **default set new services inherit**
  (`GET|PUT /workspaces/:ws/service-fragment-defaults`), seeded onto a frame's
  `serviceFragmentIds` when it is created (board drop, repo import, or bootstrap).

  Agents gain first-class **capability traits** (`@cat-factory/agents`): a registry of
  standard + custom traits with `traitsFor` / `hasTrait`, assignable to built-in kinds and
  to custom kinds via `AgentKindDefinition.traits`. Two standard traits ship:

  - **`code-aware`** (coder, ci-fixer, fixer, reviewer, architect): the running service's
    selected fragments are folded into the agent's system prompt, unioned with the block's
    own manual pins. Other kinds keep only their block pins.
  - **`spec-aware`** (every code-touching kind): the agent's system prompt gains guidance to
    read the in-repo `spec/` artifact (overview.md → rules.md → features/\*.feature →
    spec.json) and treat it as the source of truth for required behaviour.

  This **replaces the automatic per-run relevance selector**: fragment delivery is now
  explicit (the service's selection) and trait-gated (code-aware) rather than guessed per
  run. Per-block manual pins (`Block.fragmentIds`) still apply to that block's own agents.
  The tenant fragment **library** (account/workspace CRUD + repo sources) remains as a
  management surface but no longer feeds the run path.

  Persistence is mirrored on both runtimes: a `service_fragment_ids` column on `blocks`
  and a `workspace_fragment_defaults` table (Cloudflare D1 migration `0040` +
  `D1ServiceFragmentDefaultsRepository`; Node Drizzle schema/migration +
  `DrizzleServiceFragmentDefaultsRepository`), with the cross-runtime conformance suite
  asserting the workspace-default round-trip, new-service inheritance, and the
  code-aware-only folding on both facades. The UI adds a per-service "Service best
  practices" picker in the inspector and a "Default service best practices" workspace
  settings panel.

  BREAKING (Node facade dev/test only): the Drizzle migration lineage under
  `runtimes/node/drizzle/` was squashed into a single fresh baseline migration — the prior
  incremental migrations had a forked, non-commutative history (left by merging two
  branches) that broke `drizzle-kit generate`/`check`. There are no production Postgres
  deployments, so existing dev/test databases should be dropped and re-created from the
  new baseline rather than migrated. CI now runs `db:check` to keep the lineage honest.

- 8eed38c: Move the "Login with GitHub" OAuth flow into `@cat-factory/server`. `AuthController`
  and its fetch-based `GitHubOAuth` client are runtime-neutral, so they now live in
  the shared package and are mounted via `registerCoreControllers`. The Worker keeps a
  thin re-export shim for backward-compatible imports. Behaviour is unchanged.
- 8eed38c: Harden the Node facade and de-duplicate the auth gate (review follow-ups):

  - Extract the default-deny session gate + per-workspace authorization into
    `mountAuthGate(app)` in `@cat-factory/server`, so the security-critical middleware
    has ONE implementation instead of being copy-pasted into each runtime facade (the
    Worker and the Node service now both call it). Behaviour is unchanged.
  - Node durable execution now actually recovers from crashes: the pg-boss advance job
    carries an `expireInSeconds` sized above a full poll budget plus `retryLimit`, and a
    stale-run sweeper re-enqueues runs left `running` in storage (the analogue of the
    Worker's cron `sweepStuckRuns`). Re-enqueues use the run's `singletonKey`, so a run
    still being driven is never double-driven.
  - `start()` shuts down cleanly on SIGTERM/SIGINT: it closes the HTTP server, stops the
    sweeper + pg-boss, releases the pool, then exits (previously the process could hang
    until SIGKILL).
  - `TokenUsageRepository.totalsSince` sums into `bigint` instead of `int4`, fixing an
    overflow past ~2.1B tokens and matching the 64-bit totals the D1 store returns.
  - `migrate()` runs its `CREATE … IF NOT EXISTS` bootstrap under a transaction-scoped
    advisory lock, so concurrent replica boots can't race on DDL.

- 8eed38c: Move the runtime-neutral HTTP controllers into `@cat-factory/server`. The 18
  controllers that only use the DI container + request helpers (board, execution,
  pipelines, workspaces, accounts, documents, tasks, environments, runners,
  bootstrap, agent-runs, board-scan, requirements, notifications, merge presets,
  models, prompt-fragments, fragment-library) now live in the shared package and are
  mounted by a facade via `registerCoreControllers(app)`. The shared request context
  (`ServerContainer`, `AppEnv`) and the auth middleware (`requireAuth`,
  `verifySession`, `bearerToken`) move there too.

  The Cloudflare Worker keeps only its runtime-coupled controllers — the LLM proxy
  (Workers AI binding), the WebSocket event stream (Durable Object), the GitHub
  webhook (Queue) and connect (Workflow), and the OAuth login flow — and mounts the
  shared controllers. `createApp`/`buildContainer` keep their signatures; all 326
  worker integration tests pass unchanged.

- 8eed38c: Make the container LLM proxy runtime-neutral and move it into `@cat-factory/server`,
  completing the migration of every HTTP controller into the shared package. The
  controller keeps session verification, the spend gate, request hardening, the
  OpenAI-compatible HTTP forward and streaming metering; the runtime-specific bits —
  resolving an OpenAI-compatible upstream and the in-process Workers AI binding path —
  move behind a new `LlmUpstream` gateway. The Worker supplies `WorkersAiLlmUpstream`
  (env-keyed upstreams + the `AI` binding, with the OpenAI⇄AI-SDK translation), and
  `ContainerSessionService` moves to the shared package. The Worker `app.ts` now mounts
  only the shared controllers; behaviour is unchanged.
- 8eed38c: Move the application configuration type contract (`AppConfig` and every
  sub-config interface) into `@cat-factory/server`. The config SHAPE is now shared
  by every facade, while each runtime keeps its own loader that produces it (the
  Worker's env-driven `loadConfig` is unchanged). This lets the shared HTTP layer
  type `container.config` without depending on any runtime. Behaviour is unchanged.
- 8eed38c: Move the runtime-neutral crypto/auth primitives into `@cat-factory/server`: the
  base64url/PEM encoding helpers and the Web Crypto `HmacSigner` (with the token
  audiences and session payload types) that mint and verify the session, OAuth
  state, container-proxy and WebSocket-ticket tokens. These are pure Web Crypto, so
  both the Cloudflare Worker and the upcoming Node service share one implementation.
  The Worker re-exports them from their previous paths; behaviour is unchanged.
- 8eed38c: Introduce `@cat-factory/server`, the runtime-neutral HTTP layer shared by every
  deployment facade. This first slice moves the cross-cutting HTTP primitives out of
  the Cloudflare Worker — structured logging, the path-param helper, the valibot
  request-body validation envelope, the domain→HTTP error mapping, and the CORS
  origin policy — so they can be reused by a non-Worker (Node) facade. The Worker
  re-exports them from their previous paths, so behaviour is unchanged.
- de5a9d7: Add configurable Slack notifications as an additional delivery transport for the
  existing notification mechanism (merge_review / pipeline_complete / ci_failed) —
  not a parallel system. A new `SlackNotificationChannel` implements the same
  `NotificationChannel` port the in-app channel does and is composed alongside it via
  `CompositeNotificationChannel`, so the engine call sites that raise notifications
  are untouched.

  Two scopes, mirroring the GitHub-App precedent:

  - The Slack **connection** (the installed team + its bot token) is bound
    **per-account**. The bot token is multi-tenant data, so it is encrypted at rest
    with `WebCryptoSecretCipher` (HKDF tag `cat-factory:slack`) and never returned on
    the wire — only safe metadata (team name/icon, bot user, scopes) is exposed.
    Onboarding is UI-based: a full OAuth "Add to Slack" flow when the app credentials
    are configured (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_REDIRECT_URL`),
    with manual bot-token paste always available as a fallback.
  - Notification **routing** (which types post, to which channel) is configured
    **per-workspace**.
  - Optional **@-mentions** are **role- and audience-aware**, not a workspace
    broadcast. The per-account member map tags each member `product` or `engineering`,
    and each notification type mentions a specific audience: requirement-review
    findings ping **product** people **plus the task's creator**, while the engineering
    notifications (merge_review / pipeline_complete / ci_failed) ping **only the task's
    creator**. This adds a `requirement_review` notification type (raised by the
    requirements reviewer when it produces findings) and records a `createdBy` on
    blocks (a new nullable column on both runtimes), captured from the authenticated
    user at task creation.

  New surface: the `slack` contracts, the kernel Slack repository ports, the
  `@cat-factory/integrations` Slack module (`SlackNotificationChannel`,
  `SlackConnectionService`, `SlackSettingsService`, `SlackMemberMappingService`,
  `SlackApiClient`), the shared `SlackController` (+ public OAuth callback) and
  `SlackConfig`, and the orchestration `SlackModule`. Persisted on **both** runtimes:
  the Cloudflare D1 tables (migration `0037_slack.sql`) and the Node Postgres tables
  (Drizzle schema + generated migration), with both facades wiring the channel +
  management module. The cross-runtime conformance suite asserts the routing and
  member-map persistence parity on both stores.

  This change also closes a pre-existing parity gap: the Node/Drizzle facade now has
  a `notifications` table + `DrizzleNotificationRepository` and wires
  `notificationRepository`, so the notification subsystem — and any channel composed
  onto it — fires on the Node runtime exactly as on the Worker.

  Opt-in via `SLACK_ENABLED=true` (requires `ENCRYPTION_KEY`); off by default, so
  unconfigured deployments are unaffected.

- f647733: Run the spec-writer before the architect, and give every agent in a pipeline one
  shared work branch created up front.

  - **Pipeline order**: in `pl_full` and `pl_fullstack` the `spec-writer` now runs
    _before_ the `architect` (in `pl_fullstack`, the `spec-writer`/`spec-companion`
    pair moves ahead of `architect`/`architect-companion`). The architect is
    spec-aware, so it now designs against the just-written in-repo `spec/` instead of
    writing the spec only after the design is settled. Human gates are unchanged
    (requirements review, spec, architecture).

  - **Shared work branch**: the per-task work branch (`cat-factory/<blockId>`) is now
    ensured before the container agents run, via a new optional `ensureWorkBranch`
    dependency on `ContainerAgentExecutor` (wired in both the Cloudflare and Node facades
    through `ensureWorkBranchViaRest`). Every agent — including the read-only design agents
    (architect, analysis) — operates on that one branch, so the architect reads what the
    spec-writer committed. The helper probes first (an existing branch is reported ready in
    a single call), and only _writers_ create the branch from base when absent — read-only
    agents probe only, so a code-less pipeline never orphans an empty ref. It is idempotent
    (a 422 race is success) and best-effort, but now logs a warning on every failure path so
    a fallback to the base branch is observable rather than silent; ref names with slashes
    are encoded per path segment. When GitHub is not wired (tests), read-only agents fall
    back to the base branch as before.

- a54ada2: Spec-writer now applies ONE task's requirements as an increment, not a service-wide aggregate.

  The spec-writer used to receive `serviceTasks` — every task under the block's service
  frame, merged or not — and fold them all into one document. So a run for a single task
  ("add CRUD for office tables") produced a spec covering five unrelated sibling resources,
  and the spec-reviewer correctly read it as scope contamination. That violates the
  branched-work model: a task's baseline is what's already merged, plus its own increment;
  an unmerged sibling task does not exist for it.

  The spec-writer now reads the spec already committed on its work branch (the baseline)
  and applies ONLY the current task's clarified/reworked requirements as an increment —
  adding what the task introduces and adjusting existing requirements only where the task
  changes their behaviour. It translates the given requirements and does not invent or fill
  gaps (that is the requirements step's job). The in-repo `spec.json` stays the complete
  service spec; only the writer's editing scope narrows.

  - Engine: removed `gatherServiceTasks` and the `serviceTasks` field from
    `AgentRunContext`. The dispatch feeds the single task (the block, whose description is
    already the reworked requirements).
  - Reviewer: the `spec-companion` now judges fidelity to the requirements it was given and
    no longer penalises the writer for requirements it was never handed.
  - Harness (`SpecJob.tasks` → `SpecJob.task`): the prompt is reframed as "baseline plus
    this task's increment". Image retagged 1.6.0 → 1.7.0 (deploy/backend `image:publish` +
    wrangler.toml) so the new digest rolls out.

  Breaking: the `/spec` harness job shape changes (`tasks: []` → `task: {}`) and
  `AgentRunContext.serviceTasks` is gone. No migration — stale in-flight jobs simply break.

- 2dd7e56: Step observability + a discoverable iteration-cap decision.

  - Every pipeline step now carries the `runId` of the run it belongs to, surfaced on
    the step-detail panel (copyable) so a lone step in a log line or view names its run.
    It is a read-time projection (always equals the enclosing run's id), stamped on read
    and on emit; not persisted independently.
  - A step's duration now stops counting once it is terminal OR parked on a human. The
    engine records `pausedAt` when a step parks on an approval / decision / iteration-cap
    gate and clears it when the step resumes or finishes, so elapsed time no longer
    accrues while the run waits for input (the symmetric counterpart of the terminal
    freeze). A step finished directly out of a parked approval is billed to the pause
    instant, not the later human decision.
  - An iterative gate that spends its automatic budget (a quality companion at its rework
    cap, or the requirements reviewer at its iteration cap) now raises a
    `decision_required` notification. Previously the three-choice decision was reachable
    only by drilling into the parked step, so the run looked silently stuck; the inbox
    item now opens that step's decision surface (companion → step detail with the
    iteration-cap prompt; requirements → the review window).

  No DB migration: the step fields ride in the existing execution `detail` JSON, and the
  notification `type` column is free text in both runtimes.

- 5ca8086: Add alternate subscription-backed coding harnesses (Claude Code / Codex) alongside
  the Pi proxy harness.

  - New per-workspace **subscription token pool** (`provider_subscription_tokens`,
    D1 + Postgres, encrypted at rest) with usage-aware rotation, behind a kernel
    port + `ProviderSubscriptionService`, wired into all three runtimes.
  - A guided **LLM Vendors** navbar UI to connect Claude / Codex / GLM (Z.ai) /
    Kimi (Moonshot) / DeepSeek subscription credentials (token pool, write-only).
    GLM / Kimi / DeepSeek all run via Claude Code against the vendor's
    Anthropic-compatible endpoint; the unfiltered credential list covers every vendor.
  - The executor-harness image now bundles the Claude Code and Codex CLIs; the
    harness selects `pi` / `claude-code` / `codex` per job from the model, and the
    subscription harnesses authenticate direct-to-vendor (no proxy) and report token
    usage from the CLI event stream for rotation + telemetry.
  - The model catalog becomes a canonical-model → provider map with precedence
    **subscription > direct > cloudflare** ("subscriptions always win"): latest
    Opus/Sonnet + GPT-5.5/5.4 (subscription-only), GLM-5.2/Kimi gain a Claude-Code
    subscription flavour, and `ModelOption` now carries per-flavour cost, context
    window, and a `quotaBased` flag (subscription usage is flat-rate quota, never
    billed against the spend budget).
  - A block's model is shared by all its pipeline steps, so a pin to a subscription-only
    model (Claude Code / Codex — container-only, no provider key) is degraded to the
    step's env-routing default for every INLINE LLM path through one shared seam
    (`inlineModelRef` / `resolveInlineModelRef`): both the inline agent executor and the
    requirements reviewer/rework, so the inline steps run instead of hard-failing and the
    two paths can't drift. The claude-code subscription harness repairs malformed
    structured output through the vendor's own Anthropic-compatible endpoint (the Pi
    harness still uses the proxy; Codex keeps the graceful no-repair path).
  - Hardening: the per-vendor token pool is capped to bound growth; the leased
    subscription credential is scrubbed from subscription-repair error details (not just
    GitHub-shaped secrets); and Codex token usage is read from its cumulative
    `total_token_usage` so multi-turn runs attribute usage correctly for rotation.

- 0090313: Surface a step's model the moment it starts, not only once its work finishes.

  A pipeline step's `model` was recorded on the step only after the work returned: a
  container step got its model from the job handle once `startJob` (which blocks for
  the whole cold-boot dispatch) returned, and an inline step from the result once the
  LLM query was over. But the model is fixed the instant its ref resolves (block pin >
  workspace per-kind default > env routing) — well before the container is up or the
  query runs — so the board showed "Spinning up container…" / a working step with no
  model for that whole window.

  The executor port gains an optional, side-effect-free `resolveModel(context)` that
  previews the `provider:model` without dispatching (implemented by the inline
  `AiAgentExecutor` and the `ContainerAgentExecutor`, forwarded by
  `CompositeAgentExecutor`). The execution engine calls it up front and sets
  `step.model` before the first "spinning up container" emit (container steps) and
  before the blocking LLM call (inline steps), so the model rides the same emit that
  shows the step starting. The job handle / result still re-assert the same value, and
  the preview is best-effort (an executor that can't preview, or a resolution failure,
  simply falls back to the old timing). No wire-contract change — the SPA already
  renders `step.model` whenever present, so it now appears immediately. A cross-runtime
  conformance assertion pins that `step.model` is set on the booting/querying emit.

- cc8d96a: Flesh out the Tester agent, add an agent configuration-contribution mechanism, and
  make Mocker always precede Tester.

  - **Pipelines:** every built-in pipeline that runs a `tester` now runs `mocker`
    immediately before it, so the Tester has its external-dependency mocks up.
  - **Config contribution:** agents (built-in or custom, via the agent registry's new
    `configContributions`) declare task-level config parameters. The union over a
    task's pipeline appears on task creation + the inspector and freezes once the
    contributing agent's step starts. Values persist as a sparse `agentConfig` map on
    the block (keys/values length-capped); the catalog rides the workspace snapshot. The
    Tester contributes its `environment` (local vs ephemeral) and Playwright its e2e
    target (CI vs ephemeral). The old fixed `testTarget` block field is dropped — its
    column is dropped on both runtimes too (no backwards-compat shim).
  - **Tester → Fixer loop:** `tester` is now a container agent that runs the project's
    tests — standing infra up locally via the service's docker-compose (rootless
    Docker-in-Docker in the harness) or against an ephemeral environment — and returns
    a structured report (what was tested, outcomes, concerns, greenlight). On a
    withheld greenlight the engine loops a new dedicated `fixer` agent with the report
    and re-tests, up to the task's merge-preset attempt budget. Only **blocking
    (high/critical)** concerns withhold the greenlight — low/medium are advisory, so a
    trivial nit can't burn the whole fixer budget — and the engine re-applies that rule
    defensively over the report. When the budget is spent (or there's no PR branch to
    fix, or the report is unparseable) the run fails for real (the tester step is left
    un-`done`) and raises a human-actionable `test_failed` notification (retry action),
    mirroring the CI gate. New harness `/test` + `/fix-tests` endpoints; reports + fixer
    summaries render in the inspector and step detail.
  - **Service + provisioning config:** a service frame carries the Tester's
    docker-compose path / "no infra dependencies" toggle (a Tester pipeline can't start
    until one is set), plus a cloud provider and abstract instance size that resolve to
    the concrete instance-type id forwarded to the runner. Per-service sizing applies to
    the self-hosted-pool and local-Docker backends; the Cloudflare Container backend has
    a fixed per-class instance type (`wrangler.toml`) with no per-dispatch override, so
    it ignores the hints (pick `cloudflare` when you don't need per-service sizing).
  - **Account default cloud provider (fully wired):** accounts carry a
    `defaultCloudProvider` new services inherit — persisted on both runtimes, settable
    via `PATCH /accounts/:id` (owner-only) and the account menu, returned on the account
    wire, and pre-filled as the service editor's provider default.
  - **Local mode is 100% Docker/Podman:** a new first-class `docker` cloud provider
    represents the local daemon. The local runner backend sizes each per-job container
    from the abstract instance size (`--memory`/`--cpus`) and runs the Tester job
    `--privileged` so it stands its docker-compose infra up with Docker-in-Docker on the
    host daemon — never Cloudflare. A Tester-only pipeline with no PR branch now fails
    cleanly (no fixer to push to) instead of throwing.
  - Mirrored across both runtimes (D1 migration ⇄ Drizzle schema + migration).

- 43f2443: Add a unified, persisted requirements structure stored in each service's GitHub
  repo. A new `requirements-writer` container agent runs before the coder in
  `pl_full` (and standalone via the new `pl_requirements` pipeline): it aggregates
  the clarified requirements of every task under the service frame into one
  PRESCRIPTIVE document, committed to the implementation branch
  (`cat-factory/<blockId>`, created from base when absent) so the spec is present
  before any code is written.

  The harness deterministically renders the document into `requirements/`: the
  canonical `requirements.json` (a `RequirementsDoc`), `overview.md`, `rules.md`
  (cross-cutting domain rules / invariants), a `version.json` staleness manifest,
  and Gherkin `features/*.feature` files (one `Scenario` per acceptance criterion).
  Gherkin is generated two-pass — mechanical render in the harness, then the
  `acceptance` agent polishes the `.feature` files and `playwright` turns each
  scenario into a runnable test. Every container agent reads the requirements via a
  new `REQUIREMENTS_GUIDANCE` block in its global `AGENTS.md`. The in-repo files are
  the source of truth; the engine strictly validates the returned doc
  (`parseRequirementsDoc`) at ingest. Mirrors the blueprint pattern; covered by the
  cross-runtime conformance suite.

- 48d2f0d: Add per-workspace, per-agent-kind default model selection. A workspace can choose
  which model each agent kind defaults to (e.g. point `architect` at a strong model
  and `tester` at a cheap one), overriding the env-driven `AGENT_routing` for that
  workspace at run time. New `GET|PUT /workspaces/:workspaceId/model-defaults`
  endpoints (returning/replacing `{ defaults: Record<agentKind, modelId> }`) and the
  selection surfaced on the workspace snapshot as `modelDefaults`. Persisted in
  `workspace_model_defaults` on both runtimes (D1 migration 0028 / a new Postgres
  migration).

  The defaults are applied uniformly through one shared resolver
  (`resolveStepModelRef` in `@cat-factory/agents`) used by **every** executor — the
  inline LLM executor, the container executor and the requirements reviewer, on both
  the Worker and the Node service — so a step's model resolves as block-pinned >
  workspace per-kind default > env routing for the kind > env default for every agent
  kind, not just the container kinds. A stale/unresolvable block pin now falls
  through to the workspace default instead of skipping it. Request keys (agent kinds)
  and values (model ids) are validated as trimmed, non-empty strings.

- 3e6a844: Workspace creation/onboarding overhaul: real users, non-GitHub auth, invites,
  named+described boards.

  - **Persistent identity**: a new `users` + `user_identities` model replaces the
    GitHub-numeric-id identity. Memberships, `blocks.created_by`, personal
    subscriptions, and the session payload are all re-keyed to a generated `usr_*`
    id. (BREAKING: pre-existing personal accounts — keyed by GitHub login with a null
    `owner_user_id` — stop matching and a fresh personal account is created on next
    sign-in; old member-mapping rows keyed by GitHub id are orphaned. No migration,
    per the pre-1.0 policy.)
  - **Non-GitHub auth**: email/password (WebCrypto PBKDF2 hashing) and Google OAuth
    login alongside GitHub. New-user creation is invite-only plus an optional
    `AUTH_ALLOWED_EMAIL_DOMAINS` self-signup allowlist (fail-closed). A user without
    a GitHub account works fully — repo access is via the GitHub App, not a user token.
  - **Email invitations**: invite teammates by email into an org account; the invitee
    redeems a tokened link to gain membership. Email is sent via a pluggable
    `EmailSender` (SendGrid / Resend adapters) whose provider + API key are
    **onboarded per-account in the UI and stored sealed in the DB** (not env), like
    the Slack bot token. New tables: `users`, `user_identities`, `account_invitations`,
    `email_connections` (D1 + Drizzle).
  - **Board name + description**: `Workspace.description` end to end (create + edit).
  - **Onboarding discovery**: org members see and open existing org boards from the
    switcher instead of being forced to create one.
  - Slack member-mapping is re-keyed from `githubUserId` to the internal `userId`.

### Patch Changes

- 8eed38c: Address review findings on the runtime-facades work:

  - **Node durable execution: fix pg-boss dedup.** The advance queue is now created with
    the `exclusive` policy. `singletonKey` alone does NOT deduplicate under pg-boss's
    default `standard` policy (the singleton unique indexes are policy-gated, and the
    policy-independent one needs `singletonSeconds`), so duplicate `signalDecision`/sweeper
    sends could double-drive a healthy run. `exclusive` makes at most one advance job per
    run id live at a time, restoring the documented no-op semantics.
  - **Node decision timeout.** A run parked on a human decision now arms a delayed
    `execution.decision-timeout` job; `ExecutionService.expireDecision` fails it
    `decision_timeout` only if still parked on that exact decision (idempotent, no driving),
    matching the Cloudflare driver's `waitForEvent` timeout instead of waiting forever.
  - **Node Postgres pool** attaches an `'error'` handler so a transient idle-client drop
    (Postgres restart/failover) no longer crashes the process.
  - **Provider registration parity.** The Worker now registers `openai`/`anthropic` only
    when their key is set (like the Node facade), so an unconfigured provider throws a clear
    "Unsupported model provider" error instead of failing deep in the vendor SDK.
  - **Node config fail-fast**: a too-short `AUTH_SESSION_SECRET` with OAuth configured (and
    no dev-open) now refuses to boot with a clear message rather than silently 503-ing.
  - **`BEDROCK_MODELS=""`** (set-but-blank) is treated as "allow all" rather than rejecting
    every model.
  - **LLM proxy** trims the bearer token, matching the auth middleware.
  - The Node `driveExecution` gate handling drains gate→gate transitions (e.g. a CI step
    dispatching a `ci-fixer`) in-iteration rather than relying on the next advance.

- 28d3c28: Blueprinter: decompose repos into DDD domain modules, not technical layers.

  The Blueprinter (and the manual board-scan scanner) system prompt now applies
  Domain-Driven Design vocabulary: every module must be a **business domain** (a
  bounded context / aggregate / subdomain) named after a business concept, not a
  technical layer. Technical shapes like `api`, `routes`, `controllers`, `utils`,
  `config`, `types` and `db` are explicitly NOT domains, and the genuinely
  non-business, cross-cutting plumbing is collapsed into a single `infrastructure`
  module instead of being scattered across many technical modules.

- a48c620: LLM proxy: cap a workers-ai call's `max_tokens` to the model's context window.

  The proxy floors every workers-ai container call's output request to 32K
  (`PI_MIN_OUTPUT_TOKENS`), assuming Workers AI clamps a too-large request to the
  model's real max. It does not — a model whose TOTAL context window is also 32K
  (e.g. `@cf/qwen/qwen3-30b-a3b-fp8`) rejects the WHOLE request (error 8007 →
  HTTP 502) because the 32K output floor alone fills the window, leaving no room for
  the prompt. Every blueprint/default-model step on that model 502'd on its first
  call and the run failed with "the blueprint agent did not return a usable service
  tree" (an empty completion).

  The catalog already declares each model's window (`contextTokens`); the proxy now
  consults it. New `contextWindowFor(ref)` in `@cat-factory/kernel` looks the window
  up by provider + model, and the proxy caps the floored `max_tokens` so estimated
  input (serialized prompt + tool definitions) plus output fits the window. The cap
  only ever narrows the floor; a large-window model (kimi/glm at 256K) or one with no
  declared window keeps the full 32K. No model change — small-window models now work
  through the proxy instead of hard-failing.

- 9d3a956: Clarity reviewer (bug-report triage) + bug investigator: a new bug-fix pipeline front.

  Adds two new agents at the front of a new `pl_bugfix` ("Triage & fix bug") pipeline preset:

  - **`bug-investigator`** — a read-only container agent (it runs the shared `/explore`
    harness path used by `architect`/`analysis`, so no new harness endpoint or image change).
    It clones the repo, reads the codebase from the raw bug report, and returns a prose
    enriched report plus an OPTIONAL working hypothesis — which it omits unless reasonably
    confident, so a low-confidence guess never misdirects the fix. Its output feeds the
    clarity reviewer (the triage subject) and the coder (a non-binding lead, via `priorOutputs`).
  - **`clarity-review`** — an inline engine gate step that triages the bug report for
    _fixability_ (repro steps, expected-vs-actual, environment, affected area), mirroring the
    requirements-review iterative loop (raise findings → answer/dismiss → incorporate into one
    standard-format clarified report → re-review until it converges, with the same per-task
    `maxRequirementIterations` / `maxRequirementConcernAllowed` knobs). The converged clarified
    report substitutes downstream as the task description for the spec-writer/coder (when both
    a requirements and a clarity review exist, the requirements doc wins).

  Persisted as a new `clarity_reviews` table on BOTH runtimes (D1 migration
  `0002_clarity_reviews` + Drizzle migration), wired in both facades' containers with a new
  `clarity` event on the real-time transport and a `clarity_review` notification type. A
  cross-runtime conformance assertion pins the clarified-brief substitution against both
  stores.

- ad9ba9e: Quality companions (Spec Reviewer, coder's Reviewer, Architect Companion) no longer
  get stuck when they spend their automatic rework budget — they park for a human, the
  same way the requirements reviewer does at its iteration cap.

  Previously a companion that stayed below its quality bar after `maxAttempts` automatic
  reworks failed the run (`companion_rejected`), leaving the task stuck with no path
  forward. Now it parks on a shared iteration-cap gate offering the same three choices as
  the requirements reviewer:

  - extra-round — raise the budget by one and loop the producer back for one more pass;
  - proceed — advance the pipeline accepting the producer's current output;
  - stop-reset — cancel the run and return the task to phase zero (editable), the
    producer's latest output preserved on its branch.

  The two gates now share one mechanism rather than duplicating it: the choice contract
  (`iterationCapChoiceSchema` / `resolveIterationCapSchema`), the parking
  (`parkStepOnDecision`), the gate-resume advance (`advancePastResolvedGate`, also used by
  the generic approval gate), the three-way dispatch (`dispatchIterationCap`, where
  stop-reset is uniformly `cancel()`), and the guard that stops the generic
  approve/request-changes/reject resolvers from short-circuiting an iterative gate
  (`assertNotIterativeGate`). The frontend renders both with one `IterationCapPrompt`
  component.

  `companion_rejected` now means only a genuinely unparseable companion verdict (truncated
  / malformed even after a repair retry) — exhausting the rework budget is no longer a
  failure. New `companion.exceeded` flag marks a parked companion gate;
  `POST /executions/:executionId/steps/:approvalId/resolve-exceeded` resolves it. No new
  persistence — the gate reuses the existing execution row + durable decision-wait, so both
  runtime facades get it; the cross-runtime conformance suite asserts the parking and all
  three resolutions against both.

- 3e7ab89: Make the conflict-resolver actually see the conflict, and stop it churning to 10 attempts.

  Telemetry on a failed run showed the `conflict-resolver` was handed `userPromptFor(context)`
  — the full task brief plus every prior agent's output (~53 KB) — with no mention of which
  files conflicted or that there were conflicts at all. The model drifted onto the original
  feature task (it returned a "test report is ready" answer) and never touched the markers,
  so the gate re-dispatched 10 times with the PR head SHA never moving, then failed the run.

  - Harness: when the base merge surfaces conflicts, build a conflict-focused prompt that
    leads with the exact conflicted files and their `git diff` hunks (new `conflictDiff`
    helper), keeping the task only as a trailing reference. Clean merges and no-op
    "already up to date" cases are now logged distinctly so the "GitHub says conflicting but
    the local merge is clean" loop is diagnosable. Bumps the harness image (1.7.1 -> 1.7.2).
  - Server: the conflict-resolver job body no longer renders `userPromptFor(context)`; it
    sends only a compact task reference (title + description). The harness supplies the
    actual conflict material.
  - Orchestration: the conflicts gate now caps escalations at 3 (was CI's default of 10) via
    its own `attemptBudget` — a conflict retry re-merges the same base with no new signal, so
    it fails fast to a manual-resolution notification instead of burning containers.

- 4ee8a4b: Tame `ContainerAgentExecutor.buildJobBody` (Phase 3). The ~416-line method had eight
  copy-adjust `agentKind` branches, each rebuilding the same `jobId`/`model`/auth/
  `ghToken`/`repo`/`githubApiBase` fields. Extracted two collaborators with no behaviour
  change:

  - A `ModelRouter` that owns the model-routing policy (the canonical step precedence —
    block pin > workspace per-kind default > env routing — plus the "subscriptions always
    win" override for pooled and individual-usage vendors), decoupling routing from job
    dispatch. `resolveModel`/`isQuotaBased`/`buildJobBody` now delegate to it.
  - A shared `common` job-body (built once) + a `resolveAuth` helper (Pi proxy session
    token vs. a leased subscription credential) + a per-kind `buildKindBody` table that
    contributes only each kind's delta. The eight inline bodies collapse to one shared
    base plus small per-kind deltas.

  Pure refactor: the dispatched body shape per kind, the `startJob`/`pollJob` and
  `RunnerTransport` seam, and all public surface are unchanged. Guarded by a new
  per-kind body characterization snapshot test and `ModelRouter` unit tests.

- 8eed38c: The Node runtime now persists to Postgres via Drizzle (the latest 1.0 RC) — the
  single persistence used in dev, test and prod (no test-only in-memory store). It
  implements every core kernel repository port (workspaces, accounts, memberships,
  blocks, pipelines, executions-on-agent_runs, token usage, agent-runs) over a
  node-postgres pool, reusing the SAME row<->domain mappers the Cloudflare D1 repos
  use — which moved into `@cat-factory/server` so both stores share one mapping (the
  Worker re-exports them from their old path). The schema mirrors the D1 tables
  column-for-column; `migrate()` bootstraps it idempotently on boot. `DATABASE_URL`
  selects the database; the in-memory repositories are removed.
- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
- 157cd02: Standardize the executor-harness job API on a single `POST /jobs` endpoint with the
  agent kind carried in the request body, instead of one route per kind (`/run`,
  `/bootstrap`, `/merge`, …).

  Breaking wire change between the runtime transports and the harness image (acceptable
  pre-1.0: the two ship together, no external consumers). The old per-kind-route image
  is incompatible with the new transports, so the runner image MUST be republished and
  deployed.

  - Harness: `server.ts` is now table-driven — one `KINDS` registry keyed by kind drives
    a single `POST /jobs` dispatcher (reads the body's `kind` to pick the validator +
    registry) and a single `GET /jobs/{id}` poll. Adding an agent kind is one table
    entry, not a new endpoint + registry global + poll-chain branch. Bumps the runner
    image tag (1.7.2 -> 1.7.3) in `deploy/backend` (`image:publish` + wrangler.toml).
  - Harness: the explore job's temp-dir/log label field is renamed `kind` -> `label` so
    it no longer collides with the reserved dispatch discriminator `kind`.
  - Server: `ContainerAgentExecutor` stamps the kind into the dispatch body (the explore
    body now sends `label` for its agent-kind label).
  - Worker + local-server transports POST `{ ...spec, kind }` to `/jobs`;
    `LocalDockerRunnerTransport` drops its `KIND_ROUTE` map. The self-hosted pool already
    forwards `kind` in the spec, so it needs no code change — only the manifest docs
    (kernel/contracts/integrations) are updated to note the harness routes by the body's
    `kind`.

- 7a9cabf: Local mode now warns when no GitHub PAT is configured — in the UI, not just the
  console. At boot, `startLocal()` still logs a warning, but the local facade also tags
  its `AppConfig` with a `localMode` block carrying a GitHub "new personal access token
  (classic)" URL (scopes pre-selected: `repo`, `workflow`) when `GITHUB_PAT` is unset.
  The shared `/auth/config` endpoint surfaces that block, and the SPA renders a
  dismissible banner with a one-click link straight to the token-creation page, so the
  prompt isn't lost in a dev terminal. Exposed as `githubPatCreationUrl()` from the local
  facade and `LocalModeConfig` from `@cat-factory/server`.
- b156b4b: Personal-password prompt: per-user dual-mode resolution + accurate model context sizes.

  The individual-usage credential gate now prompts for a personal password exactly when
  dispatch will actually lease one, per user:

  - A subscription-only individual model (Claude / Codex) always needs the personal
    credential (no fallback).
  - A DUAL-MODE individual model (GLM, which also has a Cloudflare base) is per-user: a user
    who has connected their own GLM subscription runs on it (gated on their password), while
    a user without one falls back to Cloudflare GLM with no prompt. Dispatch
    (`ContainerAgentExecutor.resolveEffectiveRef`) and the gate now share this decision via a
    new `hasPersonalSubscription(userId, vendor)` seam wired in both runtime facades, so the
    two can't drift. Previously GLM-on-Cloudflare always prompted (the gate keyed off "the
    model has an individual subscription flavour" rather than "this user will use it").
  - A block pinned to any non-subscription model (Cloudflare / Bedrock / direct) is never
    gated just because a workspace per-kind default happens to be an individual model — a
    resolvable block pin wins for every step, mirroring `resolveStepModelRef`.

  The precedence is a pure, unit-tested `resolveIndividualVendors` +
  `personalCredentialVendorForModelId`.

  Frontend: cancelling the personal-password modal now reverts the task's optimistic
  "Starting…" state instead of leaving it stuck until reload. `withCredential` awaits the
  prompt and reports whether the action ran or was cancelled.

  Model catalog context windows corrected from each provider's own docs (the field is now
  documented as the per-flavour served window, which can be larger or smaller per provider):
  Llama 3.1 7,968; Qwen3-30B 32,768; Kimi K2.6 / K2.7 256K on Cloudflare; DeepSeek R1 distill
  80K on Cloudflare; DeepSeek V4 Pro 131,072; GLM-5.2 256K on Cloudflare and the full 1M via a
  Z.ai subscription. The "cut NNK on Cloudflare" wording in the Kimi/GLM/DeepSeek descriptions
  was inaccurate and is rewritten.

  Also: the board shows an empty-state invite (bootstrap a repo / add from an existing repo)
  when it has no service frames.

- 861d363: Raise the workers-ai proxy output floor `PI_MIN_OUTPUT_TOKENS` 16k → 32k — the actual
  fix for spec-writer truncation.

  The LLM proxy floors every `workers-ai` call to `max_tokens = max(asked, floor)` and
  records/applies that. Production telemetry showed all 362 workers-ai calls recording
  exactly 16384, never 32768: Pi does not forward its model-entry `maxTokens` (the
  harness `PI_MAX_OUTPUT_TOKENS`) as the request `max_tokens`, so `asked` is always at or
  below the floor and the floor is the effective ceiling. Bumping the harness ceiling to
  32k (and rebuilding the image) therefore had no effect on the applied limit. The proxy
  floor is the lever, and it's a worker-side change — no image rebuild needed.

- 311a110: Requirements review: dedicated window + iterative convergence loop, and a universal
  result-view seam.

  The pipeline's `requirements-review` gate step no longer runs as a prose agent behind the
  generic approve/reject panel. It now drives the purpose-built structured review window: the
  reviewer raises findings (each with a severity), the human answers or dismisses them, an
  incorporation companion folds the answers into one standard-format document, and the
  reviewer re-reviews that document. The cycle repeats until the reviewer converges (or every
  remaining finding is dismissed). The human can reject a bad merge and redo the incorporation
  with a freeform "do it differently" comment.

  Two new per-task knobs live on the merge-threshold preset:

  - `maxRequirementIterations` (default 3) — reviewer passes allowed before the run stops on
    its own and the human picks: one more round / proceed anyway (with the last incorporated
    document) / stop and reset the task to phase zero (editable; the last incorporated
    document stays on the inspector as a base).
  - `maxRequirementConcernAllowed` (default `none`) — when every outstanding finding is at or
    below this severity, the findings are recorded but the run advances automatically (no
    human gate, companion skipped).

  Frontend gains a UNIVERSAL result-view seam: an agent archetype can declare a `resultView`
  id and register a window component, and the renderer dispatches to it instead of the generic
  prose panel — requirements review is the first consumer, not a hardcoded special case.

  Breaking (pre-1.0, acceptable): the requirements-rework quality-companion gate is removed
  (convergence is now reviewer-driven), so `RequirementReview` drops `companionVerdicts` and
  gains `iteration`/`maxIterations` and the `merged`/`exceeded` statuses; the
  `requirement_reviews` and `merge_threshold_presets` tables change shape on both runtimes
  (D1 migration `0044` ⇄ a generated Drizzle migration — additive `ALTER`s: `companion` is
  dropped, the new columns take defaults, so existing rows are not lost but their old review
  state is re-created on the next run).

- f16ae62: Board cleanup, resizable service frames, and an explicit container start-up phase.

  - **No more sample services + no "reset to sample board".** New boards start
    empty: workspace creation no longer seeds the sample architecture blocks (the
    SPA passes `seed: false`), and the toolbar's "Reset board to sample" button (and
    the `workspace.reset()` action behind it) is gone. The built-in **pipeline
    catalog is still always provisioned** — it is product config, not sample data —
    so an empty board can still run pipelines. The `seed` flag (now sample _blocks_
    only, default true) remains for demo boards and the test fixtures.

  - **Resizable service frames (Miro-style).** A frame can be resized by dragging
    its right / bottom edges or the bottom-right corner. `Block` gains an optional
    `size` (`{ w, h }`); when set it is the user's dragged size, used as a floor over
    the frame's content extent so a frame grows but is never dragged smaller than its
    tasks/modules. The size is persisted (new `width`/`height` columns on `blocks` —
    D1 migration `0027`, Drizzle migration for Postgres) and updated via the existing
    `PATCH /blocks/:id` (which now accepts `size`).

  - **Explicit "Spinning up container…" phase.** Container-backed steps (`coder`,
    `mocker`, `playwright`, `blueprints`, `merger`, …) now surface an explicit
    cold-boot phase instead of a blank "working" state. `PipelineStep` gains
    `startingContainer`, set the moment the job is dispatched (the dispatch blocks
    until the per-run container is up and has accepted the job, so it covers the whole
    boot window) and cleared on the first successful poll, when the container is
    provably up. The board shows "Spinning up container…" during that window — an
    accurate signal that does not rely on the absence of subtasks. Steps persist as
    JSON, so this needs no migration.

- 861d363: Raise the container LLM-proxy session-token TTL from 30 to 90 minutes so a long but
  healthy agent step can't 401 mid-run.

  The harness job watchdog lets a step run up to `JOB_MAX_DURATION_MS` (default 60 min),
  but the per-run session token (`DEFAULT_SESSION_TTL_MS`) expired at 30 min. The token
  is minted at dispatch, before the container boots and Pi starts, so its clock leads
  the job's by the boot/dispatch latency. A spec-writer run on a slow Workers AI model
  (`kimi-k2.7-code`, with repeated 4-minute upstream timeouts) ran ~34 min and died with
  `401 Invalid or expired session token` while the watchdog still considered it alive.

  90 min clears the 60-min watchdog ceiling plus the boot lead with margin. The token
  stays tightly scoped (audience `llm-proxy`, one workspace, one execution, locked
  provider+model), so the longer life is a small risk increase: a leak can only spend
  that run's metered budget on that one model. The token is minted with no `ttlMs`
  override in `ContainerAgentExecutor`, so both runtimes pick up the new default.

- 86a5843: Require final-answer agents to emit the answer in the reply, not the reasoning channel.

  A spec-writer run, then a blueprinter run, on `@cf/moonshotai/kimi-k2.7-code` failed
  with "the agent did not return a usable ...: its final turn produced no text (an empty
  completion)" even though the model produced a complete, valid document. The whole
  answer landed in the model's reasoning channel and the visible reply came back empty
  (telemetry: `finish_reason='stop'`, thousands of completion tokens, ~31k chars of
  `reasoning_text`, zero visible content). The harness reads the deliverable from the
  visible content only, so the no-empty-outcome gate (`unusableFinalAnswerCause`)
  correctly failed the run.

  This is universal to any agent whose deliverable IS its final reply. Added a shared
  `FINAL_ANSWER_IN_REPLY` fragment (`@cat-factory/agents`, `prompts/shared.ts`) that
  names the channel, and applied it to every final-answer agent: the four container
  constants in `ContainerAgentExecutor.ts` (spec-writer, blueprint, merger, on-call), the
  design/review/test standard phases, the tester report, the business-reviewer, the
  companions, the requirements reviewer + rework, and the generic report roles
  (researcher, analysis, bug-investigator, documenter, integrator, task-estimator,
  merger). It is deliberately NOT applied to side-effect agents whose product is a pushed
  commit (coder, ci-fixer, conflict-resolver, mocker, playwright, business-documenter):
  they legitimately end with no final text. The spec-writer prompt also now states it has
  no repository write access, removing the "maybe it just wants me to push the file"
  reading. Bumped the `requirement-review`, `requirement-rework`, and `review` versioned
  prompts. The no-empty-outcome gate stays as the safety net.

- Updated dependencies [fe53445]
- Updated dependencies [8eed38c]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [3e7ab89]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [ec0c416]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [14840ec]
- Updated dependencies [4030da2]
- Updated dependencies [268c15d]
- Updated dependencies [c9d3f49]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [794b628]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [1a0686f]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [f9d3647]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [c664fe6]
- Updated dependencies [7d5e060]
- Updated dependencies [4a08935]
- Updated dependencies [2796a42]
- Updated dependencies [6406c8c]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [56ee67d]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [ba1c0cf]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [cc39497]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [2ab06b5]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [6406c8c]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [e0230a0]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [b98923c]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/integrations@0.7.0
  - @cat-factory/orchestration@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
  - @cat-factory/prompt-fragments@0.7.0
  - @cat-factory/spend@0.7.0
