# @cat-factory/mcp-server

## 0.52.1

### Patch Changes

- 9f8cabc: Re-point the DeepSeek Flash route at the model DeepSeek actually serves, take the agent CLIs at
  their newest, and refresh the dependency tree.
  
  **A retired model behind a live alias.** DeepSeek retired V4-Flash and V4-Flash-Vision-Exp on
  2026-09-10 and made `deepseek-flash` the canonical, unversioned name for V4.1-Flash. The old
  `deepseek-v4-flash` id still resolves, but only as a TEMPORARY compatibility alias onto the new
  model, which is the quietest shape this catalog's failures take: nothing throws and nothing fails
  to dispatch, so the picker went on saying "DeepSeek V4 Flash" while a different model answered, at
  a rate the spend table did not carry, and the route dies outright whenever the alias is withdrawn.
  All three DeepSeek-served arms of the `deepseek` entry (direct, subscription, and the OpenRouter
  one, which must name the same model or the entry straddles two) now name the live model. The entry
  keeps its `deepseek` id: that id is what a workspace persists against a block, and this is the same
  slot following the vendor's own successor, so re-minting it would invalidate every stored pick to
  say nothing new. `acceptsImages` is new on both refs and is a real capability gain rather than a
  correction, since V4.1-Flash folds the vision line back into the main model.
  
  Two adjacent claims were re-read rather than trusted. The 2026-09-10 release note said
  `deepseek-v4-pro` would route to V4.1-Flash from 2026-09-14, which would have silently demoted that
  entry to a cheaper, weaker model; DeepSeek has since decided to keep serving V4 Pro with billing
  unchanged, so it is untouched. And OpenRouter still serves a separate `deepseek/deepseek-v4-flash`
  at a fifth of the price, which this entry deliberately does not keep: it is the retired build, and
  an entry whose direct and gateway arms named different models is the neighbouring-version trap the
  catalog header bans. Both retired price keys stay in the table so historical spend rows keep
  costing correctly.
  
  **No other catalog gap.** Every frontier launch since the last sweep was checked against its
  serving provider and is already here: Claude Fable 5.1, Gemini 3.8 Flash, Muse Spark 1.3 and GPT-6
  Astra. Claude Mythos 5.1 stays out on purpose. It is the same model as Fable 5.1 at identical
  pricing, offered by invitation only through Project Glasswing with no public route on any provider
  this platform reaches, so an entry could only be a re-badge that `effectiveVariant` would pick and
  then fail to dispatch. "Astra Pro" stays out for the reason recorded last time, re-checked here:
  OpenRouter mints a slug for it, but reasoning effort is a parameter on the single `gpt-6-astra` id.
  
  **Agent CLIs at their newest**, ahead of the 24h `minimumReleaseAge` window, as the Dockerfile's
  standing note allows for those three pins alone: Claude Code 2.1.265 to 2.1.270 and Codex 0.153.4
  to 0.154.0 (still above the 0.153.0 floor `gpt-6-astra` needs). Pi holds at 0.85.1, already newest.
  The two Pi extensions do NOT take that exemption and hold at 2.9.0: 2.10.0 published three hours
  before this change and has not aged past the window. Both harness images move to the newest
  `node:26-trixie-slim` digest that has (node 26.8.2), and the executor image tag rolls to 1.158.0
  with the deploy image at 0.6.8.
  
  **Dependency refresh**: direct ranges plus a lockfile re-resolution, 31 resolved names moved, no
  package name dropped. `pg-boss` 12.31.0 brings `rrule-temporal` and `temporal-spec` in as new
  transitive deps, the only additions. A `pnpm dedupe` follows the bump because the partial
  re-resolution left `@types/node` resolved at two patch versions. Four holds are unchanged and were
  re-verified at HEAD rather than assumed: `vitest` at 4.1.11 and `wrangler` at 4.124.0
  (`@cloudflare/vitest-pool-workers` 0.22.0 is still newest, peers `vitest: ^4.1.0` and pins that
  wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the resolved workerd's date, which
  that pool pins), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 reaches for
  `typescript/lib/tsc`, absent from TS 7's exports map). pnpm moves 11.24.0 to 11.26.0, staying on
  its major. WireMock holds at 3.13.1, still its newest non-prerelease. Actions: `setup-java` v6.0.0
  to v6.0.1 and `zizmor-action` v0.6.3 to v0.6.4; every other pinned action is already newest.
- Updated dependencies [9f8cabc]
  - @cat-factory/sdk@0.54.1

## 0.52.0

### Minor Changes

- 69fc66c: Watch a run that works in chunks: an SSE decision channel, bug-fishing verbs, and a step-boundary
  webhook event
  
  Three of the platform's longest operations work in CHUNKS. A PR deep review slices a diff, reviews
  the slices in parallel and aggregates. A bug-fishing expedition dispatches one read-only pass per
  angle per territory, recording each catch as it lands. A requirements review iterates. Each runs for
  minutes to tens of minutes, and none of it reached the stream: an SSE frame is emitted when the RUN
  projection changes, and what those operations move through lives on step state the projection does
  not carry. A seventeen-minute review produced no frame at all and then one `decision` at the park,
  while the public-API guide told a caller to poll the decisions endpoint for exactly the progress the
  stream could not give it.
  
  `GET /api/v1/runs/{runId}/decision-events` streams that decision list: a `decision-state` frame
  carrying the same payload `GET /api/v1/runs/{runId}/decisions` answers, pushed whenever it changes,
  so a slice reporting, a challenge verdict landing or an expedition's angle settling arrives without
  polling. Its own endpoint rather than a `?decisions=true` flag on the run streams, and that is the
  decision worth reading: a query parameter added to an existing operation is emitted as a positional
  argument ahead of the trailing options bag, so `client.tasks.stream(taskId, options)` becomes
  `client.tasks.stream(taskId, query, options)` and Go's `Stream(ctx, taskID)` grows an argument, which
  is an in-place retype of four released clients. A new operation is additive, and it is the better
  shape anyway: keyed by RUN like the list it streams, so one endpoint serves a board task and a
  headless job where the flag needed adding to two. The frame carries the WHOLE list, never a subset,
  because an empty `decisions` that means "nothing is being asked" and one that means "this payload was
  narrowed" are opposite facts. What it does reduce is the model-authored PROSE inside the list, which
  is where the volume is: over-long strings are clipped to a preview and `truncated: true` reports the
  clip, the same bargain `publicRunStep.truncated` strikes on the run streams. The point read still
  serves every field whole.
  
  `bug-fishing` joins the decision surface as a fourteenth kind, with the three verbs the app already
  drives: mark findings to be addressed (one bug-fix task per mark), dismiss one, finish triaging. A
  parked expedition used to arrive in `unanswerable[]` as a `curation_gate` saying the marking had to
  happen in the app, while the step's own approval gate WAS offered, so a `decide` key could end an
  expedition with everything it caught unacted on but could not act on any of it. Both shipped curating
  kinds are now answerable; `curation_gate` keeps a narrower population, a curating kind a deployment
  registered itself. All three verbs refuse an expedition the run has already advanced past
  (`expedition_settled`), which is the one state curation is not accepted in: marking is deliberately
  open while later angles are still being fished, so "settled" is what has to be checked and a stale
  finding id could otherwise be replayed into fix tasks nothing is left to link them to.
  
  The outbound webhook's `runEvents` family gains `run.step_completed`, one delivery per step
  BOUNDARY, opt-in per event like the rest. This is the narrowing of the per-step feed ADR 0030
  rejected, not a reversal: that rejection was about a progress feed the engine emits on every
  container poll, where this fires ten times over a ten-step pipeline. Its `deliveryId` carries the
  step index AND the step's attempt, because it is the one event a single run emits repeatedly and it
  does so along both axes: the family's two-part key would collapse a whole pipeline onto its first
  step, and an index-only key would collapse a step's rework cycles onto its first pass. `step.outcome`
  distinguishes `skipped` from `completed`, because the engine skips a gated step by marking it done
  with no output. The member is APPENDED to the vocabulary rather than slotted in beside the edge it
  belongs with: that list's order is published as a Java enum's `ordinal()` and as a `*_VALUES` array
  in three more clients.
  
  The `/api/v1` spec moves to 1.74.0 and the change is additive throughout. One thing to watch on the
  generated clients: bug-fishing's `confidence` vocabulary is `high|medium|low` and a reviewer
  finding's `severity` is `low|medium|high`, and the SDK emitter's enum signature is value-sorted, so
  two vocabularies spelled the same way collapse onto one type whose name and member order come from
  whichever walks first. Left alone that deleted `PublicReviewFindingSeverity` from four released SDKs.
  The emitter now answers both halves of that: a pin fixes member ORDER as well as the name (and is
  checked to be a permutation of the real set), and a vocabulary that merely coincides can be declared
  DISTINCT, so `confidence` publishes as `PublicBugFishingConfidence` rather than under a name that
  asserts it is a reviewer finding's severity.

### Patch Changes

- Updated dependencies [69fc66c]
  - @cat-factory/sdk@0.54.0

## 0.51.0

### Minor Changes

- 2cf867d: Pick the best-practice standards a task is judged against, over `/api/v1`
  
  A workspace curates best-practice standards, merged across the deployment's shipped catalog, the
  account's library and the board's own; an agent working under one is held to it, and a reviewer
  additionally rates how closely the change followed each. Which of them apply is a real per-task
  question (a security sweep, a migration, a pull request in a repository whose rules differ from its
  service's), and it was answerable from the app and from the internal API and nowhere else. A caller
  filing a review headlessly could name the pull request, the focus, the pipeline and the model, and
  could not say what the reviewer was to judge it against. Its only lever was the enclosing SERVICE's
  standing set, which is the right default and aims any change at every other task under that service.
  
  `GET /api/v1/prompt-fragments` serves the merged catalog and `fragmentIds` on task creation names
  ids from it, the same pairing `GET /api/v1/task-types` has with `fields`. `PublicTask` reads back
  `fragmentIds`, which is the one pin a caller cannot predict from what it sent: the platform unions
  the list with the service's standards and the task type's defaults and freezes the result.
  
  **The catalog carries each standard's identity, not its `body`.** Naming a standard needs the id,
  the title, the category, the one-line summary and the tags, which is also exactly what the
  platform's own relevance selector decides from; the body is the authored text of an organisation's
  engineering guidelines, which is a different thing to publish than a list of what it has written
  down. Each entry also says which `tier` it won on, because an account-wide rule and one this board
  authored need different fixes when a standard is wrong.
  
  **The read sits at `write`, not at `read`.** Withholding the body is not enough to make the lower
  floor honest: a standard imported from a repo of Markdown guidelines carries no authored summary,
  so the importer derives one from the opening of the file, and for those entries the published
  `summary` is a capped slice of the guidance itself. `write` is the scope that NAMES a standard on a
  task, which keeps the discovery pairing exact (a key that can fill `fragmentIds` can read the
  vocabulary it fills it from) with nothing derived from an org's guidelines below it. It stays under
  the `admin` the preset libraries take, because naming a standard is not managing one.
  
  **The list is keyset-paginated from this first release** (`?limit=`, `?cursor=`, `nextCursor`),
  ordered by `fragmentId`. A catalog is not self-limiting: a tier can link a repo directory and get
  one standard per Markdown file, so an unbounded first release would have left only a `/v2` or a
  silent truncation as the way to add the bound afterwards.
  
  **Fragment ids have ONE ceiling now** (`MAX_FRAGMENT_ID_LENGTH`), shared by the hand-authored `id`,
  the repo-source mint and this public field, which is what makes "the catalog serves it ⇒ the create
  accepts it" structural rather than a coincidence of two numbers. A sourced id is
  `src:<sourceId>:<slugified path>` and had no bound at all, so a deep enough guidelines directory
  produced ids the create door would have refused with a generic length error. The mint now truncates
  with a stable digest of the slug (a prefix cut alone drops the filename, which is the half that
  distinguishes siblings in a deep tree), and a file whose FRONTMATTER declares an over-long id is
  declined with a warning rather than shortened, since that id is the author's own choice and a
  rewritten one shadows nothing. Existing sourced fragments with an over-long id are re-minted on the
  next sync: the old id tombstones and the new one starts at version `1.0.0`.
  
  **An id the board does not resolve is refused** (`422`, `details.reason:
  'prompt_fragment_not_found'`, `details.fragmentIds` naming every one that missed) where the RUN path
  drops it. The run path is right to drop: a standard deleted after a task was filed must not break
  the run. At the door it is the wrong disposition, because a typo would answer `201` for a review
  that folded nothing, which reads afterwards exactly like a review nobody asked to be judged against
  anything. The check lives at this door rather than on `BoardService` beside the preset-pin guard,
  and the reason is not the store it reads: the app's create form submits the service's inherited
  standards verbatim alongside the person's own picks, so the same refusal there would turn one stale
  library id into a service nobody can file a task under. Here every id was named by the caller, in
  the same request cycle it read the catalog in. The route now checks the CONTAINER before any of
  this: every other refusal on it presumes a service that exists, so answering an unknown-standard
  `422` for a typo'd `serviceId` sent an integrator to fix the wrong end of a two-part mistake.
  
  The `blockTypes` value set is now pinned in the SDK IR's enum table. It is shared with
  `publicService.type` and is walked first alphabetically under its new home, so leaving it positional
  would have respelled the published `PublicServiceType` in four clients as a side effect of adding an
  unrelated endpoint, arriving as a clean generated diff nobody reads.
  
  OpenAPI `info.version` 1.72.0 -> 1.73.0. The Python and Java clients (Kotlin with them) carry the
  new operation and models, so their manifests move 0.7.0 -> 0.8.0: for those two the version change
  IS the release, so regenerating without it would have shipped the catalog in two clients of four.

### Patch Changes

- Updated dependencies [2cf867d]
  - @cat-factory/sdk@0.53.0

## 0.50.0

### Minor Changes

- 5dc7506: Drive the whole PR deep review through `/api/v1`
  
  Triggering a review of an existing GitHub or GitLab pull request, reading back its prioritized
  findings and posting the ones a person kept as inline comments was already reachable over the
  public API, one call at a time. Driving it end to end was not, for three reasons that only show up
  once something goes wrong.
  
  **A `post` that failed reported nothing.** A partial or total failure re-parks the review at
  `awaiting_selection` with its resolution cleared, which is byte-for-byte a review nobody has
  curated yet: a caller that posted seven comments and landed none read back the state it held a
  moment before, and either looped or reported success. The `pr-review` decision now carries
  `postReport` (what was attempted, what posted, what was folded into the summary comment because its
  line falls outside the diff or the branch moved, and the provider's own error per finding) and
  `postedFindingIds` (what a retry skips, so re-posting the same selection never double-comments).
  The report names the PASS it describes (`attempt`, against the decision's `postAttempts`), because
  a retry that fails identically leaves an otherwise byte-identical report and the defect would
  reappear one level in; `postedBody` states whether the summary comment has landed, so
  `bodyPosted: null` is readable as "suppressed, it already went" rather than "there was none". A
  finding dismissed after a failed pass loses its `failures[]` row with it, so no id on this surface
  names a finding the caller can no longer see.
  
  **A wedged review had no exit but throwing the work away.** The reviewer fans its slices out across
  parallel subagents and emits findings only in a final aggregation turn, which can hang with every
  slice finished; the watchdogs cannot see it and the 60-minute kill discards the lot. The app could
  already re-dispatch only the slices that never reported, and now so can a key:
  `POST /api/v1/runs/{runId}/decisions/pr-review/resume`. BOUNDED, unlike the app's own resume, and
  projecting the evidence a bound needs (`resumeAttempts` / `maxResumeAttempts`, `reportedSlices`,
  `lastActivityAt`): each call stops the running reviewer and starts a fresh container, so a poller
  resuming on a timer shorter than the review takes would otherwise kill it forever, each time it
  was about to finish. A person clicking Resume in the window is watching what they nudged, which is
  the judgement a headless caller cannot supply.
  
  **A `write` key could start a review it could not finish.** Both `pl_review` and `pl_bug_fishing`
  are single-step pipelines whose step parks the run for a person to curate what it found, and public
  admission could not see that park: the two kinds park through machinery of their own rather than
  through anything a registry declared, so a `write` key was admitted and then held a run whose every
  verb needs `decide`. Both kinds now carry a `curation-gate` trait, which is the sixth park mechanism
  admission enumerates and the fourth it derives from a registration, so a deployment's own curating
  kind is seen with no edit there. **Starting either preset now needs a `decide` key**
  (`403 pipeline_requires_decide_scope`), and so does RETRYING a run whose stored steps carry one: a
  start path is not the only way to set a park in motion. The refusal names `pr-review` as answerable
  through the decision surface and `bug-fisher` as not, and it names the DECISION KINDS rather than
  the park surfaces, three of which are spelled differently in the two places (a `pr-reviewer` step
  is answered by a `pr-review` decision, both brainstorm kinds by one `brainstorm`), so an
  integration mapping the refusal onto `decisions[]` no longer hunts for an entry that is never
  there. A run parked on the curation this API cannot answer now NAMES that wait
  (`unanswerable[].reason = "curation_gate"`), which is what makes "honestly reported as parked with
  nothing to answer" true rather than an empty list plus an approval that would end the run.
  
  OpenAPI `info.version` 1.71.0 → 1.72.0. The Python and Java clients (Kotlin with them) carry the
  new operation and models too, so their manifests move 0.6.0 → 0.7.0: for those two the version
  change IS the release, so regenerating without it would have shipped the loop in two clients of
  four.

### Patch Changes

- Updated dependencies [5dc7506]
  - @cat-factory/sdk@0.52.0

## 0.49.3

### Patch Changes

- 333b967: Meter every two-band model in the band its prompt actually lands in, check the cache classes the
  table DERIVES, take the agent CLIs at their newest, and refresh the dependency tree.
  
  **Six rows were metering a long-context request at half its input rate.** OpenAI bills a request
  whose prompt reaches 272,000 input tokens entirely at roughly double the short rate, with no
  blending, and Gemini 3.1 Pro does the same at 200,000 tokens. Every OpenAI row and the Gemini Pro
  row carried the SHORT band, so a long-prompt run metered at half its input and around 60% of its
  output. The catalog gives all six entries a window over a million tokens, so a container agent
  re-sending a large checkout crosses that threshold as ordinary behaviour, not as an edge case.
  
  **`ModelPrice` now carries both bands, and the meter picks between them.** A two-band row states
  its base rates plus a `longBand` (rates, cache tiers and the threshold), `bandFor` selects on the
  request's total input, and both metering entry points already hold that count: `estimateCost` gets
  `inputTokens`, and `estimateClassedCost` sums the three input classes, because a vendor's threshold
  is stated against the whole request and a 300K prompt served mostly from cache crosses it all the
  same. Ten OpenAI rows, Gemini 3.1 Pro and the three Grok 4.6 rows carry a band, and each band's
  cache tiers derive from that band's own input rate. A caller that cannot see the prompt size, which
  is the telemetry rollup's rate resolver, still gets the DEARER band: of the two answers open to it,
  only that one keeps a budget safe.
  
  Pricing the whole row at the long band instead is worse in both directions the figure is read. A
  short-prompt run meters at roughly double its cost, which on inline judges and estimators is the
  majority of calls and trips a workspace ceiling at half its real spend. The same rows are also the
  picker's informational list price, rendered with no band annotation, so GPT-6 Astra would read
  18.4/69 beside Claude Fable 5 at 9.2/46 while both bill $10/$50 at ordinary prompt lengths.
  `modelCostResolver` stays on the base band for that reason, and the split between `priceFor` (the
  list price a human compares) and `ratesFor` (the rate a budget meters) is now stated at both.
  
  The DYNAMIC per-workspace OpenRouter overlay still folds a model's bands to their maximum
  (`dearestRate`), because which band applies depends on the prompt actually sent and a catalog
  refresh has none to read. So enabling a two-band model in a workspace catalog meters its short
  requests conservatively where the curated row prices each band exactly; carrying the threshold
  through the catalog metadata is what would close that.
  
  **A DERIVED cache rate can understate the live one, and nothing was checking it.** A row names a
  cache rate only where the vendor departs from the `CACHE_*_MULTIPLIER` floor, and
  `check-openrouter-pins.mjs` skipped every unnamed class on the grounds that a derived figure has no
  pin to have drifted. The derived figure is still what the budget meters with, and it follows OUR
  input rate rather than the vendor's cache rate: `openrouter:z-ai/glm-5.3` was metering cache reads
  at 54% of the live rate while the report said "nothing to do", on the class a container agent's
  re-sent prefix lands in every turn. That row now names its rate, and the check compares the
  EFFECTIVE rate for four classes rather than the pinned numbers for three.
  
  Three things keep that from becoming noise. A cache class is compared only where a hit can actually
  land on the route, read out of the contracts `GATEWAY_PREFIX_POLICY` rather than restated, and the
  gate covers a NAMED rate as well as a derived one: a figure no hit reaches is inert however it was
  obtained, which is what `pricing.test.ts` already records for the two Alibaba slugs. The live side
  is read band for band, so a row priced correctly in both bands reports nothing rather than flagging
  its short band on every run. And the pinned THRESHOLD is checked as well, against the lowest
  `min_prompt_tokens` the route publishes: pinned above the live one, every request between the two
  meters in a band the vendor has stopped charging.
  
  Three parser fixes came with it, each of which silenced a comparison rather than breaking one. The
  policy-map and price-row readers count braces and skip comments and strings, where a `[^}]*` match
  ends the policy map at the `{@link}` reference sitting between its entries (leaving every vendor
  declared below that line invisible) and would end a price row at its nested band's closing brace.
  The cache-WRITE class reads `input_cache_write_1h` as a fallback, the order `cacheWriteRate`
  applies on the dynamic path, so a route publishing only the long TTL is compared instead of passing
  by default. And a non-array `overrides` is treated as no bands rather than thrown on, because a
  throw exits 1, which is this script's reserved signal for a pinned route that was withdrawn.
  
  `openrouter:moonshotai/kimi-k2.7-code` is re-pinned from $0.674 / $3.40 to the $0.71 / $3.50 the
  gateway's blend reads today, and its named cache read to 0.18: 0.17 sat under the 0.1748 the
  conversion gives by more than the checker's rounding tolerance. The two Workers AI Kimi rows that
  round the same vendor figures are corrected with it. The DeepSeek alias rows are re-stamped and
  deliberately not moved: both now sit above their live rate, and Pro has swung $0.556 to $1.60 to
  $0.946 across three reads in a fortnight, so chasing that blend down would spend the table's margin
  on noise.
  
  **Every other rate was re-read and is unchanged**, against each vendor's own list rather than
  inferred: Anthropic, the twelve Workers AI partner rows, Z.ai, Moonshot K3 and K2.6, DeepSeek's
  peak bands, xAI, Qwen3.8 Max and Flash. Two prose corrections came out of it. Gemini 3.7 Flash's
  half-rate promotion has lapsed on the gateway, so the row's deliberate over-count against it no
  longer describes anything, and all three Flash routes now serve at the list price the rows carry.
  Qwen3.8 Max is confirmed flat across its whole 1M window, unlike most of the Qwen line.
  
  **No major model is missing.** Everything shipped between 2026-09-01 and 2026-09-04 is already in
  the catalog, and every one of the 27 curated OpenRouter routes is still served at the context
  window it declares. Three re-checked and still not added: GPT-6 Astra Pro carries the same
  $10 / $50 short band, the same $20 / $75 long band and the same 1,050,000-token window as
  `gpt-6-astra`, and OpenAI's pricing page lists no row for it, so an entry could only re-badge a
  model already here; Claude Mythos 5.1 is limited-availability; and Mercury 2.5, the one text model
  the gateway has gained since, is a new vendor family rather than a frontier route.
  
  Pi holds at 0.85.1, Codex at 0.153.4 and both Pi extensions at 2.9.0, each already newest. Claude
  Code goes 2.1.263 to 2.1.265, taking its newest release ahead of the 24h age window as the
  Dockerfile's standing note allows. Playwright holds at 1.63.0 and WireMock at 3.13.1, both still
  newest stable. `node:26-trixie-slim` still resolves to the pinned digest, so no base image moved.
  The executor image tag rolls to 1.156.0, and the DEPLOY image tag to 0.6.6: the dependency refresh
  reaches the deploy harness's own `@types/node` range, which is an image source, and republishing
  over a live tag does not roll a deployment out.
  
  Dependency refresh: direct ranges plus a lockfile re-resolution, 75 resolved names moved, no
  package name added or dropped, and three names that had two copies now have one. `@clack/prompts`
  1.8.0 needed one source change: `isCancel` narrows to a UNIQUE symbol while the prompts still
  return the wide `symbol`, so control flow cannot subtract one from the other. The CLI's single
  cancel seam supplies the second half itself (`isCancel(value) || typeof value === 'symbol'`), which
  narrows to `T` with no assertion and also exits cleanly on a cancel symbol minted by a second copy
  of `@clack/core`, where an assertion would hand that symbol back to a caller about to call `.trim()`
  on it. Four holds are unchanged and were re-verified at HEAD:
  vitest at 4.1.11 and wrangler at 4.124.0 (vitest-pool-workers 0.22.0 is still newest, peers
  `vitest: ^4.1.0` and pins that wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the
  resolved workerd's date), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 is still newest and
  calls `require.resolve('typescript/lib/tsc')`, absent from TS 7's exports map). Actions:
  changesets/action v2.1.1 to v2.1.2, the only one that moved.
- Updated dependencies [333b967]
  - @cat-factory/sdk@0.51.3

## 0.49.2

### Patch Changes

- Updated dependencies [5c50d30]
  - @cat-factory/sdk@0.51.2

## 0.49.1

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
  - @cat-factory/sdk@0.51.1

## 0.49.0

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
- a1802d9: Report what the platform tried about a failed environment, instead of reporting only that it failed
  
  Both remediation loops a `deployer` step can run recorded everything on the step and nothing
  reduced either into the verification report. So a run whose environment failed, was diagnosed as a
  provider fault, was restarted in place and then came up served byte-for-byte what a run with no
  remediation loop wired at all serves. Nothing outside the backend could establish that the loop
  had run: a headless suite reading the report, the one provider-neutral surface it has, had no
  observable to assert on, which made the feature unfalsifiable from outside the deployment.
  
  `environments.entries[].remediation` now carries the DECISIONS, per frame. `deployFix` counts the
  `deploy-fixer`'s repair rounds against the cause it was dispatched for and splits the rounds whose
  job FINISHED from the ones that died having changed nothing in the checkout, because a bare round
  count reads as the first. `investigation` carries the layer the last verdict blamed, the action it
  asked for, every action the engine actually RAN, why a requested action was withheld, the
  investigation's own failure when a round produced no verdict, and how many readiness-ceiling
  extensions a `wait` verdict won: a granted `wait` is the one remedy that otherwise leaves no trace
  anywhere, since the bring-up simply runs past the configured ceiling and the timeline beside it
  cannot be reconciled without it. The investigator's summary paragraph and cited evidence stay on
  the run's own record.
  
  Three absences stay distinct: no `remediation` means neither loop ran, a null `faultLayer` means no
  round produced a verdict (never the `unknown` LAYER, which is a verdict reached on evidence that did
  not settle the question), and an empty `ranActions` means nothing ran, with `withheld` saying why.
  There is no field for whether the remedy WORKED, on purpose: that is the deployer's next verdict,
  which `entries[].status` already states. `@cat-factory/acceptance-kit` gains
  `checkEnvironmentRemediation`, the reduction that asserts the loop ran and settled on a fault layer.
  
  Fixes a defect the new section would otherwise have under-reported, and one bug beside it. A
  loop-back to a `deployer` step (the `human-test` gate rebuilding the environment a person is
  testing) dropped the whole of `step.deployFix`, so a frame whose deployment files the fixer had
  machine-edited reported as one nothing was ever attempted on; and `step.environmentInvestigation`
  had no reset at all, so the looped-back step carried a SPENT budget into its next failure, refused
  the first round of the new cycle as "the budget is spent", and explained the terminal failure with
  the verdict about the environment the re-provision had already superseded. The counters of both are
  now re-armed per provisioning CYCLE and the attempt logs survive the RUN, which is what the report
  reduces.
  
  Splitting those two lifetimes is what every remaining decision here follows from. Each attempt row
  carries the CYCLE that ran it, so a read scopes itself explicitly instead of taking whichever
  half is nearer: the live budget and the last verdict are read within the CURRENT cycle (a verdict
  from a superseded cycle diagnoses an environment the re-provision destroyed), while the report
  reduces the whole log and states `cycles` beside `attempts` rather than printing a run-long count
  against a per-cycle budget. `waitExtensions` is the one counter that stays RUN-long: a cycle is
  not always started by a person or a gate, since `rerunProducerThrough` is driven by the judge loop
  and the below-threshold companion loop too, and a per-cycle bound would hand the model a fresh
  readiness ceiling on every automatic rework round. Both logs are now capped and count what they
  drop, since they live in the run's compare-and-swapped JSON blob.
  
  Internal break: an attempt log's `attempt` is now its ordinal in that run-long log rather than a
  copy of the live cycle counter, and each row carries a `cycle`. The two ordinals are identical on
  any run that never loops back to its deployer, and only a stored step carries the fields.
  
  Additive on `/api/v1` (spec `info.version` 1.66.0): new optional and required fields on a response
  object introduced in the same release, plus a fourth `entries[].status` value, `unsettled`, for the
  frame whose recorded outcome a remediation loop cleared to re-provision it. The clients ignore
  unknown fields and tolerate unknown enum values, so a consumer built against 1.65.0 keeps parsing.

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/sdk@0.51.0

## 0.48.0

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
  - @cat-factory/sdk@0.50.0

## 0.47.0

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
- a08d2ad: Diagnose an environment that never became usable, instead of ending the run at the tester
  
  A provisioning failure that no edit in the checkout could fix used to be terminal and
  unexplained: the `deploy-fixer` correctly declines every cause outside `manifest_invalid`, and
  nothing else looked. The run died at the tester with a report saying a human had to look, while
  the facts that explained it sat unread in the provider's own response.
  
  A `deployer` step now investigates such a failure. The platform gathers the evidence it already
  had (the environment record, the WHOLE captured provision-field bag rather than the four fields
  a consuming step is handed, and the run's provisioning timeline), asks the provider for its own
  account through a new optional `EnvironmentProvider.diagnostics` capability, and runs one inline
  model call that names the fault layer and picks one remediation from a list the engine narrowed
  first. The engine performs it and the deployer re-enters its own path, so the provider's next
  verdict is what settles the frame. When nothing is worth trying, the run still fails, but with a
  named cause instead of a tester's guess.
  
  The Kubernetes backend implements the new capability: `describe` reads the namespace phase, the
  Deployments' unsatisfied conditions, every pod through `analyzePodStatus`, the namespace's
  warning events and a log tail from each unhealthy pod, and `remediate` rolls the Deployments the
  `kubectl rollout restart` way. Every other provider is unaffected and degrades to the platform's
  own evidence, which it states rather than presenting as an absence of problems.
  
  Internal break: `EnvironmentProvisioningServiceDependencies` gains an optional
  `readProvisioningLog` and an optional `logger`; both facades wire them through the shared
  container, so nothing outside a hand-built instance is affected.
  
  The provisioning-log operation vocabulary gains `remediate`, and the platform appends one such row
  whenever it asks a provider to repair an environment in place. It is a distinct actor, the way
  `teardown-verify` is: the investigation's own second round rebuilds its timeline from that log, so
  an unlogged restart leaves the next round reasoning about an environment it believes nothing has
  touched. Additive on `/api/v1` (spec `info.version` 1.63.0); the clients tolerate unknown enum
  values, and a consumer that maps `operation` through an exhaustive table gains a member to name.

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/sdk@0.49.0

## 0.46.1

### Patch Changes

- be0b953: Refresh the dependency tree, the base images and the agent CLIs.
  
  **Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the newest
  release each declared range already admits, under the `minimumReleaseAge` gate:
  
  - **Runtime**: the `ai` / `@ai-sdk/*` line takes its first aged releases since it was held back last
    round (`ai@^7.0.77 → ^7.0.83`, `@ai-sdk/anthropic@^4.0.41 → ^4.0.44`,
    `@ai-sdk/openai@^4.0.46 → ^4.0.50`, `@ai-sdk/openai-compatible@^3.0.35 → ^3.0.39`,
    `@ai-sdk/provider@^4.0.7 → ^4.0.8`, `@ai-sdk/amazon-bedrock@^5.0.61 → ^5.0.66`), staying on the
    majors `workers-ai-provider` pairs with. Also `hono@^4.13.4 → ^4.13.5`,
    `@aws-sdk/client-s3@^3.1116.0 → ^3.1119.0` and `vue@3.5.41 → 3.5.42` with the whole pinned
    `@vue/*` override family moved in lockstep.
  - **Tooling**: `@types/node@^26.2.0 → ^26.4.0`, `turbo@^2.10.11 → ^2.10.12`, `knip@^6.32.2 → ^6.32.3`,
    `happy-dom@^20.11.6 → ^20.11.8`.
  - **Java SDK**: `jackson-databind 2.22.1 → 2.22.2`, `junit-jupiter 6.1.2 → 6.1.3`, and the build
    plugins (compiler 3.15.0, source 3.4.0, javadoc 3.12.0, gpg 3.2.8, central-publishing 0.11.0).
  - **Transitives the re-resolve moved**, among ~180: `eslint@10.6.0 → 10.9.1`,
    `@tiptap/*@3.24.0/3.30.0 → 3.30.5`, `rollup@4.62.5 → 4.63.0`, `rolldown@1.2.5 → 1.2.6`,
    `terser@5.50.0 → 5.51.1`, `@ai-sdk/gateway@4.0.62 → 4.0.67`, `@ai-sdk/provider-utils@5.0.29 →
  5.0.32`, `@inquirer/*`, `@intlify/*` and `vue-i18n` to 11.4.10, `cssnano@8.0.8 → 8.0.10`.
  
  **The re-resolve also drops ~22 packages that were in the tree only through lockfile inertia**:
  `@vitejs/devtools-kit`, `tsx`, `@parcel/watcher` (with its platform packages), `devframe`,
  `@devframes/*`, `@json-render/core`, `zigpty` and `node-addon-api`. Every one of them occupies an
  OPTIONAL peer slot, which pnpm does not auto-install; they survived because each partial install
  preferred what the previous tree already held. Resolving from a deleted `node_modules` as well as a
  deleted lockfile is what surfaces that, and it is also what collapses the duplicate `h3` and `srvx`
  copies. `@parcel/watcher-wasm` still serves the watcher slot, so this costs dev-time niceties at
  most.
  
  **The base image both runner Dockerfiles pin by digest moves to `sha256:5758d367…`** (Node 26.7.0),
  the build held back at 17h old last round and now 74h old. The newer `26.8.1` digest is 14h old and
  is held on the same rule. `searxng` in the local compose stack takes `2026.8.22-9fea41204`.
  
  **Claude Code `2.1.246 → 2.1.250` and Codex `0.150.0 → 0.150.1` take their newest releases** ahead of
  the age window, as the Dockerfile's standing note about the three agent CLIs allows. Pi (`0.84.3`)
  and both Pi extensions (`2.7.1`) are already at their newest and have aged past the window, so they
  need no exemption. Both image tags roll (executor `1.142.0`, deploy `0.5.0`) because republishing
  over a live tag does not roll a deployment out.
  
  **`wrangler` and `@cloudflare/workers-types` deliberately do not move**, for the third round running:
  `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins `wrangler@4.124.0`
  exactly, and the types version IS the workerd date that pin resolves (`1.20260815.1`). They move
  together on the next pool bump.
  
  **Held back, all inside the 24h window when this was cut**: `@aws-sdk/client-s3@3.1120.0` (12h),
  `happy-dom@20.11.12` (16h), `vue-router@5.3.0` (18h), `wrangler@4.127.0` (23h) and
  `@cloudflare/workers-types@5.20260828.1` (4h, and blocked by workerd besides). Held on the
  compatible-major rule: `pnpm@12.0.0` and `typescript@7` for the frontend, which is on `^6.0.3`
  because that is the line Nuxt's build graph resolves.
- Updated dependencies [be0b953]
  - @cat-factory/sdk@0.48.1

## 0.46.0

### Minor Changes

- 7d899c4: Stop publishing an ephemeral-environment URL nothing can serve, and make a containerized tester
  able to reach one that can.
  
  An acceptance pass deployed a healthy pod, published `http://cf-acc-pr8.127.0.0.1.nip.io`, reported
  the environment `ready`, and then spent fourteen minutes in the tester on curl code 000 before
  failing the run at forty-three minutes. Two independent faults, both of which PR #2075 named and
  left open:
  
  - **The Ingress was claimed by nothing.** It declared `ingressClassName: nginx` on a cluster
    running Traefik. The apiserver accepts that, no controller watches it, `status.loadBalancer`
    stays empty, and readiness (which was the Deployments' rollout and nothing else) still said
    `ready`. The Kubernetes provider now grades a template-derived URL against the cluster's own
    `IngressClass` catalog and reports `failed` / `config_incomplete` naming both the requested class
    and the available ones. It fails only on POSITIVE evidence that no controller can claim the
    Ingress; a missing address is `pending`, never a refusal, and a cluster that will not answer the
    cluster-scoped read passes through byte-for-byte as before. `cat-factory k3s` grants the
    `ingressclasses` read so a cluster it provisions can answer.
  - **A loopback URL is unreachable from an agent container**, whose `127.0.0.1` is its own network
    namespace. The local facade now maps the environment's host to the container's host gateway, so
    one URL means the right thing to the operator's browser and to the agent alike. A container that
    predates its environment is replaced, and a bridged job never takes a warm-pool member (a member
    is re-leased across runs, so one run's per-PR entry would leak into the next). It covers every
    environment a job is handed, not just the frame's own: a live peer service's environment for a
    cross-service test and a frontend flow's resolved backend binding fail identically without it.
    The URLs ride the dispatch OPTIONS as a declared, typed list rather than being dug back out of
    the job body, where they sit three levels down under a wire shape the harness owns.
  
    A URL naming this machine that NO bridge can re-point is reported rather than bridged: a hosts
    entry cannot displace the `127.0.0.1 localhost` line an image ships with, and it is never
    consulted for a bare IP literal. A compose environment publishes `http://localhost:<port>`, so
    bridging it bought nothing while costing every such run its warm-pool member and a container
    replacement. Those runs are pooled again, and the log now says the environment is out of the
    agent's reach instead of leaving it to be discovered as a dead cluster.
  
  Also: the acceptance suite refuses a pass up front when the cluster runs no ingress controller or
  publishes no host port into it, reusing `cat-factory k3s`' probe; its scaffold briefs tell agents to
  leave `ingressClassName` unset so the cluster's default class claims the Ingress; and the run driver
  reports step TRANSITIONS instead of only sampling `currentStep`, so a step that starts and finishes
  between two polls is still named. That last one is why this failure was misread: the `deployer`
  finished in one second against a ten-second poll, so the pass jumped from `reviewer` to
  `tester-api` and the step that published the bad URL never appeared in the log at all.
  
  Alongside them, `/api/v1` serves `skipped` on a run's steps (an additive optional field, OpenAPI
  `1.62.0`). A skipped step's `state` is `done` with no output, which is byte-for-byte a step that
  ran and produced nothing, so following a run's chain could not tell the engine deciding a step was
  unnecessary from the step happening and having nothing to say. The acceptance kit's transition
  reducer already knew how to announce the difference and could not observe it.

### Patch Changes

- Updated dependencies [7d899c4]
  - @cat-factory/sdk@0.48.0

## 0.45.0

### Minor Changes

- a8f8d14: Close the two accepted findings from the second acceptance-suite gap report (now
  [ADR 0060](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0060-headless-caller-diagnosability.md)).
  
  The four SDK transports no longer render every transport failure as `failed to reach <baseUrl>`,
  which is a reachability verdict made without classifying the cause and the one provably false
  reading when the deployment answered nine calls a moment earlier and then restarted. Each client
  classifies the cause from its own runtime's codes, states only what that cause supports, adds what
  the client had already seen from the origin, and keeps the runtime's chain verbatim at the end. The
  error class and its cause are unchanged, so this is additive.
  
  On `/api/v1` (surface version 1.61.0, additive): `GET /api/v1/environments/manifest-types` publishes
  every id a service's `custom` provisioning may pin, because nothing validates a pin on the way in
  and an unserved id currently fails at the `deployer` step of a run already paid for. Alongside it,
  the service provisioning variant gains an `infraless` member, which
  `PATCH /api/v1/services/{serviceId}` accepts to TAKE A PIN BACK; omitting the key still leaves the
  stored pin alone, so no request a consumer sends today changes meaning. The undo is a member rather
  than a `provisioning: null` because a null-valued optional field is not expressible from the Go,
  Java or Python clients, which each drop one when serializing.

### Patch Changes

- Updated dependencies [a8f8d14]
  - @cat-factory/sdk@0.47.0

## 0.44.0

### Minor Changes

- 08752da: Answering a Coder's question and RULING ON it are now different acts, and a decision the loop
  budget throws away says so.
  
  A local run spent three implementer passes and about €4 producing three commits that reworded one
  comment about a Kubernetes Ingress class, and the fourth walked the wording back to roughly where
  the second left it. Nothing was broken: every part behaved as designed, and the design was the bug.
  
  The Coder asked a question nobody in the loop could answer (which IngressClass the target cluster
  marks as default). Its answerer replied with a standing steer, the same string every time, because
  that is all an unattended caller has. `resolution` did not exist, so the engine had exactly one
  thing it could do with an answered question: fold it into another pass and tell the agent to apply
  it. There was nothing to apply, so the agent did the only thing left and wrote its uncertainty into
  the manifest comment, the README and the commit message, one wording per pass, re-raising the same
  question under a new title each time. The loop ended on `maxLoops`, not on agreement, and then the
  last round's answers were dropped in silence.
  
  **`POST …/follow-ups/…/answer` takes an optional `resolution`.** `answered` (the default, and
  byte-for-byte the old behaviour) means the reply carries something to apply and buys a pass.
  `closed` means the reply rules on the question: it clears the gate identically, spends nothing, and
  rides into every later rework prompt under a heading that says the topic is settled and must not be
  re-argued in the code or the commit message. The answerer picks; the engine does not try to read the
  difference out of prose, which it cannot do. The public-API surface moves to `1.60.0`; the SPA's
  answer box gains a second button.
  
  **Exhausting the send-back budget is no longer indistinguishable from converging.** The gate's
  decision was a boolean whose `false` covered three different situations, one of which was "a
  human's decision is about to be thrown away". It is now a named verdict, and the dropped items are
  stamped `sendBackDropped`, warned about with the budget that ran out, counted under
  `followup.send_back_dropped`, and reported on the pull request. Without the stamp such an item
  stays `answered` with `sentToCoder` false forever, which reads exactly like an answer the Coder
  applied.
  
  **The PR verification report gains a `followUps` section** (payload `version: 10`): what the Coder
  flagged and what was decided, with the three dispositions that mean "not dealt with as triage
  intended" called out above the table rather than left to be derived from a status column. Its
  counts (`total`, `dropped`, `dismissedByPolicy`) are taken over every item the run surfaced rather
  than over the rows the entries cap left visible, and the banner quotes `droppedBudget`, summed over
  the steps that actually dropped something. A pipeline may place more than one follow-up-enabled
  Coder, and a budget summed across all of them reads as half-spent while asserting it was spent.
  
  **A stamped drop is not permanent, and an unbudgeted step is not a drop.** Deciding an item again
  clears `sendBackDropped`, so the send-back the budget could not pay for can be sent once the step
  has a pass to spend; the stamp is terminal in the send-back selection, so left set it made that
  item unsendable forever while the window claimed it had been sent. And a step whose `maxLoops` is
  absent (persisted before the field existed) has the loop UNWIRED rather than exhausted: it passes
  through as before instead of stamping every decided item, warning, and banner-ing a budget of 0/0
  that nobody configured.
  
  **The acceptance suite closes questions instead of answering them.** It was the caller in the story
  above, and its own file header had already reasoned through this exact failure for the clarity-review
  gate. Its steer is a ruling, so it now sends one.
  
  **Fixed alongside, and part of why the agent had so little to work from:** the single-repo coding
  path dropped `job.contextFiles` on the floor. Every sibling caller forwarded them;
  `buildSingleRepoCodingSpec` did not. So a task whose brief was too long for `description` (and
  therefore rode an attached document, which is the documented way to submit a real specification)
  reached the implementer as a prompt naming `.cat-context/<file>.md` beside a checkout that had no
  such directory. The agent rebuilt the brief from whatever summary the prompt carried and filed the
  gap as a follow-up question. Bumps the runner image to `cat-factory-executor:1.130.0`.
  
  **The four SDK clients keep their published follow-up type names.** `PublicFollowUpItemKind` and
  `PublicFollowUpItemStatus` are deduped enums, and adding the report's follow-ups section re-pointed
  both onto a name derived from the section instead: a source break in four released clients,
  arriving as ordinary generated churn. Both are now pinned in the emitter's `INLINE_ENUM_NAMES`, so
  the only change to them is `closed` joining the status list. Python and Java are bumped to `0.5.0`,
  which is what publishes them.

### Patch Changes

- 0cfa7a2: Refresh the dependency tree, the pinned GitHub Actions and the Docker images, and move the three bundled agent CLIs.
  
  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
  newest release each declared range already admits):
  
  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.68 → ^7.0.77`,
    `@ai-sdk/anthropic@^4.0.39 → ^4.0.41`, `@ai-sdk/openai@^4.0.43 → ^4.0.46`,
    `@ai-sdk/openai-compatible@^3.0.31 → ^3.0.35`, `@ai-sdk/amazon-bedrock@^5.0.58 → ^5.0.61`.
  - **Runtime deps**: `jose@^6.2.9 → ^6.2.10`, `pg-boss@^12.27.0 → ^12.28.0`,
    `capnweb@^0.11.1 → ^0.12.0`, `@aws-sdk/client-s3@^3.1113.0 → ^3.1116.0`,
    `@cloudflare/workers-types@^5.20260819.1 → ^5.20260823.1`.
  - **Frontend**: `@nuxt/ui@^4.10.0 → ^4.11.0`, `happy-dom@^20.11.2 → ^20.11.6`,
    `vue-tsc@^3.3.10 → ^3.3.11`. The frontend's `typescript@^6.0.3` is deliberately unchanged:
    `vue-tsc` still resolves `typescript/lib/tsc`, a subpath TypeScript 7's exports map does not
    expose, so the SPA stays on 6 until `vue-tsc` supports the Go port.
  - **Tooling**: `@stryker-mutator/*@9.6.1 → 10.0.0` (its only breaking change is dropping Node 20;
    CI runs 26) and pnpm `11.22.0 → 11.23.0`.
  
  **Changesets moves as a coupled major**: `@changesets/cli@^2.31.1 → ^3.0.1` plus
  `changesets/action@v1.9.0 → v2.1.1`, which refuse each other's majors. Two behaviour changes had to
  be pinned back to what this repo already relied on: `.changeset/config.json` now sets
  `privatePackages: { version: true, tag: false }`, because v3 stopped versioning private packages by
  default and `@cat-factory/executor-harness`'s version IS the runner image tag; and `release.yml`
  takes the renamed inputs (`version-script`, `publish-script`, `pr-title`, `commit-message`), the
  `pr-number` output, and the token through the `github-token` input, which v2 no longer accepts from
  the environment. v2 pushes the release branch and tags through the GitHub API, so that job's
  checkout no longer persists git credentials.
  
  **Held back, all inside the ~24h `minimumReleaseAge` window when this was cut**: `@types/node@26.3.0`,
  `hono@4.13.4`, `oxlint@1.80.0`, `oxfmt@0.65.0`, `ai@7.0.78`, `@ai-sdk/openai-compatible@3.0.36`,
  `@aws-sdk/client-s3@3.1117.0`. `pg-boss@12.28.0` was ~20 minutes short of the same window and was
  taken anyway, so it is listed in `minimumReleaseAgeExclude` — the ONE third-party entry there, added
  deliberately with a PRUNE ME note, since it has already aged past the gate and removing the line is
  now a no-op re-resolve.
  
  **`wrangler` is now pinned by override**, not merely ranged. `@cloudflare/vitest-pool-workers@0.22.0`
  pins `wrangler` (and through it `workerd` and `miniflare`) EXACTLY, so any in-range refresh floats our
  caret ahead of the pool's pin and the tree gains a SECOND workerd — not just ~100MB of duplicated
  platform binary per arch, but a runtime the Worker suite proves that is a different build from the one
  `wrangler deploy` ships. The override holds it at whatever pool-workers pins, exactly as the three
  esbuild pins beside it already do, and moves when that package moves.
  
  **Stryker 10 pulled Babel 8 into a tree whose Nuxt half is on Babel 7**, and the three Babel plugins
  Nuxt declares as OPTIONAL PEERS were then filled from the 8.x line while still being handed
  `@babel/core@7`. A Babel 8 plugin's `declare()` asserts the core major and throws, so
  `pnpm-workspace.yaml` scopes those three names back to 7.x for their Nuxt parents.
  
  **The three agent CLIs the executor image bundles** move together and are all taken at their newest
  release, ahead of the release-age window: Pi `0.84.2 → 0.84.3`, Claude Code `2.1.237 → 2.1.243`,
  Codex `0.148.0 → 0.149.1`. That exemption is an explicit call re-made at each bump, and the
  Dockerfile now says so for all three rather than for Claude Code alone. Pi's two extensions take the
  ordinary aged pick, `2.6.2 → 2.7.0`. The UI image moves `pnpm 11.22.0 → 11.23.0` to match the
  workspace; its Playwright (1.62.1), Yarn (4.18.0), `serve` (14.2.6) and WireMock (3.13.1) pins are
  already current, as are the deploy image's kubectl `v1.36.4` / kustomize `v5.8.1` / helm `v4.2.4` and
  both images' `node:26-trixie-slim` digest.
  
  The executor image tag therefore rolls to `1.130.0` (base + UI): republishing over a live tag does
  not roll a deployment out. The deploy image is unchanged and stays at `0.2.15`.
  
  **Pinned GitHub Actions**: `actions/checkout v7.0.0 → v7.0.1`, `actions/setup-node v6.4.0 → v7.0.0`,
  `actions/setup-java v5.7.0 → v6.0.0` (both majors are ESM rewrites with no change to the inputs used
  here), `docker/build-push-action v7.2.0 → v7.3.0`, `docker/login-action v4.2.0 → v4.6.0`,
  `docker/setup-buildx-action v4.1.0 → v4.3.0`, `docker/setup-qemu-action v4.1.0 → v4.2.0`,
  `dorny/paths-filter v4.0.1 → v4.0.3`, `pnpm/action-setup v6.0.9 → v6.0.10`,
  `rharkor/caching-for-turbo v2.5.0 → v2.5.1`, and `zizmorcore/zizmor-action v0.5.7 → v0.6.2`, which
  raises the default zizmor from 1.26.1 to 1.29.0.
- Updated dependencies [08752da]
- Updated dependencies [0cfa7a2]
  - @cat-factory/sdk@0.46.0

## 0.43.1

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
  - @cat-factory/sdk@0.45.1

## 0.43.0

### Minor Changes

- 53a4c40: Publish the Kaizen entries as a public surface (`/api/v1/kaizen/entries`, spec 1.58.0): the
  platform's post-run gradings of its own agent steps, as a backlog a consumer drains rather than a
  screen a person browses.

  The gradings already existed and were already rendered, so this is a shape change. What did not
  exist was a way to read them without naming a run or a task first, which is exactly what a caller
  asking "what has the platform learned about my agents" cannot supply, and a way to record that one
  had been dealt with, without which every poll re-reports the same backlog. The list is
  keyset-paginated and workspace-wide, filters (`acknowledged`, `settled`, `status`, `agentKind`,
  `since`) compose in SQL, and an entry carries the run, step, agent kind, resolved model, prompt
  version, combo streak, grade, recommendations and board task, so acting on one needs no second
  lookup. `?acknowledged=false&settled=true` is the drainable backlog: `settled` reads the same
  definition the acknowledge write is gated on, so every entry it returns is one that write accepts.

  `KaizenGrading` gains `acknowledgedAt` / `acknowledgedBy` / `acknowledgementNote` on both runtimes
  (D1 migration 0095 ⇄ a Drizzle migration). They are written ONLY by the new acknowledge route: the
  grading sweep's upsert leaves them alone, so a re-graded row keeps its triage. Existing rows read as
  unacknowledged, which is what they are. An acknowledgement moves the row's `updatedAt` with it, so
  that field stays usable as a change watermark; a repeat acknowledgement, and a clear where nothing
  was acknowledged, write nothing at all.

  `KaizenVerifiedComboRepository` gains a batched `listByKeys` (both facades, `remote` for mothership
  mode) so the entry join names the combo keys a page holds rather than reading the workspace's whole
  combo library on every call, including single-entry point reads.

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/sdk@0.45.0

## 0.42.0

### Minor Changes

- 302e05a: Close the gaps a third-party acceptance suite hit, and fix the 422 our own suite would have hit.

  The kit is published so a deployment can cover its OWN providers, gates and environment backends.
  The first consumer to actually do that came back with thirteen findings, and one of them is a real
  defect here: a task `description` caps at 2,000 characters, both scaffold briefs in
  `backend/internal/acceptance` measure past it (2,507 and 2,697), and scenario 01 passed them straight
  through. The platform's own acceptance pass could not create its first task, and would have found
  that out as a `422` after an operator had created two repositories and wired a workspace.

  `briefFields` now owns the branch, reading the cap from the contracts rather than restating it: over
  it the brief becomes an attached document (this surface's own documented path for spec-sized input),
  under it nothing changes at all. `MAX_TASK_DESCRIPTION_CHARS` is exported so the branch and the route
  cannot disagree.

  The rest of the kit changes are seams a consumer had to re-derive by reading our source. A
  `resource.ts` giving an external RESOURCE the record-before-you-can-observe discipline `resume.ts`
  gives runs, because a teardown needs the provider's id plus what the provision captured and neither
  can be re-derived, so a killed pass leaks a machine nothing on disk can name. `PassOptions.onSettled`,
  so a reclaim report lands INSIDE the closing words rather than after the sentence written to be read
  last. An `unknown` verdict constructor beside its two siblings, and `Prerequisite.probe`, so a check
  reaching a host that is not the deployment still gets kernel's transport classification. A
  `ConfigProblem` export. Provider-neutral evidence prose (`checkEphemeralEnvironment` claimed the
  disposer reclaimed "the namespace", which is false of every non-Kubernetes backend). The console
  password prompt as an opt-in `@cat-factory/acceptance-kit/console-credential` subpath, so the base
  package keeps no terminal code. And the `.env` MERGE half published from `@cat-factory/cli` beside
  the `renderEnvFile` it completes.

  On `/api/v1` (spec `1.57.0`, all additive): `PublicServiceProvisioning` gains a `custom` variant so a
  service pinned to a deployment's own environment backend can be declared and, more importantly, READ
  BACK (the projection dropped what it could not describe, so a pinned service and an unpinned one
  answered identically); `GET /api/v1/environments/connections` closes the write-only loop on handlers,
  reporting BOTH manifest-id fields because the engine matches a pinned service against either and each
  way of registering a handler sets only one; and `GET /api/v1/repos/{owner}/{name}/contents` reads one
  file out of a linked repository, so a caller can grade what a run committed without a second VCS
  credential. That read answers `ref: null` for a request that named none, since the branch the provider
  resolved is not something it learns and the platform's recorded default may be one it invented; `sha`
  is the handle to record. It refuses rather than answering approximately in three cases: past its own
  cap, past the PROVIDER's contents ceiling (`file_too_large` either way, which is also what stops
  GitHub's over-limit `403` reading as a revoked credential), and for bytes that are not UTF-8
  (`file_not_text`, carrying the `sha`).

  Watch for: `provisioning.type` must now be narrowed before `manifestSource` is read, since the public
  union is no longer single-member. A `custom` service patch that omits `manifestPath` CLEARS the stored
  one, which is the only way this surface can express "back to the manifest type's default".
  `RepoFileContent` gains an optional `lossy`, so a `VcsClient` implementation outside this repo should
  set it where it can tell. What was DELIBERATELY not added, and why, is
  `backend/docs/adr/0058-acceptance-kit-consumer-gaps.md`.

### Patch Changes

- Updated dependencies [302e05a]
  - @cat-factory/sdk@0.44.0

## 0.41.0

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
  - @cat-factory/sdk@0.43.0

## 0.40.0

### Minor Changes

- 0ef48d1: Stop an agent's own cleanup command from killing the harness that supervises it, and report a
  harness that WAS stopped as what it is.

  A local acceptance run failed as "the container kept vanishing, treating as deterministic" after
  two full coder passes. Nothing evicted anything. The harness ran as PID 1 with the command line
  `node dist/server.js`, which is also where the Fastify service the coder was scaffolding built to;
  the agent started that service in the background to smoke-test it over a real socket, then ran
  `pkill -f 'node dist/server.js'` to stop it again. The image ships no `pkill`, so that failed with
  `command not found` and the next turn used something that works without procps, which matched PID 1
  and shut the harness down. The container exited 0, the engine could only see a backend that had
  stopped answering, so it called it an eviction, spent its crash-recovery budget re-running the same
  agent into the same wall, and blamed infrastructure churn.

  **The harness no longer answers to a pattern kill aimed at anything else.** It runs from
  `dist/harness-server.js` and sets `process.title = 'cat-factory-harness'`, which on Linux rewrites
  both `/proc/<pid>/cmdline` and (truncated) `/proc/<pid>/comm`, so neither `pkill -f 'node dist/…'`
  nor a bare `pkill node` nor a hand-rolled `/proc` sweep can name it. It is not a security boundary
  and is not claimed as one: the agent shares the harness's uid, and separating them needs a PID 1
  running as root, which this image deliberately does not have. What it removes is the accident.

  **`procps` + `psmisc` are now in the image**, which reads backwards until you look at what the
  absence caused: `pkill`/`pgrep`/`ps` are the narrow tools an agent reaches for first, and the
  fallback it writes when they are missing is the unbounded one that took the harness down.

  **A harness that exits cleanly mid-job is no longer an eviction.** Every transport that can read an
  exit code (the local container and native-process legs, the Cloudflare per-run container, and a
  Kubernetes runner pod's `state.terminated`) now distinguishes a workload that exited 0 with a job
  still in flight from one that crashed or was reclaimed, and reports `harnessShutdown` instead of
  `evicted`. The engine fails that run immediately with a new `harness_shutdown` failure kind
  (additive to the public failure-kind vocabulary; OpenAPI surface 1.54.0) and a hint that names the
  causes worth checking, rather than spending an automatic retry that walks back into whatever
  stopped it. A backend that reports no exit code (Apple `container`, a manifest-driven runner pool
  whose scheduler exposes only status words) keeps reporting an eviction, because an absent code is
  not a zero.

  The distinction is only ever drawn where NOTHING else explains the stop. Infrastructure churn is
  named and recovers on its own budget, and it stays named even after its attribution window passes:
  a rollout drain the harness answered by exiting 0, discovered minutes later by a re-driven poll, is
  still that drain rather than a shutdown. The same rule orders the engine's own reading: a killed
  job that some branch settles WITHOUT failing the run (a parked PR review's read-only Challenge
  Investigator) keeps that settlement, since losing a human's in-flight curation is worse than the
  retry this failure kind exists to prevent. `container.harness_shutdown` counts the class, kept out
  of `container.evicted` so the eviction rate an operator sizes infrastructure by is not inflated by
  deaths no infrastructure change prevents.

  **An aborted agent run says who aborted it.** The Claude Code / Codex runner rejected with a
  hard-coded "agent run aborted by watchdog" for every abort, including the shutdown handler's, so a
  job killed by something else filed its failure against a watchdog that never fired. It now carries
  the abort reason the caller supplied, the way the Pi runner already did, and an abort that supplied
  none falls back to saying so rather than quoting the platform's own contentless "This operation was
  aborted" (a reasonless `abort()` sets an `AbortError` that IS an `Error`, so the fallback was
  unreachable).

  The image moves to `cat-factory-executor:1.121.0` across the wrangler config, the publish script and
  `RECOMMENDED_HARNESS_IMAGE`: the entrypoint rename and `procps` are only in effect once a deployment
  runs a tag that contains them.

  **The acceptance suite stops blaming the merge threshold for a failed run.** Its "the merge was
  HELD" hint fired on "there is a pull request and the status is not done", which is also true of a
  run that died three phases before any merge was considered; it is now offered only where nothing
  else explains the stop.

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/sdk@0.42.0

## 0.39.0

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
  - @cat-factory/sdk@0.41.0

## 0.38.0

### Minor Changes

- 36e0c9b: A headless caller can now DELETE a board service, and the acceptance suite has a command that clears a
  board back to "before any pass ran".

  The two halves are one change. The acceptance preflight refuses a fresh pass whose target repository
  already backs a service frame an earlier pass created, and it offers three ways out: resume the pass
  that owns it, point the suite at fresh repositories, or delete the frame. The third was not a command:
  deleting a service was an app act, and a public-API key authenticates on `/api/v1` only. So the one
  branch an operator running a HEADLESS pass could not act on headlessly was the one that starts over.

  **`DELETE /api/v1/services/{serviceId}`** (`admin`, OpenAPI `1.51.0`) closes that, additively. It runs
  the same sequence the app's own delete does, so a run still going under the frame is stopped and its
  container killed before anything is removed. Two answers a caller branches on rather than retries: a
  frame holding UNFINISHED tasks is refused with `422 service_has_unfinished_tasks` (deleting one would
  discard work in flight along with its history, so meaning it looks like deleting those tasks first),
  and an ARCHIVED frame is a `404`, which is the population rule every per-service endpoint here
  follows. Archiving stays app-only, deliberately: a surface that publishes neither the archive nor the
  restore has no business deleting through one.

  That refusal is decided BEFORE the run teardown, which is the ordering both delete controllers now
  share (`BoardService.assertRemovable`, handing back the board list the teardown and the remove both
  reuse, so the sequence still costs one read). The guard used to live only inside `removeBlock`, one
  step past a teardown that kills every container, cancels every durable driver and deletes every run
  row under the frame: a `422` therefore described a board it had already emptied of exactly the
  history the refusal exists to protect. It now leaves everything as it was, which is what the SPA's
  own delete has always claimed too.

  **`pnpm --filter @cat-factory/acceptance run reset [runId|latest] [--yes]`** is what uses it. It
  targets what the CONFIGURATION would adopt rather than what a ledger remembers, because the gate
  refuses over the board as it stands and the hardest case is leftover state whose owning ledger is gone
  (another machine, another operator, a state directory somebody cleared). Naming a pass widens the
  target to that pass's whole ledger.

  Three properties are worth knowing before running it. It PREVIEWS by default and changes nothing
  without `--yes`, naming every frame, task and file, and the preview is decided by the same retention
  rule the apply runs, so a pass is listed under "to remove" or under "KEPT" and never under the one it
  will not get. It keeps a pass's local files whenever any frame that ledger names is still on the
  board, since the ledger is the only thing that maps a leftover frame back to a run id, and removing it
  strands that frame with no pass for the next refusal to name; a repository it could not FREE keeps
  every ledger for the same reason one step out, because the frame still holding it is one no read here
  can name at all. And it STATES what no key can reclaim: the two repositories keep whatever a previous
  pass scaffolded (with its branches and pull requests), a reporter-filed issue stays open, and per-PR
  cluster namespaces are untouched, so a cleared board is not a fresh one.

  One diagnosis it deliberately declines to make: `GET /api/v1/repos` reports `linkedElsewhere: true`
  with `serviceId: null` for a service homed on another board of the account AND for a frame ARCHIVED on
  this one (the flag is computed against the frames a board visibly lists), and the two have opposite
  fixes. Every message that names it now names both, `target-repos`' own remedy included, rather than
  sending an operator to a board that does not exist.

  `--all` clears the whole board rather than one configuration's share of it. The two questions the
  default asks are narrow by design (they answer the two refusals a pass earns), so a board accumulates
  frames neither can see: a pass run under a different name prefix, one whose repositories the `.env` has
  since replaced, a frame raised by hand. None of them blocks the next pass, which is why no refusal
  prints the flag and why it is an operator's request rather than a remedy. It reuses the task reads and
  deletes the surface already published (`GET /api/v1/services/{serviceId}/tasks`, whose pages it walks,
  and `DELETE /api/v1/tasks/{taskId}`), so the endpoint added here is still the only new one. Two things
  it changes rather than widens: the preview STATES the scope, because a board holding a single pass
  renders an identical frame list either way, and every pass file in the state directory goes with the
  board, a refused attempt's included, since a board with no frames left maps nothing and a file kept
  back is a run id `latest` may still resolve to.

  The suite's configuration now resolves in two halves, and `reset` needs only the BOARD half (the
  deployment, the key, the two repositories, the state directory). Requiring a cluster and a reporter
  token to clear a board would refuse exactly the operator whose cluster has moved on, which is who is
  resetting.

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/sdk@0.40.0

## 0.37.0

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
  - @cat-factory/sdk@0.39.0

## 0.36.0

### Minor Changes

- fc4a1e4: A run nobody is watching now finishes instead of waiting on a person who is not coming, and a
  workspace states that posture per intake rather than once for everything.

  Four parks stopped an otherwise-autonomous run, and none of them is a checkpoint anybody asked for:
  a companion at its automatic rework cap, a JUDGE at its bounce cap, an iterative review at its
  reviewer-pass cap, and the Coder's follow-up companion holding the run while any item is undecided.
  Each is the automation reporting that it gave up, and each already offered a person a documented
  "proceed anyway". A run started over `/api/v1`, dispatched from a ticket or fired by a schedule had
  nobody to offer it to, so it waited indefinitely. The headless acceptance suite found this on
  `pl_build`, stopping on an `approval-gate` raised by `architect-companion`.

  A judge's other two parks are deliberately NOT in that set — `onFail: 'park'` is a registration
  asking for a person, and a verdict with no producing step to bounce to never got to try — so
  `disposeJudgeVerdict` now returns a machine-readable `JudgeParkReason` instead of leaving the engine
  to tell them apart by their prose. A review still ASKING questions parks under either posture too:
  the answers are a product judgement, and inventing them is the one thing an unattended policy may
  never do.

  - **`RiskPolicy.autonomy`** (`attended` | `unattended`) decides which way those three go. `attended`
    is byte-for-byte the previous behaviour and is what every existing policy, every custom one, and
    the built-in fallback get. `unattended` takes the "proceed" answer ON THE RECORD:
    `step.companion.capSettledByPolicy` and `followUpItem.dismissedByPolicy` say that policy decided,
    because the last companion verdict already says the producer was below the bar and a run that
    advanced anyway must not read like one whose companion quietly stopped grading.
  - **It never touches a park the PIPELINE asked for.** An approval gate, a `human-test` step, visual
    confirmation, the human/PR review gate, a brainstorm or interview, the fork choice and the input
    gate all stop the run under either value. A companion step that is ALSO gated still raises its
    human approval gate at the cap, because the cap settling is routed through the same pass branch a
    converged companion takes.
  - **A workspace now has TWO default policies.** `isDefault` governs a task somebody started in the
    app; the new `isUnattendedDefault` governs one nothing is watching. Which applies is
    `riskPolicyDefaultScopeFor(intakeOrigin)`, its own `Record` rather than a reuse of
    `isHeadlessIntake` — the two disagree about `schedule`, which is not headless (its reused block
    has no stable place to hold a clarification conversation) and is nonetheless unwatched.
  - **A third built-in, `mp_unattended` ("Unattended delivery")**, seeded as that default. It is
    `Balanced` with one field changed, deliberately: a seed may decide that an unwatched run should
    not wait forever on an automation budget, and may not decide that it gets to land a change an
    operator's own thresholds would have held.
  - **Pinning a task to it is a permission**, not a preference. `refuseRiskPolicySelection` gained a
    `relaxes_run_oversight` arm: `mp_unattended`'s role layer is empty, identical to `Balanced`'s, so
    without it any member could re-point a task onto the seeded policy and remove the human
    checkpoints their workspace's own default raises.
  - **Every grading loop now remembers its own rounds.** `step.companion.verdicts` recorded one verdict
    per cycle and no prompt read it, so a companion re-graded a revised document with no idea what it
    had asked for last time — the loop resampled instead of converging, and a rework budget bought
    nothing. Both sides of the loop now receive the rounds so far (`AgentRunContext.priorReview`,
    folded once in `userPromptFor`, so an inline companion, a container-backed one, a
    deployment-registered one and the producer being reworked all get it), and the 0..1 scale is
    anchored and SHARED with the judge bucket, which had carried its previous verdict all along.

  **Migration, and the one thing to check.** Both facades' migrations materialise `mp_unattended` in
  every existing workspace as a CLONE of that workspace's own default row, with `autonomy` the only
  field changed. Cloning, not seeding stock values: a built-in is editable in place, so a workspace
  that tightened its `Balanced` still holds `id = 'mp_balanced'`, and writing catalog ceilings beside
  it would hand every API-started run there a wider licence to land than its operator granted. Every
  ceiling, budget and per-role restriction is inherited (`dryRunRoles` and `submissionClassesByRole`
  above all). Landing authority does not move underneath anyone; what changes is that such runs stop
  parking on the caps. A deployment that WANTS its API-started runs to keep parking re-points
  `isUnattendedDefault` at a policy whose `autonomy` is `attended`.

  `Balanced` and `Manual review only` are NOT version-bumped. Both new fields land on them as the
  migration's column defaults, so a stored row and a freshly seeded one are identical — advising every
  existing workspace to reseed for a zero-delta change would invite them to overwrite their own edits.

  **Public API (additive, OpenAPI 1.49.0).** `GET /api/v1/risk-policies` gains `isUnattendedDefault`
  and `autonomy`. `isDefault` keeps its exact former meaning, so nothing an existing client was told
  becomes wrong; it was reading about the other scope. A caller predicting whether its own runs can
  reach a terminal state unassisted should read `autonomy` on the `isUnattendedDefault` row.

  **Internal break.** `RiskPolicyRepository.getDefault` takes the scope, and
  `RunMergePolicy.resolve` / the engine's `resolveRiskPolicy` callback take the run. Both are required
  rather than defaulted: a call site that has not decided which kind of run it is resolving for now
  fails to compile, because the alternative reads as correct and silently hands an unwatched run the
  in-app policy.

  Design record: [ADR 0053](../backend/docs/adr/0053-unattended-run-autonomy.md).

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/sdk@0.38.0

## 0.35.0

### Minor Changes

- ee733ee: A run whose stored row cannot be decoded is now closed instead of re-driven forever, and one
  unrecoverable run no longer ends the stale-run sweep.

  The two are the same incident. A `kind='execution'` row with no `block_id` fails `rowToExecution`,
  and every path that could settle such a run begins by READING it: the re-drive throws on the load,
  and so does the hard-stall backstop whose entire job is to settle a run recovery cannot resume. The
  row therefore stayed `running` forever, was re-listed by every sweep (`listStale` is ordered oldest
  first, so it sorted to the front of each one), and past the hard-stall deadline its throw escaped
  the per-run body and ended the whole pass: no other stale run recovered, no spend-paused run
  resumed, no batch enqueue happened, tick after tick, while the sweeper reported itself as running.

  - **Disposal.** `RunStateMachine.loadOrDispose` recognises a `DataIntegrityError` by TYPE (a
    transient database failure still propagates and leaves the run alone) and settles the run through
    `markFailed`, the one write that decodes nothing. Both the driver entry point
    (`ExecutionService.advanceInstance`) and the settle path (`failRun`) read through it, so such a
    row is closed on its first re-drive rather than an hour later.
  - **The owning block goes with it.** A settled run row with the card still `in_progress` leaves the
    human half of the incident unresolved forever, because the run is dropped from the board snapshot
    and there is no failure card and no Retry. The run names no block, but the block names the run:
    the new `BlockRepository.getByExecution` reads that reverse link, and the card drops to `blocked`
    with a pushed board event and no fabricated progress.
  - **Only a MALFORMED row is disposed of.** A stored value this build does not RECOGNISE is a fact
    about the reader, not the row: during a rolling deploy an unknown `ExecutionStatus` member is a
    healthy run the newer replica wrote, and disposal is irreversible while a re-drive costs a tick.
    `DataIntegrityError` now carries a `DataIntegrityFault`, and the reversible half is the fallback
    wherever the fault is unknown or absent.
  - **Isolation.** Both facades' sweeps recover one run at a time inside a per-run boundary, log the
    run they skipped, and count it as `sweep.run_recovery_failed`. A pass that took runs on and
    recovered NONE of them reports itself as a FAILED pass, since such a pass now completes and a
    recorded success would reset `sweep_degraded` on precisely the wedged sweeper it watches for. A
    run whose probe threw keeps its per-process orphan clock, so the hard-stall backstop can still
    reach it.
  - **A new failure kind, `state_unreadable`** (surface version 1.48.0, additive), so these runs are
    distinguishable in the operator's failure-kind breakdown rather than filed under `stalled`, whose
    advice is "retry" and whose retry would re-read the same row.
  - **A write-side guard.** Composing the stored `detail` for a run that `rowToExecution` would refuse
    now throws, for both invariants it checks (no `blockId`, a cursor outside its step list), so the
    writer that produces one reports the fault instead of a sweeper hours later. Both facades'
    `upsert`/`insertLive`/`compareAndSwap` compose through that one function.

  `DataIntegrityError` moved to `@cat-factory/kernel` (re-exported from `@cat-factory/server`, so no
  import breaks) because the engine has to be able to recognise it. It also survives the mothership
  persistence RPC as its own error code rather than an opaque 500, without which the disposal would be
  a no-op on mothership deployments.

  Documented on the website in kibertoad/cat-factory-website#53.

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/sdk@0.37.0

## 0.34.1

### Patch Changes

- 01086d8: `GET /api/v1/models` now says whether a model's subscription is actually CONNECTED for the person a
  key belongs to, and stops calling the commonest one unwired. Surface version 1.47.0, additive: two
  new response fields and no change to anything already published.

  **The bug.** `userScoped` was added so a caller could tell "your credential was never consulted" from
  "no provider is wired", and it was derived from the route IN FORCE. A model with more than one route
  resolves, when nothing is configured, to the most-preferred route it merely DECLARES, and
  `subscription` is last in that order, so `claude-opus`, the built-in Claude preset's own model, which
  also declares OpenRouter, answered `userScoped: false`. The flag shipped to remove that misreport
  never fired for the model every report of it has been about; the acceptance suite kept printing "no
  provider wired for it" at operators whose workspace runs Claude every day, and the fix it named (add
  a provider key) was for a deployment that was already correct.

  **Why a new field rather than a corrected one.** `userScoped` is published, and correcting it in
  place would have moved its meaning in two directions at once: true where a model merely declares a
  subscription route (right), and no longer true for a POOLED vendor whose subscription route is in
  force (also right, and also a change under any consumer branching on it). So `userScoped` keeps
  answering exactly what it always answered and is marked superseded, `personalSubscription` is served
  beside it, and dropping the old half is a later change. `personalSubscription` is true where a model
  declares a subscription route whose vendor is individual-usage only, read through kernel's own
  `individualVendorForModelId`, the same predicate the run path gates a personal credential on. The
  pooled exclusion matters: a Kimi or DeepSeek token belongs to the WORKSPACE, so every key can already
  see it, and reporting one as personal sent an operator to re-mint a token when the fix was a pooled
  token or a provider key.

  **The existence field.** `personalSubscription` alone still stops one step short of useful: told a
  row cannot be judged, an operator's next move is to re-mint the token bound and see what happens,
  which is exactly how the last person to hit this found the answer. Each row now carries
  `subscriptionConfigured`: whether a personal subscription for that vendor is stored for the person
  the key belongs to (`actsAsUserId` when bound, else its minter), and `null` when there was nobody to
  ask about. Existence is a row lookup, so the deployment answers it without the personal password that
  OPENS the credential.

  That is also the correction to 1.45.0's reasoning, which rejected reporting this on the grounds that
  "the server cannot know whether one exists without a user". An unbound key does have a user for
  DESCRIPTION purposes: its minter, who is exactly who the remedy names. Reading it changes nothing
  about admission: `available` is still resolved under `actsAsUserId` alone, so a system token reads
  `available: false` beside `subscriptionConfigured: true`, and both are true. `createdByUserId` rides
  `PublicApiKeyAuth` for that one reader and stays provenance; nothing authorizes off it. The
  disclosure this trades (an `admin`-scoped key learns one bit about its minter, who need not be its
  holder) is documented on the field and in `public-api.md`.

  **Three fixes underneath.** A LAPSED personal subscription reported as configured (`has` checked
  existence where `unlock` checks expiry), so the catalog offered a model whose run was then refused at
  its first dispatch, naming the model rather than the subscription. Both credential stores answered
  the vendor sweep one single-row question at a time; `PersonalSubscriptionService.liveVendors` and the
  new `ProviderSubscriptionService.liveVendors` each answer the whole vocabulary in one read, on a path
  both the catalog render and every run start take. The pooled half needed a new
  `ProviderSubscriptionTokenRepository.listByWorkspace`, mirrored across D1, Drizzle and the local
  sqlite credential store with a conformance assertion.

  The acceptance suite reads all of it: `configure`'s menu and the `model-preset` / `agent-model` gates
  now distinguish five states with five different fixes, with the account model-family policy ranked
  ahead of every credential state (it is the one cause no credential can undo) and the state that
  matters most saying the subscription is connected and naming the token as the only thing in the way.

- Updated dependencies [01086d8]
  - @cat-factory/sdk@0.36.1

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
