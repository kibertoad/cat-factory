# @cat-factory/mcp-server

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

## 0.34.0

### Minor Changes

- 195b248: Tracker writeback is ON by default, and `/api/v1` can now read and change it:
  `GET /api/v1/tracker/writeback` reports what a task's linked tracker issue hears as its pull request
  progresses, and `PATCH /api/v1/tracker/writeback` changes one action without moving the others.
  Surface version 1.46.0, additive.

  **BEHAVIOUR CHANGE, and worth reading before upgrading.** All three writeback actions (comment when
  the pull request opens, comment and CLOSE the issue when it merges, post a headless run's parked
  review findings) now default to ON for a workspace that has never configured them. All three were
  off. Nothing published said what the defaults were, so this is not an `/api/v1` break, but it IS a
  change a deployment notices: a board that never opened the issue-tracker settings panel now closes a
  linked ticket when its task's pull request merges, and comments on it twice on the way. A deployment
  that wants the old behaviour turns it off with one call to the new PATCH (or in the app), and a single
  task can still opt out through its own per-task override.

  The reasoning for the flip is that these actions only ever touch an issue a task is LINKED to, and
  nothing links one by accident: a link arrives because somebody imported the issue, the recurring
  intake picked it up, or a headless caller filed a task with `ticket`. Every one of those is a request
  to work the issue where it was filed, so the half-closed loop was the common outcome and the wrong
  one: a merged pull request beside an issue still sitting open with nothing on it saying the work was
  done. The default now lives in ONE place (`DEFAULT_TRACKER_WRITEBACK` in `@cat-factory/contracts`),
  read by the settings service, the writeback service and the SPA's panel, which previously spelled it
  three times.

  The public pair closes the last gap in the ticket-driven loop. A caller could file a task FROM a
  ticket and the platform would write back to that issue, but WHETHER it did was workspace
  configuration reachable only from the app, so the deployment shape that most needs the loop closed
  (nobody in the SPA at all) could neither read the disposition nor change it, and could not tell "this
  deployment leaves tickets open" from "the writeback is broken". Three things about the shape: it
  publishes the WRITEBACK half of `tracker_settings` and not the filing selection, which is a separate
  decision the writeback does not key off; the write MERGES, so a caller acting on one action cannot
  move the other two; and `updatedAt` is null when nobody has ever chosen, which is how a caller knows
  it is reading defaults rather than somebody's decision.

  **Every writeback write now merges, the app's own included.** An omitted action used to revert to the
  deployment default on the internal wholesale PUT, which the default flip above turns from harmless
  into a silent re-enable: the recurring-pipeline dialog persists a FILING tracker and names no
  writeback action, so scheduling a tech-debt pipeline switched writeback back on for a workspace that
  had deliberately turned it off. Absence now means "not moving this action" on both doors, which is
  the only reading any caller wanted, and the merge itself moved down into the two repositories
  (`TrackerSettingsRepository.merge`, replacing `put`), so the SPA panel and a headless patch naming
  different actions both land instead of one silently losing to the other's stale snapshot.

  The acceptance suite gains a fifth spec built on all of it: an issue filed on the backend repository
  by an OUTSIDE reporter (its own provider credential, since an issue the platform created and closed
  proves only that the credential works), a task filed FROM that issue over `/api/v1`, delivery through
  `pl_build`, and then the pair of claims that the platform CLOSED the issue and commented on it at both
  edges of the pull request's life. The pair matters because a provider closes an issue by itself when a
  merged pull request's text carries `Closes #12`, and that path posts no comment: a closed issue alone
  cannot tell the writeback from the host noticing a word an agent wrote. Two new prerequisites refuse
  before any of it spends anything, and `run configure` opens the token page prefilled.

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/sdk@0.36.0

## 0.33.0

### Minor Changes

- bc2478d: A public-API key now has an IDENTITY as well as a scope: a SYSTEM token (the default, unchanged) or
  a PERSONAL token its minter bound to themselves, which can run their own individual-usage
  subscription headlessly. Surface version 1.45.0, additive. Plus two bug fixes that made the old
  behaviour unreadable rather than merely limited.

  **The reported problem.** A workspace whose Claude runs come from a stored personal subscription was
  told by `GET /api/v1/models` that `claude-opus` was `available: false`, which the acceptance suite
  rendered as "no provider wired for it". Both statements are false, and the remedy they imply (add a
  provider key) is for a deployment that was already correct. The model was wired — as a credential
  belonging to a person, which a key-authenticated read is not allowed to see.

  **Two things were genuinely broken, independent of the feature.**

  `resolveWorkspaceCapabilities` did not know about NATIVE ambient execution. A vendor served by the
  host's own `claude`/`codex` CLI login (`LOCAL_NATIVE_AGENTS`) has no credential in either store, and
  the resolver consulted only those two stores, so the catalog and the pipeline-start guard called the
  model unconfigured on the very machine that would have run it. The personal-credential gate, reading
  the same allow-list, had already decided such a vendor needs no unlock: two halves of one decision,
  disagreeing. They now share `isAmbientNativeVendor`, which is where the executor's half already was.

  `GET /api/v1/models` could not say why a personal subscription's model was unavailable. The existing
  `excludesUserScopedModels` flag reports what an answer OMITS, and a subscription model is not omitted
  — it is listed, unjudged, because no user's credential store was consulted. Each row now carries
  `userScoped`, so the distinction is stated where it applies. Widening the response flag instead was
  tried and rejected: with no user resolved the server cannot know whether a personal subscription
  exists, so the honest predicate is "this deployment has `ENCRYPTION_KEY`", which is true nearly
  everywhere. A flag that is always true stops answering its question, and it would have re-pointed a
  published field at a new predicate under the same name.

  **The feature.** `POST /workspaces/:ws/public-api-keys` takes `actsAsSelf`, and the key row carries
  `actsAsUserId`. A personal token's runs record that person as initiator, `GET /api/v1/models`
  resolves under them, and a start/retry/decision call may unlock their subscription by sending
  `X-Personal-Password` — the same header, the same 428, and the same per-run activation the app uses.
  A system token behaves exactly as every key did before, including the `409
individual_model_unsupported` refusal, which is now reserved for the case no password could fix.

  Three properties bound it, and each is a shape rather than a rule to remember. The wire field is a
  BOOLEAN and the server reads the id off the session, so minting a key onto a colleague's
  subscription is unrepresentable rather than merely forbidden; a mint with no signed-in user is
  refused instead of quietly producing an unbound key. Headless provisioning (`POST /api/v1/keys`)
  can never bind, because a provisioning key holds nobody's consent to inherit. And the password is
  stored NOWHERE — not on the row, not in a session — so the binding alone spends nothing and a
  leaked personal token reaches that user's PAT (as a leaked session would) but not their
  subscription.

  A bound key attributes EVERY run it starts, not only the ones needing an unlock. The alternative
  makes one key produce runs under two identities depending on which model a task happened to pin,
  with two credential scopes and two merge-policy roles, and nothing in the request to say which.

  **And a bound run is that person's run all the way through, policy included.** The two public start
  routes resolve the bound user's workspace ROLE and pin it, so a headless start is admitted under the
  same role-scoped merge narrowing and the same dry-run sandbox its holder gets in the app: a key
  cannot land what the person behind it could not. An initiator with no role is not a lenient run, it
  is a run with no policy — which is what the bug-hunt adopt route once shipped, and why
  `runAdmission.coverage.spec.ts` makes every start route CLASSIFY itself. A retry deliberately keeps
  the ORIGINAL run's pinned authority instead (`buildResumedInstance`), because a re-drive is the same
  work under the authority it was first granted, and dropping it would launder a dry run into a live
  one via restart-from-step-0.

  `POST /api/v1/jobs` runs the same personal-credential gate as the board start. Being inline-only
  settles what a public run may DO (no container, no push) and says nothing about whose credential it
  needs: the inline harness leases a personal subscription for every individual-usage vendor, so
  skipping the gate there traded an actionable refusal for a run that dies at its first dispatch.

  Deliberately not lifted: `POST /api/v1/notifications/:id/act`. Its ci-/test-failure arm retries
  through a shared effect that mints no activation, so admitting a bound key there would trade a
  refusal the caller can act on for a run that dies at its first dispatch. Lifting it means threading
  the gate through that effect for the SPA and this surface at once.

  **Answering a park no longer re-derives a credential that is already fresh.** Each re-mint runs
  210k PBKDF2 iterations per vendor, which a human clicking through a run pays once and a headless
  driver answering eight follow-ups would pay eight times in a row — seconds of blocked event loop on
  Node, a CPU-limit kill on workerd. The interaction path now skips the whole gate while the run holds
  an activation with over half its life left, and both facades share one helper, so the SPA gets the
  same. The decision surface's refusal is returned as DATA (a `428` in that surface's own envelope,
  carrying the vendor and reason) rather than thrown, which is the invariant every other gate there
  already keeps.

  **`X-Personal-Password` is declared on the operations that read it**, so it reaches
  `docs/openapi.json` and the four generated clients instead of being discoverable only by getting a 428. Each client also gained a post-construction setter for it, since that is when a caller learns
  it is needed.

  **The acceptance suite** now runs on the operator's own subscription. It prompts for the personal
  password at the terminal on the first call that needs one — never at `configure` time, and never at
  all for a workspace on a provider API key — and holds it in memory only: not the `.env`, not the
  ledger, not the journal, because a copy beside `CAT_FACTORY_API_KEY` would put both halves of a
  two-factor credential in one file. The header then rides every request, since answering a park
  re-mints the run's activation server-side. `configure` and the `model-preset` gate now say "not
  visible to this system token" and name the fix, instead of the wrong one they used to name — read
  off the ROW, so a model that genuinely has no provider still reads as unwired, and an invisible
  workspace default stays SELECTED rather than being quietly swapped for a model nobody chose.

  The prompt opens the CONTROLLING TERMINAL rather than reading `process.stdin`. The suite runs under
  vitest, whose workers are forked with piped stdio, so a prompt built on stdin could never have asked
  anything: the one path this exists for would have thrown "stdin is not a terminal" on every pass. It
  is also stricter than the check it replaces, since a controlling terminal cannot be fed from a pipe
  or a file at all. And the entered password is no longer trimmed: a space is printable ASCII, so a
  legal password with one at either end was being silently altered and then reported as wrong.

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/sdk@0.35.0

## 0.32.0

### Minor Changes

- 7893f35: `/api/v1` can ADOPT a repository that already exists: `GET /api/v1/repos/available` lists what a
  workspace's connection can reach, and `POST /api/v1/repos/link` adopts one by name. Surface version
  1.44.0, additive.

  The hole they close was invisible from the surface. `GET /api/v1/repos` serves the repositories a
  workspace has LINKED, which is a set someone assembles in the app: linking is explicit per workspace,
  the provider webhook for an added repository does not project one, and a resync refreshes what is
  already linked rather than rediscovering the installation. So a repository that exists and is
  perfectly reachable is absent from every public read until a human opens the picker, and
  `POST /api/v1/services` answers 404 for its `repoId`, which is byte-for-byte what a caller gets for a
  repository that does not exist. A deployment could CREATE a repository through this API (1.41.0's
  bootstrap) and could not adopt one it already had.

  The two reads are a population pair rather than a duplicate, with `linked` as the join, so an absent
  repository is now diagnosable: reachable-but-unadopted appears in `/repos/available` with
  `linked: false`, and one that does not exist appears in neither. The adopt takes `owner`/`name`
  because a caller setting a workspace up from configuration knows the name and cannot know a provider
  id for a repository no public read lists; it is idempotent, answers the same row shape `/repos`
  serves (projected from the same read, so the two cannot disagree about whether a repository is free),
  and refuses an unreachable one with `404 repo_not_reachable`, a reason that covers "does not exist"
  and "your credential is not granted it" together because a provider answers those identically.
  `GitHubSyncService.linkRepoBySlug` resolves through the same path the app's own picker uses, and
  matches the OWNER as well as the name: a slug search can surface a look-alike, and linking that one
  would file a caller's work in someone else's account while answering 200.

  The acceptance suite uses them, which is what makes a hand-written `.env` a supported way in rather
  than a setup only `configure` could finish. Spec 01 adopts a repository the workspace does not hold
  instead of refusing; `target-repos` gates on REACHABILITY, point-reading `/repos/available` for
  anything unlinked and reporting "reachable but not adopted yet" as a pass; and `configure` adopts each
  repository rather than printing instructions for doing it by hand. Every attempt states its outcome,
  because a loop that reports only its positive answer is indistinguishable from one doing nothing, and
  what a refusal now asks for is only what no API can do: create the repository, and grant the
  credential access to it.

  Review follow-ups on the pair, all still inside 1.44.0 and still additive:

  Both rows now report whether a repository is SPOKEN FOR, from one account-scoped judgement.
  `/repos/available` publishes `serviceId` and `linkedElsewhere` exactly as `/repos` does, because a
  repository nobody here has linked can still back a service on another board of the account, and
  `POST /api/v1/services` refuses it either way. A discovery read that could not say so handed a
  caller a repository whose next call fails, and it was the acceptance gate that felt it first: it
  green-lit a pass that then died on the adopt, after the run the gate exists to precede. The
  judgement is now `PublicBoardReads.repoUse`, asked once of the projection (the repos list) and once
  of a batch of ids (the available read), so there is no second derivation to drift.

  The available read also publishes `truncated`. The provider legs behind it stop at a page cap and a
  search cap, so on a wide connection the rows are a prefix and a reachable repository can be missing
  from them, which is indistinguishable from the non-existence this read exists to diagnose. A
  point-read (`?q=owner/name`) resolves the exact slug directly and stays authoritative either way.

  A provider refusal is answered as one on BOTH operations and on either provider. The available read
  was left unwrapped, so a revoked credential or a rate limit on it arrived as `500 internal` rather
  than the documented 503/429; and the mapping recognised `GitHubApiError` alone, so a GitLab-connected
  workspace got that same `500` for a revoked token on both routes. Kernel now owns a `VcsApiError`
  base that both provider clients extend, which is the identity a consumer above the adapters branches
  on.

  The adopt is idempotent for a repository the credential can no longer reach: it resolves from what
  the workspace LINKS before consulting the provider, so a re-run no longer answers 404 for a
  repository `GET /api/v1/repos` still lists (a personal repository, or a narrowed App grant). And the
  link's `owner` accepts a namespace PATH, so a GitLab project under nested groups can be adopted at
  all: the available read published `group/subgroup` and the adopt refused it with a 422.

  In the suite, "the connection cannot reach it" is now recognised by `details.reason`, not by the 404
  alone: a deployment older than these endpoints answers an unmatched route with the same status, and
  reading that as "create the repository" sent an operator to create one they already had.

  Internal, breaking for in-repo callers only: `GitHubSyncService.listAvailableRepos` answers
  `{ repos, truncated }` rather than an array, the kernel `GitHubClient.searchInstallationRepos` port
  answers a `Paged` rather than an array (every adapter caps something, and a search that filters a
  bounded listing can return two rows and still be a prefix, which no row count reveals), and the
  `viewerRepos` / `patInstallationRepos` caches hold the whole page rather than its items (an
  enumeration that stopped at the cap is a prefix, and caching only the rows served that prefix to
  every later keystroke as the complete set).

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/sdk@0.34.0

## 0.31.0

### Minor Changes

- 07ff467: Let `/api/v1` callers pin what a task runs on (surface 1.43.0). `GET /api/v1/model-presets` lists
  the model library, task create and task PATCH accept `modelPresetId` and `riskPolicyId`, and the
  task projection reads both back. A pinned id no library carries is refused with `details.reason`
  naming which one it missed, rather than falling back to the default, because a run that quietly
  used another model succeeds while being about something else. The check lives on `BoardService`, so
  the SPA, tracker intake, an initiative spawn and blueprint reconciliation get the same refusal.

  **Breaking, deliberately, on a surface with no adopters:** `GET /api/v1/merge-presets` is renamed
  to `GET /api/v1/risk-policies` in place (response `presets` → `policies`, `presetId` → `policyId`,
  SDK group `mergePresets` → `riskPolicies`, reasons `merge_preset_*` → `risk_policy_*`). It shipped
  one release ago under the name the product renamed away from a month before that, and the id it
  serves is what a task pins as `riskPolicyId`, so leaving it would put two names for one concept on
  one wire permanently. `backend/docs/public-api-versions.md` records why this is an exception to ADR
  0034 rather than a precedent.

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/sdk@0.33.0

## 0.30.0

### Minor Changes

- b25732f: Add deployment provisioning to `/api/v1`, so a workspace can be taken from "connected" to "able to
  run a pipeline" with no browser. Surface version 1.41.0; every change is additive.

  Eight new operations: `POST /api/v1/repos/bootstrap` and `GET /api/v1/repos/bootstrap/{jobId}` create
  a repository and adapt it with the bootstrapper agent; `POST /api/v1/environments/connections` and
  `.../test` bind or probe the cluster per-run environments deploy onto; `PATCH
/api/v1/services/{serviceId}` declares where a service's manifests live; and `GET /api/v1/models`,
  `GET /api/v1/vcs/connection` and `GET /api/v1/merge-presets` report what the deployment has wired. All
  `admin`, including the reads: they name deployment configuration rather than board content, and a
  caller that can read them is already at the rung that could change them.

  `PublicService` also gains an optional `provisioning`, so a caller that just set it can confirm what
  landed. It is projected only for the shapes this surface publishes; a service provisioned through
  another engine reports nothing rather than a coerced value.

  A service PATCH OVERLAYS the stored provisioning rather than replacing it (the column is one JSON
  blob, and this surface publishes two of its fields, so a wholesale write dropped the image overrides
  and Secret injections an operator authored in the app), and it must name at least one field.
  `GET /api/v1/models` reports `excludesUserScopedModels`, and `GET /api/v1/merge-presets` reports
  `submissionRestrictedRoles`: in both cases a state the surface previously rendered identically to
  "nothing here", where the two need opposite reactions. `GET /api/v1/vcs/connection` now answers on a
  GitLab-only deployment, which builds no GitHub module and so was refused with a 503.

  No breaking change: nothing published was renamed, retyped or re-scoped, and the SDKs tolerate the new
  enum members by design. The bootstrap request's `type` enum is PINNED to the name the service
  creation route already published (`scripts/sdk/ir.mjs`), because sharing a value set is what
  otherwise renames a released type in four clients.

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/sdk@0.32.0

## 0.29.0

### Minor Changes

- 2428b6b: Attribute a cross-service run's pull request to every involved service frame whose changes ride
  it, not just the first.

  The multi-repo fan-out checks out one repo per REPO, so several involved services living in one
  monorepo already shared a checkout, a work branch and a single pull request. Only the RECORD was
  singular, which left every frame but the first looking like a service the run had opened no pull
  request for. The attribution is now a set (`frameIds`) from the dispatch through the harness echo
  to `block.peerPullRequests`, the merge order, and the verification report. The own-service report
  carries it too, naming the involved services co-located in the task's own repo: those open no pull
  request of their own, so that report is the only place their change is reported. A peer checkout
  also stops inheriting one co-located service's `serviceDirectory`: it is whole-repo, as the primary
  already was, so the services that resolved second are reachable.

  A recorded peer pull request is now ADDRESSED by its repo rather than by its frames, which is what
  a checkout is identified by, and one the platform cannot resolve is named to the merger instead of
  being dropped from the combined diff it scores.

  Internal break: `peerPullRequestSchema.frameId`, `allPullRequests`, `MergePrEntry.frameId`,
  `PrReportTarget.frameId` and the harness `peerRepos`/`peerPullRequests` wire fields are replaced
  by `frameIds`. Peer PRs recorded on a block before this ship lose their frame attribution (the
  pull requests themselves are untouched). Public `/api/v1` is additive only: `PrReportScope` gains
  `frameIds` and keeps `frameId` as its head (surface version 1.40.0). `frameId` is no longer always
  null on an own-service report: it names a co-located involved service when there is one.

  The runner image moves to `cat-factory-executor:1.109.0`.

### Patch Changes

- Updated dependencies [2428b6b]
  - @cat-factory/sdk@0.31.0

## 0.28.1

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
  - @cat-factory/sdk@0.30.1

## 0.28.0

### Minor Changes

- 83764b5: Put a run's live environments on the outcome summary (spec 1.38.0, outcome `version` 3). Additive.

  The outcome summary gains an `environments` section: one row per throwaway environment the run
  stood up, carrying its URL, its state, the TTL instant when the platform recorded one, the service
  frame it belongs to, the environment id an operator greps for, the producer's verbatim cause, and
  whether the run's deployer declared that the environment outlives the run. The app's outcome card
  renders it beside the captured views, and `GET /api/v1/runs/:runId/outcome` serves the same
  reduction, so "click and look" no longer means opening the step that provisioned it.

  `state` is the field that matters and `live` is the only one that offers a link. Every other row
  (`provisioning`, `failed`, `reclaiming`, `reclaimed`, `expired`) still carries whatever URL it had,
  because that is what names the environment, so a consumer rendering the URL without the state
  beside it hands someone a link to something that is no longer there. A client with a clock owes the
  other half of that: `expiresAt` is served as an instant rather than folded into `state` (the
  reduction is clock-free so the app and the endpoint cannot disagree about one run), so a `live` row
  whose TTL has passed is not a URL to hand anyone.

  Several producers know something about the same environment, and they are reconciled BY IDENTITY
  before they are ranked: the run's step projections and the `human-test` gate's own record fold into
  one observation per environment id, above which the disposer's terminal record wins and below which
  the deployer's provision-time row is the floor. An environment a LATER deploy of the same frame
  replaced is reported as gone, derived rather than observed, since nothing refreshes its projection
  again. A reclaim that FAILED leaves the row `live` with the provider's cause beside it: the
  environment is still standing and its URL still works, and that it should not be is the verification
  report's teardown proof rather than this section's question.

  Absences stay three distinct facts: `no_environment_step` (the pipeline provisions nothing),
  `not_provisioned` (something was meant to and nothing is recorded yet) and `infraless` (every frame
  declares no environment of its own). `hasOutcomeToShow` counts a reported environment, so the "read
  the result" affordance now appears on a run whose only product so far is something to look at.

  The rules this shares with the PR verification report moved into contracts' `run-evidence.ts`
  beside the tester rules: which frames the run's deploys settled, what it observed of each
  environment, which recorded lifecycle states mean one is gone, and whether the deployer declared
  retention. The disposer reclaims by the same fold, so the set of environments a run stood up has one
  statement rather than three. `DEPLOYER_AGENT_KIND` / `DISPOSER_AGENT_KIND` are defined there now and
  re-exported from `pipeline-environment-lifecycle.ts` under the same names, so no importer moves.

  A `deployer` step now also records the environment id on a frame whose provision FAILED, where the
  provision got far enough to have a record to fail against. Internal step state, so stale rows simply
  lack it; what it buys is that the failed environment the run projected is nameable as the one that
  frame broke on rather than surfacing as a second environment nothing accounts for.

  The spec generator's per-version changelog moved to `backend/docs/public-api-versions.md`, a
  document rather than a 250-line comment block in a script: it grows with every release and never
  shrinks, and the file-size ratchet said so first. Nothing about how the number is set changed, and
  the note that makes the next silent version collision arrive as a merge conflict travels with it.

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/sdk@0.30.0

## 0.27.1

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

  - @cat-factory/sdk@0.29.0

## 0.27.0

### Minor Changes

- bf473bd: `/api/v1` gains `GET /api/v1/runs/{runId}/spec` at `read` scope: the in-repo specification a run was
  judged against, read at the branch that run pushed its work to. Additive, so the OpenAPI surface
  version moves to 1.36.0 and nothing existing changes shape, scope or error vocabulary.

  It is the sibling `GET /api/v1/services/{serviceId}/spec` could not stand in for. That one answers
  the repository's default branch, and a task's spec increment does not merge while its pull request
  is open, so a caller joining `requirements` rows from `…/report` or `…/outcome` back to the criteria
  they were scored against found no criterion for exactly the rows the run had added. The pair mirrors
  the internal split the SPA's outcome card already needed for the same reason.

  Both public reads and both internal ones now go through one reader, and the run read goes through
  the engine's own evidence loader, so the tree a caller joins against is the tree the platform joined
  against: the same branch rule, the same tester gate and the same per-run memo the verification
  report and the outcome summary use.

  The loader change worth knowing about is that it now reports WHERE a spec read stopped instead of
  folding every outcome onto an empty view. The two reductions still fold (a coverage section states
  its own absence), but the endpoint does not: an unwired integration and an unreadable repository are
  `503`s carrying their own `details.reason`, and a fourth `anchor` value, `not_read`, says the
  platform has consulted no tree for this run yet. Folded, an outage would have told an integrator
  that a run was judged against a service declaring no requirements.

  The read also resolves the branch head before walking, which adds one repository call per run
  (memoised with the tree, so a later reader gets the commit the tester ruled at rather than one
  resolved afterwards). That resolution now carries a second job: a run keeps naming its pull
  request's head branch after the branch is deleted, which is the ordinary sequel to a merge, so a
  read that finds neither a head nor an anchor there falls back to the repository default and names it
  in `provenance.ref`. Without it the post-hoc audit this endpoint exists for was the one case that
  answered a permanent `503`. Only a confirmed missing branch moves the read; a host that will not
  answer for the ref leaves it alone, so an incident cannot swap the tree.

  Between the two wiring refusals and the `not_read` gate, the gate now goes first: before a tester
  reports, a run answers `not_read` whatever the deployment wired. Ranked by what was cheap to check,
  an unwired deployment and an unconnected workspace behaved differently for the same run, one
  answering `503` throughout and the other flipping from `200` to `503` partway through.

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/sdk@0.29.0

## 0.26.1

### Patch Changes

- 3036af7: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
  (`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
  Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
  exactly one Vue.

- Updated dependencies [3036af7]
  - @cat-factory/sdk@0.28.1

## 0.26.0

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
  - @cat-factory/sdk@0.28.0

## 0.25.0

### Minor Changes

- 8a06abc: SDK clients: a request body with no required field is now a parameter you may OMIT, and
  `POST /api/v1/notifications/:id/act` carries the reviewer-effort tag.

  Fourteen operations have a body whose every field is optional, and until now all four clients
  rendered it as a required positional parameter, so a caller with nothing to say still had to type
  an empty object. That was also what kept `act` body-less: giving it the app's `reviewEffort` field
  would have rewritten `act(id)` as `act(id, body)` in four published clients. Teaching the emitters
  an omittable body fixes both at once, and the emitters read "omittable" off the spec (`required: []`
  on the body schema) rather than a per-operation list.

  `act` now takes `{ "reviewEffort": "none" | "minor" | "major" | null }`, so confirming a merge and
  recording what reviewing it cost is ONE headless request rather than two, matching the app's one-tap
  confirm-and-tag. A `merge_tag_request` card becomes actionable too, but only when a tag is supplied:
  recording one is its entire side-effect, so a bare `act` answers 409 with
  `details.reason: "review_effort_required"` instead of resolving the nudge and writing nothing. The
  route's other 409 now says `no_automated_action`, so the two causes are told apart by a machine.

  **Wire compatibility is unaffected.** `act` mounts `optionalJsonBody`, so an integration that has
  been calling it with no body at all keeps working; every client sends `{}` when the argument is
  omitted, because the route's validator still requires a body to parse.

  **Source compatibility, per language.** TypeScript and Java are unchanged for every existing caller:
  the body gets a default, and Java gets a real overload. Two need a mechanical edit:

  - **Go** takes an all-optional body by pointer, so `Start(ctx, id, body)` becomes
    `Start(ctx, id, &body)` and `Act(ctx, id)` becomes `Act(ctx, id, nil)`. Both are compile errors,
    not silent changes.
  - **Python** makes `timeout` keyword-only on every operation. `act(id, timeout=5)` is unchanged;
    a positional `act(id, 5.0)` is now a `TypeError`. That is the point of the change: leaving it
    positional would have bound `5.0` to the new body and sent the timeout as the payload.

- 8a06abc: Public API (`/api/v1`, spec 1.33.0): the merge-EVIDENCE loop. Additive.

  Four new operations: `GET /api/v1/runs/:runId/merge-record` (the merge decision a run left behind,
  carrying the backend-derived change class, the merger's scores and the preset they were compared
  against), `GET /api/v1/merge-records/rollups` (every change class's accumulated track record as one
  aggregate), `GET /api/v1/merge-records/:recordId`, and
  `POST /api/v1/merge-records/:recordId/effort` (tag or clear the reviewer effort a landed pull
  request needed).

  Until now the merge track record (ADR 0046) was reachable only from a browser session, which split
  the headless story in half: an integration could start a run through `/api/v1` and merge its pull
  request through `POST /notifications/:id/act`, and then had nowhere to record how much review that
  merge took nor any way to read back what the workspace had accumulated. The one signal the
  auto-merge policy is meant to eventually stand on was collectable only by the people who were not
  driving the runs.

  **Tagging is `write`, not `admin`.** `act` is at the top of the ladder because it merges a pull
  request for real; recording how much review an already-landed one took performs no external
  side-effect and merges nothing, so an integration whose job is collecting evidence no longer needs a
  key that can also delete tasks and merge.

  Refusals across the surface carry `error.details.reason`: `run_not_found`, `no_merge_record` (a
  readable run whose pipeline reached no merge decision) and `merge_record_not_found`, which the
  record-addressed READ and the TAG now answer identically, so a client branches on one value
  whichever of the two it called.

  `POST /api/v1/notifications/:id/act` deliberately stays body-less, so the app's one-tap
  confirm-and-tag has no single-request headless equivalent: every SDK emitter renders a request body
  as a required positional parameter, so adding `reviewEffort` there would rewrite `act(id)` as
  `act(id, body)` in four published clients. The headless form is two calls in either order, since the
  tag is idempotent and orthogonal to the decision.

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/sdk@0.27.0

## 0.24.0

### Minor Changes

- 11f9efa: Public API (`/api/v1`, spec 1.32.0): the two cost and telemetry reads that were reachable only
  from a browser session. Both additive.

  `GET /api/v1/usage/spend` groups a board's spend over a window (`24h` / `7d` / `30d` / `90d`) by
  one dimension: `repo`, `ticket` and `run` are the cost-attribution axes an organisation budgets
  against, and `model` / `agentKind` / `service` / `taskType` slice the same money the other ways.
  `GET /api/v1/usage` answers the budget question and structurally cannot answer this one, since the
  ledger row it aggregates carries no board shape and its window is the current calendar month. The
  long windows are served from the durable `spend_days` rollup, which froze each run's attribution
  while the money was being spent, so a quarterly figure does not move when a service is re-pointed
  at a new repository. `source` and `rolledUpThrough` say which store answered and how far its sweep
  has covered, because a rollup that has never run and a board that spent nothing produce the same
  empty breakdown. There is no `workspace` dimension and no account-wide scope: a workspace-scoped
  key must never learn a sibling board's spend. `rows` is the heaviest `limit` slices (default 100,
  ceiling 500) with `truncated` beside it, because `run` and `ticket` grow with activity rather than
  with a catalog; `totals` aggregates the whole window either way, so a capped answer still reports
  what the board spent and loses only the identity of the tail.

  `GET /api/v1/debug/runs/:runId/llm-export` serves a run's model activity as one self-describing
  bundle, the external counterpart of the app's own export button, for a caller assembling the same
  picture from the overview plus a walk of the call list. It differs from the app's export in the
  half that matters: the rollups are SQL aggregates over every recorded call and do not move with
  `limit`, so a bundle budgeted down to a handful of rows still states what the run actually cost,
  where the internal export folds its numbers from the rows it holds and stops pricing them once
  they are a slice. `truncated` and `order` say that the call rows are a window and which end was
  kept, and `available` says whether the deployment retains LLM telemetry at all, since an unwired
  sink and a run that made no model calls otherwise produce the same document and this one is
  composed to be handed straight to a model.

  The SDK emitters gained the notion of a REQUIRED query parameter, which nothing on the surface had
  until now: the TypeScript client no longer defaults such a query bag to `{}` (a signature promising
  a call the deployment refuses), Python emits it with no default, Go and Java say so on the field
  rather than documenting it as optional, and Java withholds both the no-query call overload and the
  record's empty `none()` factory for such an operation, offering `Query.of(<required>)` instead.
  The MCP and gatekeeper facades refuse a missing required query parameter locally, naming it, the
  way a missing path parameter already was: the reference MCP server forwards a host's arguments
  without validating them against the tool's own input schema, so nothing else was catching it.

  `@cat-factory/gatekeeper-bindings` (breaking, pre-1.0): a binding's `queryParams` is now
  `{ name, required }` records rather than bare names, so a credential-holding front-end can refuse
  what the deployment would refuse instead of forwarding it to collect a 400. Bindings that read
  captured run telemetry carry `telemetrySink`, and the new `TELEMETRY_BINDINGS` export is that list,
  derived from the table. It is what a policy should withhold captured model prompts, tool arguments
  and command output with: all of it sits inside a `read` key's floor, and the hand-typed deny list
  it replaces had already fallen behind the surface, leaving the run LLM export readable by an
  oversight tier that denied every sibling read of the same sink. Generation now fails on a `/debug`
  operation that is not classified either way.

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/sdk@0.26.0

## 0.23.0

### Minor Changes

- 3e9a6af: Public API (`/api/v1`, spec 1.31.0): board provisioning, task relationships, and the evidence a
  judging consumer was missing. All additive.

  Seven new operations: `GET /api/v1/repos` and `POST /api/v1/services` (create a service, optionally
  backed by a repository, so a headless deployment can provision the board it drives),
  `POST /api/v1/tasks/:taskId/dependencies` and `.../dependencies/remove` (declare an ordering
  instead of racing a batch of related tasks against one repository), and
  `GET|POST /api/v1/tasks/:taskId/documents` plus `.../documents/detach` (a task's spec routinely
  arrives after the task does). New fields: `autoStartDependents` on the task patch, `dependsOn` and
  `autoStartDependents` on the task projection, `output` and `data` on a run step (an inline-only
  pipeline's deliverable, previously readable only in the app), `truncated` on a run step,
  `linkedElsewhere` on a repo option, and `scope` on a run artifact.

  Two rules a consumer of the new fields should read. **`GET /api/v1/tasks/:taskId/events` serves a
  run's step deliverables REDUCED**: an SSE frame carries the whole run, so an oversized `output` is
  clipped to a preview and an oversized `data` withheld, with `truncated: true` on the step saying so.
  The point read (`GET /api/v1/tasks/:taskId/run`) serves both whole and is what to read for a
  deliverable. And **`GET /api/v1/repos` distinguishes three states, not two**: `serviceId` names the
  service a repository backs ON THIS BOARD, and `linkedElsewhere` marks one already backing a service
  homed on another board of the account, which `POST /api/v1/services` refuses
  (`reason: repo_service_homed_elsewhere`) rather than answering with a frame id a workspace-scoped
  key could not then use.

  One population change worth reading before upgrading: `GET /api/v1/runs/:runId/artifacts` now
  returns the reference designs attached to the run's TASK alongside the artifacts the run captured,
  each row saying which it is. A consumer counting rows to mean "screenshots this run captured" must
  filter on `scope: "run"`; one comparing a screenshot against the design it was judged against
  finally has both.

  BREAKING for a deployment that registers its own polling gate (internal API, not `/api/v1`): a gate
  declares `pollExhaustion` on its REGISTRATION rather than on the `GateDefinition` its factory
  builds. `HUMAN_WAIT_GATE_KINDS` and `BUILTIN_GATE_KINDS` are removed from
  `@cat-factory/contracts` with them. A declaration left on the definition now fails to typecheck
  rather than being silently ignored. The payoff is that public-API admission reads every gate's own
  declaration, so a deployment's unbounded human-wait gate is no longer admitted for a plain `write`
  key and then parked forever with nothing able to name the surface.

  See [ADR 0050](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0050-public-api-headless-completeness.md).

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/sdk@0.25.0

## 0.22.0

### Minor Changes

- 17687a1: Let a headless provisioner say who a key acts for, and carry that onto the runs the key starts

  `POST /api/v1/keys` accepts an optional `externalIdentity`: an opaque string naming who, on the
  CALLER's side, the key acts for. An integration that mints one key per person (the Cloudflare OS
  gatekeeper of `docs/initiatives/cloudflare-os-gatekeeper.md` is the motivating consumer) could
  already get real per-user attribution, but only by keeping its own keyId-to-person table and
  joining it against every run it read. The field removes that table: the identity is echoed on the
  key resource, on `GET /api/v1/me`, and on both run projections (`publicRun`, `publicJob`) as the
  identity the run was started for.

  It is opaque in the strongest sense: stored verbatim, never parsed, never resolved against a user,
  never an authorization input. What a key may do is still its `scope`; what a run may do is still
  its pinned role and mode. Bounded at 200 characters and refused if it carries control characters,
  because it is echoed onto surfaces that later render it.

  The run's copy is PINNED at admission rather than resolved from the key on read, which is the
  decision worth reviewing. Revoking a per-user key is exactly what an integration does when someone
  leaves, and that must not erase who a finished run was for; pinning also keeps a page of runs from
  becoming a page of credential reads, and matches what the run already does with `initiatedByRole`
  and `mode`. It rides `agent_runs.detail` through the shared mappers, so a retry carries it forward
  (same work, same requester, whoever pressed retry) and the conformance case asserts it survives
  both the store round-trip and the key's revocation on each facade.

  A run's identity is not readable by every key. A key that carries an `externalIdentity` of its own
  sees the value only on the runs started for that identity; a key with none (the provisioner, or
  one a member minted in the app) sees every run's. Without the rule, the one-key-per-person
  deployment this feature is built for would hand each person's key the roster of everyone else, and
  the value is routinely an email. The run projections carry `externalIdentityWithheld` beside the
  value so a withholding is STATED: `null` already means "this run names nobody", and reporting a
  mapping the platform holds as one it never had is the failure the flag exists to prevent.

  Two smaller calls: the identity is never inherited from the provisioning key, since a provisioner
  mints for many identities and naming itself would attribute every run to the integration; and the
  field is offered on the headless mint only, because the session-authed create already records
  `createdByUserId`, an account the platform can resolve.

  The validation splits along what can be PUBLISHED. The shipped `pattern` refuses the C0 controls,
  DEL and the C1 controls, spelled with `\xHH` escapes because that is the one syntax ECMA-262, RE2,
  PCRE, Python and Java all read: the `\uHHHH` spelling this started with is a parse error in RE2 and
  PCRE, so it would have broken the Go client outright rather than rejected a value. U+2028 and
  U+2029 have no portable spelling at all and are refused off the schema, which makes the published
  pattern a necessary condition rather than a sufficient one.

  Additive on the public surface: one optional request field, one nullable field plus its
  withheld flag on the run projections, `null` being the correct answer for every key and run that
  predates it. New nullable `external_identity` column on both stores (D1 0086, Drizzle). OpenAPI
  `info.version` goes to 1.30.0 (1.29.0 was published by the dispatch-diagnostics change while this
  branch was in flight).

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/sdk@0.24.0

## 0.21.0

### Minor Changes

- 01bb6d2: Keep the cause of a failed dispatch and a dead durable driver, instead of discarding it at the
  moment it becomes the only thing anyone wants.

  Three sites had the same shape: the record of a failure was written by the thing that only exists
  once the failure did not happen.

  A run's `diagnostics.lastDispatch` was stamped from the job HANDLE, which `startJob` returns only
  after a container has accepted the job. So the two failure classes the block exists to explain, a
  container that never started and a preflight rejection like "GitHub not connected", were exactly
  the ones that recorded nothing. The block is now opened before the dispatch from what is already
  known and refined afterwards by what only the accepted dispatch resolved, and it carries the
  dispatch's own failure verdict, which the step also holds but loses to the next retry. Inline
  steps stamp one too, naming their backend `inline`: dispatching nowhere is why they stamped
  nothing, and the result was a mixed pipeline reporting whatever container step ran last as where
  the run was when it died.

  The Cloudflare stale-run sweeper answered "the instance was lost, re-create it" for both of its
  swallowed error paths, so a Workflows API outage read as every stale run losing its instance at
  once and re-drove the fleet with no log line to say why. The lookup now returns a probe over four
  states, and the fourth is the point: an instance it could not classify produces no action at all.
  Every action the sweep has is destructive against a run that is actually fine, so one unclassified
  tick costs a run some recovery latency where a guess costs it its container. Two states were also
  reaching the finalize branch by fall-through, Workflows' own `unknown` status and an instance
  finishing its work before pausing, and a terminal instance's own error, destructured by nobody,
  now reaches the stop reason that until now said only that some driver ended without finalizing
  something. An unconfigured workflow binding says so once per isolate rather than reporting the
  kind as healthy forever.

  The local pooled container poll now passes `postMortem`, the same argument the per-run poll always
  did, so a pool member that dies mid-run leaves its exit state and log tail behind rather than the
  bare eviction sentinel.

  Additive on the public API (`info.version` 1.29.0): `diagnostics.lastDispatch` grows an optional
  `failure` object and `executionBackend` one further value. What does change for a consumer is the
  population, since a pure-inline run used to answer no diagnostics at all and now answers a block.
  A new `sweep.run_state_unknown` operational counter reports what the sweeper could not classify,
  which is the one signal that separates a blind sweeper from a healthy one.

### Patch Changes

- Updated dependencies [01bb6d2]
  - @cat-factory/sdk@0.23.0

## 0.20.0

### Minor Changes

- eaab22a: Register several NAMED outbound webhooks per workspace, instead of one that each integration overwrites

  `/api/v1/notification-webhook` was one endpoint per workspace, which made a second integration's
  enrolment a destructive act: registering it replaced whatever was already there, and the only symptom
  was that the previous receiver went quiet. `GET /api/v1/notification-webhooks` plus
  `GET|PUT|DELETE /api/v1/notification-webhooks/:webhookId` are the additive fix. The singular routes
  keep working unchanged and now address the reserved id `default`, which appears in the collection
  like any other entry, so the two surfaces are two views of one store rather than two stores.

  The endpoint id is CALLER-CHOSEN and `PUT` is idempotent by it. That is what the motivating consumer
  needs (a credential-holding front-end, the Cloudflare OS gatekeeper of
  `docs/initiatives/cloudflare-os-gatekeeper.md`): a Worker booting cold writes its own well-known id
  and is enrolled, whether or not it has ever run, with no id table of its own and no
  create-or-discover round trip it might be racing a second instance on. A server-minted id would have
  pushed exactly that state back onto the caller.

  Each endpoint carries its own sealed signing secret and its own three filters, and every rule the
  singular routes enforce holds identically: the `admin` floor, keep-on-omit in every field, the
  write-only secret, the SSRF guard at the write boundary and per redirect hop. Deliveries FAN OUT to
  every subscribed endpoint, concurrently but BOUNDED at six in flight, isolated per endpoint, and
  sharing ONE wall-clock budget. All three are deliberate: the caller awaits the fan-out on a run's
  terminal path, so serial delivery would make enrolling a second integration a latency cost on every
  run; six is the Workers ceiling on simultaneous connections, past which a `fetch` queues invisibly
  while the delivery's clock runs, so an unbounded fan-out reports failures it never attempted; and a
  shared failure path would let one permanently broken receiver mask every sibling's health. An
  endpoint the budget never reached is reported as not attempted rather than as a delivery failure.
  `deliveryId` is unchanged and carries no endpoint segment, because each receiver only ever sees its
  own copy.

  Watch for two things in review. `notification_webhooks` is re-keyed to `(workspace_id, id)` on both
  stores, and neither generator produces a migration that survives existing rows: the D1 side is the
  usual SQLite rebuild, and drizzle-kit's in-place `ALTER` adds `name` as `NOT NULL` with no default,
  so both are hand-healed (add nullable, backfill to `default` / `Default`, then constrain). And the
  per-workspace cap of 10 is a 409 `webhook_limit_reached` that bounds only what CREATES an endpoint,
  since disabling and deleting are the actions an operator at the cap needs. The cap is enforced in
  the STORE, because counting in the service and writing a statement later admits two racing
  enrolments, which is the access pattern this exists for: D1 gets it from one conditional upsert,
  Postgres from a transaction-scoped advisory lock per workspace.

  Additive on the public surface throughout: four new operations, and two new response fields (`id`,
  `name`) on a projection consumers already tolerate unknown members of. OpenAPI `info.version` goes to
  1.25.0 and all four SDK clients, the MCP facade and the gatekeeper bindings pick the operations up
  from the same generation pass.

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/sdk@0.22.0

## 0.19.0

### Minor Changes

- 74ea2bc: Record which revision of a linked design a run actually built against.

  The dispatch-time freshness check already computed the verdict and rendered it into the agent's
  context, where it did its job and vanished with the container. So "did this run build from the
  revision the designer is looking at" was answerable only while the run was live, and only by
  re-probing the source, which by then answers about the revision it is at NOW. On a design under
  active iteration that is exactly the wrong answer: a reviewer cannot tell an implementation that
  MISREAD the design from one that faithfully implemented a revision the designer has since moved
  past, and the two need opposite reactions.

  Each dispatch now records the documents it put in front of its agent, with the verdict it reached
  about each, on `step.contextDocuments`. The PR verification report gains a `Context sources`
  section composed from those records, and the in-app run outcome card gains the matching "Built
  from" list; both reduce the same records the same way, so the page a person reads and the report
  a reviewer reads cannot disagree.

  The write goes through the existing `StepObservations` seam rather than a call at each dispatch
  site, which is what makes it correct: `buildContext` has two callers that resolve a full context
  and start no job (the over-budget exemption probe, and a re-attach to a job a replayed dispatch
  already started), so a source that recovered in between would otherwise overwrite the revision the
  shipped job actually read with one it never saw.

  A moved revision is DERIVED, not recorded. A row carries the last verdict, since that is the state
  the run ended on, and that alone says the run ended current while saying nothing about the coder
  step that finished before the edit landed. So both readers compute `movedDuringRun` from the
  distinct revisions the run's own steps recorded and state it beside the revision rather than folded
  into it.

  Additive on the public surface: `PR_VERIFICATION_REPORT_VERSION` steps to 9, `RUN_OUTCOME_VERSION`
  to 2, and the API to 1.27.0. `GET /api/v1/runs/:runId/outcome` grows a `sources` section beside the
  existing ones and `GET /api/v1/runs/:runId/report` a `context` one; every section a consumer
  already reads is byte-for-byte unchanged, and the four SDKs plus the MCP facade are regenerated
  from the spec.

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/sdk@0.21.0

## 0.18.0

### Minor Changes

- 1c8df4a: Record what the agent's CLI said about the tool servers it loaded, beside what the dispatch decided

  A step's tool-server record has answered one question since it landed: what the platform wired for
  the agent, and what it withheld and why. It cannot answer the other one. A server that passes every
  check, resolves its credential, survives the budget and reaches the container can still fail to come
  up there: a vendor endpoint that 500s, a pinned `npx` package that no longer resolves, a token the
  vendor revoked between dispatch and launch. In every one of those the prompt promises the agent a
  tool that never exists, and the only evidence was the agent mentioning it in prose, if it noticed.

  The claude-code CLI announces its resolved session before its first model call, naming the MCP
  servers it loaded with a status each, plus the flat list of tools it will expose. The harness reads
  that one event and publishes it on the job view; the engine folds it onto the same
  `step.toolServers` record the dispatch wrote, and the step detail renders it on the existing chips.
  Both halves are kept, never merged into one status: the platform withholding a tool and the CLI
  failing to start one are different faults for different people.

  The distinctions this is built out of are the whole point, because each one reads as a healthy
  server if it collapses:

  - **Not observed is not "nothing was loaded."** Codex's CLI publishes no such report, nor does any
    image older than this one, nor a runner pool whose manifest does not map the field. All of them
    leave the record's observed half ABSENT, and the surface then says nothing at all rather than
    accusing every wired server on every deployment one release behind.
  - **Started-with-no-tools is not started.** A server that connects and exposes nothing reaches the
    agent exactly like one that was never wired, and every other signal about it says healthy, so a
    zero tool count gets its own sentence and an uncounted one stays absent.
  - **A status this build cannot map is not a fault.** The CLI's status words are a third party's
    vocabulary; an unrecognised one records as `unknown` and is rendered neutrally, because painting
    it red would send an operator to debug a working integration each time a CLI adds a word.

  Nothing branches on an observation: this is evidence for a person, not a control signal.
  Correspondingly it rides all three poll dispositions rather than just the live one — a job short
  enough to settle between two polls is never seen running, and a job that fails is the one whose
  post-mortem needs this most.

  Runner-pool operators who proxy the executor-harness verbatim gain
  `response.toolServersPath` on the manifest; leaving it unset costs the diagnostic and never
  produces a false one. Ships with runner image 1.95.0.

  On the public surface this is one additive optional field, `observed` on a step's `toolServers` in
  `GET /api/v1/debug/runs/:runId` (spec `1.24.0`), so a consumer written against the previous version
  parses everything it already knew. The one rule it has to carry across is the first distinction
  above: an absent `observed` is "no observation was made", never "the CLI loaded nothing".

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/sdk@0.20.0

## 0.17.0

### Minor Changes

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

### Patch Changes

- 1025674: Publish each `/api/v1` operation's key-scope floor, and ship it as a policy table.

  Every public route contract now declares `minScope` (`withMinScope`), the controllers enforce
  that same field instead of per-route literals, and the OpenAPI document stamps it as
  `x-min-scope` per operation, beside the `x-public-api-scopes` ladder those floors rank against
  (spec 1.23.0, additive). A new generated package,
  `@cat-factory/gatekeeper-bindings` (`sdk/gatekeeper`), projects the whole surface as a
  policy-annotated operation table (scope floors, mutation and transport metadata, invoke thunks
  over `@cat-factory/sdk`) for credential-holding front-ends such as a Cloudflare OS Gatekeeper.
  Its ladder helpers refuse a scope rung the package does not carry rather than ranking it below
  everything, and `resolveConsequence` applies the cautious reading of an unannotated mutation.
  First slice of `docs/initiatives/cloudflare-os-gatekeeper.md`.

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/sdk@0.19.0

## 0.16.1

### Patch Changes

- f7882cf: Stop the run-debug surface and the decision-list description from telling callers things that are
  no longer true.

  The `tool_retry_loop` signal handed the reader `?ok=false`, a tool-call filter replaced by
  `?outcome=error`. An unknown query param is ignored rather than refused, so the link answered with
  the run's WHOLE trajectory and a follower reading it as the failing subset saw every call as a
  failure. Now pinned by a test, which is what was missing when the param was renamed.

  `listPublicRunDecisions` described two decision kinds out of the thirteen the response can carry,
  and claimed `parked` gates the list. It does not: a `follow-ups` entry is answerable while the run
  is still working, so a caller that polls only when `parked` waits for a stop that never comes. The
  regenerated description names every kind and points an empty `decisions` at `unanswerable`. It
  reaches the spec, the four SDK clients and the MCP tool descriptions, which is the surface LLM
  callers read instead of the docs.

- Updated dependencies [f7882cf]
  - @cat-factory/sdk@0.18.1

## 0.16.0

### Minor Changes

- 11a2966: Say which tool servers a step actually had, on the step

  A run whose agent kind declares MCP tool servers could drop any of them for seven different
  reasons, and until now every one of those was stated in two places nobody looks: the agent's own
  system prompt, and one backend `warn` line. From the outside a run that quietly went without its
  issue tracker was indistinguishable from a run whose agent simply chose not to use it, which is the
  question an adopting deployment asks first and the platform could not answer.

  **A dispatch now records what it decided on the step** (`PipelineStep.toolServers`): the servers it
  wired (id, label, transport, and the narrowed `allowedTools` where the definition set one), the ones
  it dropped each with its reason, and the agent kind those lists belong to. The step detail renders
  them as chips, with translated copy per reason in every locale, and hides itself when the record
  holds nothing (a kind that declares no tool servers, which is every step on a deployment that
  registers none).

  The kind is stamped by the engine as it folds, from the same parameter that feeds `step.dispatches`,
  because a step's own kind is routinely not what ran: a `ci` gate escalates to `ci-fixer`, a tester
  hands off to `fixer`, a two-phase coder dispatches twice. Each of those resolves its own
  declarations and overwrites the record, so without the stamp the chips would credit one agent's
  capabilities to another. The step detail names whose they are whenever the two differ.

  **Recorded on the STEP rather than on the agent-context telemetry snapshot**, which is where the
  same facts sat inside an untyped `extras` bag. The snapshot is double-gated behind
  `LLM_RECORD_PROMPTS` and the per-workspace `storeAgentContext`, and pruned on the telemetry
  retention window, so a surface reading it would be blank on any deployment that simply has prompt
  recording off. "Which tools did this step have" is an ordinary question about a run, not an opt-in
  debugging artifact. It also costs no telemetry migration: the run row already carries its steps as
  JSON.

  **Public API (additive, `info.version` 1.21.0):** each step of `GET /api/v1/debug/runs/:runId` now
  carries the same record, so a diagnosing reader can tell "the agent never had the tool" from "the
  agent had it and did not call it", which the tool-call trajectory alone cannot show. The snapshot's
  `extras.toolServers` / `extras.unavailableToolServers` keep being served, deprecated, projected from
  the step's own record so the two cannot disagree; the removal window is in `backend/docs/public-api.md`.

  It is written at dispatch and never re-derived, for the same reason the model and the leased
  subscription token are: the poll site rebuilds the job handle from the step alone, and whether a
  server was servable depended on the resolved harness plus the facade's secret and OAuth resolvers at
  that moment. A workspace that fills in a missing credential an hour later must not make a step that
  ran without the tool read as one that had it. Absent and both-lists-empty stay different states:
  absent is "no container dispatch recorded here", both-empty is "a dispatch ran and its kind declared
  none".

  **The unavailability vocabulary moved to `@cat-factory/contracts`, and kernel's
  `UnavailableToolServer['reason']` is now typed against it.** The SPA cannot see kernel, so leaving
  the union there would have made the run surface's copy a hand-written duplicate of a closed list,
  and a member added on one side only renders as a blank chip. Which member a dispatch picks is still
  decided in kernel. Internal break: the seven reason strings are unchanged, but the type now aliases
  `ToolServerUnavailableReason`.

  **Tool servers and capability credentials also gain their first cross-runtime assertions.** The
  conformance harness could not reach either, because the suite runs a `FakeAgentExecutor` that
  composes no job body, and the values are write-only on every wire. `ConformanceApp.toolServerDispatch()`
  (built by `makeToolServerDispatchProbe` over each facade's OWN container) drives the same
  `resolveToolServers` a dispatch does with the chain that facade actually composed, so a facade that
  wired its per-workspace credential store behind the deployment environment (or not at all) now
  fails a test instead of handing its agents an unauthenticated server. It asserts a stored credential
  reaching the job body under its declared channel, an unstored one dropping the server as
  `missing_secret` in the same resolution (the per-KEY composition rule), and a Pi run dropping
  everything as `harness_unsupported`.

  What this does NOT answer is a server that was wired and whose CLI failed to start it anyway: that
  needs the agent CLI's own startup report, which is a harness change and therefore a runner-image
  bump. It is the remaining half of the tracker's slice 5; the probe already diagnoses the same
  condition interactively.

### Patch Changes

- Updated dependencies [11a2966]
  - @cat-factory/sdk@0.18.0

## 0.15.0

### Minor Changes

- 00bff05: A descriptor-driven form groups under section captions

  The last open gap from the extension-seam report an org build filed against the published packages: a
  reusable operation that collects thirteen fields, every one of which changes what the agents do,
  rendered as one undifferentiated column. `DescriptorFields.vue` walked `fields` in declaration order
  and the vocabulary had no grouping attribute, so the only way to signal structure was to bury it in
  each `label`.

  A field may now carry `section`, the caption its run of fields renders under. It sits on the SHARED
  `descriptorFieldEntries` spread, so both declaring surfaces (a custom task type's per-case form and
  an initiative preset's create form) gain it at once and cannot drift, and the gate-config form the
  pipeline builder renders through the same component gets it for free. It is presentation and nothing
  else: validation, what is frozen on the entity, and the prompt fold are all untouched, so moving a
  field between sections can never change what the platform does with its answer.

  The grouping RULE lives in contracts (`descriptorFieldSections`) rather than in the renderer, because
  two readers depend on it. Visibility is applied BEFORE the runs are cut, which is what makes a
  section whose every field is hidden by `showWhen` render no caption at all (a caption over nothing
  reads as a form that failed to load its own controls) and what keeps a hidden field between two
  fields of one section from splitting its caption in half. Two spellings of one caption fold together
  on case and whitespace, exactly as the task-type picker's category rows do, and the first spelling is
  the one rendered, because a caption is the deployment's own words rather than an id.

  Declaration order is never rearranged, and that is what makes the second reader a boot ERROR
  (`task_type_field_section_interleaved` and its `initiative_preset_` / `gate_` siblings, through the
  same `descriptorFormProblems` checker every declaring surface shares). A section a form can be made to
  caption twice has no honest rendering: the caption prints twice, which reads as a platform fault
  rather than as the declaration it is, and the alternative repair moves a field away from where its
  author wrote it. Refusing the declaration at boot is the only disposition that leaves the renderer
  free of a repair nobody asked for, and it is the bar the surrounding checks already hold registrations
  to (error on what is fully knowable from the registration).

  What that check judges is REACHABILITY, never contiguity in the declared list, because the reduction
  it mirrors applies visibility before it cuts the runs. A branching form is written with its branches
  interleaved (each branch's fields beside the picker they qualify), so a section is reported only on
  finding a concrete state that prints it twice: two of its fields with a differently-captioned field
  between them that can be on screen beside both. For the single-condition vocabulary that is decidable
  pairwise, since the only contradictions available are two `equals` on one key and an `equals` against
  an `includes`. Reading contiguity alone would fail a deployment's boot outright over a form no user
  can break, which is a far worse failure than the duplicate caption it is guarding.

  The third surface reaching that checker is new here: a registered GATE's per-step config form
  rendered through the same component, which had none of these checks behind it, so a gate could boot
  clean and print the duplicate caption the platform calls its own fault (along with unchecked duplicate
  keys, optionless pickers and out-of-options defaults). It declares its form as an option on
  `GateRegistry.register` rather than as a field of a descriptor type, which is why nothing at the call
  site read as a descriptor form; the code prefix is now a named union so the next such surface has to
  be added deliberately.

  Reviewing: the interesting question is that severity, since grouping is cosmetic and every other
  error in that checker is a form that cannot be filled. The renderer's own behaviour for an
  interleaved declaration is still defined and total, because it has to be for a wire descriptor from a
  node whose build differs.

  One rendering constraint is worth knowing before touching the component: the captioned runs render
  FLAT, with each run's caption on the field that opens it, never as a per-run wrapper element. Run
  membership shifts as `showWhen` reveals fields while a field's identity does not, so nesting the
  fields inside a wrapper re-parents them when a boundary moves, and Vue can only do that by remounting
  them. The remounted input is the one being typed into, because typing into the trigger is what moved
  the boundary.

  `section` reaches `/api/v1` through `GET /api/v1/task-types`, so the surface version steps to
  `1.20.0` and the SDKs are regenerated. Additive per ADR 0034: it groups nothing the create call
  validates, so a client that ignores it fills exactly the same bag as before.

  With this the `deployment-extension-seam-gaps` tracker's committed scope is complete, so it converts
  to [ADR 0040](../backend/docs/adr/0040-deployment-extension-seam-reachability.md). The one item that
  does NOT land is the deployment-scoped document source, declined rather than deferred: the account
  tier already serves an org-wide living document, and the boot error added earlier in that initiative
  names that path at the moment a deployment reaches for the wrong one.

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/sdk@0.17.0

## 0.14.0

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
  - @cat-factory/sdk@0.16.0

## 0.13.0

### Minor Changes

- 53cd697: Close three holes in `/api/v1` around a run that stops.

  - **A bug-triage question is now answerable from the ticket it was asked on.** The clarity gate's
    park echo rendered its findings as bare prose, so the ticket-comment reply grammar (which
    addresses a finding by id) could never reach it. Both review subjects now ride one id-carrying
    post path, and a comment naming a clarity finding drives the clarity review through the same
    service methods the app calls.
  - **`decisions: []` no longer means "we cannot say".** The decision list carries `unanswerable[]`,
    naming each wait this surface cannot answer — a human-review gate, a gate the deployment
    registered itself, an interviewer wired nowhere — with where its answer actually lives. It lists
    only waits that are live and genuinely beyond this surface: a finished run names nothing, and a
    wait the same response answers (a deployment gate that exhausted onto an ordinary approval) is
    never reported as one nobody here can answer.
  - **`GET /api/v1/me`** reports what the calling key may do, and **`GET /api/v1/openapi.json`**
    serves the deployment's own spec.

  Internal break: `IssueWritebackProvider.postQuestions` is gone (folded into `postReviewQuestions`,
  which now takes a subject), and `TrackerWebhookService` takes `reviewGateways` per subject in place
  of the single `reviewGateway`.

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/sdk@0.15.0

## 0.12.0

### Minor Changes

- 7f5ed08: Aggregate tool-execution failures: a rollup, a signal and an `?ok=` filter

  A failed tool call was a row nowhere counted. The trajectory sink recorded each one (`ok: false`,
  with what the tool returned), and nothing above it added them up: the run overview reported only how
  many tool calls the run made, no filter narrowed a page to the failures, and no signal was derived
  from them. That is the one class of failure the LLM telemetry beside it structurally cannot see: a
  rejected edit or a non-zero command is a perfectly healthy model call whose result came back bad, so
  a run stuck re-running a broken tool reports a clean model side and an inexplicable death. Finding
  it meant paging the whole trajectory and reading each row's `ok` by eye.

  `AgentToolCallRepository.summarizeByExecution` is now the one GROUP BY, at the `(agentKind, tool)`
  grain, and it REPLACES the bare `countByExecution`: the overview's `sinks.toolCalls.count`, its new
  `toolCalls` rollup and both of that rollup's breakdowns are folds over the same cells, so a count and
  a breakdown that disagree is not a representable state. The grain keeps both halves deliberately,
  because the finding is the CONCENTRATION: one agent kind retrying one tool is a stuck loop, the same
  count scattered over nine tools is an agent exploring, and either axis alone folds that away. Every
  level carries `failureRate` beside its counts (34 of 36 and 34 of 3,600 are the same number and
  opposite diagnoses) and a run that called no tools reports it as `null` rather than a clean 0%, which
  would file "nothing happened" beside "everything worked".

  Two signals ride it, and their severities carry the difference between them. `tool_calls_failed` is
  an `info` reporting the run-wide count with its ratio: a failing tool call is the ordinary shape of
  an agent loop (a test that fails before it is fixed, a `grep` that matches nothing), so as a warning
  it would fire on most healthy runs and cost the severity ordering the thing it is for.
  `tool_retry_loop` is the `warning`, firing only where the failures concentrate on one
  `(agentKind, tool)` cell that is both mostly-failing and has failed enough times to not be a single
  bad command. It selects among the cells that QUALIFY rather than testing the run's most-failed one,
  which is not the same thing: ranking first would hide a fixer wedged 5-for-5 on `apply_patch` behind
  a coder's 6 failures across 100 healthy `bash` calls, silently missing the run the sink exists for.
  `failure_outside_model_calls` now reads the sink before deciding where to send the reader: failing
  tool calls to start at, a recorded loop with none in it (so what is left is the engine), or no
  trajectory at all — which is unrecorded rather than uneventful, and was previously indistinguishable
  from a clean one.

  Public API 1.12.0 → 1.13.0, additive: `?ok=true|false` on `GET /api/v1/debug/runs/:runId/tool-calls`
  (both orders, applied in SQL, because a caller filtering a page itself has already spent that page's
  `limit` on the calls that worked) and the `toolCalls` block on the run overview. The four SDK clients
  and the MCP facade are regenerated. Worth a reviewer's attention: `countByExecution` is gone from the
  kernel port, so all three telemetry stores, the mothership read-through and its bounded-read table
  move together, and the new aggregate is classified `telemetry` in the drift guard rather than routed
  over the persistence RPC.

  No migration, and the aggregate is knowingly costlier than the COUNT it replaces: the existing run
  index served that count without touching the table, while grouping reads `agent_kind`, `tool` and
  `ok` off each row. A covering index would buy that back and is the wrong trade here: this sink is
  append-hot (a row per tool call of every run) and the aggregate runs once per debug overview, so a
  fifth index would tax the hot path for the rare read. Either way the scan is bounded by one run's
  rows.

### Patch Changes

- Updated dependencies [7f5ed08]
  - @cat-factory/sdk@0.14.0

## 0.11.0

### Minor Changes

- bac6776: Follow-up triage and interview-gate decisions over the public API

  `/api/v1` answered every park a pipeline can carry except three. Two of those were surfaces nobody
  had built (`docs/initiatives/public-api-additions.md` found them while landing the rest, and left
  them unranked); this lands both, leaving `human-review` as the only ❌ row, and that one is
  unanswerable by construction, since its answer is a person approving the pull request on the VCS
  host rather than an API call.

  **Follow-up triage** (`…/decisions/follow-ups/items/:itemId/{file,send-back,answer,dismiss}`) is the
  first decision here that is not a park: the Coder streams forward-looking items while it is still
  running, so the projection lists them whenever any item is `pending` rather than once the run is
  `blocked`. An integration that triages as they arrive never sees the run stop at all.

  **Interview gates** (`…/decisions/interview/{answer,continue,proceed}`) are ONE route set for every
  interviewer, keyed by run alone: which interviewer is asking is a property of the parked step, so
  the server resolves it and the decision's `stepKind` reports it. That needed a new seam: the two
  built-in gates store their Q&A on entities belonging to their own features, so `InterviewGateKind`
  now projects a kind-neutral `InterviewView` (the questions and the round budget, deliberately not
  the brief each one converges on), reached through the narrow `InterviewGate` interface rather than
  the entity-generic controller. A third interviewer implements `view` and needs no route, projection
  or decision kind of its own; it does still wire its controller, since an interview gate is built
  from its feature's own store rather than constructed by a registry. Registered-but-unwired is a
  real state and reports as one: admission counts the park (it reads the trait), the projection lists
  nothing, and the routes 503 naming the kind. Its question `status` is derived, not stored: one gate
  keeps an explicit `dismissed` marker and the other has only the answer, so one derivation is what
  lets a caller read both through one shape.

  Worth reviewing, because it is a behaviour change rather than an addition: **an interview gate is now
  a park surface the start rule can see**, read off the step kind's `interview-gate` trait. That closes
  a hole in the wrong direction: an interviewer is an INLINE step, so a pipeline built out of
  interview steps satisfied the inline-only rule and was reported `headlessStartable` while every run
  of it stopped on the first batch of questions. No shipped preset changes hands (`pl_initiative` and
  `pl_document` both carry a later human gate and were already admitted as parking on it); what
  changes is that the refusal names the interview, and that a pipeline whose only park is the
  interview is finally refused for a `write` key.

  **Follow-up triage is deliberately NOT added to that rule**, and the trade-off is stated in
  `backend/docs/public-api.md` rather than left to be discovered: the companion is on by default on
  every Coder step, so counting it would make `decide` mandatory for all board work that builds
  anything and take board starts away from every live `write` key at once. The park now has an answer
  path, so a run that stops there is recoverable with a `decide` key instead of being app-only.

  Also noted rather than fixed, in the same three places a reader would look: an unbounded human-wait
  GATE a deployment registers itself is invisible to the start rule, because a gate declares
  `pollExhaustion` on the object its factory builds from an engine context and nothing can read that
  at HTTP request time. Such a pipeline is admitted for a `write` key and then parks with nothing on
  this surface able to name it. The tracker ranks the fix (declare `pollExhaustion` at registration
  and read the registry, which also retires the hand-kept `HUMAN_WAIT_GATE_KINDS` constant) as its own
  slice, since it changes the `GateRegistry` seam.

  Public API surface version `1.10.0`, additive: two new decision kinds (`follow-ups`, `interview`) and
  seven endpoints, all `decide`-scoped.

### Patch Changes

- Updated dependencies [bac6776]
  - @cat-factory/sdk@0.13.0

## 0.10.0

### Minor Changes

- e7867db: Run evidence and key provisioning on `/api/v1`, and a trajectory link on the PR report

  Everything the platform captured about a run was reachable only from a browser session. A consumer
  whose job is to JUDGE a run (a trial harness deciding whether to accept a change, an evaluation
  pipeline scoring a fleet) could scrape the fenced JSON block out of a pull-request body and read
  `/api/v1/debug/*`, and that was all: the captured screenshots were unreachable, and a run with no
  pull request (a headless job, a run that failed before it pushed) had no evidence surface at all.
  Getting a key at all still needed a browser.

  Three additions, all `/api/v1`:

  - **`GET /runs/:runId/report`** serves the engine's verification report: the SAME bundle it writes
    onto the pull request, composed on read by the same code, so the two can never disagree about
    what a run proved. It answers for runs that never opened a pull request, and it does not consult
    the `publishPrVerificationReport` opt-out, which is a statement about writing onto someone else's
    pull request rather than about reading your own evidence back.
  - **`GET /runs/:runId/artifacts`** and **`GET /artifacts/:artifactId/blob`** list a run's captured
    artifacts and stream their bytes, at `read` scope, with the content type clamped to the image
    allow-list exactly as the session-authed route does. An account with no blob backend gets a 503,
    never an empty list. The blob operation declares every media type it can answer with (the image
    allow-list plus an `application/octet-stream` fallback) rather than one standing in for the rest,
    so a client generated from the spec can switch on the response honestly.
  - **`GET|POST|DELETE /keys`** provisions keys headlessly at `admin` scope. Two enforced bounds make
    that safe: a key minted here can never reach the `admin` rung minting requires (so the chain is
    one link long), and revoking a key now revokes every key it minted, on this surface and in the
    app alike. Otherwise a leaked provisioning key would survive its own revocation.

  Refusals across the three evidence reads carry `error.details.reason`, so causes needing different
  reactions stay apart: `run_not_found`, `artifact_not_found`, `artifact_blob_missing` (the row
  outlived its bytes, which is a storage fault rather than a bad request) and
  `binary_artifact_storage_unconfigured`.

  The **PR verification report** gained the links a machine needs: `observability.trajectoryUrl` (the
  run's tool calls in the order the agents made them) and `observability.reportUrl` (this report,
  served live), both rendered in the prose as well as carried in the JSON, and both built from the
  deployment's public BACKEND url. Report payload version 5 → 6.

  Worth knowing when upgrading:

  - **The report shape is now part of the STABLE public surface.** It is served verbatim on
    `/api/v1`, so from here it grows additively and never renames or retypes in place.
  - **A new `created_by_key_id` column** on `public_api_keys` (D1 migration `0081`, its Drizzle
    mirror, plus an index), which carries the provenance of a headless mint and is what the
    revocation cascade follows. The app's key panel renders it, so a provisioned key no longer reads
    as one whose minter is unknown.
  - **The SDK chain learned binary responses.** An operation whose success body was neither JSON nor
    SSE previously generated as a method that returned NOTHING; the IR now marks it `binary`, each
    of the four transports hands the bytes back in its own idiom, and an unrecognised media type
    fails generation instead of silently discarding a body.
  - **A container wiring bug is fixed on both facades**: the HTTP layer's binary-artifact store
    resolver was built from account settings while the engine's came from `CoreDependencies`, so an
    override reached one side of the app and not the other.

### Patch Changes

- Updated dependencies [e7867db]
  - @cat-factory/sdk@0.12.0

## 0.9.0

### Minor Changes

- c5a1a16: Per-step gate configuration: approver policies, approval quorums, and gate-declared settings

  `Pipeline.gates: boolean[]` said a step paused for "a human" and nothing else. There was nowhere to
  say which humans, how many of them, or what a registered gate's own knobs should be for this
  particular step — the built-in gates read their attempt budgets and time windows off the
  workspace-wide merge preset, and a deployment's own gate had nowhere to put its parameters at all.

  A step now carries `stepOptions.gateConfig` (the extensible per-step bag, so no column and no
  migration on either runtime), with two halves. The platform owns `approvers` and `minApprovals`: who
  may resolve the human gate, and how many DISTINCT people must, both snapshotted onto the approval
  when the gate is raised so an edit to the pipeline cannot move the bar under the people already
  counted toward it. The GATE owns `fields`, declared on its registration
  (`register(kind, factory, { configFields })`) as descriptor fields — one declaration driving the
  save-time validation, the run-start re-validation and the authoring form the builder renders, so a
  registered gate needs no frontend change to become configurable. The built-ins declare their own
  (`maxAttempts`, `watchWindowMinutes`, `graceMinutes`) instead of the engine hard-coding them.

  Behaviour changes worth reviewing. The approver policy governs all three resolutions, not just
  approve: a gate the wrong person can reject is not a gate. A workspace admin always passes a policy
  (they can cancel the run or edit the pipeline anyway, and refusing them would deadlock a gate whose
  named approvers have left). A machine key or an auth-disabled caller is refused by any policy — a
  shared credential is not one of the people a policy named — which also means a quorum above one
  cannot be met on a deployment running with auth off, since counting distinct approvals needs
  identities that deployment does not have. All of this is additive: a gate with no config behaves
  byte-for-byte as it did.

  A quorum votes on ONE artifact, so only the approval that CLEARS the gate may carry a `proposal`
  edit. An edit on an earlier approval is refused (`proposal_not_editable_until_quorum`) rather than
  silently rewriting the text under the people already counted toward the bar; the SPA withholds the
  affordance and says why. Both raise sites for the human gate now go through one `buildStepApproval`
  builder, so a gated COMPANION step honours the policy and quorum its step configured.

  Public API (`/api/v1`, surface version now `1.9.0`, additive): the `approval-gate` decision projects
  `requiredApprovals` and `recordedApprovals`, because a quorum makes `approve` legitimately not
  advance the run and without the tally a caller could not tell that from a failed call.

  Internal break, per the pre-1.0 rule: `ExecutionService.approveStep` / `requestStepChanges` /
  `rejectStep` now require a `GateActor`. Required rather than optional so an entry point that forgets
  to supply the acting identity fails to typecheck, instead of silently resolving a gate that names
  its approvers as though it named nobody.

  Design record: `backend/docs/adr/0038-per-step-gate-config.md` (supersedes the
  `extensible-custom-gate-config` initiative tracker, removed).

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/sdk@0.11.0

## 0.8.0

### Minor Changes

- 289b3de: Disposer step, and a teardown that is proved rather than assumed

  A run's PR asserts a three-leg proof — the test environment came up, evidence was captured against
  it, and it was torn down again — and the third leg had two problems.

  Nothing closed it inside the run. Teardown happened only on the TTL sweep, a manual Destroy, a
  `human-test` resolution, or a re-provision supersede. The sweep fires long after the last step
  settled, so the report was published saying the environment was still live and corrected later
  through a back-channel, and only where a provisioning log is retained. TTL is a backstop; it
  cannot be a proof.

  Worse, the teardowns that did happen were never checked. Success was recorded whenever
  `provider.teardown()` returned without throwing, which is a different fact from the environment
  being gone: `HttpEnvironmentProvider` reports `torn_down` unconditionally, so a manifest with no
  `teardown:` request destroys nothing and still reports success, and a Kubernetes namespace
  `DELETE` returns while the namespace is still `Terminating`. The section could therefore render a
  green tick about an environment that was still running and still billing.

  So teardown now has two halves. A new optional `EnvironmentProvider.confirmTeardown` re-probes
  after the destroy call and the result is recorded as its own `teardown-verify` log row; only a
  probe that positively finds the environment gone counts as a reclaim. This is deliberately not
  folded into `status()`, whose implementations are all written to describe a LIVE environment — the
  generic provider with no `status:` template answers `ready` forever, and the compose mapping reads
  an empty project as `failed`, both of which are exactly inverted as teardown verdicts. The four
  outcomes stay distinct because each needs a different person: confirmed, still standing (the
  teardown was a no-op — fix the config and reclaim by hand), unverifiable (the provider has no way
  to tell you, and no retry will change that), and unconfirmed (transient; the next sweep re-probes).

  And a new `disposer` step, the deployer's counterpart, reclaims what the run provisioned wherever
  its author places it — after the automated tester, or after a human has finished with the live
  URL. It never fails the run: it commonly sits after `merger`, so an un-reclaimed environment is a
  recorded warning and an operator's job, not a failed pipeline. It is palette-addable rather than
  seeded into the built-in pipelines; seeding it is a follow-up that needs its own version bumps.

  Crucially it reclaims BY IDENTITY, not by re-resolving. The deployer now records which environment
  each frame got (`deployEnvs[frame].environmentId`) and the disposer tears down exactly that one.
  Re-resolving from `(block, frame)` reads correct and is not: that lookup falls back to the block's
  frame-less row, which is where the manual and `human-test` environments live, so a disposer running
  after a supersede, an operator's Destroy or a TTL sweep on a long run would have destroyed an
  environment the run never provisioned and recorded it as the frame's clean reclaim.

  The provisioning-log operation vocabulary is part of `/api/v1`, so `teardown-verify` is an
  ADDITIVE public-API change: the OpenAPI surface goes to 1.9.0 and the four SDK clients plus the
  MCP facade are regenerated from it. The SDKs tolerate unknown enum values by design, so an older
  client decodes the new row as a plain string rather than failing.

  One ordering detail is worth understanding, because getting it wrong made the whole feature
  unreachable while every unit test still passed. The hook that re-publishes the PR report on a
  teardown fires from the same place that writes the log rows, and its consumer RE-READS that log.
  Fired between the teardown row and the confirmation row it sees a teardown nothing has verified,
  publishes `unconfirmed`, and — being the last edge on an already-settled run — is never corrected.
  Both writes and the notification therefore happen in one method that takes the confirmation, and
  the regression test asserts the row count at hook time rather than the final rows, since only that
  can see the order.

  Two things to watch when reviewing. The report gains a `teardown: 'unconfirmed'` state, and
  because a missing verify row is treated as "not proved" rather than as a pass, runs whose
  teardowns predate this change will report unconfirmed rather than confirmed. That is a correction,
  but a visible one. And the confirmation applies to every teardown path, not just the new step, so
  a deployment whose provider config makes teardown a silent no-op will start being told so.

### Patch Changes

- Updated dependencies [289b3de]
  - @cat-factory/sdk@0.10.0

## 0.7.0

### Minor Changes

- 99be350: Public API: answer every remaining park a run can stop on

  `/api/v1/runs/:runId/decisions` could answer four parks; a `decide` key could START many more than
  that, so a caller could put a run into a state only the app could get it out of. Twenty-four
  additive endpoints close the gap: the generic approval gate (approve / request-changes / reject,
  plus `resolve-exceeded` for a companion at its rework cap), agent-raised decisions, the
  clarity-review and both brainstorm loops, PR deep-review curation, and the two human-verdict gates.
  The decision list gained seven kinds alongside them, and the OpenAPI surface version is now `1.7.0`.

  Of the parks a pipeline can carry, only `human-review` is now unanswerable, and by construction
  rather than omission: its answer is a person approving the pull request on the VCS host. Two park
  surfaces the original investigation missed (follow-up triage, interview gates) are recorded in
  `docs/initiatives/public-api-additions.md` as unbuilt and are NOT advertised as answerable.

  Behaviour change worth reviewing: a park that rides the engine's generic `step.approval` but is
  owned by a dedicated surface (a review gate, a fork choice, a human-verdict gate, follow-up triage,
  an interview) is reported as its own kind, never as `approval-gate`, because the engine refuses the
  generic verbs on those. `StepDecisionController`'s refusal and the public projection now read one
  shared classifier so the two cannot disagree.

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/sdk@0.9.0

## 0.6.0

### Minor Changes

- 8511a90: MCP maturation slice 3: the public API is now served over MCP from the deployment itself.

  `POST /api/v1/mcp` speaks Model Context Protocol behind the same public-API key auth as every other
  `/api/v1` route, so an MCP host reaches a deployment with a URL and a key and nothing installed. That
  is the point of the slice: until now "drive cat-factory from a model" meant an npm dependency, a local
  process per host and a long-lived key in the host's plaintext config, which rules out claude.ai, hosted
  agents and anything that cannot spawn a subprocess. The stdio binary stays, for hosts with no HTTP MCP
  support and for use against a deployment you do not run.

  It is the SAME server behind both paths: the endpoint mounts `@cat-factory/mcp-server`'s
  `handleMcpHttpRequest`, so the generated tool table, the instructions and the result rendering are the
  same bytes, and every tool call is one `/api/v1` request under the CALLER's own forwarded key. Nothing
  is reachable over MCP that the same key could not reach with `curl`. Behaviour worth knowing about:
  the key's SCOPE decides the tool list (a `read`-scoped key is served only the tools that change
  nothing, and the instructions say a wider key would expose the rest, so a model asks for one instead of
  reporting the platform as unable to write); above `read` the whole table is listed and each tool's own
  rung is enforced by the endpoint it calls, arriving as tool content the model can act on; and the
  endpoint is stateless with JSON responses, so `GET` and `DELETE` are answered `405`.

  Two things a caller and an operator each notice. A tool's `/api/v1` call INHERITS the MCP request's
  `X-Request-Id`, so the tool call and the API call it caused share one correlation id and a log holding
  both lines can be joined on it (supply your own on the MCP request and both halves land under it).
  And `Mcp-Protocol-Version` joins the shared CORS allow-list both facades serve, without which a
  cross-origin BROWSER host would negotiate successfully and then have every later call dropped by the
  browser, since a Streamable HTTP client sends that header on every request after `initialize` and on
  none before it.

  The endpoint joins the PUBLIC surface under the stability contract from this release. It is
  deliberately absent from `docs/openapi.json`: a JSON-RPC endpoint has no operation shape to describe,
  and describing it would mint an SDK method in four languages for a protocol none of those clients
  speaks. `backend/docs/public-api.md` carries the obligation instead, which also means the endpoint's
  arrival does not move the spec's `info.version`: that version tracks the described surface.

  `@cat-factory/mcp-server` gains `handleMcpHttpRequest` / `refuseMcpMethod`, so any deployment of this
  API can mount the endpoint, plus a `readOnlyReason` option that lets the instructions name the right
  fix for a narrowed tool list.

  INTERNAL BREAK in `@cat-factory/mcp-server`: `optionsFromEnv(env, deps)` now REQUIRES
  `deps.readSecretFile` rather than defaulting to `readFileSync`, and `ToolSelection.writeToolsHidden` is
  a `ReadOnlyReason | null` rather than a boolean. The first is what keeps every module the hosted
  endpoint reaches free of Node built-ins: those modules are bundled into deployments' Workers, where
  `node:fs` does not resolve at build time, so the default was a Worker that fails to BUILD for the sake
  of a code path it can never take. `bin.ts` supplies the reader.

### Patch Changes

- @cat-factory/sdk@0.8.0

## 0.5.0

### Minor Changes

- cec0c3e: Attach spec-sized requirements documents when creating a task over the public API.

  `/api/v1` had no way to give a run a specification. `description` caps at 2,000 characters because
  it is a task's own framing, echoed into every prompt; the 50,000-character `POST /jobs` brief drives
  inline pipelines that never touch a repository; and the app's own attach-a-document flow is
  session-authed. A headless caller holding a PRD could only paste a truncated version of it into a
  field and hope. `POST /api/v1/services/:serviceId/tasks` now takes an ordered `documents` list, each
  entry either NAMING a page in a connected document source (imported and attached, as `ticket`
  already does for a tracker issue) or CARRYING the text itself. The full body reaches agents exactly
  as a document a human attached does: materialised under `.cat-context/` for a container agent,
  folded into the prompt for an inline one.

  Carrying the text needed a document with no source behind it, so `DocumentOrigin` (`DocumentSourceKind`
  plus `upload`) is now what a stored row and its block/role links are keyed by, while everything a
  provider does stays typed against the narrow union. That keeps the missing `upload` provider a
  compile error rather than an `undefined` at whichever call site reaches for it first. An uploaded
  document has no origin URL, and every reader now renders that absence as nothing rather than as
  `Title ()` or a bare `Source:` line.

  One fix rode along, found by the cross-runtime assertion for the new origin rather than by
  reasoning: `urlMatchCandidates` used to hand back `['', '/']` for an empty needle, so `getByUrl`
  would match every row whose stored `url` is empty. Nothing produced such a row before uploads, and
  no caller passes an empty URL today, but "a lookup for nothing resolves to an arbitrary uploaded
  document, which the caller then hands an agent as the page a description pointed at" is not a trap
  to leave armed. It now returns null, and the four repositories that call it answer "no match".

  A document is now attached to at most ONE block, enforced where the link is written rather than at
  the new endpoint. `linkedBlockId` is a single column, so attaching a document another task already
  holds MOVED the link instead of copying it: the earlier task silently lost a document it was created
  with, and nothing in its next run reported the absence. That was reachable from the app's own
  picker too, which offers already-attached documents for re-use. `linkToBlock` now refuses with
  `document_already_linked` and the holder's id, the same rule and shape as one-task-per-ticket, with
  translated SPA copy. Two things keep it from wedging anything: a link naming a DELETED block is not
  a holder (so the guard heals rows left by past deletes), and `removeBlock` now detaches a doomed
  block's documents through the removal cascade, so new ones are not made. Only the link goes; the
  document survives its task.

  Attaching a list is one unit of work rather than a loop: `linkManyToBlock` asserts the block once,
  resolves the whole list through a new batched `DocumentRepository.listByRefs` and writes the links
  through a new `linkBlockMany` (both mirrored D1 ⇄ Drizzle, with cross-runtime assertions, plus
  `detachBlocks` for the cascade). The point method in a loop was three round-trips per document, ten
  of which re-read the same block.

  Worth watching in review: the creation is all-or-nothing. Everything refusable (an unconfigured
  source, an unparseable ref, a page the provider will not serve, an upload that renders to no
  readable text, a document another task holds) is refused before the board changes, and an
  attachment that fails after the task exists takes the task back off the board, because a task
  silently missing part of its spec is the failure this whole surface exists to prevent. Two ordering
  details carry that: uploads are written only after the whole list resolves (an import is idempotent
  on its ref, but every upload mints an id, so an eager write would leave one orphan per retry), and
  the rollback detaches by BLOCK rather than by the refs it resolved (a rollback can be running
  because one of those refs belongs to another task, and clearing it by ref would commit the very
  loss the guard just refused). The attach runs before the ticket claim so that rollback can never
  orphan a claimed ticket. Naming `documents` does not work in mothership mode yet, for the same
  reason `ticket` does not: the document write surface is still `pending` on the persistence
  allow-list, which the new `linkBlockMany`/`detachBlocks` join rather than widen.

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/sdk@0.8.0

## 0.4.0

### Minor Changes

- 8cbf1a7: Manage the outbound notification webhook over `/api/v1`, so the whole integration surface is
  headless.

  `GET|PUT|DELETE /api/v1/notification-webhook` (`admin` scope) register, read and remove the one
  HTTPS endpoint a workspace pushes its notifications, run-lifecycle events and platform-health
  alerts to. Until now that endpoint could only be registered over the session-authed
  `/workspaces/:ws/notification-webhook`, so a deployment driven entirely by API keys had to put a
  human in a browser to switch on the very channel that exists because there is no browser: the
  delivery contract was headless and its enrolment was not.

  The routes delegate to the same `NotificationWebhookService` the session controller calls, so the
  SSRF guard on the endpoint, the keep-on-omit rule for every field and the one-row-per-workspace
  invariant are identical whichever surface writes. The signing secret stays write-only: `PUT`
  accepts one and the read reports only `hasSecret`, so an `admin` key can rotate it and can never
  learn the stored one.

  `PUT`'s `url` becomes optional, on both surfaces, so keep-on-omit is uniform across every field
  rather than every field but one. A mandatory re-send made the routine edit (subscribe to a family)
  carry a value the caller never meant to change, and a client re-sending a URL it cached before
  someone else rotated the receiver would silently redirect the workspace's deliveries back to the
  old endpoint while appearing to add a subscription. `url` is still required on the first `PUT`
  against a workspace with nothing registered, refused with `details.reason: "webhook_url_required"`.
  Relaxing a required field is additive, so no live caller changes.

  Additive on `/api/v1` (OpenAPI `info.version` 1.5.0; main took 1.4.0 for its own additive change
  while this branch was open). The four SDK clients gain a `webhook` resource
  (`get` / `set` / `delete`) and the MCP facade the matching `webhook_*` tools.

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/sdk@0.7.0

## 0.3.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- Updated dependencies [1f14793]
  - @cat-factory/sdk@0.6.1

## 0.3.0

### Minor Changes

- a8acd48: Bring the published MCP server under the repo's publish guards and give it the protocol depth the
  generator already had the data for.

  The tool table now declares an `outputSchema` for every operation that answers with a JSON object and
  returns `structuredContent` beside the text, so a host or agent framework can consume a result without
  re-parsing prose. Those schemas are rendered deliberately loosely (no `required`, no `enum`, no closed
  `anyOf`, no bounds, and for a union not even `type`): a caller's MCP client validates against them and
  `/api/v1` is additive forever, so anything stricter would let an older copy of this package reject a
  newer deployment's honest answer. `destructiveHint` / `idempotentHint` are now set on the operations whose consequence is real
  money or a merged pull request, and left unset elsewhere so the protocol's cautious defaults stand.

  Two behaviour changes to know about:

  - **A result over `CAT_FACTORY_MCP_MAX_RESULT_CHARS` is now refused rather than truncated**, with a
    message naming the size, the limit and the way out (`limit` / `cursor` / `offset`, or a bigger cap).
    Half an object cannot satisfy the output schema it was cut out of, and the old `[TRUNCATED]` prefix
    spent the whole cap delivering the instruction to narrow instead of reading on.
  - **Results are compact JSON**, not two-space indented.

  New configuration: `CAT_FACTORY_API_KEY_FILE` reads the key from a file instead of the host's
  plaintext config (setting both is refused, not resolved by precedence), and
  `CAT_FACTORY_MCP_TOOLS` / `CAT_FACTORY_MCP_EXCLUDE_TOOLS` filter per tool beside the existing group
  filter, so withholding the PR-merging `notifications_act` no longer costs the whole inbox group. Every
  filter is stated in the server's instructions, and a combination that would expose no tools at all
  fails at startup.

## 0.2.1

### Patch Changes

- Updated dependencies [10e0341]
  - @cat-factory/sdk@0.6.0

## 0.2.0

### Minor Changes

- 43fd5c0: Add `@cat-factory/mcp-server`: a Model Context Protocol facade over the public API, so an MCP host
  can drive a workspace directly (plan work on the board, start and watch runs, answer parked
  decisions, read a run's telemetry).

  It is a facade rather than a fifth client. The tool table is rendered by `pnpm gen:sdk` from the
  same `docs/openapi.json` the four SDKs are generated from, and every tool is one call on
  `@cat-factory/sdk` — so it cannot drift from the surface it exposes, and it re-implements none of
  the SDK's auth, retry, error, pagination or encoding behaviour. `pnpm check:sdk` covers it.

  Every operation is a tool except the two SSE endpoints: a tool call returns one result over no
  streaming channel, and a bounded "wait for the run" tool would be a timeout dressed up as an
  answer, since a parked run waits for a human indefinitely by design. The server names both
  omissions, and their alternatives, in its instructions; generation fails on a new streaming
  operation nobody has classified.

### Patch Changes

- @cat-factory/sdk@0.5.0
