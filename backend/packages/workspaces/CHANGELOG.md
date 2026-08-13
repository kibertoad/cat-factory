# @cat-factory/workspaces

## 0.28.8

### Patch Changes

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0

## 0.28.7

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0

## 0.28.6

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2

## 0.28.5

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/kernel@0.298.1

## 0.28.4

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0

## 0.28.3

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0

## 0.28.2

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1

## 0.28.1

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0

## 0.28.0

### Minor Changes

- edd4fd0: A fourth built-in model preset, **GPT-5.6 Sol** (`mdp_chatgpt`), is seeded for every workspace
  alongside Kimi K2.7, GLM-5.2 and Claude Opus 5, so `claude | chatgpt | kimi` is finally expressible
  as a pin rather than as a note in a config file.

  It needs no new catalog route to be usable. `gpt-5.6-sol` carries an `openrouter` route and a Codex
  `subscription` route, which is the same pair `claude-opus` already had, so `effectiveVariant` lands
  on whichever the workspace holds: an OpenRouter key alone makes the preset dispatchable to a SYSTEM
  API key (a Codex subscription is per-seat and individual-only, so a system token may not spend one),
  and a connected subscription wins where there is one. Deliberately NOT a seeded default on any
  deployment shape: Cloudflare and Node still seed Kimi K2.7, local mode still seeds Claude Opus 5.
  The seed id names a VENDOR rather than a generation (`mdp_chatgpt`, not `mdp_gpt56sol`) so a built-in
  can roll its `baseModelId` forward without becoming a preset nobody selected; argued in ADR 0056.

  **An OpenAI API key is not one of those routes, and the run-start refusal now says which are.**
  `openai` is a first-class poolable provider with its own onboarding copy, so "add an API key for the
  provider" read as a `platform.openai.com` secret key, which cannot make this preset dispatchable.
  `providers_unconfigured` now names each unusable model's DECLARED routes, computed from the catalog by
  the new kernel `declaredModelRouteLabels`: `gpt-5.6-sol (needs OpenRouter or ChatGPT (Codex))`. That
  fixes the misattribution for every subscription-or-gateway-only model rather than for this one, and
  `details.models` still carries the bare ids the SPA and the four SDK clients read.

  **Model presets gained the catalog NAME channel pipelines already had.** The snapshot ships
  `modelPresetCatalogNames` beside `modelPresetCatalogVersions`, built from one `seedModelPresets()`
  read. A brand-new built-in has no stored row to take a name off, which is exactly the state the
  startup advisory offers to fix: without the map the SPA humanises the id, so every board created
  before this release would have been offered "Chatgpt" instead of GPT-5.6 Sol. A new optional field on
  the wire, so an older SPA keeps working off the humanised fallback.

  **The built-in seed is now ONE batched write.** `ModelPresetRepository.upsertMany` (mirrored D1 batch
  and Drizzle transaction, allow-listed for mothership mode) replaces a serial `upsert` per built-in on
  a path that runs at a workspace's first board load, where every shipped built-in used to add a
  round-trip. The single-default invariant is read over the batch: a promoted member demotes every row
  outside it, and each member's own flag stands as written.

  `catalog.test.ts` gains the assertion nothing else could make: every built-in's base model AND every
  per-kind override names a model `MODEL_CATALOG` actually ships. A preset's `baseModelId` is a plain
  string matched at DISPATCH, so a built-in naming a renamed or dropped model typechecks, seeds, lists
  and is selectable, then fails on the first agent step of whichever run picked it. The expectation is
  derived from the catalog rather than hand-listed, so a rename breaks a test instead of a live run. The
  conformance seeding assertion is derived the same way, and now compares the persisted rows against
  the catalog member by member and in order instead of counting them.

  The `acceptance-suite-operator-setup` initiative tracker is retired into
  [ADR 0056](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0056-acceptance-suite-operator-setup.md),
  its committed scope now complete.

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0

## 0.27.28

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/kernel@0.294.1

## 0.27.27

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0

## 0.27.26

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0

## 0.27.25

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2

## 0.27.24

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1

## 0.27.23

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0

## 0.27.22

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0

## 0.27.21

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1

## 0.27.20

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0

## 0.27.19

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/kernel@0.289.1

## 0.27.18

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0

## 0.27.17

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0

## 0.27.16

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/kernel@0.287.0

## 0.27.15

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/kernel@0.286.3

## 0.27.14

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/kernel@0.286.2

## 0.27.13

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

## 0.27.12

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/kernel@0.286.0

## 0.27.11

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/kernel@0.285.3

## 0.27.10

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2

## 0.27.9

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/kernel@0.285.1

## 0.27.8

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/contracts@0.291.0

## 0.27.7

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0

## 0.27.6

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0

## 0.27.5

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1

## 0.27.4

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0

## 0.27.3

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/kernel@0.281.3

## 0.27.2

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2

## 0.27.1

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/kernel@0.281.1

## 0.27.0

### Minor Changes

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

## 0.26.27

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0

## 0.26.26

### Patch Changes

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/kernel@0.279.3

## 0.26.25

### Patch Changes

- Updated dependencies [3036af7]
  - @cat-factory/kernel@0.279.2

## 0.26.24

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/kernel@0.279.1

## 0.26.23

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0

## 0.26.22

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0

## 0.26.21

### Patch Changes

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/kernel@0.277.0

## 0.26.20

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0

## 0.26.19

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/kernel@0.275.4

## 0.26.18

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/kernel@0.275.3

## 0.26.17

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/kernel@0.275.2

## 0.26.16

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/kernel@0.275.1

## 0.26.15

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/kernel@0.275.0

## 0.26.14

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0

## 0.26.13

### Patch Changes

- Updated dependencies [a62bcf8]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0

## 0.26.12

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/contracts@0.274.0

## 0.26.11

### Patch Changes

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0

## 0.26.10

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0

## 0.26.9

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0

## 0.26.8

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0

## 0.26.7

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0

## 0.26.6

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0

## 0.26.5

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0

## 0.26.4

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0

## 0.26.3

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0

## 0.26.2

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/kernel@0.262.2

## 0.26.1

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/kernel@0.262.1

## 0.26.0

### Minor Changes

- 7a2730a: Fold a board's un-rolled spend inside its own delete, so the durable record ends where the board did

  `spend_days` is deliberately outside the workspace-delete cascade: money already spent is an
  account-level fact, and reclaiming it would shrink last quarter's TCO retroactively and silently.
  Keeping it out of that list was made real by bounding the sweep's rewrite to boards that still
  exist, because `token_usage` IS cascaded and an unbounded window DELETE would otherwise re-fold
  nothing and reclaim the deleted board's most recent days on the sweep's own schedule.

  That bound left the mirror-image gap, which this closes. The sweep reaches only boards that still
  exist, so a board's spend SINCE the last completed rollup day has never been folded when its delete
  begins, and its ledger rows go with the cascade before any later pass could see them. The loss was
  bounded by the sweep interval, permanent, and skewed worst for exactly the boards an operator
  deleted because they were expensive. `WorkspaceService.delete` now runs one final per-workspace fold
  before the cascade, beside the binary-artifact purge and for the same reason: afterwards there is
  nothing left to read.

  Three things make that fold a different shape from a sweep pass, and each was a decision rather than
  a detail:

  - **It walks to now in chunks instead of capping its window.** A sweep can leave a wide catch-up for
    its next pass; this board has no next pass, so the span cap becomes a chunk size rather than a
    truncation. Truncating would have introduced a second, quieter version of the same loss.
  - **It walks newest-first, on a budget, and one bad chunk does not end it.** The walk is unbounded
    by construction (a watermark left stale by an outage plans a ledger-retention's worth of chunks)
    and it runs inside a user's delete request rather than on a cron. Unbounded, on the Worker, it
    stops preserving the board's spend and starts preventing its deletion: the invocation dies before
    the cascade, and the retry reads the same watermark and plans the same walk. So the walk stops at
    `FINAL_SPEND_FOLD_BUDGET_MS` and a failing chunk costs only itself, which makes the ORDER decide
    what survives: newest-first, because every report window this rollup serves is anchored at now
    while the far end of a stale catch-up falls outside even the 90-day one.
  - **It does not touch the coverage marker.** `rolledUpThrough` is deployment-scoped and states how
    far the SWEEP has covered every board at once. One board's final fold covers no other board's
    days, and the marker only ever moves forward, so advancing it there would permanently present
    days nothing folded as covered.
  - **It keeps the still-exists guard anyway.** Called after the cascade the fold reads nothing, and
    an unguarded window DELETE would then reclaim the frozen rows the exclusion exists to keep. The
    guard makes the fold-then-cascade ordering a property of the query rather than of the call site,
    so both halves of "a rewrite may only delete what it can reproduce" live in the same statement.

  The resume point and the ledger-retention horizon are the sweep's own, which is why the pure walk
  (`spendRollupWindow` plus the new `finalSpendFoldPlan`) moved from `@cat-factory/orchestration` into
  kernel: the two callers sit in different layers and restating the horizon rule per caller is exactly
  how the delete path would end up stepping over days a sweep would still have folded. Facades now
  wire `tokenUsageRetentionMs` onto `CoreDependencies` so both derive it from one number.

  The fold is best-effort, which is a trade worth reviewing: refusing the delete on a sick rollup query
  would keep the spend foldable for a retry, but it would also render a reporting outage as a board
  that cannot be deleted. So the delete proceeds and what was not folded is named on one `warn`, whose
  fields keep the causes apart because they need different responses: what the ledger no longer holds
  (already unfoldable before the delete began), what the store refused, what the budget never reached,
  and a resume point that could not be read at all.

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0

## 0.25.2

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/contracts@0.261.1
  - @cat-factory/kernel@0.261.0

## 0.25.1

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0

## 0.25.0

### Minor Changes

- 24f76f1: Make the audit log readable, and make revoking a session actually end it

  **Breaking for existing sessions: everyone signs in again once after this deploys.** A session
  token now carries a `gen` claim, and one that carries none is refused rather than admitted. That is
  the deliberate choice: treating an absent claim as "current" would be a permanent bypass of the
  whole revocation mechanism, and it is the hole an attacker would aim at. The cost is a single
  re-login; the alternative is a dual-read path that never goes away. Internal wire shape, pre-1.0,
  per the repo's compatibility policy.

  Two enterprise loose ends, and they are the same story from both ends.

  The audit log has been WRITE-ONLY in the product since it landed. Privileged actions were recorded
  faithfully and there was no way to read them back: no route, no viewer, and no retention, so the
  one table designed to be kept for years was also the one growing without a bound. It now serves a
  keyset-paginated page to account admins and renders in an admin panel, as translated sentences
  composed from the row's machine-readable fields rather than from stored prose — which is what lets
  a row written today read correctly for somebody in another language years later, and what makes an
  action this build no longer declares render as "unrecognised" instead of splicing `undefined` into
  an operator's screen. Names are resolved at render time in one batched read per page, and a name
  that no longer resolves stays null so the id shows: the person being gone is exactly the thing the
  row is kept to record. A failed READ is rendered differently from an empty log at every layer,
  because an audit viewer that reports an outage as "nothing happened" tells an admin the reverse of
  the truth. Retention arrives with its own knob (`AUDIT_EVENT_RETENTION_DAYS`, default 730 days),
  which is the governance half of keeping the log in its own store: it cannot be shortened as a side
  effect of tuning a telemetry window, and the prune takes a cutoff and nothing else, so it can never
  be used to remove the record of one inconvenient thing.

  The other end is enterprise SSO, whose whole offboarding promise is "we disabled them in the
  identity provider and they lost access". A stateless signed session could not deliver that: group
  membership was already re-read on every sign-in, so a removed person could not get a NEW session,
  but the one they were already holding stayed valid until it expired. Each user row now carries a
  session generation that every token is stamped with, so ending every session a person holds is one
  write with nothing to enumerate. An SSO sign-in the directory refuses now cuts their live sessions
  as well as withholding a new one; an admin can do the same for a member who has left or lost a
  laptop (recorded in the audit log, naturally); and anyone can sign themselves out everywhere.

  An SSO refusal only ends existing sessions when the DIRECTORY is what refused. A refusal caused by
  a claim that never arrived (a dropped `groups` scope, a renamed claim name, a provider that stopped
  marking an address verified) still blocks the login, but withholds the revocation: those refusals
  are indistinguishable from "removed from every group", and they fire for everybody at once, so
  treating them as offboardings would turn one configuration regression into a deployment-wide forced
  sign-out.

  Two decisions worth knowing. A role change deliberately does NOT revoke: the RBAC gate re-reads
  roles on the next request and the token carries none, so coupling them would sign a person out of
  every board because their role on one was adjusted. And the check is a NEW read on a path that
  previously touched no store at all — served through the app cache with invalidation on every bump,
  which means the Worker (whose isolates share no invalidation bus, so the entry passes through
  there) pays a real per-request read. That is accepted rather than discovered: a cache with a TTL
  would go on admitting a bearer a peer isolate had already revoked, and "they lost access, within
  the minute" is not the claim an offboarding story can make.

  Still open, and stated so nobody assumes otherwise: run start/stop/retry are not yet audited. That
  half needs the mothership to derive the row from what it observes rather than accept it from a
  node's say-so, since a node cannot be allowed to write events that name their own actor — the
  design question is written up in `docs/initiatives/audit-log-and-session-revocation.md`.

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/kernel@0.259.0

## 0.24.0

### Minor Changes

- 4be3510: Refuse to auto-merge when no merge policy resolves at all

  A run whose task pinned no preset, in a workspace whose preset library had not been seeded (or a
  deployment with no preset repository wired), used to fall back to `DEFAULT_RISK_POLICY`, which is
  `Balanced` with auto-merge ON. So a deployment that had configured no merge policy still landed
  pull requests on a merger model's own scores.

  That unresolved case now resolves the new `FALLBACK_RISK_POLICY`, which auto-merges nothing. The
  shipped `Balanced` preset is unchanged: still `autoMergeEnabled: true`, still the seeded default,
  still no per-class floors. The refusal carries its own merge-decision reason,
  `no_policy_configured`, kept apart from `auto_merge_disabled` because the remedies differ in kind:
  one names a preset somebody chose and is fixed by editing it, the other says the deployment has
  stated no merge policy at all.

  A board's built-in preset library is now written when the board is CREATED rather than by the
  first `list()`. The engine resolves a task's governing preset without listing anything, so seeding
  on a read left a board nobody had opened with no library at all: a run started over the public API
  resolved the fallback and refused, while the identical run after one board load merged.
  `RiskPolicyService` still repairs an empty library on read, for boards that predate this.

  The `merge_review` inbox card is now worded from the decision's own reason rather than from a pair
  of booleans beside it, so every rung of the merge ladder describes what actually refused. Only
  `exceeded_thresholds` still blames the ceilings; the other reasons no longer report a PR as scored
  "outside the task's auto-merge thresholds" when no threshold took part in the decision.

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/kernel@0.258.0

## 0.23.8

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0

## 0.23.7

### Patch Changes

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/kernel@0.256.0
  - @cat-factory/contracts@0.258.0

## 0.23.6

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/kernel@0.255.1

## 0.23.5

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0

## 0.23.4

### Patch Changes

- Updated dependencies [ee6ce7c]
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0

## 0.23.3

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0

## 0.23.2

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0

## 0.23.1

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0

## 0.23.0

### Minor Changes

- 4c071ec: Close the last committed gaps in reusable operations: hide one per board, invoke one headlessly.

  Five changes, landed together because the last two turned out to depend on each other: the public
  task-type catalog has to honour suppression (a type it lists and creation then refuses is worse than
  one it omits), and both read the registry through the same projection the board snapshot does.

  - **Per-workspace suppression.** An org registers its operations process-wide, so twenty of them
    flood the picker of a team that runs three. A workspace admin (`settings.manage`) now hides the
    ones that board does not use. Tombstones in a new `task_type_suppressions` table (D1 ⇄ Drizzle,
    with conformance), so ABSENCE is the default and a newly registered operation reaches every board
    until somebody hides it: the only direction whose silent failure is a surplus rather than a
    withheld capability. Three readers, and their failure postures differ on purpose: the board
    snapshot and the public catalog are best-effort (a picker must not take a board load down over a
    cosmetic preference), while `BoardService.addTask` PROPAGATES, because it decides whether a row is
    written and hits the same database as the insert. The creation refusal is what makes the hiding
    real: the internal API, the public API, an initiative spawn and a tracker import all reach
    `addTask` without ever seeing a picker. Built-in types stay unsuppressible (they carry hardcoded
    creation affordances). Mothership bucket: `remote`, because the catalog is code and the hide-list
    is data.

  - **Public API: discover a form, then fill it.** `/api/v1` could always NAME a task type and fill
    none of it, so a headless caller filed an operation and every agent in the run worked from a blank
    form. `GET /api/v1/task-types` (`read`) serves the built-in types plus this workspace's registered,
    non-suppressed ones with the fields each accepts; `fields` on task creation fills them, landing in
    `taskTypeFields.custom` for a custom type and on the schema-typed top-level keys for a built-in
    one, so existing creation machinery runs unchanged. Additive per ADR 0034: OpenAPI `info.version`
    → 1.18.0, SDKs regenerated. One table (`contracts/src/public-task-types.ts`) backs BOTH directions
    rather than the descriptors-plus-hand-written-OpenAPI-shape the design sketched, so what discovery
    advertises is exactly what creation validates, through the shared `validateDescriptorFields` the
    app's own form runs. Refusal is a 422 with `details.reason: 'task_type_fields_invalid'` carrying
    every problem at once.

  - **Descriptor defaults apply at the door, not in the form.** `withDescriptorFieldDefaults` runs
    server-side at both descriptor doors (a custom type's creation bag and an initiative preset's
    inputs) before validate + sanitize. A field that is both `required` and defaulted was accepted
    from the SPA (which had already seeded it) and refused for every other caller, which had no way
    to know it must restate a value the deployment already declared. The SPA now seeds from the same
    shared helper rather than its own copy. Consequence worth naming: because defaults are
    authoritative, a `select` default outside its own options is now a boot ERROR
    (`task_type_field_default_outside_options`) instead of a form that merely opened oddly.

  - **The new-pipeline advisory names a pipeline instead of humanising its id.** `pipelineCatalogNames`
    rides beside `pipelineCatalogVersions`, built from the same `seedPipelines()` read so the two
    cannot list different ids. Humanising was fine for shipped built-ins and wrong the moment a
    deployment registered its own: `pl_org_introduce_api` was offered as "org introduce api", on
    exactly the boards that predate an operation and therefore see this advisory.

  - **The Go SDK client's accessor list was three groups stale.** `me`, `evidence` and `keys`
    generated services that nothing constructed, so those endpoints were uncallable from Go while
    every drift check passed. All are wired, and `check-sdks.mjs` now fails on a resource group Go's
    hand-written client never constructs. Two emitters had the sibling latent bug: group names are
    camelCase in the surface table and every group was one word until `taskTypes`, so Python now
    snake-cases them (`client.task_types`) and so does the MCP facade, whose tool name and group are
    the strings a HOST allow-lists and a model calls (`task_types_list`, and `task_types` in
    `CAT_FACTORY_MCP_GROUPS`). A NEW resource group, as opposed to a new operation, is what exercises
    those paths.

  Breaks, all internal and unreleased: `CoreDependencies` and `BoardServiceDependencies` gain an
  optional `taskTypeSuppressionRepository`; `snapshotRegistryProjections` takes an optional workspace
  id (absent at workspace-create, which cannot have hidden anything); `PublicTaskCreationDeps` gains
  `taskTypeRegistry`; the snapshot gains `suppressedTaskTypes`; the Python SDK's and the MCP
  facade's multi-word resource names are now snake_case.

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0

## 0.22.5

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0
  - @cat-factory/kernel@0.249.0

## 0.22.4

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0

## 0.22.3

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0

## 0.22.2

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/contracts@0.248.0

## 0.22.1

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0

## 0.22.0

### Minor Changes

- ec96387: Account audit log, slices 1 and 2: privileged tenancy actions are now recorded, with the store and the
  first real writers landing together.

  Until now nothing left a record of who did what: role changes, budget edits, invitations sent and
  revoked, board roster changes and access-mode flips all happened with the resulting STATE as the only
  evidence. `audit_events` (D1 ⇄ Drizzle, cross-runtime conformance) is an append-only log of them,
  written at the point each mutation commits, and the tenancy services in `@cat-factory/workspaces` are
  the first writers: account member add / role change, account budget and settings edits, invitation
  create / revoke / accept, and the workspace roster's add / role change / remove / access-mode flip.

  Four decisions worth knowing, because each has a wrong-looking alternative that reads as correct:

  **It gets its OWN store, and not for the reason telemetry has one.** An audit log looks append-heavy
  and therefore telemetry-shaped, but it is the mirror image: low-volume (admin actions, single digits
  per account per month, against telemetry's row-per-LLM-call) and long-retention where telemetry
  prunes at three days. What makes it a storage question is the run-lifecycle slice, after which this
  becomes the only table in the platform that grows monotonically with run volume AND wants a
  multi-year window; on a store with a hard 10 GB per-database ceiling that would put a years-deep
  trail in competition with live transactional state. Measured at ~500 B/row on Postgres (the index
  costing as much as the data, since the keyset carries `id` as its tie-break), so 1,000 runs/day is
  ~550 MB/year. It is a required `AUDIT_DB` D1 database on Cloudflare and an `audit` Postgres schema on
  Node. It is emphatically NOT in the telemetry store: that bucket is written and read on the LAPTOP in
  mothership mode, which would scatter the trail across nodes and leave it readable and deletable by
  the person it audits.

  **OPERATOR ACTION on Cloudflare**: `AUDIT_DB` is required, so a deployment must provision it
  (`wrangler d1 create cat_factory_audit`, then paste the id into its `wrangler.toml`;
  `db:migrate:remote` applies `audit-migrations` alongside the other lineages). Required means
  required, and not softly: the container build refuses an unbound binding, so a Worker deployed
  without it answers the misconfiguration screen on every request rather than running silently
  unaudited, and `/ready` reports `audit` so an operator reads which binding is missing. Per-PR preview
  environments provision and tear the database down automatically.

  **A row states VALUES, never a sentence.** An event carries `action` plus machine-readable
  `details` (`{"previousRole":"viewer","role":"admin"}`), and the viewer composes its copy from
  translated keys. Recording a ready-made English summary is the tempting shape and is wrong here for
  a reason peculiar to this store: rows are kept for years, so prose written today could never be
  re-rendered for a reader in another locale, and a persisted shape cannot be quietly changed later the
  way a wire shape can. `AUDIT_ACTION_DETAIL_KEYS` in contracts names each action's fields, so the
  writer and the viewer agree about the slots and a new action cannot ship with values the copy has no
  place for. For the same "closed but persisted" reason `targetType` is a picklist rather than a free
  string, and both vocabularies read back through guards derived from their own picklists: a member
  retired from the union arrives NAMED as retired (`{ retired: 'account.seat_reassigned' }`), never
  guessed onto a current member and never dropped, since a missing row is the one failure an audit log
  must not have.

  **The actor is a discriminated principal, and `system` is asserted rather than defaulted.** `user`,
  `apiKey` and `system` are three kinds, not a nullable user id, because "the engine did it" and "we
  lost track of who did it" are different facts and a log rendering them identically misattributes a
  human action to automation. Where no acting user resolves (only reachable under `AUTH_DEV_OPEN`, where
  the whole authorization model is bypassed) NOTHING is recorded rather than an event blaming the engine.
  `apiKey` is separate from the user who minted the key, so a leaked key is not indistinguishable from
  that person in the log.

  **`record` cannot FAIL the action it describes, but it is awaited.** The append runs behind
  `runBestEffort`, so a store outage costs the audit row and logs a warning, never the membership change
  the operator asked for. It is deliberately not fire-and-forget: an un-awaited write is discarded when
  a Worker isolate freezes after the response (the rule `http/waitUntil.ts` exists to state), so
  `record`-and-return would have recorded nothing on the primary runtime while every test driving a fake
  recorder went on passing. One store round-trip is worth strictly more than the milliseconds it costs
  an admin action. The READ has the opposite disposition and propagates: a viewer silently rendering an
  empty page when the store is down tells an admin the exact opposite of the truth.

  `CoreDependencies.auditRecorder` is REQUIRED, joining `logger` and `operationalMetrics` for the same
  reason and with the sharpest version of it: an un-wired audit log reads as "nobody changed anything",
  which is precisely the assurance it exists to give. A deployment that does not persist audit events
  passes kernel's `noopAuditRecorder`, which says so in code.

  INTERNAL BREAK: `WorkspaceMemberService.setRole`, `.remove` and `.setAccessMode` each take a trailing
  `actingUserId: string | null`, matching `.add`'s existing shape. Without it those three writes had no
  actor to attribute, and defaulting them to `system` would have been the misattribution above.
  `@cat-factory/server`'s controller supplies `c.get('user')?.id ?? null`.

  Still to come on this initiative: the paginated read endpoint and the admin viewer UI, run-lifecycle
  and API-key events, session revocation, and the retention sweep (so the table is unbounded until that
  slice lands).

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0

## 0.21.60

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/kernel@0.243.1

## 0.21.59

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0

## 0.21.58

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0
  - @cat-factory/contracts@0.243.0

## 0.21.57

### Patch Changes

- Updated dependencies [7cf3e70]
  - @cat-factory/kernel@0.241.1

## 0.21.56

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0

## 0.21.55

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0

## 0.21.54

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/kernel@0.239.0

## 0.21.53

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/contracts@0.239.0

## 0.21.52

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/contracts@0.238.0

## 0.21.51

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/kernel@0.236.1

## 0.21.50

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0

## 0.21.49

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1

## 0.21.48

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0

## 0.21.47

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/kernel@0.234.2

## 0.21.46

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/kernel@0.234.1

## 0.21.45

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0

## 0.21.44

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/contracts@0.231.0

## 0.21.43

### Patch Changes

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0

## 0.21.42

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0

## 0.21.41

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0

## 0.21.40

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0

## 0.21.39

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/kernel@0.228.1

## 0.21.38

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0

## 0.21.37

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0

## 0.21.36

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0

## 0.21.35

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0

## 0.21.34

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0

## 0.21.33

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0

## 0.21.32

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0

## 0.21.31

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/kernel@0.221.1

## 0.21.30

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/kernel@0.221.0

## 0.21.29

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/kernel@0.220.0

## 0.21.28

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0

## 0.21.27

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0

## 0.21.26

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0

## 0.21.25

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0

## 0.21.24

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0

## 0.21.23

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/kernel@0.214.1

## 0.21.22

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0

## 0.21.21

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0

## 0.21.20

### Patch Changes

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/contracts@0.210.1

## 0.21.19

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0

## 0.21.18

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0

## 0.21.17

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0

## 0.21.16

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0

## 0.21.15

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0

## 0.21.14

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/contracts@0.206.1

## 0.21.13

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0

## 0.21.12

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0

## 0.21.11

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0

## 0.21.10

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0

## 0.21.9

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/contracts@0.203.0
  - @cat-factory/kernel@0.201.1

## 0.21.8

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/kernel@0.201.0

## 0.21.7

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0

## 0.21.6

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0

## 0.21.5

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/contracts@0.200.0

## 0.21.4

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/contracts@0.199.0
  - @cat-factory/kernel@0.197.0

## 0.21.3

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0

## 0.21.2

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0

## 0.21.1

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/kernel@0.194.0

## 0.21.0

### Minor Changes

- be7fe66: Let a deployment declare its infra dependencies in code: `startNode`/`startLocal` take
  `seedSharedStacks`, and a compose layer can now be an inline document or a file in another repo.

  A `StackRecipe`'s and a `SharedStack`'s `composeFiles` entries are now `ComposeFileRef`s — a bare
  in-repo path (unchanged, still the common case) or an explicit `ComposeSource`: `inline` (the
  compose document itself) or `repo` (a path in another `owner/name`, read without cloning it). A
  stack whose layers are all inline / foreign owns no repository, so `SharedStack.cloneUrl` is
  nullable.

  An `inline` layer may name where it is materialized, and that path is host-escape guarded on every
  path that accepts one: a layer that would land outside the checkout is refused when the shared
  stack is SAVED (`details.reason: 'compose_layer_escapes_checkout'`) and again before any layer is
  read or written, alongside the recipe path's existing pre-daemon check.

  Breaking (pre-1.0): `SharedStack.cloneUrl` is `string | null` rather than `string`, and
  `composeFiles` entries widen from `string` to `string | ComposeSource`. D1 migration `0070`
  rebuilds `shared_stacks` to relax the `clone_url` NOT NULL; the Drizzle mirror does the same. No
  data changes — every existing row keeps its clone URL and its plain-path layers.

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0

## 0.20.0

### Minor Changes

- 83fd037: Retire built-in pipelines: remove ones that are no longer relevant through the reseed lifecycle

  A built-in pipeline is copied into every workspace at creation, so withdrawing one from the catalog
  in code did nothing for boards that already had it — `reseed` had no definition left to resolve and
  `remove` refused every built-in, leaving an obsolete pipeline in each existing library permanently
  (and still startable). Retirement closes that gap.

  - Kernel gains a tombstone list (`buildRetiredPipelines` in `domain/seed.ts`, exposed as
    `retiredPipelines()`). Retiring a built-in is TWO edits — delete its definition from the builder
    AND name its id in the tombstone list — and they do different jobs: the deletion is what takes the
    pipeline out of `seedPipelines()` (so it stops being seeded into new workspaces, drops out of the
    catalog versions, and stops being reseedable, with no change at any of its call sites), while the
    tombstone is the separate positive assertion that the id used to be ours and is now obsolete, which
    is what reaches a board that already stored it. Doing only the deletion is the silent no-op this
    release fixes; doing only the tombstone is caught by a kernel unit test and a boot check.
  - `PipelineRegistry` gains `retire(id, { replacedBy })` / `retired()` / `mergeRetired()`, so a
    deployment can withdraw its OWN registered pipelines. `register` and `retire` are inverses for an
    id, and a live catalog entry always wins, so the live and retired sets stay disjoint. A deployment
    cannot withdraw a BUILT-IN this way (that would be a route to emptying the curated palette), and
    `validateRegistrations` now raises `retirement_of_live_pipeline` at boot when a `retire()` call
    names a still-live pipeline, rather than leaving the ignored call to be discovered as a cleanup
    that never appeared.
  - `PipelineService.remove` accepts a built-in only while it is retired (a pipeline the catalog still
    ships stays read-only), and the workspace snapshot ships `retiredPipelines` beside
    `pipelineCatalogVersions`.
  - The SPA's pipeline-health advisory grows a "Retired pipelines" section offering a per-row removal,
    naming the replacement when the catalog declares one — resolved from the stored row when the board
    has one and from the catalog otherwise, since the usual retirement is superseded-by-a-newly-shipped
    built-in, which has no row until someone adds it. A retired pipeline is excluded from every reseed
    offer, including the "new built-ins available" list.

  Also fixes an adjacent gap: deleting a pipeline that a recurring schedule still points at is now
  refused with a 409 naming the fix, for custom pipelines as much as retired built-ins. Previously the
  delete succeeded and every subsequent fire of that schedule failed silently. A paused (`enabled:
false`) schedule blocks the delete too — pausing is not detaching, and the breakage would otherwise
  surface when someone re-enabled it. That refusal and the two pre-existing schedule refusals on
  `update` now carry machine-readable `details.reason` codes (`pipeline_schedule_attached` /
  `pipeline_schedule_requires_recurring` / `pipeline_schedule_intake_unconfigured`), so the SPA words
  them in the user's language instead of surfacing the raw English message.

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0

## 0.19.20

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0

## 0.19.19

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0

## 0.19.18

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0

## 0.19.17

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0

## 0.19.16

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0

## 0.19.15

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0

## 0.19.14

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/kernel@0.185.1

## 0.19.13

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0

## 0.19.12

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0

## 0.19.11

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0

## 0.19.10

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0

## 0.19.9

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0

## 0.19.8

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0

## 0.19.7

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0

## 0.19.6

### Patch Changes

- Updated dependencies [9d965c9]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0

## 0.19.5

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0

## 0.19.4

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/contracts@0.183.0
  - @cat-factory/kernel@0.176.0

## 0.19.3

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0

## 0.19.2

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0

## 0.19.1

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0

## 0.19.0

### Minor Changes

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

- 71ea4ec: Fix a service frame jumping to a different spot on the board right after it is resized (and after
  any other frame edit, including a rename or an archive/restore). A frame's board position is a
  per-workspace layout override carried on its mount, so the shared block row keeps whatever
  coordinates it was created with — but the single-block mutation responses were built straight from
  that row, and the SPA upserts the authoritative block a mutation returns. Frame-returning reads now
  project through the same `applyMountLayout` the board snapshot uses. Importing a repo that already
  backs a shared service likewise returns the frame placed where this board just mounted it, instead
  of at the home board's coordinates.
- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0

## 0.18.16

### Patch Changes

- Updated dependencies [9d8fe9b]
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0

## 0.18.15

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/kernel@0.170.0

## 0.18.14

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0

## 0.18.13

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0

## 0.18.12

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/kernel@0.167.1

## 0.18.11

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/kernel@0.167.0

## 0.18.10

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0

## 0.18.9

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1

## 0.18.8

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0

## 0.18.7

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0

## 0.18.6

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/contracts@0.169.0
  - @cat-factory/kernel@0.163.1

## 0.18.5

### Patch Changes

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/kernel@0.163.0

## 0.18.4

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/contracts@0.168.0
  - @cat-factory/kernel@0.162.0

## 0.18.3

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0

## 0.18.2

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0

## 0.18.1

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/kernel@0.159.1

## 0.18.0

### Minor Changes

- 1f8ca48: Let a deployment declare environment-handler seeds so infra handlers are registered programmatically instead of via the SPA.

  A deployment can now pass `seedEnvironmentHandlers` (a list of `RegisterHandlerInput`) to `start()` / `startLocal()`. The server idempotently ensures each seed's `environment_connections` handler exists for **every existing workspace at boot** (a best-effort, fire-and-forget backfill over `workspaceService.list(null)`) and for **each newly-created workspace** (`WorkspaceService.create`), so a service's declared provision type resolves a handler with no manual Infrastructure → Test environments step. Seeding is idempotent (a handler already present for a `(provisionType, manifestId)` is skipped) and per-seed fault-tolerant (a bad seed is logged and skipped, never crashing boot or workspace creation).

  New: the `EnvironmentHandlerSeeder` kernel port, the deployment-neutral `createEnvironmentHandlerSeeder` (`@cat-factory/integrations`), a late-bound `getEnvironmentHandlerSeeder` dependency on `WorkspaceService`, an `environmentHandlerSeeder` handle on the container, and the exported `backfillEnvironmentHandlerSeeds` runtime helper.

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0

## 0.17.26

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0

## 0.17.25

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0

## 0.17.24

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0

## 0.17.23

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0

## 0.17.22

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/contracts@0.160.1

## 0.17.21

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/kernel@0.154.1

## 0.17.20

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0

## 0.17.19

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0

## 0.17.18

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0

## 0.17.17

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0

## 0.17.16

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/kernel@0.150.0

## 0.17.15

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0

## 0.17.14

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.17.13

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4

## 0.17.12

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.17.11

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2

## 0.17.10

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/kernel@0.148.1

## 0.17.9

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0

## 0.17.8

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.17.7

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2

## 0.17.6

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.17.5

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.17.4

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1

## 0.17.3

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/kernel@0.145.1

## 0.17.2

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0

## 0.17.1

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0

## 0.17.0

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

## 0.16.9

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.16.8

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.16.7

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.16.6

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1

## 0.16.5

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.16.4

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2

## 0.16.3

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1

## 0.16.2

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0

## 0.16.1

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1

## 0.16.0

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
  - @cat-factory/kernel@0.138.0

## 0.15.2

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1

## 0.15.1

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.15.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0

## 0.14.2

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0

## 0.14.1

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/kernel@0.134.1

## 0.14.0

### Minor Changes

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

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0

## 0.13.51

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0

## 0.13.50

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0

## 0.13.49

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0

## 0.13.48

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0

## 0.13.47

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/kernel@0.129.2

## 0.13.46

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.13.45

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0

## 0.13.44

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/kernel@0.128.1

## 0.13.43

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0

## 0.13.42

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0

## 0.13.41

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0

## 0.13.40

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0

## 0.13.39

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.13.38

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3

## 0.13.37

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1

## 0.13.36

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.13.35

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.13.34

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0

## 0.13.33

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.13.32

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.13.31

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

## 0.13.30

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

## 0.13.29

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.13.28

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.13.27

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/kernel@0.121.2

## 0.13.26

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.13.25

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

## 0.13.24

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.13.23

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.13.22

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/kernel@0.118.1

## 0.13.21

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0

## 0.13.20

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6

## 0.13.19

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.13.18

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4

## 0.13.17

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.13.16

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

## 0.13.15

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.13.14

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.13.13

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.13.12

### Patch Changes

- ddb0b68: Fix account/identity orphaning on a dangling identity, and add referential integrity for the
  user-identity lineage.

  **Login no longer silently forks a new account.** `UserService.findOrCreateByIdentity` resolves
  a user by inner-joining `users` onto `user_identities`, so it returned `null` for BOTH "never
  seen this identity" and "identity row present but its `users` row is gone". The two were
  conflated: a dangling identity (a `users` row removed out from under a still-present
  identity/account/subscription) made login create a fresh, empty user + personal account,
  silently stranding the original account and everything on it (subscriptions, secrets, settings)
  with no error surfaced. It now distinguishes the two via the join-free `getIdentity` read and
  **fails loudly** (logged, 500) on a dangling identity instead of forking, so the corruption is
  caught and healed rather than masked.

  **DB-level referential integrity (both runtimes).** Previously nothing referenced `users(id)` at
  the schema level, so an unsafe delete orphaned dependent rows with no complaint. Add
  `ON DELETE RESTRICT` foreign keys so a `users` row can no longer be dropped while any of these
  still reference it:

  - `user_identities.user_id → users(id)`
  - `accounts.owner_user_id → users(id)`
  - `personal_subscriptions.user_id → users(id)`
  - `memberships.user_id → users(id)`
  - `subscription_activations.user_id → users(id)`

  Node/Postgres: five validating `ADD CONSTRAINT` FKs (Drizzle schema + generated migration).
  Cloudflare/D1: migration `0046_user_identity_foreign_keys.sql` rebuilds the five tables with the
  FKs (deferring FK enforcement to commit via `PRAGMA defer_foreign_keys`, like `0001_init`) and
  also corrects `user_id` on `personal_subscriptions`, `memberships`, and `subscription_activations`
  from `INTEGER` to `TEXT` (matching the canonical `usr_*` id and the Postgres columns).

  No data migration. On a database that already contains orphaned rows, the validating Postgres
  constraint (or the D1 table-copy) will fail at boot — that is the intended loud surfacing of
  pre-existing corruption; re-point or remove the orphaned rows and re-run.

## 0.13.11

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.13.10

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0

## 0.13.9

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0

## 0.13.8

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/contracts@0.121.2

## 0.13.7

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.13.6

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.13.5

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/kernel@0.111.1

## 0.13.4

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/contracts@0.121.0

## 0.13.3

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.13.2

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0

## 0.13.1

### Patch Changes

- 8319e52: Fix a first-sign-in race in `AccountService.ensurePersonalAccount` that 500'd
  `GET /accounts` ("cannot reach backend") on a fresh DB.

  The method was a non-atomic check-then-act: concurrent first-load requests all read
  "no personal account yet", then all `INSERT`, so all but one failed with a duplicate-key
  violation on the personal-account partial unique index (`idx_accounts_personal`) and the
  error surfaced as an unhandled 500.

  The create path is now atomic. A new `AccountRepository.ensurePersonal(account)` port
  inserts-or-returns the surviving row — D1 via `INSERT OR IGNORE`, Postgres via
  `ON CONFLICT DO NOTHING` — so concurrent first-sign-in callers all converge on the same
  account with no rejection. Both runtimes implement it and a cross-runtime conformance
  assertion fires the concurrent resolution and asserts a single account results.

  The sibling paths are unaffected: `createOrg` is a deliberate non-idempotent create (org
  accounts have no such unique index), and `ensureMembership` already writes through an
  idempotent `upsert`.

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.13.0

### Minor Changes

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

## 0.12.14

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.12.13

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.12.12

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.12.11

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0
  - @cat-factory/contracts@0.118.0

## 0.12.10

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/kernel@0.104.4

## 0.12.9

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/kernel@0.104.3

## 0.12.8

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2

## 0.12.7

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0
  - @cat-factory/kernel@0.104.1

## 0.12.6

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0

## 0.12.5

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0

## 0.12.4

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0

## 0.12.3

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/kernel@0.101.2

## 0.12.2

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1

## 0.12.1

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0

## 0.12.0

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

## 0.11.27

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/kernel@0.99.1

## 0.11.26

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/contracts@0.108.0

## 0.11.25

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0
  - @cat-factory/kernel@0.98.0

## 0.11.24

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0

## 0.11.23

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0

## 0.11.22

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0

## 0.11.21

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0

## 0.11.20

### Patch Changes

- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0

## 0.11.19

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/kernel@0.92.0

## 0.11.18

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0

## 0.11.17

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0

## 0.11.16

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/kernel@0.89.1

## 0.11.15

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0

## 0.11.14

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.11.13

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.11.12

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/kernel@0.86.1

## 0.11.11

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0

## 0.11.10

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.11.9

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.11.8

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.11.7

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0

## 0.11.6

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0

## 0.11.5

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0

## 0.11.4

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/kernel@0.79.1

## 0.11.3

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0

## 0.11.2

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0

## 0.11.1

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0

## 0.11.0

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

## 0.10.28

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0

## 0.10.27

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0

## 0.10.26

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.10.25

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0

## 0.10.24

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0

## 0.10.23

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2

## 0.10.22

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.10.21

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.10.20

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/kernel@0.69.8

## 0.10.19

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.10.18

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/kernel@0.69.6

## 0.10.17

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/kernel@0.69.5

## 0.10.16

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/kernel@0.69.4

## 0.10.15

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/kernel@0.69.3

## 0.10.14

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/contracts@0.80.1

## 0.10.13

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1

## 0.10.12

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0

## 0.10.11

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1

## 0.10.10

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0

## 0.10.9

### Patch Changes

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0

## 0.10.8

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/kernel@0.66.1

## 0.10.7

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0

## 0.10.6

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0

## 0.10.5

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0

## 0.10.4

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/kernel@0.63.4

## 0.10.3

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/kernel@0.63.3

## 0.10.2

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2

## 0.10.1

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/kernel@0.63.1

## 0.10.0

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

## 0.9.43

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/kernel@0.62.4

## 0.9.42

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/kernel@0.62.3

## 0.9.41

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/kernel@0.62.2

## 0.9.40

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/kernel@0.62.1

## 0.9.39

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0

## 0.9.38

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/kernel@0.61.1

## 0.9.37

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0

## 0.9.36

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0

## 0.9.35

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0

## 0.9.34

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0

## 0.9.33

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.9.32

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0

## 0.9.31

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/kernel@0.56.1

## 0.9.30

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0

## 0.9.29

### Patch Changes

- fdeb466: Eliminate N+1 query loops in the service layer. `ExecutionService.teardownForBlockTree` now
  resolves runs with a single `listByWorkspace` instead of a per-block `getByBlock`;
  `TaskConnectionService.listSourceStates` hoists its installation/connection reads out of the
  per-provider loop; and `BoardService` (`removeBlock` / `addServiceFromRepo`) and
  `AccountService.listForUser` batch their per-item point reads via two new chunked-`IN`
  repository methods, `ServiceRepository.listByFrameBlocks` and `AccountRepository.listByIds`
  (implemented symmetrically on the D1 and Drizzle stores, with cross-runtime conformance
  coverage). Behavior is unchanged.
- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.9.28

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1
  - @cat-factory/kernel@0.55.3

## 0.9.27

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/kernel@0.55.2

## 0.9.26

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/kernel@0.55.1

## 0.9.25

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0

## 0.9.24

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0

## 0.9.23

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/kernel@0.53.1

## 0.9.22

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0

## 0.9.21

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1

## 0.9.20

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0

## 0.9.19

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0

## 0.9.18

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0

## 0.9.17

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0

## 0.9.16

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0
  - @cat-factory/kernel@0.47.2

## 0.9.15

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/kernel@0.47.1

## 0.9.14

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0

## 0.9.13

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0

## 0.9.12

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5

## 0.9.11

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/kernel@0.45.4

## 0.9.10

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.9.9

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2

## 0.9.8

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.9.7

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0

## 0.9.6

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0

## 0.9.5

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.9.4

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/kernel@0.42.2

## 0.9.3

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1

## 0.9.2

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0

## 0.9.1

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0

## 0.9.0

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

## 0.8.0

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

## 0.7.46

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/kernel@0.38.1

## 0.7.45

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0

## 0.7.44

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0

## 0.7.43

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0

## 0.7.42

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0

## 0.7.41

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0

## 0.7.40

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0

## 0.7.39

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0

## 0.7.38

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0

## 0.7.37

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0

## 0.7.36

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0

## 0.7.35

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/kernel@0.28.1

## 0.7.34

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0

## 0.7.33

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0

## 0.7.32

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1

## 0.7.31

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0

## 0.7.30

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0

## 0.7.29

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0

## 0.7.28

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0

## 0.7.27

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0

## 0.7.26

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0

## 0.7.25

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0

## 0.7.24

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0

## 0.7.23

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0

## 0.7.22

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0

## 0.7.21

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2

## 0.7.20

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/kernel@0.16.1

## 0.7.19

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0

## 0.7.18

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1

## 0.7.17

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0

## 0.7.16

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0

## 0.7.15

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/kernel@0.13.4

## 0.7.14

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/kernel@0.13.3

## 0.7.13

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2

## 0.7.12

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1

## 0.7.11

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0

## 0.7.10

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/contracts@0.12.0

## 0.7.9

### Patch Changes

- Updated dependencies [f8a24e0]
  - @cat-factory/kernel@0.11.1

## 0.7.8

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0

## 0.7.7

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/kernel@0.10.1

## 0.7.6

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0

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

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1

## 0.7.0

### Minor Changes

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

- 6406c8c: Extract `@cat-factory/workspaces` from `@cat-factory/core`

  `WorkspaceService` and `AccountService` (tenancy base services) move to the new
  `@cat-factory/workspaces` package. `@cat-factory/core` re-exports the full surface
  for backward compatibility — no consumer import paths change.

### Patch Changes

- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
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
