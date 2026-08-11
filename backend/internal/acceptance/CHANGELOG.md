# @cat-factory/acceptance

## 0.1.4

### Patch Changes

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

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/sdk@0.36.0
  - @cat-factory/cli@0.12.0

## 0.1.3

### Patch Changes

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

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/sdk@0.35.0
  - @cat-factory/cli@0.12.0

## 0.1.2

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.34.0

## 0.1.1

### Patch Changes

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

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/sdk@0.34.0
  - @cat-factory/cli@0.12.0

## 0.1.0

### Minor Changes

- c0412e9: The acceptance suite now ADOPTS two repositories the operator created instead of bootstrapping
  them, and ships a `configure` command that assembles its `.env`.

  Bootstrapping was the one prerequisite no configuration could satisfy: a PAT connection reports
  `canCreateRepos: false` for every workspace and the App creation path is org-scoped, so on the
  deployment shape the suite's own README offers first, spec 01 could not run at all. It now backs a
  board service with each named repository (`POST /api/v1/services` already takes a `repoId`) and
  scaffolds both through `pl_build` from the same briefs, which also makes an interrupted scaffold
  resume the way an interrupted feature run does. `vcs-connection` stops asking for repository
  creation, `target-repos` gates on both repositories being visible AND adoptable, and a new
  `model-preset` check joins the pinned preset against the model catalog so an undispatchable preset
  is named as one rather than found at the first dispatch. Every task the suite files pins
  `ACCEPTANCE_MODEL_PRESET`, so a pass runs on the model it says it ran on.

  Adoptable is the stricter half of that gate, and it reads `linkedElsewhere` rather than only
  `serviceId`: a whole-repo service homed on another board of the account has no id a
  workspace-scoped surface can return, so the repository row answers `serviceId: null` with the flag
  set, and `POST /api/v1/services` refuses it. An existing link on this board is compared against the
  LEDGER's own service ids, so a resumed pass holding one of the two services cannot silently adopt a
  colleague's other one. The two repository blockers, a monorepo and a foreign home, are refused
  identically by the gate and by the adopt itself.

  `pnpm --filter @cat-factory/acceptance run configure` resolves what the deployment and the
  kubeconfig already know (workspace, connected account, preset library, apiserver, ServiceAccount
  token), asks for the API token and the two repository names, and opens each repository's creation
  page prefilled. It never overwrites a value without naming it and prints neither token.

  `@cat-factory/cli` gains four exports (`readApiServerCommand`, `readTokenCommand`, `decodeToken`,
  `normalizeApiServerUrl`) so the new command asks a kubeconfig the same questions `cat-factory k3s`
  does, and normalises the answer the same way: k3d writes the undialable wildcard bind address
  `https://0.0.0.0:6443` into a kubeconfig, so the read and its rewrite travel together.

  Internal break, as pre-1.0 internals may: a ledger from an earlier pass is not read for its
  `bootstrapJobs`, so a pass interrupted mid-bootstrap under the old shape starts fresh rather than
  re-attaching to a job.

### Patch Changes

- Updated dependencies [c0412e9]
  - @cat-factory/cli@0.12.0

## 0.0.6

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/sdk@0.33.0

## 0.0.5

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/sdk@0.32.0

## 0.0.4

### Patch Changes

- f6a1a87: Read the acceptance suite's configuration from a `.env` beside its vitest config. The file was
  already gitignored and referenced, but nothing loaded it, so a fully configured `.env` still
  refused with every variable reported as missing. A variable exported in the shell wins over the
  file, so a one-off `ACCEPTANCE_RUN_ID=latest` still resumes.

## 0.0.3

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/sdk@0.32.0

## 0.0.2

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/sdk@0.31.0

## 0.0.1

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/sdk@0.31.0
