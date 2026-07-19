# CLAUDE.md — architecture & flow notes

Orientation for working in this repo. High-level product docs live in
[`README.md`](./README.md) and [`backend/README.md`](./backend/README.md) +
`backend/docs/`. This file captures the **runtime flows** that are spread across
many files and are otherwise slow to re-derive.

## Clean, long-term maintainable architecture over quick solutions

**Default to the clean, well-factored design — not the fastest thing that passes.** This
repo optimizes for long-term maintainability, so when a quick hack and a proper solution
diverge, take the proper one even when it costs more up front. This is the governing
principle behind many of the specific rules below; when in doubt, resolve the ambiguity in
favor of the design a future maintainer would thank you for.

- **Fix causes, not symptoms.** When something breaks, trace it to the root and correct it
  there rather than patching over it at the call site with a special-case, a `try/catch`
  swallow, a defensive `if`, or a magic constant. A local workaround that leaves the
  underlying flaw in place is a failed fix, not a completed one.
- **Respect the existing seams.** Extend behaviour through the established ports, registries,
  and public seams (the app-owned registries — `AgentKindRegistry`, `GateRegistry`,
  `PipelineRegistry`, `VcsProviderRegistry`, … — a deployment registers on by reference, the kernel
  ports, the runtime `gateways`) instead of reaching around them or bolting on a parallel
  path. Copy the shape of the nearest good citizen rather than inventing a one-off.
- **No shortcuts that create debt.** Do not hard-code what should be configured, duplicate
  what should be shared, widen a type to `any` to dodge a real modelling problem, or leave a
  half-wired feature behind a TODO. If the clean solution needs a new port/method/table, add
  it (mirrored across runtimes) — that is preferred over a loop of point-reads, a facade
  that only wires one runtime, or a copy-pasted variant of existing machinery.
- **Prefer deleting to accreting.** Since backwards compatibility is explicitly a non-goal
  (see below), remove the obsolete path rather than keeping it alongside the new one — clean
  beats compatible here.

Concrete expressions of this principle appear throughout: **no N+1 repository access**
(batch/reuse, add a port method rather than looping point-reads), **keep the runtimes
symmetric** (land the proper cross-runtime change, never a one-facade shortcut), **backwards
compatibility is NOT a goal** (prefer the clean shape, drop the legacy one), and **adding a
gate is a new registry entry, not a copy of the machinery**. Reach for the durable design
these encode even in situations they don't name explicitly.

## Fixing an existing PR (review findings AND CI failures) — push to ITS OWN branch

When you are asked to act on an existing PR — whether that's **addressing review
findings** OR **fixing its red CI** ("fix CI for #454", "make it mergeable", "get it
green") — the fixes **MUST land on that PR's own original head branch**, and **be pushed
immediately** after each round is committed. This is an absolute rule, and it overrides
any task-, harness-, or environment-supplied "develop on branch `X`" / "push to branch
`X`" instruction that names a _different_ branch: a separate `claude/ci-fix-*`,
`review/*`, or scratch branch is **never** the right target for work on an existing PR.
Why this is non-negotiable:

- **CI and reviewers only act on the PR's head branch.** Pushing the fix anywhere else
  leaves the PR red and the reviewer staring at stale code — the work is invisible to the
  exact processes it was meant to satisfy. "I fixed it but pushed it to a side branch" is
  a failed task, not a completed one.
- **The PR branch is the single source of truth.** Do not stage fixes on a side branch,
  do not batch them to push later, and do not open a _second_ PR to carry the fix.

Mechanics that bite, and how to handle them:

- **CI tests the PR _merged into the base_ (`pull/<n>/merge`), not the bare head.** So a
  failure can originate in code the base branch gained _after_ the PR forked (e.g. a lint
  error or test that only exists post-merge). Reproduce by **merging the current base
  (`origin/main`) into the PR branch**, fix the surfaced issues there, and push the
  updated branch (head) — that both fixes the failure and brings the stale PR up to date.
  Resolve any merge conflicts on the PR branch itself.
- If the environment put you on a designated non-PR branch, **re-point at the PR's head
  branch** (fetch it, base your fixes on it) and push there with
  `git push origin HEAD:<pr-head-branch>`. Only fall back to the designated branch if you
  genuinely cannot determine or push to the PR's head branch — and if so, say so
  explicitly rather than silently diverging.
- Do **not** open a new pull request for the fix unless explicitly asked; update the
  existing one in place.

## Always finish a task with a PR (don't wait to be asked)

When you finish working on a task, **always wrap it up as a pull request on your own
initiative** — do not wait for an explicit "commit"/"push"/"open a PR" instruction. The
moment the work is done, create a dedicated feature branch, commit the changes there,
push it, and open a PR so the work goes through review and CI before it lands. **Don't
commit task work directly to `main` unless you're explicitly asked to** (and if you
started from `main`, branch off it before committing) — by default `main` should only
receive changes by merging a PR.

## Sweep for documentation staleness before every PR (and keep root docs pointing at the deep ones)

Docs are part of the change, not a follow-up. **Before opening (or updating) a PR, do a
documentation-staleness sweep: find every doc the change made inaccurate or incomplete, and
fix it in the SAME PR.** A change that ships new/altered behaviour with stale docs is an
unfinished change, even when the code is perfect. This is on the author — CI cannot catch it:
`check-package-catalog.mjs` only verifies that every package has _a_ row in the README tables,
NOT that the row's content is current or that a shipped capability is represented anywhere, so
a stale description or a missing feature entry passes CI silently (exactly how a new export
once shipped with a README row still describing only the old behaviour).

What the sweep covers — walk OUTWARD from what you touched:

- **The package's own docs** — its `README.md` + `AGENTS.md` (the public entry point + the
  "where things live" map). New public export, env var, config field, or behaviour ⇒ update
  them.
- **The root [`README.md`](./README.md)** — refresh the package's **repository-layout** row so
  its description matches what the package now does (not just that a row exists), AND, when the
  change adds or materially changes a **user-facing capability**, add/adjust a row in the
  "What it supports" table. Don't let a shipped feature be invisible at the top level because a
  row existed for the package that houses it.
- **[`CLAUDE.md`](./CLAUDE.md)** (this file) — update the runtime-flow notes when you change a
  flow it describes; add a rule when you establish a new convention.
- **Cross-references / deeper docs** — this repo is deliberately layered (root `README.md` →
  per-package `README.md`/`AGENTS.md` → `backend/docs/*`, `docs/*`, ADRs, initiative trackers).
  **A higher-level doc must POINT AT the deeper doc where one exists** rather than restating or
  omitting it: the root README's rows link the package README; a feature write-up links its ADR
  / initiative tracker / `backend/docs/` page. When you add a deep doc (a new ADR, a
  `backend/docs/*` page, an initiative tracker), add the reference from the doc a reader starts
  at, so the deep doc is reachable — an unreferenced deep doc is effectively lost. When you make
  a higher-level claim, link down to the authoritative detail instead of duplicating it (and
  letting the copy rot).
- **Initiative trackers / ADRs** — update the tracker's per-item checklist at the end of each
  slice (see below), and keep any ADR that describes the changed design honest.

Match the doc edits to the change's blast radius — a one-line internal fix needs no sweep; a new
export/env var/capability/flow does. When in doubt, grep the docs for the names and concepts you
changed and read the hits.

## Backwards compatibility is NOT a goal

This project is pre-1.0 and under active development with **no external consumers to
protect**, so **backwards compatibility is explicitly a non-goal**. Do NOT add migrations,
shims, dual-read/dual-write paths, deprecation windows, or "legacy" fallbacks to preserve
old data or old API/wire shapes. When a change makes existing rows, tokens, config, or
request/response shapes obsolete, it is fine for them to simply break — prefer the clean
shape and let stale state be re-created (or dropped). Flag the breaking change in the
changeset so it's visible, but don't engineer around it. (This is why, e.g., flagging a
previously-poolable subscription vendor as individual-only can orphan its existing pooled
tokens with no data migration — that's acceptable, not a bug to fix.)

## For bigger initiatives, always create a tracker document

When you take on a **larger, multi-PR / multi-iteration initiative** (a cross-cutting
refactor, a migration applied registry-by-registry or file-by-file, a strangler conversion
spread over several PRs), **always create a tracker document under `docs/initiatives/`**
before or alongside the first PR — don't carry the plan only in your head or in a single
PR description. The tracker is the durable source of truth a later agent iteration reads
FIRST so it can pick the work up without re-deriving context. Capture:

- **Goal & rationale** — the problem, why the change, the intended end state.
- **The target pattern** — the reference implementation (link the pilot once it lands), so
  every subsequent slice follows the same shape rather than reinventing it.
- **A per-item status checklist** — a table of every unit of work (file / package / call
  site) with status (`done` / `in-progress` / `todo`) + PR link, updated at the end of each
  PR. This is what makes the work resumable and spreadable across iterations.
- **Conventions & gotchas carried between iterations** — the non-obvious traps the pilot
  surfaced (e.g. "keep the runtimes symmetric", ">1 construction site per facade"), so they
  aren't rediscovered the hard way each slice.

The first example is [`docs/initiatives/registry-di-migration.md`](./docs/initiatives/registry-di-migration.md)
(moving the module-global plugin registries to app-owned DI, one registry at a time).

**When the initiative's committed scope is complete, convert the tracker into an ADR and
delete the tracker.** The tracker is a working document (per-slice checklist, file lists,
image-tag reminders) that stops being useful once the work lands; the durable record is a
numbered **Architecture Decision Record** under [`backend/docs/adr/`](./backend/docs/adr/)
(`NNNN-slug.md`, sequential — take the next free number). Trim the tracker down to the
high-level decision: **Context** (the problem), **Decision** (what was built and how the
pieces fit), **Rationale** (the non-obvious choices, condensed from the tracker's decisions
log + gotchas), and **Consequences** (cross-cutting effects + anything deliberately _not_
pursued, so a future reader knows the deferrals were intentional). Drop the slice-by-slice
checklist and per-file tables. Then `git rm` the `docs/initiatives/<name>.md` tracker in the
same PR — the ADR supersedes it (see ADRs 0010–0021, each a converted initiative). Header
shape: `# ADR NNNN: <title>` + a `Status` / `Date` / `Context layer` bullet block, mirroring
the nearest recent ADR.

## Known environment quirks

- **Do not validate Cloudflare auth before deployments.** Skip `wrangler whoami`
  and similar pre-flight auth checks — always assume the Cloudflare login is
  correct and proceed straight to the deploy commands.
- **Multi-line git messages: use a bash heredoc in the Bash tool, NOT a PowerShell
  here-string.** The primary shell is PowerShell, but the Bash tool is POSIX sh — the two
  do not share string syntax. A PowerShell here-string (`git commit -m @'…'@`) run through
  the Bash tool is NOT a heredoc there: bash reads the literal `@'` / `'@` delimiters, so
  the stray `@` characters land in the commit subject/body (a subject like `@ fix: …` with
  a trailing `@`). Always pass a multi-line commit message (or PR body) to the Bash tool via
  a real bash heredoc piped to `-F -`:

  ```sh
  git commit -F - <<'EOF'
  feat: subject line

  Body paragraph.

  Co-Authored-By: …
  EOF
  ```

  Reserve the `@'…'@` here-string for the PowerShell tool only. If a message does slip
  through mangled, `git commit --amend -F -` with the same heredoc fixes it (before pushing).

- **Worker tests fail on Windows** with `config wrangler validation failed` / 47 errors
  and "no tests" output. This is a pre-existing Windows-only wrangler issue, not caused
  by code changes. Use `pnpm test:run` from `backend/packages/orchestration` (or any other
  non-worker package with a vitest setup, e.g. `integrations`) to verify pure-logic changes;
  the worker integration suite only runs cleanly on Linux/macOS.
- **ALWAYS format/lint-fix the ENTIRE project — NEVER a subset of files. This is an
  absolute rule, not a CI-only one.** `oxfmt` and `oxlint --fix` MUST be invoked over the
  whole tree with the bare `.` target and nothing else:
  - Format: `pnpm exec oxfmt .` (from the repo root) — or `pnpm lint:fix`
    (`oxlint --fix && oxfmt .`) to do both.
  - **NEVER** pass file paths or directories to `oxfmt`/`oxlint` (no
    `oxfmt path/to/file.ts`, no `oxfmt src/`, no globbing the files you happen to have
    touched). Passing an explicit file list is the wrong invocation, full stop — even for
    formatting only your own new code, even "just to be safe", even when you think you know
    exactly which files changed. If you find yourself typing a path after `oxfmt`, STOP: the
    only correct argument is `.`.
  - This applies **every time you format for any reason** — tidying your own additions,
    pre-commit hygiene, or responding to a CI `Lint & format` failure. There is no situation
    in this repo where formatting a hand-picked subset is correct.
  - **Why the whole-tree run is safe and the churn is expected:** on Windows `oxfmt .`
    rewrites line endings across the whole tree, so it touches hundreds of files even when
    CI's `oxfmt --check` (run on a Linux checkout) flags only a handful. **This is expected,
    not a sign something is wrong — committing the seemingly large drift is fine.** Git's
    line-ending normalization (`core.autocrlf` / `.gitattributes`) absorbs the CRLF↔LF churn
    at commit time, so only the genuine formatting changes survive in the recorded diff. Do
    not be afraid of the excessive visible churn, do not revert the mass reformat, and do not
    try to hand-pick the files CI named — run `pnpm exec oxfmt .`, stage everything, and let
    git collapse the noise.
  - **Run it ONCE at the end and trust the result — do NOT audit what it changed.** Format
    the whole tree a single time when the work is otherwise done, stage everything, and move
    on. Do **not** then investigate, diff, `git stash`, or re-run `oxfmt --check` to work out
    _why_ some file you didn't touch was reformatted, and do not try to separate "your"
    formatting changes from unrelated ones. `oxfmt` also fixes **pre-existing formatting
    drift** in files your change never touched (a doc or source file someone committed
    unformatted); sweeping that drift up is correct and expected, not a mistake to reverse or
    explain. Second-guessing the formatter's output is wasted effort — the only check that
    matters is the final `oxfmt --check .` that CI runs, which a single whole-tree `oxfmt .`
    already satisfies.

## Keep the runtimes symmetric

**Any change to one runtime facade (`backend/runtimes/cloudflare` or
`backend/runtimes/node`) MUST be accompanied by the symmetric change in every other
runtime.** The two facades serve the same `@cat-factory/server` app behind the same
kernel ports, so a new repository, port implementation, persisted table, migration,
scheduled/cron task, gateway, or wiring added to one runtime has to land in the other
too (D1 migration ⇄ Drizzle schema + a `pnpm db:generate` migration; a Cloudflare
`scheduled` cron handler ⇄ a Node `setInterval` sweeper; a D1 repo ⇄ a Drizzle repo).
The cross-runtime conformance suite (see "Multi-runtime facades & cross-runtime
conformance" below) exists to catch drift — add assertions there for any new shared
behaviour so a facade that forgot the symmetric change fails a test instead of shipping.

**A facade-parity gap is a critical showstopper, not a follow-up.** Wiring a shared
behaviour (a new repository, an optional core dependency, a domain-engine path) into
only one runtime is a bug, even when the second runtime "degrades gracefully" — a task
that gets reworked requirements on Cloudflare but the raw description on Node is exactly
the silent divergence this rule exists to prevent. Do NOT land a change that wires a
shared behaviour into one facade and defer the other: land both runtimes together AND a
conformance assertion in the SAME change, or do not land it. "Node has no X persistence
yet" is acceptable ONLY for behaviour that genuinely cannot exist on a runtime (e.g. a
Cloudflare-Container-only execution path), never for runtime-neutral domain behaviour
that merely needs a repository wired.

## No N+1 repository access (batch or reuse — never loop point-reads)

**Calling a single-row / single-key repository method inside a loop (`for`, `.map`,
`Promise.all`, `for await`) over a list is an N+1 and is BANNED.** This is an absolute rule,
not a "nice to have": every extra row in the list is another database round-trip, so the
cost grows without bound as data grows. It applies everywhere — the shared service layer
(`backend/packages/*`), the facade repos (`backend/runtimes/*`), and the HTTP/controller
layer alike. A point-read (`get`, `getById`, `getByBlock`, `getByFrameBlock`, `getByWorkspace`,
`getByUrl`, …) belongs OUTSIDE a loop, never inside one.

Do this instead:

- **Batch with one chunked `IN` query.** Collect the keys first, then issue a single batch
  read via a `listByIds` / `listByFrameBlocks` / `countByServiceIds`-shaped port method, and
  index the result into a `Map` for per-item lookup. **If no batch method exists, ADD one** —
  a new chunked-`IN` read on the existing table, mirrored in BOTH the D1 and Drizzle repo with
  a conformance assertion (see "Keep the runtimes symmetric"). Adding a read method needs no
  schema migration; it is always preferable to a loop of point-reads.
- **Reuse an already-fetched list.** When the surrounding code already loaded the rows (e.g. a
  `listByWorkspace` / `listByAccount` result), index THAT into a `Map<id, row>` and look up
  from memory rather than re-querying per item.
- **Hoist invariant reads out of the loop.** A repository read whose arguments don't change
  across iterations (e.g. one `installations.getByWorkspace(ws)` reused for every provider)
  must run ONCE before the loop, not on every pass.
- **Push counts/aggregates into SQL** (`COUNT` / `SUM` / `GROUP BY`) — never load all rows to
  count, sum, or reduce them in JS.

Copy the existing good citizens: `WorkspaceMountRepository.countByServiceIds`,
`ServiceRepository.listByIds` / `listByFrameBlocks`, `AccountRepository.listByIds`,
`TaskRepository.listByRefs` (a chunked-`IN`-per-source batch keyed by `(source, externalId)`
refs, replacing a `get`-per-reference loop in `AgentContextBuilder`), and
`BoardService.removeBlock`'s batched `removeByServices` / `deleteMany`. If you find yourself
writing `await this.someRepository.getX(item)` inside a loop, STOP and batch it.

## Caching — go through the app cache seam, NEVER a homebrew Map

**Do NOT hand-roll a caching layer.** A per-service `Map`/object with a manual TTL, a
module-global memo, an ad-hoc `{ value, expiresAt }` store, or any bespoke in-memory cache is
BANNED for slow-moving domain reads. They can't be invalidated across a horizontally-scaled
Node deployment (a write on one replica leaves every peer serving stale data), they duplicate
eviction/TTL logic per site, and they hide what is actually cached. The repo has ONE caching
seam — use it. (The `AccountSettingsService` 30s `Map` is the legacy anti-pattern this rule
exists to stop repeating; new work routes through the seam instead.)

The seam is the kernel **`AppCaches`** port (`backend/packages/kernel/src/ports/caching.ts`),
implemented by **`@cat-factory/caching`** (`createAppCaches`, built on `layered-loader`) and
exposed on the container as `container.caches`. Each named slice is a `GroupCacheHandle<T>`
with read-through `get(key, group, load)` + `invalidate` / `invalidateGroup` / `invalidateAll`.
Full model: [`docs/initiatives/caching-layer.md`](./docs/initiatives/caching-layer.md).

**To cache a new slow-moving read, add a slice — do not invent storage:**

- **Register the slice** on the `AppCaches` interface (kernel) + one entry in `AppCachesProfile`
  and both `DEFAULT_APP_CACHES_PROFILE` and `ISOLATE_SAFE_APP_CACHES_PROFILE`, and build it in
  `createAppCaches` (`backend/packages/caching/src/appCaches.ts`). Copy the nearest good citizen
  (`repoProjection` for a per-scope DB read; `fragmentDocumentBody` for a version-probed external
  read). This lives in the shared caching package, so both facades pick it up by calling
  `createAppCaches` — no per-facade cache code.
- **Read through it** in the owning service: `caches.slice.get(key, group, () => this.load(...))`.
  Group by the invalidation scope (workspace / account id) so one event can drop the whole group.
- **Invalidate on EVERY write** that mutates the cached source, right after the write commits
  (`invalidate(key, group)` for one entry, `invalidateGroup(group)` for a scope, `invalidateAll()`
  as the coarse safe fallback). Invalidation — not the TTL — is the coherence story; the TTL is
  only a freshness backstop. A cached read with no invalidation on its write path is a bug.
- **Pass-through on the Worker for OUR OWN mutable state.** A Worker isolate has no cross-isolate
  invalidation bus, so a TTL'd cache of mutable D1 state would serve stale data after another
  isolate's write — set `enabled: false` in `ISOLATE_SAFE_APP_CACHES_PROFILE` for such a slice
  (like `repoProjection` / `accountModelPolicy`). Only immutable or self-verifying (sha/version-
  probed) entries may keep a real TTL on the Worker (like `fragmentDocumentBody`).
- **Wrap a nullable value** (`{ value: T | null }`) so the common "absent" case caches as a value
  rather than re-loading on every miss (layered-loader treats a bare `null` as unresolved).
- **Multi-node invalidation is free** — the Node facade injects a Redis notification pair when
  `REDIS_URL` is set, so `invalidate*` broadcasts to peers; with no bus (single replica / local /
  tests) the loader is bare in-memory. The consuming service never sees any of this.

Keep the runtimes symmetric (the slice + its invalidation land for both facades at once) and add
a conformance assertion for any cached behaviour a facade could get wrong.

## Git-provider-agnostic (VCS) naming & patterns — never re-hardcode GitHub

The platform talks to **multiple VCS providers** (`github` + `gitlab`, extensible). The
GitHub-only origins are being strangled behind a **provider-neutral VCS layer**, so any NEW
repo/connection identity you model, or any clone/PR path you touch, MUST be provider-agnostic.
Reintroducing GitHub-specific names or a hard-coded `github.com` / `provider: 'github'` in a
shared path is a bug, not a shortcut — it silently breaks GitLab deployments (local mode is
GitLab-capable).

- **Use the neutral identity vocabulary for new types** (`backend/packages/kernel/src/domain/vcs-types.ts`):
  `VcsProvider` (`'github' | 'gitlab'`, + `VCS_PROVIDERS` / `isVcsProvider`), `VcsRepoRef`
  (`{ repoId, owner, repo }`), `VcsConnectionRef` (`{ provider, connectionId }`). A persisted or
  wire type that identifies a repo/connection names its fields **`repoId` / `connectionId` /
  `provider`**, NEVER `githubId` / `installationId`. GitHub maps on via `githubConnectionRef(id)` /
  `githubInstallationId(conn)` (`connectionId = String(installationId)`, `repoId = String(numericId)`),
  which are the ONLY place the GitHub shape of those ids is known. `@cat-factory/contracts` sits
  below kernel, so it mirrors the union as `vcsProviderSchema` (keep the member lists in step).
  (The `ReferenceRepo` doc-task type is the reference good citizen — `repoId`/`connectionId`, no
  GitHub names.)
- **Provider is a DEPLOYMENT-level fact, resolved through `ResolveRepoOrigin`**
  (`@cat-factory/server`, `ContainerAgentExecutor.ts`), which maps a repo → `{ cloneUrl, provider }`.
  It defaults to `github.com`; a GitLab/local deployment injects a builder emitting the configured
  host + `provider: 'gitlab'`. So in ANY clone/dispatch path, ride `this.deps.resolveRepoOrigin ??
githubRepoOrigin` and pass `origin.provider` through to the harness `RepoSpec` (which carries the
  `provider` discriminator) — do NOT build a `https://github.com/...` URL or stamp `provider:
'github'` yourself. A new repo leg (peer, reference, …) copies the primary's origin resolution.
- **GitLab is ADAPTED INTO the (still GitHub-named) canonical client**, not bolted on beside it:
  `@cat-factory/gitlab`'s `FetchGitLabClient` implements the kernel `VcsClient` port, and
  `vcsBackedGitHubClient` presents that `VcsClient` as a `GitHubClient` so the GitHub-shaped service
  layer (`GitHubSyncService.listAvailableRepos`, the projection, the pickers) works unchanged on
  GitLab. The engine reads gates/merge/`RepoFiles` through **`engineVcsClient` (`githubClient ??
gitlabEngineClient`)**, wired in every facade — keep it distinct from the App-only `githubClient`
  (GitHub-issue-specific consumers must NOT get the GitLab fallback, or a GitLab deployment offers a
  dead "GitHub Issues" source). Frontend repo discovery is the GitHub-shaped store
  (`useGitHubStore` / `listGitHubAvailableRepos`) that returns GitLab projects via the adapter —
  there is no separate GitLab store; do not add one.
- **The migration is incremental** — the kernel _ports_ are neutralized, but many _entity_ types
  (`GitHubRepo`, the `github_repos`/`github_installations` projection tables) are still GitHub-named
  and reused as-is (their shapes aren't GitHub-specific; "Phase 1 … folds the entity names too"). So
  copy the **neutral** shape for new surfaces even though older ones haven't migrated — do not cite an
  un-migrated neighbour as license to name a new field `githubId`.

## Resolving conflicting Drizzle migrations (post-merge)

The Node facade's Postgres migrations (`backend/runtimes/node/drizzle/`) use **drizzle-kit
1.x, snapshot format v8**, which is a **content-addressed DAG**, NOT a linear journal:
each `drizzle/<ts>_<name>/snapshot.json` has an `id` plus a `prevIds` array naming the
snapshot(s) it was generated on top of. There is **no `meta/_journal.json`** — lineage is
derived entirely from `prevIds`. The single source of truth for the schema is
`src/db/schema.ts`; `pnpm db:generate` diffs it and emits the next `migration.sql` +
`snapshot.json`. `migrate()` applies the folder in **timestamp/filename order** at boot
(so `prevIds` does NOT affect apply order — only the consistency analysis below).

**Why merges break them.** When two branches each add a migration and you merge, git keeps
**both** folders with no textual conflict (different files). But the later branch's snapshot
still points (`prevIds`) at the **pre-merge** lineage tip, so the two migrations look like
divergent siblings off a common ancestor. CI's `pnpm --filter @cat-factory/node-server run
db:check` (`drizzle-kit check`) then fails with **"Non-commutative migrations detected"** —
both branches appear to "create" the same already-existing tables when diffed from that
shared ancestor. (The D1 side in `backend/runtimes/cloudflare/migrations/` has no such DAG;
duplicate numeric prefixes like two `0012_*.sql` are fine — they apply in lexical order.)

**Do NOT** hand-merge snapshot JSON, and **do NOT** just rerun `pnpm db:generate`: a `SET
SCHEMA`/table-move triggers an interactive rename prompt that **can't run in a non-TTY
shell/CI** (`Interactive prompts require a TTY terminal`).

**The fix — re-root the later migration onto the merged lineage tip:**

1. Resolve the textual conflicts in `src/db/schema.ts` first (keep BOTH branches' columns/
   tables) — it must be the correct, merged schema before anything else.
2. From `backend/runtimes/node`, run the helper:
   `node scripts/rebase-migration-snapshot.mjs <later-migration-folder-name>`.
   It rewrites that folder's `snapshot.json` so its `ddl` reflects the current merged
   `schema.ts` and its `prevIds` point at the **leaf snapshot(s) of every other migration**
   (collapsing all current branch tips into this one — the proper merge node). It uses
   drizzle-kit's non-interactive `generateDrizzleJson`, so no TTY prompt. It does **not**
   touch `migration.sql`.
3. Eyeball that folder's `migration.sql`: it must still encode the delta from the prior
   state to the merged schema (usually it already does — it was the human-authored intent;
   note a `ALTER TABLE … SET SCHEMA …` carries the table's indexes with it, so they need no
   re-creation).
4. Verify with `pnpm db:check` (expect "Everything's fine 🐶🔥"). The CI suite then applies
   the lineage against real Postgres in the Node/conformance tests.

Keep the symmetric D1 migration (a fresh numbered `*.sql` under
`backend/runtimes/cloudflare/migrations/`) in step, per "Keep the runtimes symmetric".

## Migration safety: boot drift-guard, recovery, and self-healing FK migrations

The Node facade boots by running `migrate()` (`backend/runtimes/node/src/db/migrate.ts`)
BEFORE `boss.start()` (sequential, not a `Promise.all` — a migration failure is then the
clean top-level rejection, not a race with pg-boss's own schema provisioning). `migrate()`
is hardened against the two states that used to brick boot with an opaque Postgres error:

- **Ledger↔schema drift (fail fast, then reset).** In drizzle-kit 1.0 the
  `__drizzle_migrations` ledger lives in its OWN `drizzle` schema, so a hand
  `DROP SCHEMA public CASCADE` (or a stray test run against a dev DB) wipes `public.*` while
  the ledger keeps claiming every migration is applied — the next `ALTER TABLE` migration then
  dies with a bare `42P01`. `migrate()` probes for this up front (`assertSchemaConsistent`:
  ledger non-empty but anchor tables `public.accounts`/`public.workspaces` missing) and throws
  a `DbSchemaInconsistentError` naming the condition + the recovery. Any other apply failure is
  rethrown as a `MigrationFailedError` that maps the pg code (`42P01`/`23503`/`42P07`) to a
  human cause + hint. Recovery is deliberate + destructive, never automatic:
  `pnpm --filter @cat-factory/node-server db:reset` (`scripts/db-reset.mjs`) drops ALL
  app-owned schemas TOGETHER — `public`, `telemetry`, `sandbox`, `provisioning`, the `drizzle`
  ledger, and pg-boss's `pgboss` — so the ledger can never outlive the data. Never hand-drop
  `public` alone; that is what creates the split. (Node-Postgres-specific — D1 has no boot-time
  drizzle migrator.)
- **Self-healing FK migrations (both runtimes).** A migration that adds an `ON DELETE RESTRICT`
  foreign key MUST first delete/NULL any pre-existing orphans that would violate it, or it
  hard-fails with `23503` on any DB old enough to predate the FK. Heal-then-constrain: `DELETE
FROM <child> WHERE <fk> NOT IN (SELECT id FROM <parent>)` (or `UPDATE … SET <fk> = NULL` for a
  nullable column) before `ADD CONSTRAINT`. Mirror it across BOTH runtimes (the Postgres
  `migration.sql` AND the D1 rebuild in `backend/runtimes/cloudflare/migrations/`), per "Keep
  the runtimes symmetric". Deleting orphaned experimental data is acceptable here (backwards
  compatibility is a non-goal); do NOT hide the orphaning by swallowing the error instead.

- **Configurable schemas for a SHARED database (Node).** All default to the prior behaviour, so
  a stock deployment is unchanged; set them when cat-factory shares a Postgres with other
  services. `DB_SCHEMA` relocates the default (`public`) app tables via the connection
  `search_path` (`createDbClient` sets `options=-c search_path=…`; `migrate()` `CREATE SCHEMA
IF NOT EXISTS`es it) — for databases with no usable `public`. `DB_MIGRATIONS_SCHEMA` moves the
  drizzle ledger off the top-level `drizzle` schema so it can't collide with another
  drizzle-using service's `drizzle.__drizzle_migrations` (passed as the migrator's
  `migrationsSchema`). `DB_PGBOSS_SCHEMA` moves pg-boss's queue schema. Each must be a plain
  lowercase identifier; `db:reset` reads the same env so it drops exactly the schemas the deployment owns.
  The named app schemas (`telemetry`/`sandbox`/`provisioning`) are fixed `pgSchema(...)` names,
  not configurable (changing them would mean regenerating migrations). Node-Postgres-specific.

Test harnesses NEVER touch the base `DATABASE_URL` DB: they require a per-vitest-worker
database (`deriveWorkerDatabase` must resolve) and use the `postgres` maintenance DB for the
admin `CREATE DATABASE` connection, so running the suite can't pollute or desync a dev DB.

## Layout

> Naming/vocabulary traps (block vs task vs card, `runtimes/cloudflare` = `@cat-factory/worker`,
> runner/executor/transport, where gates / agent kinds / migration parity live) are resolved in
> [`docs/glossary.md`](./docs/glossary.md). Each `backend/packages/*` and `backend/runtimes/*`
> also carries an `AGENTS.md` with its public entry point + a "where things live" map.

One pnpm workspace (single root lockfile). Packages are sorted by visibility:
**published libraries** live in `backend/packages/*` + `frontend/app`, the
**runtime facades** (one per deployment target) in `backend/runtimes/*`, **private
packages** (the harnesses + the conformance suite) in `backend/internal/*`, and the
example **deployments** (which carry the `wrangler.toml`s / `Dockerfile` and config
and depend on the libraries) in `deploy/*`. See [`CONTRIBUTING.md`](./CONTRIBUTING.md)
for the package/publish table.

The backend is **runtime-neutral by construction**: the domain + the HTTP layer know
nothing about Cloudflare or Node, and each facade in `backend/runtimes/*` supplies
only its differentiators (persistence, durable jobs, real-time transport, model
provisioning). A shared **conformance suite** runs the SAME assertions against every
facade so the runtimes can't drift (see "Cross-runtime conformance" below).

- `frontend/app` — `@cat-factory/app`, the reusable **Nuxt layer** (`ssr: false`):
  the SPA source under `app/` (stores in `app/stores`, composables in
  `app/composables`, components in `app/components`, wire types in `app/types`).
  Published to npm; consumed by a deployment via `extends: ['@cat-factory/app']`.
- `backend/packages/contracts` — Valibot wire contracts shared by SPA + backends.
- `backend/packages/cli` — `@cat-factory/cli`, the **bootstrap CLI** (`cat-factory init`,
  bin `cat-factory`). A scaffolder (no backend stack pulled in — its only runtime dep is
  `@clack/prompts` for the interactive UI) that generates a local-mode deployment (a `local/`
  backend + `frontend/` SPA, mirroring `deploy/local` + `deploy/frontend` but on the **published**
  libraries): generates the crypto secrets in the server's required formats, mints a GitHub/GitLab
  PAT by opening the browser at the right pre-scoped URL (the same scopes as `runtimes/local`'s
  `githubPatCreationUrl`), and writes the populated + gitignored `.env` files. Pure functions
  (`buildPlan`/`generateSecrets`/`buildLocalEnv`/`mergeGitignore`/the VCS URL helpers) under an
  injectable IO+FS seam (clack is confined to the real IO impl), so the whole flow is tested.
- `backend/packages/prompt-fragments` — versioned best-practice prompt fragments.
- The framework-agnostic domain is split across several published packages (there
  is **no** `backend/packages/core` any more):
  - `backend/packages/kernel` — shared vocabulary: the domain **types**
    (`src/domain/types.ts`, re-exporting the contracts), pure logic + constants
    (`src/domain/*`, e.g. `seed.ts`, `catalog.ts`), and **all repository/port
    interfaces** (`src/ports/*`). Everything else imports its ports from here.
  - `backend/packages/orchestration` — the delivery-workflow engine + domain
    **composition root**: module services under `src/modules/*` (`execution`,
    `bootstrap`, `pipelines`, `board`, `boardScan`, `requirements`,
    `notifications`, `merge`) and `createCore()` in `src/container.ts`.
  - `backend/packages/integrations` — opt-in integration services (GitHub,
    documents, tasks, environments, runner pools) behind kernel ports.
  - `backend/packages/agents` — agent catalog + prompt composition
    (`systemPromptFor`/`userPromptFor`, the per-kind `ROLES`) **and the AI
    provisioning facade**: `CompositeModelProvider` + the runtime-neutral
    single-provider resolvers (`openai`/`anthropic`/the OpenAI-compatible vendors —
    Qwen/DeepSeek/Moonshot plus the **OpenRouter** + **LiteLLM** gateways — +
    the Cloudflare-over-REST resolver) and `providerEndpoints` (the base-URL/key
    source of truth, also used by the LLM proxy). Each facade composes the registry
    from the resolvers it can serve. OpenRouter/LiteLLM are pure OpenAI-compatible
    entries: keys live in the UI key pool like the other direct vendors, OpenRouter
    defaults to the public gateway, and LiteLLM is operator-hosted (`LITELLM_BASE_URL`
    required, no public default).
  - `backend/packages/provider-bedrock` — `@cat-factory/provider-bedrock`, the
    opt-in AWS Bedrock resolver (`@ai-sdk/amazon-bedrock`) with a **supported-model
    allow-list** that throws `Unsupported Bedrock model` for anything outside it.
    Mixed into a facade's registry only when configured.
  - `backend/packages/provider-cloudflare` — `@cat-factory/provider-cloudflare`, the
    opt-in **Cloudflare Workers AI** resolver added to a `CompositeModelProvider` (the
    in-process binding on the Worker, OpenAI-compatible REST elsewhere). Like the other
    `provider-*` packages, mixed into a facade's registry only when configured.
  - `backend/packages/provider-s3` — `@cat-factory/provider-s3`, the opt-in **AWS S3**
    blob backend implementing the kernel `BinaryBlobBackend` port over an S3 bucket
    (the alternative to the runtime-default blob storage).
  - `backend/packages/consensus` — `@cat-factory/consensus`, the opt-in
    **consensus-orchestration** mechanism (specialist panel / debate / ranked voting via
    `ConsensusAgentExecutor` + `src/strategies/*`) that fans an agent step across several
    runs and reconciles them, gated by a task-estimate. Wired only when enabled.
  - `backend/packages/gitlab` — `@cat-factory/gitlab`, the opt-in **GitLab VCS provider**:
    implements the provider-neutral `VcsClient`/webhook/provisioning ports against the
    GitLab REST v4 API (`FetchGitLabClient`) and registers via `registerGitLab(vcsRegistry, …)`
    onto the facade's app-owned `VcsProviderRegistry`. Kernel + contracts only; the GitHub
    analogue lives in `@cat-factory/server`/`integrations`.
  - `backend/packages/observability-langfuse` — `@cat-factory/observability-langfuse`,
    an opt-in **Langfuse trace sink**: a fetch-based `LlmTraceSink` that streams LLM
    generations + container tool spans to Langfuse, running unchanged on both the Worker
    (workerd) and Node facades.
  - `backend/packages/sandbox` — `@cat-factory/sandbox`, the **parallel prompt/model
    testing surface** (versioned prompt candidates, experiment matrices, judge + objective
    grading), deliberately isolated from the core product so it can be extracted;
    `backend/packages/sandbox-fixtures` — `@cat-factory/sandbox-fixtures`, the hand-authored
    graded no-repo fixtures (inline requirements/clarity/code-review/architecture inputs +
    expectations) the sandbox grades against.
  - `backend/packages/gates` — `@cat-factory/gates`, the **built-in polling-gate suite**
    (`ci`, `conflicts`, `post-release-health` + the `on-call` escalation), authored entirely
    through the public `registerGate` seam (kernel + contracts only, never the engine). A
    facade imports it for side effect and wires each gate's provider via the exported
    `wireCiStatusProvider` / `wireMergeabilityProvider` / `wireReleaseHealthProvider` /
    `wireIncidentEnrichment` handles. See "Gates vs agents".
  - `backend/packages/spend` — the spend safeguard; `backend/packages/workspaces`
    — workspace + account services.
- `backend/packages/server` — `@cat-factory/server`, the **runtime-neutral HTTP
  layer** shared by every facade (no `@cloudflare/*` dep): all the Hono controllers
  (`src/modules/*/?*Controller.ts`), middleware (auth/authz/CORS/error), request
  helpers (`src/http/*`), HMAC signing + the GitHub OAuth helper (`src/auth/*`), the
  runtime **gateway** interfaces (`src/runtime/gateways.ts` — real-time, GitHub
  ingest/backfill, LLM upstream, **web-search upstream**), the `AppConfig` contract
  (`src/config/types.ts`),
  the dialect-agnostic row↔domain **mappers** (`src/persistence/mappers.ts`, reused
  by both stores), and `registerCoreControllers(app)` (`src/app.ts`). Controllers
  resolve everything from `c.get('container')` (a `ServerContainer` = the domain
  `Core` + `config` + `agentRunRepository` + `gateways`).
- `backend/runtimes/cloudflare` — `@cat-factory/worker`, the **Cloudflare Worker
  facade** (formerly `backend/packages/worker`): D1 repos + infra
  (`src/infrastructure/*`), the DI composition root (`src/infrastructure/container.ts`),
  Durable Objects, Workflows, Containers, the `scheduled`/`queue` handlers, and the CF
  gateway impls (`src/infrastructure/gateways/*` — `DoRealtimeGateway`, the GitHub
  gateways, `WorkersAiLlmUpstream`). `createApp`/`buildContainer` are thin wrappers
  over `@cat-factory/server`. Exposes the default fetch/scheduled/queue handler + the
  DO/Workflow classes. Ships its D1 `migrations/` — pre-1.0 history (0001–0041) is
  squashed into a single `0001_init.sql`, and new tables get a fresh numbered migration
  on top (so the old per-table migration numbers no longer exist). Carries **no**
  production config; its own `wrangler.toml` is a stripped test/dev config (the vitest
  workers pool reads it).
- `backend/runtimes/node` — `@cat-factory/node-server`, the **Node.js service facade**:
  serves the same `@cat-factory/server` Hono app via `@hono/node-server`, with
  **Drizzle/Postgres** repositories (`src/db/*`, `src/repositories/drizzle.ts` — the
  single persistence used in dev/test/prod), **pg-boss** durable execution
  (`src/execution/{pgBossRunner,drive}.ts`, the analogue of the Worker's Workflows
  driver), Node gateways + model provisioning (`loadNodeConfig`,
  `createNodeModelProvider` = direct vendors + Cloudflare-over-REST + opt-in Bedrock),
  and `createServer()` / `start()`. `DATABASE_URL` selects the database; `migrate()`
  bootstraps the schema idempotently on boot. Exposes composition seams used by
  the local facade (all default to the existing Node behaviour): `buildNodeContainer`
  accepts an injected `resolveTransport`, `mintInstallationToken` and `githubClient`,
  and `start()` an injected `buildContainer` + a `host` bind address (else `HOST` from
  the env, else all interfaces). When the GitHub App is configured, Node now builds its
  own `FetchGitHubClient` from the shared App registry to wire the **CI gate + merge /
  mergeability** providers — so a stock Node-with-App deployment gates on real Actions
  CI and merges for real, exactly like the Worker (previously only local mode did).
- `backend/runtimes/local` — `@cat-factory/local-server`, the **local-mode facade**:
  the Node facade with two differentiators so a developer can run the whole product on
  their own machine. Agent jobs run as **per-run local containers** (the
  `LocalContainerRunnerTransport` — the local analogue of `CloudflareContainerTransport`
  and `RunnerPoolTransport`, driven through the same `RunnerTransport` port: start the
  executor-harness image per run, re-attach the run's later steps to it (each step's
  harness job is keyed by the per-step `RunnerJobRef.jobId`), eviction-maps a vanished
  container). HOW it talks to the runtime is delegated to a `ContainerRuntimeAdapter`
  (`src/runtimes/*`), selected by `LOCAL_CONTAINER_RUNTIME` (docker | podman | orbstack |
  colima | apple): **Docker/Podman/OrbStack/Colima** share the Docker-CLI adapter
  (`docker run`, publish `:8080` to an ephemeral host port read with `docker port`,
  `cat-factory.runId` label), while **Apple `container`** has its own adapter
  (VM-per-container: `container run` addressed by a deterministic name, connect to the
  container's own IP, no Docker-in-Docker). Each adapter exposes a `localDind` capability;
  the local facade threads it into `ExecutionService` as `localTestInfraSupported` so a
  runtime that can't nest containers (Apple) **refuses a local-infra Tester run at start**
  ("limited mode" — steer to the ephemeral env or a no-infra service; see
  `tester-infra.logic.ts`). GitHub is reached via a **PAT** (`GITHUB_PAT` →
  `mintInstallationToken`) instead of a GitHub App. `buildLocalContainer` reuses ALL of Node's persistence/
  pg-boss/gateways and only swaps the runner transport + the GitHub token/client seams;
  `startLocal()` reuses Node's `start()`. The harness itself opens the PR via the PAT,
  and the **CI gate + merge / mergeability providers are wired from a PAT-backed
  `FetchGitHubClient`** (`createLocalGitHubClient`), so a local pipeline gates on real
  GitHub Actions CI and **merges the PR for real**. Repo resolution is unchanged (the
  `github_repos`/`github_installations` projection); the `linkRepo` helper (+ CLI) seeds
  those rows from PAT-read repo metadata since there is no GitHub-App connect flow.
- `backend/internal/executor-harness` — the payload that runs **inside** each
  per-run Cloudflare Container (the Pi coding-agent harness). Published to **npm**
  (its zero-dependency `dist/server.js` is the entry `@cat-factory/local-server`
  spawns in local native mode), and its multi-arch Docker image is published
  publicly to **GHCR + Docker Hub** by `docker-publish.yml` (or manually via the
  package's `image:publish` script / `scripts/publish-image.sh`). Its version is
  both the npm version and the Docker image tag.
- `backend/internal/benchmark-harness` — headless agent benchmarking (`cat-bench`);
  private, not published.
- `backend/internal/smoketest-harness` — `@cat-factory/smoketest-harness`, a headless
  **smoketest** for the Pi coding agent (`cat-smoke`): runs real coding tasks through the
  actual Pi setup against Cloudflare AI, captures the full transcript, and flags breakage /
  dead-ends / non-productive loops (no grading — that's the benchmark harness). Private.
- `backend/internal/deploy-harness` — `@cat-factory/deploy-harness`, the container payload
  that renders a service's **Kubernetes manifests** (kubectl/kustomize/helm) and applies
  them to a per-PR namespace for ephemeral environments. Carries no secrets (the per-job
  cluster + git tokens arrive in the job body). Private; its own Docker image.
- `backend/internal/e2e` — `@cat-factory/e2e`, the **Playwright end-to-end suite** (see
  "End-to-end (assembled-product) coverage" below): a real Chromium drives the real SPA
  against a real Node backend, only the external deps faked. Private.
- `backend/internal/conformance` — `@cat-factory/conformance`, the private
  **cross-runtime conformance suite** + the single canonical deterministic
  `FakeAgentExecutor`. `defineConformanceSuite(harness)` runs the key backend
  behaviour against any facade; both runtimes' test suites invoke it (see below).
- `backend/internal/example-custom-agent` — `@cat-factory/example-custom-agent`, a
  private **worked example** of a company-authored agent package: an inline `org-reviewer`
  - a container `security-auditor` (`container-explore` structured, a post-op rendering
    `compliance/REPORT.md` via `RepoFiles.commitFiles`, presented through
    `generic-structured`) + the `pl_org_audit` pipeline, registered purely via the public
    app-owned registries (`registerExampleCustomAgents(agentKindRegistry, presets, gateRegistry,
    stepResolverRegistry, pipelineRegistry)` — by reference, no module-global side effect). Proves
    a brand-new repo-writing agent ships with ZERO harness changes. See **Custom agents** below.
- `deploy/backend` — example Worker deployment: a one-line `src/index.ts`
  re-exporting `@cat-factory/worker` + the full production `wrangler.toml`
  (`[vars]`, the GHCR runner `image`, `migrations_dir` →
  `node_modules/@cat-factory/worker/migrations`).
- `deploy/node` — example **Node.js service** deployment: a one-line `src/main.ts`
  calling `@cat-factory/node-server`'s `start()`, a `Dockerfile` (builds from the repo
  root, then `pnpm install --prod` prunes to runtime deps — no `pnpm deploy`/`--legacy`),
  and an `.env.example`. Env-driven (`DATABASE_URL` required); the scripts load `.env`
  via Node's native `--env-file-if-exists`, and the entry runs via Node 24/26 **type
  stripping** (no build step for this package).
- `deploy/local` — example **local-mode** deployment: a one-line `src/main.ts` calling
  `@cat-factory/local-server`'s `startLocal()`, a `docker-compose.yml` (local Postgres
  only — the orchestrator runs on the host so it can drive the Docker daemon to spawn
  agent containers), and an `.env.example` (`LOCAL_HARNESS_IMAGE`, `GITHUB_PAT`,
  `DATABASE_URL`). Like `deploy/node`, the entry runs via Node type stripping.
- `deploy/frontend` — example Pages deployment: a thin Nuxt app that `extends` the
  `@cat-factory/app` layer + the Pages `wrangler.toml`. `NUXT_PUBLIC_API_BASE` is
  baked in at `nuxt generate` time.

## Updating dependencies (the `minimumReleaseAge` supply-chain gate)

Installs run behind a **`minimumReleaseAge` gate** (configured in the managed
environment, ~24h): pnpm strictly verifies the lockfile and **rejects any registry
package published more recently than the cutoff** (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`).
The allow-list is `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. The policy for it:

- **Only ever list wildcard namespaces WE OWN** there — today `@cat-factory/*` and
  `@toad-contracts/*`. Our own freshly-published packages are trusted and must never be
  age-gated, so a wildcard (not per-version pins) keeps them installable the moment they
  publish.
- **Never add a per-version exception for a third-party package** (`some-pkg@1.2.3`), and
  do not let a non-strict `pnpm install` auto-append them — if you see third-party entries
  accrue in `minimumReleaseAgeExclude`, delete them. (pnpm's non-strict mode silently
  appends a pin for every too-new version it resolves; that churn is exactly what this
  policy forbids.)
- **When upgrading, pick the latest version that already satisfies the release-age rule**,
  not the absolute newest. Concretely: find the newest version published before the cutoff
  (`npm view <pkg> time --json`), stay within the compatible major (see the AI-SDK pin
  below), and set that as the range. If `pnpm install`/`update` resolves something too new,
  pass the explicit compliant version (`pnpm update -r <pkg>@<compliant-version>`) rather
  than excluding it. A dep whose only newer releases are all inside the cutoff window stays
  where it is until they age out.
- **Do not touch the executor-harness** (`backend/internal/executor-harness`) during a
  dependency sweep — its deps feed the published runner image (see the image-tag rules
  below), so bumping them is a separate, deliberate, image-bumping change.
- **The Vercel AI SDK family (`ai`, `@ai-sdk/*`) is held to the major that pairs with
  `workers-ai-provider`.** `workers-ai-provider`'s peers require `ai@^6` + `@ai-sdk/*@^3`
  (provider/openai/anthropic), so do NOT bump `ai` to v7 (or the `@ai-sdk/*` packages past
  their `ai@6`-compatible majors) until `workers-ai-provider` ships a release whose peers
  accept it. Upgrade only within those majors.

## Releases & changesets

- Versioning/publishing is [changesets](https://github.com/changesets/changesets)
  (`.changeset/config.json`, root `pnpm changeset` / `ci:publish`). Public packages
  publish to npm; `deploy/*` + `benchmark-harness` are `ignore`d;
  `executor-harness` publishes to npm too and its version doubles as the Docker
  image tag.
- **Always add a changeset for any change to a versioned package**, and bump
  `@cat-factory/executor-harness` whenever you touch what goes into its image
  (`src/**`, `Dockerfile`, `tsconfig.json`, the pinned `PI_*` args). Empty changeset
  (`pnpm changeset --empty`) for docs/CI/test-only changes. Full rules + file format
  in [`CONTRIBUTING.md`](./CONTRIBUTING.md). CI enforces this (`changeset status`).
- `.github/workflows/release.yml` runs changesets on push to `main`;
  `docker-publish.yml` republishes the runner image (multi-arch, GHCR + Docker Hub),
  gated on image-affecting paths (incl. the harness `package.json`, so a version
  bump re-tags the image). Docker Hub is gated on the `DOCKERHUB_USERNAME` /
  `DOCKERHUB_TOKEN` repo secrets; absent them it publishes GHCR only.
- **Any change that affects the runner image MUST bump the image tag** (the harness
  `src/**`, `Dockerfile`, `tsconfig.json` or the pinned `PI_*` args). Bump
  `@cat-factory/executor-harness`'s `version` AND the matching tag in BOTH
  `deploy/backend/package.json` (`image:publish`) and `deploy/backend/wrangler.toml`
  (`[[containers]] image`), AND `RECOMMENDED_HARNESS_IMAGE` in
  `backend/runtimes/local/src/harnessImage.ts` (the tag local mode pins + pulls at boot,
  so the image and the Node/local backend stay a matched set — a changeset-published
  `@cat-factory/local-server` then carries the right image), then `pnpm image:publish` +
  `pnpm deploy` from `deploy/backend`. The deployment serves the **Cloudflare managed-registry** image
  (`registry.cloudflare.com/<acct>/cat-factory-executor:<tag>`), NOT the GHCR image,
  so the GHCR auto-publish does not roll it out. Reusing the same tag does NOT
  deploy: `wrangler deploy` diffs the image by tag string, reports
  `no changes cat-factory-backend-executioncontainer`, and the container application
  stays pinned to the OLD digest — so new per-run containers keep running stale code
  (a missing harness route then 404s as `Container dispatch failed (HTTP 404)`). A
  fresh, immutable tag is what forces the rollout.
- **The release PR re-syncs the pins automatically — don't hand-fix a red release PR.**
  A harness bump in a feature PR ships a changeset, so when the changesets action builds
  the "Release Packages" PR it bumps the harness `version` a SECOND time (e.g. a manual
  `1.27.5` becomes `1.27.6`) while leaving the three hand-maintained pins behind — which
  used to be born as tag drift + red CI on the consistency guard. The root `version`
  script now runs `scripts/sync-runner-image-tags.mjs` after `changeset version`, so the
  release PR re-derives every pin from the freshly-bumped harness `version` and is
  consistent by construction. Consequence: the RELEASED tag is whatever changesets
  computed (`1.27.6`), which may differ from the tag the feature PR published (`1.27.5`);
  the content is identical, and `docker-publish.yml` re-tags GHCR off the version bump,
  but the Cloudflare managed-registry image for the released tag is only built when
  someone next runs `pnpm image:publish` + `pnpm deploy`. Run `pnpm sync:image-tags`
  locally if you ever need to reconcile the pins by hand;
  `scripts/check-runner-image-tag.mjs` is the CI guard that verifies the same invariant.

## Adding a new published package

A new library under `backend/packages/<name>` is **not** wired up just by creating the
folder. Miss one of these registries and it builds locally but ships broken (the classic
failure: `@cat-factory/gitlab` + `@cat-factory/provider-s3` once published as **empty
shells** — a `package.json` with no `dist/` — because a bare `pnpm publish` skipped the
build and `dist/` is gitignored). The checklist:

- **`package.json` must carry the full publish contract**, copied from an existing leaf
  package (e.g. `packages/gates`): `"files": ["dist"]`, `"main"`/`"types"`/`"exports"`
  pointing at `./dist`, `"publishConfig": { "access": "public" }`, a `"build": "tsc -b
tsconfig.build.json"` script, AND a **`"prepublishOnly": "pnpm run build"`** hook. The
  `prepublishOnly` hook is mandatory and non-negotiable: `dist/` is gitignored, so without
  it any publish path that doesn't pre-build (a bare `pnpm publish`, a one-off
  `changeset publish`) ships an empty shell. The canonical `pnpm ci:publish` builds first,
  but the hook is the guardrail for every other path.
- **Register it in `backend/tsconfig.build.json`** — add `{ "path":
"packages/<name>/tsconfig.build.json" }` to the `references` array. This is the
  solution-style build graph that `pnpm build:tsc` (and the incremental project-reference
  build) walks. A package reachable only transitively (because some runtime happens to
  reference it) builds today but silently drops out the moment that reference goes away;
  list every publishable library here directly.
- **No pnpm-workspace edit needed** — `pnpm-workspace.yaml` globs `backend/packages/*`, so
  the package is picked up automatically. (`deploy/*` are listed individually, but library
  packages are not.)
- **Add a changeset** (`pnpm changeset`) — CI's `changeset status` gate fails the PR
  otherwise. A brand-new package still needs an initial-release changeset.
- **Add a row to README.md's repository-layout tables** — CI's
  `node scripts/check-package-catalog.mjs` guard fails the `Build & typecheck` job for any
  workspace package missing from the map. (This is what bit the `@cat-factory/caching`
  pilot PR.)
- **Check knip knows about any dynamically-loaded dependency** — a dep referenced only via
  an opaque dynamic import (`import('pkg' as string)`) is invisible to knip's static
  analysis and fails `pnpm lint:knip` as "unused"; add an `ignoreDependencies` entry with a
  comment in `knip.jsonc` (the `ioredis`/`layered-loader` pattern).
- **Keep the runtimes symmetric** if the package is a shared behaviour both facades must
  wire (see "Keep the runtimes symmetric").

After wiring, verify with a clean build + a publish dry-run from the package dir:
`rm -rf dist && pnpm publish --dry-run --no-git-checks` — it must run `prepublishOnly`,
rebuild `dist/`, and list the compiled files in the tarball.

## Run the CI guard scripts locally before committing

CI's `Build & typecheck` job runs a set of fast repo guards BEYOND build/typecheck/tests,
and a locally-green branch fails CI when one of them is skipped. **Before committing —
always after adding/renaming a package, touching dependencies, or bumping the harness —
run the guards your change class can trip:**

- `node scripts/check-package-catalog.mjs` — every workspace package must have a row in
  README.md's repository-layout tables.
- `node scripts/check-file-size.mjs` — soft max-lines budget (default 1,500) for non-test
  source files, with ratcheted allowances for the legacy oversized files (the engine
  god-file re-accretion guard). Grew a file past its budget ⇒ split it along a cohesive
  seam (the `RunDispatcher` controller extractions are the model), or deliberately adjust
  the allowance in the same PR.
- `pnpm exec changeset status --since=origin/main` — every changed versioned package needs
  a changeset (run after committing locally; it diffs git refs).
- `pnpm lint:knip` — unused files/deps/exports (run after `pnpm build`); remember
  dynamically-imported deps need a `knip.jsonc` ignore entry.
- `pnpm lint:monorepo` (sherif) — cross-package dependency-version consistency.
- `pnpm check:publish` (publint + attw, after `pnpm build`) — publish-artifact integrity
  for every publishable package.
- `node scripts/check-runner-image-tag.mjs --since origin/main` — harness image-tag
  consistency, whenever anything image-affecting changed.
- `pnpm lint:fix` (whole tree, per the formatting rule above) and
  `pnpm exec turbo run typecheck --filter=<each touched package>` (typecheck covers tests,
  which the build configs exclude).

The full `pnpm test:run` matrix is CI's job; the guards above are cheap enough to run
every time and catch the failures a plain build+test loop misses.

## Execution flow (the canonical async + observable pattern)

This is the gold-standard pattern for long-running agent work. Anything new that
runs an agent in a container should mirror it.

1. `ExecutionService.start()` (orchestration `src/modules/execution/ExecutionService.ts`)
   creates an `ExecutionInstance` with steps and hands off to the durable driver.
2. `ExecutionWorkflow` (worker `infrastructure/workflows/ExecutionWorkflow.ts`) —
   one Cloudflare **Workflows** instance per run, addressed by execution id.
   Loops calling `advanceInstance`, parking on `waitForEvent` for human
   decisions. A cron sweeper re-drives runs whose Workflows instance died.
3. `ContainerAgentExecutor` (worker `infrastructure/ai/ContainerAgentExecutor.ts`)
   — `startJob()` dispatches the job **asynchronously** (`/run`, non-blocking,
   returns a `jobId`); `pollJob()` polls and lifts `view.progress` → `subtasks`.
4. Inside the container, `runPi()` (`executor-harness/src/pi.ts`) streams
   Pi's JSON-line events; `parseTodoProgress()` turns the todo tool's output into
   `{completed, inProgress, total}` via the `onProgress` callback →
   `JobRegistry` (`src/runner.ts`) → exposed on the `/jobs/{id}` `JobView.progress`.
5. `ExecutionService.pollAgentJob()` writes `step.subtasks`/`step.progress`,
   `executionRepository.upsert()`, then `emitInstance()`.
6. Events reach the browser by **push, not polling**:
   `DurableObjectEventPublisher.executionChanged()` →
   `WorkspaceEventsHub` Durable Object (`/publish`, hibernatable WebSockets,
   one per workspace) → broadcast → SPA `useWorkspaceStream.ts` →
   `execution.upsert()` store → `TaskExecution.vue` / `PipelineProgress.vue`
   render the `{completed}/{total}` subtask bars.

## Repo bootstrap flow (ASYNC + observable + board-integrated)

The "bootstrap repo" task adapts a reference architecture (or scaffolds from
scratch) into a **pre-created, empty** GitHub repo and force-pushes the result.
It mirrors the execution pattern above: dispatch → durable poll → push events.

- Trigger: SPA `components/bootstrap/BootstrapModal.vue` → `stores/bootstrap.ts`
  → `POST /workspaces/:ws/bootstrap/jobs`. The call returns **immediately** with a
  `running` job (the container keeps working in the background).
- `BootstrapService.bootstrap()` (orchestration `src/modules/bootstrap/BootstrapService.ts`):
  pre-flight GitHub connection → insert a `bootstrap_jobs` row as `running` →
  `repoBootstrapper.startBootstrap()` (dispatch, returns once accepted) →
  materialise a **provisional service frame** (a real `Block`, `level:'frame'`,
  `status:'in_progress'`, titled from the repo; its id is stored on the job's
  `block_id`) → `bootstrapRunner.startRun()` to kick the durable driver → return
  the running job. A pre-flight/dispatch failure returns a `failed` job with **no**
  frame left behind.
- `BootstrapWorkflow` (worker `infrastructure/workflows/BootstrapWorkflow.ts`) —
  one Cloudflare Workflows instance per job (id = bootstrap job id; binding
  `BOOTSTRAP_WORKFLOW`). Loops calling `BootstrapService.pollBootstrapJob()`
  inside retriable `step.do`s, sleeping durably between polls.
- `pollBootstrapJob()`: polls the container once via
  `repoBootstrapper.pollBootstrap()`; while running, writes changed `subtasks` and
  emits a `bootstrap` event; on **success** marks the job `succeeded`, calls
  `repoBootstrapper.linkRepoToBlock()` (upserts the new repo into the
  `github_repos` projection + sets `block_id`) and flips the frame to `ready`; on
  **failure** marks the job `failed` and the frame `blocked`. It is idempotent
  (terminal jobs return as-is) so the driver's retries/replays are safe.
- `ContainerRepoBootstrapper` (worker `infrastructure/ai/ContainerRepoBootstrapper.ts`):
  a **thin layer on the generic runner seam**, mirroring `ContainerAgentExecutor`.
  `startBootstrap` pre-flights (target exists, reachable, empty — only
  README/.gitignore/license/**AGENTS.md** tolerated, see `isBootstrapBoilerplate`),
  mints GH + proxy tokens, builds the job body, then dispatches via the shared
  `RunnerJobClient` → `resolveTransport(workspaceId).dispatch(jobId, body,
'bootstrap')` (no direct `EXEC_CONTAINER`; backend-polymorphic — Cloudflare
  always, a self-hosted pool throws a clean "unsupported" until it implements the
  kind). `pollBootstrap` `RunnerJobClient.poll`s and maps the `RunnerJobView` to
  running (with subtasks) / done (outcome, from `result.defaultBranch`) / failed
  (`classifyBootstrapFailure`: `evicted` on a 404-mapped view, `timeout` on a
  watchdog kill, else `agent`). `stopBootstrap` → `RunnerJobClient.release`.
- Harness: `/bootstrap` starts a **background job** in a `JobRegistry` (the same
  generic registry as `/run`), keyed by the job id; `handleBootstrap()`
  (`executor-harness/src/bootstrap.ts`) threads `onProgress`/`signal` so Pi's
  todo-tool counts surface as `subtasks`. Sequence: clone (or empty dir) →
  `writeAgentsContext()` writes the prompt to Pi's **global** `~/.pi/agent/AGENTS.md`
  (outside the checkout, so it never lands in the bootstrapped repo) → `runPi()`
  adapts → `reinitAndPush()` resets history to one commit and **force-pushes** to
  the default branch.
- Events: `DurableObjectEventPublisher.bootstrapChanged()` → `WorkspaceEventsHub`
  → SPA `useWorkspaceStream.ts` patches `stores/agentRuns.ts` (`upsertBootstrap`)
  - the board block. `BlockNode.vue` reads `agentRuns.byBlock[frameId]` to render
    the "bootstrapping…" badge + subtask progress bar, flipping to a ready service or
    the shared `<AgentFailureCard>` (failure hint + retry). Tracing logs (pino) run
    controller→service→workflow→bootstrapper→harness, queryable in the Cloudflare
    dashboard.

## Service blueprints flow (in-repo map + board population)

A **Blueprinter** agent decomposes a repo into the canonical service → modules
tree and persists it **in the repo** under `blueprints/`, then the board is
reconciled from it. It is modelled as a normal pipeline step (`agentKind:
'blueprints'`), so it reuses the whole execution engine — no separate durable
runner. The map intentionally stops at modules: tasks are authored by people, not
derived from the blueprint (there is no longer a "feature" granularity level).

- In-repo artifact (`blueprints/`, rendered deterministically by the harness from
  the coerced tree): `blueprint.json` (canonical `BlueprintService`), `overview.md`
  (high-level, read first), `modules/<slug>.md` (deep-dive per module), and
  `version.json` (a tiny manifest — monotonic version + content hash + counts — for
  quick staleness checks). Strict shape enforced by `parseBlueprintService`
  (Valibot) at ingest; the harness coerces leniently then the worker/core validate.
- Harness: `handleBlueprint` (`executor-harness/src/blueprint.ts`) clones the
  target branch, reads any existing blueprint (update mode), runs Pi to emit the
  tree, renders the files, and **commits onto that branch** (no history reset /
  force-push) via `commitAll`+`pushBranch`. Served at `POST /blueprint`, polled on
  the shared `/jobs/{id}`. Every agent's global `~/.pi/agent/AGENTS.md` carries
  `BLUEPRINT_GUIDANCE` (pi.ts): read `overview.md` first, open a module file only
  when relevant.
- Worker: `ContainerAgentExecutor` builds a blueprint job for the `blueprints` kind
  — branch = the prior `coder` step's PR branch (`block.pullRequest.branch`) when
  present (mode `update`), else the repo default branch (mode `create`) — and
  dispatches it via `RunnerTransport.dispatch(id, body, 'blueprint')` (Cloudflare
  container only; `CompositeAgentExecutor` routes the kind to the container
  executor). The returned tree maps to `AgentRunResult.blueprintService`.
- Core: `ExecutionService.recordStepResult` ingests that tree — strict-parse, then
  `BoardScanService.reconcileBlueprint(frameId, service)` updates the run block's
  **service frame** in place (match modules by name, add missing, refresh
  descriptions, **never delete**, and never touch the authored tasks inside them),
  and emits a `board` event so the SPA refreshes.
- Triggers: `blueprints` is inserted after `coder` in the default pipelines (so the
  map + board refresh on the same implementation PR branch), and
  `BootstrapService.pollBootstrapJob` success starts the blueprint-only
  `pl_blueprint` pipeline against the new frame (best-effort) to create the initial
  map. A mapping-only run leaves a frame `ready` (not `done`).
- Nothing is persisted to a blueprint table: the in-repo `blueprints/` files are the
  source of truth and the board is the projection. There is **no** standalone "scan
  repository" command — repository decomposition is always the `blueprints` pipeline
  agent (which runs through the runner transport, so it works on every backend);
  `BoardScanService` is purely the reconciler the engine drives with its result.

## Requirements review flow (iterative gate step + dedicated window)

`requirements-review` is the FIRST step of the default pipelines — a special engine
gate (handled in `ExecutionService.evaluateRequirementsReview`, like `ci`/`conflicts`,
NOT a container/prose agent). The reviewer inspects a block's "collected requirements"
(description + linked PRD/RFC docs + tracker issues) and raises items, each with a
**severity**. The run **parks** on a durable decision-wait and the dedicated structured
window drives an iterative loop until the reviewer converges; only then does the run
advance to the architect. Every reviewer/incorporation call runs an LLM inline (via the
`ModelProvider` port) and returns the updated review, which the SPA patches directly.

The loop (one reviewer pass = one **iteration**; the initial review is iteration 1):

1. Reviewer raises findings → human **answers** the relevant, **dismisses** the irrelevant.
2. An **incorporation companion** folds the answers into ONE standard-format document
   (`incorporate`, status `merged`). The human inspects it and either re-reviews or
   **redoes** the merge with a freeform "do it differently" comment.
3. **Re-review** runs the reviewer against that document (`iteration++`). It converges
   (`incorporated` → the run advances), continues (`ready` → answer the new findings) or
   hits the cap (`exceeded`).
4. At the cap the human picks: **extra-round** (one more pass), **proceed** (advance with
   the last incorporated doc) or **stop-reset** (`cancel()` → block `planned`/editable;
   the last incorporated doc survives on the inspector as a base to rework from).
5. **Auto-pass**: if every outstanding finding is at or below the task's tolerated
   severity (`maxRequirementConcernAllowed`), the findings are recorded but the run
   advances with no human gate and no incorporation. All findings dismissed → **proceed**.

The cap + tolerated severity are per-task on the **merge preset** (`maxRequirementIterations`
default 6, `maxRequirementConcernAllowed` default `none`). There is NO quality-companion
grade gate any more — convergence is reviewer-driven.

- Wire contracts: `contracts/src/requirements.ts` (`RequirementReview` +
  `RequirementReviewItem`; review `status` ∈ `ready`/`merged`/`exceeded`/`incorporated`,
  plus `iteration`/`maxIterations`; `incorporateRequirementsSchema` carries the redo
  `feedback`; `resolveRequirementsExceededSchema` carries the choice). One **live review
  per block**. The document lives on `review.incorporatedRequirements`.
- Core: `RequirementReviewService` (`modules/requirements/`) — `review()`/`reReview()`
  generate items (reReview reviews the incorporated doc), `replyToItem()`/`setItemStatus()`
  mutate items, `incorporate()` requires no `open` items then runs the rework LLM (folding
  in the redo `feedback` + prior doc), `markIncorporated()`/`grantExtraRound()` settle the
  loop. `ExecutionService.{reReviewRequirements,proceedRequirements,resolveRequirementsExceeded}`
  call the service then drive the parked run (`resumeRequirementsRun` advances + signals;
  stop-reset cancels). The pure `disposeReview(items, {iteration,maxIterations,
concernThreshold})` (`requirements.logic.ts`) decides auto-pass / awaiting / exceeded.
  `REWORK_SYSTEM_PROMPT` (`@cat-factory/agents`) enforces the standard doc structure.
  Pass-through when the reviewer model isn't wired (tests/conformance) so pipelines run
  unchanged. Assembled by `createRequirementsModule` whenever `requirementReviewRepository`
  is wired (and passed into `ExecutionService` as `requirementReviewService`).
- Downstream consumption: `ExecutionService.resolveReworkedRequirements` reads the
  block's incorporated review (optional `requirementReviewRepository` dep). When
  present, `buildAgentContext` uses it as the block description (only for `task`-level
  blocks — reviews are task-scoped, so frame/module steps skip the lookup) and
  **drops** `contextDocs`/`contextTasks` (already folded in). The spec-writer then
  receives that same reworked description as its single-task input and applies it as an
  increment onto the baseline spec already committed on the branch (it is NOT a
  service-wide aggregate — an unmerged sibling task is invisible). Absent → original
  behavior. The rework LLM call rejects a length-truncated document (it would become a
  silently-incomplete spec for every downstream agent) rather than persisting it.
- Persistence: `requirement_reviews`, mirrored on **both** runtimes (parity is
  mandatory): the Cloudflare D1 table (`D1RequirementReviewRepository`) and the Node
  Postgres table (Drizzle `requirementReviews` in `db/schema.ts` +
  `DrizzleRequirementReviewRepository`, generated migration under `runtimes/node/drizzle/`).
  Items as a JSON column; `iteration`/`max_iterations` columns track the loop; the old
  `companion` column is gone. `getByBlock` returns the current one. Both facades wire the
  repo + model provider; the cross-runtime conformance suite asserts the agent-context
  substitution against both stores.
- Controller (shared `@cat-factory/server`): `RequirementReviewController` mounts
  `GET|POST /blocks/:blockId/requirement-review`, `POST /requirement-reviews/:id/items/:itemId/reply`,
  `PATCH …/items/:itemId`, `POST /requirement-reviews/:id/incorporate` (reviewId-scoped,
  no run drive), and the run-driving `POST /blocks/:blockId/requirement-review/{re-review,
proceed,resolve-exceeded}` (via `container.executionService`). Each facade wires the
  review repo + a model provider + the routing default ref + `resolveBlockModel`, so the
  reviewer resolves its model like an agent step (block pin > workspace default >
  Cloudflare Workers AI).
- Frontend: `stores/requirements.ts` (load/review/reply/setItemStatus/incorporate/
  reReview/proceed/resolveExceeded) +
  `components/requirements/RequirementsReviewWindow.vue` — the loop UI (answer/dismiss →
  incorporate → inspect doc → re-review or redo-with-comment → proceed; the 3-choice
  prompt on `exceeded`; "Iteration N / M"). It opens via the **universal result-view
  seam** (see "Conventions"), not a hardcoded mount. `InspectorPanel.vue` freezes a
  task's raw description once `incorporated` (the standardized doc takes focus), and after
  a stop-reset surfaces the last incorporated doc read-only as a base.

## Implementation-fork decision flow (two-phase Coder step: propose → park → choose)

An OPTIONAL phase on the Coder step (`agentKind: 'coder'`, the `build` phase) that surfaces
the **materially different ways to implement a task** BEFORE any code is written, then parks for
a human to pick one, enter their own approach, or **chat** about the forks. It rides the run's
coder step (`step.forkDecision`) — no side table — so it is runtime-symmetric by construction,
exactly like `followUps`. Gated on the task Estimator's estimate via the workspace risk policy
(`riskPolicySchema.forkDecision`, reusing `stepGatingSchema`) plus a per-task tri-state
(`coder.forkDecision` ∈ `auto`/`always`/`off`). Full design + rationale:
[`backend/docs/adr/0022-coder-fork-decision.md`](./backend/docs/adr/0022-coder-fork-decision.md).

A container job can't pause mid-run, so the human park sits BETWEEN two dispatches on the same
coder step:

- **Phase A (propose)** — `RunDispatcher.handleForkDecisionPhase` resolves the tri-state + the
  risk-policy fork gate (`forkDecision.logic.ts`). Not proposing → `step.forkDecision.status =
'skipped'`, fall through (the Coder runs). Proposing → dispatch the read-only **`fork-proposer`**
  explore kind (`container-explore`, structured JSON → `result.custom`) as a HELPER off the coder
  step (`status: 'proposing'`). Its completion is caught by the `fork-proposal` interceptor →
  `ForkDecisionController.recordProposal`: `singlePath` or <2 usable forks ⇒ `single_path`
  (re-arm the step, no park, the Coder runs against the one fork); else mint fork ids, raise a
  `fork_decision_pending` notification, and `parkStepOnDecision`.
- **Human interaction** (`awaiting_choice`) — pick a fork / type a custom approach / **chat**, via
  the dedicated `fork-decision` result-view window. Chat rides the transient re-entry protocol
  (the `pendingIncorporation` template): `ForkDecisionController.chat` CAS-appends the human turn,
  sets `status: 'answering'` + `step.pendingForkChat = { messageId }`, flips `blocked → running`,
  and signals the driver (reason `fork-chat`). The `reentrantForkDecision` guard in
  `ExecutionService.stepInstance` falls through so `handleForkDecisionPhase` re-enters →
  `ForkDecisionController.answerChat` computes the grounded reply INLINE in the durable driver
  (`ForkChatService`, DocInterview-style model resolution + metering) off the fixed proposal
  grounding + the thread, appends the assistant turn, and re-parks (a fresh approval id).
  `maxChatTurns` (default 15, human messages) is a hard budget (409 past it). **No chat model
  wired, or a responder failure ⇒ a canned "chat unavailable" assistant turn** and re-park —
  pick / custom still work (the pass-through the conformance suite asserts).
- **Phase B (implement)** — `ForkDecisionController.choose` CAS-records `forkDecision.chosen`
  (`status: 'chosen'`), re-arms the step (`resetStepForRerun` + `startStep`), and signals. On
  re-entry `forkPhasePending` is false, so `handleAgentStep` dispatches the Coder normally;
  `AgentContextBuilder` folds `buildImplementationChoice(step.forkDecision)` into
  `AgentRunContext.implementationChoice` (the chosen approach + the rejected alternatives), which
  `implementationChoiceSection` renders into the `build` prompt as a binding directive.

Pass-through everywhere it can't run (tri-state `off`, gate not met, proposer/chat unwired), so
pipelines without the feature — and the engine tests — behave exactly as before. Scoped to the
run's PRIMARY repo (single-repo tasks); per-repo fork sets are a follow-up.

## Merge lifecycle flow (CI gate → CI-fixer → merger → notifications)

The tail of a build pipeline turns an open PR into a merged one — gated on **real**
CI and a **real** GitHub merge, so a task is `done` only when its PR actually merged
(the old bug: a task showed "merged" — `block.status === 'done'`, rendered by
`TaskExecution.vue` — purely from a confidence score, while CI was red and the PR
still open). Two new container agent kinds plus a special gate step implement it.

- **`ci` step (a polling Gate — see "Gates vs agents" below)** — auto-inserted
  second-to-last in the standard pipelines, after all code-producing steps. It is NOT
  an LLM/container agent: its `GateDefinition` reads the PR head's GitHub check runs via
  the `CiStatusProvider` port (worker `GitHubCiStatusProvider`), aggregates them
  (`ci.logic.ts` → green / pending / failure / none), and the shared
  `ExecutionService.evaluateGate` acts: green/none → finish + advance (polling
  **stops**, the agent is never spun up); pending → `awaiting_gate` (the durable driver
  sleeps `ciPollInterval` then calls `pollGate`); failure → dispatch a `ci-fixer`
  container job (up to the task preset's `ciMaxAttempts`, default 10), else raise a
  `ci_failed` notification + fail the run. A finished fixer job returns the gate to
  `checking` (it never advances the step). Pass-through when no `CiStatusProvider` is
  wired (tests / no GitHub).
- **`ci-fixer` (container kind)** — `executor-harness/src/ci-fixer.ts` (POST
  `/ci-fix`): clones the PR head branch, runs Pi to make CI pass, commits + pushes
  back onto the **same** branch (no new PR). `ContainerAgentExecutor` builds the body
  with `agentKind` overridden to `ci-fixer` and dispatch kind `ci-fix`.
- **`merger` (container kind)** — the **last** standard-pipeline step.
  `executor-harness/src/merger.ts` (POST `/merge`) clones the PR head branch, scores
  the diff vs base (complexity / risk / impact, each 0..1) and returns ONLY a JSON
  assessment — it makes **no** commits. `ExecutionService.resolveMergerStep` parses
  the assessment, compares it to the task's resolved **merge threshold preset**, and
  either merges for real (the `PullRequestMerger` port → worker
  `GitHubPullRequestMerger` → `GitHubClient.mergePullRequest` → block `done`) or
  raises a `merge_review` notification leaving the block `pr_ready`. A pipeline with
  **no** merger raises a `pipeline_complete` notification (confirm + merge) instead of
  auto-`done`.
- **Merge threshold presets** — a per-workspace library
  (`merge_threshold_presets`; `MergePresetService` +
  `D1MergePresetRepository`; `GET|POST|PATCH|DELETE /workspaces/:ws/merge-presets`).
  A task selects one via `Block.mergePresetId` (the inspector dropdown in
  `TaskModelSettings.vue`); none → the workspace default (lazily seeded from
  `DEFAULT_MERGE_PRESET` in kernel). Carries the auto-merge ceilings + `ciMaxAttempts`
  - the requirements-review knobs `maxRequirementIterations` (default 6) and
    `maxRequirementConcernAllowed` (default `none`); see "Requirements review flow".
- **Notifications** — a first-class, human-actionable surface (NOT a mid-pipeline
  gate). `notifications` table + `NotificationService`
  (orchestration) behind a `NotificationChannel` port: the canonical row is persisted
  - the in-app `notification` `WorkspaceEvent` is pushed (worker
    `InAppNotificationChannel` over `DurableObjectEventPublisher.notificationChanged`),
    with `CompositeNotificationChannel` as the seam for **future email/Slack** channels.
    `NotificationController` mounts `GET /notifications`, `POST /notifications/:id/act`
    (merge / confirm / retry by type), `POST …/dismiss`. SPA: `stores/notifications.ts`
  - the toolbar `NotificationsInbox.vue`; the snapshot carries open notifications +
    the preset library.

## Post-release health flow (Datadog gate → Agent-On-Call → notify/enrich)

After a release ships, the **`post-release-health`** gate (the LAST standard-pipeline
step, after `merger`) watches the team's Datadog monitors/SLOs for a window and, on a
regression, spawns an **`on-call`** agent to investigate — it never auto-reverts.

- **Polling gate** (a `GateDefinition` in `buildGateRegistry`, not a copy of the
  machinery): `wired()` = a `ReleaseHealthProvider` is configured; `probe()` reads the
  block's monitors/SLOs since a **release marker** (`step.gate.watchSince`, set on first
  entry) and combines the verdict with the watch window via `classifyReleaseHealth`
  (`release.logic.ts`) → `pass` (healthy + window elapsed; or no monitors configured →
  pass through immediately), `pending` (keep polling), `fail` (a monitor alerts / SLO
  breached). `attemptBudget` = the merge preset's `releaseMaxAttempts` (default 1);
  the window is `releaseWatchWindowMinutes` (default 30).
- **Provider**: the kernel `ReleaseHealthProvider` port is vendor-neutral and served by the
  pluggable `RegistryReleaseHealthProvider` (`integrations/modules/observability`) — a registry
  of per-vendor adapters (today only `DatadogObservabilityAdapter`, `integrations/modules/datadog`,
  which reads monitor state + SLO SLI-vs-target and recent error logs). The composite owns
  connection loading + decryption, config resolution up the frame chain, and the verdict
  reduction; an adapter is just the vendor reads, so a second provider is a new registry entry.
  Observability creds live on the backend (`observability_connections`: a `provider` discriminator
  - one sealed `credentials` JSON blob + a non-secret `summary`, sealed `cat-factory:observability`)
    — never in containers. Per-block monitor/SLO mapping is `release_health_configs` (resolved up the
    frame chain). Both tables mirror D1 ⇄ Drizzle; managed via `ReleaseHealthService` + the
    `GET|PUT|DELETE /workspaces/:ws/observability/connection` + `…/release-health-configs/:blockId`
    controller. The SPA splits this: the connection is an **Integrations** entry
    (`ObservabilityConnectionPanel.vue`), while the per-service monitor/SLO mapping lives in the
    **service inspector** (`ServiceReleaseHealthConfig.vue`, keyed by the selected frame's block id —
    no manual entry, disabled with a hint until a connection exists). Both use `stores/releaseHealth.ts`.
- **On-call agent** (`on-call` container kind, `executor-harness/src/on-call.ts`, `/on-call`):
  the gate escalates via `gatherHelperPriorOutputs` (renders the evidence bundle into the
  agent's prompt). The agent clones the released PR head, correlates the diff with the
  evidence, and returns ONLY a JSON assessment (`onCallAssessment`: culprit confidence +
  `revert`/`hold`/`monitor`). Its completion is resolved SPECIALLY (not the generic gate
  re-probe): `ExecutionService.resolveOnCallStep` parses it, raises a `release_regression`
  notification (Slack + in-app inbox), best-effort **enriches** any incident PagerDuty /
  incident.io already opened (the `IncidentEnrichmentProvider` port — annotate, NOT
  re-alert, since those systems page off the same signals), then finishes the gate step so
  the run completes (the human decides revert/acknowledge out-of-band).

## Gates vs agents (the step taxonomy)

A pipeline step's `agentKind` puts it in one of three buckets. Most engine handling
keys off which bucket, so know them before adding a step:

- **Agents** — a container or inline LLM does the work (`coder`, `architect`,
  `spec-writer`, `tester`, `merger`, the companions, …). Dispatched via the shared
  `CompositeAgentExecutor`; container kinds park on `awaiting_job`.
- **Polling Gates** — `ci`, `conflicts`, `post-release-health`. A gate is NOT an agent: it
  runs a **programmatic precheck** against a provider and only escalates to a helper
  container agent (`ci-fixer` / `conflict-resolver` / `on-call`) on a negative verdict. The
  skip-unless-needed contract is the whole point: a green CI / mergeable PR advances with
  **nothing spun up**. One generic machine drives every gate —
  `ExecutionService.evaluateGate` / `dispatchGateHelper` / `pollGate`, parking on the single
  `awaiting_gate` result while the precheck is pending. A gate is a `GateDefinition` supplying
  only its differentiators: `wired()`, the `probe()` (→ `pass` / `pending` / `fail`), the
  `helperKind`, and `onExhausted`. The live loop state is `step.gate` (`GateStepState`:
  `phase` `checking`/`working`, `attempts`, `maxAttempts`, `headSha`); the gate kind is
  `step.agentKind`, not stored twice. **Adding a gate is a new registry entry, not a new copy
  of the machinery** — do not hand-roll another `evaluateX`/`pollX`/`awaiting_x` triple.
  - **The built-in gates are NOT inline in the engine** — they ship as the
    **`@cat-factory/gates`** package and register through the SAME public seam a deployment
    uses (the dogfood: the platform's own gates ARE an external package). The gate registry is
    an **app-owned `GateRegistry` instance** (`kernel/domain/gate-registry.ts`,
    `defaultGateRegistry()`), NOT a module-global `Map`: each facade builds one, installs the
    built-ins via `registerBuiltinGates(gateRegistry)` (the module-load side-effect is gone),
    and threads it through `CoreDependencies.gateRegistry` → the engine builds its per-kind gate
    map from `this.gateRegistry.factories()`. `defaultGateRegistry()` is EMPTY (the built-ins
    live in the gate package), so a container built with no injected registry — e.g. the Worker's
    scheduled `buildContainer(env)` — installs them itself. A deployment adds a gate with
    `gateRegistry.register(kind, factory)` on the injected instance. Each gate's provider is still
    wired deployment-global via the package's `wireCiStatusProvider` /
    `wireMergeabilityProvider` / `wireReleaseHealthProvider` / `wireIncidentEnrichment` handles
    (the provider-token registry has not migrated to DI yet). A gate is a pass-through until its
    provider is wired. The pure gate logic + the gate/helper agent-kind constants live in kernel
    (`domain/gate-logic.ts`) so a gate package never depends on orchestration. **Step-completion
    resolvers ride the analogous `StepResolverRegistry` on `CoreDependencies`.**
  - **`resolveHelperCompletion`** is the gate seam for an INVESTIGATE-don't-fix helper: most
    helpers FIX the gated condition so the engine re-probes after they finish, but `on-call`
    only investigates (it never reverts), so the `post-release-health` gate supplies this hook
    to settle the gate (raise `release_regression` + enrich the incident) WITHOUT re-probing.
    Absent → the default re-probe loop.
- **One-shot engine steps** — non-LLM steps with bespoke handling: `tracker` (files a
  ticket), `deployer` (provisions an env), `requirements-review` (inline reviewer + park
  loop). Not gates because they don't poll-or-escalate.
- **The `merger` resolver is a privileged built-in, deliberately NOT externalized.** It is a
  `StepCompletionResolver` (`buildStepResolverRegistry`) but a different archetype from the
  light, externally-authorable resolvers (output reshaping / notification / repo follow-up,
  e.g. the example auditor): it OWNS terminal block status (`ownsTerminalStatus`) and executes
  a policy-gated real merge — the dual of a gate (agent verdict → engine policy-act, vs a
  gate's provider precheck → escalate). So it keeps its engine-internal access (`MergeResolver`,
  `resolveMergePreset`, the real merge) rather than the minimal public `ResolverContext`. The
  public step-resolver seam is scoped to that light follow-up; `ownsTerminalStatus` is
  built-in-only. (`requirements-review` auto-pass + `on-call` share the same "structured
  assessment vs per-task threshold" shape — a latent "verdict gate" family, not promoted to an
  abstraction until a second externally-authored member needs it.)

The same "precheck, then skip the expensive work if it's unnecessary" idea applies to
the inline requirements-incorporation companion: `hasNotesToIncorporate`
(`requirements.logic.ts`) short-circuits `runIncorporationCycle` so the rework +
re-review LLM calls are skipped when the human left nothing to fold in (every finding
dismissed, no answered replies, no redo feedback) — the review settles `incorporated`
directly and downstream falls back to the original description.

## Custom agents (manifest-driven extension — pre/post-ops over `RepoFiles`)

A deployment can ship its own agent kinds **without forking and without rebuilding the
executor-harness image**. Governing principle: _zero `switch(agentKind)` in the
container_ — the harness is a generic LLM-over-a-checkout runner, and all
mechanical/deterministic work is backend TypeScript. Full model + worked example:
[`backend/docs/custom-agents.md`](./backend/docs/custom-agents.md).

- **Three stages** (the container runs only the middle one): `preOps` (deterministic
  backend TS, reads/commits a targeted subset of the repo with NO checkout, via the
  `RepoFiles` kernel port) → `agent` (optional LLM step: `inline` / `container-explore`
  [prose or structured JSON → `result.custom`] / `container-coding`) → `postOps`
  (deterministic backend TS: parse `result.custom`, render artifact files, commit via
  `RepoFiles`). `preOps`/`postOps` are plain `RepoOp` functions.
- **Registration** (by reference on the facade's app-owned registries, NOT a module-global side
  effect): `agentKindRegistry.register({ kind, systemPrompt, agent, preOps, postOps, presentation })`
  (`@cat-factory/agents`) + `pipelineRegistry.register(...)` (`@cat-factory/kernel`). A
  `container-*` surface implies the container requirement.
- **Live execution wiring**: `ExecutionService` runs a registered kind's `preOps` before
  dispatch and `postOps` after `recordStepResult`, over a per-run `RepoFiles` bound to the
  run's repo. The binding is the facade-wired `resolveRunRepoContext`
  (`ExecutionServiceDependencies` / `CoreDependencies`), composed from the GitHub client +
  the executor's `resolveRepoTarget` via `makeResolveRunRepoContext` (`@cat-factory/server`)
  — wired in ALL THREE facades (Worker `selectGitHubDeps`, Node `githubGateDeps`, local
  inherits via `buildNodeContainer`). Unwired (tests / no GitHub) ⇒ hooks skip, engine
  unchanged. `runRepoOps` lives in `@cat-factory/agents` (so orchestration drives it
  without importing the server layer). The cross-runtime conformance suite asserts a
  registered kind's pre-op read + post-op commit on both runtimes.
- **`RepoFiles`** (`@cat-factory/kernel` `ports/repo-files.ts`): a per-run, checkout-free
  facade over the GitHub Git Data + contents API (`getFile`/`listDirectory`/`headSha`/
  `createBranch`/`commitFiles`/`openPullRequest`) — pure HTTP, so runtime-symmetric across
  Worker/Node/local (the Worker's lack of a filesystem stops mattering).
- **Frontend**: the workspace snapshot carries `customAgentKinds` (kind + presentation +
  container flag; assembled in `WorkspaceController`), which the SPA merges into its palette
  catalog (`useAgentsStore().registerCustomKinds`) so a registered kind is a first-class
  palette block + result view. A structured kind's `result.custom` is recorded on the step
  (`step.custom`) and rendered by the shared `generic-structured` result view
  (`StepResultViewHost.vue` → `GenericStructuredResultView.vue`) — no bespoke UI.
- **NOT yet done**: the built-in agents (blueprints/spec-writer/coder/merger/…) are not
  yet migrated to this model — their rendering still lives in the harness. Converting them
  one at a time (parity-gated, image-bumped per conversion) then deleting the bespoke
  harness handlers is the remaining strangler work.

## Unified agent runs (failure + retry surface)

Both container-backed flows — task `execution` and repo `bootstrap` — persist to
one `agent_runs` D1 table (kind-scoped), and the board surfaces their failure +
retry uniformly:

- Storage: `D1ExecutionRepository`/`D1BootstrapJobRepository` both target
  `agent_runs WHERE kind=…`; `D1AgentRunRepository` reads across kinds
  (`getRef` for retry dispatch, `listStale` for the sweeper).
- Sweeper: `sweepStuckRuns` (worker `infrastructure/workflows/sweeper.ts`, driven
  from `index.ts` `scheduled`) re-drives stale `running` runs of **both** kinds —
  so an evicted bootstrap is now re-driven too (the old known limitation is gone).
- Retry: `POST /workspaces/:ws/agent-runs/:id/retry` (`modules/agentRuns/
AgentRunController.ts`) resolves the kind via `getRef`, then calls
  `bootstrap.service.retry` / `executionService.retry`; returns `{ kind, run }`.
- Frontend: `stores/agentRuns.ts` (`useAgentRunsStore`) merges `snapshot.executions`
  - `snapshot.bootstrapJobs` into a per-block `byBlock` summary; the shared
    `components/board/AgentFailureCard.vue` renders the rose banner + retry on the
    board card, the inspector, and `TaskExecution.vue`. A failed execution now leaves
    its block `blocked` (NOT the old success-looking `pr_ready`).

## Telemetry & agent-context observability (isolated store)

Two observability sinks capture what runs do, and both live in a **dedicated telemetry
store** (separate from the transactional domain — append-heavy/high-volume/short-retention):
a separate **required** `TELEMETRY_DB` D1 database on Cloudflare and a `telemetry` Postgres
**schema** (`pgSchema('telemetry')`, same connection) on Node. Both tables are pruned to the
same window (`LLM_CALL_METRICS_RETENTION_DAYS`, default 3 days) by the existing retention
sweep.

- **`llm_call_metrics`** — per LLM call (prompt/response delta-stored, tokens, timing).
  Recorded by the LLM proxy via `LlmObservabilityService` for the proxy-metered Pi harness.
  The **subscription harnesses (Claude Code / Codex) bypass the proxy** (they talk direct to
  the vendor), so the harness lifts per-call metrics off each CLI's event stream onto
  `RunnerJobResult.callMetrics`, and `ContainerAgentExecutor.pollJob` feeds them through the
  SAME `LlmObservabilityService` (via `makeHarnessCallRecorder`, wired per-facade as
  `recordHarnessCalls`). Claude Code's `stream-json` carries full request/response bodies;
  Codex's `exec --json` is thinner (flat assistant text + per-turn tokens, no request
  transcript). Both have zero per-HTTP timing (the CLIs don't expose it). This captures what
  the model _received_ per call.
- **`agent_context_snapshots`** — the complete context an agent was _provided_ per container
  dispatch: the fully fragment-composed system + user prompts, the best-practice fragment
  bodies folded in, and the **full content of the files injected into the container**
  (`.cat-context/*` — which the agent reads via tools, so they never reach proxy telemetry).
  Recorded best-effort by `ContainerAgentExecutor.startJob` (after dispatch) via
  `AgentContextObservabilityService` (orchestration), built per-facade and injected into both
  the executor (write) and `createCore` (read). The snapshot is a **redacted allow-list**
  projection of the dispatched job — NEVER a token or credential-bearing URL. As a
  defence-in-depth second layer, `AgentContextObservabilityService.record` also runs every
  stored body (both prompts, each fragment body, each injected file's content) through
  `redactSecrets` BEFORE the size budget, deep-scrubs the `extras` bag (`redactSecretsDeep`
  — its decisions/revision-feedback values are free-text prose that can embed a token), and
  drops the whole body of a context file whose name marks it as a raw credential store
  (`isSecretShapedFilename` — `.env`/`*.pem`/SSH key/`.npmrc`/…), so a token embedded in a
  task description, a decision note, or an injected secret-shaped file never lands verbatim
  in the telemetry store. `redactSecrets` also catches PEM-armored private keys by their
  header, so a pasted key is scrubbed regardless of the enclosing filename.
- **Gating**: storing requires BOTH the deployment prompt-recording switch
  (`LLM_RECORD_PROMPTS`) AND the per-workspace `storeAgentContext` setting (on by default; a
  toggle in `WorkspaceSettingsPanel.vue`).
- **Surfacing**: `GET /workspaces/:ws/executions/:executionId/agent-context` →
  `stores/observability.ts` → the "Provided context" view in `ObservabilityPanel.vue`
  (alongside the existing "Model activity" call list).
- **Parity**: the D1 repo (`D1AgentContextSnapshotRepository`) ⇄ Drizzle repo, asserted by
  the cross-runtime `defineAgentContextSuite`. The Cloudflare facade fails fast at container
  build if `TELEMETRY_DB` is unbound.

## Board / service / repo-linkage model

- A "service" on the board is just a `Block` with `level: 'frame'`,
  `parentId: null`. Modules are sub-frames; tasks are leaves. See
  `app/types/domain.ts`, `backend/packages/contracts/src/entities.ts`,
  migration `0001_init.sql`.
- **A Block carries no repo fields.** Repo↔block linkage lives in the
  `github_repos` projection table via its `block_id` column
  (`D1RepoProjectionRepository.linkBlock()`).
- **Execution resolves the repo at runtime** via `resolveRepoTarget(workspaceId,
blockId)` (worker `infrastructure/container.ts`): find the `github_repos` row
  whose `block_id === blockId`, else fall back to `repos[0]`. So to make a
  bootstrapped repo a board service that tasks target correctly, the repo
  projection row must be linked to the new frame's block id.
- A workspace has exactly **one** GitHub installation but may have **many** repos.
- `BoardScanService.reconcileBlueprint()` (orchestration `src/modules/boardScan/BoardScanService.ts`)
  is the engine's blueprint reconciler: it maps a `blueprints` step's decomposition
  tree onto the run's existing service frame in place (match modules by name, add
  missing, refresh descriptions, never delete), falling back to spawning a fresh
  frame + modules only when the target frame can't be resolved.
- Drag-drop: `useBlockDrag.ts` (`reparentAt()`) → `POST /blocks/:id/reparent` →
  `BoardService.reparent()`. Tasks can move into frames or modules; modules into
  frames; frames cannot nest (`canReparent` in `board.logic.ts`).

## Individual-usage subscriptions (per-user, not pooled)

Vendors flagged `individualOnly` in `SUBSCRIPTION_VENDORS` (today `claude`, `codex`, and
`glm`) are licensed for individual use, so they are NEVER in the per-workspace pool:
`ProviderSubscriptionService` refuses them (409). They live in a separate per-USER store
with a distinct restricted mode. (At run time `claude`/`codex` always lease a personal
credential, while `glm` is dual-mode: it leases one only when the user has their own GLM
subscription, else it runs on the poolable Cloudflare base.) Full model + safeguards:
[`backend/docs/individual-subscription-usage.md`](./backend/docs/individual-subscription-usage.md).

- **Double-encrypted at rest** (`personal_subscriptions` ⇄ Drizzle):
  `system.encrypt(personal.seal(token, password))`. The inner layer
  (`WebCryptoPersonalSecretCipher`, PBKDF2→AES-GCM) is keyed by the user's personal
  **password**, which is never stored — so the token needs BOTH the system key AND the
  password to recover. `PersonalSubscriptionService` (integrations) owns it;
  `GET|POST|DELETE /personal-subscriptions` (user-scoped) is the API.
- **Per-run activation** (`subscription_activations`): at start/retry the user supplies
  their password (cached client-side with a TTL) → `activateForRun` re-encrypts the raw
  token with the SYSTEM key only, scoped to the run, so the async container steps lease it
  without the user present. Cleared when the run reaches terminal (`emitInstance` →
  `deleteByExecution`) and swept on TTL (Worker cron ⇄ Node retention timer).
- **Gating**: `personalGateForBlock`/`personalGateForRun` (server) resolve the block's
  individual vendor via `individualVendorForModelId`; a missing user/credential/password
  → `428 credential_required {vendor,reason}`, which the SPA's
  `personalSubscriptions` store turns into a password modal (then retries). The run
  records `initiatedBy`; `ContainerAgentExecutor` leases the initiator's activation
  (`leasePersonalSubscriptionToken`) for an individual vendor instead of the pool.
- **No recurring**: `RecurringPipelineService.fire` refuses a block on an individual-usage
  model (can't unlock unattended).

## Multi-runtime facades & cross-runtime conformance

The backend ships to two deployment targets, both serving the **same**
`@cat-factory/server` Hono app; each facade in `backend/runtimes/*` supplies only its
differentiators behind the shared kernel ports + the `container.gateways` seam.

- **Cloudflare Worker** (`runtimes/cloudflare`, `@cat-factory/worker`): D1 (SQLite),
  Cloudflare **Workflows** for durable execution, Durable Objects for real-time +
  per-run Containers, queues/cron, the `workers-ai` binding. The gold-standard flows
  above (execution, bootstrap) run on this facade.
- **Node service** (`runtimes/node`, `@cat-factory/node-server`): **Postgres via
  Drizzle** (the single persistence — there is no in-memory store), **pg-boss** for
  durable execution (`PgBossWorkRunner` enqueues an `execution.advance` job;
  `driveExecution` runs the same advance/poll loop the `ExecutionWorkflow` does, with
  plain async sleeps instead of durable steps; `signalDecision` re-enqueues a parked
  run). `start()` connects to `DATABASE_URL`, runs `migrate()`, boots pg-boss + the
  execution worker, attaches the **real-time WebSocket transport** to the HTTP listener,
  and serves over `@hono/node-server`. **Async GitHub ingest is pg-boss-backed** (the
  analogue of the Worker's `GITHUB_SYNC_QUEUE` consumer + `GitHubBackfillWorkflow`): the
  `githubBackfill` / `githubWebhook` gateway seams enqueue webhook deliveries, single-repo
  resyncs and full-installation backfills onto the `github.sync` queue so the request acks
  fast, and `startGitHubSyncWorker` drains it and applies each job to the projections via
  the same `GitHubSyncService` / `WebhookService` the inline path used (a container built
  with no boss — a pure-logic test — keeps the inline fallback). **Real-time** is implemented: `start()` creates a
  per-workspace `NodeRealtimeHub` (in-memory subscriber registry), wires a
  `NodeEventPublisher` (decorated with `FanOutEventPublisher`) as the engine's
  `executionEventPublisher` + an `InAppNotificationChannel`, and `attachRealtime`
  (`runtimes/node/src/realtime.ts`) accepts the SAME raw-WebSocket + `?ticket=` protocol
  the Worker serves via a `ws` server on the HTTP `upgrade` event (`@hono/node-server`
  can't upgrade from a Hono `Response`, and the SPA speaks raw WebSocket — not socket.io —
  so this keeps the client unchanged across runtimes). The ticket mint/verify is the
  shared `@cat-factory/server` `auth/wsTicket.ts` used by both the Worker's
  `EventsController` and this upgrade handler. **Multi-node is supported** via a layered
  cross-node propagator (`runtimes/node/src/propagator.ts`): `NodeEventPublisher` writes
  through a narrow `LocalEventSink` seam that both the bare `NodeRealtimeHub` and the
  `LayeredEventPropagator` implement, so a horizontally-scaled deployment fans every event
  to the local hub AND to peer nodes over a pluggable adapter — **Redis pub/sub today**
  (`RedisWebSocketPropagator`, `runtimes/node/src/redisPropagator.ts`; the opt-in `ioredis`
  dependency is dynamically imported only when `REDIS_URL` is set), a future Postgres
  LISTEN/NOTIFY or NATS adapter implementing the same `WebSocketPropagator` port. With no
  bus configured (single replica, and **local mode**, which is always single-node) the layer
  is exactly the bare hub — zero overhead, no extra dependency. The Worker facade needs none
  of this: its `WorkspaceEventsHub` Durable Object is globally addressed (one per workspace
  across the deployment), so cross-node propagation is inherent — a genuine Node-only concern,
  not a facade-parity gap.
  **Container agent steps** (coder/mocker/tester/playwright/blueprints/ci-fixer/
  conflict-resolver/merger) run via the **same** shared `CompositeAgentExecutor` +
  `ContainerAgentExecutor` the Worker uses (now in `@cat-factory/server`),
  dispatching to a workspace's **self-hosted runner pool** — the Node facade has no
  built-in per-run container runtime, so it resolves the manifest-driven
  `RunnerPoolTransport` (in `@cat-factory/integrations`) instead of a Cloudflare
  Container. A pool runs the same executor-harness image, so it serves **every** dispatch
  kind: runtime parity is the default (see "Keep the runtimes symmetric"), so there is no
  opt-in allow-list — a new harness kind reaches the pool automatically, exactly as it
  does a Cloudflare container.
  Wired in `runtimes/node/src/container.ts` when the prerequisites are set
  (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`, `PUBLIC_URL`, `AUTH_SESSION_SECRET`,
  `ENCRYPTION_KEY`); persistence (`runner_pool_connections`,
  `github_installations`, `github_repos`) mirrors the D1 tables in `db/schema.ts`. When
  unconfigured the composite still serves inline kinds but fails container kinds loudly
  (no silent useless one-shot LLM call). NOTE: populating `github_installations` /
  `github_repos` still needs the GitHub connect/sync integration on Postgres (the
  remaining follow-up); the executor reads those rows once present.
- **Local mode** (`runtimes/local`, `@cat-factory/local-server`): the Node facade with
  the runner backend swapped for a **per-run local container** (`LocalContainerRunnerTransport`
  over a `ContainerRuntimeAdapter` for Docker/Podman/OrbStack/Colima/Apple `container`,
  injected via `buildNodeContainer`'s `resolveTransport` seam) and GitHub reached via a
  **PAT** — both the push token (`mintInstallationToken` seam) and a PAT-backed
  `FetchGitHubClient` (`githubClient` seam) that wires the CI gate + merge / mergeability
  providers, so a local pipeline gates on real Actions CI and **merges for real**.
  Reuses Node's Postgres/pg-boss/gateways unchanged. So a developer runs the whole
  product locally — agent containers clone/push/open real PRs on github.com via the PAT.
  Container kinds need a target repo's `github_repos`/`github_installations` rows seeded
  (the `linkRepo` helper does this from PAT-read metadata, since local mode has no App
  connect flow).
- **Model provisioning** is composed per facade from `@cat-factory/agents`'
  `CompositeModelProvider` (+ opt-in `@cat-factory/provider-bedrock`): Worker =
  workers-ai binding + direct vendors + Cloudflare-REST + Bedrock; Node = direct
  vendors + Cloudflare-REST + Bedrock (no binding). Unconfigured providers aren't
  registered, so `resolve` throws a clear error instead of failing deep in the SDK.
- **Locally-run models (per-user)** — Ollama / LM Studio / llama.cpp / vLLM / a custom
  OpenAI-compatible runner. Configured per USER in the UI ("My local runners"), stored in
  the `local_model_endpoints` table (D1 ⇄ Drizzle parity), validated on the fly via
  `LocalModelEndpointService.testConnection` (probes `/v1/models`). Enabled models are
  appended to `GET /models` dynamically (id `"<provider>:<model>"`) as the `direct` flavour
  gated by the `localModels` capability (the per-user set of enabled model ids — usability
  is model-granular, not just per-runner) — NO API key. At run time the LLM proxy + the
  inline model provider resolve the **run initiator's** endpoint and SKIP the DB key lease
  (the keyless local branch; `isProxyableProvider` + `isLocalRunner`), exactly like the
  personal-subscription initiator model. `parseLocalModelId` turns the dynamic id into a
  `ModelRef`. The base URL is forwarded server-side, so it's constrained to a loopback/LAN
  host allow-list (`localRunnerUrlError`) at the write boundary + the test probe (public
  hosts and the link-local metadata endpoint are rejected — anti-SSRF). Runtime-neutral and
  runs on the cross-runtime conformance suite; in practice only local/Node deployments reach
  `localhost`.

**Cross-runtime conformance** keeps the facades behaviourally identical:
`@cat-factory/conformance` exposes `defineConformanceSuite(harness)` — the key backend
behaviour (workspaces, board, the execution engine driven via the shared
`FakeAgentExecutor`) as runtime-neutral assertions parameterised by a
`ConformanceHarness` (`makeApp(agentOptions) → { call, createWorkspace, drive }`). The
Worker invokes it from `runtimes/cloudflare/test/integration/conformance.spec.ts`
(real D1, inside workerd); the Node service from `runtimes/node/test/conformance.spec.ts`
and the local facade from `runtimes/local/test/conformance.spec.ts` (both real Postgres
via `DATABASE_URL`, the latter building through `buildLocalContainer` with a fake agent
executor so the local wiring can't drift). All run the **same** assertions, so a
repository that maps a column differently or an engine path only one facade wires fails
a test instead of shipping. `runtimes/node/test/durable-execution.spec.ts` additionally
drives a run to completion through the real pg-boss runner.

## End-to-end (assembled-product) coverage

Where the conformance suite asserts backend behaviour port-by-port, the **Playwright e2e
suite** (`backend/internal/e2e`, `@cat-factory/e2e`, private) covers the **assembled
product**: a real Chromium drives the real SPA (the `@cat-factory/app` layer via the
`deploy/frontend` consumer), which talks to a **real Node backend** — real Postgres
(Drizzle), real pg-boss durable execution, and the real WebSocket push transport. Only the
**external** deps are faked, so it's deterministic and needs no secrets/Docker/network:
LLMs + per-run containers → the canonical `FakeAgentExecutor`/`AsyncFakeAgentExecutor`
(reused from `@cat-factory/conformance`), repo bootstrap → `FakeRepoBootstrapper`, and
GitHub App / email / Slack / Datadog left **off** (all opt-in, so gates/providers pass
through). The backend wiring lives in `src/testServer.ts` (the stock `buildContainer` seam
with those fakes injected); the full picture is in [`backend/internal/e2e/README.md`](./backend/internal/e2e/README.md).

- **What e2e is FOR vs conformance:** assert on what only the assembled product can show —
  the **live, WebSocket-pushed UI round-trip** (start over REST → the board reacts with no
  reload). A pure backend side-effect (a real PR merge, a column mapping) belongs in the
  conformance/integration suites, NOT here. The e2e backend has GitHub off, so anything
  needing a real outbound call (the `FetchGitHubClient`, an inline LLM) must be mocked at
  the backend's **outbound boundary** (MSW / a `buildNodeContainer` port seam), never in
  the browser — the SPA only ever talks to this one backend.
- **Spec shape (mandatory):** **seed/trigger over REST, then assert only on LIVE pushed UI
  updates** — no reloads, no fixed sleeps, no fragile canvas drag/zoom; only web-first
  assertions (`toBeVisible`/`expect.poll`) on the named timeouts in `tests/helpers.ts`.
  Shared setup is the `seededBoard` fixture (seed → pin → open) plus the **auto**
  `pageErrors` fixture that fails any test on an uncaught SPA exception. Each spec **seeds
  its own workspace** (`workers: 1`, serial), so concurrent workspaces never collide.
- **Selectors are `data-testid`, always.** Every assertion targets a stable test id, never
  text/CSS/DOM-shape. Covering a new flow whose affordance has no test id means **adding
  the `data-testid`** to that component first (a one-line, behaviour-neutral frontend
  change — e.g. `run-stop`/`run-reset` on the inspector's run controls) and a patch
  changeset for `@cat-factory/app`, then writing the spec against it.
- **Adding a spec:** drop a `*.spec.ts` under `tests/`, import `test`/`expect` from
  `./fixtures` (NOT `@playwright/test`), reuse the `helpers.ts` REST helpers + timeouts,
  and add a row to the README's Specs table. Deterministic variations are env knobs on
  `testServer.ts` (`E2E_DECISION_ON_STEPS`, `E2E_CONFIDENCE`, `E2E_ASYNC_KINDS` /
  `E2E_DISPATCH_THROW_KINDS`); a spec needing a different backend env (e.g. a merge-review
  flow at low `E2E_CONFIDENCE`) wants its **own** `webServer` in `playwright.config.ts`.
- **CI:** runs in its own non-blocking `Test e2e` job — NOT part of the unit `test:run`
  lane and NOT wired into the aggregated `Test` gate, so a browser/boot flake can't block
  an otherwise-green PR. Promote it into `test-gate.needs` only once it has earned trust
  (see the README's promotion checklist).

### A flaky e2e test is a BLOCKING bug — investigate and deflake, NEVER retry

**A flaky e2e spec is a blocking issue that must ALWAYS be investigated and deflaked at its
root cause — it can NEVER be "just retried" until it goes green, and a green-on-retry run is
NOT a pass.** This is an absolute rule. Playwright is configured to enforce it
(`failOnFlakyTests: true` in `playwright.config.ts`): a spec that fails on the first attempt
and passes on a retry reports the shard **RED**, on purpose. The retry exists ONLY to capture
the trace/video for diagnosis — it does **not** rescue the run. So when you see a red e2e
shard, or a "N flaky" line in the report, treat it exactly like a hard failure:

- **Do NOT re-run CI hoping for green, do NOT bump `retries`, do NOT `test.skip`/`test.fixme`
  the spec, and do NOT dismiss it as "just a browser/boot flake."** "It passed the second
  time" is a failed task, not a completed one. The non-blocking `Test e2e` job means a flake
  can't _stop a merge_, but that is a safety net for infra hiccups, NOT permission to ignore a
  flake — an intermittent RED is a signal to fix, every time.
- **Reproduce, then root-cause.** A flake almost always exposes a REAL race in the product,
  not "a slow test": a live event applied between a snapshot's fetch and its store-commit
  (see the bootstrap-failure flake — a stale on-connect resync dropped a live-added terminal
  run in `agentRuns.hydrate`), a subscribe-after-broadcast gap, a status that renders from a
  clobbered store. Reproduce it (locally you can start Postgres + the built frontend/backend
  and run the single spec with `--repeat-each` under load), find the ordering hazard, and
  **fix the SOURCE** — usually a frontend store reconcile or a `helpers.ts` readiness gate,
  occasionally the backend event path. Add a unit test that pins the race so it can't return.
- **Never paper over it in the spec.** No fixed `sleep`, no bumped per-assertion timeout to
  "give it more time," no reload to re-pull the snapshot (that hides exactly the live-push bug
  the suite exists to catch). Web-first assertions on the named `helpers.ts` timeouts only.
- **The bar for "fixed" is deterministic, not lucky:** the spec must pass a high-count
  `--repeat-each` locally AND the root-cause fix (with its regression test) must be in the
  same change. Only then is the flake closed.

### Real-time (live-push) store coherence — avoid the full-refresh CLOBBER

Most of the flakes above are one recurring product bug, not test noise: **a stale full-snapshot
refresh clobbering newer live state**. The SPA's real-time layer has two delivery shapes
(`useWorkspaceStream.ts`), and mixing them wrong drops live-added state with NO event left to
restore it — so a card/badge simply never appears (an e2e timeout, not a slow test). Design new
live surfaces to avoid it:

- **Know how your entity is delivered.** A `board`-type `WorkspaceEvent` is COARSE: it carries no
  payload and only triggers a **debounced full `workspace.refresh()`** (`hydrate` REPLACES whole
  lists — blocks, executions, …). A spawned task/module block reaches the browser ONLY this way
  (there is no per-block push), so its appearance depends entirely on a full refresh landing and
  STICKING. Targeted events (`execution`/`bootstrap`/`initiative`/…) instead carry the entity and
  `upsert` it directly — those don't REPLACE, so they don't clobber. Prefer a targeted upsert for
  anything that must appear reliably and fast; fall back to the coarse refresh only for genuinely
  structural changes.
- **Full refreshes MUST be monotonic.** Two `refresh()` calls can be in flight at once (board
  events >300ms apart, or the on-connect resync racing a board event). Since each ends in a
  REPLACE-style `hydrate`, a slower/staler fetch resolving AFTER a newer one overwrites it and
  drops the just-added entity. `workspace.refresh()` guards this with a monotonic sequence (only
  the latest-issued call commits its hydrate) — do NOT reintroduce an unguarded
  `hydrate(await fetch())`, and apply the same guard to any new coalesced full-refresh path.
- **Never gate readiness on a snapshot that a later resync can undo.** The on-connect resync flips
  `connected` only AFTER it settles, so an action taken on a `connected` board can't be clobbered
  by a lagging initial resync (this is why e2e specs gate on `data-connected`). A new (re)hydrate
  trigger must preserve that ordering.
- **A REPLACE-style `hydrate` must never silently drop live-only state.** If a store holds state
  that arrives ONLY via a live event (never in the snapshot), a full refresh will wipe it — either
  fold that state into the snapshot or reconcile (merge) rather than replace. The bootstrap-frame
  and spawned-block flakes were both this: a full `hydrate` REPLACED a list the stale snapshot
  hadn't caught up to.
- **Pin it with a store-level unit test** (see `stores/workspace.spec.ts`): drive two
  out-of-order-resolving refreshes and assert the fresher one wins. This is the cheap regression
  guard the e2e flake rule above asks for — write it alongside the fix.

## Internationalization (i18n)

All user-facing copy in the SPA is translatable via **`@nuxtjs/i18n`** (vue-i18n under
the hood) and **MUST** go through it — never hard-code a display string in a component.
The `@cat-factory/app` layer ships the base `en` locale; a downstream deployment
overrides or adds locales by dropping its own files, so the layer's per-layer
**deep-merge** is the override seam (consumer wins, key by key).

**Where things live:**

- `frontend/app/i18n/locales/<locale>.json` — the message catalog (the v9+ `i18n/`
  `restructureDir` convention; **NOT** `app/locales/`). Today only `en.json` exists.
- `frontend/app/i18n/i18n.config.ts` — runtime vue-i18n behaviour only (fallback locale +
  the `numberFormats`/`datetimeFormats`). Messages are deliberately NOT here, so the module
  can deep-merge catalogs across the `extends` chain. Referenced from `nuxt.config.ts` as
  the **bare** filename `vueI18n: 'i18n.config.ts'` — the module resolves it per-layer, so
  do NOT `layerDir`-anchor it the way the css block is anchored.
- `nuxt.config.ts` `i18n` block — registers locales + `defaultLocale: 'en'`. Pure SPA
  (`ssr: false`), so a single in-app locale and no URL-prefix routing.
- `package.json` `files` MUST include `"i18n"` — **release-blocking**: omit it and the
  locales don't ship in the published layer.

**Adding / changing a translatable string (the day-to-day flow):**

1. Add the key to `i18n/locales/en.json` under the feature namespace, then resolve it at
   the call site with `t('feature.area.key')` (template) / `useI18n().t(...)` (script).
2. Format **numbers, currency, percentages, and dates through vue-i18n**, not raw `Intl`:
   `$n(value, 'decimal'|'currency'|'percent')` and `$d(value, 'short'|'long')` (the named
   formats defined in `i18n.config.ts`). `currency` needs a per-call `currency` override
   (`$n(n, 'currency', { currency: s.currency })`) — the backend supplies the code.
3. For a brand-new locale, add `i18n/locales/<locale>.json` + register it in the
   `nuxt.config.ts` `locales` array (and, downstream, just drop the JSON to override).

**Key conventions:**

- One namespace per feature; resolve with `t('feature.area.key')`.
- **Leaf keys mirror the enum/code value verbatim** so a dynamic lookup is total — e.g.
  `errors.conflict.title.<reason>`, `catalog.status.<status>`.
- **No cross-key concatenation.** A full sentence is ONE key with `{named}` placeholders;
  plurals use the vue-i18n pipe form (`'no cats | one cat | {count} cats'`).

**Component migration mechanics (the vue-i18n specifics that bite):**

- **`useI18n` is auto-imported** — never add an `import`. In `<script setup>` destructure what
  you need (`const { t, d, n } = useI18n()`); the template can then use the same `t`/`d`/`n`. Do
  NOT reach for `$t`/`$d` in templates of migrated components — use the destructured fns so the
  typed-message-keys check (tier 1) sees the literal keys.
- **Plural + interpolation in one call:** `t(key, { vendor, count }, count)` — the THIRD arg is
  the plural choice (a number); the named object still feeds `{…}` placeholders. `{count}` is the
  conventional name for the count. Pass the count both as a named param and as the 3rd arg.
- **Dates/numbers always go through `d()`/`n()`** (or `$d`/`$n`), NEVER `toLocaleDateString()` /
  `Intl` / `new Date().toLocaleString()`. `t('…expires', { date: d(new Date(ts), 'short') })`.
- **Code/format-example placeholders stay INLINE, not in the catalog.** A placeholder that is a
  literal example (`sk-ant-oat01-…`, a JSON blob, a token shape) is not prose: leave it as a
  component constant. This is REQUIRED when it contains `{`/`}` — those are vue-i18n interpolation
  metacharacters and would need ugly `{'{'}` escaping. Only prose placeholders (`your GLM … key`)
  get a key. Same for proper nouns / brand names rendered as labels (keep verbatim across locales).
- **No HTML in message bodies** (the catalog has none): drop mid-sentence `<strong>` when
  migrating (it also matches the writing rules), or use the `<i18n-t>` component with slots if the
  emphasis is structural. Don't embed tags and `v-html` a message.
- **A vendor/enum-keyed set of strings:** build it as an array/computed of STATIC literal `t()`
  keys (`t('…vendors.claude.label')`), one per enum member — that keeps the tier-1 typed-key check
  live. Reserve the runtime-assembled key + exhaustive `Record` guard (tier 2) for lookups whose
  key genuinely isn't known until runtime.
- **In new catalog entries use straight quotes/apostrophes and NO em-dashes** (rephrase; the
  existing catalog is mixed, straight is the going-forward standard). Translated catalogs
  (`es/fr/pl/uk`) carry NO `@<key>` description siblings — those live only in `en.json`.

**Translator descriptions (`@<key>` siblings) — annotate ONLY truly ambiguous keys:**

vue-i18n supports a per-message metadata sibling: alongside a leaf `foo` you may add an
`@foo` object with a `description` string (e.g. `"close": "Close"` paired with `"@close":
{ "description": "Verb meaning dismiss/shut, NOT the adjective 'near'…" }`). It is a note
**to whoever translates the locale**, not runtime data — it never renders and lives ONLY in
the source `en.json` (the translated catalogs `es/fr/pl/uk.json` carry no `@` siblings).

**Default to NO description.** The overwhelming majority of keys are unambiguous from their
English value plus their namespace path (`board.toolbar.addService`, `common.save`) and a
description on them is pure noise — it bloats the catalog, dilutes the signal of the few
notes that matter, and is one more thing to keep in sync. **Do not** add a description that
merely restates the string, names the component it appears in, or explains an obviously
self-evident word. When you add a key, the bar is: _would a competent translator, seeing
only the English text and the key path, plausibly get it wrong?_ If no, add nothing.

Add a `@<key>.description` ONLY when the English is genuinely ambiguous or carries a
translation constraint the string alone can't convey — the legitimate cases (all present
in `en.json` today) are:

- **Homograph / part-of-speech ambiguity** — the word translates differently by sense:
  `@close` (verb "dismiss", not adjective "near"), `@run_not_retryable` ("run" is the
  execution NOUN, not the verb).
- **Proper nouns that must NOT be translated** — `@kaizen` (a product feature name, keep
  verbatim in every locale). Contrast `@sandbox`, whose note exists precisely to say the
  opposite — _do_ localize it descriptively — because the reader would otherwise assume it
  is also a verbatim brand term.
- **Umbrella strings hiding cases not visible in the text** — `@tester_infra_unsupported`
  (one title spanning two distinct failure causes; keep it broad).
- **Placeholder / format constraints** — keep a `{named}` placeholder intact, or note that
  a runtime value is injected (`@body` for the model-list interpolation).
- **Plural-form requirements** — a count-driven key that needs more forms than English's
  two (`@decisionWord`: Polish/Ukrainian need one/few/many via the custom `pluralRules`).

Keep each description to the constraint a translator acts on; don't turn it into prose. When
in doubt, leave it off — an unannotated key is the norm, an annotated one is the exception.

**Backend / server strings:** the backend does not localize prose. A localizable server
condition emits a machine-readable `error.details.reason`/`code`, and the SPA maps that
code to a frontend key (the `usePipelineErrorToast.ts` pattern); the raw backend `message`
is shown only as an untranslated last-resort fallback. The wire vocabulary that drives such
a mapping lives in `@cat-factory/contracts` (e.g. `ConflictReason`), so the SPA imports the
SAME source of truth the backend throws against.

**Drift guards (the repo lints with oxlint only, so the ESLint `@intlify/.../no-raw-text`
rule is unavailable — these tiers replace it):**

1. **Typed message keys** (`i18n.experimental.typedOptionsAndMessages`) make a _statically
   written_ unknown `t('literal.key')` a `nuxt typecheck` failure (a CI gate). This does
   NOT cover a key assembled at runtime — a `t(\`errors.conflict.title.${reason}\`)`template
or a variable key is typed as`string`, so the compiler can't check it.
2. For those **dynamic enum→key lookups**, guard with an **exhaustive `Record<TheEnum,
string>`** keyed off the source-of-truth union (e.g. `CONFLICT_TITLE_KEYS` in
   `usePipelineErrorToast.ts`, keyed off the contracts `ConflictReason`): adding an enum
   value without a key fails the typecheck on the map, and a runtime `te()`-guard falls back
   rather than leaking a raw key if a locale omits one. **Never rely on tier 1 alone for a
   reason/status-keyed lookup.**

3. A `vue-i18n-extract` CI check is the secondary guard for keys the typecheck can't see
   (runtime-built lookups) and for catalog staleness. It runs in CI's `build-typecheck`
   job via `pnpm --filter @cat-factory/app run i18n:check` (the wrapper
   `frontend/app/scripts/i18n-check.mjs`, which drives the `createI18NReport` programmatic
   API). It **hard-fails on MISSING keys** (a `t('…')` whose key is absent from the
   catalog — a raw-key leak) and **reports UNUSED keys as non-blocking warnings**: the
   catalog seeds keys ahead of use (`common.save|cancel|retry`) and references many
   indirectly (the `CONFLICT_TITLE_KEYS` Record, keys passed as string literals to
   `usePipelineErrorToast().present(...)`), which the scanner can't see as used — so an
   unused-key hard gate would fail spuriously and fight the incremental migration.

4. A **locale-parity** CI check couples translations to `en.json` edits: a PR that adds,
   changes, or removes an `en.json` message key MUST make the SAME change in every other locale
   (`de/es/fr/he/it/ja/pl/tr/uk`), else it fails. It runs in the `build-typecheck` job via
   `node frontend/app/scripts/i18n-locale-parity.mjs --since origin/<base>` (also
   `pnpm --filter @cat-factory/app run i18n:parity`). This is **change-coupling against the PR
   merge-base**, NOT full key-parity: it enforces ONLY the keys THIS PR touched in `en`, so the
   pre-existing translation lag on untouched keys is left alone (it does not force a mass
   back-translation). `@<key>` description siblings are en-only and ignored. Off a PR (no base
   ref) it passes. **Consequence for the incremental rule below:** you may still add `en` keys
   ahead of the components that use them, but when you do, add the translated value to all
   locales in the SAME PR — an `en`-only string edit now fails CI.

**Translate for real — NEVER ship an English string as a non-`en` locale value.** The parity
gate checks only that the KEY exists in every locale, not that its VALUE differs from English, so
it will happily pass a locale whose value is a verbatim copy of the `en` text. That copy is a bug,
not a translation: it ships English to a Spanish / Japanese / … reader and silently rots (a later
maintainer can't tell a forgotten placeholder from a deliberate choice). When you add or change an
`en` key, write the ACTUAL translation for each locale in the SAME edit. The ONLY values that may
legitimately match `en` are proper nouns / brand names that are identical across languages
(model-family labels like `Claude (Anthropic)`, `DeepSeek`, `AWS Bedrock`, `OpenAI / ChatGPT`);
everything else — prose, hints, region/country names, verbs — must be localized. If you genuinely
cannot produce a translation for some language, say so explicitly in the PR rather than committing
an English placeholder that reads as done.

Migration is incremental — `usePipelineErrorToast` is the pilot; most components still hold
inline strings, so **when you touch a component, lift its visible copy into the catalog**
rather than adding more raw text.

## Workspace RBAC enforcement (one gate, one floor, one middleware per admin group)

Per-workspace authorization (the `workspace-rbac` initiative — ADR
[`backend/docs/adr/0025-workspace-rbac.md`](./backend/docs/adr/0025-workspace-rbac.md)) is enforced
in exactly three shared places, never re-derived per controller:

1. **Resolution + the 404 hide** — `mountAuthGate` (`server/src/http/authGate.ts`) calls the
   single `loadWorkspaceAccess` (through the `workspaceAccess` AppCaches slice) on every
   `/workspaces/:ws/*` request, publishes the effective `{ role, permissions }` on the context
   (`c.get('workspaceAccess')`), and returns the SAME 404 shape for a denied/absent board (existence
   is never leaked). Roles (`admin | member | viewer`) map onto seven `WorkspacePermission`s via a
   fixed kernel table (`domain/workspace-access.ts`).
2. **The viewer write floor** — also in the gate: any non-GET/HEAD method requires `≥ member`,
   covering the whole member tier (`board.write` + `runs.execute`) with ZERO per-controller code.
   Its SOLE exemption is the read-only WS ticket mint.
3. **The admin-tier permission gate** — `requireWorkspacePermission(perm)`
   (`server/src/http/workspaceAccess.ts`), a **method-shaped Hono middleware** mounted ONCE at the
   top of each admin controller (`app.use('*', requireWorkspacePermission('integrations.manage'))`).
   It gates every WRITE the controller serves (now and future) with that permission while letting
   reads through; it runs BEFORE the handler's 503/lookup so an unauthorized member gets a clean 403
   without learning whether the integration is wired. It is co-located with the mount (NOT a central
   path→permission table), so new routes inherit the correct gate and can't drift. Each admin
   controller maps to exactly ONE permission (whole-controller). Two spots that mix gated + ungated
   writes under one mount — `WorkspaceController` (ungated `POST /workspaces` create + `workspace.read`
   snapshot GET, so `update`/`delete` gate per-handler) and `WorkspaceMemberController` — use the
   imperative `requirePermission(c, perm)` helper per-handler instead.

**Adding a route to an admin controller needs no authz code** — the mounted middleware already
covers it. **Adding a NEW admin controller**: mount `requireWorkspacePermission(perm)` at its top
(settings/integrations/secrets/members) and add a `member 403` case to `defineWorkspaceRbacSuite`
(`backend/internal/conformance/src/workspace-rbac-suite.ts`). A member-tier controller
(board/runs) needs nothing — the floor covers it. Dev-open (auth disabled) resolves no access
object and both the floor and `requirePermission` allow everything, so conformance MUST run
auth-enabled or it passes vacuously.

## Conventions

- Hexagonal layering: controllers (`@cat-factory/server`) → services
  (orchestration/integrations) → ports (kernel); infra adapters live in each runtime
  facade and implement the ports + the `gateways` seam, wired in that facade's
  `container.ts` via constructor injection of a single `dependencies` object. Opt-in
  integrations (GitHub / environments / bootstrap) wire only when configured.
- **Frontend i18n (`@cat-factory/app`):** all user-facing copy is translatable via
  `@nuxtjs/i18n` — never hard-code a display string. See the dedicated
  **[Internationalization (i18n)](#internationalization-i18n)** section above for where
  catalogs live, the add-a-string workflow, key conventions, backend-code mapping, and the
  typecheck drift guards.
- **Dedicated result-view seam (frontend):** an agent step opens the generic prose panel
  (`AgentStepDetail.vue`) UNLESS its archetype declares a `resultView` id (`app/utils/catalog.ts`).
  The `ui` store's step dispatch (`dispatchStepView`, used by both `openStepDetail` and
  `openApprovalDetail`) routes such a step to `ui.resultView`; `StepResultViewHost.vue` reads the
  modular `resultViews` slot (`app/modular/result-views.ts`, slice 2 of the modular-vue adoption)
  via `useReactiveSlots` + `resolveComponentRegistry` and mounts the component registered for that
  id. Give a new BUILT-IN window a bespoke view by declaring `resultView` + contributing a
  `{ id, component }` entry to the first-party `resultViews` slot — no caller changes. A CONSUMER
  deployment ships its own window by contributing to the SAME slot via `registerAppModule` and
  naming a namespaced `resultView` id (`<ns>:<name>`) on its agent kind. Custom agent kinds
  themselves flow through the modular `agentKinds` slot (consumer, code) + a per-workspace
  `RemoteModuleManifest` (backend, `useAgentsStore().hydrateCustomKinds`); the built-in
  `AGENT_BY_KIND` const is frozen (never mutated), and `agentKindMeta` resolves custom kinds
  through a slot-sourced reactive projection.
  `requirements-review` is the first consumer (the review window).
- **Inspector panel seam (frontend):** the block inspector's body is a **subject-keyed panel
  group** (slice 4 of the modular-vue adoption), not a `v-if` monolith. Each body sub-panel is a
  `PanelEntry<Block>` (`{ id, component, when(block), order }`) contributed to the `inspectorPanels`
  slot (`app/modular/panels/inspector.{logic.,}ts`, the group handle is `definePanelGroup<Block>`);
  `InspectorPanel.vue` renders them via `<PanelsOutlet :group="inspectorPanels" :subject="block">`,
  which shows every panel whose `when(block)` matches, ordered, with the selected block injected as
  the subject (each panel's wrapper reads it via `usePanelSubject`). Add a BUILT-IN inspector panel
  by adding a spec (id/order/`when`) + its component; a CONSUMER contributes its own inspector panels
  (e.g. for a custom block type) to the SAME slot via `registerAppModule` — no `InspectorPanel.vue`
  edits. The shell (identity/title/description, run banners, actions row, the frame "view
  requirements" button) is NOT part of the group.
- **Frontend module registry seam (`registerAppModule`, `@cat-factory/app`):** the frontend
  analogue of the backend registries (`registerAgentKind`/`registerGate`). The layer owns a
  [modular-vue](https://github.com/kibertoad/modular-react) registry (`app/modular/registry.ts`,
  resolved by `app/plugins/modular.client.ts`) into which first-party feature modules AND a
  consumer deployment's own modules register through one seam, so a deployment extends the layer
  without forking. A consumer calls the auto-imported `registerAppModule(...)` from its own
  plugin; the layer's install plugin is `enforce: 'post'` so consumer registration runs first.
  Adoption is a phased strangler migration tracked in
  [`docs/initiatives/modular-vue-adoption.md`](./docs/initiatives/modular-vue-adoption.md) (slice
  0 = the registry plumbing, behaviour-neutral; later slices convert navigation, result views,
  wizards, and inspector panels into registered modules).
- **Final answer must land in the reply, not the reasoning channel.** Any agent whose
  deliverable IS its final reply (a document, report, or JSON object the platform reads
  or parses — spec-writer, blueprinter, merger, on-call, task-estimator, the tester
  report, the reviewers/companions, the requirements reviewer + rework, the design /
  review / test phases) MUST append the shared `FINAL_ANSWER_IN_REPLY` fragment
  (`@cat-factory/agents`, `prompts/shared.ts`). Some reasoning models (seen on
  `@cf/moonshotai/kimi-k2.7-code`) emit the whole answer into their private
  reasoning/thinking channel and return an empty visible reply; the harness reads only
  the visible content, so that empty reply fails the run via `unusableFinalAnswerCause`
  (executor-harness `pi-workspace.ts`) even though the model "answered". The fragment
  names the channel. It is applied centrally for `systemPromptFor` kinds (via the track
  prompts / `roleSystemPrompt`) and inline on the four container constants in
  `ContainerAgentExecutor.ts`. Do NOT append it to side-effect agents whose product is a
  pushed commit (coder/build, ci-fixer, conflict-resolver, mocker, playwright,
  business-documenter): they legitimately end with no final text. Editing a versioned
  prompt (`agents/kinds/versions.ts`) means bumping its number.
- The Worker's integration tests use the real `workerd` + real local D1
  (`@cloudflare/vitest-pool-workers`); the Node tests use real Postgres
  (`DATABASE_URL`, a Postgres 18 service in CI); only the LLM is faked in both. Run
  the full backend suite with `pnpm test:run` from the repo root (builds, then runs
  every package's `test:run`); CI provides the Postgres service for the Node suite.
- **Always run `typecheck`/`test:run`/`build` through Turbo from the repo root**
  (`pnpm typecheck`, `pnpm test:run`, etc. — each is `turbo run <task>`), NOT a package's
  raw script from inside its directory. Turbo's `^build` edge (`turbo.json`) — "build every
  workspace dependency first" — only fires when the task runs THROUGH Turbo. Running a
  package-local script directly (e.g. `cd frontend/app && pnpm run typecheck`, which is just
  `nuxt typecheck`) bypasses the task graph, so an unbuilt workspace dependency surfaces as
  spurious `TS2307 Cannot find module '@cat-factory/contracts'` errors that don't exist in
  CI. To scope to one package, filter instead of `cd`: `pnpm exec turbo run typecheck
--filter=@cat-factory/app` still builds its deps first. (The exception is a task with no
  build deps, e.g. the i18n check, which CI itself runs package-local as `pnpm --filter
@cat-factory/app run i18n:check`.)
