# @cat-factory/caching

## 0.10.15

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/kernel@0.145.0

## 0.10.14

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/kernel@0.144.0

## 0.10.13

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/kernel@0.143.0

## 0.10.12

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.10.11

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.10.10

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.10.9

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0

## 0.10.8

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.10.7

### Patch Changes

- @cat-factory/kernel@0.139.2

## 0.10.6

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/kernel@0.139.1

## 0.10.5

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/kernel@0.139.0

## 0.10.4

### Patch Changes

- @cat-factory/kernel@0.138.1

## 0.10.3

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/kernel@0.138.0

## 0.10.2

### Patch Changes

- @cat-factory/kernel@0.137.1

## 0.10.1

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.10.0

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
  - @cat-factory/kernel@0.136.0

## 0.9.5

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0

## 0.9.4

### Patch Changes

- @cat-factory/kernel@0.134.1

## 0.9.3

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/kernel@0.134.0

## 0.9.2

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0

## 0.9.1

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/kernel@0.132.0

## 0.9.0

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

## 0.8.8

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/kernel@0.130.0

## 0.8.7

### Patch Changes

- @cat-factory/kernel@0.129.2

## 0.8.6

### Patch Changes

- 6108525: perf(engine): resolve the agent-context service frame once, and cache the merge-preset read

  - `AgentContextBuilder` walks a block's ancestry to its owning service frame a SINGLE time
    per dispatch (threaded into the environment / service-config / frontend / fragment
    resolvers) and fans the mutually-independent context resolutions out in one `Promise.all`
    wave, instead of re-walking frame→module→task once per resolver and awaiting each in turn
    (performance initiative item 13).
  - `resolveRiskPolicy` reads a task's merge-threshold preset through a new `riskPolicy`
    AppCaches slice — the slow-moving admin config was re-read on every gate evaluation.
    `RiskPolicyService` invalidates the workspace group on every preset write (create / update /
    remove / reseed / first-use seed); pass-through on the Worker's isolate-safe profile
    (performance initiative item 23).

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.8.5

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0

## 0.8.4

### Patch Changes

- @cat-factory/kernel@0.128.1

## 0.8.3

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0

## 0.8.2

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/kernel@0.127.0

## 0.8.1

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/kernel@0.126.0

## 0.8.0

### Minor Changes

- 5fa0a8e: perf(github): fix the slow add-service repo picker search on the local (workspace-PAT) path

  The "add service from repo" typeahead stalled for seconds per keystroke when local mode's
  `GITHUB_PAT` backed the picker: `PatGitHubClient.searchInstallationRepos` re-walked the
  PAT's entire `GET /user/repos` set — up to 20 SEQUENTIAL pages — on every search request,
  with nothing cached (the counterpart viewer-PAT branch was already fixed, but the
  workspace-credential branch kept its own older serial walk).

  - `PatGitHubClient.listInstallationRepos` now delegates to the shared
    `FetchGitHubClient.listReposForToken` walk (page 1 reveals the page count via
    `Link: rel="last"`, the remaining pages fetch concurrently — ~2 round-trips instead of
    up to 20 serial ones) and re-stamps the rows as workspace-wide (`linkedVia: 'app'`).
    Note the enumeration cap is now the shared walk's 10 pages (1000 repos, flagged
    `truncated`) instead of the old silent 20.
  - New `AppCaches.patInstallationRepos` slice (grouped/keyed by installation id, 60s TTL;
    pass-through on the Worker's isolate-safe profile): the picker typeahead filters a
    cached complete enumeration in memory instead of re-walking `/user/repos` per
    keystroke. The blank browse-all stays live/uncached. The local PAT is env-fixed per
    boot, so there is no swap-write to invalidate on — the short TTL is the coherence
    story, mirroring `viewerRepos`.
  - `GitHubSyncService.listAvailableRepos` now runs its three independent reads (the
    tracked-projection list, the App-side lookup, the viewer-PAT expansion) as one
    concurrent wave instead of serially, so a cold PAT enumeration no longer stacks on top
    of the App lookup's latency.

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/kernel@0.125.0

## 0.7.0

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

## 0.6.46

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/kernel@0.123.3

## 0.6.45

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2

## 0.6.44

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.6.43

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.6.42

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/kernel@0.122.0

## 0.6.41

### Patch Changes

- 2a13ece: Route `AccountSettingsService.resolve` through the app cache seam (performance initiative item 8).
  The service's legacy homebrew 30s `{ value, expiresAt }` `Map` — the anti-pattern CLAUDE.md names
  explicitly — is replaced by a new `accountSettings` `AppCaches` slice (grouped and keyed by account
  id, holding the decrypted `ResolvedAccountSettings`). `resolve` now reads through it and `write`
  invalidates the account's entry after the upsert commits, so an integration-credential change is
  coherent across replicas (the invalidation bus carries only keys, never the decrypted secrets, so
  plaintext still never leaves the process). `ResolvedAccountSettings` moved to the kernel
  account-settings port (the caching port now names it) and is re-exported from
  `@cat-factory/integrations`, so its consumers are unchanged. Pass-through on the Worker's
  isolate-safe profile (our own mutable D1 state, no cross-isolate bus); both facades wire the slice.
- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.6.40

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.6.39

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

## 0.6.38

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
  - @cat-factory/kernel@0.121.5

## 0.6.37

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.6.36

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.6.35

### Patch Changes

- @cat-factory/kernel@0.121.2

## 0.6.34

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.6.33

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.6.32

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.6.31

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.6.30

### Patch Changes

- @cat-factory/kernel@0.118.1

## 0.6.29

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/kernel@0.118.0

## 0.6.28

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/kernel@0.117.6

## 0.6.27

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.6.26

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/kernel@0.117.4

## 0.6.25

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.6.24

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2

## 0.6.23

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.6.22

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.6.21

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.6.20

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.6.19

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/kernel@0.115.0

## 0.6.18

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/kernel@0.114.0

## 0.6.17

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0

## 0.6.16

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.6.15

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.6.14

### Patch Changes

- @cat-factory/kernel@0.111.1

## 0.6.13

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0

## 0.6.12

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.6.11

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/kernel@0.110.0

## 0.6.10

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.6.9

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/kernel@0.109.0

## 0.6.8

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.6.7

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.6.6

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.6.5

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0

## 0.6.4

### Patch Changes

- @cat-factory/kernel@0.104.4

## 0.6.3

### Patch Changes

- @cat-factory/kernel@0.104.3

## 0.6.2

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/kernel@0.104.2

## 0.6.1

### Patch Changes

- @cat-factory/kernel@0.104.1

## 0.6.0

### Minor Changes

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

- Updated dependencies [37d1517]
  - @cat-factory/kernel@0.104.0

## 0.5.0

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
  - @cat-factory/kernel@0.103.0

## 0.4.22

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/kernel@0.102.0

## 0.4.21

### Patch Changes

- @cat-factory/kernel@0.101.2

## 0.4.20

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/kernel@0.101.1

## 0.4.19

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/kernel@0.101.0

## 0.4.18

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/kernel@0.100.0

## 0.4.17

### Patch Changes

- @cat-factory/kernel@0.99.1

## 0.4.16

### Patch Changes

- Updated dependencies [1afa003]
  - @cat-factory/kernel@0.99.0

## 0.4.15

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/kernel@0.98.0

## 0.4.14

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/kernel@0.97.0

## 0.4.13

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [dd6df12]
  - @cat-factory/kernel@0.96.0

## 0.4.12

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/kernel@0.95.0

## 0.4.11

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/kernel@0.94.0

## 0.4.10

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

## 0.4.9

### Patch Changes

- Updated dependencies [029a689]
  - @cat-factory/kernel@0.92.0

## 0.4.8

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/kernel@0.91.0

## 0.4.7

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/kernel@0.90.0

## 0.4.6

### Patch Changes

- @cat-factory/kernel@0.89.1

## 0.4.5

### Patch Changes

- Updated dependencies [cfcb6c7]
  - @cat-factory/kernel@0.89.0

## 0.4.4

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.4.3

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.4.2

### Patch Changes

- @cat-factory/kernel@0.86.1

## 0.4.1

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/kernel@0.86.0

## 0.4.0

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

## 0.3.0

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

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.2.0

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
