# @cat-factory/workspaces

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
