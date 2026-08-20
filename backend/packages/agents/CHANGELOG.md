# @cat-factory/agents

## 0.140.0

### Minor Changes

- 9d4b0c2: Stop telling agents things that are not true of the run they are on.

  Four findings the platform's own Kaizen graders filed repeatedly, all of them the same shape: a
  prompt asserting a fact about the dispatch that the dispatch did not deliver.

  - The best-practice-standards imperative ("treat every standard appended below as a hard
    requirement") was the closing line of seven prompt files, while the fold appends nothing when a
    block resolved no standards. It now belongs to the standards section itself, so the pointer and
    its target arrive together or not at all. The reviewer companion's adherence guidance was the
    same dangling pointer worded the other way round ("folded into this prompt above"); it is a JSON
    output contract rather than a standards header, so it could not move into the fold and is instead
    worded to be true whether or not anything was folded. `build` bumps to v7 and `review` to v3.
  - The read-only guardrail forbade creating files while the effort-report guidance, appended to every
    container dispatch, ordered one written "after any commit/push" on a step forbidden to commit. The
    carve-out naming `.cat-effort.json` as the one permitted write now rides the effort report, which
    is the half of the pair that reaches every container kind: a carve-out in the guardrail could not
    reach `merger` or `on-call`, whose prompts bypass `systemPromptFor`, and would have promised a
    working directory to the inline consensus participants that share that seam. The guardrail states
    only what the agent may do, since a read-only step's output can still be committed by a backend
    post-op (`spike`).
  - Container agents are now told what the execution environment can and cannot do: no cluster or
    registry credentials from the platform, every tool probed rather than assumed, and toolchain
    versions that are the environment's rather than the target's. Above all, that an artifact this
    environment cannot execute is not incomplete for that reason, reported in one line. It names no
    environment, because the same job body serves both the harness image and the local native
    transport, and it stops short of calling an unverifiable artifact correct: the same paragraph
    reaches the reviewers.
  - A companion round whose rating cleared the bar but which a `blocker` held back rendered to the
    next round as "did not meet the bar", asserting a comparison the engine never made. The bar
    comparison and the disposition are now two facts, with the reason named when they disagree, in
    both directions: a round advanced on a rating below the threshold no longer reads as having met
    it either.
  - The prompt editor's "what the platform appends to whatever you save" is measured from the wire
    rather than from one seam. The sandbox contract and the effort report are appended after
    `systemPromptFor` has run, so a workspace editing a `coder` prompt was shown a directive list
    ~2.3 KB shorter than the dispatch sends. They are now declared as one ordered pair
    (`CONTAINER_DISPATCH_DIRECTIVES`) that both the dispatch and the measurement read.

## 0.139.1

### Patch Changes

- 3db0d43: Refresh the whole dependency tree, re-roll both runner images, and move the three bundled agent CLIs.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
  newest release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.64 → ^7.0.68`,
    `@ai-sdk/anthropic@^4.0.38 → ^4.0.39`, `@ai-sdk/openai@^4.0.41 → ^4.0.43`,
    `@ai-sdk/openai-compatible@^3.0.30 → ^3.0.31`, `@ai-sdk/amazon-bedrock@^5.0.55 → ^5.0.58`.
  - **Runtime deps**: `hono@^4.13.1 → ^4.13.3`, `@hono/node-server@^2.1.0 → ^2.1.1`,
    `jose@^6.2.8 → ^6.2.9`, `capnweb@^0.11.0 → ^0.11.1`, `@aws-sdk/client-s3@^3.1109.0 → ^3.1113.0`.
  - **Tooling**: `wrangler@^4.122.0 → ^4.124.0`,
    `@cloudflare/workers-types@^5.20260812.1 → ^5.20260819.1` (which is what wrangler 4.124 now
    peer-requires), `@cloudflare/vitest-pool-workers@^0.21.2 → ^0.22.0`, `vitest@^4.1.10 → ^4.1.11`,
    `@vitest/coverage-v8@^4.1.10 → ^4.1.11`, `oxlint@^1.78.0 → ^1.79.0`, `oxfmt@^0.63.0 → ^0.64.0`,
    `publint@^0.3.23 → ^0.3.24`, `turbo@^2.10.9 → ^2.10.11`, `vue-tsc@^3.3.9 → ^3.3.10`,
    `@types/pg@^8.21.0 → ^8.23.1`, pnpm `11.21.0 → 11.22.0`.

  **The three agent CLIs the executor image bundles** move together: Pi `0.84.1 → 0.84.2`, Codex
  `0.147.0 → 0.148.0`, Claude Code `2.1.231 → 2.1.237`. The Claude Code pin is taken at its newest
  release, ahead of the 24h `minimumReleaseAge` window, which is the explicit call that pin's own note
  asks to re-make on every bump. Pi's two extensions move in lockstep as their monorepo publishes
  them, `2.4.0 → 2.6.2`.

  **The UI-tester image** aligns its Playwright with the one the e2e suite drives (`1.61.1 → 1.62.1`),
  and moves `@yarnpkg/cli-dist@4.10.3 → 4.18.0` and `serve@14.2.5 → 14.2.6`. **The deploy image** takes
  `kubectl v1.36.3 → v1.36.4` and `helm v4.2.3 → v4.2.4`; kustomize is already current at `v5.8.1`.

  Both image tags therefore move in this change (`cat-factory-executor:1.127.0`,
  `cat-factory-executor-ui:1.127.0`, `cat-factory-deploy:0.2.14`): republishing over a live tag does
  not roll a deployment out.

  No `minimumReleaseAgeExclude` entries were added and none were needed: every registry bump above
  already clears the gate. Five packages had a newer release the gate still withholds
  (`@ai-sdk/*`, `ai@7.0.70`, `happy-dom@20.11.6`, `@aws-sdk/client-s3@3.1114.0`,
  `@cloudflare/workers-types@5.20260820.1`), so each lands one release short of the registry's head.
  `drizzle-orm`/`drizzle-kit` stay on `1.0.0-rc.4`: the only newer builds are commit-suffixed
  snapshots, not a released `rc.5`. Majors available but deliberately not taken here, each being its
  own change: `@changesets/cli@3`, `@stryker-mutator/*@10`, and TypeScript 7 for the two frontend
  packages still on 6.

- Updated dependencies [3db0d43]
  - @cat-factory/contracts@0.323.1
  - @cat-factory/kernel@0.314.1
  - @cat-factory/prompt-fragments@1.0.91

## 0.139.0

### Minor Changes

- 72ecc7c: Skills declare a group, and a review task can queue review skills onto its run.

  A `SKILL.md` may now declare `group:` (`build`, `review`, `test`, `write`, `plan`, `operate`,
  `other`), which is what lets a surface offer the part of the catalog that fits it. A manifest that
  declares nothing, or a value this build does not know, reads as `other`, and the account library
  shows the declared value beside it so the author can fix their frontmatter.

  A `review` task carries an ordered queue of `review`-group skills (`taskTypeFields.reviewSkillIds`,
  capped at 8), picked in the create-task form. The engine resolves them onto the reviewer's own
  skills at dispatch, so the harness installs a team's Performance Review or Security Review playbook
  exactly as it installs a `skill` step's pick, and each version is pinned on the step. Which agent
  receives the queue is the new `review-skills` trait, carried by `pr-reviewer`.

  A queued skill that has left the catalog FAILS the dispatch rather than being skipped: a review
  that quietly dropped the security lens it was asked for reads exactly like a clean one.

  The queue is editable after creation on the task inspector's review panel, which matters because a
  queued skill that has left the catalog fails every dispatch of that task: the failure names the
  task's queue as where to fix it, so that surface has to exist.

  Internal break: `AccountSkillRecord` gains a required `group`, and `account_skills` gains a
  `skill_group` column defaulting to `other` on both runtimes. Existing rows read as `other` until
  their `SKILL.md` is next edited, which is the same edit that gives the field a value. The public
  API's task-field table is unchanged.

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0
  - @cat-factory/prompt-fragments@1.0.90

## 0.138.0

### Minor Changes

- 5b281a3: Act on the first external-API sweep: three vendor surfaces had already moved, two more carry
  announced dates, and eight had drifted.

  **Broken.** Confluence page reads move to Cloud REST v2 (`GET /wiki/api/v2/pages/{id}`); the v1
  content endpoint they targeted was retired on 2025-04-30, and CQL search stays on v1 because v2
  publishes no search endpoint. incident.io enrichment posts to `POST /v2/actions`, an endpoint that
  exists, where `POST /v2/incident_updates` never has at any version: the investigation lands as an
  unassigned action on the live incident rather than a status-page update (which would re-alert
  customers) or a follow-up (which is post-incident work). The MCP tool-server probe is now dual-era:
  revision `2026-07-28` deleted the `initialize` handshake, `notifications/initialized` and
  protocol-level sessions, so the probe opens in the modern stateless dialect and falls back to the
  handshake on a refusal that is not one of the three MCP-reserved error codes, or on any refusal
  naming a handshake-era revision. `server/discover`'s `supportedVersions` is negotiated onto rather
  than read and discarded, and the HTTP status is read before the body, so a 401 answered in JSON
  (the ordinary shape for an OAuth-protected server) is one refusal rather than two.

  **Dated.** The Langfuse sink is now the OTLP exporter pointed at Langfuse's OpenTelemetry endpoint;
  the batch ingestion API it used to speak is deprecated, sunsets on Langfuse Cloud on 2026-11-16, and
  its three event types are already unsupported on the v4 data model.

  **Drift.** Google userinfo reads from `openidconnect.googleapis.com/v1/userinfo`, the host Google's
  own discovery document publishes. Datadog monitor reads ask for `group_states=all` and fold
  `state.groups[*].last_triggered_ts` over the groups that are STILL ALERTING, so the
  post-release-health gate can once again tell a standing alert from one this release caused; the
  field it used to read is not in Datadog's schema, so the transition time was silently always
  absent, and the per-group timestamp outlives the group recovering, so folding it over every group
  would hand a week-old standing alert to whatever release a since-cleared blip landed after. Figma OAuth refreshes at `/v1/oauth/token`, which
  superseded `/v1/oauth/refresh`. The MCP authorization-server discovery walk drops an undocumented
  location, adds the OpenID Connect path-insert one, and enforces RFC 8414's issuer-equality check
  against a DECLARED issuer: in the origin fallback there is no published identifier to compare
  against, so the equality would refuse every deployment whose authorization server identifies as a
  fronted IdP or a tenant path. Linear rate limits are read off the error `code`, because Linear
  answers an exhausted quota with HTTP 400, and a setup check reports one as the new `rate_limited`
  verdict: the key is valid and the fix is to wait, which neither `auth_failed` nor a generic error
  says. The OTLP exporter reads `partialSuccess` instead of treating any 200 as full acceptance.
  GitLab 413s carry their own remedy. The Gemini image contract narrows `thinking_level` to the two
  values that exist, states the per-model reference-image split, and declares the 401 an invalid key
  really returns. The DeepSeek base URL drops an undocumented `/v1`.

  **Additive on the wire:** a task source's setup check can answer `rate_limited`, an eighth verdict
  in `taskSourceDiagnosticStatusSchema`.

  **Breaking for an embedder:** kernel's `GateContext` and `JudgeContext` now carry a required
  `logger`. Both are built by the engine (`makeGateContext`) and by `stubGateContext` /
  `stubJudgeContext` in tests, so a registered gate or judge needs no change.

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0
  - @cat-factory/prompt-fragments@1.0.89

## 0.137.1

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0
  - @cat-factory/prompt-fragments@1.0.88

## 0.137.0

### Minor Changes

- 4a3af5a: Close the mothership-mode repository surface: the VCS sync + repo-write half, service CRUD, the
  mount cascade and the last per-workspace reads all go remote, and the agent-kind registry's
  CAPABILITY layer becomes org state a node reads from the mothership.

  **The surface-completion backlog is empty, and the drift guard no longer has a word for it.** Every
  org/durable repository method is now either allow-listed or carries a PERMANENT classification;
  `pending` is gone from the guard's reason vocabulary, so a new repository method must be proxied or
  justified in the same PR rather than parked. What landed: the whole VCS installation + projection
  surface (reads AND the sync/repo-write writes a node's delegated GitHub client earns), service CRUD
  (a mothership-mode node could not create a service frame at all before this), the frame-deletion
  mount cascade, the Kaizen streak write and detail read, the workspace roster reads, the profile
  edit and the sealed test-credential list.

  **Three new scope rules, one of which closes a real cross-tenant hole.** `serviceInsert` binds the
  FRAME BLOCK a service claims (admitting one that does not exist yet, since the service row is
  written first), because `getByFrameBlock` resolves by frame block id alone and a service planted on
  another org's frame redirects that org's runs at a repo the caller controls. `serviceUpdate` and
  `workspaceList` bind the account a patch would re-home a service into, and the candidate list a
  repo-linkage read answers a subset of.

  **The VCS connect/disconnect WRITES stay mothership-internal**, classified `admin` alongside the
  membership and account-lifecycle mutations. They are `integrations.manage` in the service layer, and
  a machine token scopes accounts rather than roles: a plain member of an account holds one, so no row
  binding substitutes for the role check the RPC bypasses. Neither connect path can complete on a node
  regardless (App connect needs an app-JWT call the delegating token source refuses by design; a
  GitLab PAT would be sealed under the node's own key). The id-keyed READS are remote as before.

  **`WorkspaceRepository.accountIdsOf`** is a new batched port method (chunked `IN`, both stores): the
  list-shaped scope rules bound a whole candidate list through a point read per id, which is the N+1
  this layer bans.

  **Six dead port methods are deleted rather than proxied**: the single-service `listByService` on
  five repositories (board composition has gone through the batched `listByServices` for as long as
  the allow-list has existed), `serviceRepository.getByRepo`, `githubInstallationRepository`'s
  `updateCachedToken` (nothing has written that column since the App token cache moved in-process),
  and the unused `DrizzleServiceFrameRepository`. Allow-listing a method no caller invokes buys
  attack surface for nobody.

  The deployment-level tool-server layer travels as the WHOLE declaration set (`DeclaredToolServers`),
  not only its resolved servers: an id the mothership could not resolve is a typo in the org's own
  package, and a node boot-validates nothing it reads remotely, so the dispatch warn is the only place
  it can surface. The union of the local registry and that layer is one exported helper both dispatch
  sites use (the container executor and a consensus panel's withheld-server ceiling).

  **`GET /internal/agent-kinds`** makes the deployment's agent-kind capability layer org state, the
  fourth application of the rule its three siblings established. Unlike them it MERGES with the
  node's own registry rather than replacing it: a kind's executable half (prompts as functions,
  `preOps`/`postOps`, its output parser) cannot cross a wire, so the kind CATALOG stays node-local
  exactly like task types and pipelines, and a step naming an unknown kind still fails loudly at
  admission. What crosses is `assignSkills`/`assignToolServers` (a `SKILL.md` payload, a transport
  plus a credential's NAME), whose absence on a node one build behind is silent: the agent simply
  works without the org's playbook, which reads exactly like an agent that considered the standard
  and moved on. A failed read THROWS rather than answering with an empty layer.

  **Compatibility (internal):** `githubInstallationRepository.updateCachedToken`,
  `serviceRepository.getByRepo` and the five `listByService` methods are removed from their kernel
  ports and both runtimes. Nothing in the tree called them; a deployment that implemented these ports
  itself drops the members. `WorkspaceRepository` gains a required `accountIdsOf`, so such a
  deployment implements one method.

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0
  - @cat-factory/prompt-fragments@1.0.87

## 0.136.0

### Minor Changes

- cda15b8: Widen the Sandbox: more agent kinds, rubrics that match the task, and a repo-scale review fixture.

  Every cell now renders its task input through the SAME pure prompt builder its production caller
  uses, instead of a hand-rolled approximation that dropped each prompt's output contract and scope
  rules. `@cat-factory/agents` gains `composedSystemPromptFor`, the one place that decides
  bespoke-vs-composed prompt assembly (container dispatch and the Sandbox both ride it), and the
  Sandbox baseline text is now the promotable `shippedBasePromptFor` unit rather than
  `PROMPT_VERSIONS[id].text`, which for an inline engine kind is the already-composed prompt.

  The `task-estimator`'s JSON output contract is now the named `TRIAGE_JSON_CONTRACT` and an
  `OVERRIDE_PRESERVED_FRAGMENTS` member, so a per-workspace override (or a promoted Sandbox
  candidate) can no longer delete the shape `coerceTaskEstimate` parses. An unedited prompt is
  byte-identical.

  Four new rubrics (`architecture-review`, `bug-triage`, `estimation`, `answer-recommendation`); two
  new testable kinds (`task-estimator`, `requirements-writer`) with their fixtures; and a repo-scale
  multi-file code-review fixture delivered through `injectedContextFiles`.

  Breaks internal shapes, per the pre-1.0 rule for everything the public API does not cover:

  - `SandboxAgentKindMeta` / the `/sandbox/overview` response replace the single `bucket` field with
    `bucket` (production surface) plus `sandboxRun` and `unsupportedReason`. The last is a bounded
    reason CODE (`sandboxUnsupportedReasonSchema`), not prose: the backend refusal and the SPA's
    translated note are both derived from it. Stored fixtures, experiments and prompt candidates are
    unaffected.
  - The builtin fixture library is now reconciled against the shipped catalog on every read rather
    than seeded once when a workspace has none, so a workspace that used the Sandbox before a release
    picks up that release's fixtures. A builtin row whose content has drifted from the catalog is
    refreshed in place; workspace-authored fixtures are never touched.
  - `clarity-review` and `architect-companion` grade on new rubrics, so their dimension keys change.
    Grades recorded before this change carry the old keys and are no longer comparable with new ones;
    re-launch an experiment to re-grade it.
  - A Sandbox prompt candidate cloned from the `requirements-review`, `clarity-review` or
    `requirements-writer` baseline before this change contains the directives half of its prompt.
    Re-clone it rather than promoting it, or promotion doubles those directives.

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0
  - @cat-factory/prompt-fragments@1.0.86

## 0.135.0

### Minor Changes

- 3afea3a: Let a foundational service declare the credentials a step authenticates to it with, resolve the
  binary-storage precondition from the step rather than the kind, record what post-processed an
  artifact, and publish the pipeline-authoring seam from every facade.

  **A foundational service registered IN CODE may declare `credentials`**, the same
  `capabilityCredentialSchema` a generative integration and an MCP tool server declare. The engine
  projects the declarations of the services a dispatch was briefed on onto
  `AgentRunContext.foundationalCredentials` (key names only), `@cat-factory/server` resolves the
  values through the facade-wired `ToolSecretResolver`, and the brief names the variable from the
  same helper the resolver keys the job body with. `ToolSecretSubject` gains
  `foundational-service`, and the credential CHECKLIST lists the new declarer beside the other two.
  Until now the platform had a credential seam for what MAKES an artifact and none for where it GOES,
  so a step could authenticate to eight vendors and then not to the service it had to store the
  result in.

  **Only the code-registered `builtin` tier may declare one.** The stored write boundary refuses a
  credential on an account or workspace row (`foundational_service_credentials_not_storable`),
  because the shipped resolver reads a declared key off the deployment's own environment: every other
  declarer on the platform is deployment code, and a foundational service is the first one a
  workspace admin can also create over REST. Per-workspace VALUES are unaffected, which is what the
  sealed capability-credential store is for.

  **Breaking, internal wire**: the job body's `generatorSecrets` is now `capabilitySecrets`, since
  two producers share the channel, and the two resolvers became one so that a variable-name conflict
  BETWEEN a generative integration and a catalog service is caught where it is visible (per job, and
  now at boot as `capability_injection_name_collision`). The runner image bumps with it; a deployment
  must roll the new tag before a credential of either kind reaches a job.

  **The `binary-storage` precondition is resolved per STEP.** A kind carrying the trait is held to
  the account's content storage only when its `binaryOutput.storageServiceId` is the platform's own
  asset service (`storesThroughPlatformAssets`, the same fact the in-container upload seam reads).
  `media-generator` on the shipped `pl_media` still demands it; the same kind repointed at an org's
  object service no longer is, where before the refusal named a settings page unrelated to anything
  the run touched. `tester-ui` makes no step-level selection and is unchanged.

  **`binaryOutputArtifact.processedBy`** records what ran over the bytes AFTER the integration
  produced them. A post-processed artifact has two producers and `generator` can name only one:
  naming the integration records a producer of something that is not what was stored, and naming
  nothing loses the vendor attribution. A free string, judged by whoever reads the run, on the same
  terms as `location`.

  **Every facade now exports the pipeline-authoring seam**: `definePipeline` (extracted from the
  built-in catalog, which is authored with it) plus `MEDIA_GENERATOR_AGENT_KIND`,
  `PLATFORM_ASSET_STORAGE_SERVICE_ID`, the two binary traits, the reserved capability tags and the
  option types. A deployment replacing a shipped preset was writing five index-aligned arrays by
  hand, and naming what its step selects meant either a copied string literal or a second dependency
  below the facade.

  **An agent kind can name its OWN container image.** The variant is a slug rather than a
  three-member union: `ui` stays the platform's browser image, and anything else is a deployment's,
  mapped by its runner backend (a Kubernetes pool's `imageVariants`, local Docker's
  `LOCAL_HARNESS_IMAGE_VARIANTS`, a Cloudflare `[[containers]]` class bound as
  `RUNNER_CONTAINER_<VARIANT>` and subclassing the newly-exported `RunContainer`). Boot refuses a
  kind naming `default` or `deploy`, or a name that is not a slug; a backend with no image for a
  variant refuses the dispatch rather than running the default, which for a deployment's own image
  would produce a job silently missing whatever it carried.

  **Bug fix**: the Kubernetes runner pool keyed its pod by run id alone, so a `tester-ui` step
  re-attached to the pod an earlier step created on the base image and ran browser work without a
  browser. It now keys by `containerKeyForRef`, like the Cloudflare and local backends.

  **The open variant name keeps its compile-time guard.** `PLATFORM_IMAGE_VARIANTS` is a literal tuple
  exporting a `PlatformImageVariant` union, `isPlatformImageVariant` narrows to it, and all three
  backends split on that predicate and then switch EXHAUSTIVELY over the platform half. Opening the
  type cost the `never` arm that used to make a new variant fail the build, and the three backends had
  respelled the platform names inline: a fourth published image would have routed into the
  deployment-owned half and been refused as unwired on the one runtime that ships it (the Kubernetes
  pool would have served it the DEFAULT image silently), with nothing failing at compile time.

  **A container key is refused if it cannot be read back** (`container_key_not_reversible`), and the
  Apple `container` adapter refuses a container NAME the same way. Recovering the run behind a key is a
  shape test, because variant names are open and the reader holds no config, so it cannot decide a run
  id whose leading segment is itself a legal variant name: it splits to a run that does not exist, and
  the orphan sweep then deletes a live container. Only the producer can compare against the ref, so
  that is where the check lives. Nothing the platform mints today can trip it; on Apple it also catches
  the name sanitiser collapsing two distinct keys onto one name.

  **A credential injection-name collision is reported ONCE, over every capability registry.** The rule
  moved to contracts (`credentialInjectionCollisions`, beside the injection-name fallback it is about)
  and boot grades it in one section. It was graded per registry as well, so a generator-vs-generator
  pair produced two problems under two codes with two remediations for one variable, while a
  service-vs-service pair was graded by neither, and the cross-registry rule needed BOTH registries
  wired to run at all.

  **Internal break**: the boot-diagnostic code `binary_generator_injection_name_collision` is retired,
  along with kernel's `binaryGeneratorInjectionCollisions`. Every collision is now
  `capability_injection_name_collision`. These are boot log diagnostics, nothing persists or parses
  them, and the message names the same variable and claimants as before.

  **A CONTEXT service's credentials are named to the agent**, in the binary-output brief's scope
  section and in its injected contract file, the way storage's already were. `briefedServiceIds`
  resolves credentials for both id sets, so a context service's value was in the job env while no
  layer named the variable holding it: a bearer-authenticated contract the agent could not call.

  **Fixes** the local facade's harness pins, which stayed at 1.124.0 while the harness went to 1.125.0
  and the job body's `generatorSecrets` became `capabilitySecrets`, so a local install on the default
  pin ran an image that ignored the field and dropped every capability credential. The tag guard now
  verifies EVERY pin location in `scripts/runner-images.mjs`, not just the two under `deploy/backend`.

  **`LOCAL_HARNESS_IMAGE_VARIANTS` names are held to the slug shape** every declaring boundary
  enforces, and a rejected entry is named in a boot warning. `Pixel-Tools=…` parsed into the map,
  matched no declaration a kind could have made, and the dispatch was then refused pointing at the
  variable the operator had already set it in.

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0
  - @cat-factory/prompt-fragments@1.0.85

## 0.134.0

### Minor Changes

- 3f7d8b2: Support Bifrost as an AI gateway, and make the OpenAI-compatible provider set one table both
  runtimes derive from.

  `bifrost` joins the workspace API-key pool and the model catalog (`bifrost-default`) as the second
  operator-hosted gateway beside LiteLLM: self-hosted software with no public instance, so it is
  proxyable and key-poolable but resolves only once the deployment sets `BIFROST_BASE_URL`. Until then
  its pooled key is inert and its catalog entry reads `available: false`, rather than passing the start
  guard and failing at dispatch. Its catalog default is `openai/gpt-4o`, a real id on any Bifrost whose
  OpenAI provider is configured, because Bifrost names models by their canonical `provider/model` pair
  rather than by operator-coined aliases.

  **The seam it landed through.** `OPENAI_COMPATIBLE_ENDPOINTS` (`@cat-factory/agents`
  `providers/endpoints.ts`) is now the ONE table naming every OpenAI-compatible provider and the
  endpoint it defaults to, `null` marking an operator-hosted one. Everything else is derived from it:
  the built-in base URLs, `UI_CONFIGURABLE_DIRECT_PROVIDERS`, `isProxyableProvider`, the new
  `isOpenAiCompatibleProvider` / `isOperatorHostedGateway` predicates, and the `OperatorHostedGateway`
  union that the base-URL remedy's display names are an exhaustive `Record` over. Adding a provider is
  one entry there, and the compiler finds the rest.

  **Four facade gaps that closed with it**, every one of them silent before:

  - The Node LLM-proxy upstream kept its own provider→env table, which omitted `xai`. A Pi step
    pinned to Grok-direct passed the dispatch guard (`isProxyableProvider('xai')` is true) and then
    failed as "upstream not available". That table is gone; the upstream resolves through
    `baseUrlForNode`, the same resolution the inline path takes.
  - `workers-ai` was the SAME bug from the other side: the dispatch guard is runtime-neutral and
    admits it everywhere, the catalog offers every Cloudflare model once the REST credentials are set,
    and only the Worker (which has the `AI` binding) had a route. A container step on Node died at its
    first proxy call with "Provider 'workers-ai' is not available". Node now forwards it to
    Cloudflare's own OpenAI-compatible endpoint, carrying the account token on the resolved endpoint
    because `workers-ai` owns no pooled key. The proxy prefers an in-process route and falls back to
    the forward path, reporting the provider unavailable only when neither resolves.
  - The Worker's typed env override map was a loose `Record<string, …>` and omitted `xai` too, so the
    documented `XAI_BASE_URL` was consumed by neither facade. It is now total over the shared
    `DirectProvider` union, so a provider missing from it is a type error.
  - That union is the direct providers, not just the OpenAI-compatible ones, which closes
    `ANTHROPIC_BASE_URL`: Node reads env by name and always honoured it, the Worker never declared it.
    The container proxy still refuses `anthropic` (its own SDK dialect would reject an OpenAI-shaped
    body), and refuses it by the table's predicate rather than by "did a base URL resolve", those two
    answers now differing for exactly that provider.

  **Metering**: the shipped `bifrost-default` entry routes `openai/gpt-4o`, so it is priced at that
  model's own direct rate rather than the generic gateway fallback, which would have under-counted it
  about sixteenfold against a workspace budget.

  **For operators**: `BIFROST_BASE_URL` is new (CF + Node). `XAI_BASE_URL` now actually takes effect on
  the Worker, and `ANTHROPIC_BASE_URL` on the Worker at all: a deployment that set either expecting a
  regional or proxied endpoint was silently reaching the public API and will now reach what it
  configured. Both, plus the rest of the `${VENDOR}_BASE_URL` family, are documented in
  `docs/environment-variables.md` and reserved against being named as a capability credential, which
  they were not before. `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` is now read in one place on
  Node, so a whitespace-only value counts as unset everywhere instead of enabling the picker only.

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0
  - @cat-factory/prompt-fragments@1.0.84

## 0.133.3

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0
  - @cat-factory/prompt-fragments@1.0.83

## 0.133.2

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0
  - @cat-factory/prompt-fragments@1.0.82

## 0.133.1

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0
  - @cat-factory/prompt-fragments@1.0.81

## 0.133.0

### Minor Changes

- eb5fa75: Add a built-in `media` task type, so generating images (or 3D models, audio, video) is a thing a
  fresh deployment can do rather than a feature it has to build.

  The binary-output machinery already did the hard part: a generating step selects its integrations
  and its content types, an admission pass refuses a selection that cannot deliver them, a
  comparison parks the run so a person keeps the renders worth keeping, and the step's report
  records where every artifact went. All of it was reachable only by a deployment that first
  registered an agent kind, an object store as a foundational service with an OpenAPI document, and
  a pipeline. This ships the defaults: a `media` task type and pipeline purpose, a `media-generator`
  agent kind, a `pl_media` preset with a working selection, and a storage target that exists
  everywhere.

  That target is the platform's own asset storage, registered as the ONE service
  `defaultFoundationalServiceRegistry()` now holds (it returned an empty registry before). Its
  bytes land in the account's binary-artifact store, which a local deployment defaults to the
  filesystem, so an unconfigured laptop runs the whole flow; a deployment with no content storage
  at all is refused up front by the `binary-storage` precondition rather than at the end of a paid
  generation. A deployment that stores assets in its own bucket registers its own service and
  tombstones this one, exactly as it can any other `builtin`.

  Because the platform holds those bytes, it can serve them back: a stored artifact renders in the
  comparison window before the choice and in the step's report after it, with links to open it and
  to save a copy elsewhere. Whether a row renders as a picture is decided from the media type the
  SERVER served the bytes as, not from the optional one the producing agent declared, so an
  undeclared image still previews and a mislabelled bundle still reads as a file.

  Artifacts stored this way are a new `asset` artifact kind and are EXEMPT from the age-based
  retention sweep, which is sized for a run's screenshots and is the wrong clock for the thing the
  run was started to produce. The exemption is why the ingest API also takes an asset BACK: a
  candidate pass stages several files per subject and a person keeps one, and with nothing
  reclaiming an asset on a clock, the rejected renders would accumulate for the life of the
  workspace. `DELETE` on a location reclaims what the same run stored, idempotently.

  `pl_media` is also the first shipped pipeline whose step parks on a binary-candidate comparison,
  which public-API admission could not see: its four park checks read the step CHAIN, and a
  comparison lives in a step's OPTIONS. So a plain `write` key was admitted to start a run that then
  parked on a surface `/api/v1` cannot answer. `parkSurfacesOf` gains that fifth mechanism. Note the
  narrowing: a deployment that authored its own binary-output step with `comparison` and started it
  with a `write` key now gets `pipeline_requires_decide_scope` instead. That is the same disposition
  the human-wait gate and the interview gate each shipped with, and the behaviour it replaces is a
  run that hangs with nothing able to answer it.

  Four things to watch for. `GET /api/v1/runs/{runId}/artifacts` gains an `asset` member in its kind
  enum (public API 1.56.0, additive): a caller pairing screenshots against reference designs must
  filter it out rather than treat it as an unmatched capture. The foundational-services catalog is
  no longer empty by default, so a surface or test that assumed an unregistered deployment resolves
  zero services now sees one. And a single stored asset is capped at 24 MiB, sized by the Worker
  isolate's memory ceiling rather than by preference: the artifact store port takes bytes, so an
  ingest holds two full copies of the file at peak, and raising the cap needs the port and every
  blob backend behind it to take a stream.

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0
  - @cat-factory/prompt-fragments@1.0.80

## 0.132.1

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0
  - @cat-factory/prompt-fragments@1.0.79

## 0.132.0

### Minor Changes

- 7f990ea: Classify environment provisioning failures by cause, and repair the one class a checkout edit can
  actually fix. A provision whose `{{placeholder}}` cannot be filled by the environment CONNECTION is
  now refused BEFORE the apply, naming the field that fills it, rather than rendering an empty string
  and letting the platform reject the result and blame the file. A placeholder the RUN supplies keeps
  the documented lenient substitution, so a template folding an optional value into its output is
  unaffected. Adds a provider-neutral seam (`environmentFailure`, `unresolvedPlaceholders`,
  `describeUnfilledConfigPlaceholders`, and `ProvisionedEnvironment.reason` for a provider that
  reports a failure without throwing) so a deployment-registered environment backend participates in
  the same classification as the built-ins.

  On a `manifest_invalid` failure the `deployer` step now escalates to a new `deploy-fixer` agent,
  which pushes a fix onto the pull-request branch, and re-provisions against it (twice by default,
  configurable per step via `stepOptions.deployFix`). Every other cause takes the previous terminal
  path unchanged. When the budget is spent the run fails and raises a new `deploy_blocked`
  notification whose act retries the run, the `ci_failed` shape.

  The public API gains one additive notification type (`deploy_blocked`), so the OpenAPI surface moves
  to 1.55.0 and the four SDK clients regenerate. It is in the default webhook type set, and its act
  takes the same individual-usage-credential refusal `ci_failed` and `test_failed` already take.

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0
  - @cat-factory/prompt-fragments@1.0.78

## 0.131.0

### Minor Changes

- 409238f: Add GLM-5.3, Gemini 3.7 Flash and Grok 4.6 to the model catalog, and re-baseline the spend
  price table against what the providers currently charge.

  New catalog entries: `glm-5.3` (subscription-only, GLM Coding Plan), `gemini-3.7-flash`
  (OpenRouter) and `grok` (Grok 4.6, direct via a new `xai` provider or OpenRouter). GLM-4.7
  Flash gains a Bedrock flavour (`zai.glm-4.7-flash`).

  `xai` is a new direct provider: `XAI_API_KEY` joins the poolable key providers and the
  reserved-env-key list, `XAI_BASE_URL` overrides the endpoint, and `grok` joins the model
  family vocabulary the account model policy allows or blocks. A policy in `allowlist` mode
  does not admit the new family until an admin adds it, which is the intended default.

  Price corrections, several of which were metering runs BELOW their real cost: DeepSeek's V4
  pair moves to the peak rates its 2026-08-16 peak/off-peak switch introduces, the OpenRouter
  `deepseek/deepseek-v4-pro` alias nearly triples, and Cloudflare's now-published cached-input
  rates for GLM-5.2 and the Kimi pair replace a derived floor that was ~1.9x too low. GLM-5.2
  and Gemini 3.6 Flash on OpenRouter were overpriced and come down. Z.ai subscription refs
  (`zai:*`) were falling through to the generic default price and now carry Z.ai's list rate.

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0
  - @cat-factory/prompt-fragments@1.0.77

## 0.130.2

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0
  - @cat-factory/prompt-fragments@1.0.76

## 0.130.1

### Patch Changes

- d5c1f1c: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.64`,
  `@ai-sdk/openai@4.0.41`, `@ai-sdk/amazon-bedrock@5.0.55`). The Cloudflare toolchain moves
  together again: `wrangler@4.122.0` and `@cloudflare/vitest-pool-workers@0.21.2`, whose bundled
  wrangler tracks it. `@aws-sdk/client-s3` goes to 3.1109.0 and the SPA's store engine to
  `pinia@4.0.3` / `@pinia/nuxt@1.0.2`.

  `capnweb` moves 0.10.0 to 0.11.0 in the Gatekeeper Worker. The release is additive (stubs as
  stream chunks, exact ArrayBuffer/DataView serialization, URL over RPC) and touches neither
  `RpcTarget` nor `newWorkersRpcResponse`, the only two symbols we import. Its 0.11.1 patch, which
  enforces an ASCII-only dist bundle so a consumer's `btoa()` cannot choke on the runtime, missed
  the release-age window by two hours and is the first thing the next sweep should pick up.

  Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
  itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
  version above already satisfies the gate.

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0
  - @cat-factory/prompt-fragments@1.0.75

## 0.130.0

### Minor Changes

- 056e18d: Hold a run while a companion's MUST-FIX finding is open, whatever the rating said.

  A companion returned one number for a whole deliverable, and that number alone decided whether the
  run moved on. So a reviewer that found something genuinely unshippable — an unhandled failure mode,
  a requirement not met, a claim the work does not support — could still rate the change 0.9 against a
  0.8 bar and watch the pipeline advance past it. The urgency it meant was in the summary prose, in
  the `**Must fix**` group the prompt asked for, which is a channel only a person reads.

  Reviews are now GRADED. Each point a companion raises is its own `comments` entry carrying a
  `severity` of `blocker`, `major` or `minor` (the same three levels the prose groups named), and the
  verdict's two halves are read independently by kernel's new `disposeCompanionVerdict`: any open
  `blocker` reworks the producer whatever the rating, and the rating decides everything else. The
  `summary` becomes a short whole-verdict paragraph rather than a second copy of the list, matching
  what the judge prompt already does, since both are rendered together and a review written twice is
  two orderings that can disagree.

  **Spending the rework budget on a blocker parks for a person, and an unattended risk policy does not
  answer that park.** ADR 0053's rule is that a policy may take the "proceed anyway" a person would
  have been offered when an automatic loop reports it GAVE UP; a reviewer naming a must-fix is not
  that, so accepting the work anyway would be overruling a review nobody read. The distinction is a
  closed vocabulary (`CompanionParkReason`, the sibling of `JudgeParkReason`) rather than prose, and
  only `budget_spent` reaches the policy. The run panel's cap prompt states which of the two it is,
  because the person answering an unanswerable-by-policy park should know what they are being asked to
  overrule.

  That vocabulary is also what a loop stopped EARLY as unproductive (`companionLoopStalled`) now
  resolves against. Abandoning the rounds still on the budget takes the cap's park, so the reason is
  re-decided for the abandoned budget instead of being assumed to be a spent one: a standstill is the
  automation reporting that it gave up, an open `blocker` is not, and a stalled loop routinely carries
  both (the run that motivated the stall rule had two must-fix items open the whole way). So an
  unattended policy answers a stalled quality loop and still waits for a person on a blocked one.

  An out-of-vocabulary severity from a model reads as `major`, the same "unreadable severity reads as
  its safe default" rule the judge and PR-review findings use: the whole assessment is one parse, and
  an unparseable companion verdict fails the run, which is far worse than one point landing a level
  off. `major` and not either extreme, so a typo can neither manufacture a hard stop nor retire a real
  one. A comment with no severity at all (a person's "request changes" note, or one recorded before
  this existed) stays ungraded and never blocks.

  The findings now render. Each verdict card in the run panel lists them worst first with a severity
  badge beside each, which is new: `comments` were persisted and fed back into later rounds but shown
  to nobody, so the point holding a run was invisible to the person being asked to resolve it. Both
  sides of the rework loop read the grades too — the producer is told which comments are blocking and
  works them first, and a re-grading companion sees its earlier rounds' points labelled.

  **Every surface that a person or an integration answers this park from names the findings, because
  the summary no longer can.** With the prose groups gone, three places were reading the review out of
  a channel that stopped carrying it. The extra round a person grants at the cap loops the producer
  back with the verdict's graded `comments` attached, as the automatic rework path already did, so the
  round somebody just paid for names the points it is for. The `approval-gate` entry of
  `GET /api/v1/runs/{runId}/decisions` gains a `blockingFindings` array (spec `1.53.0`, additive), so a
  caller answering `resolve-exceeded` with `proceed` can read the must-fixes it would be overruling
  rather than inferring them from a verdict paragraph. And a companion's findings anchor to a
  structured item by id rather than by quoting prose, which the producer prompt was rendering against
  an empty target: an anchored point now names its item, and a point that anchors neither way is
  addressed to the proposal as a whole.

  **A first batch of nothing but nits no longer costs a round.** The rule that spends one round on a
  first review's findings asked only whether there were any, so a reviewer that followed its own
  instruction (a `minor` is "never worth holding anything for"), rated work above the bar and attached
  one polish note bought a full producer re-run plus a re-grading call. It now takes a point the
  reviewer did NOT call a nit, and the prompt states what each level costs so the grade decides
  something a reviewer can predict. An ungraded point still counts: its urgency is unknown rather than
  known to be low.

  The panel's verdict badge derives its `>=` / `<` glyph from the comparison rather than from
  `passed`, which are no longer the same fact: a round held by an open blocker fails at a rating that
  cleared its bar, and reading one off the other printed `95% < 80%` above the findings explaining it.
  The cap prompt's stalled wording drops its claim about the rating for the same reason.

  A severity read off a STORED row is narrowed through `isReviewCommentSeverity` rather than trusted:
  the schema's `major` fallback runs on the model reply, which is the only thing it parses, so a level
  retired from the vocabulary would reach an exhaustive `Record` and come back `undefined`. Such a
  value now sorts with the ungraded, carries no mechanical force, and is NAMED as unrecognised on the
  panel instead of being painted as a level nobody chose.

  `REVIEW_SUMMARY_LAYOUT` is replaced by `REVIEW_FINDINGS_LAYOUT`; a deployment appending the old
  constant to its own companion prompt should append the new one, and one relying on the shared
  companion prompt needs no change. Website: kibertoad/cat-factory-website#60.

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0
  - @cat-factory/prompt-fragments@1.0.74

## 0.129.2

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2
  - @cat-factory/prompt-fragments@1.0.73

## 0.129.1

### Patch Changes

- 0e1e0fa: Record what a subscription run actually spent, snapshot an inline agent's context, and stop a
  companion loop that has stopped converging.

  Five defects a Kaizen grading surfaced, of which the grader itself correctly diagnosed one.

  **Per-call output tokens were lost on every harness-served call.** Claude Code's `stream-json`
  `assistant` envelopes carry the message-START usage snapshot: the input and cache counts are final,
  `output_tokens` is the handful produced when the message opened, and `stop_reason` is null. The
  reconciliation against the terminal cumulative total was the intended rescue but guarded on whether
  ANY tokens had been reported, which the input side always satisfies, so it stood down and the output
  side stayed at the snapshot. Measured on a real board: a `coder` step recorded 198 output tokens
  against the 14,033 its terminal event reported, an `initiative-analyst` 531 against 30,471, with the
  input side matching exactly (which is what hid it). The shortfall is now computed PER SIDE, and it is
  filed as its OWN row standing for the job rather than added to the last captured turn: a turn grown
  by thousands of tokens it did not produce is a derived number that reads as a measured one on every
  surface showing per-call figures. It is also reconciled against the PARENT loop's calls alone, which
  matters in `ambientAuth` mode, where the CLI streams subagent turns onto the parent's stdout with no
  transcript watcher to own them: those turns were both hiding the shortfall and, being last,
  attracting it. Cost accounting was never affected; per-call telemetry, the observability panel,
  `/api/v1/debug/*` and the step rollups were.

  **A finish reason nobody reported is no longer recorded as `stop`.** Both subscription CLIs expose
  none, and three sites defaulted to `stop` anyway, which asserts the very thing a truncation check
  tries to disprove and made `finishReason === 'length'` unfireable on that whole path. Absent is now
  carried as absent, end to end — including through the AI SDK boundary, whose closed union has no
  "unknown" member, so its `other` placeholder with no vendor string behind it is read back as the
  absence it stands for rather than as a classification.

  **Inline agent kinds recorded no context snapshot at all.** `agent_context_snapshots` had exactly one
  producer, the container executor, so every companion and inline document kind was missing from it.
  The inline executor now files one through the same recorder, on both facades, and the dependency is a
  required key with a nullable value so a facade that forgets it fails to typecheck rather than
  silently recording nothing. The inline SERVICES that call `generateText` directly (the judges, the
  requirements reviewer, Kaizen's own grader) still file none; that is named in the code and the docs
  instead of being implied closed.

  **The Kaizen grader was fed two misleading figures**, and spent two of its six recommendations on
  defects that did not exist. Its digest summed `promptTokens` alone, which is FRESH input by
  definition, reporting 16 where the real input was 332,552; and it rendered a null finish reason as
  `unknown` beside a flat "Truncated calls: 0". It now reports the three input classes, and a
  truncation count carries the number of calls that actually reported a reason on the same line, so a
  "0" measured over one call in eight cannot read as a clean step. Its "no snapshot captured" line also
  stopped guessing a cause, having blamed a switch that was enabled.

  **A companion rework loop now stops when it stops making progress.** `attempts < maxAttempts` bounds
  how long a loop may run and says nothing about whether it is converging: a run re-graded an unchanged
  document to the same 0.76 four times, burning its whole budget. When the producer returns the text it
  was asked to revise AND the rating does not move, the loop stops early and takes the same
  iteration-cap exit, so an attended run parks for a person and an unattended one settles by policy.
  The rule reads a step's reply as its work, so it applies only to producers whose deliverable IS that
  reply: a `coder` pushes commits and may legitimately answer with nothing, which is why its reviewer
  reads the real diff, and a rework a human asked for is excluded too (it spends none of the automatic
  budget). The step records `stalled` beside `exceeded`, since only one of them means the remaining
  rounds were abandoned, and the park says which one it is instead of claiming a limit was hit.

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/kernel@0.298.1
  - @cat-factory/prompt-fragments@1.0.72

## 0.129.0

### Minor Changes

- 7312e0a: Stop a refused work-branch push from failing a run whose work is already on the branch.

  The harness checkpoint-pushes the agent's commits every 60s so an evicted container's work
  survives, which makes it its own competing writer: a commit is published within a minute of being
  made, the agent cannot see that from inside the container, and amending it afterwards is ordinary
  git hygiene (the delivery contract even asks it to validate AFTER committing, which is exactly the
  sequence that produces an amend). The final push was then refused as a non-fast-forward and the
  whole run failed with a complete scaffold sitting on the branch.

  Every push after the first now carries `--force-with-lease` against the sha THIS pass published,
  which is the sha the push itself named: `pushBranch` pushes `<sha>:refs/heads/<branch>` and returns
  it, rather than reading `refs/remotes/origin/<branch>` back afterwards, which a fresh coding run's
  single-branch clone never creates. That is the whole discrimination: the run's own rewrite lands, and
  a second writer's commits (a concurrent dispatch, a person) still refuse the push as `(stale info)`,
  which is the "never clobber another run's work" property the resume design leans on.

  The lease is withheld entirely unless the branch still contains the tip this pass started from
  (`workBranchLease`), because the lease alone does not bound the force to this pass's own commits: a
  resumed run that had already landed one checkpoint would otherwise force over the commits it
  resumed from and take an earlier run's work with them.

  A refused push is no longer a generic `git` fault. It reports the new `branch-contended` failure
  cause, and the engine recovers by re-dispatching the step once (`MAX_BRANCH_CONTENTION_RECOVERIES`,
  recorded on `PipelineStep.branchContentionRecoveries` and projected by the debug API): the fresh
  dispatch resumes the branch as it now stands, so the agent continues on top of whatever is on it.
  Past the budget the run fails with a remedy naming which of the two causes it was, rather than git's
  own "use `git pull`" hint, which is advice for a person at a terminal. Each refusal also increments
  the new `container.branch_contended` operational counter, since a re-dispatch that a run reports as
  a clean success is invisible per run and costs a whole agent run twice.

  The checkpoint also stops re-pushing an unchanged branch. Its gate was "the branch advanced past the
  pre-run tip", which stays true forever once it has, so every tick issued a push: an hour-long run
  that commits eight times spent ~60 authenticated round trips, ~52 of them answering "Everything
  up-to-date" and each counting against the host's push rate limits. It now pushes only an
  UNPUBLISHED tip, which makes the interval a loss window rather than a rate (one push per commit the
  agent makes, whatever the model or the run's length) and leaves the durability guarantee unchanged.

  The `build` prompt bumps to v6 with the matching half of the rule stated to the agent: add commits,
  never rewrite them.

  `/api/v1/debug/runs/:runId` gains `branchContentionRecoveries` per step (OpenAPI 1.52.0, additive):
  a run that recovered reports as an ordinary success, so nothing else tells a post-mortem that one
  agent pass was paid for twice.

  Also fixes a git failure printing its stderr twice (`execFile` already folds it into the rejection
  message), which made one refused push read as two attempts.

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0
  - @cat-factory/prompt-fragments@1.0.71

## 0.128.2

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0
  - @cat-factory/prompt-fragments@1.0.70

## 0.128.1

### Patch Changes

- 792ecde: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.62`,
  `@ai-sdk/anthropic@4.0.38` / `openai@4.0.40` / `openai-compatible@3.0.30` /
  `amazon-bedrock@5.0.54`). The Cloudflare toolchain moves together: `wrangler@4.121.0`,
  `@cloudflare/workers-types@5.20260812.1` and `@cloudflare/vitest-pool-workers@0.21.1`, whose only
  change over 0.20.3 is the wrangler and miniflare it bundles, so the pool now carries the same
  wrangler the workspace declares instead of one release behind it.

  `esbuild` gains three scoped `pnpm-workspace.yaml` overrides pinning vite's, tsx's and nitropack's
  loose ranges to the 0.28.1 that wrangler and `@cloudflare/vitest-pool-workers` pin exactly. Without
  them a re-resolve hands vite's optional PEER slot the newer 0.28.2 and the tree gains a second
  esbuild; because pnpm resolves an auto-installed peer without its own `optionalDependencies`, that
  copy never gets its platform binary and esbuild's postinstall aborts the entire install. The
  overrides are deliberately scoped rather than top-level: `drizzle-kit`, `@intlify/bundle-utils` and
  `fontless` declare narrower ranges that a blanket pin would force them out of.

  Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
  itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
  version above already satisfies the gate.

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1
  - @cat-factory/prompt-fragments@1.0.69

## 0.128.0

### Minor Changes

- fc9afb4: Let a binary-output step generate through the agent CLI's own tool, with no vendor API key.

  `BinaryGeneratorDefinition` gains a `transport` discriminator. `api` is the existing shape (a
  metered endpoint the agent's own code calls with an injected credential) and stays the default, so
  every registered integration is unchanged. `harness` is new: the artifact is produced by a tool
  built into the agent CLI the step dispatches under, which today means Codex's `image_gen` — a path
  available ONLY on ChatGPT subscription auth, since an `OPENAI_API_KEY` session is routed to the
  Images API and never offered the tool. A harness-transport definition may declare no `endpoint`,
  `credentials` or `contracts`; the credential rule is the one that matters, because a declared one
  would be an environment variable the deployment believes authenticates something and that nothing
  ever reads.

  Boot validation holds a harness transport to a CLI that actually generates, which today is codex
  alone. "This build runs that CLI" and "that CLI has a generation tool" are different questions, and
  admitting the first lets a definition naming `pi` or `claude-code` pass every check, dispatch with
  the tool flag set, produce nothing, and brief the agent to collect from a directory nothing created.

  Reachability becomes its own admission axis (`generator_harness_unavailable`): a step selecting a
  harness-served integration must resolve to that CLI. The requirement is DERIVED from the step's
  model by the same precedence dispatch uses — including the fall-through past an unresolvable block
  pin and the "subscriptions always win" override, without which the guard refuses a codex-served
  generator on a step that is about to run codex. An unresolved model raises nothing. Notably this is
  NOT a capability flag on the model catalog: whether the tool is offered is decided by the vendor per
  session and per plan tier, so a boolean on a model row would be a guarantee nothing here can verify.
  The pipeline builder states the constraint it cannot check (which CLI serves each candidate, and
  which the current selection needs) as advice, since a pipeline is a template and the model is chosen
  per task.

  The harness redirects codex's output into `.cat-context/binary-output/generated/` before the CLI
  starts, because codex exposes no path for what it generated and its output directory is also where
  the run's decrypted subscription credential lives. It is opt-in per job: the tool bills the leased
  plan at several times an ordinary turn. `generateImages` joins the job-body capability handshake, so
  a runner pool on an older image is refused rather than run blind against a brief that names the
  staging directory regardless. Where the capability genuinely cannot be honoured (an `ambientAuth`
  run has no per-run home to redirect, a filesystem refuses the link) the harness says so in the
  prompt instead of dropping it, and the teardown report tells a late-arriving image apart from one
  that was never reachable.

  Separately, the harness now consumes the job body's `artifactUpload` and surfaces it as
  `ARTIFACT_UPLOAD_URL` / `ARTIFACT_UPLOAD_TOKEN`. The backend has injected that field and served the
  ingest route since the visual-confirmation work while the container parsed neither, so a UI run's
  screenshots were dropped with no error anywhere.

### Patch Changes

- fc56d82: Make every re-dispatch mint a fresh harness job id, and make the producer answer the review.

  A container-backed producer looped back by its companion kept the same harness job id, so the
  harness replayed its first completed job: same output, same recorded usage, no model call. The
  companion then re-graded a byte-identical artifact and, correctly, never moved its rating. On a real
  run the architect was dispatched four times, produced one container session and four identical
  `token_usage` rows, and the score sat at 0.76 until the rework budget ran out.

  `dispatchEpochFor` no longer sums per-loop counters (which had to be extended for each new loop, and
  could go DOWN when a loop-back zeroed one). It reads the run's own dispatch record, so the job id
  names the n-th job of that kind in the run: unique by construction, across re-dispatches AND across
  two steps escalating the same helper kind. That closes the same replay on the tester's
  quality-control re-run and on both human-gate fix loops, which were exposed too. The deploy path's
  analogue now counts the human-test gate's rebuild loop-back for the same reason.

  Producers are also required to account for every point raised (change it and say what changed, or
  leave it and say why) in their REPLY rather than in the artifact they commit, and the grader is told
  to check that accounting against the work rather than believe it. A rework round now says whether a
  person or an automatic reviewer asked for it, since both arrive through the same prompt slice.

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0
  - @cat-factory/prompt-fragments@1.0.68

## 0.127.3

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0
  - @cat-factory/prompt-fragments@1.0.67

## 0.127.2

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/kernel@0.294.1
  - @cat-factory/prompt-fragments@1.0.66

## 0.127.1

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0
  - @cat-factory/prompt-fragments@1.0.65

## 0.127.0

### Minor Changes

- 1a0b593: A workspace now states which PIPELINE a run resolves per intake, the way it already states which risk
  policy, and a requirements review's findings are split into the two groups that decide who answers
  them.

  Three changes, one theme: a run nobody is watching should reach a pull request without stopping for a
  person who is not coming, and should stop for one exactly where a person is what the situation needs.

  **Per-scope default pipelines.** `Pipeline.isDefault` and `Pipeline.isUnattendedDefault`, scoped by
  the same `runDefaultScopeFor(intakeOrigin)` the risk-policy default takes, written through the
  `organize` body — the one pipeline write a BUILT-IN accepts, which is what makes a shipped rung
  promotable at all. Only the UNATTENDED scope is seeded: the in-app scope already resolved an answer
  without a flagged row (the interface-mode rung, then catalog order), and seeding one would silently
  overrule the adaptive rung an advanced-mode board runs today. An operator-declared row outranks both.

  The seeded rung is a new built-in, **`pl_unattended`**. It is the adaptive shape with two deliberate
  differences: no `requirements-review`, because the rung a headless caller lands on by default cannot
  open a conversation nobody is there to have; and `human-test` plus `human-review` behind ESTIMATE
  GATES after the guards, because dropping the conversation removes the platform's chance to ask about
  scope, so the oversight is bought back where the evidence is strongest. A caller that wants the
  conversation names `pl_complex` and answers it over `/api/v1/runs/:runId/decisions` or on the ticket.

  `mp_unattended` narrows the three loop budgets its own posture makes cheap (three reviewer passes
  rather than six, two tester-QC iterations, no judge bounce): each is a cap `autonomy: 'unattended'`
  settles as "proceed", so spending it buys the run nothing but tokens. `ciMaxAttempts` is deliberately
  untouched — exhausting it raises `ci_failed`, a park this policy does not answer, so cutting it would
  produce one more stop for a person rather than one fewer. Landing authority is unchanged, and the seed
  is NOT version-bumped: existing workspaces hold a CLONE of their own default there (ADR 0053's
  migration), and a reseed would restore stock ceilings alongside the narrower budgets.

  **The two groups, shown and graded.** The reviewer already classified each finding as answerable from
  practice or needing a product decision; that is now the review window's primary grouping rather than a
  badge on one edge case, with each section saying what its group is. Every Requirement-Writer
  suggestion additionally reports a `confidence`, a different claim from `groundedIn`: that one says
  where the answer came from, this one how sure the Writer is of it (a standard can settle a finding only
  partly; a general practice can be near-universal). Shown as a band on every suggestion.

  **And a run nobody is watching may settle the first group.** Under `autonomy: 'unattended'` the gate
  folds the answers in and carries on when every finding was dismissed, resolved, answered by a person,
  or auto-answered above the policy's new `minAutoAnswerConfidence` floor (default 0.8). One finding in
  the other group, or one graded below the floor, parks the whole review exactly as before, and an
  UNGRADED suggestion clears no floor above zero — so a garbled Writer reply parks the run rather than
  quietly answering it. The step stamps `autoAnsweredByPolicy`, distinct from the existing
  `reviewCapSettledByPolicy`: that one means the loop gave up, this one that it converged on answers
  nobody read. ADR 0053 ruled this out on the grounds that inventing a product judgement is off limits;
  the narrowing that makes it compatible rather than an exception is that TWO independent judgements
  must agree before anything is folded.

  **Under `attended`, nothing about the review changes.** A suggestion there is a draft a person is
  about to read, so grading it changes nothing about who decides.

  Two `/api/v1` additions (`pipelineId` on task creation, and on `GET /pipelines` both a per-row
  `unattendedDefault` and the list-level `unattendedDefaultPipelineId` that is the one to read: the
  resolution has a rung the list cannot show, so a per-row flag alone reports `false` everywhere on a
  workspace whose empty start bodies work). OpenAPI `1.50.0`, plus one behaviour change worth reading
  before upgrading: `POST
/tasks/:taskId/start` with an empty body now STARTS a run for a key that satisfies `decide`, where it
  used to answer `400 pipeline_required`. A `write` key sees no change, deliberately — the seeded rung
  reaches a human test and a human PR review, so offering it to a caller that cannot answer a park
  would trade an actionable "pass a pipelineId" for a 403 about a pipeline it never picked. The refusal
  survives wherever no default resolves.

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0
  - @cat-factory/prompt-fragments@1.0.64

## 0.126.8

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2
  - @cat-factory/prompt-fragments@1.0.63

## 0.126.7

### Patch Changes

- c09ddbe: Render a review verdict as blocks a human can skim, and ask the reviewer to write it that way.

  A companion's verdict (the architect/spec/code/doc reviewers) arrives as ONE string: `comments`
  only exist where the graded output has ids to anchor to, so everything the reviewer found lands in
  `summary`. Unshaped, a model writes that as a single dense paragraph numbering its points inline
  ("(1) … (2) …"), and the run panel then appended it to the score inside the same line
  (`78% < 80% — <four hundred words>`). Nothing about that is skimmable: a reader cannot tell what
  blocks the work from what is a nit without reading all of it.

  Both halves move. `REVIEW_SUMMARY_LAYOUT` (agents, `prompts/shared.ts`) asks for a fixed skeleton,
  a one-line verdict then `**Must fix**` / `**Should fix**` / `**Minor**` bullet groups, and is
  carried by every companion (built-in and deployment-registered, since they share one prompt). It
  survives a per-workspace prompt override, like the other fragments that describe how the platform
  reads a reply rather than what it should look for. A reviewer that already reports structured
  findings beside its summary is deliberately excluded: every judge, the `pr-reviewer` and the tester
  have that array rendered as its own list, so the layout would make them write each point twice.
  The SPA renders those summaries through the existing `MarkdownProse` reader instead of plain-text
  dumps, and each companion round is now its own card rather than a continuation of the score line.
  The same render fix reaches the reviewer prose the first markdown sweep missed: judge summary and
  findings, best-practice adherence, the PR-review summary, findings and challenge verdicts, and the
  tester report. It stops at the fields carrying a VALUE a human copies rather than prose (a
  suggested fix, a gate's failure summary), which stay preformatted: markdown would emphasise the
  `__dunder__` in a path and curl the quotes in a command.

  Kernel's `extractJson` now repairs raw control characters inside a JSON string literal. A
  multi-line summary is exactly what makes a model forget the `\n` escape, and refusing that reply
  costs the whole verdict (a companion that returns nothing parseable fails the run) over a quoting
  slip. The repair is a SECOND pass, run only once every candidate in the reply has been read as
  written: a repair makes text parse that was meant to be skipped, so tried inline it would let an
  example shape or a prose aside shadow the real verdict written after it. Fence bodies are now all
  searched, not just the first. The harness's own reader gained the same repair (hence a runner image
  bump), because it reads the reply FIRST and each refusal there costs a billed repair completion
  before the engine ever sees it.

  The judge prompt bumps to `judge@v2`: its summary is now rendered beside its findings, so it is
  asked for a short whole-verdict paragraph that does not restate them. Scoring is untouched. A
  companion kind also stops resolving to the `review` phase's prompt version — a companion runs the
  companion prompt, so both the editor's baseline label and the sandbox baseline named a revision of
  text the kind never sends.

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1
  - @cat-factory/prompt-fragments@1.0.62

## 0.126.6

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0
  - @cat-factory/prompt-fragments@1.0.61

## 0.126.5

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0
  - @cat-factory/prompt-fragments@1.0.60

## 0.126.4

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1
  - @cat-factory/prompt-fragments@1.0.59

## 0.126.3

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0
  - @cat-factory/prompt-fragments@1.0.58

## 0.126.2

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/kernel@0.289.1
  - @cat-factory/prompt-fragments@1.0.57

## 0.126.1

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0
  - @cat-factory/prompt-fragments@1.0.56

## 0.126.0

### Minor Changes

- a634746: A locally-run model can now be given a run's design renders. Its image support resolves in two
  tiers: a table of recognised open-weights families (`KNOWN_LOCAL_MODELS`, so ticking Gemma 4 or Muse
  Glimmer needs no second step), overridden by a per-model declaration on the user's own runner entry
  for anything the table cannot know about.

  The gap was structural rather than a missed case. `acceptsImages` is a per-FLAVOUR fact declared on
  `MODEL_CATALOG`, and a local model has no catalog row: it lives on one person's machine, its id is
  free text, and the OpenAI-compatible `/models` probe the panel discovers models with returns ids and
  nothing else. So every local ref arrived with the modality absent and `resolveDesignImageDelivery`
  answered `unknown_model_image_input` for all of them, forever. That reason exists precisely so this
  would stay visible instead of reading as a text-only model, and the arrival of image-capable local
  models is what turned it from a latent hole into a lost capability.

  The declaration wins over the table on purpose: the person who pulled the weights is the one who
  knows whether they are running a text-only quant, a fine-tune or a re-tagged copy. The table
  therefore carries only families whose SILENCE costs a capability (every member is image-capable; a
  text-only entry would behave identically to an absent one), and a family whose modality depends on
  the size is left out rather than approximated, which is why Gemma 3 is absent while Gemma 4 is
  present. It lives in `@cat-factory/contracts` because the settings panel labels its "not set" option
  with what the table will do and the engine folds the same answer onto the dispatched ref.

  The initiator's declarations are read on EVERY dispatch, because the winning model is not known
  until the shared resolver has walked its sources, so the read goes through a new `AppCaches`
  slice keyed on the user (the endpoint write paths invalidate it). Without that, a deployment with no
  local runners at all still paid a query per step, and a mothership-mode node an extra
  `/internal/persistence` round trip per step.

  Delivery still joins the HARNESS's answer first, and that is what decides where this lands today: a
  local ref names no harness, so a container dispatch runs it on Pi, whose `HARNESS_IMAGE_INPUT` entry
  is `false` and refuses without consulting the ref. The modality is therefore acted on by the inline
  path, and the container path becomes a reader the day an image-carrying harness serves a local model,
  which is a one-line table edit rather than new plumbing. It is resolved for every path regardless,
  because the winning model is not known until the shared resolver has walked its sources.

  `contextTokens` is deliberately NOT declared for a local model, though the same shape could carry it.
  The window a runner serves is a fact about its config rather than about the weights (Ollama's
  `num_ctx` default sits far below what a 128K-window model can do), nothing enforces it for a local
  ref, and stating a number the runner silently ignores would be worse than stating none. The
  truncation trap that follows from that is now written down in `backend/docs/model-support.md`.

  **Internal break:** the endpoint row's enabled-model list changes from `string[]` to a declaration
  array. A row written before this loses its entries on read: bare strings are dropped rather than
  coerced, so the break cannot arrive as a model id of `[object Object]`. The endpoint reports the
  discard (`unreadableModels`) and the panel names it per runner, because a shortened list on its own
  reads exactly like a runner nobody ever enabled a model on and only one of those is fixed by
  re-ticking. The fix is to re-tick the models in "My local runners", which rewrites the whole blob.

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0
  - @cat-factory/prompt-fragments@1.0.55

## 0.125.8

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/kernel@0.287.0
  - @cat-factory/prompt-fragments@1.0.54

## 0.125.7

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/kernel@0.286.3
  - @cat-factory/prompt-fragments@1.0.53

## 0.125.6

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/kernel@0.286.2
  - @cat-factory/prompt-fragments@1.0.52

## 0.125.5

### Patch Changes

- b889842: Report the actual cause of a failure everywhere, not just on a "Test connection" button.

  The previous slice taught the connection PROBES to read the cause chain, because on Node a transport
  failure is `TypeError: fetch failed` and what happened hangs off `.cause`. It turned out the repo had
  three describers of a thrown value and the other two stopped at `error.message`: `getErrorMessage`
  (the string a human is shown, and what a persisted failure reason or a PR comment records) and
  `describeError` (every log line). So a probe could name `connect ECONNREFUSED 127.0.0.1:6443` while
  the log line and the toast for the same failure still said `fetch failed`, which is what made a
  Kubernetes connect failure unexplainable even with the probe fixed.

  All three now flatten through one kernel core (`shared/error-chain.logic.ts`): `.cause` plus each
  `AggregateError` branch (so a dual-stack `localhost` reports what happened on each address), scrubbed
  through `redactSecrets`, capped with a marker saying what it dropped, and bounded by link identity so
  a cause cycle terminates. Roughly 90 hand-rolled `e instanceof Error ? e.message : String(e)` copies
  across the backend now call `getErrorMessage`, and five local `errMessage`/`messageOf` wrappers are
  deleted.

  Who may read a chain is part of the rule. An AUTHENTICATED reader gets it, because the inner link is
  usually the only thing saying whether the fix is theirs or the deployment's; where a deployment's
  model endpoints are platform-internal, their host and port do reach a workspace member through an
  ordinary 4xx. An UNAUTHENTICATED surface does not: `/ready` on BOTH facades answers with kernel's
  `publicDiagnostic` (the outermost link, scrubbed) rather than publishing the deployment's database
  address, sharing one helper so the two runtimes cannot drift to different depths.

  A VERDICT does not read the rendered string either. `errorChainMatches` tests each link uncapped, so
  a sentinel phrase pushed past the display budget by a long wrapper cannot silently turn a recognised
  rollout stop into a crash. Relatedly, log fields get their own, much wider cap than the 400 characters
  a human-facing message is held to, and an error with nothing to say answers with the empty string
  rather than the bare constructor name, so a call site's `getErrorMessage(e) || '<what to do>'` guard
  still fires.

  `redactSecrets` now spares a single-case word and an env-var-shaped identifier where a field-name rule
  matched: it scrubs the message a person reads, and `Missing required key: OPENAI_API_KEY` must not
  lose the name they have to go and set. Every credential shape the rules exist for still matches.

  An error message may therefore now carry appended causes where it did not before. The opening phrase
  is unchanged, which is what the downstream `/dispatch failed/i` and eviction-sentinel checks match on.

  On the SPA, every failure toast goes through the one funnel that already existed for pipeline errors,
  instead of 29 per-component copies of the same `notifyError(title, e)` and ~83 direct `toast.add`
  calls rendering the raw message. Beyond the translated copy that funnel already resolved, a failure
  toast now stays until dismissed instead of vanishing after about five seconds, its text is
  selectable, and one click copies the whole report: the action that failed, the class of failure, the
  backend's own account, and the `requestId` that is the only join between what the user saw and the
  server log line explaining it. Conflict (409) toasts get the same treatment, which matters most on
  the unknown-reason path, since that is where a reason an older SPA build has never heard of lands.

  `@cat-factory/cli` carries its own copy of the describer rather than importing kernel. That package is
  published and deliberately runtime-dependency-free, so a `workspace:*` import from its `bin` resolves
  through pnpm's link locally and is simply absent off the registry; a conformity test pins the copy to
  kernel's output byte for byte.

- Updated dependencies [b889842]
  - @cat-factory/kernel@0.286.1
  - @cat-factory/prompt-fragments@1.0.51

## 0.125.4

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/kernel@0.286.0
  - @cat-factory/prompt-fragments@1.0.50

## 0.125.3

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/kernel@0.285.3
  - @cat-factory/prompt-fragments@1.0.49

## 0.125.2

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2
  - @cat-factory/prompt-fragments@1.0.48

## 0.125.1

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/kernel@0.285.1
  - @cat-factory/prompt-fragments@1.0.47

## 0.125.0

### Minor Changes

- 22b2459: Make each design-picture delivery site state the channel it actually has.

  The shipped delivery decision derived its channel from whether the resolved ref named a harness,
  which is not the same question and is wrong on exactly the surfaces that cannot carry a picture at
  all. Delivery now takes a `DesignImageCarrier` the dispatch site declares: `files` plus the harness
  for a container dispatch, `message` for an inline call that composes its own request.

  Two surfaces refuse under their own reason instead of promising something. The AMBIENT INLINE path
  (a deployment serving a subscription ref by driving the developer's CLI as a host subprocess) named
  a harness whose container dispatch opens image files, so it claimed `.cat-context/design-renders/`
  on a call with no checkout and a prompt flattened to text. A CONSENSUS PANEL resolved no verdict at
  all, so its participants heard neither that pictures existed nor that they were withheld; it now
  states the ceiling exactly as it already does for the tool servers it cannot reach.

  Three more corrections to the same slice. The runner-image capability handshake never fired for
  `designImages`, because "the body carries this capability" was a populated-ARRAY test and the design
  manifest is an object, so an image predating the field ignored it while the prompt named a directory
  nothing wrote; carrying is now a per-capability predicate. The omission notice no longer attributes
  transfer losses to a ceiling nor sizes that ceiling from the DELIVERED count. And the LLM proxy's
  Workers AI output cap measures the payload it forwards rather than the image-redacted copy kept for
  telemetry, which would under-reserve context-window room by the size of every attached picture.

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/contracts@0.291.0
  - @cat-factory/prompt-fragments@1.0.46

## 0.124.0

### Minor Changes

- 19baddf: Show a task's design PICTURES to the agents that build the screen.

  The frames an import retains for a linked design (Figma, Zeplin) already fed the
  visual-confirmation gate and the UI tester's capture set. They now also reach the kinds that build
  or plan a screen, on the two channels a dispatch can actually carry an image over: written into
  `.cat-context/design-renders/` for a harness whose CLI reads image files, and attached to the model
  request as image parts for an inline call. Which kinds get them is a declared trait
  (`design-images`, on `coder` / `architect` / `fixer`), so a deployment's own UI kind opts in the
  same way.

  Delivery joins two DECLARED facts, and neither is inferred: `HARNESS_IMAGE_INPUT` says which agent
  CLI can get bytes into a turn (`claude-code`; Codex and Pi are `false` with their reason stated),
  and the new per-flavour `ModelRef.acceptsImages` says which model takes one. A dispatch that cannot
  show the pictures TELLS the agent they exist, with which of the two is missing, so the textual
  design description never reads as everything the platform had. An UNDECLARED model modality is its
  own refusal reason rather than a silent "no", so an undeclared multimodal model cannot read as a
  text-only one forever.

  **Runner image bump** (`cat-factory-executor:1.107.0`): the harness gained the download for the new
  manifest, and `designImages` joins `HARNESS_BODY_CAPABILITIES`, so a deployment running an older
  image is told rather than leaving the backend's prompt naming a directory nothing wrote. Mirror the
  tag into your registry and roll it out; nothing else in the change requires it.

  Recorded prompt bodies now pass through `redactImagePayloads` on both the inline and proxy paths: a
  `Uint8Array` JSON-stringifies to one entry per byte, so an attached frame would otherwise have
  landed in telemetry as megabytes per recorded call.

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0
  - @cat-factory/prompt-fragments@1.0.45

## 0.123.6

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0
  - @cat-factory/prompt-fragments@1.0.44

## 0.123.5

### Patch Changes

- 3ff215a: Slice 9 of the `mcp-maturation.md` tracker: a consensus-diverted step now states the tool servers
  (MCP) it cannot reach, instead of losing them in silence.

  A panel runs its participants as inline model calls with no checkout and no agent CLI, so there is
  nowhere to wire an MCP server. Nothing said so. Boot validation's `tool_servers_without_container`
  warning keys on the kind's declared surface, which is a container for nearly every consensus-eligible
  kind (architect, analysis, the reviewers), and that is exactly the set a deployment attaches a
  read-only research server to; the container executor, which owns the whole unavailability vocabulary,
  is not on this path at all. So the prompt promised nothing, the step recorded nothing, and a diverted
  step read exactly like a kind that had declared no tool servers.

  The panel now reports it in both channels a container dispatch uses. The participants' system prompt
  carries the same `toolServersSection` a container run composes, after the surface statement, so a
  model planning around the vendor tool its instructions name learns it is absent. And the step carries
  the resolution: `AgentExecutor.previewToolServers` is the inline counterpart of
  `AgentJobHandle.toolServers`, answered at dispatch and stamped with the dispatched kind by the engine
  through the same helper the container fold uses, so an executor still cannot label a resolution with
  a kind other than the one that ran. A preview rather than a field on the result for the reason the
  container path records off the handle: a step that later fails keeps its record, where a
  result-carried field would be absent on exactly the runs a reader needs it for. A kind that declared
  no servers records nothing at all, because an inline surface wires nothing by construction and an
  all-empty record would claim a resolution where none was possible.

  PUBLIC API, additive (OpenAPI `1.39.0`): the unavailable-tool-server `reason` vocabulary gains
  `consensus_panel`, carried by the run reads that project `toolServers`. A member of its own rather
  than `harness_unsupported` because no harness is involved: the kind's standard surface may serve the
  server perfectly and the same step with consensus off would have got it, so a consumer acting on the
  harness reason would go widening a list that was never the constraint. The four generated clients and
  both projections carry the new member, so they bump with the surface.

- Updated dependencies [3ff215a]
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1
  - @cat-factory/prompt-fragments@1.0.43

## 0.123.4

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0
  - @cat-factory/prompt-fragments@1.0.42

## 0.123.3

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/kernel@0.281.3
  - @cat-factory/prompt-fragments@1.0.41

## 0.123.2

### Patch Changes

- 1fbd83c: Findings of the 2026-08-09 MCP audit, the low-hanging half (the rest lands in the
  `mcp-maturation.md` tracker as slice 9 and its new inventory rows).

  A tool-server credential rides the ONE channel its transport has: a `stdio` server is a child
  process with an environment and no request, an `http` server is a remote url with headers and no
  process. Naming the other one resolved the value and folded it into nothing, leaving the server
  wired, advertised in the prompt, and started unauthenticated. Both directions are now refused, at
  all three layers a definition can reach: boot validation (`unusable_credential_header` for a header
  on `stdio`, `missing_credential_header` for an `http` credential with none, both errors), the
  dispatch, and the Test-button probe. The two runtime refusals exist because a mothership-mode node
  boot-validates nothing it resolves.

  FLAGGED BREAK: a deployment carrying either (previously silently broken) declaration now fails boot
  naming the server, the key and the fix. Remove the `header` on a `stdio` credential; add one to an
  `http` credential.

  PUBLIC API, additive (OpenAPI `1.37.0`): the unavailable-tool-server `reason` vocabulary gains
  `unusable_secret`, which the run reads project. It is kept apart from `missing_secret` (the value
  resolved) and `reserved_secret` (nothing was withheld), because only its own member points at the
  declaration. The probe's status vocabulary gains the app-only `credential_unusable` beside it.

  The rest is doc truth: the `@cat-factory/mcp-server` README's mounting example imports from
  `./http` (the root drags the stdio boot into a Worker bundle) and its group table lists all sixteen
  groups; three docs stop claiming two omitted operations where the omission list has three; the
  hosted endpoint's JSON-RPC batch acceptance is stated as transport compatibility rather than a
  protocol promise (the 2025-06-18 revision removed batching); `security-model.md` gains the
  serving-side subsection; and the `MCP_OAUTH_CALLBACK_PATH` docstring stops claiming consumers that
  did not exist.

- 00228c6: Mothership mode: widen the persistence RPC by thirteen methods across three surfaces that were
  already REACHABLE from a mothership-mode node and broken, rather than merely absent.

  Both owner-pair content libraries' repo-SYNC surfaces go remote (prompt fragments, foundational
  services) on the premise the skills slice already retired: a node reaches GitHub through the
  delegated App token, so those link / sync / unlink routes were live and failing. Introduces the
  `librarySource` scope rule, `skillSource` generalised from an accountId to an `(ownerKind, ownerId)`
  pair, and `ownerFieldUpsert`, which closes the id-keyed upsert gap the skills slice named: both
  source tables conflict on `id` alone and never re-`SET` their owner columns, so binding only the
  declared owner let an in-scope caller repoint another tenant's source at a repo it controls. That
  rule reads an absent row as a create, so its lookup reports `found` / `absent` / `unreadable`
  rather than a nullable owner: a source table a deployment cannot read must not be spent as the
  admission a genuinely free id has earned.

  `PromptFragmentRepository` gains `softDeleteBySource` on both runtimes, with a new
  `defineFragmentLibrarySuite` parity assertion. Unlink retired a source's fragments with a
  per-fragment `softDelete` loop, which going remote turns into one HTTPS round trip per fragment;
  both sibling repo-sourced libraries already retired by source.

  `reviewQuestionPostRepository` `claim`/`settle`/`get` join them. The engine writes that marker, so a
  `claim` answering `unknown_method` was read by the caller's deliberate fallback as "someone else
  holds the claim": every parked review on a local run skipped its ticket comment, and only a `warn`
  said so.

  Two Node routing gaps are fixed with them: the foundational-services catalog trio and the generated
  fragment-brief store were built over the absent `db` and never re-pointed, so the allow-list named
  them remote while only the Cloudflare facade could reach them. An un-routed repo is a `TypeError` on
  the run path rather than a clean refusal, so a new guard asserts the relation structurally: every
  repository a content-library helper builds and the allow-list names as remote must be re-pointed.

  No public API or wire-shape change.

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2
  - @cat-factory/prompt-fragments@1.0.40

## 0.123.1

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/kernel@0.281.1
  - @cat-factory/prompt-fragments@1.0.39

## 0.123.0

### Minor Changes

- 4715b74: Let a binary-output step require an exact output size, gated by a capability that can refuse it.

  `BinaryGenerationOptions` could state an aspect RATIO and not a SIZE, so for the deliverables where
  the pixel dimensions are the requirement rather than a refinement of it (an inventory icon, a sprite
  an engine slices, a texture an atlas packs) the most load-bearing fact about the artifact was the one
  thing a step could not declare. It reached the agent as prose, and a step holding only a bucketed API
  was admitted, generated at the nearest bucket, downscaled, and stored something every other check
  passes and the consumer never uses.

  `generation.outputSize` (`{ width, height }`) states it, gated by a new `exact-size` capability. The
  existing `aspect-ratio` member is narrowed to what it can honestly carry: a ratio, or a fixed set of
  size buckets. **A deployment registering an integration that takes a width and a height (Flux, Retro
  Diffusion) must now declare `exact-size` beside `aspect-ratio`** to keep serving size-requiring
  steps. The vocabulary is flat by design, so neither member implies the other, and the cost of missing
  the declaration is a refusal that names the capability rather than a silent mis-render.

  The platform deliberately does not gain a per-integration size table (it would go stale here while
  the vendor changed it there, and it is the `resolutionRange` discriminator the design record already
  refused), and it states no policy about resizing after generation. It checks that an integration can
  be ASKED for a size, states the target in the brief, and requires that any substitution be reported.

  `outputSize` is mutually exclusive with `aspectRatio` and `upscale`, refused at pipeline save: each
  states the delivered dimensions a second time and can disagree, and resolving that by precedence
  would leave the choice to the agent writing the vendor call. The pipeline builder raises the same
  refusal against the step being edited, so the conflict is reported where the fix is deleting one of
  two visible fields.

  The size covers what is measured in pixels (images and video), so a step generating an icon and its
  pickup sound states one size and means it about the icon.

  The read-back closes the loop, because admission checks only what an integration can be asked for: a
  declared artifact may carry `dimensions`, which the step's result window renders per artifact and
  counts against the requirement, keeping artifacts that reported no dimensions on their own line
  rather than letting an unmeasured one read as a delivered one.

- 8c1d8a6: Narrow the built-in pipeline catalog, and make a step conditional on what the change touches.

  A pipeline step can now carry a RUN CONDITION beside its estimate gate (`stepOptions[i].condition`),
  declaring the service scope it applies to. Every build rung carries BOTH testers: the browser pass
  runs where the change touches a frontend service, the API pass where it touches anything else. Run
  admission drops the condition-excluded steps before its gates, so a preset carrying `tester-ui` is
  not refused on a backend service.

  A condition is a SKIP AXIS, so it is held to the two structural rules an estimate gate is held to
  (`assertValidRunConditions`, mirrored in the SPA's health advisory and in what the builder offers):
  the step's kind must be one that may be absent from a run, and it may not also carry a human
  approval gate. Without that, a condition on `merger` dropped the merge on every run outside its
  scope while the pipeline still finished reporting success.

  A skipped step now records WHY as a machine-readable `skipReason` (`gated` / `condition` /
  `producer_skipped` / `run_complete`) that the SPA renders as translated copy, and its `output` stays
  empty. The
  reason used to be an English sentence written into `output`, which three separate aggregations
  select on to build a model's view of the prior steps — so a condition-skipped tester's note was
  handed to `merger` and `ci-fixer` as if it were the tester's report.

  Five presets are withdrawn (`pl_frontend`, `pl_tech_debt`, `pl_blueprint`, `pl_spec`,
  `pl_environment_analysis`) and one is added: `pl_complex` ("Complex build"), which settles the
  requirements and researches the problem before the standard loop. `pl_code_comments` stays as an
  INTERNAL pipeline: the documentation-refresh preset spawns onto it, so it resolves for a run while
  being withheld from every listing. Withheld from `pipelineCatalogVersions` too, which the health
  advisory reads as "the built-ins that exist" — an internal entry there is reported as newly
  available on every board forever, with no reseed able to clear it. `pipelineCatalogNames` still
  spans the whole catalog, so a task PINNED to an internal pipeline is named (and started) rather
  than silently falling through to a full build.

  Running ONE agent against a block is now a first-class action (`POST
/workspaces/:ws/blocks/:id/agent-kind-executions`, `ExecutionService.startAgentKind`) rather than
  something that needed a single-step preset. It backs the post-bootstrap service mapping, a new
  "Map service" action on the service frame, and the environment wizard's deep analysis.

  BREAKING (internal): a workspace seeded before this change holds rows for the five withdrawn
  presets; the pipeline-health advisory offers their removal, naming a replacement where one exists.
  Anything naming `BLUEPRINT_PIPELINE_ID` / `TECH_DEBT_PIPELINE_ID` should use `BLUEPRINT_AGENT_KIND`
  with `startAgentKind`, or name a build rung directly.

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0
  - @cat-factory/prompt-fragments@1.0.38

## 0.122.0

### Minor Changes

- afe1250: Binary generation: provider capability traits, per-step generation options, and side-by-side
  candidate comparison.

  A registered generative integration now declares `capabilities` (reference images, masked or
  instruction editing, negative prompt, seed, aspect ratio, batching, upscaling, transparent
  background, seamless tiling), and a binary-output step declares the generation options each of
  those unlocks. An option nothing selected supports refuses the run at admission with
  `binary_output_generator_invalid` / `capability_unsupported`; an option nothing has DECLARED either
  way is admitted and stated as unverifiable, so every integration registered before this axis
  existed keeps working unchanged.

  A step may also declare a `comparison`: it generates a candidate per subject from every selected
  integration, parks, and a human keeps one (or several under distinct ids) before the step re-runs
  to deliver exactly those.

  Internal shape change: the engine's park-window verbs moved from sixteen `ExecutionService`
  delegates onto one `executionService.decisions` surface.

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0
  - @cat-factory/prompt-fragments@1.0.37

## 0.121.4

### Patch Changes

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/kernel@0.279.3
  - @cat-factory/prompt-fragments@1.0.36

## 0.121.3

### Patch Changes

- 3036af7: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
  (`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
  Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
  exactly one Vue.

- Updated dependencies [3036af7]
  - @cat-factory/kernel@0.279.2
  - @cat-factory/prompt-fragments@1.0.35

## 0.121.2

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/kernel@0.279.1
  - @cat-factory/prompt-fragments@1.0.34

## 0.121.1

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0
  - @cat-factory/prompt-fragments@1.0.33

## 0.121.0

### Minor Changes

- 6ad1d8b: Let the pipeline builder's purpose dial narrow the palette per agent KIND, not per section

  The dial filtered on the palette's display CATEGORY, so it could only ever remove whole sections
  and a kind whose section survived stayed offered however plainly it contradicted the purpose. A
  `review` pipeline reviews an existing pull request and opens none, yet it was offered the two
  agents that WRITE documentation into the repo, because `docs` had to stay for the Domain Rules
  Reviewer; a `planning` pipeline was offered the bug triage and PR-review kinds; and `document` and
  `research` had identical rows, so moving the dial between those two settings narrowed nothing at
  all.

  `AgentPresentation` gains an optional `purposes`, and `purposeSuggestsAgentKind` is what the
  palette now filters on. The two narrowings INTERSECT: a declaration may only hide more, never buy
  a kind back into a purpose its section is not offered to, which is what keeps palette relevance
  inside what the save gate will accept whatever a deployment declares. Declaring nothing is the
  normal case and behaves exactly as before, so a registered kind that says nothing is as visible as
  it was; a declared list naming only purposes the reader cannot name is read as no declaration
  rather than as excluding everything.

  The built-ins that belong to one use-case now say so (the document-authoring family, the bug
  triage and PR-review kinds, the spec/blueprint/architecture kinds, the initiative breakdown), which
  is a visible narrowing of what the palette offers at every purpose, `build` included: the six
  document-authoring kinds belong to `document` alone and the initiative breakdown to `planning`
  alone, so a build pipeline stops being offered them as well. Nothing changes
  about what an existing pipeline may CONTAIN or save: `purposeAllowsAgentCategory` is untouched, so
  a stored pipeline stays editable in the builder it was built in.

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0
  - @cat-factory/prompt-fragments@1.0.32

## 0.120.2

### Patch Changes

- a596b9c: Refuse a pipeline whose environment lifecycle does not add up when it is saved: a tester /
  acceptance / human-test step with no live environment to run against (nothing provisioned one, or
  the `disposer` reclaimed it first), a `deployer` that neither reclaims nor declares that its
  environment outlives the run, or a `disposer` with nothing standing to reclaim. The rule is
  enforced at pipeline create and update only, so a stored pipeline authored before it keeps running;
  the builder shows the same faults inline off the one shared rule in `@cat-factory/contracts`, and
  the run door now reads that same rule for the two faults that would genuinely dead-end a run,
  rather than re-deriving the ordering beside it.

  An environment that is MEANT to outlive its run stays expressible: the deployer step declares it
  (`stepOptions.retainEnvironment`), which is also what lets the PR verification report render the
  teardown leg as `retained` instead of a `pending` reclaim that is never coming. That adds one enum
  value to the report's `teardown` field on `/api/v1` (spec 1.35.0, additive).

  Every built-in preset that deploys now ends with a terminal `disposer` (`pl_build`, `pl_simple`,
  `pl_full`, `pl_visual`, `pl_frontend`, `pl_tech_debt`), each with a version bump so seeded
  workspaces are offered the reseed.

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/kernel@0.277.0
  - @cat-factory/prompt-fragments@1.0.31

## 0.120.1

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0
  - @cat-factory/prompt-fragments@1.0.30

## 0.120.0

### Minor Changes

- faddbf5: Public API (`/api/v1`, spec 1.34.0): serve a service's in-repo specification. Additive.

  One new operation, `GET /api/v1/services/:serviceId/spec` at `read` scope: the prescriptive
  requirement tree stored under `spec/` in the service's repository (modules → feature groups →
  requirement items, each with its MoSCoW priority, its `aspirational`/`established` state and its
  Given/When/Then acceptance criteria, plus the domain rules scoped to each group), the Gherkin
  rendered from the same tree, and the branch and commit both were read at.

  It closes a join, not just a gap. The requirement ids on `GET /api/v1/runs/:runId/report` and
  `.../outcome` were already a key onto a document no headless caller could fetch, so an
  outcome-reviewing integration could read what a run scored and not what it scored against. Fetch the
  spec once per service and a run's outcome per run, and criterion → evidence is a map lookup outside
  the platform.

  **The read has several outcomes and the endpoint keeps them apart.** The reader behind it is total (a
  flaky repository read degrades rather than throwing), and the app's own requirements window folds an
  unreadable repository into the same empty state as a repository with no spec, which is right for a
  window and wrong for an integrator: folded here it would report every service as requirement-free
  for the duration of a VCS incident. So the response carries a three-valued `anchor` rather than a
  boolean: `absent` (no spec on the default branch) is the only value that means the service declares
  nothing, and `unparsed` says the anchor file is there and corrupt, which is a repository somebody
  has to fix rather than a service with nothing to say. An unreadable repository is a `503` with
  `reason: "spec_read_failed"`; a branch that would not resolve is a `503` with
  `reason: "spec_ref_unresolved"` (a renamed, transferred or deleted repository, a stale default
  branch and a lost installation all answer 404 exactly as an absent file does, so an empty read with
  an unresolved ref is refused rather than served as a confident "no requirements"); an unwired or
  unconnected VCS integration is a `503` with `reason: "vcs_not_configured"`; a service frame with no
  linked repository is the same `422` that starting a run on it gets; and a spec that read PARTIALLY
  is served, with `issues` naming every file that did not survive and how many items a salvaged group
  lost.

  **Every axis of the response is bounded and every bound is reported**, including the two that grow
  outside the spec's control: the Gherkin is capped across all files as well as within each one, and
  `issues` (which grows with FAILURE rather than with the spec) is capped too, so a rate-limit window
  part-way through a large walk cannot make the report of a degraded read the largest thing in the
  response. A `dropped` of `null` on an issue row means content was lost there and no count describes
  it, which is the honest answer for a shard whose `requirements` is not a list at all: those
  requirements are unreadable, so the rebuilt group is served as damaged rather than as one that
  legitimately declares nothing.

  **Two commitments a consumer should read.** `SpecDoc` and everything under it (`SpecModule`,
  `RequirementGroup`, `RequirementItem`, `AcceptanceCriterion`, `DomainRule`) are served as the SAME
  shapes the app consumes rather than a re-projection, deliberately, so one artifact cannot be
  described two ways. From this version they are part of the stable `/api/v1` surface rather than
  internals. And the `spec/` tree is anchored at the repository ROOT, so two services carved out of
  one monorepo share one spec and this endpoint answers both alike; `provenance` names the repository
  and commit rather than a subdirectory, because a subdirectory would imply a scoping the read does
  not apply.

  There is deliberately no write side: the spec's write path is a reviewed commit, and `state` is
  promoted only by an observed test pass.

  Internal, not `/api/v1`: `readServiceSpec` now returns a `diagnostics` field on `ServiceSpecView`
  (`anchor` plus per-file `issues`), so every caller can separate an absent spec from an unread one.
  The field is optional, so a view assembled by hand keeps type-checking, and `EMPTY_SERVICE_SPEC_VIEW`
  carries none. The reader also gained a total READ BUDGET: the tree's size is set by somebody else's
  repository, so one call could previously become an unbounded number of provider round trips, past
  the Cloudflare subrequest ceiling and into the installation's shared rate limit. A walk that stops
  early says so (`unread`), and the run-evidence loader no longer memoises a failed read as the run's
  answer, which had pinned one flaky read onto every later settlement.

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/kernel@0.275.4
  - @cat-factory/prompt-fragments@1.0.29

## 0.119.3

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/kernel@0.275.3
  - @cat-factory/prompt-fragments@1.0.28

## 0.119.2

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/kernel@0.275.2
  - @cat-factory/prompt-fragments@1.0.27

## 0.119.1

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/kernel@0.275.1
  - @cat-factory/prompt-fragments@1.0.26

## 0.119.0

### Minor Changes

- dfa4a8e: Hand a run's reference designs to the container that captures against them.

  `.cat-context/reference-screenshots/` has been in the UI-tester prompt since the visual-confirmation
  gate landed, and nothing wrote it. So a designer whose task links a Figma frame got a gate gallery
  built from that frame while the tester itself worked blind, naming views of its own that then had to
  be matched to design frames named by somebody else.

  A dispatch of a kind declaring the `ui` image now resolves the task's reference set (its designs'
  retained frames plus the images a person uploaded against it) and the harness downloads them into the
  checkout before the agent's first turn, with each file's view name stated in the prompt.

  The bytes do not ride the job body. A design frame is a full-page PNG and a job body is JSON that
  crosses every transport and is persisted with the dispatch, so only a manifest of ids and file names
  travels; the harness fetches the images from a new `GET ${proxyBaseUrl}/artifacts/reference/:id` on
  the same container session token the run already holds for the LLM proxy. That route is the mirror of
  the screenshot ingest route beside it and is bounded the same way, plus one more: it serves
  `kind:'reference'` only, so it cannot become a way for one container to read another run's captures.

  Two things a reviewer should look at. The reference SET now has two readers (the gate and a dispatch)
  and therefore one module: derived twice, the two would eventually disagree about a view name, which
  is exactly the join the gate performs. And the FILE NAMES are chosen by the engine, not the harness,
  because the name is how the agent learns the view name: a sanitiser change in an image a deployment
  has not rolled out yet would otherwise rename every view a run reports.

  The set is CAPPED by the engine, which is also what carries the dropped view names to the agent. A
  task's references are unbounded (a block may hold a hundred uploads beside a design's frames) while
  the download pass is budgeted well under the inactivity watchdog, so the ceiling is a decision the
  platform states rather than an accident of transfer speed. It drops design frames before uploads,
  mirroring the precedence that already lets an upload override a frame, and every dropped view is
  named in the prompt: capped and simply absent look identical on disk otherwise. The delivery is
  idempotent over the checkout, so the repair rounds of a coding flow re-cost a stat rather than a
  transfer and cannot report a view an earlier round delivered as missing, and the per-image ceiling
  now bounds the transfer (declared length, then a counted stream) instead of only the write.

  Runner image bump: harness `src/**` changed, so deployments must move to the newly pinned tag. A
  deployment on an older image simply receives no references, exactly as before this change.

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/kernel@0.275.0
  - @cat-factory/prompt-fragments@1.0.25

## 0.118.1

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0
  - @cat-factory/prompt-fragments@1.0.24

## 0.118.0

### Minor Changes

- 2544fb3: Pin the harness contract that two packages' comments claimed but nothing enforced.

  `safeDirSegment` plus the `owner__name` join, and the four sentinel paths, exist once in the
  executor harness and once in the backend, computed independently because the harness image can
  depend on no workspace package. A new conformity suite asserts the pairs, in the style of the
  existing `host-markdown` one. The backend half now lives in one module (`agents/harnessContract.ts`)
  and `.cat-follow-ups.jsonl` gets the named constant its three siblings already had.

  The suite is `test/**`-only, so it ships with no runner-image bump.

### Patch Changes

- Updated dependencies [a62bcf8]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0
  - @cat-factory/prompt-fragments@1.0.23

## 0.117.12

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/contracts@0.274.0
  - @cat-factory/prompt-fragments@1.0.22

## 0.117.11

### Patch Changes

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0
  - @cat-factory/prompt-fragments@1.0.21

## 0.117.10

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0
  - @cat-factory/prompt-fragments@1.0.20

## 0.117.9

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0
  - @cat-factory/prompt-fragments@1.0.19

## 0.117.8

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0
  - @cat-factory/prompt-fragments@1.0.18

## 0.117.7

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0
  - @cat-factory/prompt-fragments@1.0.17

## 0.117.6

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0
  - @cat-factory/prompt-fragments@1.0.16

## 0.117.5

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0
  - @cat-factory/prompt-fragments@1.0.15

## 0.117.4

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0
  - @cat-factory/prompt-fragments@1.0.14

## 0.117.3

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0
  - @cat-factory/prompt-fragments@1.0.13

## 0.117.2

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/kernel@0.262.2
  - @cat-factory/prompt-fragments@1.0.12

## 0.117.1

### Patch Changes

- e5f7eb0: Serve the run outcome summary over `/api/v1`, and compose it from the same code as the PR
  verification report.

  `GET /api/v1/runs/:runId/outcome` answers the summary the app's outcome card renders: what the run
  changed and what backs that up, for a reader who will not open a diff. It is the report's sibling on
  the evidence surface, not a projection of it.

  Serving it moved `composeRunOutcome` out of the SPA into `@cat-factory/contracts`, and moved the
  rules it shares with the verification report (which tester steps count, the spec join, the
  regression rule, the tallies) into `contracts/src/run-evidence.ts`, where both reductions call them.

  **Behaviour change, and the reason for the whole change.** The two reductions had drifted. The
  report unions every tester step's verdicts and counts coverage over the service's in-repo `spec/`;
  the outcome summary read only the last tester that reported and counted over the verdicts that
  tester happened to return. One run produced different `met` / `not covered` / `total` numbers
  depending on whether you read the pull request or the app. The summary now follows the report's
  semantics on both axes, so a requirement nobody looked at is reported as unchecked instead of being
  invisible.

  **Second behaviour change: the app's outcome card now joins against the spec on the RUN's branch.**
  It fetched the enclosing service's spec from the repo's default branch, so while a pull request was
  open every verdict naming a requirement the run itself added joined against a spec that does not
  carry it yet and rendered as "not checked", and the card's counts then contradicted the endpoint,
  which reads the run's branch. `GET /workspaces/:ws/executions/:executionId/spec` serves the card the
  same read, through the same loader and the same branch rule.

  Additive on the public surface (OpenAPI `1.22.0`): the new endpoint, plus
  `requirements.unmatchedVerdicts` on the verification report, which counts tester verdicts against
  ids the spec does not carry. Those used to be dropped silently, which made the section report fewer
  rulings than the tester made with nothing to explain the gap. The report now RENDERS that count in
  its prose rather than only carrying it in the JSON, and a spec that declares no requirements while
  the tester did return verdicts is reported (0 requirements, every verdict unmatched) instead of
  being called an absence, on both documents: it is a spec that moved under the run, and calling it
  "nothing to rule on" discarded every ruling the tester made.

  The outcome payload also gains `truncations`, in the verification report's own vocabulary. Served
  over `/api/v1` it is scrubbed with `redactSecrets` and bounded, which the report has always done for
  the same tester text on its way onto a pull request; unbounded, its size was set by how much a model
  chose to write. The counts are computed before any cap, so a bounded response still reports the true
  totals. The SPA composes the same reduction locally and caps nothing, so `truncations` is empty
  there.

  Internally: `TESTER_AGENT_KIND` and `isTesterKind` are now defined in `@cat-factory/contracts` and
  re-exported by `@cat-factory/agents` and the engine (the SPA had a hand-written copy with the slugs
  as literals), and the block + `spec/` reads both documents need are shared through a new
  `RunEvidenceLoader`. The outcome summary's `spec` join vocabulary loses `unmatched` (a joined
  section now carries every spec requirement, so a titleless row inside one cannot occur) and gains a
  `no_requirements` gap.

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/kernel@0.262.1
  - @cat-factory/prompt-fragments@1.0.11

## 0.117.0

### Minor Changes

- 8cbd518: Let a code-registered prompt fragment name a LIVING document.

  A `documentRef` on a deployment-registered fragment used to be refused at boot, because every
  document source authenticated per workspace and there was no deployment-wide credential to read one
  with. A deployment now configures its own (`DOC_SOURCE_<SOURCE>_<FIELD>`, the field names taken from
  each provider's existing connect-form declaration), and a `builtin`-tier `documentRef` resolves
  through a new `DeploymentDocumentResolver` port, version-probed and cached under one
  deployment-wide group so a hundred workspaces folding one standard cost one fetch and one
  invalidation.

  The deployment's own credentials are read from the environment and nothing else. `DOCUMENT_SOURCES`
  governs which sources a WORKSPACE may connect, and `DOCUMENTS_ENABLED` and the connection encryption
  key govern whether tenant connections are stored at all; none of the three has any bearing on a
  standard the deployment configured centrally, whose credentials live in plaintext variables and are
  never persisted. So setting `DOC_SOURCE_NOTION_API_TOKEN` is the whole configuration, with no
  unrelated prerequisite to discover.

  `github` is the exception and it is declared, not inferred: its credential is a workspace's App
  installation, so the new `deploymentScoped` source trait is false for it and both boot validation
  and the provider refuse the scope. Boot now refuses only a `documentRef` this deployment cannot
  serve, naming which of the two causes applies.

  An unreachable source still degrades to the fragment's registered body, but no longer silently: the
  fallback logs a warning naming the fragment, tier and source, because the prompt is byte-identical
  either way and nothing downstream could otherwise tell a stale standard from a current one.

  In mothership mode the credential stays on the mothership and the node reads the resolved body over
  `POST /internal/prompt-fragments/document-bodies`.

  `DocumentSourceProvider.fetchDocument` / `probeVersion` now take `workspaceId: string | null`, where
  `null` is the deployment scope. An internal interface with no external consumers.

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0
  - @cat-factory/prompt-fragments@1.0.10

## 0.116.8

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/contracts@0.261.1
  - @cat-factory/kernel@0.261.0
  - @cat-factory/prompt-fragments@1.0.9

## 0.116.7

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0
  - @cat-factory/prompt-fragments@1.0.8

## 0.116.6

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/kernel@0.259.0
  - @cat-factory/prompt-fragments@1.0.7

## 0.116.5

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/kernel@0.258.0
  - @cat-factory/prompt-fragments@1.0.6

## 0.116.4

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0
  - @cat-factory/prompt-fragments@1.0.5

## 0.116.3

### Patch Changes

- 6076cf1: Finish the built-in-agent strangler: every container agent kind the platform ships is now an
  ordinary `registerAgentKind` entry, and both switches that shadowed the registry are deleted.

  `buildKindBody` (`@cat-factory/server`) is one path — compose the prompt, resolve the kind's
  `AgentStepSpec` off the registry, build the generic body — where it used to carry
  `buildMigratedBuiltInBody`'s `switch (context.agentKind)` plus a read-only-set branch, a companion
  branch and an implementer fallback. `coerceCustomResult` (`containerAgentResult.ts`) is one
  `registry.mapStructuredResult(kind)` lookup where it used to be an `agentKind === …` chain. The two
  hard-coded Sets that answered questions the registry should have answered are gone with them:
  `CONTAINER_AGENT_KINDS` (replaced by the kind's declared `container-*` surface) and
  `MULTI_REPO_FANOUT_BUILTIN_KINDS` (replaced by `fanOutMultiRepo` on the implementer and CI-fixer
  registrations).

  **Kernel (breaking, pre-1.0).** `AgentStepSpec.infra` (declared, never read) is replaced by
  `testInfra: boolean`; the spec gains `image`, `localWrites`, and `clone.requirePr` /
  `clone.prFallback` / `clone.mergeBase`. New: `AgentDispatchContext` (`baseBranch` / `workBranch` /
  `multiRepo`), passed to a kind's `userPrompt` on a container dispatch and ABSENT for an inline
  caller — the seam whose absence is why these kinds could not be registered before, since their
  prompts have to name a branch and `AgentRunContext` describes the work rather than the checkout.

  **Agents.** `AgentKindDefinition.systemPrompt` becomes optional (a built-in's shipped TRACK owns its
  role text; a copy on the definition would be dead the day the track's wording moved), and gains
  `userPromptSuffix` (append to the generic block-context prompt instead of replacing it — the
  `on-call` agent reasons over the regression evidence that prompt carries) and `mapStructuredResult`
  (the kind's own answer to which engine channel its JSON belongs in). `standardsDelivery` gains a
  `none` tier for a kind that judges rather than produces. A suffix is applied OUTSIDE the revision
  and injected-context wrappers, so a reply-shape instruction still ends the prompt on a revision
  re-run and on the inline (no-checkout) path.

  **Behaviour.** Parity was gated on the executor's existing per-kind snapshot suite, which drives
  every kind through the public `startJob` and diffs the whole body: every body is byte-identical bar
  one deliberate change. `merger` and `on-call` were bypassing the shared prompt chain, so they now
  receive the effort-report guidance and — the actual bug — the skill and tool-server sections, which
  a deployment's `assignSkills('merger', …)` had always been silently dropped from. `merger` declares
  `standardsDelivery: 'none'` so joining that chain does not newly fold the service's coding standards
  into a scoring prompt that never applies them.

  What a deployment gets: the clone/PR/infra vocabulary the built-ins use is the public one, so an
  org's own in-place fixer, tester or assessor is a registration rather than a fork.

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/kernel@0.256.0
  - @cat-factory/contracts@0.258.0
  - @cat-factory/prompt-fragments@1.0.4

## 0.116.2

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/kernel@0.255.1
  - @cat-factory/prompt-fragments@1.0.3

## 0.116.1

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0
  - @cat-factory/prompt-fragments@1.0.2

## 0.116.0

### Minor Changes

- 184d263: Spec Writer, Blueprinter and Deployer are addable in the pipeline builder again

  The catalog collapse dropped the requirements review, the spec increment, the map refresh and the
  rest of the optional phases out of every build preset on one stated condition: that each remained
  available in the builder as an opt-in step. For `spec-writer`, `blueprints` and `deployer` that
  condition was never met, so the collapse did not move those steps out of the presets, it removed
  them from the product.

  A step reaches the palette through two independent gates and each of the three failed at least one.
  A registered kind is offered only when it declares `presentation` (the filter
  `snapshotCustomAgentKinds` applies), and `spec-writer` / `blueprints` deliberately declared none,
  recorded in code as "pipeline-internal, not palette kinds". Separately, the SPA's
  `SYSTEM_AGENT_META` shadows the backend catalog: an entry there DROPS the registry's copy, so all
  three were suppressed on the client too. Both halves are fixed, the two kinds now declaring their
  presentation next to the definition rather than the SPA restating it uninvited.

  `spec-writer` also took a second kind down with it. A companion is never placed directly, it is a
  toggle rendered on its producer step, so with no placeable Spec Writer the Spec Reviewer had
  nowhere to attach and the whole spec pair was unreachable.

  `deployer` was the sharpest case, because the engine already refuses runs over its absence:
  `assertDeployerBeforeConsumer` rejects a chain that reaches a tester, human-test or playwright step
  with no Deployer in front of it on a kubernetes / custom / compose service. The SPA's own copy for
  that refusal says "Add a Deployer step to the pipeline", which nobody could do. The backend message
  said to reseed the pipeline instead, which was the honest advice while adding one was impossible and
  is now the second-best of two, so it leads with the builder.

  Reviewing: `deployer` is a bare engine step with no registered kind, so it is modelled statically in
  the SPA catalog like `disposer`; the other two are registered kinds and are ALSO mirrored statically,
  for the reason `pr-reviewer` already is, so a `pl_bugfix` timeline names its steps before the
  workspace manifest hydrates. That mirroring is the drift risk worth a look. The rest of the palette
  is untouched: no preset changed, so no reseed advisory fires and no existing pipeline runs
  differently.

### Patch Changes

- Updated dependencies [ee6ce7c]
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0
  - @cat-factory/prompt-fragments@1.0.1

## 0.115.0

### Minor Changes

- 16576d6: Close the deployment extension-seam gaps a consumer build hit: every app-owned registry is now
  reachable from the documented boot entry point, and the prompt-fragment pool is injected rather than
  a module global.

  An org package outside this repo built a proprietary reusable operation against the PUBLISHED
  `@cat-factory/*` packages and reported nine gaps. Each seam it hit typechecks, boots, passes CI, and
  is either unreachable from the supported entry point or silently inert once reached. None showed up
  in our own tests because the worked example lives INSIDE this repo, where the composition root calls
  `buildNodeContainer` directly and every package resolves to one copy on disk.

  **Breaking, `@cat-factory/prompt-fragments`.** `registerPromptFragment(s)`,
  `clearRegisteredPromptFragments`, `universalFragments`, `registerTaskTypeDefaultFragments`,
  `clearRegisteredTaskTypeDefaultFragments` and `defaultFragmentIdsForTaskType` are REMOVED. They were
  two module globals, correct only while every reader resolved the same physical copy of the package;
  a `workspace:*` dependency publishes as an EXACT version, so a consumer floating the range onto a
  newer patch got two copies, the registration landed in one, the server read the other, and every
  task of the operation was seeded with fragment ids that folded nothing. Replaced by the app-owned
  `PromptFragmentRegistry` (kernel), injected by reference:
  `promptFragmentRegistryWithBuiltins()` news one carrying the shipped catalog, and it is an option on
  `start()` / `startLocal()` / the Worker overrides. `getFragment` remains, narrowed to the shipped
  catalog. One behaviour change rides along: `registerTaskTypeDefaults` REPLACES a built-in per-type
  set instead of silently unioning with it, so a deployment can now remove a shipped default; spread
  `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` to keep both.

  **Also breaking (internal surfaces, pre-1.0, no shims).** `validateRegistrations` /
  `collectRegistrationProblems` take their registries as ONE `registries` object (a facade passes its
  container) instead of seven hand-listed optional fields; that hand-list is why the local mothership
  boot validated five registries while its own comment claimed parity with `start()`, so a custom task
  type naming an unregistered pipeline booted clean on a laptop and failed on the Postgres path.
  `FragmentLibraryService` takes a `promptFragmentSource` and no longer falls back to the module pool.
  `TaskTypeCreationDefaults.fragmentIdsFor` is async. `PromptFragmentSource` gains a required
  `inProcess` flag, read by boot validation to tell "this deployment registered nothing" from "the
  pool lives on the mothership", which are the same empty list and opposite facts.

  **What is new rather than moved.** `start()` and `startLocal()` gain `pipelineRegistry`,
  `gateRegistry`, `judgeRegistry`, `stepResolverRegistry`, `vcsRegistry` and `promptFragmentRegistry`;
  the seam drift guard now asserts against those ENTRY POINTS rather than only the container builder
  behind them, which is how `pipelineRegistry` sat on `NodeContainerOptions` (documented, guarded,
  green) while no boot path forwarded it and local deployments had no escape hatch at all. A registered
  task type may declare `conditionalFragmentIds`, standing context selected by a `showWhen` condition
  over the answers a case supplied, evaluated once at creation by the same evaluator the form's own
  field visibility uses. A code-registered fragment carrying a `documentRef` now FAILS boot rather than
  being carried through the catalog, rendered as a live source in the library UI, and ignored at run
  time. An unresolvable standing-context id is reported on the run that dropped it instead of only as
  one boot warning that cannot be told apart from a typo, and is COUNTED on the new
  `fragments.dropped_from_run` operational counter, because a run going without its standards still
  succeeds and only a rate says a deployment is doing it every time. And a mothership-mode node reads
  the pool from the mothership over `GET /internal/prompt-fragments`, throwing rather than answering
  with an empty pool.

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/prompt-fragments@1.0.0
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0

## 0.114.7

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0
  - @cat-factory/prompt-fragments@0.16.0

## 0.114.6

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0

## 0.114.5

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0
  - @cat-factory/prompt-fragments@0.15.78

## 0.114.4

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0
  - @cat-factory/kernel@0.249.0
  - @cat-factory/prompt-fragments@0.15.77

## 0.114.3

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0
  - @cat-factory/prompt-fragments@0.15.76

## 0.114.2

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0
  - @cat-factory/prompt-fragments@0.15.75

## 0.114.1

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/contracts@0.248.0
  - @cat-factory/prompt-fragments@0.15.74

## 0.114.0

### Minor Changes

- 250b7dc: Per-judge model pin: a rubric names the model it was written for

  A judge registration could state its rubric and its verdict schema but not its model, and every
  judge assessment resolved under the constant agent kind `judge`. That was wrong in both
  directions. The deployment is the only party that knows scoring a security rubric is not the same
  ask as scoring doc completeness, and had no way to say so. And a registered judge is already its
  own row in the model-defaults panel (it reaches the palette through `customAgentKinds`), so a
  workspace could author a per-judge default that the engine then read under a different key and
  never applied.

  `JudgeDefinition.modelId` now names the CATALOG MODEL ID the rubric was authored for, and an
  assessment resolves under the judge's OWN kind. Precedence, most specific first: the task's pinned
  model, a workspace preset override NAMING the judge's kind, the registration's pin, the preset's
  base model, the deployment's routing default. A catalog id rather than a `ModelRef` on purpose, so
  the id still resolves through the deployment's catalog under the route order the task's preset
  states: a pinned judge in a residency-constrained workspace stays on that workspace's routes.

  The pin's POSITION is the design. Above the preset's base model, because a base is a blanket
  statement about every kind and a pin under it could never be reached; below an override naming the
  kind, for the reason the threshold lives on the merge preset rather than the registration, that a
  deployment-global constant no workspace can relax is not a policy. Keeping those two apart is why
  `PresetRouting` now reports `pinnedForKind` beside the id, and why kernel gains
  `presetOverrideForKind` next to the `modelForKindFromPreset` that collapses them.

  A pin this deployment cannot serve is stated, not swapped: `step.judge.modelPin` records
  `applied` / `overridden` / `unavailable`, the judge window shows the unavailable case, and the PR
  verification report's rubric line calls it out beside the model that actually ran. A rubric scored
  by a model its author rejected otherwise reads exactly like one it approved, which is the failure
  the whole report exists to remove. Telemetry keys the same way, so each rubric's spend is its own
  line in the `(agentKind, phase)` rollup instead of every judge's landing together.

  Watch for: `JUDGE_AGENT_KIND` is gone from `@cat-factory/agents` rather than left as a constant
  that would silently re-collapse every rubric onto one model default. `PresetRouting.pinnedForKind`
  is required, so any producer of that shape must state it. Public API addition only: an optional
  `modelPin` on the report's judge verdicts, spec `1.14.0`.

  Design: `docs/initiatives/judge-registry.md` (D9); resolution chain:
  `backend/docs/model-support.md`.

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0
  - @cat-factory/prompt-fragments@0.15.73

## 0.113.0

### Minor Changes

- 4e4d1b4: OAuth for external MCP tool servers, so the OAuth-first hosted ecosystem (Linear, Atlassian,
  Figma, Slack's remote server) is reachable at all. A remote (`http`) declaration may now carry
  `oauth`: the `authorization_code` grant, which a `secrets.manage` holder completes once per board
  from the Infrastructure window, and `client_credentials`, which needs no human and covers an
  internal or partner server. Endpoints are discovered per the MCP authorization spec (RFC 9728 →
  RFC 8414 → OIDC discovery) with a declaration override, PKCE and the RFC 8707 `resource` indicator
  are always used, and the grant is sealed per (workspace, server) and refreshed on the dispatch
  path. The access token rides the job body's header channel only, never a prompt or the telemetry
  snapshot.

  Two new unavailability reasons (`oauth_not_connected`, `oauth_token_failed`) and the matching probe
  verdicts keep "nobody connected", "the connection stopped working" and "no credential configured"
  apart, since each sends an operator somewhere different. New table `mcp_oauth_grants` on both
  runtimes (D1 migration 0082 ⇄ a Drizzle migration), in the mothership `remote` bucket and in the
  workspace-delete cascade. Interactive grants need `MCP_OAUTH_REDIRECT_URL` set to the deployment's
  public app URL followed by `/mcp-oauth-callback` and `ENCRYPTION_KEY` for the sealed store; without
  either, an OAuth server is stated to its agent as unavailable rather than dispatched without a
  token.

  The vendor's redirect lands on the SPA, which re-presents the `code` and `state` to a session-gated
  `POST /mcp/oauth/complete`. A backend route receiving the redirect directly could not be gated:
  sessions are bearer tokens and a third-party browser navigation carries none, so it would have to
  sit outside the default-deny session gate, and the "same user who started the flow" and "still
  holds `secrets.manage`" checks would never execute. Routing it through the app is what makes both
  enforceable.

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0
  - @cat-factory/prompt-fragments@0.15.72

## 0.112.6

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/kernel@0.243.1
  - @cat-factory/prompt-fragments@0.15.71

## 0.112.5

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0
  - @cat-factory/prompt-fragments@0.15.70

## 0.112.4

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0
  - @cat-factory/contracts@0.243.0
  - @cat-factory/prompt-fragments@0.15.69

## 0.112.3

### Patch Changes

- 7cf3e70: Refresh the dependency tree and re-roll both runner images.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the newest
  release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.47 → ^7.0.51`,
    `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.27 → ^4.0.29`, `@ai-sdk/openai-compatible@^3.0.20 → ^3.0.22`,
    `@ai-sdk/provider@^4.0.4 → ^4.0.5`, `@ai-sdk/amazon-bedrock@^5.0.40 → ^5.0.42`.
  - **Runtime deps**: `hono@^4.12.33 → ^4.13.0`, `@hono/node-server@^2.0.12 → ^2.1.0`,
    `pg-boss@^12.26.4 → ^12.27.0`, `undici@^8.9.0 → ^8.10.0`, `ws@^8.21.1 → ^8.21.2`,
    `@aws-sdk/client-s3@^3.1101.0 → ^3.1102.0`, `nuxt@^4.5.0 → ^4.5.1`.
  - **Tooling**: `oxlint@^1.76.0 → ^1.77.0`, `oxfmt@^0.61.0 → ^0.62.0`, `publint@^0.3.22 → ^0.3.23`,
    `vitest@^4.1.8 → ^4.1.10`, `@cloudflare/workers-types@^5.20260801.1 → ^5.20260804.1`.

  **Runner images** (`@cat-factory/executor-harness` 1.92.1, `@cat-factory/deploy-harness` 0.2.10, with
  all six pinned tags synced):

  - Executor: Claude Code `2.1.220 → 2.1.221`, and the two lockstep Pi extensions
    `rpiv-todo`/`rpiv-web-tools` `2.3.1 → 2.4.0`. Pi stays at `0.83.0` and Codex at `0.146.0`, both
    already the latest. Claude Code `2.1.222` exists but was published inside the release-age window, so
    `2.1.221` is the newest version the supply-chain rule admits.
  - Deploy: `kubectl v1.36.3`, `helm v4.2.3` and `kustomize v5.8.1` are all already the latest, so the
    image moves only for the base re-pin below.
  - Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest.

  No `minimumReleaseAgeExclude` entries were added: every version above already satisfies the gate.

  **Majors**: none were available this sweep except `typescript@6 → 7` for the frontend, which stays on 6
  for the same reason as last time. `vue-tsc@3.3.9` still resolves its compiler through
  `require.resolve('typescript/lib/tsc')`, and TypeScript 7's `exports` map publishes no such entry, so
  the frontend typecheck would fail to resolve at all.

- Updated dependencies [7cf3e70]
  - @cat-factory/kernel@0.241.1

## 0.112.2

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0
  - @cat-factory/prompt-fragments@0.15.68

## 0.112.1

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0
  - @cat-factory/prompt-fragments@0.15.67

## 0.112.0

### Minor Changes

- dd90c1e: A deployment can register its own REWORK PAIR: a producer, and a companion that grades its
  output and loops that producer back for automatic rework below the step's threshold.

  The companion catalog was a module-global `Map` of four built-ins, so the only way to express
  "my producer, reviewed and bounced below a bar" was to reach for a judge, a different machine.
  A judge scores against a rubric and disposes (advance / park / bounce / fail); a companion drives
  the producer's own bounded rework budget and only then involves a human. The workaround got the
  scoring and lost the loop.

  The pairing now lives on `AgentKindRegistry` (`registerCompanion`), beside traits, skills, tool
  servers and variants, rather than on a sixth registry: a companion is a relationship BETWEEN
  agent kinds. The built-in catalog is pre-loaded, so registering one adds rather than replaces,
  and module identity stops mattering for a separately-published extension package.

  Two things a reviewer should look at. The free lookups take the registry OPTIONALLY and fall
  back to the built-ins, copying `isGatableKind`, which means a call site that omits it silently
  sees built-ins only, so every engine site that could meet a deployment's pair now threads it
  (dispatch routing, the rework loop's producer search, the step-gating cascade, run-start
  threshold seeding, pipeline-shape validation, the container job body, the prompt). And the
  pairing is registered SEPARATELY from the kind, so the snapshot projection asks the registry
  rather than reading a kind's own definition, which would have missed every one.

  The SPA learns a custom pairing from the snapshot (`customAgentKinds[].companionTargets`) so the
  builder renders it as an "add companion" toggle on its producer rather than a placeable palette
  block that pipeline validation would then refuse on save. Built-in pairings win on collision: a
  deployment cannot silently re-point `coder` at its own reviewer and change what every stock
  pipeline does.

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/kernel@0.239.0
  - @cat-factory/prompt-fragments@0.15.66

## 0.111.0

### Minor Changes

- a675c63: MCP maturation slice 4: a declared tool server can now be TESTED, and the deployment's tool servers are
  finally visible without reading its source.

  Until now the only way to learn whether a wired MCP tool server actually works was to start a run and
  read the agent's own prompt. Boot validation rules on the DECLARATION and a dispatch reports what it
  DROPPED, but a server that survives both — servable harness, allowed transport, credential present —
  could still be a dead url, a rotated token or a typo'd tool name, and every one of those surfaced as an
  agent quietly doing worse work without the tool it was promised.

  Two new `secrets.manage`-gated routes under `/workspaces/:ws`: `GET /tool-servers` lists every
  registered server (which agent kinds get it, which harnesses can serve it, which credentials it asks
  for by name, whether it can be probed at all), and `POST /tool-servers/:id/test` speaks `initialize` +
  `tools/list` to it for real. The Infrastructure window's "Capability credentials" tab renders the
  inventory with a Test button per row, above the credential checklist those credentials belong to.

  What makes the verdict worth having is that the probe resolves credentials through the SAME composed
  chain a dispatch uses: the per-workspace store in front of the deployment environment, per key, with
  the reserved-key floor applied before the resolver is asked. So the answer is about THIS board rather
  than about whoever set the deployment's variable, and the probe can never be the one path that resolves
  a platform configuration variable and ships it to a third party. The result names a CAUSE rather than a
  boolean, split by the fix each needs: a missing credential and a rejected one are different rows, and
  "no answer at all" is kept apart from "answered with a status" because one is the network and the other
  is usually the token or the path.

  Three things it deliberately refuses rather than approximating. A `stdio` server runs inside the run
  container, a loopback url means "beside the agent in its own container", and the backend is neither of
  those places — so those rows say why instead of offering a button, because a probe that reached for the
  nearest thing it could talk to would answer about the backend's own machine, and a SUCCESS there would
  mislead more than a failure. The third is the `allowedTools` reconciliation: the probe is the first
  thing in the platform that can check a declared tool name against reality (every other layer holds it
  to a NAME pattern, which a well-formed typo passes), and when the server's tool list came back
  paginated past the probe's page bound the check reports itself as unchecked rather than calling a
  working tool missing.

  A redirect is followed, and each hop is held to the transport rule and to the DECLARED ORIGIN while a
  credential is riding. That matches what a run does rather than exceeding it: the Web platform removes
  `Authorization` on a cross-origin redirect, so an agent's own MCP client reaches such a hop
  unauthenticated, and a probe that forwarded the token would report on a request no run makes while
  handing a workspace's credential to whatever the redirect names. The row names the origin change, so
  the fix reads as the declaration naming the final url. A server needing no credential is followed
  across origins as before.

  Two smaller fixes ride along. `McpSecretRef` gains `usage`, the operator-facing note the credential
  checklist has always had a field for and only the generative-integration half ever populated — so a
  tool server's row can finally say which token type and scopes a key wants. And the checklist's READ was
  documented as `secrets.manage`-gated in three places while its mount let every member's GET through:
  `requireWorkspacePermission` passes GET/HEAD by design, so both surfaces now mount the
  explicitly-named `requireWorkspacePermissionIncludingReads`, with a cross-runtime RBAC assertion each.
  Both mount it on their OWN path patterns rather than `'*'`: a `'*'` mount inside a routed Hono
  sub-app lands on `/workspaces/:workspaceId/*` and can refuse a sibling controller's routes, which is
  survivable while only writes are gated and an outage once reads are.

  `ServerContainer` gains `toolSecretResolver`, the composed credential chain itself, beside the
  `toolSecretEnvironmentFallback` description it already carried; a facade that wires the chain now
  surfaces both. `AgentKindRegistry` gains `allToolServers()`, the complement of
  `kindsWithCapabilities()` and the only way to see a registration attached to no kind at all — a state
  that previously passed every check while its credentials sat in the operator's checklist as keys no
  dispatch would ever ask for. Kernel gains `isLoopbackMcpHttpUrl` beside `isAllowedMcpHttpUrl`, a
  separate predicate on purpose: one rules on the scheme, the other on where the server lives.

  No harness change, so no runner-image bump.

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/contracts@0.239.0
  - @cat-factory/prompt-fragments@0.15.65

## 0.110.9

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/contracts@0.238.0
  - @cat-factory/prompt-fragments@0.15.64

## 0.110.8

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/kernel@0.236.1
  - @cat-factory/prompt-fragments@0.15.63

## 0.110.7

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0
  - @cat-factory/prompt-fragments@0.15.62

## 0.110.6

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1

## 0.110.5

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0
  - @cat-factory/prompt-fragments@0.15.61

## 0.110.4

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/kernel@0.234.2
  - @cat-factory/prompt-fragments@0.15.60

## 0.110.3

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/kernel@0.234.1
  - @cat-factory/prompt-fragments@0.15.59

## 0.110.2

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0
  - @cat-factory/prompt-fragments@0.15.58

## 0.110.1

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/contracts@0.231.0
  - @cat-factory/prompt-fragments@0.15.57

## 0.110.0

### Minor Changes

- 2619d79: MCP maturation slice 1: every declared tool server is either served or STATED.

  A dispatch now checks the running harness's MCP TRANSPORTS, not just whether it speaks MCP, so an
  `http` server on a Codex run (whose client is stdio-only) is dropped under a new
  `transport_unsupported` reason instead of being advertised in the prompt and then silently skipped by
  the harness's TOML writer. Boot validation and the capability-credential checklist now enumerate
  `AgentKindRegistry.kindsWithCapabilities()` (every kind declaring a capability on its own
  registration, plus every kind named by `assignSkills` / `assignToolServers`), so a server attached to
  a built-in such as `coder` reaches the same refusals and the same operator checklist as a registered
  kind's own. New checks: a transport/harness combination no run could serve, an `allowedTools` entry
  that is not a single tool name (the harness joins the list with commas), and a per-dispatch server
  budget, both dimensions of which warn at boot and drop the excess under `over_budget` at dispatch.
  The harness exempts `mcp__*` calls from the no-edit progress bound and bounds them with their own
  `JOB_MAX_CONSECUTIVE_MCP_CALLS` streak, plus a `JOB_MAX_CONSECUTIVE_NON_ACTION_CALLS` backstop shared
  by every no-edit-exempt family (each per-family streak resets on a call outside its family, so
  interleaving two of them was bounded only by the job's wall-clock ceiling).

  OPERATORS UPGRADING: capabilities attached by `assignSkills` / `assignToolServers` were previously
  not boot-validated at all, so a declaration that is now an ERROR (a cleartext off-loopback endpoint,
  a reserved credential key, an unregistered id, a malformed server id or tool name) turns a
  deployment that used to start into one that refuses to. That is the intent of the change, and each
  message names the kind and the declaration to fix.

  INTERNAL BREAK: `UnavailableToolServer['reason']` gains `transport_unsupported` and `over_budget`, so
  a deployment rendering that union exhaustively must map them. Runner image bumped to 1.89.0.

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0
  - @cat-factory/prompt-fragments@0.15.56

## 0.109.2

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0
  - @cat-factory/prompt-fragments@0.15.55

## 0.109.1

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0
  - @cat-factory/prompt-fragments@0.15.54

## 0.109.0

### Minor Changes

- fccb1df: Reusable operations, slice 1: a registered custom task type can now carry its whole bundle, and the
  per-case values a user fills reach the agents that act on them.

  A custom task type's collected `taskTypeFields.custom` bag previously reached ZERO prompts: it rode
  the run context and nothing rendered it, so an operation's brief ("expose CRUD for Order", "auth:
  service-to-service") was invisible to every step in the pipeline. The engine now resolves a labelled
  projection once per dispatch (`AgentRunContext.customTaskType`, joined from the registered
  descriptor by kernel's `describeCustomTaskType`) and the agents package renders it as a
  `## Task parameters` section at all three prompt-assembly points, including the prepend a registered
  kind that authors its own user prompt gets.

  The descriptor gains two optional fields: `defaultFragmentIds`, the operation's standing context,
  unioned onto every new task's own fragment selection at creation, and `presentation.category`, the
  picker grouping axis a later slice renders. Boot validation warns (never refuses) on a
  `defaultFragmentIds` entry the code pool cannot resolve, because an account/workspace-tier fragment
  merges per workspace at run time and is invisible at boot.

  Every existing prompt is byte-identical: the projection is absent whenever a block collected no
  custom values, which is every run of a built-in task type. It is also absent for an un-namespaced
  type, so a built-in carrying a stray `custom` bag renders no section: a custom type is namespaced by
  construction, so the raw-id fallback that honestly names a withdrawn operation would otherwise invent
  one. Seeding the standing context STATES a namespaced type this process does not register, since only
  the id set freezes at creation and that task never gains the operation's fragments later.

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0
  - @cat-factory/prompt-fragments@0.15.53

## 0.108.3

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/kernel@0.228.1
  - @cat-factory/prompt-fragments@0.15.52

## 0.108.2

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0
  - @cat-factory/prompt-fragments@0.15.51

## 0.108.1

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0
  - @cat-factory/prompt-fragments@0.15.50

## 0.108.0

### Minor Changes

- f1a6cb3: Put the platform's captured evidence on the pull request: the pre-PR validation run, the bugfix
  reproduction proof, and direct links to the artifacts the report lists.

  Two of the strongest things this platform does were invisible to the only audience that matters.
  The executor-harness has always run the service's own check commands against the exact tree that
  opens a PR, and has run the declared reproducing test against the pre-fix tree and the finished one,
  but both landed on the step record and nowhere a reviewer looks. The verification report now
  carries them.

  **Pre-PR validation** is reported as its own section: each command, its exit code and duration, and
  the captured log of whatever failed. It is deliberately kept apart from the `ci` section, because
  they answer different questions: CI is the host's opinion of the pushed branch, on another machine
  and later, while this is the platform's own run of the service's commands on the exact tree that
  was pushed, and the one verdict the platform ENFORCED (only a green checkout opens a PR). A passing
  command's log is dropped and the section says so in as many words: ten green logs would cost the
  body budget that makes the failing one readable, and an unexplained empty tail would read as "the
  command printed nothing".

  **The reproduction proof** is reported as red-then-green or not at all. Only failing-on-the-pre-fix
  tree and passing-on-this-one is proof; anything else is `inconclusive`, stated plainly, with the
  producer's own diagnosis rendered verbatim rather than re-derived from the exit codes (a green
  pre-fix tree can mean the test misses the defect, or that a resumed run's base already carried this
  step's own work, and only the side that ran the two trees can tell those apart). A run whose bug
  genuinely cannot be reproduced in a test publishes the agent's structural declaration with its
  reason and what it verified instead, which is never the same thing as nobody having tried. The
  verdict also surfaces in the app, on both the result-window shell and the step-detail card. Both
  are needed, because the proof is recorded on whichever step opened the PR, and in every built-in
  pipeline that is the `coder`, a kind with no dedicated result view.

  **Captured artifacts are now reachable.** Each screenshot row carries a direct link to its bytes on
  the deployment's own authenticated blob endpoint, built from a new `apiBaseUrl` dependency
  (`PUBLIC_URL` on Node and local, `WORKER_PUBLIC_URL` on the Worker) rather than from the SPA origin
  beside it: the two coincide on a same-origin deployment and diverge the moment the SPA is served
  from its own host. The artifact id stays in the row (it is what an operator greps the store for),
  and a deployment that configures no backend URL gets the id with no link rather than a link to
  nowhere. The endpoint stays authenticated, so a report on a public repository does not make the
  bytes reachable by an unguessable URL.

  Two supporting changes. Untrusted text that reaches the body as CODE is now delimited by kernel
  helpers sized to what it carries: `hostMarkdown.outputBlock` for a captured log, and
  `codeCell` / `inlineCode` for a command, a path or a stored id. A fixed three-tick fence closes on
  the first backtick run a linter or a snapshot test prints, and everything after it (the rest of the
  log, the sections below, and the machine-readable JSON block) lands in the body as prose; the same
  hazard applies inline, where a value carrying a backtick closes its span and re-exposes the
  auto-link triggers the escapes skip inside code. And `pl_bugfix` gained a `repro-test` step before
  its `coder`, so the manual bugfix preset produces a red test before the fix regardless of this
  feature; the version bump offers the reseed to existing workspaces.

  `repro-test` is also now estimate-GATABLE, and deliberately not gated anywhere. It is the most
  expensive thing a small bugfix pays for (a container dispatch with a real checkout, a commit and a
  push) and the least likely to earn its keep on a one-line change, so an author who wants a trivial
  bug to skip it can now gate the step off a task estimate. No built-in preset does, because that
  would change what every existing bugfix run costs and drop the evidence on whichever tasks a model
  happened to score low. When a pipeline DOES gate it, the report names the skip as its own cause
  rather than reporting it as the phase never having been enabled.

  The report's JSON `version` goes to 5 for the two new sections and the artifact `url` field. The
  `coder.reproductionProof` tri-state is now a task-facing control, deferred until the behaviour it
  promises actually existed.

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0
  - @cat-factory/prompt-fragments@0.15.49

## 0.107.1

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0
  - @cat-factory/prompt-fragments@0.15.48

## 0.107.0

### Minor Changes

- 413095f: Let a model preset choose the ORDER a model's routes are preferred in, instead of one order compiled into the resolver.

  Which route a model takes was a deployment-wide constant, so a workspace could not have both a compliance preset pinned to a residency-guaranteed route (AWS Bedrock, whose selectability landed in the previous slice) and an everyday preset riding a flat-rate subscription. It is a per-WORKLOAD choice, so the knob is the preset row (`ModelPreset.providerPreference`) rather than a new env var, and it needs no migration of behaviour: a preset stating nothing resolves exactly as before.

  **A preference REORDERS, it never filters.** Routes a preset omits are appended in default order and tried last, so naming three routes cannot make a model whose only route is the fourth unresolvable. That is structural rather than a rule to remember: `orderedModelFlavorPreference` returns a total order over every route, which is also why the editor offers no way to REMOVE one. The write boundary refuses a repeated route (an order cannot say two things about one route) but accepts a partial list.

  **The order rides `ProviderCapabilities`, and it reaches a run by two paths because a capability set is resolved at two different times.** The START GUARD resolves one per run, so it now resolves under the block's own preset and walks each model's routes in the order the dispatch will. A DISPATCH has no capability set of its own — the facade's `resolveBlockModel` closes over the boot-time one — so the order arrives on `AgentRunContext.providerPreference`, resolved ONCE by the engine exactly like the prompt override and the output budget, and the facade folds it onto its captured capabilities per call. Folding rather than replacing is the point: which routes EXIST is a deployment fact (keys, the Bedrock allow-list, the Workers AI binding) and only the ORDER is per preset. Both ends read one preset row, so the guard, the container path, the inline path and the consensus panel cannot disagree about which provider a step ran on.

  **Eight inline callers each carried a byte-identical copy of the step precedence**, which is how a fact like this gets forgotten in seven places. The judge, the fork-decision chat, the iterative reviewers (with their brainstorm and clarity subclasses), the doc and initiative interviewers, the tester QC companion, the bug-hunt assessor and the Kaizen grader now share one `resolveInlineBlockModelRef`, and it takes the model and the route order as ONE dependency rather than two wired side by side. Kaizen is why: it resolved through a seam with no route-order parameter, so it would have taken the model half and silently ignored the other — a compliance preset getting its route for every inline call on a block except its grading.

  **The preset row is read on every dispatch, every inline call and every start guard, so it goes through the app cache seam.** `AppCaches.modelPreset` is the merge preset's `riskPolicy` slice one table over: same key shape (`picked:<id>` / `default`), same wrapped null so an unseeded workspace caches as a value, same invalidate-the-workspace-group on every `ModelPresetService` write, same pass-through on the Worker's isolate-safe profile. The model id and the route order are resolved from ONE read of that row (`resolvePresetRouting`), where asking two collaborators for them read it twice.

  **"Equals the default order" is stored as ABSENT, not as a copy of it.** Reordering back to the default clears the preference, so a preset keeps tracking the shipped order as the product changes it instead of pinning today's wording of it — which matters because that order is itself scheduled to change. For the same reason the default order now lives in ONE place, `DEFAULT_MODEL_FLAVOR_ORDER` in contracts: the preset editor renders the same fold the resolver walks, and a copy in the SPA would let the picker display an order the run does not take.

  Compatibility break to expect: none for existing rows (`provider_preference` is nullable and NULL means the default order), but a stored route the build no longer knows is DROPPED at the read boundary rather than named. That is the opposite disposition from a retired binary modality, and deliberate: the value names a route, so once the route is gone there is no current member a human could re-pick it as, and the surviving entries keep their relative order.

  One limit worth stating plainly: "subscriptions always win" is still applied ON TOP of this order, so on a workspace holding a subscription token a preset promoting AWS Bedrock is overruled for every dual-mode model. Folding that override into the order is the next slice; until then the preset editor warns rather than letting the copy promise a route a connected plan takes back.

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0
  - @cat-factory/prompt-fragments@0.15.47

## 0.106.8

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0
  - @cat-factory/prompt-fragments@0.15.46

## 0.106.7

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0
  - @cat-factory/prompt-fragments@0.15.45

## 0.106.6

### Patch Changes

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

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/kernel@0.221.1
  - @cat-factory/prompt-fragments@0.15.44

## 0.106.5

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/kernel@0.221.0
  - @cat-factory/prompt-fragments@0.15.43

## 0.106.4

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/kernel@0.220.0
  - @cat-factory/prompt-fragments@0.15.42

## 0.106.3

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0
  - @cat-factory/prompt-fragments@0.15.41

## 0.106.2

### Patch Changes

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

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0
  - @cat-factory/prompt-fragments@0.15.40

## 0.106.1

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0
  - @cat-factory/prompt-fragments@0.15.39

## 0.106.0

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
  - @cat-factory/prompt-fragments@0.15.38

## 0.105.0

### Minor Changes

- 233e279: Register generative binary integrations (image / music / video generation APIs) in a deployment's own code, and let binary-generating agent steps select them.

  `BinaryGeneratorRegistry` is a new app-owned registry beside the foundational-service one: an integration declares the content types it produces (`image | audio | video | 3d | document`), its media types, endpoint, API contracts and the credential it needs BY NAME. A step picks from it via `stepOptions.binaryOutput.generatorIds` and states the content types it must deliver via `.modalities`; run admission refuses an unregistered id or an uncovered content type under the new `binary_output_generator_invalid` conflict reason. The agent's `.cat-context/binary-output/brief.md` now leads with a Generation section describing each integration, and the credential value reaches only that job's agent process (job body `generatorSecrets`), never a prompt or the telemetry snapshot.

  All three facades take the registry as their own DI option (`binaryGeneratorRegistry`), so a deployment registers integrations on Node and local exactly as on the Worker, and each facade boot-validates the instance it was handed. A new `registry-seams` guard derives the app-owned registry set from `CoreDependencies` and holds each one to a declared route, so the next registry cannot land threaded on one runtime and inert on another.

  The SPA follows the shapes through: the binary-output step picker offers the generative selection (from the workspace snapshot's new `binaryGenerators`, identity only — never a credential key name) and mirrors both new refusals inline, and the report names the integration that produced each artifact plus any the deployment does not register.

  Breaking, pre-1.0: `PipelineStep.binaryOutputs` gains a required `unknownGenerators` array, so reports recorded before this change no longer parse — an affected step's declaration record is re-created on its next run. `ToolSecretResolver.resolve` takes a discriminated `subject` (`tool-server` | `binary-generator`) in place of `serverId`; a deployment implementing that port per workspace must update its signature, and one passing `allowKeys` to the env-backed default must extend the list to cover its integrations' credential keys or they resolve to nothing.

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0
  - @cat-factory/prompt-fragments@0.15.37

## 0.104.3

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/kernel@0.214.1
  - @cat-factory/prompt-fragments@0.15.36

## 0.104.2

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0

## 0.104.1

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0

## 0.104.0

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

- 4ac6960: Refresh the dependency tree — direct and transitive — to the latest versions that satisfy the `minimumReleaseAge` supply-chain gate, staying within each dependency's compatible major.

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.37 → ^7.0.47`, `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.2x → ^4.0.27`, `@ai-sdk/openai-compatible@^3.0.14 → ^3.0.20`, `@ai-sdk/provider@^4.0.3 → ^4.0.4`, `@ai-sdk/amazon-bedrock@^5.0.32 → ^5.0.40`.
  - **Runtime deps**: `pg-boss@^12.26.3 → ^12.26.4`, `@aws-sdk/client-s3@^3.1095.0 → ^3.1101.0`, `@nuxtjs/i18n@^10.5.0 → ^10.6.0`, `@vueuse/core@^14.3.0 → ^14.4.0`.
  - **Tooling**: `wrangler@^4.114.0 → ^4.118.0`, `@cloudflare/workers-types@^5.20260726.1 → ^5.20260801.1`, `oxlint@^1.75.0 → ^1.76.0`, `oxfmt@^0.60.0 → ^0.61.0`, `knip@^6.29.0 → ^6.31.0`, `turbo@^2.10.7 → ^2.10.8`, `vue-tsc@^3.3.8 → ^3.3.9`, `@playwright/test@^1.62.0 → ^1.62.1`, `@types/node@^26.1.1 → ^26.1.2`, `@types/pg@^8.20.0 → ^8.20.3`.

  No `minimumReleaseAgeExclude` entries were added: every bump above already satisfies the gate. The `@cat-factory/executor-harness` and `@cat-factory/deploy-harness` deps are deliberately untouched, since they feed the published runner images and bumping them is a separate image-bumping change. `hono`'s declared range therefore stays at `^4.12.32` (sherif requires one version workspace-wide, and the harness declares it) while the lockfile still resolves 4.12.33 within that range.

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/contracts@0.210.1
  - @cat-factory/prompt-fragments@0.15.35

## 0.103.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0

## 0.102.0

### Minor Changes

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
  - @cat-factory/prompt-fragments@0.15.34

## 0.101.0

### Minor Changes

- 0a1170e: Fix a `folder`-mode foundational source retiring a live service on the strength of directories it
  declined to list, and report what a scan actually covered.

  The zero-contract disposition tested whether the scan found candidates. A walk stopped by a cap
  before it reached ANY candidate — a recursive link over a wide tree whose specs sit below the
  visited prefix — reports exactly that, so it read as "this folder holds no contracts", tombstoned
  the service and pinned the commit, which kept it retired until the folder changed again. The test
  is now whether the walk had the COVERAGE to conclude anything: absence of evidence is transient
  (keep the prior row, leave the pin), while a truncated pass that DID produce contracts still pins.

  The sync result's `truncated` boolean is replaced by `folderScan`: `complete` / `truncated` /
  `missing`, null for the modes that walk nothing. `missing` is a new third answer — git cannot store
  an empty directory, so an empty root listing means the folder is gone rather than empty, and the
  two need opposite reactions from whoever linked it. A never-synced link whose head probe finds no
  commit for its path reports it too, so a mistyped folder no longer syncs "successfully" forever.
  Both non-`complete` outcomes are logged, which is the only standing signal an autorefresh leaves.

  Two bounds keep an unbounded discovery honest. Package, lockfile and compiler manifests are no
  longer contract candidates, so a folder scan's file budget is not spent on `package.json` before
  the walk reaches the specs. A candidate larger than the host contents API's own 1 MiB ceiling is
  declined unread — above that the read returns an empty body anyway — and counted as skipped rather
  than dropped in silence. Each skipped candidate is now also named in the log with its reason; a
  duplicate contract id was previously undiagnosable, since the losing document is absent under a
  name that is present.

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0
  - @cat-factory/prompt-fragments@0.15.33

## 0.100.0

### Minor Changes

- d320539: Add a `folder` mode to foundational-service repo sources: link a whole repo FOLDER — optionally
  including its subfolders — as the contract set of the ONE service the link names. It joins the
  existing `directory` (one service per subdirectory) and `files` (an explicit path list) modes.

  The point is WHEN the file set is decided. A `files` link pins the paths, so a contract added
  upstream stays invisible until somebody edits the link; a `folder` link re-discovers the set on
  every sync, which is what a spec directory that grows actually needs. Freshness still costs one
  head-commit read against the folder, and the walk only runs once that read says the commit moved.

  The walk is bounded (depth, directories listed, contract files taken) and breadth-first over
  name-sorted listings, so the result is deterministic across syncs and the cap falls on the
  deepest, least-specific files rather than on a root-level `openapi.yaml`. A truncation is
  reported on the sync result rather than treated as a transient failure, because holding the
  pinned commit back would make the next pass truncate identically while the source looked
  permanently behind. An EMPTY folder is stable for the same reason and pins the same way: a folder
  under which nothing even looked like a contract retires its service, exactly as a directory that
  lost its `service.md` does, while a folder whose candidates all read back unusable is the
  transient case that keeps the prior row and leaves the pin behind. The listings and contract
  bodies a walk needs are fetched with bounded concurrency rather than one round trip at a time,
  which is what keeps a deep subtree's sync to seconds. Contract ids in a `folder` source come from the path RELATIVE to the folder
  root (`v1/users.yaml` → `v1-users`): the basename rule the other modes use would collapse
  `v1/users.yaml` and `v2/users.yaml` onto one id and silently drop one of them. An optional
  `service.md` at the folder root supplies the description and capability tags, never the id or
  name — the link already gave those, so identity keeps exactly one source.

  Two changes reach the existing modes. The sync result gains `skippedFiles` and `truncated`, so a
  link that produced fewer contracts than its author expected has an explanation available to them;
  `skippedFiles` counts only files that LOOKED like contracts (an OpenAPI or contract-module
  extension) and were not usable. And files with no contract extension are no longer fetched at all
  before being discarded, which removes a read per README sitting beside a service's specs.

  Compatibility: `FoundationalServiceSourceRecord` and the source wire shape gain a required
  `recursive` field, backed by a new column on both stores (D1 migration `0075`, the matching
  Drizzle migration). Existing rows take `false`, which is the only value the other two modes can
  honestly carry.

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0
  - @cat-factory/prompt-fragments@0.15.32

## 0.99.0

### Minor Changes

- 9e5f785: Add binary-output agent steps: a kind carrying the new `binary-output` trait (image generation is
  the canonical example) generates binary artifacts and stores them through a FOUNDATIONAL SERVICE
  its step selects from the workspace catalog (`stepOptions.binaryOutput.storageServiceId`, which
  must carry the `asset-storage` capability tag), consulting further selected catalog services for
  the SCOPE of the generation — what entities exist, which lack an asset, how each is described
  (`contextServiceIds`).

  The engine injects a `.cat-context/binary-output/` brief naming the selected services plus their
  API contracts, refuses at pipeline save and run admission a generator step whose selection is
  missing or does not resolve (`binary_output_service_invalid`), and records the agent's
  machine-readable declaration of what it stored — with every loss bookkept (undeclared /
  parse-failed / invalid / omitted / unknown service ids) — onto `PipelineStep.binaryOutputs`.
  No built-in kind carries the trait; a deployment's generator opts in via
  `registerAgentKind({ traits: ['binary-output'] })`.

  Two behaviour changes reach existing code. A declaration block is now found by the shared
  `extractFencedDeclaration`, which takes the LAST matching block rather than the first — the
  guidance asks agents to END their reply with it, and a model that illustrates the shape earlier
  had its example parsed instead of its answer. This applies to the FOUNDATIONAL-SERVICES
  declaration too, which reads through the same helper: an architect whose reply showed an example
  block before its real one now has the real one recorded. And the whole-catalog storage capability
  tag is `asset-storage`, deliberately distinct from the agents package's `binary-storage` TRAIT
  (which marks a kind needing the platform's own artifact store for run evidence) — the two meant
  opposite things about opposite subjects while sharing one literal.

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0
  - @cat-factory/prompt-fragments@0.15.31

## 0.98.0

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
  - @cat-factory/contracts@0.206.1
  - @cat-factory/prompt-fragments@0.15.30

## 0.97.0

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
  - @cat-factory/prompt-fragments@0.15.29

## 0.96.1

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0
  - @cat-factory/prompt-fragments@0.15.28

## 0.96.0

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
  - @cat-factory/prompt-fragments@0.15.27

## 0.95.1

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0

## 0.95.0

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

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/contracts@0.203.0
  - @cat-factory/kernel@0.201.1
  - @cat-factory/prompt-fragments@0.15.26

## 0.94.0

### Minor Changes

- 8c40f33: Record an inline harness-CLI step's model calls PER CALL and LIVE, instead of one lumped row at exit.

  A local-mode document run reported **0 model calls for eight minutes** and then, when it was killed,
  **one row of zero tokens** beside a failure message stating it had burned 896.7k. Both readings came
  from the same cause: an inline step served by a harness CLI is not one model call. `doc-researcher`
  on a host `claude` login runs a whole tool loop — a measured run made 16 calls over 8 minutes —
  behind ONE `doGenerate`, and the instrumentation middleware wrapped around that boundary can only
  ever see the boundary.

  Three consequences, each a different way of being wrong about the same run:

  - **One row for sixteen calls.** `message_count` 2 and `tool_count` 0 on a row whose loop used tools
    throughout, `total_ms` 497316 for "one call", and the fifteen intermediate turns' bodies nowhere.
    The container inline transport dropped its per-call metrics for the same reason: nothing on
    `InlineCliResult` could carry them.
  - **Nothing at all until the subprocess exits.** `wrapGenerate` is a post-hoc hook with no
    `wrapStream` sibling, and the spawn settles only in `child.on('close')`. So the run was dark for
    its whole duration — precisely when someone is watching it.
  - **Zeros whenever it was killed.** The middleware's error path has no usage to attach (a rejection
    carries none), so the row read `total_tokens 0`. What the run spent survived only inside the free
    text of `error_message`, through a deliberately lossy formatter — `896.7k` is not recoverable as an
    integer even in principle.

  **The model now files its own calls, and the middleware stands down.** `CliInlineLanguageModel` takes
  the facade's `InlineLlmCallRecorder` and records each call the CLI reports the moment it arrives, then
  declares `reportsOwnLlmCalls` so `InstrumentedModelProvider` returns it unwrapped — two producers for
  one call would double every token in the step's rollup, and of the two the middleware's is the less
  truthful. The model is ASKED rather than a facade told, because the instrumentation is composed
  OUTSIDE the wrap that substitutes the model (it has to be, or it sees nothing that wrap serves) and
  cannot know what the inner wrap returned.

  **The per-call fold is imported, not re-implemented.** Claude Code emits one envelope per content
  BLOCK, each repeating that call's usage, so folding by `message.id` first is the difference between 31
  calls and 117 — a measured 1.47M tokens inflated to 5.53M. The container harness had already solved
  that, along with the prompt-transcript reconstruction and the routing of subagent turns off the
  parent's chain; local carried a lesser copy of only the usage half, which is exactly why the two
  paths disagreed about how many calls a step had made. `@cat-factory/executor-harness` now exports
  that fold as the `./claude-call-aggregator` subpath and local drives it, so there is ONE
  implementation.

  **Sharing it made the backend a second DRIVER of a reconstruction that had only ever run in a
  container**, and two of its properties are memory rules there rather than niceties. The transcript is
  retained only to `MAX_TRANSCRIPT_CHARS` (512 KiB, the store's own body cap — past that the retention
  could only ever be thrown away), stating what it stopped retaining rather than ending mid-conversation;
  and assembling bodies at all is a switch, off when `LLM_RECORD_PROMPTS` is. Unlike every other body,
  these are BUILT rather than merely passed as a thunk — the growing history, re-serialised per call — so
  a body the store will drop has to be refused at the source. Unbounded, this is the same fault
  `OUTPUT_TAIL_RETAIN_CHARS` already refuses one screen away: hundreds of MB parked in the orchestrator
  process, on precisely the runs worth diagnosing.

  Also: the tag-then-scope attribution precedence is now one shared `resolveInlineAttribution`, since
  two producers apply it; `InlineLlmCall` carries an optional `turnIndex`, real for a harness-CLI call
  and absent for a plain `generateText`; every row names the model the CLI says SERVED that call
  (`call.model ?? requested`, as `makeHarnessCallRecorder` already did — cost is derived per row from
  `(model, token classes)`, and a CLI serves some calls with a cheaper model of its own); and
  `ModelProviderResolverWrapDeps.recordInlineCall` is required-but-nullable, so a facade that FORGOT it
  fails at typecheck rather than shipping a deployment that silently reports no model activity.

  Degradations are stated rather than papered over. The step-level row carries the SHORTFALL — the
  terminal cumulative usage minus what the per-call rows accounted for — which covers three cases with
  one rule: a CLI that narrates nothing (`codex exec`) gets the single row the SDK boundary knows, a
  fully-narrated step gets none (one there would double every token), and a PART-narrated step gets the
  remainder rather than losing it. That last case is why it is a shortfall and not a lump: an older CLI
  build, or a turn that errored before reporting usage, leaves a step whose uncosted turns would
  otherwise simply vanish. An uncosted turn is never filed as a zero-token row, and that rule lives with
  the model, so it holds for the host CLI's stream and a container job's terminal metrics alike. A killed
  step still gets one `ok: false` row at the ordinal after its last completed call, with zero tokens,
  which is now TRUE of it: it stands for the interrupted call, and everything the run really spent is
  already on record. Every fold step is isolated, because the reader runs inside the spawn's `stdout`
  listener and its flush on the killed path runs BEFORE the failure is enriched with the burn clause.

  **Deliberately still open:** the spend LEDGER. `token_usage` is written from the agent result on the
  success path only, so a failed step writes no ledger row on either transport and the budget rollups
  stay blind to what it burned. Closing that needs the failure-path recording seam in orchestration,
  covering the container path in the same change — not a fourth pass over the inline provider.

  `@cat-factory/executor-harness` now emits declarations (`declaration: true`), because the new subpath
  is a `dist` import rather than the compile-only source `./embed` is.

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/kernel@0.201.0

## 0.93.0

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
  - @cat-factory/prompt-fragments@0.15.25

## 0.92.0

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

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0
  - @cat-factory/prompt-fragments@0.15.24

## 0.91.0

### Minor Changes

- d9789f9: Replace the seven near-identical build presets with a three-rung build ladder, and generalise
  estimate gating past companions so one pipeline can cover the range that used to need several.

  The ladder varies the one axis anyone actually chose a build pipeline on — how much design a task
  gets. **Standard build** (`pl_build`, the new default) is design → challenge the design → implement
  → review → verify → guards → merge, every step unconditional. **Simple build** (`pl_simple`) drops
  the design phase for trivial work. **Adaptive build** (`pl_full`) runs a `task-estimator` first and
  switches its own `architect` / `tester-api` / `human-review` steps on from the estimate.

  Estimate gating is now a declared per-kind capability (`isGatableKind`) rather than a
  companion-only special case: any step whose output later steps read as context may be gated, while
  one some other mechanism reads structurally (`merger`, `deployer`, `conflicts`/`ci`, `bug-intake`)
  may not. A skipped producer cascades onto its review companion, and a step may no longer carry both
  a human approval gate and an estimate gate — the estimate may add a human checkpoint, never cancel
  one.

  The gatable-kind vocabulary is exported from `@cat-factory/contracts` (`BUILTIN_GATABLE_KINDS` /
  `isBuiltinGatableKind`) because two surfaces in different packages must answer identically: the
  engine's shape validation and the SPA's pipeline-health advisory, which re-derives the same verdict
  client-side. `isGatableKind` in `@cat-factory/agents` remains the registry-aware form a deployment's
  own kind overrides through.

  Pickers are scoped to the task's use-case: a `feature`/`bug` task no longer offers the
  document-authoring, PR-review or planning presets, and a new block-level rule keeps the planning
  presets on initiative blocks (they were previously offered on every task and then refused at start).
  An UNCLASSIFIED pipeline — one with no `purpose`, which the builder leaves unset by default — stays
  visible on a `feature`/`bug` task, so a workspace's own hand-built pipelines are unaffected.

  **Breaking:** six built-in pipelines are retired — `pl_quick`, `pl_dep_update`, `pl_pr_review`,
  `pl_human_review`, `pl_fullstack` and `pl_integrate`. Each is tombstoned with a replacement, so an
  already-seeded workspace gets the "retired — remove it" advisory naming where to go instead; a task
  pinned to one will need repointing. `pl_simple` is redefined (`mocker` dropped) and `pl_full`
  reshaped, both version-bumped, so existing workspaces are offered a reseed. `pl_integrate` is
  removed rather than replaced because it carried no merge tail at all, which meant its coder-class
  `integrator` committed straight to the base branch with no conflicts check and no CI.

  Two further consequences worth knowing before upgrading. A retired pipeline that a recurring
  SCHEDULE still points at cannot be deleted (that refusal is unchanged and deliberate), so acting on
  its advisory means repointing the schedule first. And because a step may no longer carry both a human
  approval gate and an estimate gate, a workspace pipeline that already carries both — only reachable
  by having added estimate gating to a human-gated companion, as a `pl_fullstack` clone allowed — is
  now refused at save and at run start until one of the two is dropped.

  Retiring `pl_fullstack` also removes the last built-in preset carrying `playwright`, `researcher`,
  `documenter`, `spec-companion`, `human-test` and the two brainstorm dialogues. All remain available
  as steps in the pipeline builder; none is now in a shipped preset, so a task's agent-config catalog
  surfaces a contributing kind's settings (e.g. `playwright.e2eTarget`) only once some pipeline in the
  workspace actually uses that kind.

  The `dep-update` recurring-schedule template is no longer inferred from a pipeline id (its pipeline
  was the ordinary build tail under a recurring name); the template value remains for explicit API
  callers.

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/contracts@0.200.0
  - @cat-factory/prompt-fragments@0.15.23

## 0.90.0

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
  - @cat-factory/contracts@0.199.0
  - @cat-factory/kernel@0.197.0
  - @cat-factory/prompt-fragments@0.15.22

## 0.89.1

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0
  - @cat-factory/prompt-fragments@0.15.21

## 0.89.0

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

## 0.88.0

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
  - @cat-factory/kernel@0.194.0

## 0.87.2

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0
  - @cat-factory/prompt-fragments@0.15.20

## 0.87.1

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0
  - @cat-factory/prompt-fragments@0.15.19

## 0.87.0

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

- 449d856: Classify agent kinds into three tiers (`basic` / `intermediate` / `advanced`) and open the two
  surfaces that enumerate the whole catalog — the pipeline builder's palette and a model preset's
  per-agent overrides — on the basic tier, with a control on each to widen the view.

  Both surfaces listed every kind the deployment knows about: ~30 palette blocks across six
  categories, and a per-agent override row for each of those plus the engine kinds that run a model.
  That is the full roster for someone assembling their first pipeline, and the everyday kinds
  (architect, coder, tester, documenter) are scattered through it. The tier is the axis that was
  missing — categories say what a kind is FOR, not how far off the main path it sits.

  Tiers are CUMULATIVE, which is the main decision to sanity-check: the control is a level dial
  (`basic` → `intermediate` → `advanced`), not a set of exclusive filters, so the widest level shows
  the entire catalog and there is no separate "show all" option that would duplicate it. Exclusive
  filters were rejected because a real pipeline mixes tiers — reaching for one specialist kind should
  not hide the coder while you do it.

  The vocabulary, the default and the predicate live in `@cat-factory/contracts` beside
  `purposeAllowsAgentCategory`, so a deployment-registered kind's declared `presentation.tier` and the
  SPA's own built-ins are read by one rule. A kind that declares no tier is treated as `intermediate`:
  `basic` would let anything unclassified into the default view, and `advanced` would bury a kind a
  deployment deliberately installed. Built-ins are not allowed that freedom — `catalog.spec.ts` fails
  if one forgets its tier, since the silent outcome would be it vanishing from the default view for
  no stated reason.

  Two things worth looking at when reviewing. The model-preset list always keeps a kind the edited
  preset already pins a model for, whatever the tier — that override may have been written by a
  teammate, by the API, or by this user at a wider tier, and a hidden row is one they can neither read
  nor clear (the rule `showOverrideField` already states for a single field). And this is deliberately
  NOT the basic/advanced interface mode: that tier decides which surfaces exist, this one decides how
  much of one surface's catalog is listed, so the axes stay separate and the tier control is visible
  in both interface modes — it is the only route to what it hides.

  Compatibility note: `post-release-health` is tiered `intermediate` rather than `advanced` even
  though it is the most specialist gate, because the palette already offers it only once an
  observability integration is connected, and that connection is a stronger statement of intent than
  the tier.

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0
  - @cat-factory/prompt-fragments@0.15.18

## 0.86.0

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

## 0.85.0

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
  - @cat-factory/prompt-fragments@0.15.17

## 0.84.2

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0
  - @cat-factory/prompt-fragments@0.15.16

## 0.84.1

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0
  - @cat-factory/prompt-fragments@0.15.15

## 0.84.0

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
  - @cat-factory/prompt-fragments@0.15.14

## 0.83.1

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/kernel@0.185.1
  - @cat-factory/prompt-fragments@0.15.13

## 0.83.0

### Minor Changes

- 1fa8ef7: Initiative planning now explores the repository BEFORE it interviews you.

  `pl_initiative` ran `initiative-interviewer → initiative-analyst → …`, but the interviewer is an
  inline kind with no checkout — so the only source it could reach for was the human, and it spent
  its bounded rounds asking stakeholders to describe their own codebase (what frameworks are in use,
  how a module is laid out, what test coverage exists) while the agent that could have read all of it
  waited behind the park. The steps are reordered to `initiative-analyst → initiative-interviewer →
initiative-planner (gate) → initiative-committer`, and the analysis is folded into the interviewer's
  prompt with an explicit ban on re-asking anything it settles.

  Behaviour changes worth knowing about:

  - The analyst container starts before the human is asked anything, so an initiative abandoned mid
    interview has already paid for one read-only exploration.
  - The analyst now closes its report with an `## Open questions` section naming only what the code
    cannot settle; that section is the interview's agenda.
  - The interview is restricted to what no amount of code reading recovers: intent, priorities, risk
    and downtime tolerance, deadlines, external commitments, and choices the code permits equally.
    The "recommend an answer" action is grounded in the analysis too.
  - That restriction is a rule about where an ANSWER comes from, so it now lifts when there is no
    analysis to lean on (an unreachable repo, an analyst that produced nothing, the gate driven
    outside `pl_initiative`): the interviewer is told the repository was NOT read and may ask about
    it again, with the human-only facts still first. The ban and the analysis fold share one
    predicate, so the role prompt can never promise a reading the task prompt does not carry.
  - `pl_initiative` is reseeded (version 5) with a new description. `pl_initiative_docs` keeps its
    steps — it never had an interviewer and already led with the analyst — but the shared analyst
    kind now learns from the running chain whether an interview actually follows it
    (`AgentRunContext.initiative.interviewFollows`) and states the matching reason to read
    exhaustively. Asserting "a stakeholder is interviewed after you" unconditionally would be false
    on every interview-less planning pipeline, including a deployment's own.
  - The technological-migration preset's interviewer steering no longer asks for the operational
    surface (scheduled jobs, ops tooling, monitoring, CI); its analyst already inventories that.
  - Both interview windows (initiative planning, document authoring) gained a `preparing` state.
    Neither gate leads its pipeline, so a running run used to read as "the interviewer is working on
    your answers" for the whole of a lead-in the human had not answered anything into — now the
    window says what is actually happening and the "Planning in progress" route into it stays
    available throughout.

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0

## 0.82.4

### Patch Changes

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

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0

## 0.82.3

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0
  - @cat-factory/prompt-fragments@0.15.12

## 0.82.2

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0
  - @cat-factory/prompt-fragments@0.15.11

## 0.82.1

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0
  - @cat-factory/prompt-fragments@0.15.10

## 0.82.0

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

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0

## 0.81.1

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0
  - @cat-factory/prompt-fragments@0.15.9

## 0.81.0

### Minor Changes

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

- 8a9f311: Let an initiative carry linked context documents and tracker issues, and put them in front of the
  whole planning pipeline.

  Requirements, RFCs, PRDs and tracker issues can now be attached while CREATING an initiative — the
  same staged picker the add-task flow uses, extracted into a shared `ContextAttachmentFields` so the
  two surfaces cannot drift. Attachments are linked once the initiative block exists.

  The backend gap this closes is that the engine already RESOLVED a block's attachments for initiative
  blocks (an initiative is anchored to an ordinary block) and the container already materialised them
  under `.cat-context/` — but the initiative agent kinds build their own user prompts and so returned
  before the generic `linkedContextSection` fold. The analyst and planner had the files on disk with
  nothing telling them the files existed, and `initiative-breakdown`'s system prompt told it to reason
  from "any linked context" the user prompt never supplied. All three now fold it in, each in the form
  matching its surface (index + `.cat-context/` pointer for the container kinds, inlined bodies for the
  inline one).

  The interviewer needed wiring rather than a fold: it is an inline service that never passes through
  `AgentContextBuilder`. `resolveLinkedContext` moved out of the builder into its own module and both
  paths now share it, so the interviewer can never see a different set of attachments than the analyst
  and planner that follow it. It is also told to treat what an attachment settles as already answered,
  which is the point of attaching a PRD — otherwise the stakeholder is interrogated about exactly the
  facts the document they attached already states.

  Attachments are still only editable at create time; the inspector's context panels remain task-only.
  Pasting a document URL or issue key into the initiative's goal text reaches the planning agents too,
  so an initiative created without attachments is not a dead end.

### Patch Changes

- Updated dependencies [9d965c9]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0
  - @cat-factory/prompt-fragments@0.15.8

## 0.80.1

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0
  - @cat-factory/prompt-fragments@0.15.7

## 0.80.0

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
  - @cat-factory/contracts@0.183.0
  - @cat-factory/kernel@0.176.0
  - @cat-factory/prompt-fragments@0.15.6

## 0.79.0

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
  - @cat-factory/prompt-fragments@0.15.5

## 0.78.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0
  - @cat-factory/prompt-fragments@0.15.4

## 0.77.1

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0
  - @cat-factory/prompt-fragments@0.15.3

## 0.77.0

### Minor Changes

- a04f609: Confine the requirements-review stage to the product / business layer.

  The reviewer was routinely raising technical design questions — which library to use, how to shape
  an endpoint, whether to cache — and the incorporation editor was writing the resulting decisions
  into the standardized requirements document. Both ask a product owner something they cannot answer,
  bury the questions only they can, and pre-empt the `architect` and `researcher` steps, which settle
  the technical layer later with the repository and the in-repo `tech-spec/` in hand.

  All three prompts of the flow (reviewer, incorporation editor, Requirement Writer) now fold in one
  shared scope-boundary block: what is in scope (behaviour, business rules, actors and permissions,
  data meaning, scope boundaries, quality expressed as a business outcome), what is out (technology
  choice, architecture, API and schema shape, algorithms, performance technique, infrastructure,
  coding and test approach), and the test to apply to each point — could a product owner who does not
  read code settle it from business knowledge alone? The matching user prompts restate it, since they
  land last in context and carry the output contract. Two behaviour notes: a technical concern is now
  dropped outright rather than kept at a low severity, and raising no findings at all is stated as the
  expected outcome for purely technical work.

  Prompt versions bumped together: `requirement-review@v4`, `requirement-rework@v3`,
  `requirement-writer@v3`.

## 0.76.0

### Minor Changes

- 68f0edd: Add the Bug hunt: pick a connected tracker and one of its boards, get its open and unassigned bugs
  rated on impact against implementation complexity, and confirm one candidate to adopt it as a bug
  task running the standard bug-fix pipeline. The interactive counterpart of the recurring bug-triage
  schedule; it persists nothing of its own.

### Patch Changes

- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0
  - @cat-factory/prompt-fragments@0.15.2

## 0.75.2

### Patch Changes

- 3260f2d: Record one `llm_call_metrics` row per model call instead of per stream envelope, and bound what a pr-review slice carries.

## 0.75.1

### Patch Changes

- 15905ab: Fix the PR deep-review's live slice list collapsing, and bound how many slice subagents run at once.

  - **The plan and the subagent dispatches are MERGED, not picked between.** The harness derives slice progress from two views of the same slicing: the parent's task list (the inventory, and the only place a not-yet-dispatched slice is named) and the `Agent`/`Task` dispatches (the live status). `pickProgress` chose whichever looked further along, so the moment the first subagent returned the dispatch view won on `completed` and the rendered list collapsed to the slices dispatched so far — every queued slice vanished from the window and reappeared one at a time as it was picked up. `mergeProgress` folds the dispatch statuses ONTO the plan's inventory instead: paired by normalised slice name, then positionally into the leftover pending entries, with an unpairable dispatch appended rather than dropped. The list can only grow, and a status can only advance.
  - **At most 5 slice subagents in flight.** The fan-out was unbounded, and a large PR slices into dozens: every one is a concurrent conversation on the same account, so a full-width wave buys rate-limiting rather than speed and lands all the findings in one burst at the end. This is a prompt-level budget (the CLI owns tool dispatch, so the harness can observe the in-flight count but cannot refuse a call). The reviewer is also told to mark a slice's task entry in progress on dispatch and completed on return, and to name the dispatch after the slice's task entry so the two views pair cleanly.
  - **The "Reviewing now" callout stays mounted for the whole reviewing phase.** With a bounded window there are moments between two waves when nothing is in flight; dropping the callout there made the window look like it had lost one of its two lists.

- Updated dependencies [9d8fe9b]
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0
  - @cat-factory/prompt-fragments@0.15.1

## 0.75.0

### Minor Changes

- cf2779a: Cut coder token/quota burn and fix subscription usage attribution.

  - **Two-tier best-practice fragments.** `PromptFragment` gains an optional `brief` body; a new `brief-standards` trait marks the high-turn code-writing implementer kinds (coder, fixer, ci-fixer, conflict-resolver) so their system prompt — re-sent on every turn of a long agentic loop — folds the condensed standard instead of the full body. Reviewer/planner kinds keep the full text. The brief is resolved ALONGSIDE the body it condenses and never re-looked-up by id, so a workspace/account-tier row that overrides a built-in id folds its own full body rather than the built-in's condensed text. Backward-safe: no `brief` / unmarked kind ⇒ the full body, unchanged. `brief` authored for every built-in fragment that can reach an implementer kind (node, react, design, migration).
  - **No-progress guard on the claude-code path.** The `ProgressGuard` that killed rabbit-holing Pi runs (no-edit probing, error-retry loops, web rabbit-holes) now also runs on the claude-code subscription harness, which previously had only the wall-clock watchdog. Its no-edit exploration allowance scales with the task-estimator's complexity when an estimator ran (conservative default otherwise), so it only ever catches absolute spiralling and never truncates a productively-editing run. Subagent dispatches (`Agent`/`Task`) are neutral to the no-edit bound, since the edits they make are invisible on the parent stream.
  - **Trimmed always-on prompt bloat.** The harness no longer appends its own spec-reading block (deduped — it now comes solely from the backend `spec-aware` trait, so a spec-aware Pi run stops carrying it twice); the blueprint orientation note is included only when the checkout (or, for a multi-repo run, one of its legs) actually ships `blueprints/`; and the spec-reading guidance now steers agents to the overview index and the relevant-and-adjacent shards in one line.
  - **Fix subscription token-usage attribution.** A container/subscription step's `token_usage` row recorded `provider='unknown'` / `model=''` because the durable poll path rebuilt a stripped job handle without the dispatch model. It now forwards `step.model`, so the row records the real provider + model.

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/prompt-fragments@0.15.0
  - @cat-factory/kernel@0.170.0

## 0.74.1

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0
  - @cat-factory/prompt-fragments@0.14.24

## 0.74.0

### Minor Changes

- fb71506: Pipeline-opened pull requests now carry a reviewer briefing instead of the barebones dispatch-time text.

  A PR-opening coding agent is asked (via the new `PR_DESCRIPTION_GUIDANCE` appended to its system prompt) to end its run by writing a reviewer-facing description — the problem, the decisions made and alternatives rejected, what to look out for — to a `.cat-pr-description.md` sentinel at the checkout root (one per sibling repo in a multi-repo run, plus the workspace root as a fallback for the primary; an optional leading `# <title>` line sets the PR title when it is the file's only `#` heading, so an agent using `#` for its section headings does not rename the PR to "Problem"). The harness lifts it (secret-scrubbed, size-capped with a visible truncation note, managed-report markers stripped, kept out of the commit) onto the PR it opens, falling back to the dispatch-time text when the agent wrote none.

  A RESUMED run — whose PR is already open, so the create call answers 422 — now refreshes that PR's title and description in place, carrying the engine's managed verification-report region across. Only a real agent briefing refreshes; the generic fallback never does, so an edit a human made to a description is not clobbered.

  Because the briefing is model-authored text landing on a host-parsed surface, it crosses a text boundary first: the harness carries a conformity-pinned copy of kernel's `hostMarkdown`, defusing issue references, account mentions and issue-closing keywords, and closing any code fence the briefing left open (an unbalanced one would otherwise swallow the verification report appended to the same body). The briefing's size budget leaves that report room under the host's body limit.

  The dispatch-time fallback (`prBody`) is itself restructured as a briefing: the task, the human-chosen implementation approach with rejected alternatives when the fork-decision phase ran, and an explicit marker that no agent briefing exists — with each untrusted hole rendered through `hostMarkdown`.

## 0.73.2

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0
  - @cat-factory/prompt-fragments@0.14.23

## 0.73.1

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/kernel@0.167.1
  - @cat-factory/prompt-fragments@0.14.22

## 0.73.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/kernel@0.167.0
  - @cat-factory/prompt-fragments@0.14.21

## 0.72.3

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0
  - @cat-factory/prompt-fragments@0.14.20

## 0.72.2

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1

## 0.72.1

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0
  - @cat-factory/prompt-fragments@0.14.19

## 0.72.0

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
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0
  - @cat-factory/prompt-fragments@0.14.18

## 0.71.0

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
  - @cat-factory/contracts@0.169.0
  - @cat-factory/kernel@0.163.1
  - @cat-factory/prompt-fragments@0.14.17

## 0.70.1

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

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/kernel@0.163.0

## 0.70.0

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
  - @cat-factory/contracts@0.168.0
  - @cat-factory/kernel@0.162.0
  - @cat-factory/prompt-fragments@0.14.16

## 0.69.10

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0
  - @cat-factory/prompt-fragments@0.14.15

## 0.69.9

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0
  - @cat-factory/prompt-fragments@0.14.14

## 0.69.8

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/kernel@0.159.1
  - @cat-factory/prompt-fragments@0.14.13

## 0.69.7

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0

## 0.69.6

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0
  - @cat-factory/prompt-fragments@0.14.12

## 0.69.5

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0
  - @cat-factory/prompt-fragments@0.14.11

## 0.69.4

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0
  - @cat-factory/prompt-fragments@0.14.10

## 0.69.3

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0
  - @cat-factory/prompt-fragments@0.14.9

## 0.69.2

### Patch Changes

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
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/contracts@0.160.1
  - @cat-factory/prompt-fragments@0.14.8

## 0.69.1

### Patch Changes

- 770f926: Upgrade the Vercel AI SDK family to v7 (paired with `workers-ai-provider@4`) and refresh the rest of the dependency tree within the supply-chain release-age gate.

  - **AI SDK v7 / Cloudflare Workers AI**: `ai@^6 → ^7`, `@ai-sdk/openai`/`@ai-sdk/anthropic`/`@ai-sdk/provider` `^3/^4 → ^4`, `@ai-sdk/openai-compatible@^2 → ^3`, `@ai-sdk/amazon-bedrock@^4 → ^5`, and `workers-ai-provider@^3 → ^4`. This is now possible because `workers-ai-provider@4` accepts `ai@^7` peers, lifting the pin that previously held the family at v6. The only code change required is reading the AI SDK v7 usage shape (`usage.inputTokenDetails.cacheReadTokens` in place of the removed `usage.cachedInputTokens`).
  - **Dependency sweep**: within-range refresh of the tree plus targeted bumps of `@cloudflare/workers-types@^4 → ^5` (aligns with the `wrangler@4` peer), `@opentelemetry/exporter-*-otlp-http@^0.220 → ^0.221` (lockstep with the `@opentelemetry/*@2.10` SDKs), and `oxfmt`, `undici`, `pg-boss`, `@nuxtjs/i18n`, `happy-dom`, `vue-tsc`, `wrangler` and others to their latest release-age-compliant versions. The `@cat-factory/executor-harness` runner-image deps are deliberately untouched.

- Updated dependencies [770f926]
  - @cat-factory/kernel@0.154.1

## 0.69.0

### Minor Changes

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

## 0.68.4

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0
  - @cat-factory/prompt-fragments@0.14.7

## 0.68.3

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0
  - @cat-factory/prompt-fragments@0.14.6

## 0.68.2

### Patch Changes

- 8254367: Lint tightening: ratchet oxlint `complexity` from 40 to its step-2 target of 30.

  Refactored every function above complexity 30 along cohesive, behaviour-neutral seams (helper
  extractions / options-object bundles), including the god-file offenders: the Worker
  `buildContainer` registry resolution → a `container-registries.ts` sibling, `RunDispatcher`'s
  settled-poll branch tree → a new `PollCompletionController`, and `ExecutionService.stepInstance`'s
  re-entrancy predicate → a `reentrancy.logic.ts` sibling (both of which also shrink their host
  god-files). The executor-harness image tag is bumped (harness `src/**` changed).

## 0.68.1

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0
  - @cat-factory/prompt-fragments@0.14.5

## 0.68.0

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
  - @cat-factory/prompt-fragments@0.14.4

## 0.67.9

### Patch Changes

- da0b83b: fix(pr-review observability): close ADR 0027 Defect A + Defect B for the parallel-subagent shape

  Both mechanisms ADR 0026 shipped for a `Task`-parallelised PR review were defeated on the exact
  shape they targeted. ADR 0027 confirmed the root causes; this closes them.

  - **Defect A — subagent token usage never counted.** The watcher was pointed at
    `<configHome>/subagents`, which the Claude CLI never creates — it writes each parallel subagent's
    transcript per-session under `<configHome>/projects/<encoded-cwd>/<session-uuid>/subagents/*.jsonl`.
    `startSubagentWatcher` now takes the `projects` root and DISCOVERS the `subagents/` dirs by walking
    (the session uuid isn't known before the CLI mints it), summing every `subagents/*.jsonl` turn's
    usage while deliberately EXCLUDING the sibling parent session transcript (whose usage the terminal
    `result` event already totals) so the parent is never double-counted. A harness fixture test now
    lays the tree out exactly as the CLI writes it.

  - **Defect B — progress pinned at 0%.** The slice-tracker fallback was gated off by `sawTodoPlan`,
    but the pr-reviewer prompt makes the CLI write its todo plan ONCE at grouping time and then fan the
    review out across parallel subagents that never mark the plan done — so the todo source sat at 0/N
    and the very fallback meant to cover the parallel shape was disabled. The gate is gone: a new pure
    `pickProgress` reconciles the two redundant views on every update, preferring whichever is further
    along (more completed, then more in-flight, then richer), so live in-flight `Task` slices surface as
    progress and a stale todo plan can no longer mask them. The pr-reviewer prompt is corrected to say
    progress is surfaced from the todo list AND from parallel subagent dispatches.

  The executor-harness image tag is bumped for the `src/**` change (Defect A + B live in the harness).

## 0.67.8

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

## 0.67.7

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/kernel@0.150.0
  - @cat-factory/prompt-fragments@0.14.3

## 0.67.6

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0
  - @cat-factory/prompt-fragments@0.14.2

## 0.67.5

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.67.4

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4
  - @cat-factory/prompt-fragments@0.14.1

## 0.67.3

### Patch Changes

- 3999941: pr-reviewer: prefetch the reviewed PR head so the review can see the proposed code.

  A `pr-reviewer` clones only the base branch and the container agent holds no git credential of its own, so files the PR ADDS (not on the base checkout) and the head version of modified files were unreachable — the review was silently limited to the ~256 KiB of patches inlined in `.cat-context/pr-diff.md`, and the prompt's `git fetch origin pull/<n>/head` fallback fails on a private repo. On a 518-file PR that meant only ~29 files were fully reviewable.

  The engine now resolves the reviewed PR number (new `AgentCloneSpec.prHead`, set on the pr-reviewer kind) into the job's `reviewPrNumber`, and the harness fetches `pull/<n>/head` (GitHub) / `merge-requests/<n>/head` (GitLab) into `origin/pr-head` with its own token before the run — mirroring the reference-branch prefetch. The reviewer prompt + injected diff now point at `origin/pr-head` for full head file bodies. Best-effort: a failed fetch leaves the review on the base checkout + injected diff as before.

  The injected `.cat-context/pr-diff.md` also gains a per-file patch cap (32 KiB): a single oversized patch (a lockfile, a snapshot, a vendored blob) is now stubbed with an `origin/pr-head` pointer instead of being inlined, and no longer draws down the global 256 KiB budget — so one giant generated diff can't starve the many small, reviewable source patches. The head prefetch makes the stubbed files readable on demand.

  Harness (image bump): the `agent` job gains an optional `reviewPrNumber?: number`.

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.67.2

### Patch Changes

- Updated dependencies [b1d1e2c]
  - @cat-factory/prompt-fragments@0.14.0

## 0.67.1

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2
  - @cat-factory/prompt-fragments@0.13.48

## 0.67.0

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
  - @cat-factory/kernel@0.148.1
  - @cat-factory/prompt-fragments@0.13.47

## 0.66.7

### Patch Changes

- 8053837: PR deep-review `post`: guard against comment position drift when the PR branch is updated
  after a review starts. The reviewer's dispatch now captures the PR head sha
  (`reviewedHeadSha`), and the `post` resolution re-reads the current head before publishing:
  if the branch moved, every finding is folded into the summary comment instead of being
  anchored to a line number that may have shifted, so comments can't land on the wrong code.
  Adds an optional `pullRequestHeadSha` read to the `GitHubClient`/`VcsClient`/`RepoFiles`
  ports (best-effort; the check is inert where a provider can't read it).
- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0
  - @cat-factory/prompt-fragments@0.13.46

## 0.66.6

### Patch Changes

- 511076d: Make the `pr-reviewer` agent comment-aware. A second preOp injects the PR's existing review threads (prior review rounds, human reviewers, other bots) as `.cat-context/pr-existing-comments.md` via a new optional `RepoFiles.listReviewThreads`, and the reviewer prompt now de-dups against them — skip issues already raised, focus on what is new or still unaddressed. Reuses the `listReviewThreads` read already implemented for the `human-review` gate (forwarded by `vcsBackedGitHubClient`, so GitLab gets it for free); passes through unchanged when the client can't read threads.
- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.66.5

### Patch Changes

- 1614e62: Fold the selected best-practice fragments into every repo-reading agent that was silently missing them, and guard against the class of bug.

  The engine's fragment fold (`AgentContextBuilder.resolveFragments`) only runs for kinds carrying the `code-aware` or `doc-aware` trait. Several container (repo-cloning) kinds were registered with no context trait, so a task's chosen best-practice fragments were dropped: tenant-managed fragments never resolved, and the "Provided context" telemetry snapshot recorded 0 fragments. The standalone "Review" task (`pr-reviewer`) was the reported case.

  Added `code-aware` to `pr-reviewer`, `ralph`, `repro-test`, `skill`, `bug-investigator`, `fork-proposer`, `initiative-analyst`, `initiative-planner`, `spike`, and `conflict-resolver` (which previously had only `spec-aware`). A new guard test asserts every registered repo-cloning kind actually folds fragments (carries `code-aware` or `doc-aware` — the only traits `resolveFragments` acts on; `spec-aware` alone does not fold), or is on an explicit, justified opt-out list (today `spec-writer`, `environment-analyst`, and `blueprints`), so a future kind that forgets its trait fails a test instead of silently dropping fragments.

## 0.66.4

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2
  - @cat-factory/prompt-fragments@0.13.45

## 0.66.3

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

## 0.66.2

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.66.1

### Patch Changes

- 2d97b16: First pass on the oxlint complexity/size ratchet (no behavioural change):

  - Tighten the free size ceilings now that the conformance god-file split dropped their floors:
    `max-lines` 3119 → 2802 and `max-lines-per-function` 3103 → 2453.
  - Complete `max-nested-callbacks` (6 → 4, its final target) by extracting the spec-id flatMap
    chain in `render.test.ts` into a helper.
  - Lower `max-depth` 6 → 5 by extracting the per-metric fold in the OTEL conformity test and the
    per-target recommendation application in `RequirementReviewService` (`applyRecommendationToTarget`)
    out of their deeply-nested loops.
  - Add `scripts/lint-limits-report.mjs`, a floor-finder that reports each ratcheted rule's live
    ceiling, actual floor, and top offenders to plan subsequent slices.

## 0.66.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.65.5

### Patch Changes

- 7aab031: feat: surface live PR-review progress instead of a bare "agent running"

  A running `pr-reviewer` deep review now shows what it is actually doing rather than a generic
  "agent running" spinner. Two gaps closed:

  - The `reviewing` status existed on `step.prReview` (and `recordFindings` already guarded for it)
    but was never assigned — so during a run the deep-review window had no state to render. The
    engine now SEEDS `step.prReview = { status: 'reviewing', prUrl, model, … }` (via the new pure
    `initialPrReviewState` helper) the moment the reviewer's container job dispatches, so the window
    renders a real reviewing phase carrying the reviewed PR and model. A `fix`/`post` re-dispatch is
    untouched (it already carries `fixing`/`posting` state). Runtime-symmetric — state rides the
    step, no table.

  - The reviewer's prompt now instructs it to maintain a per-slice todo list (one entry per cohesive
    chunk it groups the diff into, plus a final "aggregate findings" entry) and mark each done as it
    finishes. That surfaces as the step's live `subtasks`, which the deep-review window now renders
    during `reviewing`: a "slices reviewed / total" count, a progress bar, and the chunk breakdown
    with per-item status — instead of a static spinner. It degrades gracefully to the spinner before
    the reviewer has planned its slices.

## 0.65.4

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1
  - @cat-factory/prompt-fragments@0.13.44

## 0.65.3

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/kernel@0.145.1
  - @cat-factory/prompt-fragments@0.13.43

## 0.65.2

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0
  - @cat-factory/prompt-fragments@0.13.42

## 0.65.1

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0
  - @cat-factory/prompt-fragments@0.13.41

## 0.65.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/prompt-fragments@0.13.40

## 0.64.2

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.64.1

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.64.0

### Minor Changes

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

## 0.63.0

### Minor Changes

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

## 0.62.13

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.62.12

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1
  - @cat-factory/prompt-fragments@0.13.39

## 0.62.11

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
  - @cat-factory/kernel@0.139.3

## 0.62.10

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2
  - @cat-factory/prompt-fragments@0.13.38

## 0.62.9

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/prompt-fragments@0.13.37

## 0.62.8

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/prompt-fragments@0.13.36

## 0.62.7

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1
  - @cat-factory/prompt-fragments@0.13.35

## 0.62.6

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/prompt-fragments@0.13.34

## 0.62.5

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1
  - @cat-factory/prompt-fragments@0.13.33

## 0.62.4

### Patch Changes

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

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.62.3

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/prompt-fragments@0.13.32

## 0.62.2

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/prompt-fragments@0.13.31

## 0.62.1

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/kernel@0.134.1
  - @cat-factory/prompt-fragments@0.13.30

## 0.62.0

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

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/prompt-fragments@0.13.29

## 0.61.2

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/prompt-fragments@0.13.28

## 0.61.1

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/prompt-fragments@0.13.27

## 0.61.0

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
  - @cat-factory/prompt-fragments@0.13.26

## 0.60.0

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
  - @cat-factory/prompt-fragments@0.13.25

## 0.59.2

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/kernel@0.129.2
  - @cat-factory/prompt-fragments@0.13.24

## 0.59.1

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.59.0

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
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/prompt-fragments@0.13.23

## 0.58.1

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/kernel@0.128.1
  - @cat-factory/prompt-fragments@0.13.22

## 0.58.0

### Minor Changes

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
  - @cat-factory/prompt-fragments@0.13.21

## 0.57.0

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
  - @cat-factory/prompt-fragments@0.13.20

## 0.56.0

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
  - @cat-factory/prompt-fragments@0.13.19

## 0.55.0

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
  - @cat-factory/prompt-fragments@0.13.18

## 0.54.12

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.54.11

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/prompt-fragments@0.13.17

## 0.54.10

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/prompt-fragments@0.13.16

## 0.54.9

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.54.8

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.54.7

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/prompt-fragments@0.13.15

## 0.54.6

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.54.5

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.54.4

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.54.3

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
  - @cat-factory/contracts@0.127.1
  - @cat-factory/kernel@0.121.5
  - @cat-factory/prompt-fragments@0.13.14

## 0.54.2

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.54.1

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.54.0

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
  - @cat-factory/kernel@0.121.2
  - @cat-factory/prompt-fragments@0.13.13

## 0.53.6

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.53.5

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.53.4

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

## 0.53.3

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.53.2

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.53.1

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/kernel@0.118.1
  - @cat-factory/prompt-fragments@0.13.12

## 0.53.0

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
  - @cat-factory/prompt-fragments@0.13.11

## 0.52.9

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/prompt-fragments@0.13.10

## 0.52.8

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.52.7

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/prompt-fragments@0.13.9

## 0.52.6

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.52.5

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/prompt-fragments@0.13.8

## 0.52.4

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.52.3

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.52.2

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.52.1

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.52.0

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

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/prompt-fragments@0.13.7

## 0.51.0

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
  - @cat-factory/prompt-fragments@0.13.6

## 0.50.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/contracts@0.121.2
  - @cat-factory/prompt-fragments@0.13.5

## 0.49.3

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
  - @cat-factory/kernel@0.112.1

## 0.49.2

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.49.1

### Patch Changes

- 9aa9e19: Initiatives: phases can now declare a `checkpoint` (slice 2 of the
  custom-initiative-definitions initiative). A checkpoint phase PAUSES the initiative for
  human review once every one of its items settles, before the next phase spawns — so a
  human can read the phase's committed output (e.g. a research doc + GO/NO_GO verdict) and
  then resume to continue or cancel to stop. The engine never interprets an LLM verdict:
  the pause is declarative phase data the loop reads, and resume is the acknowledgment.

  - Contracts: `checkpoint?` on the plan/entity/draft phase and the preset phase-template
    phase, plus `checkpointClearedAt?` bookkeeping on the entity phase; a new `checkpoint`
    reason on the `initiative` notification.
  - Ingest stamps a template-authored `checkpoint` onto the matched phase (forced on — the
    planner cannot unset it), honours a planner-authored one on any draft phase (generic,
    usable without a preset), and preserves `checkpointClearedAt` across a re-plan.
  - The execution loop pauses at a completed, uncleared checkpoint phase (checked before
    completion, so a last-phase checkpoint still pauses) and raises the notification;
    `InitiativeService.resume` clears the checkpoint in the same CAS transform it resumes in.
  - The in-repo tracker markdown annotates a checkpoint phase (pending vs cleared).

  Non-checkpoint phases are byte-for-byte unchanged — a plan with no `checkpoint` advances
  exactly as before.

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/kernel@0.111.1
  - @cat-factory/prompt-fragments@0.13.4

## 0.49.0

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
  - @cat-factory/contracts@0.121.0
  - @cat-factory/prompt-fragments@0.13.3

## 0.48.5

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
  - @cat-factory/kernel@0.110.1

## 0.48.4

### Patch Changes

- a2db337: Fix initiative planning interview wedging after "Continue"/"Proceed", and surface a
  "Run planning" start control on the initiative board card.

  - **Engine:** the step re-park guard in `ExecutionService` never let a _resumed_
    interactive-interviewer step (initiative planning + document interviewer) fall through to
    its gate evaluation — it re-parked the run immediately, so pressing Continue/Proceed
    loaded briefly and then hung on the same questions. The guard, the generic approve/reject
    guard, AND the step-handler dispatch in `RunDispatcher` now all key off a new
    `interview-gate` agent **trait** carried by both interviewer kinds — the dispatch routes
    by trait to the controller registered for the step's `agentKind`, so a resumed interview
    (one carrying `pendingInterview`) re-runs the interviewer in the durable driver instead of
    wedging. Fully trait-based rather than kind-based, so a future interviewer just carries the
    trait and wires its controller — no engine branch.
  - **Board:** an initiative card now offers "Run planning" (and, while the interview is
    parked, "Answer planning questions") directly on the board, mirroring a task card's
    on-card Start affordance instead of hiding it behind selecting the block. The card and the
    inspector share a single `useInitiativePlanning` composable (no duplicated planning logic):
    the "Answer planning questions" affordance now keys on the interview's parked status alone
    (so it stays reachable once every question is answered but before the human resumes), and
    the optimistic start flag clears the moment the run takes over (so the button can't strand
    itself spinning after a cancel).

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/prompt-fragments@0.13.2

## 0.48.3

### Patch Changes

- 35636d5: Re-export the canonical migration phase-id constants (`MIGRATION_PHASE_IDS`,
  `MIGRATION_PHASE_ID_ORDER`, and the `MigrationPhaseId` type) from the package index. They are the
  contract shared by the tech-migration preset's `phaseTemplate`, its `promptAdditions`, and
  `seedMigrationPlan`; exporting them lets the migration end-to-end test reference the ids by import
  rather than retyping strings that could silently drift from the template the ingest normalizer
  matches on. Additive — no behaviour change.

## 0.48.2

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.48.1

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/prompt-fragments@0.13.1

## 0.48.0

### Minor Changes

- 4775c40: Register `preset_tech_migration`, the Technological-migration initiative preset (tech-migration slice
  T8) — the second real consumer of the initiative-preset primitives and the one that proves "preset as
  a mandated multi-phase methodology". It is pure WIRING that composes the already-landed migration
  pieces: a create-time FORM (which migration, from/to tech, stored-proc policy, compat posture,
  coverage bar, migration docs dir), the interviewer-driven `pl_initiative` planning pipeline
  (`interview: 'full'`, `humanReviewDefault: true`), a declarative five-phase `phaseTemplate`
  (blast-zone → coverage → transition-design → delivery → verify-decommission, all required, no extras)
  enforced by the generic ingest normalizer, the conservative execution policy (`maxConcurrent: 2`,
  `pl_quick` default escalating risky/complex items to `pl_full`, `onMissingEstimate: 'strongest'`),
  `seedMigrationPlan` (T7) as its `seedPlan` for per-item spawn decoration + the confidence-case
  control point, the T5 methodology `promptAdditions` for the interviewer/analyst/planner, and the
  full T4 `MIGRATION_FRAGMENT_IDS` as `defaultFragmentIds`. It registers as an import side effect (the
  docs-refresh / `@cat-factory/gates` pattern) so both runtimes pick it up with no per-facade wiring,
  and carries NO `detect` hook (its derived `probe` is false — a create-time probe could read only the
  FROM-side stack, which the analyst rediscovers far more thoroughly at planning time).

## 0.47.0

### Minor Changes

- f97d5d3: Add `seedMigrationPlan`, the `preset_tech_migration` plan post-processor (tech-migration slice T7),
  landed unwired ahead of the preset registration (T8). Running at ingest after the generic
  phase-template normalizer, it stamps per-item spawn DECORATION keyed off each item's migration phase:
  the blast-zone report + transition-design document(s) become `document` tasks with `.md` target paths
  under the frozen `migrationDocsDir` on the doc-quick pipeline; coverage/delivery/verify items stay
  ordinary coding tasks routed by the policy's estimate rules. It wires the phase-2 confidence case — a
  single human-gated `confidence-case.md` document that `dependsOn` every surviving coverage item,
  canonicalizing a planner-authored one or injecting it when omitted — caps phase-2 coverage at eight
  items (scrubbing dropped ids from every surviving `dependsOn`), and applies the human-review gate
  policy (confidence-case + transition-design are always gated as the coverage→delivery control points;
  `humanReview` additionally gates the informational blast-zone report). Every spawned item carries the
  `migration.*` fragments that APPLY to its primary producer — `coder` for coding items, `doc-writer`
  for documents — via the new `migrationFragmentIdsFor(agentKind)` from `@cat-factory/prompt-fragments`
  (alongside the full-set `MIGRATION_FRAGMENT_IDS` T8's `defaultFragmentIds` reuses), so a document
  task no longer receives the coding-only behaviour-preservation standard (manual `fragmentIds` pins
  bypass `appliesTo` at run time, so the scoping is applied at stamp time). The shared `seedPlan`
  primitives (`strInput`/`fileSlug`/`uniqueDocPath`/`mergeGateOverride`) are lifted into
  `presets/plan-helpers.ts` so docs-refresh and tech-migration share one implementation. Pure + total;
  no runtime behaviour changes until T8 registers the preset.

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/prompt-fragments@0.13.0

## 0.46.0

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

## 0.45.0

### Minor Changes

- 09a1c85: Technological-migration initiative — slice T5: the methodology prompt pack + the interviewer
  promptAddition seam.

  Adds `backend/packages/agents/src/presets/tech-migration/`, the code-side methodology steering the
  upcoming `preset_tech_migration` registration (T8) will spread onto its `promptAdditions`. Kept OFF
  the wire descriptor per the parent's off-the-wire rule (the descriptor's `phaseTemplate` carries
  only the short phase ids/titles/goals; the deep methodology lives here):

  - **`phases.ts`** — `MIGRATION_PHASE_IDS` (+ `MIGRATION_PHASE_ID_ORDER`), the single canonical
    phase-id contract shared by the phase template, this prompt pack, the plan post-processor
    (`seedMigrationPlan`, T7) and the migration E2E (T10), so no consumer retypes a phase id (a typo
    would silently break the ingest normalizer's verbatim id match).
  - **`prompt-additions.ts`** — `MIGRATION_PROMPT_ADDITIONS` (keyed by the kernel initiative kind
    constants) with the interviewer / analyst / planner steering: the interviewer probes the fuzzy,
    form-uncapturable migration facts (downtime tolerance, data-migration constraints, compat posture)
    and never re-asks the seeded form; the analyst produces the direct + TRANSITIVE blast-zone
    inventory with per-touchpoint existing-test coverage; the planner authors per-phase item briefs
    (single-writer artifacts, the human-gated confidence-case item, coverage-before-delivery),
    referencing the canonical phase ids verbatim.

  Completes the interviewer half of the preset `promptAdditions` seam in
  `InitiativeInterviewService`: the analyst/planner already fold their steering via `AgentContextBuilder`
  → `initiativeContextLines`, but the interviewer is an inline service that builds its own prompt, so it
  now folds `promptAdditions['initiative-interviewer']` under the same `## Initiative preset: <label>`
  heading. Generic and preset-less initiatives register none, so their interview stays byte-for-byte
  unchanged — the migration preset is simply the first FULL-interview preset to steer its interviewer.
  Both changes are dormant data + a generic seam until T8 registers the preset; the loop never branches
  on a preset id.

## 0.44.1

### Patch Changes

- 785576b: Initiative presets — docs-refresh preset review fixes (follow-up to slice 8, #911):

  - **`seedPlan` deduplicates derived target paths.** Two items whose titles slug to the same name
    under one directory (e.g. two `diagrams` items) would previously stamp the SAME `targetPath`,
    spawning two doc tasks that open competing PRs writing one file. Derived `<dir>/<slug>.md` paths
    are now uniquified (`-2`, `-3`, …) across the plan.
  - **Human review gates the `merger` step, derived from the pipeline shape.** `docsReviewGates` no
    longer hand-maintains per-pipeline boolean arrays; it derives the override from each pipeline's
    `agentKinds` and places the single gate on `merger`, so the human reviews the CI-green PR right
    before it merges — the same review point for EVERY doc pipeline (previously `pl_document_quick`
    gated a mid-pipeline `doc-reviewer` that still auto-merged afterwards, contradicting the form's
    "review each documentation change before it merges" promise). Correct-by-construction against
    pipeline-shape drift instead of relying on a length drift-guard.
  - **README items are writer-placed from the description, not a dead `targetPath` mechanism.** The
    planner's structured output has no `spawn` field (`INITIATIVE_PLANNER_SYSTEM_PROMPT`), so
    `coerceInitiativePlan` never carries a planner-authored path to `seedPlan` — the old
    `authored-readme` branch was inert. READMEs now name their per-service path in the item
    description (like `comments`/`business-rules`) and carry no `targetPath`.
  - **`seedPlan` merges its decoration OVER any planner spawn** (so a planner-authored `agentConfig`
    survives) rather than replacing it, and reuses the package's shared `moduleSlug` for the file
    slug instead of a fourth copy of the kebab-slug helper.
  - **Planner steering keeps the required `foundations` phase present** (0 items when the dirs already
    exist) rather than implying the phase may be dropped — which the exhaustive `phaseTemplate` would
    reject as a missing required phase, failing the whole plan ingest.

## 0.44.0

### Minor Changes

- f1906cb: Initiative presets — slice 8 (docs-refresh pilot): register the `preset_docs_refresh` initiative
  preset — the FIRST real preset, and the registration pattern the technological-migration preset
  (T8) copies. Incorporates inter-phase follow-up #1 (adopt the generic `phaseTemplate` shape
  enforcement; do NOT hand-roll phase shaping in `seedPlan`); follow-up #2 (templated pipelines)
  stays deferred.

  - **agents** (`presets/docs-refresh/preset.ts`): the `preset_docs_refresh` registration — a
    descriptor FORM (doc types, placement mode, docs/diagrams/business-rules dirs with `showWhen`,
    scope hint, human-review opt-in, writing-style fragments), a `detect` probe reusing slice 6's
    `detectDocsLayout`, a declarative `phaseTemplate` (Foundations `required` + one OPTIONAL phase
    per doc type, `allowAdditionalPhases: false`), `promptAdditions` turning the analyst into a
    documentation gap-auditor and shaping the planner's phases + item granularity, and a `seedPlan`
    that stamps per-item spawn DECORATION only (pipeline per doc type, `taskType`/`docKind`/derived
    `targetPath`, writing-style `fragmentIds`, and — when human review is opted in — the per-run
    `spawn.gates` override at each pipeline's review point). Registered as a module side effect on
    import (the `@cat-factory/gates` pattern), so it is available in every deployment with no
    per-facade wiring — the two runtimes cannot drift on it. Plan SHAPE lives in the template + the
    generic ingest normalizer; DECORATION lives in `seedPlan`; the two never overlap.
  - **kernel** (`domain/seed.ts`): the preset's interviewer-free planning pipeline
    `pl_initiative_docs` (`[initiative-analyst, initiative-planner, initiative-committer]`, no human
    gates — the form is the interview; per-task review is the opt-in gate-override seam) + its
    exported id `INITIATIVE_DOCS_PIPELINE_ID`, plus `DOCUMENT_QUICK_PIPELINE_ID` for the README /
    diagram spawn pipeline.
  - **prompt-fragments**: re-export the `styleFragments` collection so the preset builds its
    writing-style form options from the same source of truth (no duplicated fragment ids/labels).

  Backend-only: the SPA renders the new preset from its descriptor with no frontend changes (the
  slice-4 generic form renderer + picker), and human review maps to SPAWNED-task gates, so the
  planning run stays unattended.

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0
  - @cat-factory/prompt-fragments@0.12.0

## 0.43.1

### Patch Changes

- Updated dependencies [4a7fca0]
  - @cat-factory/prompt-fragments@0.11.0

## 0.43.0

### Minor Changes

- 44fafa4: Inline subscription LLM steps can now run inside a prewarmed local container on a leased
  subscription credential (initiative phase C2). The executor-harness gains a one-shot `inline`
  job kind that runs `claude -p` / `codex exec` with no checkout and returns the completion text +
  usage; the local `LocalContainerRunnerTransport` leases a warm pool member to serve it. The
  local inline resolver now selects the developer's host CLI when its binary is present (ambient,
  unmetered) and otherwise the container backend on a leased credential — personal per-run
  activation for an individual vendor (Claude/Codex/GLM), a pooled token otherwise (Kimi/DeepSeek).
  This lets a subscription-only preset run its inline reviewers/brainstorm/estimator even when the
  host has no `claude`/`codex` binary and in mothership mode, and extends inline coverage to the
  non-native claude-code vendors.

  Mechanics: `ModelScope` gains an `executionId` run dimension and `resolveScopedModelProvider`
  takes the full scope; the inline callers (the iterative reviewers, the doc/initiative
  interviewers, the tester quality companion, Kaizen, and the AI/consensus agent executors) thread
  the run's execution + initiator so the container backend can lease the right credential.
  `buildNodeContainer`'s `wrapModelProviderResolver` seam now receives the subscription lease
  closures. Bumps the executor-harness image tag (the harness `inline` kind is new image code).

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.42.0

### Minor Changes

- 89c861a: Initiative presets — slice 7 (docs-refresh pilot): the in-source comment annotator + the lean
  spawn pipelines the preset drives.

  - **agents** (`agents/kinds/code-commenter.ts`): a new built-in `code-commenter` agent kind,
    pre-loaded by `defaultAgentKindRegistry()`. It adds and clarifies WHY-not-what comments in
    EXISTING source with **no behaviour change** — a container-coding kind that runs the generic
    work-branch → PR lifecycle (`buildRegisteredAgentBody`, no bespoke harness handler, no
    executor-harness image bump), `doc-aware` so the engine folds the block's writing-style
    fragments into its prompt. Its system prompt hard-forbids touching executable code (comments /
    docstrings only), and the pipeline's `ci` step is the backstop that proves the diff is
    behaviour-neutral. Being a side-effect kind (its product is a pushed commit) it deliberately does
    NOT carry `FINAL_ANSWER_IN_REPLY`.
  - **kernel** (`domain/seed.ts`): two lean built-in spawn pipelines the docs-refresh preset stamps
    onto its spawned tasks (also pickable standalone) — `pl_code_comments`
    (`[code-commenter, conflicts, ci, merger]`) and `pl_business_docs`
    (`[business-documenter, conflicts, ci, merger]`, reusing the existing reverse-doc kind) — plus
    their exported ids (`CODE_COMMENTS_PIPELINE_ID` / `BUSINESS_DOCS_PIPELINE_ID`).
  - Design note (see the tracker's slice-7 row + inter-phase follow-up): after review, this is the
    MINIMAL set — Mermaid diagrams and READMEs reuse `doc-writer` / `pl_document_quick` (a diagram
    doc is just Markdown a writer produces), so `code-commenter` is the only genuinely-new capability
    and no `diagram-author` kind / `pl_diagrams` pipeline are added.

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.41.0

### Minor Changes

- 2d97812: Initiative presets — slice 6 (docs-refresh pilot): deterministic documentation-layout
  autodetection.

  - **agents** (`presets/docs-refresh/docs-detect.logic.ts`): a new pure `detectDocsLayout(reader)`
    heuristic — the checkout-free repo probe behind the docs-refresh preset's form prefill (its
    `detect` hook lands in slice 8). Over a narrow `DocsRepoReader` (a `RepoFiles` satisfies it
    structurally) it proposes the preset's placement DEFAULTS without a clone: the docs root
    (`docs`/`doc`/`documentation`), the diagrams + business-rules subfolders (known dir-name
    heuristics under the detected root), a monorepo flag (workspace manifest / `package.json`
    `workspaces` / conventional `packages`|`apps`|`services`|`libs` dirs), a `per-service` vs `root`
    placement decision (sampled from whether most packages carry their own docs), and an
    `hasExistingMermaid` hint for the analyst.
  - Deterministic, memoized, bounded by a hard read budget, and TOTAL — it never throws and never
    rejects, so an unwired GitHub / a partial or unreadable repo simply yields the conventional
    defaults (a prefill must never block create). Detected values are non-binding FORM DEFAULTS; a
    user edit wins and the analyst confirms placement at planning time.
  - **kernel** (`shared/repo-scan.logic.ts`): extracts the checkout-free scan primitives the repo
    auto-detectors share — `joinRepoPath` + the budgeted, memoized `BudgetedRepoScanner` (over a
    `CheckoutFreeRepoReader`) — into one home, so a fix to path normalization / caching / budget
    lands once instead of drifting across copies.
  - **integrations**: the service-provisioning (`provision-detect`) and frontend-config
    (`frontend-detect`) detectors now consume the shared kernel primitive instead of their own
    private `joinPath` + `Scanner` copies — a behaviour-neutral refactor (the shared `exhausted`
    uses the precise "a read was actually skipped" semantics both had converged toward).

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0
  - @cat-factory/contracts@0.118.0
  - @cat-factory/prompt-fragments@0.10.27

## 0.40.13

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/kernel@0.104.4
  - @cat-factory/prompt-fragments@0.10.26

## 0.40.12

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/kernel@0.104.3
  - @cat-factory/prompt-fragments@0.10.25

## 0.40.11

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/prompt-fragments@0.10.24

## 0.40.10

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0
  - @cat-factory/kernel@0.104.1
  - @cat-factory/prompt-fragments@0.10.23

## 0.40.9

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/prompt-fragments@0.10.22

## 0.40.8

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/prompt-fragments@0.10.21

## 0.40.7

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/prompt-fragments@0.10.20

## 0.40.6

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/kernel@0.101.2
  - @cat-factory/prompt-fragments@0.10.19

## 0.40.5

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/prompt-fragments@0.10.18

## 0.40.4

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/prompt-fragments@0.10.17

## 0.40.3

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/prompt-fragments@0.10.16

## 0.40.2

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/kernel@0.99.1
  - @cat-factory/prompt-fragments@0.10.15

## 0.40.1

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/prompt-fragments@0.10.14

## 0.40.0

### Minor Changes

- bf31df7: Stack recipes & shared stacks (slice 8): the opt-in environment analyst.

  Adds an `environment-analyst` agent kind — the LLM half of environment auto-detection. Where the deterministic detector reads a repo checkout-free and can only see mechanical facts (compose layering, external networks, env-file pairs), the analyst is a read-only `container-explore` agent that CLONES the repo and reads the imperative bring-up a scan can't (README / Makefile / `bin/*` CLIs / setup scripts / seed dumps) to draft a declarative Docker Compose stack recipe — setup steps, prerequisites and a health gate — each grounded in a source citation. It returns the draft on `result.custom` (rendered by the shared `generic-structured` view); it never writes the repo. The draft is NON-BINDING: the setup wizard (slice 7) will merge it over the deterministic recommendation and nothing is applied until the human confirms.

  - Contracts: `AnalystRecipeDraft` / `AnalystRecipeNote` / `AnalystCitation` (`environment-analyst.ts`) — a lenient LLM-output shape (a proposed `StackRecipe` + per-field provenance + summary) that degrades field-by-field on a partially-malformed reply.
  - Agents: the `environment-analyst` kind (registered through the public `AgentKindRegistry` seam, pre-loaded by `defaultAgentKindRegistry()`), with its schema-derived structured output (`failOnUnusableFinal`, so an empty reply fails loudly rather than yielding an empty draft).
  - Kernel: a seeded analyst-only pipeline `pl_environment_analysis` (`ENVIRONMENT_ANALYSIS_PIPELINE_ID`) the wizard runs against a service frame, mirroring `pl_blueprint`.

  No persistence change — the analyst rides the execution engine and the existing `provisioning` blob, so no migration and no runtime asymmetry. The draft-merge + wizard trigger UI land with the wizard (slice 7).

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/prompt-fragments@0.10.13

## 0.39.4

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/prompt-fragments@0.10.12

## 0.39.3

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/prompt-fragments@0.10.11

## 0.39.2

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/prompt-fragments@0.10.10

## 0.39.1

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/prompt-fragments@0.10.9

## 0.39.0

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
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/prompt-fragments@0.10.8

## 0.38.2

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/kernel@0.92.0
  - @cat-factory/prompt-fragments@0.10.7

## 0.38.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/prompt-fragments@0.10.6

## 0.38.0

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
  - @cat-factory/prompt-fragments@0.10.5

## 0.37.2

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/kernel@0.89.1
  - @cat-factory/prompt-fragments@0.10.4

## 0.37.1

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/prompt-fragments@0.10.3

## 0.37.0

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

## 0.36.0

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

## 0.35.0

### Minor Changes

- 102c049: Document tasks: per-kind specific fields. The create-task form now collects the fields that
  matter for the chosen document kind (PRD target users + success metrics, RFC alternatives +
  rollout concerns, ADR decision drivers + considered options, runbook when-to-use + escalation,
  research question + options to compare, API surface), and the author agents fold them into the
  brief as required content for the matching template sections. The fields live on the sparse
  `taskTypeFields` bag (no migration) with `DOC_KIND_FIELDS` as the single source of truth shared
  by the form and the prompts.

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/kernel@0.86.1
  - @cat-factory/prompt-fragments@0.10.2

## 0.34.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/prompt-fragments@0.10.1

## 0.33.1

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.33.0

### Minor Changes

- 8eaa3f2: Universal writing-style fragments for document-authoring tasks (WS2 of the
  documentation-type task initiative). Two built-in fragments — `style.anti-llmisms`
  (cut the machine-written tells: filler intensifiers, hedging, throat-clearing,
  summary-that-restates, bullet inflation) and `style.concise-actionable` (lead with
  the point, active voice, one idea per paragraph, every recommendation names an actor
  and an action) — now guide the document-authoring agents.

  They reach those agents through a new `doc-aware` capability trait, the document
  analogue of `code-aware`: the `doc-researcher` / `doc-outliner` / `doc-writer` /
  `doc-finalizer` kinds carry it on their definitions and the `doc-reviewer` companion
  carries it too, so the execution engine folds the block's selected style fragments
  into each one's system prompt via the same `AgentContextBuilder` path `code-aware`
  uses — no parallel fragment path in the prompt builders. Because the reviewer sees
  the same bodies, the style guidance is both the writer's instruction and the
  reviewer's criteria (an explicit clause in the companion prompt says so).

  A new document task is pre-seeded with both style fragments (default-on,
  user-removable like any block pin) via `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`, seeded
  onto the task's `fragmentIds` in `BoardService.addTask` — the selection default lives
  at task creation, not hard-coded in a prompt.

  The fragment "add" pickers (service, task, and workspace-default) now render their
  options as labelled per-category sections instead of one flat list, so the catalog
  stays navigable now that a block can pin across two tracks at once — the technical
  collections (Node / React / …) and the Writing-style fragments.

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/prompt-fragments@0.10.0

## 0.32.0

### Minor Changes

- e5ddaa4: Cache document-backed prompt-fragment bodies through the app caching seam
  (caching-layer initiative, slice 2). A new `AppCaches.fragmentDocumentBody`
  group cache serves a living fragment's external Confluence/Notion/GitHub/Figma/
  Zeplin/Linear body, replacing the hand-rolled `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`
  in `FragmentLibraryService`: a run reads the cached body instead of blocking on a
  live page fetch, and an entry entering its refresh window runs the source's cheap
  version probe — keeping the cached body when the page hasn't moved, reloading in
  the background when it has.

  To support the probe, `DocumentContent` now carries an opaque `version` token and
  `DocumentSourceProvider`/`DocumentContentResolver` gain a `probeVersion` method
  (metadata-only, strictly cheaper than a full fetch), implemented across all
  document providers. The self-verifying cache stays enabled on the Cloudflare
  Worker (bounded staleness via the probe), unlike the mutable-state fragment
  catalog.

  Behavior change (pre-1.0, no back-compat): the durable `prompt_fragments.body` is
  now the offline fallback + management-view content, refreshed only by an explicit
  create/refresh; the live run-time body flows through the cache. Without a cache
  wired, a run serves the persisted body and does not re-resolve live.

- 6213771: Add a per-`DocKind` document template registry (WS1 of the documentation-type task
  initiative). Each document kind now carries a structured template — required and optional
  sections with per-section authoring guidance — that is the single source of truth for the
  kind's expected shape. The templates are woven into the `doc-outliner` prompt (the outline
  must cover the required sections) and the `doc-writer` prompt (start from the rendered
  skeleton), replacing the previous one-line structure hint. A deployment can override a
  kind's template through the public `registerDocTemplate` seam (an import side effect,
  mirroring `registerPromptFragment`).

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.31.0

### Minor Changes

- 9bac054: Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
  app-level caching seam and adopt it for the per-dispatch fragment-catalog resolve.

  - New published package `@cat-factory/caching`: `createAppCaches(options)` builds the
    named, typed in-memory read-through caches (layered-loader `GroupLoader`, LRU + TTL)
    behind the new kernel `AppCaches`/`GroupCacheHandle` port. Redis is only ever an
    invalidation bus, never a data tier; with no notification factory injected the
    loaders are bare in-memory. The package deep-imports only layered-loader's in-memory
    machinery so ioredis never enters the module graph outside the Node facade's
    REDIS_URL-gated wiring.
  - `FragmentLibraryService.resolveCatalog` now reads through the fragment-catalog cache
    (group = workspace id), and every fragment write path — create / update / remove /
    createFromDocument / refresh / the run-time document-body re-resolve / fragment-source
    sync + unlink — invalidates it after commit (`invalidateCatalogTier`). The
    `ResolvedCatalogEntry` type moved to `@cat-factory/kernel` so the port can name it.
  - Node facade: `start()` builds the process-wide cache bag; when `REDIS_URL` is set,
    each cache gets its own `cat-factory:cache:<name>` notification channel (prefix
    overridable via the new `REDIS_CACHE_CHANNEL_PREFIX` env var) over dedicated
    ioredis publisher/subscriber clients, so peers drop their in-memory entries on every
    write — the same gating and resilience pattern as the realtime propagator. Local
    mode stays bare in-memory (single-node by construction).
  - Cloudflare Worker: wired with the ISOLATE-SAFE profile — the fragment catalog (mutable
    cross-instance state) is pass-through, since an isolate has no cross-isolate
    invalidation bus. Documented in the caching package README.
  - Conformance: new `defineCacheSuite` asserts write-then-read coherence of the resolved
    catalog on all three runtimes (Worker/Node/local).
  - Staleness probes for the upcoming git-backed slices, on layered-loader 14.5.3's new
    in-memory `isEntryStillCurrentFn` support: a cache profile may set
    `ttlLeftBeforeRefreshInMsecs`, and `GroupCacheHandle.get` accepts an optional per-read
    `isStillCurrent` probe — entries entering the refresh window get their TTL bumped when
    the probe reports the source unmoved, and fall back to a full background reload
    otherwise. `layered-loader` (maintainer-owned) is now excluded unversioned from the
    `minimumReleaseAge` supply-chain gate, like the `@cat-factory/*` namespace.

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.30.5

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/prompt-fragments@0.9.55

## 0.30.4

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/prompt-fragments@0.9.54

## 0.30.3

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/prompt-fragments@0.9.53

## 0.30.2

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/kernel@0.79.1
  - @cat-factory/prompt-fragments@0.9.52

## 0.30.1

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/prompt-fragments@0.9.51

## 0.30.0

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
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/prompt-fragments@0.9.50

## 0.29.1

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/prompt-fragments@0.9.49

## 0.29.0

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
  - @cat-factory/prompt-fragments@0.9.48

## 0.28.0

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
  - @cat-factory/prompt-fragments@0.9.47

## 0.27.1

### Patch Changes

- cc924a9: Requirements-review recommendations: batch, tighten, and surface what's awaited.

  - The Requirement Writer now answers findings in CHUNKS (up to 4 per LLM call) instead of one
    call per finding, so a batch of N findings costs `ceil(N / 4)` calls rather than N. Shared
    grounding is still gathered once and progress still streams `ready / total` a chunk at a time;
    a failure is isolated to its chunk. Each finding keeps the same per-finding output budget the
    single-call path used (scaled by chunk size), and a batched response is routed back to its
    findings by the echoed itemId with a prompt-order fallback — so a response that drops the ids
    isn't discarded wholesale and the whole chunk force-reopened.
  - The Writer prompt (`requirement-writer`, bumped to v2) now asks for precise, succinct
    recommendations — the concrete answer in a couple of sentences, cite sources briefly, no
    preamble or padding — instead of open-ended prose.
  - The review window now shows a persistent "awaited recommendations" summary (how many the
    Writer is still generating and how many are waiting on the human) in the stats rail, and lets
    you request recommendations while a merged review is being reworked — not only in the initial
    `ready` state.
  - The incorporated-requirements document can now be collapsed as a whole. It defaults to collapsed
    only in the pre-incorporation `ready` phase (so a long doc doesn't push the findings being worked
    through off-screen) and expanded in `merged`/`incorporated`, where the document itself is the
    thing to read; a manual collapse no longer leaks across a status change.

## 0.27.0

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
  - @cat-factory/prompt-fragments@0.9.46

## 0.26.18

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.26.17

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/prompt-fragments@0.9.45

## 0.26.16

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/prompt-fragments@0.9.44

## 0.26.15

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/prompt-fragments@0.9.43

## 0.26.14

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.26.13

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.26.12

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/kernel@0.69.8
  - @cat-factory/prompt-fragments@0.9.42

## 0.26.11

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.26.10

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

## 0.26.9

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/prompt-fragments@0.9.41

## 0.26.8

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/kernel@0.69.5
  - @cat-factory/prompt-fragments@0.9.40

## 0.26.7

### Patch Changes

- fc8df61: Fix a cross-tenant access hole on the fragment-source routes: `unlink`/`status`/`sync`
  resolved the source by its id alone, so an authenticated member of one account/workspace
  could read, resync or delete another tenant's fragment source by addressing its id under
  their own prefix. `FragmentSourceService.unlink/sync/status` now take the addressed
  `(ownerKind, ownerId)` and 404 when the source belongs to a different owner (breaking
  signature change for direct callers of those three methods).

## 0.26.6

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/kernel@0.69.4
  - @cat-factory/prompt-fragments@0.9.39

## 0.26.5

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/kernel@0.69.3
  - @cat-factory/prompt-fragments@0.9.38

## 0.26.4

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/contracts@0.80.1
  - @cat-factory/prompt-fragments@0.9.37

## 0.26.3

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/prompt-fragments@0.9.36

## 0.26.2

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/prompt-fragments@0.9.35

## 0.26.1

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/prompt-fragments@0.9.34

## 0.26.0

### Minor Changes

- 16621f8: feat(testing): test quality-control companion that loops the Tester on incomplete reports

  The Tester gate concluded a step purely from `greenlight` + blocking concerns + failed
  outcomes, so a report that claimed to exercise many areas (`tested`) but recorded a single
  happy-path `outcome` could greenlight and "pass" — leaving most scenarios as "No discrete
  check recorded" in the Test Report window while the step read as successfully completed.

  Two changes address this:

  - **Tester prompts now require one recorded `outcome` per `tested` area** (API + UI testers):
    every scenario listed as tested must have a matching outcome with a concrete detail, and
    describing results only in the prose `summary` does not count. Genuinely un-exercised areas
    are recorded as `skipped` with a reason rather than dropped.
  - **A new test quality-control companion** (`tester-qc`) audits each Tester report for
    coverage/coherence BEFORE the greenlight/fixer decision. When the report is inadequate it
    loops the Tester for a focused additional pass (folding the prior report + the flagged gaps
    in, and carrying forward already-covered outcomes), bounded by a new merge-preset knob
    `maxTesterQualityIterations` (default 3). Enabled by default; a per-Tester-step toggle in
    the pipeline shape (`pipeline.testerQuality`) disables it or gates it on the task estimate.
    The companion is an inline reviewer (no container) that resolves its model like the other
    inline reviewers and is a pass-through when no model is wired.

  Persistence: the merge preset gains a `max_tester_quality_iterations` column, mirrored across
  the D1 and Drizzle stores (built-in preset seed `version` bumped 1 → 2). The QC loop state
  lives on the execution step, so no new table is added.

  The frontend pipeline-builder toggle + Test Report verdict surfacing land in a follow-up
  (see `docs/initiatives/tester-quality-companion.md`).

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/prompt-fragments@0.9.33

## 0.25.0

### Minor Changes

- f70c273: feat(frontend): `pl_frontend` pipeline + frontend-aware mocker (slice 4 of the
  frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  Builds on slice 3's self-contained UI-test infra with the pipeline that drives it and a mocker
  that authors the mocks it needs.

  - **`pl_frontend` built-in pipeline** (`coder → reviewer → mocker → tester-ui → conflicts → ci →
merger`). For a `type: 'frontend'` frame the engine already resolves the frame's
    `frontendConfig` + backend bindings and stands the app + WireMock up in one container (slice 3),
    so this pipeline is just the step order that exercises it end to end: implement → review → mock
    → browser-test → the standard mergeability/CI/merge tail. Labelled `experimental` — two
    deploy-/keying-time steps remain (the `ui`-image per-step routing, and keying a bound service's
    ephemeral env by its FRAME id so a live-service binding resolves instead of falling back to
    WireMock); a mock-only frontend already runs fully self-contained today.
  - **Frontend-aware mocker.** When a `mocker` step runs on a task under a `frontend` frame, its
    user prompt now carries a frontend section: author WireMock stub mappings under the frontend
    repo's mock dir in WireMock's `--root-dir` layout (`<dir>/mappings/*.json` + `<dir>/__files/`)
    for exactly the upstreams the harness points at WireMock (every binding with no live service
    under test), and do NOT wire a docker-compose stack — the platform serves the app + WireMock
    directly. The live service(s) under test are named and explicitly excluded from mocking. A
    backend-service mocker run is unchanged (the section is absent without a resolved frontend
    context). The section explicitly OVERRIDES the docker-compose stand-up guidance in the
    (backend-oriented) mocker role prompt so the two do not contradict for a frontend run, and the
    default WireMock root (`mocks/`) is now the shared `DEFAULT_FRONTEND_MOCK_MAPPINGS_PATH` constant
    in `@cat-factory/contracts` rather than a private literal.

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

- 33687cf: fix(tester): give the Tester standardized env coordinates + real access credentials in its prompt

  The tester prompt claimed a deployed environment's URL and access credentials were "provided to
  the test harness out of band" — but nothing delivered them, so Testers aborted with "no deployed
  URL or credentials found". `environmentSection()` now renders the standardized coordinates
  (URL + derived host/port/scheme) and the FULL endpoint access credentials (bearer token / HTTP
  basic username+password / custom header name+value) directly in the run context.

  These are test-environment access credentials, treated as non-sensitive: the Tester cannot
  authenticate without them reaching the model regardless of channel, so they go straight into the
  prompt rather than a fictional out-of-band path. The tester system prompts and run-mode wording
  now point at the concrete "Ephemeral environment under test" section.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/prompt-fragments@0.9.32

## 0.24.16

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/kernel@0.66.1
  - @cat-factory/prompt-fragments@0.9.31

## 0.24.15

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/prompt-fragments@0.9.30

## 0.24.14

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/prompt-fragments@0.9.29

## 0.24.13

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/prompt-fragments@0.9.28

## 0.24.12

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/kernel@0.63.4
  - @cat-factory/prompt-fragments@0.9.27

## 0.24.11

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/kernel@0.63.3
  - @cat-factory/prompt-fragments@0.9.26

## 0.24.10

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/prompt-fragments@0.9.25

## 0.24.9

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/kernel@0.63.1
  - @cat-factory/prompt-fragments@0.9.24

## 0.24.8

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/prompt-fragments@0.9.23

## 0.24.7

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/kernel@0.62.4
  - @cat-factory/prompt-fragments@0.9.22

## 0.24.6

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/kernel@0.62.3
  - @cat-factory/prompt-fragments@0.9.21

## 0.24.5

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/kernel@0.62.2
  - @cat-factory/prompt-fragments@0.9.20

## 0.24.4

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/kernel@0.62.1
  - @cat-factory/prompt-fragments@0.9.19

## 0.24.3

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0
  - @cat-factory/prompt-fragments@0.9.18

## 0.24.2

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/kernel@0.61.1
  - @cat-factory/prompt-fragments@0.9.17

## 0.24.1

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/prompt-fragments@0.9.16

## 0.24.0

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
  - @cat-factory/prompt-fragments@0.9.15

## 0.23.4

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/prompt-fragments@0.9.14

## 0.23.3

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0
  - @cat-factory/prompt-fragments@0.9.13

## 0.23.2

### Patch Changes

- 6009266: Refresh dependencies to their latest release-age-compliant versions: the Vercel AI
  SDK family within its `workers-ai-provider`-compatible majors (`ai` 6.0.214,
  `@ai-sdk/anthropic` 3.0.89, `@ai-sdk/openai` 3.0.77, `@ai-sdk/openai-compatible`
  2.0.54, `@ai-sdk/amazon-bedrock` 4.0.124), `drizzle-orm`/`drizzle-kit` 1.0.0-rc.4,
  and `yaml` 2.9.0, plus refreshed transitive resolutions.
- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.23.1

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/prompt-fragments@0.9.12

## 0.23.0

### Minor Changes

- 5fd0ffa: Refuse to start a pipeline that includes an agent relying on binary-artifact storage when the workspace's account has none configured.

  The requirement is modelled as a new `binary-storage` agent trait (carried today by the UI Tester, which uploads its screenshots), so the system is universal: a future artifact-producing agent just declares the trait instead of the engine hard-coding it. `ExecutionService` enforces it on start/retry/restart and throws a `binary_storage_unconfigured` conflict, which the SPA surfaces as an error prompt with a "Configure storage" jump to the content-storage settings.

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/kernel@0.56.1
  - @cat-factory/prompt-fragments@0.9.11

## 0.22.6

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0
  - @cat-factory/prompt-fragments@0.9.10

## 0.22.5

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.22.4

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1
  - @cat-factory/kernel@0.55.3
  - @cat-factory/prompt-fragments@0.9.9

## 0.22.3

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/kernel@0.55.2
  - @cat-factory/prompt-fragments@0.9.8

## 0.22.2

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/kernel@0.55.1
  - @cat-factory/prompt-fragments@0.9.7

## 0.22.1

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0
  - @cat-factory/prompt-fragments@0.9.6

## 0.22.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0
  - @cat-factory/prompt-fragments@0.9.5

## 0.21.17

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/kernel@0.53.1
  - @cat-factory/prompt-fragments@0.9.4

## 0.21.16

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0
  - @cat-factory/prompt-fragments@0.9.3

## 0.21.15

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/prompt-fragments@0.9.2

## 0.21.14

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/prompt-fragments@0.9.1

## 0.21.13

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/prompt-fragments@0.9.0

## 0.21.12

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/prompt-fragments@0.8.9

## 0.21.11

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0
  - @cat-factory/prompt-fragments@0.8.8

## 0.21.10

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0
  - @cat-factory/kernel@0.47.2
  - @cat-factory/prompt-fragments@0.8.7

## 0.21.9

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/prompt-fragments@0.8.6

## 0.21.8

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/prompt-fragments@0.8.5

## 0.21.7

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0
  - @cat-factory/prompt-fragments@0.8.4

## 0.21.6

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
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5
  - @cat-factory/prompt-fragments@0.8.3

## 0.21.5

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/kernel@0.45.4
  - @cat-factory/prompt-fragments@0.8.2

## 0.21.4

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.21.3

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2
  - @cat-factory/prompt-fragments@0.8.1

## 0.21.2

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.21.1

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0
  - @cat-factory/prompt-fragments@0.8.0

## 0.21.0

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
  - @cat-factory/prompt-fragments@0.7.41

## 0.20.3

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.20.2

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/kernel@0.42.2
  - @cat-factory/prompt-fragments@0.7.40

## 0.20.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/prompt-fragments@0.7.39

## 0.20.0

### Minor Changes

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

### Patch Changes

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
  - @cat-factory/prompt-fragments@0.7.38

## 0.19.0

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
  - @cat-factory/prompt-fragments@0.7.37

## 0.18.5

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0
  - @cat-factory/prompt-fragments@0.7.36

## 0.18.4

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0
  - @cat-factory/prompt-fragments@0.7.35

## 0.18.3

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/kernel@0.38.1
  - @cat-factory/prompt-fragments@0.7.34

## 0.18.2

### Patch Changes

- 692ccb4: Centralize OpenAI-compatible provider base-URL resolution.

  The env-override→default base-URL logic (and the "litellm has no public default" rule)
  was reconstructed per facade — a `NODE_BASE_URLS` map plus a `||` lookup on Node and a
  provider `switch` on the Worker. Both now route through a single
  `resolveOpenAiCompatibleBaseUrl(provider, override)` in `@cat-factory/agents`, driven by
  the existing `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` table, so adding an OpenAI-compatible
  vendor is a one-line table entry both runtimes pick up automatically.

  Minor behavioural alignment: a _blank_ `${PROVIDER}_BASE_URL` override now falls back to
  the built-in default on the Worker too (it previously returned the empty string), matching
  Node's long-standing `||` semantics.

## 0.18.1

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/prompt-fragments@0.7.33

## 0.18.0

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
  - @cat-factory/prompt-fragments@0.7.32

## 0.17.2

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/prompt-fragments@0.7.31

## 0.17.1

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/prompt-fragments@0.7.30

## 0.17.0

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
  - @cat-factory/prompt-fragments@0.7.29

## 0.16.1

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

## 0.16.0

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
  - @cat-factory/prompt-fragments@0.7.28

## 0.15.2

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/prompt-fragments@0.7.27

## 0.15.1

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0
  - @cat-factory/prompt-fragments@0.7.26

## 0.15.0

### Minor Changes

- 52d886a: Improve the ergonomics of authoring custom agent kinds and gates:

  - **Typed provider registry** (`defineProviderToken`/`wireProvider`/`requireProvider`, kernel),
    surfaced through `GateContext.getProvider`/`requireProvider`. A custom gate reaches its data
    source through the context instead of a hand-authored module global + unsafe `!`. The built-in
    `@cat-factory/gates` suite dogfoods it (public `wireX` signatures unchanged).
    **Breaking:** `GateContext` gains required `getProvider`/`requireProvider` (use `stubGateContext`).
  - **Schema-driven structured output** (`defineStructuredOutput`, agents): one valibot schema
    derives both the `agent.output` spec and a typed `parse`/`safeParse`, replacing the hand-written
    `shapeHint` string + lenient coercer. `registerAgentKind` auto-fills `agent.output` from a
    `structuredOutput` schema.
  - **Boot-time registration validation** (`validateRegistrations`/`validateRegistrationsOnce`,
    orchestration): a facade validates registered gates/kinds/pipelines at startup (gate `helperKind`
    resolves, `resultView` is known) and fails loudly instead of mid-run. Wired into both runtimes.
  - **Prompt + resultView wiring** (agents/contracts): `FINAL_ANSWER_IN_REPLY` + the read-only
    guardrail are applied to registered kinds from their `agent.surface` (fixing a registered
    `container-explore` kind missing the guardrail); `resultView` is now a typed picklist of
    `RESULT_VIEW_IDS` (unknown ids fail validation instead of silently falling back to prose).

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/prompt-fragments@0.7.25

## 0.14.9

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0
  - @cat-factory/prompt-fragments@0.7.24

## 0.14.8

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/kernel@0.28.1
  - @cat-factory/prompt-fragments@0.7.23

## 0.14.7

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/prompt-fragments@0.7.22

## 0.14.6

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0
  - @cat-factory/prompt-fragments@0.7.21

## 0.14.5

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1

## 0.14.4

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0

## 0.14.3

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0

## 0.14.2

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/prompt-fragments@0.7.20

## 0.14.1

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0

## 0.14.0

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
  - @cat-factory/prompt-fragments@0.7.19

## 0.13.0

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
  - @cat-factory/prompt-fragments@0.7.18

## 0.12.0

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

## 0.11.16

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0
  - @cat-factory/prompt-fragments@0.7.17

## 0.11.15

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/prompt-fragments@0.7.16

## 0.11.14

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0
  - @cat-factory/prompt-fragments@0.7.15

## 0.11.13

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
  - @cat-factory/prompt-fragments@0.7.14

## 0.11.12

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/prompt-fragments@0.7.13

## 0.11.11

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0

## 0.11.10

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1

## 0.11.9

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/prompt-fragments@0.7.12

## 0.11.8

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

## 0.11.7

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/prompt-fragments@0.7.11

## 0.11.6

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
  - @cat-factory/kernel@0.13.4

## 0.11.5

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/kernel@0.13.3
  - @cat-factory/prompt-fragments@0.7.10

## 0.11.4

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
  - @cat-factory/prompt-fragments@0.7.9

## 0.11.3

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1

## 0.11.2

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0
  - @cat-factory/prompt-fragments@0.7.8

## 0.11.1

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

## 0.11.0

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

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/prompt-fragments@0.7.7

## 0.10.1

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/kernel@0.11.1

## 0.10.0

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
  - @cat-factory/prompt-fragments@0.7.6

## 0.9.0

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
  - @cat-factory/kernel@0.10.1
  - @cat-factory/prompt-fragments@0.7.5

## 0.8.2

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/prompt-fragments@0.7.4

## 0.8.1

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0

## 0.8.0

### Minor Changes

- c70df09: Add the foundations for manifest-driven custom agents (pre/agent/post-op model).

  - `@cat-factory/agents`: new `repo-ops/render.ts` — the deterministic, container-free
    rendering + lenient coercion of the in-repo `blueprints/`/`spec/` artifacts
    (`renderBlueprintFiles`/`renderSpecFiles`/`renderSpecFeatureFiles`,
    `coerceBlueprintService`/`coerceSpecDoc`/`dedupeSpecIds`, the version manifests). This
    is the logic lifted out of the executor-harness image; the hash uses Web Crypto so it
    is runtime-neutral (so the hash + version helpers are async). The agent-kind registry
    (`AgentKindDefinition`) gains `agent` (execution surface), `preOps`/`postOps` (backend
    repo-op hooks) and `presentation` (frontend palette metadata), with matching accessors;
    `registeredKindRequiresContainer` now also derives from a container agent surface.
  - `@cat-factory/kernel`: new `RepoFiles`/`ResolveRepoFiles` ports (a per-run,
    checkout-free facade over the `GitHubClient` Git Data API) and the agent-definition
    vocabulary (`AgentSurface`/`AgentStepSpec`/`AgentCloneSpec`/`AgentOutputSpec`,
    `RepoOp`/`RepoOpContext`).
  - `@cat-factory/contracts`: new `AgentPresentation`/`AgentCategory`/`CustomAgentKind`
    wire shapes for the data-driven agent palette.

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/prompt-fragments@0.7.3

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/contracts@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/prompt-fragments@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/prompt-fragments@0.7.1

## 0.7.0

### Minor Changes

- 6406c8c: Extract `@cat-factory/agents` — agent catalog, routing, prompts, fragment library, and versioned prompt registry are now a standalone package. `@cat-factory/core` re-exports the full public surface for backward compatibility. `REVIEW_SYSTEM_PROMPT` moves from `requirements.logic` into agents (its natural home); `renderTaskContext`/`TaskContextView` move into `@cat-factory/kernel` (pure, kernel-deps-only).
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

- 3a12f15: Fix the container coding-agent role prompts that told the agent to push and manage
  the pull request itself — work it has no credentials for and was never meant to do.

  The `build`, runnable-tests (`playwright`) and docs (`business-documenter`) gates each
  instructed the agent to "open or update the pull request, push the fix, and wait for
  CI". Inside the run container the agent has no push token (version control is the
  platform's job), so a capable model would try `git push`, hit an auth wall, and then
  burn the entire run probing env vars, decoding tokens and poking at git remotes
  instead of doing the work (shipping zero changes and failing with "no file changes");
  weaker models just gave up.

  The three gates now share one `PLATFORM_DELIVERY_CONTRACT` (in `ci-gate.ts`) that makes
  the boundary explicit: the agent commits its OWN work (it alone knows which files are
  part of the solution vs scratch scripts/artifacts), validates locally, and stops; the
  platform pushes, opens the PR and drives CI (dispatching a CI-fixer on failure). It is
  told not to push, not to use `gh`/the GitHub API, and not to chase credentials, and to
  bound its effort rather than spin. The `build` prompt is bumped to `build@v2`.

  BREAKING: the `CI_RETRY_SANITY_CHECK` export is replaced by `PLATFORM_DELIVERY_CONTRACT`.

- b40da13: Simplify task granularity and run configuration; open the pipeline-step detail
  overlay from the zoomed-in board.

  - **Open the agent step-detail overlay from the board.** Clicking a pipeline agent
    in a zoomed-in task card now opens the full `AgentStepDetail` overlay (execution
    metadata + the agent's prose output), exactly like clicking it from the inspector
    or the focus-view pipeline — instead of expanding raw text inside the card.
  - **Removed the per-task auto-merge "confidence threshold".** The confidence-score
    auto-merge gate (`Block.confidenceThreshold`, the inspector + task-card UI, the
    `DEFAULT_CONFIDENCE_THRESHOLD` constant) is gone; the `merger` step's merge-policy
    preset (complexity/risk/impact ceilings) is the sole auto-merge gate. (The raw
    `confidence` score is still recorded for transparency.)
  - **Removed "feature" tracking from the board and the service map.** `Block.features`
    (the inspector's "Features implemented" tags and the board/module feature badges)
    is removed, and the in-repo blueprint / board-scan decomposition is now
    service → modules only — the Blueprinter, harness rendering, and reconciliation no
    longer produce a "feature" sub-level or derive tasks from it. Acceptance scenarios
    are now freeform per task (decoupled from features) pending a deeper
    requirements-driven model.
  - **Task creation picks a pipeline + merge policy; model selection removed.** The
    "Add a task" modal now offers a default pipeline (`Block.pipelineId`, which the
    task's Run/Start controls use) and a merge policy preset. The per-task model
    picker is gone — a model is resolved per step, not per task.

  Migration `0025_task_run_config.sql` drops the `confidence_threshold` and `features`
  columns and adds `pipeline_id`. Bumps `@cat-factory/executor-harness` (the blueprint
  rendering inside its image changed).

- 8eed38c: Introduce a generic, extensible AI provisioning facade so model resolution is no
  longer hardwired to the Cloudflare Worker.

  `@cat-factory/agents` now exposes `CompositeModelProvider` — a `ModelProvider`
  composed from one or more mixable `ProviderRegistry` maps — plus the base,
  runtime-neutral resolvers (`openAiResolver`, `anthropicResolver`,
  `openAiCompatibleResolver`, `cloudflareRestResolver`, `baseProviderRegistry`) and
  the shared OpenAI-compatible endpoint constants. Direct vendor usage works on any
  runtime; `cloudflareRestResolver` adds a non-binding path to Cloudflare-hosted
  models (Workers AI REST / AI Gateway) for non-Worker deployments.

  AWS Bedrock support ships as a separate opt-in package,
  `@cat-factory/provider-bedrock` (`bedrockResolver` / `bedrockRegistry`), so the
  AWS SDK is pulled in only by deployments that use it. It throws a clear
  `Unsupported Bedrock model` for any model id outside its configured allow-list.

  `@cat-factory/worker`'s `CloudflareModelProvider` is now a thin composition of the
  shared facade (behaviour unchanged: same providers, same "not configured" errors),
  and a new installation extension point — `registerModelRegistry` — lets a
  deployment mix extra provider registries (e.g. Bedrock) into every container build,
  including the durable Workflow and cron-sweeper paths.

- f49fa30: Give the inline design/research agents (architect, researcher) provider-hosted web
  search. The `AiAgentExecutor` now attaches the AI SDK's server-executed `web_search`
  tool (Anthropic / OpenAI) to its one-shot call for an allow-listed set of kinds, plus
  a per-kind usage nudge — so those agents can verify current libraries/APIs instead of
  relying on training data, the same way Claude Code and Codex do. Opt-in and a no-op by
  default: enabled per deployment via `INLINE_WEB_SEARCH_ENABLED` (with
  `INLINE_WEB_SEARCH_KINDS` / `INLINE_WEB_SEARCH_MAX_USES` to tune the allow-list and
  cap), and only on providers that expose a hosted search — models on Workers AI / the
  OpenAI-compatible providers run unchanged. Both runtime facades wire it from env.

  The per-kind web-research nudge is data-driven, not a hardcoded switch:
  `AgentKindDefinition` gains an optional `webResearchHint`, so a proprietary/custom
  agent kind registered via `registerAgentKind` supplies its own nudge and the shared
  composer (`webResearchGuidanceFor`) picks it up — the shared surface never needs to
  know the custom kind exists. Built-in kinds carry sensible defaults; unknown kinds get
  a generic hint.

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

- 9be11e1: Add an automated merge-conflict resolver, and converge the container coding agents
  onto a shared base.

  **Conflict resolver.** Previously a PR that conflicted with its base degraded to a
  manual `merge_review` handoff. A new pre-merge `conflicts` gate now sits before the
  `ci`/`merger` steps in the standard pipelines (mirroring the CI gate): it reads the
  PR's mergeability (`PullRequestMergeabilityProvider` → GitHub `mergeable_state`) and,
  on a real conflict, dispatches a `conflict-resolver` container agent that clones the
  PR branch, merges the base in, has the agent resolve the conflicts, and pushes back
  onto the same branch — looping (bounded by the merge preset's attempt budget) until
  the PR is mergeable, or failing the run for a human if it can't. Pass-through when no
  mergeability provider is wired (e.g. tests / no GitHub), so existing behaviour is
  unchanged. The resolver never pushes a half-resolved tree (it guards on remaining
  unmerged paths).

  **Shared base.** The container agents were near-duplicates of one clone → write
  context → run Pi → push flow. They now share `runCodingAgent` (implement + ci-fix +
  conflict-resolve) on top of a thinner `withWorkspace` / `runAgentInWorkspace` base
  (also used by bootstrap / blueprint / merger), plus shared no-op-reason helpers — so
  fixes like the "judge the whole run, counting the agent's own commits" change apply
  everywhere instead of being re-derived per agent.

  Bumps `@cat-factory/executor-harness` (new `/resolve-conflicts` endpoint + shared-base
  refactor change its image).

- 5ec0d25: Real merge lifecycle: CI gate + CI-fixer, merger agent, and notifications.

  A task now becomes `done` only when its pull request is **actually merged** on
  GitHub — fixing the bug where a task showed "merged" (and a green board) from a
  confidence score alone, while CI was red and the PR still open.

  - **CI gate (`ci` step)** — auto-inserted before the merger in the standard
    pipelines. It polls the PR head's GitHub check runs and, on failure, dispatches a
    new **`ci-fixer`** container agent that pushes a fix to the PR branch, looping up
    to a configurable budget (default 10) until CI is green; polling stops the moment
    CI goes green. If the budget is spent it raises a `ci_failed` notification.
  - **Merger agent (`merger` step)** — runs last. A container agent scores the PR's
    complexity / risk / impact, and the engine compares those against the task's
    **merge threshold preset** to either auto-merge (a real GitHub merge) or raise a
    `merge_review` notification for a human. Presets are a per-workspace library
    (selectable per task); the CI-fixer attempt budget lives on the preset.
  - **`merger` is appended to the standard pipelines.** A pipeline with no merger now
    raises a `pipeline_complete` notification on completion (confirm + merge) instead
    of silently marking the task done.
  - **Notifications** — a new first-class, human-actionable board surface (inbox +
    events), modelled behind a `NotificationChannel` port so email/Slack delivery can
    be added later without touching the call sites. In-app delivery only for now.

  Adds migration `0024_merge_lifecycle.sql` (notifications + merge-preset tables, the
  `blocks.merge_preset_id` column). The executor-harness image gains `/ci-fix` and
  `/merge` endpoints (version bumped so the GHCR image is re-tagged).

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

- 5c8ca33: Add per-step human approval gates to pipelines, plus two board polish fixes.

  A pipeline step can now be marked "require approval" when building the pipeline
  (`Pipeline.gates`, parallel to `agentKinds`; persisted via the new `gates` column,
  migration `0023`). When a gated step finishes, the run parks — reusing the durable
  decision wait — and a human reviews the step's proposal in an editable modal, then
  either **Approves** (the edited proposal advances and flows to downstream steps as
  context) or **Requests changes** (the same step re-runs with the human's feedback
  folded into the agent's prompt via `AgentRunContext.revision`). New endpoints
  `POST /executions/:id/steps/:approvalId/{approve,request-changes}`
  (`ExecutionService.approveStep` / `requestStepChanges`). The gate is surfaced on the
  board card, inspector, focus view and the zoomed-in pipeline.

  The **requirements reviewer** is now an automated, inline pipeline step
  (`requirements` agent kind) that runs before the architect instead of a manual
  inspector button. The default "Full build" pipeline seeds it first and gates both
  the requirements review and the architecture proposal.

  Also: the inspector panel now scrolls when its content exceeds the viewport, and
  zoomed-in pipeline steps are clickable to reveal the prose conclusion each agent
  produced (matching the inspector).

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

- c664fe6: Let deployments mix in custom agent kinds and predefined pipelines programmatically —
  the same installation-level extension pattern as opt-in model providers
  (`registerModelRegistry` / `@cat-factory/provider-bedrock`).

  `@cat-factory/agents` now exposes an agent-kind registry (`registerAgentKind` /
  `registerAgentKinds`, `AgentKindDefinition`): a registered kind contributes its system
  prompt (string or `(kind) => string`), an optional custom user prompt, and an optional
  `requiresContainer` flag. `systemPromptFor` / `userPromptFor` consult the registry for
  custom kinds — after the built-in tracks (so a registered kind never shadows a
  standard-phase, acceptance, mock or business-logic kind) and before the generic
  fallback. The Worker's `CompositeAgentExecutor` routes a registered
  `requiresContainer: true` kind to the container executor (inline kinds need no harness
  changes and work end-to-end).

  `@cat-factory/kernel` now exposes a pipeline registry (`registerPipeline` /
  `registerPipelines`): registered pipelines are merged into `seedPipelines()` by id
  (appended, or replacing a built-in in place), so every new workspace is seeded with the
  deployment's pipelines alongside the built-in catalog.

  Both runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`) re-export
  `registerAgentKind` / `registerPipeline` (and the test-only `clear*` helpers) next to the
  existing model-provider seam, so a proprietary org package registers everything from one
  place at deployment-assembly startup. The agent-kind id was already an open string
  throughout (pipelines, steps, model defaults), so no schema change is required.

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

- 7dc8e57: Link integration context at task creation, GitHub issues as a source, and feed
  all linked context to every agent step.

  - **Linked context now reaches every step.** Documents (Confluence / Notion / …)
    and tracker issues (Jira / GitHub) attached to a task were only rendered into the
    prompts of the generic agent kinds — the four standard phases (architect, coder,
    reviewer, tester) silently dropped them, so the agents doing the work never saw
    the linked requirements/issues. The engine already resolves this context per step
    (`ExecutionService.buildAgentContext`); a shared `linkedContextSection` is now
    appended to every kind's user prompt (`@cat-factory/agents`), standard phases
    included.
  - **Attach context when creating a task.** The "Add a task" modal now lets you
    select already-imported documents and issues and links them to the new task on
    creation (previously only possible from the inspector after the fact).
  - **GitHub Issues as a task source.** A new `github` task source reuses the
    workspace's installed GitHub App (no separate credentials): it resolves the
    installation that owns the issue's repo and fetches the issue body + comments via
    the existing `GitHubClient` (new `getIssue`). Refs accept a full issue URL or the
    `owner/repo#number` shorthand. Wired in when `TASK_SOURCES` includes `github` and
    the GitHub integration is enabled.

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

### Patch Changes

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

- b48c455: Internal cleanup — no behavior or API changes. Deduplicates repeated helpers into
  shared modules: the subtask-snapshot comparison (`sameSubtasks`/`sameSubtaskItems`)
  used by the execution + bootstrap flows now lives in `@cat-factory/kernel`
  (`domain/subtasks.logic`), a `getErrorMessage` helper replaces the repeated
  `error instanceof Error ? error.message : String(error)` expression, the shared
  `STANDARDS_FOOTER` prompt line is centralized in `@cat-factory/agents`
  (`agents/prompt-shared`), and the identical document/task in-memory provider
  registries now extend a generic `MapSourceRegistry` exported from
  `@cat-factory/kernel`.
- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
- 197264e: Sharpen the `mocker` and `tester` agent prompts so they do real work instead of
  restating the implementer and resolving.

  - **Mocker.** Leads with the concrete goal — make the service runnable locally with
    just `docker-compose up`, every external SERVICE answered by a WireMock mock — and
    is now explicit that this is a hands-on build step: it must read the existing
    mappings, add/extend the stubs + fixtures + docker-compose wiring and COMMIT them.
    A prose-only "already covered" write-up with no committed mock files is called out
    as a failure of the step. The prose output is reframed as a summary of the mocks it
    committed (which services/operations are now mocked, and what was deliberately left
    unmocked).
  - **Tester.** Reframed as exploratory testing that actually runs the software:
    greenlights must be backed by observed runtime behaviour, not by reading the diff.
    It now starts from the earlier steps' artifacts — the `spec/` document and its
    Gherkin acceptance scenarios for the new functionality, and the WireMock mocks the
    mocker stood up on localhost via docker-compose — then probes edge/error cases and
    does a reasonable amount of regression testing of the blast radius. Sub-blocking
    issues go in `concerns` at low/medium severity without necessarily withholding the
    greenlight (the engine still skips the fixer when the report is greenlit).

  The existing tester gate already dispatches the `fixer` companion on a withheld
  greenlight and skips it when the tests pass — no wiring, pipeline or harness-image
  change for the prompts.

  **Frontend (`@cat-factory/app`).**

  - **Dedicated test-report window.** The `tester` archetype now declares a `resultView`,
    so opening a tester step opens a structured window (the universal result-view seam,
    like the requirements review) instead of the generic prose panel. It renders the
    report as a hierarchical tree — the scenarios the Tester exercised (its `tested`
    areas) → the per-area outcomes (passed / failed / skipped) → the concerns grouped
    under them — plus the greenlight verdict, outcome counts and the fixer-attempt state.
    The service spec is not yet exposed to the SPA, so spec-element linkage is derived
    from the report itself (a future spec endpoint can make it explicit).
  - **Companion visualization.** Companion steps (`reviewer` / `architect-companion` /
    `spec-companion` / `fixer`) are now visually tagged as companions in the pipeline
    views, and a gate step's conditionally-run companion — today the Tester's `fixer` —
    renders as a distinct sub-node marked **possible / running / completed / skipped**
    (in both `PipelineProgress` and the inspector's `TaskExecution`). `fixer` is added to
    the agent catalog + the `AgentKind` union.

- b80d657: Reorganize the `agents/` source into focused subfolders so each agent's prompt is
  easy to find. Pure internal refactor: the package's public barrel exports are
  unchanged, the precompiled template output is byte-identical, and behaviour is the
  same. The prompt TEXT now lives under `agents/prompts/*` (one file per track:
  `standard`, `acceptance`, `business-logic`, `mock`, `testing`, `companion`,
  `requirements`, plus the thin `roles` map extracted from the old `agent-catalog`,
  and the shared `shared`/`delivery-contract` constants); metadata ABOUT kinds lives
  under `agents/kinds/*` (`companions`, `traits`, `configs`, `read-only`, `registry`,
  `versions`); the model-call machinery lives under `agents/runtime/*` (`executor`,
  `routing`, `fragments`, `web-search`); and `agents/catalog.ts` is the dispatcher
  that maps a kind to its prompt. The versioned-prompt registry (`versions`) is split
  from the requirements prompt text (`prompts/requirements`) it references.
- 2dd7e56: Spec reviewer (`spec-companion`) now judges only what the Spec Writer controls.

  The reviewer kept faulting the writer for things the writer was never allowed to add:
  error paths, validation rules, and status codes the requirements never stated (or
  explicitly put out of scope), plus open questions like "is an extra field discarded?".
  That is reviewing the requirements, not the spec — exactly what the writer's mandate
  forbids it from filling.

  The prompt now: covers the happy path for every stated behaviour plus only the
  error/edge/boundary cases the requirements explicitly call for or that a stated
  requirement cannot be satisfied without; honours the requirements' own non-goals,
  assumptions, and exclusions instead of penalising the spec for leaving them out; and
  never asks the writer to "clarify" or "decide" a question the requirements left open.

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

- Updated dependencies [fe53445]
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
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [268c15d]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [4a08935]
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
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2d66d34]
- Updated dependencies [a54ada2]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/prompt-fragments@0.7.0
