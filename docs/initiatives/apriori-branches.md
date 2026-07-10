# Initiative: apriori branches (pre-existing branches as run input)

**Status:** planned (design settled, no slice landed yet) · **Owner:** core · **Started:** 2026-07-10

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

Every agent run today starts from the repo **default branch** (`RepoTarget.baseBranch =
repo.defaultBranch ?? 'main'`, `backend/packages/server/src/agents/resolveRepoTarget.ts`)
and works in the deterministic per-block branch **`cat-factory/<blockId>`**. There is no
way to hand a run pre-existing branches as input — yet that is a common real-world shape:
a human (or an earlier tool) has already pushed a spike, a prototype, or a half-finished
feature branch, and the task's agents should either learn from it or continue it.

This initiative adds **apriori branches**: a task (a `Block`) can name existing branches
of its **primary target repo**, each in one of two modes with deliberately different
semantics:

- **`reference`** — provided purely as a reference point (a spike / prototype / prior-art
  branch). Agents can read it — inspect its log, diff it against their branch, open files
  from it — but NEVER commit to or push it.
- **`working`** — the branch agents are supposed to **keep building inside**: the run
  starts from and continues committing into this branch instead of minting
  `cat-factory/<blockId>` off the default branch. The PR opens from it, the CI gate polls
  it, the merger merges it.

The two modes are the whole point of the feature — a reference branch is context, a
working branch is the starting point — and the design keeps them mechanically disjoint
(a prompt-visible read-only ref vs the run's actual work branch).

## Target pattern

### Data model (slice 1)

One new optional `Block` field, persisted as a JSON text column mirroring
`referenceRepos` exactly (shared `blockFields` mapper entry → both stores pick it up):

```ts
// backend/packages/contracts/src/entities.ts (beside referenceRepoSchema)
export const aprioriBranchSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200) /* + git-ref-safety pipe */),
  mode: v.picklist(['reference', 'working']),
})
// blockSchema: aprioriBranches: v.optional(v.array(aprioriBranchSchema))
```

Helpers `aprioriWorkingBranch(x)` / `aprioriReferenceBranches(x)` exported next to the
schema so call sites never re-implement the `find`. Write-boundary rules (in
`BoardService.update`, beside the `referenceRepos` drop guard): dropped on non-task
blocks; at most ONE `working` entry; no duplicate names; no name in both modes; no
`working` entry on a task with non-empty effective `involvedServiceIds` (v1); the
`working` entry is frozen once `block.pullRequest` exists (the PR head is already
pinned — reference entries stay editable).

### Working mode = the existing resume path (zero harness change, slice 2)

The harness already resumes any remote branch named as `spec.newBranch`
(`executor-harness/src/coding-agent.ts` — `remoteBranchExists` → `cloneExistingBranch` +
best-effort `refreshFromBaseIfClean(base)`), across all three prep arms (persistent
checkout / resume clone / fresh clone). So the whole mode is a backend-side branch-name
swap:

1. `ContainerAgentExecutor.buildJobBody`:
   `workBranch = aprioriWorkingBranch(context) ?? cat-factory/${blockId}`. Everything
   downstream is free — `jobBody.ts` builders all read `parts.workBranch`
   (`newBranch`/`pushBranch`/explore fallback/`pr-or-work`), the PR opens
   head=apriori-branch base=`repo.baseBranch`, `applyResult` records
   `pullRequest.branch`, and the CI gate/merger operate on the PR head unchanged.
2. The branch MUST already exist: probe via `ensureWorkBranch(..., { create: false })`;
   a missing branch **fails the dispatch loudly**, naming the branch — never silently
   created, never fallen back from. Also reject `working === repo.baseBranch`.
3. Mirror the swap in the checkout-free RepoFiles ops (`RunDispatcher`):
   `resolveRepoOpBranch`, `ensureWorkBranch` (probe-only for an apriori branch — throw on
   miss, never create), AND the separate spec-writer arm `builtInRepoOpBranch`.
4. `GitHubPullRequestMerger`: only delete the merged PR head when it
   `startsWith('cat-factory/')` — never tear down a user-provided branch.

### Reference mode = fetch into the primary checkout (small harness change, slice 3)

Reference branches are NOT sibling repo legs (see the gotcha below). Instead the harness
gains one optional job field `referenceBranches?: string[]`; after checkout it runs
`git fetch --no-tags origin +refs/heads/<b>:refs/remotes/origin/<b>` per branch under
`authEnv` (the clone is shallow single-branch and the agent has no git network
credentials, so the harness is the only place that can fetch). Best-effort per branch:
warn-and-continue on a fetch failure. The backend renders a prompt section: the branches
are readable as `origin/<b>` (`git log origin/<b>`, two-dot `git diff origin/<b>`,
`git show origin/<b>:<path>`, or `git worktree add .cat-reference/<slug> origin/<b>`) and
are never to be committed to or pushed.

Consumer kinds: `coder`, `spec-writer`, `doc-writer`, and the read-only design/analysis
kinds — NOT the PR-cloning fix/assess kinds (ci-fixer / conflict-resolver / tester /
merger already carry the work in the PR they clone). At dispatch, probe each reference
branch and drop missing ones with a logged warning (contrast: a missing _working_ branch
fails loudly — it is the starting point, not garnish).

### UI (slice 4)

`TaskAprioriBranches.vue` (pattern: `DocReferenceRepos.vue`) in `TaskRunSettings.vue`,
saving via `board.updateBlock(id, { aprioriBranches })`. Branch options come from the
existing branches projection endpoint (`useGitHubStore().loadBranches(repoGithubId)`; the
target repo is always linked, so the projection covers it). Per-entry mode toggle, a
distinct badge for the single working entry, the working picker disabled with a hint once
`block.pullRequest` exists, and a warning when a `protected` branch is picked as working.

## Per-slice checklist

| #   | Slice                                                                                                                                                                                                   | Key files                                                                                                                                                                                                         | Status      | PR   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---- |
| 1   | Tracker doc + contracts (`aprioriBranchSchema`, helpers, `updateBlockSchema`) + persistence (mapper entry, D1 migration, Drizzle column) + `BoardService` write-boundary rules + conformance round-trip | `contracts/src/entities.ts`, `contracts/src/requests.ts`, `server/src/persistence/mappers.ts`, `runtimes/*/…`, `orchestration/…/BoardService.ts`, `conformance/src/suite.ts`                                      | ✅ done     | #997 |
| 2   | Working mode: context threading + `workBranch` override + probe-only ensure (executor + `RunDispatcher` ×3 sites) + merger deletion guard + tests                                                       | `kernel/src/ports/agent-executor.ts`, `orchestration/…/AgentContextBuilder.ts`, `server/src/agents/ContainerAgentExecutor.ts`, `orchestration/…/RunDispatcher.ts`, `server/src/github/GitHubPullRequestMerger.ts` | ⬜ todo     |      |
| 3   | Reference mode: harness `referenceBranches` fetch (⇒ image bump) + `jobBody` prompt section + per-kind gating + dispatch probe                                                                          | `executor-harness/src/{job,git,coding-agent,agent}.ts`, `server/src/agents/{jobBody,ContainerAgentExecutor}.ts`                                                                                                   | ⬜ todo     |      |
| 4   | UI + i18n: `TaskAprioriBranches.vue` in `TaskRunSettings.vue`, branch picker off the projection, mode toggle/badges, all locales                                                                        | `frontend/app/app/components/panels/inspector/…`, `frontend/app/i18n/locales/*`                                                                                                                                   | ⬜ todo     |      |
| —   | Deferred: working mode + multi-repo (`involvedServiceIds`) — needs `parts.workBranch` split into primary/peer values                                                                                    |                                                                                                                                                                                                                   | ⬜ deferred |      |
| —   | Deferred: cross-repo reference branches (optional user-picked `branch` on `referenceRepoSchema`)                                                                                                        |                                                                                                                                                                                                                   | ⬜ deferred |      |

## Decisions log

1. **One JSON field, not two scalars.** `aprioriBranches: Array<{ name, mode }>` over a
   separate `workBranchName` + reference list: one list in the UI, one write-boundary
   validation site, and it extends cleanly (a future per-entry `repo` for cross-repo
   references). The single-working-entry invariant is enforced at the write boundary.
2. **Reference branches ride the primary checkout, not `referenceRepos` legs** — see the
   sibling-dir gotcha below.
3. **A merged apriori working branch is never deleted** — only `cat-factory/*` branches
   are torn down post-merge. A user's branch is theirs.
4. **Protected branch as working branch: UI warning only.** A rejected push is a normal
   harness failure; no dispatch-time hard block.
5. **Missing branch handling is mode-asymmetric by design**: missing working branch →
   loud dispatch failure; missing reference branch → drop with a logged warning.
6. **Working entry frozen once a PR exists.** The recorded `pullRequest.branch` already
   pins the run's branch everywhere; allowing an edit after that would silently diverge.
7. **v1 excludes multi-repo working mode.** Peer legs mint `newBranch: workBranch` in
   EVERY involved repo — minting a user's branch name across peer repos is wrong, so
   working mode is rejected on tasks with `involvedServiceIds` until `parts.workBranch`
   is split into primary/peer values.

## Conventions & gotchas (carry between iterations)

- **The work-branch name is hardcoded in THREE places that must swap together**:
  `ContainerAgentExecutor.buildJobBody`, `RunDispatcher.resolveRepoOpBranch`, and the
  separate spec-writer arm `RunDispatcher.builtInRepoOpBranch`. Miss the last one and the
  spec-writer explores the apriori branch but commits its spec to a phantom
  `cat-factory/<blockId>`.
- **Same-repo sibling legs are structurally impossible** — do not "reuse the
  referenceRepos machinery" for same-repo reference branches. The harness sibling dir is
  deterministic `owner__name` with NO collision handling (dedup happens upstream by
  owner/name, and the name must stay byte-identical to the backend's
  `siblingCheckoutDir`), so a same-repo leg collides with the primary checkout. Forcing
  multi-repo mode also drops checkpoint pushes, persistent checkouts, and follow-up
  streaming on plain coding tasks, and the explore surface has no `referenceRepos` field
  at all. Fetching `origin/<b>` refs into the primary checkout avoids all of it.
- **The harness resume-safety invariant shifts for apriori branches.** For platform
  branches, resume safety relies on the merger DELETING the merged `cat-factory/*` branch
  (so a re-run finds no branch and starts fresh). An apriori working branch is never
  deleted, so a new task reusing a merged apriori branch RESUMES it — intended: the new
  PR's diff contains only the new commits.
- **Probe, never create, for apriori branches** — in `ensureWorkBranch` (both the REST
  helper call sites and the `RunDispatcher` mirror). Silently creating a mistyped branch
  name off base would look exactly like "the agent ignored my branch".
- **The existing-PR shortcut still holds**: `workBranchReady` is keyed on
  `block.pullRequest?.branch === workBranch`, and with the override the recorded PR head
  IS the apriori branch, so retries take the ready path unchanged.
- **Keep the runtimes symmetric.** The new column lands as D1 migration ⇄ Drizzle
  schema + generated migration in the same slice, with the conformance round-trip; the
  shared `blockFields` mapper entry is what makes both repos agree.
- **Slice 3 is image-affecting.** Any `executor-harness/src` change bumps the harness
  version + the three pins (`pnpm sync:image-tags`), and the released tag only serves new
  containers after `pnpm image:publish` + `pnpm deploy` (a reused tag does NOT roll out).
- **Two-dot diffs in the prompt guidance, not three-dot.** The primary clone is shallow;
  `git diff origin/<b>` (two-dot) works without the merge base, `...` does not.

## Out of scope

- **Cross-repo reference branches** — an optional user-picked `branch` on
  `referenceRepoSchema` (the harness already clones a reference leg at whatever
  `baseBranch` the spec carries, so for OTHER repos this is nearly free). Deferred as an
  adjacent slice; the same-repo case is the primary use case and uses a different
  mechanism (see gotchas).
- **Working mode on multi-repo tasks** (`involvedServiceIds`) — rejected at the write
  boundary in v1; lifting it means splitting `parts.workBranch` into primary/peer values.
- **Branch creation** — apriori branches must pre-exist; the platform never creates one
  from this feature. Minting task branches stays the `cat-factory/<blockId>` convention.
- **Commit/tag/SHA pinning** — only branch heads; a pinned-ref variant would be a new
  mode, not an overload of these two.
