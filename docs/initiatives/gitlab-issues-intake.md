# Initiative: GitLab Issues as a task source

**Status:** in progress (the READ path landed: import, search, setup check) · **Owner:** core · **Started:** 2026-08-05

> Durable source of truth for a multi-PR initiative. Read it FIRST before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

GitLab is a first-class **VCS** provider (clone, MR, CI gate, real merge, deep review: see
[`gitlab-parity.md`](../../backend/docs/gitlab-parity.md)) and is **not** a task source. The
three task sources this build ships are `jira`, `github` and `linear`
(`BUILTIN_TASK_SOURCE_KINDS`), so a shop that runs GitLab for both code and issues can have
its agents work in its repositories but cannot:

- **import** a GitLab issue onto a board block as agent context (`TaskImportService`);
- run a recurring **`bug-intake`** schedule against a GitLab project (`BugIntakeService`
  needs `searchIssues`);
- run the interactive **bug hunt** over GitLab issues (`listBoards` + `listBugCandidates`);
- receive **push intake or ticket-comment replies** from GitLab
  ([ADR 0032](../../backend/docs/adr/0032-tracker-webhook-intake.md) needs a webhook adapter);
- **write back** to a GitLab issue (`TicketTrackerProvider`, the tech-debt pipeline's
  `tracker` step, and the writeback path Jira/Linear have).

Such a deployment's only route today is to connect Jira or GitHub Issues beside its GitLab
repositories, which is exactly the second vendor it was avoiding. The gap is also invisible
from the product: nothing refuses, the source simply is not in the list.

**End state:** `gitlab` is a fourth built-in task source at behavioural parity with GitHub
Issues, so a GitLab-only deployment runs the whole intake → run → merge loop on one vendor.

## Why this is NOT already covered by the VCS work

It is close, and that is the trap worth stating before anyone re-derives it.

`FetchGitLabClient` **already implements the issue half of the `VcsClient` port**:
`listIssues`, `getIssue`, `searchIssues`, `listIssueComments`, `createIssue`, `closeIssue`.
`vcsBackedGitHubClient` presents it as a `GitHubClient`, and `ProviderRoutingGitHubClient`
dispatches per installation by stored provider. So the CLIENT layer is done, and no new HTTP
client is needed.

What is missing is everything ABOVE it: a `TaskSourceProvider` is a different port with a
different contract (`normalizeConnection` / `parseRef` / `fetchTask` / `searchIssues` /
`listBoards` / `listBugCandidates` / `diagnose` / `webhook`), and `GitHubIssuesProvider`
hard-codes GitHub in three places that a GitLab deployment cannot use (see the gotchas). The
work is a provider plus its registry wiring, not a client.

## Target pattern

The pilot to copy is `GitHubIssuesProvider`
(`backend/packages/integrations/src/modules/tasks/`), because it is the credential-less,
installation-backed shape GitLab needs: the provider stores no credentials of its own and
reads through the workspace's existing connection (`github_installations`, which already
holds `provider: 'gitlab'` rows carrying the sealed PAT).

1. **Contracts**: add `gitlab` to `BUILTIN_TASK_SOURCE_KINDS`. Additive on a persisted closed
   vocabulary, so no migration and no existing row changes; `taskSourceKindSchema` is on the
   PUBLIC surface (`public-api.ts`), so it is an OpenAPI `info.version` MINOR bump plus
   `pnpm gen:sdk`, never a break.
2. **Pure logic**: `gitlab-issues.logic.ts` beside `github-issues.logic.ts`: the descriptor,
   the external-id grammar, the ref parser, the intake-query builder. Pure, so it is unit
   testable with no live API.
3. **Provider**: `GitLabIssuesProvider` implementing `TaskSourceProvider` over the kernel
   `GitHubClient` port (i.e. `engineVcsClient` / `ProviderRoutingGitHubClient`) plus
   `GitHubInstallationRepository`, exactly as the GitHub one does. Runtime-neutral by
   construction: both facades then wire the SAME class.
4. **Webhook adapter**: a `TaskSourceWebhookAdapter` in `tasks/webhook/adapters.ts`. GitLab
   signs with a plain `X-Gitlab-Token` shared secret rather than an HMAC over the body, so
   the comparison must still be constant-time and the raw body is still read BEFORE any
   parse. Without this the shared receiver 404s the source, which is the honest outcome, so
   this slice may land after the read path.
5. **Ticket writeback**: `gitlab.create.logic.ts` / `gitlab.writeback.logic.ts` beside the
   Jira and Linear pairs, so the `tracker` step and the review-question writebacks reach a
   GitLab issue.
6. **Facade wiring**: `runtimes/cloudflare/src/infrastructure/container.ts` and
   `runtimes/node/src/container-github-deps.ts` push the provider into the same
   `TaskSourceProvider[]` the other three go into, gated on the GitLab connection being
   configured (the same condition `vcsIdentity` uses).
7. **Conformance**: extend the task-source suite so a provider that maps an issue differently
   between facades fails a test. The bug-hunt and intake paths are the ones with real
   divergence risk, because they are the two that push predicates into a vendor query.

## Gotchas found while surveying (before any code)

Each of these was verified against the code, not assumed. They are the reason this is a
tracker rather than a one-PR change.

- **The `owner/repo#number` external-id grammar structurally cannot hold a GitLab path.**
  `github-issues.logic.ts`'s `SEG` (`[A-Za-z0-9._-]+`) excludes `/` and the parser expects
  exactly TWO segments, but GitLab nests subgroups and `FetchGitLabClient` folds them into
  `owner` (`parseProjectWebUrl` splits at the LAST `/`, so `group/sub/project` arrives as
  `owner: 'group/sub'`, `repo: 'project'`). A GitLab issue in a subgroup therefore round-trips
  through the GitHub grammar as garbage rather than as a refusal. The GitLab id grammar must
  admit a multi-segment owner, and the ref parser must round-trip it.
- **The canonical URL is not derivable from the id.** `githubIssueUrl` builds
  `https://github.com/…`; a self-managed GitLab lives at the deployment's own host, and the
  issue path is `/-/issues/N`, not `/issues/N`. Take the URL the API returned and fall back to
  one built from the CONNECTION's base URL, never a constant. This is the "never re-hardcode
  `github.com`" rule in CLAUDE.md, at the intake boundary.
- **`iid` vs `id`.** GitLab issues carry a per-project `iid` (what a human sees and what
  `/projects/:id/issues/:iid` takes) and a global `id`. `FetchGitLabClient.searchIssues`
  already maps `iid`; a new read must not reach for `id` because it is the field named `id`.
- **There is no epic/sub-issue hierarchy to import.** `listSubIssues` is a documented accepted
  gap on the GitLab client (GitLab has no parent→child issue relation on the basic API), so
  `TaskContent.childExternalIds` is empty and every GitLab issue imports FLAT. That is a
  correct outcome, but it must be a stated one: the epic-spawn import silently producing a
  one-task board would otherwise read as a failed import.
- **The bug hunt's ONE-vendor-call rule binds here too.** `listBugCandidates` must gather
  body/labels/priority/age in a single call (GitLab's issues list returns all of them, so this
  is achievable), never a per-candidate detail fetch. See
  [`bug-hunt.md`](../../backend/docs/bug-hunt.md).
- **A repo-backed search MUST refuse a `null` scope.** The reason is not tidiness: an unscoped
  vendor issue search returns whatever the CREDENTIAL can reach, which under a PAT is every
  project the user can see. `GitHubIssuesProvider` throws on `null` and the GitLab one must
  too; the port documents this at `TaskSourceProvider.search`.
- **`diagnose` must classify, never reject.** The four causes a GitLab setup fails on (no
  connection, PAT missing the `read_api` scope, expired PAT, host unreachable) need different
  fixes, and the connect surface exists to name which. A promise that rejects gets the
  provider a static verdict instead.
- **Per-workspace engine routing is still open on the VCS side.** The engine reads gates and
  merges through the single-token `GITLAB_TOKEN` client, so a deployment serving several
  GitLab workspaces is already constrained there (see `gitlab-parity.md`'s accepted gaps). The
  intake path should ride `ProviderRoutingGitHubClient` from the start rather than inherit that
  constraint, and the two should not be conflated when the VCS gap is closed.

## Prioritized checklist

| #   | Slice                                                                                                   | Status  | PR   |
| --- | ------------------------------------------------------------------------------------------------------- | ------- | ---- |
| 0   | This tracker                                                                                            | 🟩 done | this |
| 1   | Contracts: `gitlab` in `BUILTIN_TASK_SOURCE_KINDS`, OpenAPI minor + `pnpm gen:sdk`                      | 🟩 done | this |
| 2   | `gitlab-issues.logic.ts`: descriptor, multi-segment external id, ref parser, URL resolution             | 🟩 done | this |
| 3   | `GitLabIssuesProvider`: `normalizeConnection` / `parseRef` / `fetchTask` / `search` / `diagnose`        | 🟩 done | this |
| 3b  | **Registry wiring, both facades** (pulled forward out of slice 4: the read path is unreachable unwired) | 🟩 done | this |
| 4   | `searchIssues` (recurring `bug-intake`) + the `board.gitlabProject` scope field                         | ⬜ todo |      |
| 5   | `listBoards` + `listBugCandidates` (interactive bug hunt), ONE vendor call per scan                     | ⬜ todo |      |
| 6   | Webhook adapter: `X-Gitlab-Token` verification on the RAW body, push intake + ticket replies            | ⬜ todo |      |
| 7   | Ticket writeback (`tracker` step + review-question posts) against a GitLab issue                        | ⬜ todo |      |
| 8   | Conformance: the task-source suite parameterised over the new provider on both facades                  | ⬜ todo |      |
| 9   | Docs sweep: root README "What it supports", `vcs-providers.md`, `gitlab-parity.md` cross-links          | ⬜ todo |      |

## Findings (slices 1-3b: the read path)

The first code slice landed import, search and the setup check, wired on both facades. Read this
before slice 4 (recurring intake) or 5 (bug hunt): three of the decisions below constrain them.

- **The scope had to become a REQUEST ARGUMENT, which is a new kernel port method.** The survey
  assumed the GitLab provider could ride `GitHubClient.searchIssues` the way the GitHub one does.
  It cannot, and the reason is not ergonomic: `searchIssues` maps to GitLab's global
  `/search?scope=issues`, which accepts NO project qualifier, so folding `repo:owner/name` into
  the query would match it as prose and return every issue the PAT can read across the instance.
  The scope therefore rides a new optional `searchProjectIssues(connection, ref, query)` on
  `VcsClient` + `GitHubClient` (`ProjectIssueQuery`: text, labels, open-only, unassigned-only,
  order, limit, page), implemented over `GET /projects/:id/issues` and forwarded through
  `vcsBackedGitHubClient`. That endpoint evaluates every predicate server-side and returns the
  body/labels/created-at/comment-count/assignee in the SAME response, so **slices 4 and 5 already
  have their one-vendor-call primitive** and should extend `ProjectIssueQuery` rather than
  reach back for the global search.
- **`TaskSourceProvider.fetchTask` now takes `workspaceId`.** GitHub Issues resolves an
  installation from the issue's `owner` because a GitHub App installation is keyed on the account
  owning the repo. A GitLab PAT connection is keyed on the WORKSPACE, and its `accountLogin` is
  the token's user, which has no relation to the group a project sits under, so there is nothing
  to match on. The port change is one line at the single call site (`TaskImportService`), and it
  is what makes every GitLab read scoped to the reading tenant instead of a scan across
  connections for one that happens to be able to read the id.
- **Availability is the connection's PROVIDER, not its existence, and that was a live bug.**
  `github_installations` holds one row per workspace and now carries `provider`, so "connected to
  a VCS" and "connected to GitLab" are different facts. `TaskConnectionService` keyed its
  credentialless-source availability on `provider.kind === 'github' && a row exists`, so a
  workspace connected to GitLab (possible since the connect flow landed) reported **GitHub Issues
  as available**, and an import then resolved an empty App projection: a source that looks
  connected and answers nothing. `ridesVcsConnection` now maps each credentialless source to the
  provider it requires and compares the row's own.
- **A source that cannot back a schedule must not be OFFERED one, and that is now asked of the
  provider.** Adding a fourth built-in exposed a hole the three did not: the recurring-pipeline
  modal offered every `available && enabled` source, and its board-field branch keys on
  `BUILTIN_TASK_SOURCE_KINDS`, so a `gitlab` intake schedule would have rendered no scope field
  and been permanently unsaveable with nothing said. `TaskSourceState.supportsIntake` is now
  derived from `typeof provider.searchIssues === 'function'` and the picker filters on it, with
  its own copy for "sources are connected, none can search on a schedule" (a different remedy
  from "connect a source"). **Slice 4 flips this to true for GitLab by implementing
  `searchIssues`, and owes the modal a `gitlabProject` board field in the same change.**
- **Two accepted gaps, stated rather than silently empty.** GitLab has no parent→child issue
  relation (the same gap `listSubIssues` documents on the client), so `childExternalIds` is
  always `[]` and every GitLab issue imports FLAT; and dependency `links` are omitted entirely
  rather than body-scanned, because the GitHub grammar's `owner/repo#n` cannot express a
  subgroup path and would mint plausible-looking edges to projects that do not exist. GitLab
  models both natively (issue links, `/issues/:iid/links`), so both are a later slice, not a
  parse to bolt onto the body. Note that `TaskLinkService.spawnEpic` still produces an empty
  epic node for a childless issue with no refusal — pre-existing for GitHub, now reachable for
  every GitLab issue, and worth fixing where it belongs (in `spawnEpic`, for all sources).
- **The URL is taken from the API, and WITHHELD rather than guessed when absent.**
  `gitlabIssueUrl` builds from the deployment's web base (derived by stripping `/api/v4` off
  `config.gitlab.apiBase`) and answers `''` without one. A `gitlab.com` constant would be wrong
  for every self-managed instance, and a wrong link fails differently from a missing one: it
  looks like it worked. Same disposition the UI-parity tracker reached for its new-project link.

When the committed scope completes, convert this tracker into a numbered ADR under
`backend/docs/adr/` and `git rm` this file, per CLAUDE.md.
