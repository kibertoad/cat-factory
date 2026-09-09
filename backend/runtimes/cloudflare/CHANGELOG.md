# @cat-factory/worker

## 0.216.0

### Minor Changes

- b75fa3c: Let a service say, in its own words, how it should be tested
  
  A Tester was handed two things about a service it did not stand up: where to reach it, and which
  credentials its shell carries. Neither says which flows matter, which of the seeded accounts is the
  one to sign in as, what the demo data means, or which flow charges a real card. That knowledge
  exists, it is short, and until now there was nowhere to put it, so every Tester run rediscovered it
  from the repository or guessed.
  
  **Testing context** is a freeform text box on the service frame's inspector, directly beneath the
  sealed test credentials (advanced interface tier, and shown at either tier once a service records
  one, so nobody is left unable to read or clear what their testers are being told). It is stored on
  the service and injected verbatim into every tester prompt for it. The environment self-test's agent dry run is handed the same text through the same renderer:
  a dry run's whole claim is that it predicts what a real Tester will be able to do here, and it cannot
  predict that from a different briefing.
  
  Three decisions worth knowing:
  
  - **It is non-sensitive by contract**, because it is rendered INTO the prompt. Secrets stay in the
    sealed panel above, which never renders a value into a prompt or into telemetry, and this prose
    refers to them by variable name. The panel says so.
  - **The empty case is stated to the agent, never omitted.** A Tester told nothing cannot tell "this
    platform has nowhere to write that down" from "the place exists and nobody filled it in", so it
    either reports no gap at all or reports one against the service. Told, it reports what it had to
    guess at, which is what tells an operator what to type. A tester running on work that sits under
    no service frame is told THAT instead, so an empty field and an absent owner cannot be reported
    as the same neglect.
  - **It is a `blocks` column, not a table**, for the reason `provisioning` and `service_connections`
    are columns: one service-frame-owned value the engine reads off the frame it has already walked
    to. Both runtimes gain the column and a conformance assertion drives the frame-chain walk on both
    stores; the write boundary drops the field on any non-frame block rather than persisting dead data.
  
  Only the two tester kinds are handed it, so every other agent's prompt is byte-for-byte unchanged,
  and a service that records nothing keeps the prompts it had.

### Patch Changes

- Updated dependencies [b75fa3c]
  - @cat-factory/contracts@0.352.0
  - @cat-factory/kernel@0.345.0
  - @cat-factory/agents@0.163.0
  - @cat-factory/orchestration@0.309.0
  - @cat-factory/server@0.321.0
  - @cat-factory/binary-generators@0.3.47
  - @cat-factory/consensus@0.17.47
  - @cat-factory/eks@0.1.386
  - @cat-factory/gates@0.11.47
  - @cat-factory/gitlab@0.23.10
  - @cat-factory/integrations@0.172.16
  - @cat-factory/observability-otel@0.23.40
  - @cat-factory/prompt-fragments@1.1.43
  - @cat-factory/spend@0.21.5
  - @cat-factory/caching@0.20.81
  - @cat-factory/observability-langfuse@0.11.47
  - @cat-factory/provider-cloudflare@0.7.539

## 0.215.2

### Patch Changes

- Updated dependencies [bba4beb]
  - @cat-factory/kernel@0.344.0
  - @cat-factory/agents@0.162.0
  - @cat-factory/orchestration@0.308.0
  - @cat-factory/binary-generators@0.3.46
  - @cat-factory/caching@0.20.80
  - @cat-factory/consensus@0.17.46
  - @cat-factory/eks@0.1.385
  - @cat-factory/gates@0.11.46
  - @cat-factory/gitlab@0.23.9
  - @cat-factory/integrations@0.172.15
  - @cat-factory/observability-langfuse@0.11.46
  - @cat-factory/observability-otel@0.23.39
  - @cat-factory/prompt-fragments@1.1.42
  - @cat-factory/provider-cloudflare@0.7.538
  - @cat-factory/server@0.320.2
  - @cat-factory/spend@0.21.4

## 0.215.1

### Patch Changes

- Updated dependencies [afd09af]
  - @cat-factory/contracts@0.351.1
  - @cat-factory/agents@0.161.1
  - @cat-factory/binary-generators@0.3.45
  - @cat-factory/consensus@0.17.45
  - @cat-factory/eks@0.1.384
  - @cat-factory/gates@0.11.45
  - @cat-factory/gitlab@0.23.8
  - @cat-factory/integrations@0.172.14
  - @cat-factory/kernel@0.343.1
  - @cat-factory/observability-otel@0.23.38
  - @cat-factory/orchestration@0.307.1
  - @cat-factory/prompt-fragments@1.1.41
  - @cat-factory/server@0.320.1
  - @cat-factory/spend@0.21.3
  - @cat-factory/provider-cloudflare@0.7.537
  - @cat-factory/caching@0.20.79
  - @cat-factory/observability-langfuse@0.11.45

## 0.215.0

### Minor Changes

- 2ae7e2b: Add a bugfix preset that proves the fix from the repository and spends the environment on one question
  
  Every way the platform had of establishing that a change works needs a running system: the API and
  UI testers read a provisioned ephemeral environment, and the acceptance author writes tests that
  target one. On a deployment whose preview environments are slow, costly or not representative, that
  makes a bugfix wait on infrastructure to answer a question a committed test answers better, and it
  leaves nothing behind: the environment goes away and the next regression is found the same way.
  
  `pl_bugfix_tested` ("Fix bug, verified by tests") is `pl_bugfix`'s investigate, triage, reproduce,
  fix, review spine with the verification moved into the checkout:
  
  - **`mocker` then `integration-test`**, both after the fix and both before the `ci` gate. The mock
    step is the existing one (WireMock stubs the repo owns, wired into compose and CI); the
    integration step is a new registered kind that drives the fix through the seam a caller uses
    against those stubs, commits the tests, and reports what it could NOT cover. CI re-running them
    is the enforcement, which is why the step is a `container-coding` kind rather than a tester: only
    the tester family is handed environment coordinates, so tests written here cannot come to depend
    on a URL even by accident.
  - **`deployer` then `disposer`, with nothing between them**, as a LAUNCH CHECK. The deployer
    provisions the pull-request branch and settles on a reachability verdict, so a service that no
    longer starts fails the run; a service that stands nothing up records a clean no-op as always.
    That verdict is the only thing this preset asks an environment for, so the reclaim is adjacent
    rather than terminal: holding the environment through the merge tail would bill for a URL no step
    is going to open.
  
  Three things about the new step are deliberate and worth knowing before editing it. Committing no
  test never fails the run (the fix is already pushed by the time it runs, so a failure would throw
  the work away rather than name the gap): it reports `outcome: 'uncovered'` with the reason, and an
  unreadable reply degrades to the same value rather than to a claim it never made. The gaps it
  states are rendered even under a `covered` verdict, because the reported behaviour being covered
  says nothing about the neighbouring case that is not. And its verdict is a claim about FILES, which
  tolerating a no-op makes uncheckable by anything else, so the platform records on the step whether
  the run committed anything and withdraws a `covered` claim an empty push contradicts, naming the
  claim rather than quietly showing it.
  
  `mocker` gains the same no-op tolerance, which is a fix to every preset that carries it rather than
  a concession to this one. Its own prompt tells it to add stubs only for calls not yet mocked, so an
  empty diff is the ordinary outcome on a repository whose upstreams are already stubbed, and the
  harness cannot tell that apart from an agent that did nothing. Failing there was also late: every
  preset runs the mocker after the coder has opened the pull request. That prompt now sizes the work
  to the change in flight too, instead of treating the block's whole external surface as mandatory.
  
  **Behaviour change: a marked BUG-FISHING finding now spawns onto this preset by default** instead of
  `pl_bugfix`. A fished defect has no reporter to reproduce it with and no environment anybody is
  watching it in, so the regression test committed beside the fix is the whole deliverable. Selection
  is unchanged and was already there at two tiers: the board's `bugFishingFixPipelineId` overrides the
  platform default for every spawn, and a single marking overrides both through the request's
  `pipelineId`. A workspace that had set the board field is unaffected.
  
  Two costs come with that default, both the launch check's, and both are documented rather than
  worked around: every marked finding provisions and reclaims an environment (a recorded no-op on an
  `infraless` service), and a marking is refused outright when the service declares provisioning it
  has not finished wiring, because a pipeline carrying an enabled `deployer` meets
  `RunAdmission.assertDeployerConfigured` and the marking propagates that refusal rather than
  answering 200 over a fix task that will never appear. `pl_bugfix` reached neither. A board that
  wants neither pins something else in `bugFishingFixPipelineId`.
  
  Existing workspaces pick the preset up the way every catalog addition arrives: the new-pipeline
  advisory offers it, a reseed inserts it, and a run that pins it by id adopts it. The bug-fishing
  spawn resolves its fix pipeline through that same adoption seam rather than a point read at the
  workspace's rows, which is what lets a board older than a built-in mark a finding at all.
  
  The run outcome summary gains one additive `/api/v1` value for the same reason (surface version
  1.71.0): `tests.gap: 'verified_by_committed_tests'`, so a run that verified through committed tests
  stops being reported as one where "nothing was exercised" on the one surface a person reads, while
  its pull request says the opposite.

### Patch Changes

- Updated dependencies [2ae7e2b]
  - @cat-factory/contracts@0.351.0
  - @cat-factory/kernel@0.343.0
  - @cat-factory/agents@0.161.0
  - @cat-factory/orchestration@0.307.0
  - @cat-factory/server@0.320.0
  - @cat-factory/binary-generators@0.3.44
  - @cat-factory/consensus@0.17.44
  - @cat-factory/eks@0.1.383
  - @cat-factory/gates@0.11.44
  - @cat-factory/gitlab@0.23.7
  - @cat-factory/integrations@0.172.13
  - @cat-factory/observability-otel@0.23.37
  - @cat-factory/prompt-fragments@1.1.40
  - @cat-factory/spend@0.21.2
  - @cat-factory/caching@0.20.78
  - @cat-factory/observability-langfuse@0.11.44
  - @cat-factory/provider-cloudflare@0.7.536

## 0.214.1

### Patch Changes

- Updated dependencies [6ff632f]
  - @cat-factory/contracts@0.350.0
  - @cat-factory/agents@0.160.0
  - @cat-factory/orchestration@0.306.0
  - @cat-factory/server@0.319.0
  - @cat-factory/binary-generators@0.3.43
  - @cat-factory/consensus@0.17.43
  - @cat-factory/eks@0.1.382
  - @cat-factory/gates@0.11.43
  - @cat-factory/gitlab@0.23.6
  - @cat-factory/integrations@0.172.12
  - @cat-factory/kernel@0.342.1
  - @cat-factory/observability-otel@0.23.36
  - @cat-factory/prompt-fragments@1.1.39
  - @cat-factory/spend@0.21.1
  - @cat-factory/provider-cloudflare@0.7.535
  - @cat-factory/caching@0.20.77
  - @cat-factory/observability-langfuse@0.11.43

## 0.214.0

### Minor Changes

- ca5be97: Read one notification row where the engine was reading the whole inbox, and write one review key where the SPA was cloning the record
  
  Five paths on the run loop answered a one-row question by pulling every open notification in the
  workspace and filtering in JS: does a card already point at this parked run, is the workspace-wide
  `budget_paused` card open, and the two "ready for review/testing" clears. Each decoded every open
  card's `body` and `payload` JSON, and each ran per park and per gate pass, so the cost grew with
  whatever humans had not yet actioned rather than with the thing being asked about. They read
  narrowly now, through `NotificationService.findOpenByType` / `clearByType` / the new
  `clearOnBlock` (one find-then-settle for every "the run settled this card itself" path, replacing
  two copies of it in the controllers and the loop inside `clearWaitingDecision`), and through a new
  `NotificationRepository.listOpenByBlock(workspaceId, blockId)` for the park check, served by the
  existing `(workspace_id, block_id, type, status)` index on its leading columns. That one
  deliberately takes no `type`: the caller asks whether ANY card points at the block, so narrowing to
  one would raise a duplicate beside a card of another type.
  
  Two behaviour notes, neither of them cosmetic:
  
  - **`clearByType` settles EVERY open block-less card of its type, not just the newest**, in one
    `UPDATE … RETURNING` (`NotificationRepository.dismissOpenByType`). A block-less card is exempt
    from the partial unique index behind the block-scoped raise, because NULLs are distinct in a
    unique index, so `raise` still de-dupes it with a read-before-write and two writers landing in
    one tick can leave two open rows. The inbox scan this PR removed was healing that on every
    clear; a point-read would have left the second card open forever, escalated red for a condition
    that had since cleared. It returns `Notification[]` (newest first) instead of
    `Notification | null`, which the platform-health and key-drift sweeps read.
  - **`NotificationRepository` gains two required members** (`listOpenByBlock`, `dismissOpenByType`),
    so an out-of-tree implementation of the kernel port stops compiling until it adds them. Both are
    mirrored D1 ⇄ Drizzle with conformance assertions and allow-listed `remote` for mothership mode.
  
  On the SPA side the review-family stores (requirements, clarity, brainstorm, consensus, doc
  interview, initiative) wrote a key by replacing the whole record. That record is a deep reactive
  ref, so the replace is a write to the ref itself, a dependency every reader shares: one review
  event woke every card on the board, not just the one whose review changed. They assign the key
  now, and `requirements.backgroundStage` (the getter every card actually calls) answers the
  pending-recommendation half off the block's own review object rather than a `computed` over the
  record, which tracked every key and kept the fan-out alive on its own.
  `notifications.byBlock` was deleted rather than fixed, its per-block badge having moved to
  `reviewDebtByBlock` some time ago with nothing left consuming it.
  
  The wire shapes, the inbox contents and the rendered UI are unchanged.

### Patch Changes

- Updated dependencies [ca5be97]
- Updated dependencies [333b967]
  - @cat-factory/kernel@0.342.0
  - @cat-factory/orchestration@0.305.0
  - @cat-factory/server@0.318.0
  - @cat-factory/caching@0.20.76
  - @cat-factory/eks@0.1.381
  - @cat-factory/spend@0.21.0
  - @cat-factory/agents@0.159.1
  - @cat-factory/binary-generators@0.3.42
  - @cat-factory/consensus@0.17.42
  - @cat-factory/gates@0.11.42
  - @cat-factory/gitlab@0.23.5
  - @cat-factory/integrations@0.172.11
  - @cat-factory/observability-langfuse@0.11.42
  - @cat-factory/observability-otel@0.23.35
  - @cat-factory/prompt-fragments@1.1.38
  - @cat-factory/provider-cloudflare@0.7.534

## 0.213.0

### Minor Changes

- 5f06bfb: Run an environment dry run on the model the workspace picked, and hand it what the tester will get
  
  An agent dry run was dispatched on a model no workspace had chosen. Its facades read the deployment's
  env routing for the tester kinds once, at wiring, and pinned the prober to it for the process
  lifetime, so a workspace running everything on its Claude preset had its dry run dispatched at the
  Node family's Qwen default. The LLM proxy then refused it for having no key configured (`502`), after
  the run had already created a branch and stood a real environment up. The subscription that would
  have served it was never asked for, because the flow only ever knew the proxy branch: a
  subscription-routed model was refused at WIRING, which disabled the whole capability for exactly the
  deployments that had one.
  
  The model is now resolved per dispatch, under the same precedence a pipeline step gets (the frame's
  own pin, then the workspace's model preset entry for the prober's kind, then env routing), through
  the shared `ModelRouter`. The credential that opens it comes from the same `ContainerJobAuthResolver`
  the step executor uses, so a dry run can run on a pooled subscription, a personal one, or the
  developer's own CLI in native local mode. A personal credential is only leasable with its owner's
  unlock, so the start route gates on it exactly as a run start does (428 `credential_required`, minted
  against the run id the dispatch leases against) rather than provisioning an environment and failing
  at the lease. `provision` mode spends no model call and stays ungated.
  
  The dry run also now predicts what a tester step will be handed, which is the only thing it was ever
  claiming. Both are rendered by one module: the frame's test credentials as a three-state brief
  (configured / the platform could not open its own store / this deployment has no store), the
  environment access scheme including the two states the tester's own section used to drop, and one
  list of where to look in the repository for how to operate the service. The tester side of each was
  weaker: a sealed store that would not open reached it as an absent section, which reads as "this
  service has none configured" and sends someone to re-enter secrets that are already there, and an
  unopenable store took the whole dispatch down rather than costing the credentials.
  
  One rule the two held halves of moved with them: the shapes of a success nobody observed (a 200
  carrying an error body, a login page where JSON was expected, a command that printed failures and
  exited 0, a suite that ran zero tests). The prober named the HTTP ones; the tester, whose greenlight
  is what merges a change, had the principle and none of the shapes. Grading and writing deliberately
  did NOT move, because a prober never does either and the second is a security property its dispatch
  shape enforces.
  
  Watch for one behaviour change: a dry run used to run on the deployment's `tester-api` /
  `tester-ui` env routing, and now runs on whatever the workspace's preset names for
  `environment-prober-api` / `environment-prober-ui`, falling back to that same env routing when the
  preset names neither. A deployment that wants a specific model for dry runs sets it on those two
  preset entries. The proxyable check moved with the resolution: it is asked of the RESOLVED model at
  dispatch instead of disabling the capability deployment-wide over a routing entry no workspace had
  chosen.
  
  Three things the dispatch resolves are now PERSISTED on the run row and handed back to every later
  poll (`probe_model`, `probe_subscription_token_id`, `probe_subscription_vendor`), the same rule a
  pipeline step's `recordDispatchAttribution` follows. The poll runs in a fresh process and rebuilds
  its handle from that row: re-resolving the model there answered about the frame and preset as they
  are NOW, so a pin cleared while the container worked stamped the settled report with a model nobody
  ran, and the leased pooled token id has no second source at all.
  
  With it, a settled dry run files what it spent through the same `ContainerJobAccounting` a step's
  poll files through: the per-call rows, the leased token's usage-aware rotation counters and the
  modeled quota cycle. That only binds on a subscription harness, which is why it could not be left
  out: a Pi job is metered by the LLM proxy, but a subscription harness talks to the vendor direct, so
  the whole burn of a subscription-routed dry run was previously absent from the telemetry, from the
  rotation and from the quota window: free and invisible, on the flow whose own admission gate is a
  budget.
  
  Admission now also asks whether the RESOLVED model can be dispatched (409
  `env_test_probe_model_unavailable`, translated in every locale), covering a provider the LLM proxy
  cannot serve and a subscription-only model with no connected credential. Both were knowable before
  anything was created and both used to cost a throwaway branch, a full provision and a teardown to
  discover. The personal-credential unlock moved to LAST among the gates, resolved through a closure
  the service calls after its own refusals, so a dry run that could never have started no longer asks
  for a password first; and the mint now happens before the run row exists and outside the start's
  cleanup path, so an unlock that fails answers `428 credential_required` instead of a `201` carrying
  a failed run that the SPA reads as a finished action.
  
  Two fixes reach beyond the dry run. The modeled subscription quota cycle is now keyed on the VENDOR
  the dispatch resolved rather than the model's provider: the two differ for four of the five
  (`claude`/`anthropic`, `codex`/`openai`, `glm`/`zai`, `kimi`/`moonshot`), so the fold silently
  matched DeepSeek alone and counted nothing for the rest. Expect quota cycles to start reporting
  usage for those vendors. And both facades now compose every container dispatch's credential channels
  through one builder, which is what closes the gap the dry run's own composition had: it omitted
  `resolveAccountId`, so the proxy session token carried no account scope and the account-tier spend
  budget was not enforced for a dry run while it was for every pipeline step.

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0
  - @cat-factory/agents@0.159.0
  - @cat-factory/orchestration@0.304.0
  - @cat-factory/server@0.317.0
  - @cat-factory/binary-generators@0.3.41
  - @cat-factory/consensus@0.17.41
  - @cat-factory/eks@0.1.380
  - @cat-factory/gates@0.11.41
  - @cat-factory/gitlab@0.23.4
  - @cat-factory/integrations@0.172.10
  - @cat-factory/observability-otel@0.23.34
  - @cat-factory/prompt-fragments@1.1.37
  - @cat-factory/spend@0.20.2
  - @cat-factory/caching@0.20.75
  - @cat-factory/observability-langfuse@0.11.41
  - @cat-factory/provider-cloudflare@0.7.533

## 0.212.0

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
  - @cat-factory/binary-generators@0.3.40
  - @cat-factory/consensus@0.17.40
  - @cat-factory/eks@0.1.379
  - @cat-factory/gates@0.11.40
  - @cat-factory/gitlab@0.23.3
  - @cat-factory/integrations@0.172.9
  - @cat-factory/observability-otel@0.23.33
  - @cat-factory/prompt-fragments@1.1.36
  - @cat-factory/spend@0.20.1
  - @cat-factory/caching@0.20.74
  - @cat-factory/observability-langfuse@0.11.40
  - @cat-factory/provider-cloudflare@0.7.532

## 0.211.6

### Patch Changes

- 636fcf3: Re-verify every curated model route against its serving provider, take the agent CLIs at their
  newest, and refresh the dependency tree.
  
  **A withdrawn route, caught by the pin checker.** OpenRouter has withdrawn the undated
  `qwen/qwen3.8-max` and now serves the dated `qwen/qwen3.8-max-0902` instead. That is the silent
  failure `scripts/check-openrouter-pins.mjs` exists for: nothing throws, `effectiveVariant` keeps
  choosing the gateway for a workspace holding only an OpenRouter key, and every dispatch fails on
  a dead slug. The two entries swap arms accordingly, and the floating entry is deliberately NOT
  re-pointed at the dated slug: following an alias onto a snapshot is the identity the pinned entry
  beside it exists to hold.
  
  **GLM-5.3 gains the two routes it was waiting for.** It shipped subscription-only because Z.ai
  had not yet released the weights; Workers AI picked it up on 2026-08-28 and OpenRouter serves
  `z-ai/glm-5.3` today. Both were read off the serving provider before being declared, and each
  carries that provider's own window rather than the vendor's headline figure: Workers AI
  1,048,576, OpenRouter 1,310,720, the coding plan 1M.
  
  **Qwen3.8 Flash joins the catalog**, on DashScope and OpenRouter. It is the cheapest 1M-window
  entry here that reads images, which is what earns it a curated slot rather than the dynamic
  OpenRouter catalog: it is the natural low-cost tier for the inline steps that reach for
  `glm-flash` today, and a per-token rate is what those steps are chosen on.
  
  **One pinned rate was understating the budget gate.** `openrouter:x-ai/grok-4.6` carried xAI's
  SHORT band ($2 / $6) with its cache tier left to derive, while the direct `xai:grok-4.6` row
  carried the long band as its comment explains. xAI bills a request whose prompt reaches 200K
  tokens entirely at the doubled rate and OpenRouter is a passthrough, so the gateway row now
  matches: a cache read was metering at 60% below the live rate on a route that really does record
  the class (`x-ai` is `auto-prefix` on the gateway). Every other pin came back at or above its
  live rate, and every curated `openrouter` context window matches what the gateway serves.
  
  **Two omissions re-checked rather than assumed.** GPT-6 Astra still declares no `bedrock` arm:
  Codex 0.153.3 did add Astra to the Bedrock picker, so the route demonstrably exists, but neither
  AWS nor OpenAI publishes the model id it addresses, and a `baseModelId` guessed from a
  neighbouring entry is precisely the dead pin repaired above. Still no separate "Astra Pro" entry
  either, though the reasoning has narrowed: OpenRouter has minted its own `openai/gpt-6-astra-pro`
  slug, while OpenAI's model doc states reasoning effort is a parameter on the single `gpt-6-astra`
  id and Codex has no such `--model` slug. A second entry could therefore carry one arm re-badging
  a model already here at byte-identical pricing, and the two-entry shape is for a choice made with
  the price in front of you.
  
  **Agent CLIs.** Pi 0.85.0 -> 0.85.1 and Claude Code 2.1.261 -> 2.1.263 take their newest releases
  ahead of the 24h age window, as the Dockerfile's standing note allows for those three pins. Codex
  holds at 0.153.4 (already newest) and both Pi extensions at 2.9.0. Playwright in the UI image goes
  1.62.1 -> 1.63.0 with `@playwright/test`. The executor image tag rolls to 1.154.0.
  
  **Dependency refresh.** Direct ranges plus a lockfile re-resolution: 56 resolved names moved, no
  package name added or dropped. Four holds are unchanged and were re-verified at HEAD rather than
  restated: vitest at 4.1.11 and wrangler at 4.124.0 (`@cloudflare/vitest-pool-workers` 0.22.0 is
  still the newest and peers `vitest: ^4.1.0` while pinning that wrangler exactly),
  `@cloudflare/workers-types` at 5.20260815.1 (the resolved workerd's date), and frontend TypeScript
  at 6.0.3 (`vue-tsc` 3.3.11 calls `require.resolve('typescript/lib/tsc')`, which TS 7's exports map
  does not carry). Base images are unchanged: `node:26-trixie-slim` still resolves to the digest
  already pinned. GitHub Actions: `docker/setup-qemu-action` v4.2.0 -> v4.3.0, `pnpm/action-setup`
  v6.0.10 -> v6.1.0, `zizmorcore/zizmor-action` v0.6.2 -> v0.6.3.
- Updated dependencies [636fcf3]
  - @cat-factory/agents@0.157.2
  - @cat-factory/consensus@0.17.39
  - @cat-factory/integrations@0.172.8
  - @cat-factory/kernel@0.339.0
  - @cat-factory/observability-langfuse@0.11.39
  - @cat-factory/orchestration@0.302.2
  - @cat-factory/provider-cloudflare@0.7.531
  - @cat-factory/server@0.315.2
  - @cat-factory/spend@0.20.0
  - @cat-factory/binary-generators@0.3.39
  - @cat-factory/eks@0.1.378
  - @cat-factory/caching@0.20.73
  - @cat-factory/gates@0.11.39
  - @cat-factory/gitlab@0.23.2
  - @cat-factory/observability-otel@0.23.32
  - @cat-factory/prompt-fragments@1.1.35

## 0.211.5

### Patch Changes

- 386c4a2: Add GPT-6 Astra to the curated catalog, take the agent CLIs at their newest, and refresh the
  dependency tree.
  
  **GPT-6 Astra.** OpenAI's new flagship (2026-09-03) joins the catalog as `gpt-6-astra` with a
  Codex subscription arm and an OpenRouter pay-as-you-go arm, a 1.05M window and image input. The
  model id IS the Codex `--model` slug, the same rule the GPT-5.6 tiers already follow. Two shapes
  were decided by checking the routes rather than the announcement:
  
  - **No `bedrock` arm**, even though OpenAI named Bedrock among the launch-day routes. No published
    model card names the Bedrock **id** for Astra, and this catalog declares a flavour only once the
    route is verified to serve that exact model: a declared-but-absent route is selected by
    `effectiveVariant` and then fails at dispatch, with nothing upstream of the dispatch to catch it.
    The arm can be added, additively, when the id lands.
  - **No separate "Astra Pro" entry.** Pro is not a second model or a second API id: it is this same
    `gpt-6-astra` served with `reasoning.mode` set to `pro`, and it exists only inside the ChatGPT
    plans, never on the API or in Codex. An entry for it could only name a route nothing here can
    dispatch.
  
  Astra is priced at $10 / $50 per 1M, the most expensive model this catalog can select on either
  OpenAI route, so it gets its own `openai:` and `openrouter:` spend rows rather than metering
  against the bare provider fallback. Its cached input is $1, the same 0.1x read multiplier the
  GPT-5.6 tiers use, so the derived cache tiers are already exact. The 2x "Fast mode" rate is
  deliberately not modelled: nothing here dispatches it, and a row set to a mode we never request
  would over-meter every ordinary Astra run against the budget gate.
  
  The built-in `mdp_chatgpt` preset deliberately stays on `gpt-5.6-sol` this round. It names a
  vendor rather than a generation and is meant to roll forward as that vendor's flagship moves, but
  Astra is still rolling out per-organization: rolling the preset now would repoint every workspace
  holding it onto a model its subscription may not serve yet, and the failure would land at dispatch.
  It is a one-line roll-forward once the rollout completes.
  
  **Agent CLIs.** Claude Code 2.1.260 -> 2.1.261, Codex 0.153.2 -> 0.153.4 and Pi 0.84.4 -> 0.85.0
  all take their newest releases ahead of the 24h age window, as the Dockerfile's standing note
  allows for those three pins. The Codex pin now also carries a floor the catalog depends on: Astra
  resolves only from Codex 0.153.0 onward, and an older CLI answers `Unknown model` rather than
  falling back, so that coupling is recorded at both ends. Both Pi extensions are already newest at
  2.9.0. The executor image tag rolls to 1.152.0.
  
  **Dependency refresh.** Direct ranges plus a full lockfile re-resolution: 70 resolved names moved,
  no package name added or dropped. Four holds, each on a live constraint rather than caution, and
  the first three are one constraint at three levels:
  
  - vitest and `@vitest/coverage-v8` stay on 4.1.11: `@cloudflare/vitest-pool-workers` 0.22.0 is the
    newest release and still peers `vitest: ^4.1.0`.
  - wrangler holds at 4.124.0 for the sixth round, pinned exactly as a dependency of that same package.
  - `@cloudflare/workers-types` holds at 5.20260815.1, one level further down. Its version encodes a
    workerd DATE and the wrangler above pins `workerd@1.20260815.1`, so moving the types to
    5.20260904.1 would describe a runtime three weeks newer than the one that actually executes: an
    API added in the gap typechecks green and throws in production. That is the whole reason
    `check-cloudflare-runtime-pins` exists, and it is what caught the attempt.
  - TypeScript holds at 6.0.3 on the frontend, where `vue-tsc` resolves `typescript/lib/tsc`, which
    TS 7 no longer exports.
- Updated dependencies [386c4a2]
  - @cat-factory/agents@0.157.1
  - @cat-factory/consensus@0.17.38
  - @cat-factory/integrations@0.172.7
  - @cat-factory/kernel@0.338.0
  - @cat-factory/orchestration@0.302.1
  - @cat-factory/provider-cloudflare@0.7.530
  - @cat-factory/spend@0.19.0
  - @cat-factory/binary-generators@0.3.38
  - @cat-factory/server@0.315.1
  - @cat-factory/eks@0.1.377
  - @cat-factory/caching@0.20.72
  - @cat-factory/gates@0.11.38
  - @cat-factory/gitlab@0.23.1
  - @cat-factory/observability-langfuse@0.11.38
  - @cat-factory/observability-otel@0.23.31
  - @cat-factory/prompt-fragments@1.1.34

## 0.211.4

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/orchestration@0.302.0
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0
  - @cat-factory/agents@0.157.0
  - @cat-factory/server@0.315.0
  - @cat-factory/gitlab@0.23.0
  - @cat-factory/integrations@0.172.6
  - @cat-factory/binary-generators@0.3.37
  - @cat-factory/consensus@0.17.37
  - @cat-factory/eks@0.1.376
  - @cat-factory/gates@0.11.37
  - @cat-factory/observability-otel@0.23.30
  - @cat-factory/prompt-fragments@1.1.33
  - @cat-factory/spend@0.18.2
  - @cat-factory/caching@0.20.71
  - @cat-factory/observability-langfuse@0.11.37
  - @cat-factory/provider-cloudflare@0.7.529

## 0.211.3

### Patch Changes

- 5c50d30: Cleanup pass with no behaviour change: deletes exports nothing consumed (dead constants, parse
  wrappers, alias schemas, pass-through re-exports and the Worker's compat-shim modules left over
  from the `@cat-factory/server` extraction), drops the `export` keyword from module-local symbols,
  folds duplicated private helpers onto one owner (base64, `scrub`, `sleep`, `withFlag`, the
  per-row busy guard), and removes tests that asserted a constant against its own literal or
  re-implemented the code under test. The SPA's unreachable palette drop handler goes with it.
  
  Internal-surface break, flagged per the compatibility rules: the removed barrel exports
  (`DEFAULT_CI_MAX_ATTEMPTS`, `STANDARD_PHASES`, `isTestingKind`, `isBugFishingPhaseId`,
  `SEALED_SECRET_SOURCE_NAMES`, `TelemetryReadResults`, `LinearFetchLike`, `ENVIRONMENT_BLOCK_TYPE`,
  the contracts `parse*`/`safeParse*` one-liners and the `initiativePreset*`/`taskTypeFieldOption`
  schema aliases) had no consumer in this repository; a downstream import of one of them fails at
  typecheck and should read the underlying helper directly.
- Updated dependencies [5c50d30]
  - @cat-factory/agents@0.156.3
  - @cat-factory/consensus@0.17.36
  - @cat-factory/contracts@0.346.2
  - @cat-factory/gitlab@0.22.36
  - @cat-factory/integrations@0.172.5
  - @cat-factory/kernel@0.336.1
  - @cat-factory/observability-otel@0.23.29
  - @cat-factory/orchestration@0.301.3
  - @cat-factory/prompt-fragments@1.1.32
  - @cat-factory/server@0.314.3
  - @cat-factory/binary-generators@0.3.36
  - @cat-factory/provider-cloudflare@0.7.528
  - @cat-factory/eks@0.1.375
  - @cat-factory/gates@0.11.36
  - @cat-factory/spend@0.18.1
  - @cat-factory/caching@0.20.70
  - @cat-factory/observability-langfuse@0.11.36

## 0.211.2

### Patch Changes

- cd220f2: Add five catalog models, take the agent CLIs at their newest, and refresh the dependency tree.
  
  **Five new curated models.** Claude Fable 5.1, Gemini 3.8 Flash, a pinned Qwen3.8-Max-0902
  snapshot, and Meta's Muse Spark 1.3 in both of its commercial tiers. Every route was checked
  against the serving provider's live catalogue before it was declared, which is what decided three
  of the shapes:
  
  - **Claude Fable 5.1** is the first Claude entry carrying subscription, OpenRouter and Bedrock arms
    at once. Bedrock listed `anthropic.claude-fable-5-1` on Anthropic's own launch day rather than a
    generation behind, so the flavour is declared against a verified route. Its OpenRouter slug is
    DOTTED (`anthropic/claude-fable-5.1`) where the API id is dashed; the two genuinely disagree and
    normalising either spelling yields a dead id.
  - **Qwen3.8-Max-0902** is DashScope-only. OpenRouter serves the undated alias and publishes no dated
    slug, and a flavour declared before its route exists is picked by `effectiveVariant` and then
    fails at dispatch. It is a separate entry rather than a repoint of `qwen3.8-max` for the reason
    `claude-opus-4-8` is separate: a block pinned to a snapshot must keep getting that build.
  - **Muse Spark 1.3 ships as TWO entries**, standard and contributor. They are the same model on the
    same route and differ only in what Meta may do with the traffic: the contributor tier costs a
    twelfth on input in exchange for Meta training on the prompts and completions. That is a choice
    an operator has to make with the price in front of them, and one entry could only make it
    silently, so the two prices sit in separate rows and the SPA's "enable recommended" set omits the
    contributor slug.
  
  `meta` joins the OpenRouter vendor-prefix family map beside `meta-llama`, so an account that blocks
  the Meta family blocks Muse Spark too rather than leaving it unclassified.
  
  **The bare `bedrock` price row moved up a tier**, from ~$5/$30 to ~$10/$50 per 1M. A Bedrock ref
  carries the account's own geo prefix, so `priceFor` can only ever match the bare provider key, and
  that row is deliberately set to the frontier tier the catalog can select there. Fable 5.1 moved that
  ceiling; leaving the row behind would have metered every Fable-5.1-on-Bedrock run at half its cost.
  
  **Both runner image tags roll**: the executor to 1.150.0 for the CLI bumps, and the deploy image
  to 0.6.2 because the dependency round moved `@types/node` in its `package.json`, which the image
  builds from. A dep bump inside a harness IS an image-source change, and republishing over a live
  tag does not roll a deployment out.
  
  **Agent CLIs at their newest, ahead of the age window**, as the Dockerfile's standing note allows
  for exactly these pins: Claude Code 2.1.252 -> 2.1.260 and Codex 0.152.0 -> 0.153.2. Pi is already
  at its newest (0.84.4). Both Pi extensions move 2.8.0 -> 2.9.0 and have aged past the window, so
  they take the ordinary route.
  
  **Dependency refresh**: direct ranges plus a lockfile re-resolution, so transitives move to the
  newest release each declared range already admits under the `minimumReleaseAge` gate. 68 resolved
  names move and the re-resolve adds and drops nothing, leaving 1388 names on both sides. Direct:
  the `@ai-sdk/*` line (`amazon-bedrock@^5.0.73`, `anthropic@^4.0.49`, `openai@^4.0.57`,
  `openai-compatible@^3.0.43`, `provider@^4.0.10`), `ai@^7.0.91`, `@aws-sdk/client-s3@^3.1125.0`, the
  `@opentelemetry/*` set (`0.222.0` exporters, `2.11.0` SDK), `@types/node@^26.4.1`,
  `happy-dom@^20.13.2`, `knip@^6.34.0`, `oxfmt@^0.66.0`, `oxlint@^1.81.0`, `undici@^8.10.1`. The AI
  SDK family stays inside the `ai@^7` + `@ai-sdk/*@^4` majors that pair with `workers-ai-provider`.
  
  Three holds, each for a reason rather than for the age window:
  
  - **TypeScript stays at 6.0.3 on the frontend** while the backend is already on 7.0.2. TS 7 was
    tried and reverted: `vue-tsc@3.3.11` resolves `typescript/lib/tsc`, which TS 7 no longer exports,
    so the typecheck dies with `ERR_PACKAGE_PATH_NOT_EXPORTED` before reading a single file. vue-tsc
    is the real gate for `.vue`, so the frontend moves when vue-tsc does.
  - **wrangler holds at 4.124.0 and `@cloudflare/workers-types` at 5.20260815.1** for the fifth round
    running. `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins wrangler
    exactly; the types version IS the workerd date that pin resolves.
  - **`@types/node@26.4.0` and `undici@8.10.0` keep a second resolved copy** beside the new ones, held
    by upstream ranges (`@types/pg`, `happy-dom`, `nuxt`, `unifont`) rather than by anything here.
  
  Also re-pins `openrouter:deepseek/deepseek-v4-flash`, the one row `check-openrouter-pins.mjs`
  reported as metering BELOW the live rate. The alias drifted up ~9% since the 2026-09-01 read, and a
  budget gate is allowed to be early but never short.
- Updated dependencies [cd220f2]
  - @cat-factory/agents@0.156.2
  - @cat-factory/caching@0.20.69
  - @cat-factory/consensus@0.17.35
  - @cat-factory/eks@0.1.374
  - @cat-factory/integrations@0.172.4
  - @cat-factory/kernel@0.336.0
  - @cat-factory/observability-langfuse@0.11.35
  - @cat-factory/observability-otel@0.23.28
  - @cat-factory/orchestration@0.301.2
  - @cat-factory/provider-cloudflare@0.7.527
  - @cat-factory/server@0.314.2
  - @cat-factory/spend@0.18.0
  - @cat-factory/binary-generators@0.3.35
  - @cat-factory/gates@0.11.35
  - @cat-factory/gitlab@0.22.35
  - @cat-factory/prompt-fragments@1.1.31

## 0.211.1

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1
  - @cat-factory/orchestration@0.301.1
  - @cat-factory/server@0.314.1
  - @cat-factory/agents@0.156.1
  - @cat-factory/binary-generators@0.3.34
  - @cat-factory/caching@0.20.68
  - @cat-factory/consensus@0.17.34
  - @cat-factory/eks@0.1.373
  - @cat-factory/gates@0.11.34
  - @cat-factory/gitlab@0.22.34
  - @cat-factory/integrations@0.172.3
  - @cat-factory/observability-langfuse@0.11.34
  - @cat-factory/observability-otel@0.23.27
  - @cat-factory/prompt-fragments@1.1.30
  - @cat-factory/provider-cloudflare@0.7.526
  - @cat-factory/spend@0.17.12

## 0.211.0

### Minor Changes

- 0f3fb10: Bootstrap runs are legible: their steps are shown, their details are inspectable, and a retry resumes where the run stopped
  
  A repo bootstrap was already a first-class agent run in every way that costs something to build
  (one `agent_runs` table, one retry surface, one stop surface) and in no way that helps a person
  watching one. It rendered as a single "bootstrapping…" bar, so a monorepo bootstrap's three moves
  (survey both repositories → your adoption decisions → write the service and open the pull request)
  were invisible, and the control under that bar said "Retry bootstrap" while the service actually
  resumed at the phase the run reached, carrying the reviewer's settled decisions forward.
  
  The steps are now derived from the run row by one rule in `@cat-factory/contracts` that both sides
  read: the board renders them on the in-progress, parked and failed cards, and
  `BootstrapService.retry` branches on the same function, so the button names the step it resumes
  from and cannot promise one the service does not re-enter at. Where a run GOT to and where a retry
  RESUMES are separate questions, because they differ on one case: a run parked on a plan the
  platform could not produce reached the review, but the retry drops that plan so a fixed deployment
  can produce a real suggestion, and re-surveys.
  
  A bootstrap is also inspectable through the observability panel now, over the same routes and the
  same four sinks as any other run. It had been filing almost nothing: no provided-context snapshot,
  no tool-call trajectory, and its apply phase's model calls keyed on the run's DRIVE id, which no
  run-scoped read asks for. The drive id now addresses the container and nothing else; every sink
  carries the run. The inline monorepo survey tags its loop with the run too and files its own
  context snapshot, so its prompt and its spend read beside the apply's instead of sitting in the
  store outside every read that could find them. What the panel cannot answer for a bootstrap (the
  per-phase rollup and the run's cost, both folded from an execution's steps) it now SAYS, rather
  than hiding the section: beside a list of calls that plainly cost something, a missing cost tile
  reads as a run that cost nothing.
  
  Stopping a bootstrap no longer reports itself as a failure of the step it was stopped in. A stop
  is stored as a failed status with a `cancelled` kind, so a stopped monorepo run used to paint the
  reviewer's own decision step red; it is now its own step state.
  
  Two behaviour changes worth knowing: a bootstrap's model calls are filed under the agent kinds
  that actually ran (`repo-bootstrapper`, `monorepo-adoption-advisor`) rather than under `architect`,
  which changes how new rows group in per-kind spend rollups (the container still resolves its MODEL
  through `architect`'s routing); and `MonorepoAdoptionSubject` gains a required `runId`, so a
  deployment that injects its own `MonorepoAdoptionAdvisor` implementation gets the run id it needs
  to tag its calls with. The two kind strings are exported from `@cat-factory/contracts`
  (`REPO_BOOTSTRAP_AGENT_KIND`, `MONOREPO_ADOPTION_AGENT_KIND`), which is where anything naming
  them should now read them from; `@cat-factory/agents` no longer exports the second.

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0
  - @cat-factory/agents@0.156.0
  - @cat-factory/orchestration@0.301.0
  - @cat-factory/server@0.314.0
  - @cat-factory/binary-generators@0.3.33
  - @cat-factory/consensus@0.17.33
  - @cat-factory/eks@0.1.372
  - @cat-factory/gates@0.11.33
  - @cat-factory/gitlab@0.22.33
  - @cat-factory/integrations@0.172.2
  - @cat-factory/observability-otel@0.23.26
  - @cat-factory/prompt-fragments@1.1.29
  - @cat-factory/spend@0.17.11
  - @cat-factory/caching@0.20.67
  - @cat-factory/observability-langfuse@0.11.33
  - @cat-factory/provider-cloudflare@0.7.525

## 0.210.0

### Minor Changes

- 745eae8: Let a bootstrap say how its work should land: a pull request, or a push.
  
  A bootstrap's delivery used to be decided by its target. Landing a service in a monorepo always
  opened a pull request; creating a repository always force-pushed the scaffold onto the default
  branch. Neither is wrong as a default and both are wrong as the only option: a team that wants
  the first commit of a new service reviewed before it becomes `main` had no way to ask for that,
  and a team standing services up in their own monorepo had to review and merge a pull request per
  service to get one there.
  
  `delivery` (`pull_request` | `direct_push`) is now a third axis on the launch form and on
  `POST /workspaces/:ws/bootstrap/jobs`, orthogonal to where the content comes from and where the
  service lands. Omitted, it resolves to the target's own default, so every existing caller is
  unchanged: `direct_push` for a new repository, `pull_request` for a monorepo. It is stored on the
  run, because a retry re-dispatches under it.
  
  Three consequences worth knowing before choosing:
  
  - **`direct_push` into a monorepo publishes as the agent works.** The harness checkpoints
    committed work to whichever branch it is pushing, so a run that faults leaves what it had
    already written on the default branch. A retry resumes on top of it.
  - **`pull_request` for a NEW repository needs a base commit**, since a pull request is opened
    between two commits. A repository with none is refused at pre-flight, naming both ways out.
    Create it with an initial README, or push directly. The modal's own "create repository" button
    now seeds one.
  - **A `pull_request` run does not trigger the initial service mapping.** The mapper clones the
    default branch, which such a run has not written to, so it would map the repository's initial
    README. The service frame says so; run "map service" from the inspector once the pull request
    has merged.
  
  `/api/v1`: a bootstrap job now projects `delivery`, and its already-released `prUrl` is populated
  for a new-repo run that opened one. Read `delivery` for whether a pull request is coming and
  `repoUrl` for which target a run took; the two URL fields are no longer mutually exclusive. Spec
  version 1.68.0, additive, all four SDKs regenerated.
  
  Internal break: `MonorepoBootstrapLeg` no longer carries `branch`/`pr`, and `BootstrapRepoRequest`
  carries a required `delivery` plan instead; `monorepoBootstrapBranch` / `monorepoBootstrapPrTitle`
  are now `bootstrapWorkBranch` / `bootstrapPrTitle`. A bootstrap run also records its `workBranch`,
  so a retry resumes the branch its first attempt pushed instead of opening a second one.

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0
  - @cat-factory/agents@0.155.0
  - @cat-factory/orchestration@0.300.0
  - @cat-factory/server@0.313.0
  - @cat-factory/binary-generators@0.3.32
  - @cat-factory/consensus@0.17.32
  - @cat-factory/eks@0.1.371
  - @cat-factory/gates@0.11.32
  - @cat-factory/gitlab@0.22.32
  - @cat-factory/integrations@0.172.1
  - @cat-factory/observability-otel@0.23.25
  - @cat-factory/prompt-fragments@1.1.28
  - @cat-factory/spend@0.17.10
  - @cat-factory/caching@0.20.66
  - @cat-factory/observability-langfuse@0.11.32
  - @cat-factory/provider-cloudflare@0.7.524

## 0.209.0

### Minor Changes

- e7e1f8c: Bug fishing expeditions: hunt a codebase for the defects nobody has reported yet
  
  Every defect flow the platform had started from a REPORT: `bug-investigator` triages one,
  `pl_bugfix` fixes one, `bug-hunt` picks one off a tracker board. Nothing looked for the defects
  nobody has hit, and those are the ones that surface as an incident rather than as a ticket.
  
  A new `bug-fishing` task type runs the new read-only `bug-fisher` agent over a service's codebase
  once per ANGLE — logic and control flow, failure handling, boundary conditions, concurrency and
  idempotency, state and resource lifecycle, interface contracts, footguns, and conformance with the
  supplied product requirements. One pass told to find everything returns the shallow half of
  everything; a pass told to think only about concurrency reads the same files with a question that
  makes the race visible, and each angle is its own dispatch with a fresh context, so one angle's
  reading never lands on another's transcript. Nothing is written and no pull request is opened.
  
  Triage does not wait for the hunt. A finished angle's findings are final the moment they land, so
  the expedition window offers them while later angles are still fishing, and each finding a human
  MARKS spawns its own bug-fix task — carrying the finding's evidence and reproduction — on the
  pipeline the board configures for spawned fixes (`bugFishingFixPipelineId`, defaulting to the
  built-in bug-fix preset, overridable per batch). The spawned task links back through the new
  `Block.expeditionId`.
  
  Refusals are deliberately loud rather than convenient. A pass that crashes settles THAT angle as
  failed carrying its reason, and so does one that answers unusably (no `result.custom`, or a blob
  the schema rejects), because a phase that silently reported nothing is indistinguishable from one
  that honestly found nothing — and which angles came back empty is the whole thing a human reads.
  A mark whose fix task cannot be created — a pipeline that no longer exists, or one that cannot be
  started on a one-off task — fails with the pipeline named instead of answering 200 and leaving
  somebody waiting for a task that will never appear. Dismissing an id the expedition does not carry
  is refused rather than quietly accepted. And an expedition that caught nothing still parks and
  says so.
  
  Marking is safe against two people at once. Creating the task and recording it after would let two
  markings of one finding each file the same bug and start a run for it, so the finding's spawn
  record is taken as a `pending` CLAIM under the run's compare-and-swap, carrying the block id it is
  about to create, and settled to `spawned` or `failed` behind the work. The consequence for anyone
  reading the state: whether a finding is being fixed is its spawn's `status`, not the record being
  present. A spawned fix is also created the way the create form would have created it — with the
  service's standing standards and the marking user as its creator — so it is held to the same
  standards as the identical bug filed by hand, and the notifications its run raises reach somebody.
  
  The pre-dispatch input gate learned about the type: a bug-fishing task legitimately carries no
  description, because its input is the codebase, so `description_missing` no longer parks one at
  step 0.
  
  Public API: `taskType` gains `bug-fishing` and `NotificationType` gains `bug_fishing_triage`,
  with two new optional notification-payload fields (`phaseCount`, `untriagedFindingCount`). Both are
  additive enum members the SDKs already tolerate; the spec is `1.67.0`.
  
  Internal break: `workspace_settings` and `blocks` each gain a column, and
  `ExecutionServiceDependencies` gains an optional `serviceRepository` plus an optional
  `promptFragmentSource` (the pool a newly created task's default fragments come from, so a spawned
  fix reads the same one the create form does). Both facades ship the migration.

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0
  - @cat-factory/agents@0.154.0
  - @cat-factory/orchestration@0.299.0
  - @cat-factory/integrations@0.172.0
  - @cat-factory/server@0.312.0
  - @cat-factory/binary-generators@0.3.31
  - @cat-factory/consensus@0.17.31
  - @cat-factory/eks@0.1.370
  - @cat-factory/gates@0.11.31
  - @cat-factory/gitlab@0.22.31
  - @cat-factory/observability-otel@0.23.24
  - @cat-factory/prompt-fragments@1.1.27
  - @cat-factory/spend@0.17.9
  - @cat-factory/caching@0.20.65
  - @cat-factory/observability-langfuse@0.11.31
  - @cat-factory/provider-cloudflare@0.7.523

## 0.208.2

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0
  - @cat-factory/agents@0.153.1
  - @cat-factory/binary-generators@0.3.30
  - @cat-factory/consensus@0.17.30
  - @cat-factory/eks@0.1.369
  - @cat-factory/gates@0.11.30
  - @cat-factory/gitlab@0.22.30
  - @cat-factory/integrations@0.171.2
  - @cat-factory/observability-otel@0.23.23
  - @cat-factory/orchestration@0.298.1
  - @cat-factory/prompt-fragments@1.1.26
  - @cat-factory/server@0.311.3
  - @cat-factory/spend@0.17.8
  - @cat-factory/caching@0.20.64
  - @cat-factory/observability-langfuse@0.11.30
  - @cat-factory/provider-cloudflare@0.7.522

## 0.208.1

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0
  - @cat-factory/agents@0.153.0
  - @cat-factory/orchestration@0.298.0
  - @cat-factory/binary-generators@0.3.29
  - @cat-factory/consensus@0.17.29
  - @cat-factory/eks@0.1.368
  - @cat-factory/gates@0.11.29
  - @cat-factory/gitlab@0.22.29
  - @cat-factory/integrations@0.171.1
  - @cat-factory/observability-otel@0.23.22
  - @cat-factory/prompt-fragments@1.1.25
  - @cat-factory/server@0.311.2
  - @cat-factory/spend@0.17.7
  - @cat-factory/caching@0.20.63
  - @cat-factory/observability-langfuse@0.11.29
  - @cat-factory/provider-cloudflare@0.7.521

## 0.208.0

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
  - @cat-factory/binary-generators@0.3.28
  - @cat-factory/consensus@0.17.28
  - @cat-factory/eks@0.1.367
  - @cat-factory/gates@0.11.28
  - @cat-factory/gitlab@0.22.28
  - @cat-factory/observability-otel@0.23.21
  - @cat-factory/prompt-fragments@1.1.24
  - @cat-factory/server@0.311.1
  - @cat-factory/spend@0.17.6
  - @cat-factory/caching@0.20.62
  - @cat-factory/observability-langfuse@0.11.28
  - @cat-factory/provider-cloudflare@0.7.520

## 0.207.0

### Minor Changes

- 8b015a3: Bootstrap a new service INTO an existing monorepo, with a human review of what it adopts.
  
  Repo bootstrap only ever created a service in a repository of its own: clone a reference
  architecture, adapt it, force-push a single commit to a fresh empty repo. That shape is exactly
  wrong for a monorepo, which already holds other people's services: there is no empty target, the
  force-push would destroy them, and the question worth asking is not what the service contains but
  what it should share with everything around it. A bootstrap can now target a DIRECTORY of a
  repository the workspace already has, and it is delivered as a pull request.
  
  That question has no good default, which is why the run stops to ask. The template ships its own
  build tooling, lint config, test runner, CI wiring and layout; the monorepo has answers for the
  same areas, usually different ones. Adopt the template wholesale and the repository grows a second
  toolchain; adopt the monorepo wholesale and the template stops being worth having. So a monorepo
  run is two phases with a person between them: it surveys both sides, proposes per-area
  recommendations, parks on a new `awaiting_review` status, and writes nothing until a human has
  settled every line.
  
  The suggestion is built to be CHECKED rather than trusted. The platform reads a bounded, declared
  set of files through the checkout-free repo port (the root manifests, the CI workflows, and the
  nearest EXISTING sibling service, which is the only thing that says what a service in this
  repository actually looks like), and the model only judges what it was given. A recommendation
  whose evidence names no file the survey read is dropped before it reaches the reviewer, and the
  plan reports the drop rather than quietly shortening: a plan that lost half its lines to invention
  must not look like a monorepo with few conventions. What the survey could not read is reported
  apart from what is simply absent, for the same reason.
  
  Two refusals are load-bearing. A review that leaves a decision unanswered is refused rather than
  defaulted onto the recommendation, because agreeing with a suggestion and never having read it are
  the two things this step exists to tell apart. And an answer naming a decision the plan does not
  carry is refused whole, since the reviewer was looking at a different proposal. Where no model is
  configured, over budget, or unable to read the repository, the run still parks and the reviewer is
  told what the platform could not offer and why. An empty decision list and "the analysis never
  ran" lead to opposite conclusions, and each cause needs a different fix, so each is its own
  reason. The reviewer can settle such a plan anyway: there is nothing to answer, their notes are
  the whole instruction, and the review is the only exit from the park.
  
  The survey's own model call is guarded twice. It answers to the same workspace budget a run start
  does, since nothing else gates it; and it is claimed atomically before the call rather than marked
  after it, because both durable drivers replay and two drives that each saw no plan yet would bill
  twice and leave a reviewer answering a plan that had been replaced underneath them.
  
  The apply phase is an ORDINARY coding job rather than a bootstrap one: the monorepo as the
  writable primary at a work branch, the reference template beside it as a read-only checkout the
  run is structurally incapable of pushing to, and one pull request. Nothing outside the new
  directory is touched beyond the registration the monorepo's own tooling needs, and nothing is
  merged for the reviewer.
  
  The settled decisions ride the pull request as an engine-owned marker region rather than as its
  body. The harness lets an agent-authored description replace the body field-wise, and it asks for
  one whenever the target repository ships a pull request template, so the reviewed decisions (the
  one thing on that PR the agent did not choose) would otherwise be routinely overwritten. The
  region also means every hole in it crosses the host-markdown boundary: a reviewer's note reading
  "fixes #412" would close an unrelated issue on the monorepo when the bootstrap PR merged.
  
  `BootstrapStatus` gains `awaiting_review` and `BootstrapJob` gains `prUrl`, both reaching
  `/api/v1` (surface 1.65.0) because a run started in the app is read through it. `prUrl` is a new
  field rather than a reuse of `repoUrl`: a monorepo run creates no repository, and putting a pull
  request link in a field documented as the created repository's URL would leave an integration
  that clones what it reads cloning a PR. It is additive (the clients tolerate unknown enum values),
  but a poller's terminal test has to change: `awaiting_review` is neither running nor finished, so a
  loop treating "not succeeded and not failed" as "still working" would wait forever on a run that is
  waiting for a person.

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0
  - @cat-factory/agents@0.151.0
  - @cat-factory/orchestration@0.296.0
  - @cat-factory/server@0.311.0
  - @cat-factory/binary-generators@0.3.27
  - @cat-factory/consensus@0.17.27
  - @cat-factory/eks@0.1.366
  - @cat-factory/gates@0.11.27
  - @cat-factory/gitlab@0.22.27
  - @cat-factory/integrations@0.170.1
  - @cat-factory/observability-otel@0.23.20
  - @cat-factory/prompt-fragments@1.1.23
  - @cat-factory/spend@0.17.5
  - @cat-factory/caching@0.20.61
  - @cat-factory/observability-langfuse@0.11.27
  - @cat-factory/provider-cloudflare@0.7.519

## 0.206.0

### Minor Changes

- ec0aba1: Keep what a status poll observes, and stop the environment investigation reasoning past it
  
  The first real environment investigation produced a confident wrong verdict: it blamed a platform
  readiness gate that had worked correctly, told a human to go change three behaviours that already
  behave as asked, and filed the actual cause as one bullet underneath. Three defects behind it, all
  in what the platform recorded rather than in what the model did with it.
  
  **A status poll now persists what it captured.** `refreshStatus` handed the whole provision-field
  bag to the provider and then wrote a patch that omitted it, so `provision_fields_cipher` was
  written once at create time and never again. For an asynchronous provider the create response is
  the least informative answer it will ever give (no finished deploy job, no load balancers, no
  readiness detail), so every fact worth capturing arrived on a poll and was discarded, and an
  adapter recording its balancer health and DNS resolution on each poll was writing into a field
  nothing read. A stated bag now REPLACES the stored one, whole, and
  `ProvisionedEnvironment.fields` is nullable: `null` states nothing and keeps what is stored, which
  is what stops a status endpoint answering a narrower shape than its create endpoint from erasing
  teardown state. The docstring described merge semantics and the code implemented neither.
  
  The corollary binds every adapter: a statement has to be COMPLETE. The generic manifest provider's
  `status()` therefore carries the keys this response said nothing about over from the stored bag
  under its freshly mapped values, because its bag is built from two paths a status endpoint commonly
  omits (the id usually rides the request path, not the body). Its no-`status`-template fallback and
  the Compose provider's no-project branch answer `null`, which is what an adapter that read nothing
  owes.
  
  **A poll the provider ANSWERED leaves a trail.** The provisioning log records a poll that threw and
  a poll that turned an environment `failed`; any other answer wrote nothing anywhere, so a readiness
  wait that polled for four minutes left two rows a second apart at the create, and nothing in the
  data distinguished "nothing polled" from "polling is not logged". The environment row carries
  `lastPolledAt` plus a `pollCount` floor (a row per poll being the wrong shape at a ten-second
  cadence), both projected onto `EnvironmentHandle`. It counts ANSWERS rather than successes, a
  `failed` verdict included: the claim a reader gets wrong is how much polling happened, and reading
  it as a success count would hand an investigation twenty-two successes for an environment that
  failed all twenty-two.
  
  **The investigation's evidence carries the route, and one timeline.** The bundle gains
  `route` (the addresses the provider stated and what dialling them proved) and folds the proof into
  the timeline dated from its own `checkedAt`, so an ordering claim that contradicts a timestamp the
  platform held is structurally hard to state; the verdict that filed this said the reachability
  check "settled roughly at the moment of the create request" against a `checkedAt` reading 4m18s
  later. The provisioning log's own state is an entry in that list too, in each of the four ways it
  can have one (this deployment keeps none / this environment is on no run / it was read and holds
  nothing / the read threw), because once the record's dates and the poll marker joined the timeline
  an absent log stopped being distinguishable from an empty one by the list coming back short. The
  platform also COMPUTES the determinate cause where its own inputs settle one (a `not_reached` proof
  beside an empty candidate list means nothing but the environment's own name was ever available to
  dial; a `no_candidate` proof BESIDE stated addresses is the different determinate cause that the
  URL published none, not that the provider stated no addresses) and tells the model it outranks
  anything inferred from apparent ordering. Prompt bumped to `environment-investigation@v2`, which
  also forbids reading the absence of an entry in a record of attempts as the absence of the event,
  and names the route evidence and the poll marker as sources an answer may cite.
  
  The route evidence is scrubbed and bounded on the way into the bundle, like every other
  provider-authored section: `candidates` comes off a response mapping with no declared length and a
  probe's `detail` is the only field carrying a raw error string. The attempt list now has ONE
  renderer (kernel's `describeRouteTargets`) rather than a copy per surface, which is how one of them
  came to ship that detail unredacted while its neighbour scrubbed it.
  
  **A route proof survives on what it established.** The fold compared the candidate list as a
  SEQUENCE, so any later poll whose list merely reordered dropped the proof, and nothing took
  another: `proveEnvironmentRoute` is reached only from the deployer's frame settle, which never runs
  again for a settled frame. A provider stating addresses from a live DNS answer does not control
  their order. A `reached` proof now survives while the target it names is still on offer (compared
  after the same trim the prober applies, so a padded address stops failing to match its own proof),
  any other proof while the candidate set is unchanged, and `refreshStatus` re-proves a `ready`
  environment whose proof it had to drop.
  
  The re-prove is bounded, and the bound needed a third field. It runs at most once a minute per
  environment, because a provider that genuinely re-states a different candidate set on every answer
  would otherwise add up to twenty seconds of sequential dialling to every poll of a ten-second
  readiness wait. Pacing that off the proof's own `checkedAt` does not work: the first time the poll
  waits, it persists the drop, and the next poll reads an environment nothing ever dialled. So
  `EnvironmentReachability` carries `probedAt` (when the platform last LOOKED, kept across a dropped
  verdict and a moved URL), which is also what lets an environment settled `unproved` before a
  deployment wired its prober get proved once one exists: `unproved` is a proof never taken, and it
  survives the fold indefinitely.
  
  Internal break: `ProvisionedEnvironment.fields` is `ProvisionFields | null` (nullable, not
  optional, so every provider still has to decide), `EnvironmentRecord` gains `lastPolledAt` and
  `pollCount`, and the stored reachability blob gains an optional `probedAt`. Both facades add the two
  columns (D1 migration 0099 and the matching Drizzle migration) and existing rows read back as
  never-polled, which is what they are; `probedAt` needs no migration (it is inside the existing JSON
  column) and a value written without one re-proves at its first opportunity.

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0
  - @cat-factory/integrations@0.170.0
  - @cat-factory/agents@0.150.0
  - @cat-factory/orchestration@0.295.0
  - @cat-factory/binary-generators@0.3.26
  - @cat-factory/consensus@0.17.26
  - @cat-factory/eks@0.1.365
  - @cat-factory/gates@0.11.26
  - @cat-factory/gitlab@0.22.26
  - @cat-factory/observability-otel@0.23.19
  - @cat-factory/prompt-fragments@1.1.22
  - @cat-factory/server@0.310.2
  - @cat-factory/spend@0.17.4
  - @cat-factory/caching@0.20.60
  - @cat-factory/observability-langfuse@0.11.26
  - @cat-factory/provider-cloudflare@0.7.518

## 0.205.0

### Minor Changes

- 720bad0: A boot-validation warning now names ONE structured `subject`, so `escalateRegistrationWarning` can
  dispose of a mixed fragment declaration per id.
  
  `task_type_unknown_fragment` reports one warning per unresolved id instead of batching a
  declaration's ids into one, and every warning carries the id it is about as data rather than only
  interpolated into its message. A deployment whose `defaultFragmentIds` names code-registered
  standards beside a late-bound tenant-tier reference can now fail boot on the typo and keep the
  warning on the late-bound id, by testing the namespace its own standards live under:
  
  ```ts
  escalateRegistrationWarning: (p) =>
    p.code === 'task_type_unknown_fragment' && p.subject.startsWith('acme.'),
  ```
  
  Test that namespace positively. The inverse (`!p.subject.startsWith('src:')`) reads as the same rule
  and is not one: a hand-authored account-tier row and a repo-sourced file pinning its own frontmatter
  `id` both carry a plain slug, so it fails boot on exactly the tenant-tier reference it means to
  spare.
  
  The platform's own severity is unchanged: both are still warnings by default, because boot cannot
  tell a typo from a tenant-tier id. Design record: ADR 0063.
  
  Two reports also stop arriving in duplicate: a repeated id in one declaration is one warning, and a
  tool-server definition shared across kinds is checked once, naming every kind it is declared for. A
  blank `defaultFragmentIds` entry is now an ERROR (no tier resolves a blank id, so it cannot be a
  late-bound reference).
  
  INTERNAL BREAK (pre-1.0, no shim): `RegistrationProblem` is now a union of `RegistrationErrorProblem`
  and `RegistrationWarning`, and only the warn branch carries `subject`; its `code` is the closed
  `RegistrationWarnCode` union. Code constructing a problem by hand, or reading `subject` off the
  union, must narrow on `severity` first. An `escalateRegistrationWarning` predicate written against
  the previous signature keeps compiling: its parameter is narrowed to `RegistrationWarning`, and
  every field it could read is still present. The two credential warnings
  (`oauth_header_collision`, `unused_credential_env_name`) name the TOOL SERVER as their subject
  rather than the credential key, which several servers may share.

### Patch Changes

- Updated dependencies [436f373]
- Updated dependencies [720bad0]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0
  - @cat-factory/orchestration@0.294.0
  - @cat-factory/agents@0.149.1
  - @cat-factory/binary-generators@0.3.25
  - @cat-factory/consensus@0.17.25
  - @cat-factory/eks@0.1.364
  - @cat-factory/gates@0.11.25
  - @cat-factory/gitlab@0.22.25
  - @cat-factory/integrations@0.169.1
  - @cat-factory/observability-otel@0.23.18
  - @cat-factory/prompt-fragments@1.1.21
  - @cat-factory/server@0.310.1
  - @cat-factory/spend@0.17.3
  - @cat-factory/caching@0.20.59
  - @cat-factory/observability-langfuse@0.11.25
  - @cat-factory/provider-cloudflare@0.7.517

## 0.204.0

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
  - @cat-factory/binary-generators@0.3.24
  - @cat-factory/consensus@0.17.24
  - @cat-factory/eks@0.1.363
  - @cat-factory/gates@0.11.24
  - @cat-factory/gitlab@0.22.24
  - @cat-factory/observability-otel@0.23.17
  - @cat-factory/prompt-fragments@1.1.20
  - @cat-factory/spend@0.17.2
  - @cat-factory/caching@0.20.58
  - @cat-factory/observability-langfuse@0.11.24
  - @cat-factory/provider-cloudflare@0.7.516

## 0.203.0

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
  - @cat-factory/binary-generators@0.3.23
  - @cat-factory/consensus@0.17.23
  - @cat-factory/eks@0.1.362
  - @cat-factory/gates@0.11.23
  - @cat-factory/gitlab@0.22.23
  - @cat-factory/observability-otel@0.23.16
  - @cat-factory/prompt-fragments@1.1.19
  - @cat-factory/spend@0.17.1
  - @cat-factory/caching@0.20.57
  - @cat-factory/observability-langfuse@0.11.23
  - @cat-factory/provider-cloudflare@0.7.515

## 0.202.0

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
  - @cat-factory/spend@0.17.0
  - @cat-factory/binary-generators@0.3.22
  - @cat-factory/consensus@0.17.22
  - @cat-factory/eks@0.1.361
  - @cat-factory/gates@0.11.22
  - @cat-factory/gitlab@0.22.22
  - @cat-factory/observability-otel@0.23.15
  - @cat-factory/prompt-fragments@1.1.18
  - @cat-factory/caching@0.20.56
  - @cat-factory/observability-langfuse@0.11.22
  - @cat-factory/provider-cloudflare@0.7.514

## 0.201.13

### Patch Changes

- 0f426b3: Refresh the dependency tree and the bundled agent CLIs.
  
  **Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the
  newest release each declared range already admits, under the `minimumReleaseAge` gate:
  
  - **Direct**: `ai@^7.0.84 → ^7.0.85`, `@ai-sdk/anthropic@^4.0.45 → ^4.0.46`,
    `@ai-sdk/openai@^4.0.51 → ^4.0.52`, `@ai-sdk/openai-compatible@^3.0.40 → ^3.0.41`,
    `@ai-sdk/provider@^4.0.8 → ^4.0.9`, `@ai-sdk/amazon-bedrock@^5.0.67 → ^5.0.68`,
    `happy-dom@^20.11.15 → ^20.12.0`, `pg-boss@^12.28.1 → ^12.29.0`,
    `layered-loader@^16.1.0 → ^16.1.1`. The whole `@ai-sdk` line and `ai` were named as
    age-blocked by the previous round and have now aged past the window. `layered-loader`
    16.1.1 is 23 hours old and would miss it, but the package is ours and sits on
    `minimumReleaseAgeExclude`, which is exactly the case that list exists for.
  - **Transitives the re-resolve moved**, 32 resolved entries added against 32 removed:
    `zod@4.5.2 → 4.5.4`, `@ai-sdk/gateway@4.0.68 → 4.0.69`,
    `@ai-sdk/provider-utils@5.0.33 → 5.0.34`, `qs@6.15.3 → 6.16.0`,
    `serialize-javascript@7.1.0 → 7.1.1`, `type-fest@5.8.0 → 5.9.0`, `ignore@7.0.6 → 7.0.7`,
    `electron-to-chromium@1.5.416 → 1.5.417`.
  
  The tree is structurally unchanged: 1434 distinct names and 1967 resolved entries on both
  sides, with no name added and none removed. The two-`zod` split the previous round introduced
  holds along the same seam: `@cloudflare/vitest-pool-workers` keeps its hard-pinned `4.4.3` for
  its own config validation, and every app-reachable consumer (the AI SDK family,
  `@modelcontextprotocol/sdk`, `drizzle-orm`) moves to `4.5.4` together, so a schema built in one
  module is still read by the same identity in another.
  
  **The agent CLIs**: Claude Code `2.1.251 → 2.1.252` and Codex `0.151.0 → 0.152.0`, both taken
  at their newest under the Dockerfile's standing exemption from the age window (2.1.252 is 17
  hours old, 0.152.0 is 8). That exemption covers exactly those three pins and is an explicit
  call re-made on each bump. Pi is already newest at `0.84.4`, as are both Pi extensions at
  `2.8.0`, and the extensions are held to the ordinary window regardless.
  
  The executor image tag rolls to `1.145.0` for the two CLI pins, because republishing over a
  live tag does not roll a deployment out. The deploy image is untouched at `0.6.1`: nothing
  under `backend/internal/deploy-harness/` moved.
  
  **Held back by the age window rather than by a compatibility call**, and takeable next round:
  `ai@7.0.87` with `@ai-sdk/openai@4.0.53` and `@ai-sdk/amazon-bedrock@5.0.69` beside it (all
  published late on 2026-08-31), `@aws-sdk/client-s3@3.1123.0`, `knip@6.34.0`, `undici@8.10.1`,
  and the OpenTelemetry line (`@opentelemetry/sdk-*` and `resources` at 2.11.0, the two OTLP
  exporters at 0.222.0).
  
  **Held by a deliberate call**, unchanged: `wrangler` stays at `4.124.0` and
  `@cloudflare/workers-types` at `5.20260815.1` for the sixth round running, because
  `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins that exact
  wrangler, and the types are derived from the `workerd@1.20260815.1` it brings. `4.127.1` is
  available and would split the runtime the tests prove from the runtime that ships. Drizzle
  stays at `1.0.0-rc.4`: still only per-commit `rc.5` snapshots. The frontend layer stays on
  `typescript@^6.0.3` while the rest of the tree is on `7.0.2`, which is why sherif ignores that
  name. The `node:26-trixie-slim` base digest and the `searxng` tag in the local compose stack
  are both already the newest published.
- Updated dependencies [0f426b3]
  - @cat-factory/agents@0.146.6
  - @cat-factory/caching@0.20.55
  - @cat-factory/consensus@0.17.21
  - @cat-factory/integrations@0.166.22
  - @cat-factory/kernel@0.323.2
  - @cat-factory/orchestration@0.290.2
  - @cat-factory/provider-cloudflare@0.7.513
  - @cat-factory/binary-generators@0.3.21
  - @cat-factory/server@0.307.9
  - @cat-factory/eks@0.1.360
  - @cat-factory/gates@0.11.21
  - @cat-factory/gitlab@0.22.21
  - @cat-factory/observability-langfuse@0.11.21
  - @cat-factory/observability-otel@0.23.14
  - @cat-factory/prompt-fragments@1.1.17
  - @cat-factory/spend@0.16.26

## 0.201.12

### Patch Changes

- 332ef26: Refresh the dependency tree, the agent CLIs and the local web-search image.
  
  **Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the
  newest release each declared range already admits, under the `minimumReleaseAge` gate:
  
  - **Direct**: `ai@^7.0.83 → ^7.0.84`, `@ai-sdk/anthropic@^4.0.44 → ^4.0.45`,
    `@ai-sdk/openai@^4.0.50 → ^4.0.51`, `@ai-sdk/openai-compatible@^3.0.39 → ^3.0.40`,
    `@ai-sdk/amazon-bedrock@^5.0.66 → ^5.0.67`, `@aws-sdk/client-s3@^3.1120.0 → ^3.1121.0`,
    `happy-dom@^20.11.12 → ^20.11.15`, `knip@^6.32.3 → ^6.33.0`, `pg-boss@^12.28.0 → ^12.28.1`.
    Every one of these was named as held back by the age window in the previous round and has now
    aged past it.
  - **Transitives the re-resolve moved**, 42 resolved entries added against 43 removed:
    `oxc-parser@0.143.0 → 0.147.0` with its 19 platform bindings, `@ai-sdk/gateway@4.0.68`,
    `@ai-sdk/provider-utils@5.0.33`, `express-rate-limit@8.7.0`, `fastq@1.20.3`,
    `formatly@0.3.0 → 0.7.0` (knip's own range), `ip-address@10.7.0`, `json-rpc-2.0@1.8.0`,
    `open@11.0.2`, `powershell-utils@0.2.1`, `pretty-bytes@7.1.2`, `pretty-ms@9.3.1`,
    `@iconify/collections@1.0.730`.
  
  The tree stays at 1387 distinct names on both sides, and 1614 resolved entries becomes 1613:
  `@oxc-project/types` collapses from three copies to two and `get-tsconfig` from two to one, while
  `zod` gains a second.
  
  **That second `zod` is deliberate and is worth knowing about**, because a duplicated singleton is
  usually a bug here. No workspace package declares `zod`, so every copy of it fills an
  auto-installed optional peer slot, and until now the exact `zod@4.4.3` that
  `@cloudflare/vitest-pool-workers@0.22.0` pins as a hard dependency was the only version in the
  tree, which dragged every other consumer onto it. `zod@4.5.2` has now aged past the window, so the
  peer slots take it and the pool's pin no longer speaks for the whole graph. The split is along a
  seam nothing crosses: `4.4.3` is reachable only from the vitest pool, which uses it to validate its
  own config, and everything app-reachable (the AI SDK family, `@modelcontextprotocol/sdk`,
  `drizzle-orm`) moves to `4.5.2` together, so there is still exactly one `zod` identity in every
  place a schema is built in one module and read in another. Do not "fix" this with a top-level
  override pinning `4.4.3`: that would freeze the whole tree on a decision that belongs to the test
  pool, which is the mistake the `wrangler` note in `pnpm-workspace.yaml` exists to prevent.
  
  **Held back by the age window rather than by a compatibility call**, and takeable next round:
  `ai@7.0.85` and the whole `@ai-sdk` line beside it (`anthropic@4.0.46`, `openai@4.0.52`,
  `openai-compatible@3.0.41`, `amazon-bedrock@5.0.68`) were all published about six hours ago, and
  `happy-dom@20.12.0` misses by two and a half hours.
  
  **The agent CLIs**: Codex `0.150.1 → 0.151.0`, and both Pi extensions `2.7.1 → 2.8.0`. Pi
  (`0.84.4`) and Claude Code (`2.1.251`) are already at their newest. The Dockerfile's standing
  exemption that lets the three CLI pins run ahead of the age window is not exercised this round:
  every version taken here has aged past it on its own, the extensions included, which is the rule
  they are held to anyway.
  
  The executor image tag rolls to `1.144.0` for those pins, because republishing over a live tag does
  not roll a deployment out. The deploy image is unchanged and stays at `0.6.1`: nothing under
  `backend/internal/deploy-harness/` moved, and its `kubectl`/`kustomize`/`helm` pins are managed
  deliberately rather than swept (`kubectl` has a `v1.37.0` available against the pinned `v1.36.4`,
  which is a call for its own change).
  
  **The `searxng` image in the local compose stack takes `2026.8.29-d226b78bc`**, 29 hours old, after
  holding two rounds at `2026.8.22-9fea41204` for tags that kept landing an hour or two short of the
  window. The `node:26-trixie-slim` digest both runner Dockerfiles pin does not move: the tag still
  resolves to `sha256:c0753125` (Node 26.8.1), unchanged since 2026-08-27.
  
  **Standing holds, restated so the next round need not re-derive them**: `wrangler` and
  `@cloudflare/workers-types` do not move for the fifth round running, because
  `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins `wrangler@4.124.0`
  exactly, and the types version is the workerd date that pin resolves to. `drizzle-orm` and
  `drizzle-kit` stay at `1.0.0-rc.4`: the only newer publishes are per-commit `rc.5` snapshots, not a
  release to pin against. The frontend keeps `typescript@^6.0.3` against the root's `7.0.2` because
  `vue-tsc@3.3.11` is what pairs with it, so moving it is a Nuxt-toolchain decision rather than a
  sweep. The Java SDK moves nothing: jackson, junit, jspecify and every build plugin are already at
  their newest stable on Maven Central, and Go and Python have no dependencies by design.
- Updated dependencies [332ef26]
  - @cat-factory/agents@0.146.5
  - @cat-factory/consensus@0.17.20
  - @cat-factory/integrations@0.166.21
  - @cat-factory/kernel@0.323.1
  - @cat-factory/orchestration@0.290.1
  - @cat-factory/provider-cloudflare@0.7.512
  - @cat-factory/binary-generators@0.3.20
  - @cat-factory/server@0.307.8
  - @cat-factory/eks@0.1.359
  - @cat-factory/caching@0.20.54
  - @cat-factory/gates@0.11.20
  - @cat-factory/gitlab@0.22.20
  - @cat-factory/observability-langfuse@0.11.20
  - @cat-factory/observability-otel@0.23.13
  - @cat-factory/prompt-fragments@1.1.16
  - @cat-factory/spend@0.16.25

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
