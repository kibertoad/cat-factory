# Initiative: GitLab Issues as a task source

**Status:** in progress (read path + both predicate scans landed; push and writeback are open) ·
**Owner:** core · **Started:** 2026-08-05

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
`vcsBackedGitHubClient` presents it as a `GitHubClient`, and `providerRoutingGitHubClient`
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
   `GitHubClient` port (i.e. `engineVcsClient` / `providerRoutingGitHubClient`) plus
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
  intake path should ride `providerRoutingGitHubClient` from the start rather than inherit that
  constraint, and the two should not be conflated when the VCS gap is closed.

## Prioritized checklist

| #   | Slice                                                                                                   | Status  | PR   |
| --- | ------------------------------------------------------------------------------------------------------- | ------- | ---- |
| 0   | This tracker                                                                                            | 🟩 done | this |
| 1   | Contracts: `gitlab` in `BUILTIN_TASK_SOURCE_KINDS`, OpenAPI minor + `pnpm gen:sdk`                      | 🟩 done | this |
| 2   | `gitlab-issues.logic.ts`: descriptor, multi-segment external id, ref parser, URL resolution             | 🟩 done | this |
| 3   | `GitLabIssuesProvider`: `normalizeConnection` / `parseRef` / `fetchTask` / `search` / `diagnose`        | 🟩 done | this |
| 3b  | **Registry wiring, both facades** (pulled forward out of slice 4: the read path is unreachable unwired) | 🟩 done | this |
| 3c  | **Registry-driven scope + settings surface** (review follow-up: three `github` hard-codings)            | 🟩 done | this |
| 4   | `searchIssues` (recurring `bug-intake`) + the `board.gitlabProject` scope field                         | 🟩 done | this |
| 5   | `listBoards` + `listBugCandidates` (interactive bug hunt), ONE vendor call per scan                     | 🟩 done | this |
| 6   | Webhook adapter: `X-Gitlab-Token` verification on the RAW body, push intake + ticket replies            | ⬜ todo |      |
| 7   | Ticket writeback (`tracker` step + review-question posts) against a GitLab issue                        | ⬜ todo |      |
| 8   | Conformance: the task-source suite parameterised over the new provider on both facades                  | ⬜ todo |      |
| 9   | Docs sweep: root README "What it supports", `vcs-providers.md`, `gitlab-parity.md` cross-links          | ⬜ todo |      |

## Findings (slices 1-3c: the read path)

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

- **Registering a provider is not the same as REACHING it, and three callers were the difference.**
  Review of the read path found the source registered, wired and unit-tested, and still unusable:
  `TaskSourceController.resolveSearchScope` returned `null` for anything but `github`, so every
  GitLab query reached a provider that refuses a null scope by design and 422'd; `taskInRepoScope`
  early-returned `true` for anything but `github`, so a multi-project connection leaked other
  projects' issues into every frame's imported list; and the issue-tracker settings panel held one
  hard-coded card per built-in, so the new setup check had no button and the toggle no switch.
  Each was a source LIST standing where a registry lookup belongs, and each failed silently in a
  different direction. The fix is one declaration read by both backend callers,
  `TaskSourceProvider.repoScope` (present ⇔ repo-backed; it carries the `matches` rule because the
  comparison is the source's own: GitHub folds case, GitLab must not, and a GitLab namespace
  NESTS), plus `TaskSourceState.ridesVcsProvider` on the wire so the panel renders one card per
  registered source and still names the right remedy for an unavailable one. **A slice that adds a
  capability owes the callers that gate on it, not only the provider that implements it**: slice 4
  and slice 6 each have one (`supportsIntake` and the webhook adapter's presence).

## Findings (slices 4-5: the predicate scans)

The recurring `bug-intake` schedule and the interactive bug hunt now both run on GitLab. Read
this before slice 6 (webhooks) or 7 (writeback).

- **The board scope had a leg missing, and the fall-through was silent.** `BugHuntService`'s
  `boardScopeFor` was an `if`-chain ending in the opaque `boardId` leg that only a
  DEPLOYMENT-REGISTERED source's provider reads, so the moment `gitlab` became a built-in (slice
  1. a GitLab hunt handed its project path to a leg no built-in provider looks at. The failure
     mode is the one that chain's own comment warns about one source over: every leg is a plain
     string, so it surfaces as "no matching issues" rather than as mis-routing. It is now a
     `Record<BuiltinTaskSourceKind, …>` (the type is new, exported from contracts beside the
     vocabulary), so a fifth built-in fails to compile until it names its leg, and each source's
     routing is pinned by a test.
- **`titleFragment` needed a new port field, because GitLab's default reading of it is wrong for
  intake.** GitLab's `search` parameter covers the description as well as the title, so a
  schedule configured on a title fragment would have picked up (and started a pipeline on) an
  issue that merely mentions it in its body. `ProjectIssueQuery.textIn: 'title'` is the
  narrowing, and it is its own field rather than a convention on `text` because the picker's
  free-text box legitimately wants the wider reading: the two differ in what they RETURN, not in
  how they are spelled.
- **`issueType` is IGNORED, and the FORM that offers it says so.** GitLab's own issue-type
  vocabulary is the closed set `issue` / `incident` / `test_case` / `task`, which has no member
  meaning "bug" — and `bug` is exactly what `BugIntakeService` defaults the predicate to, so
  sending it would be rejected by the API outright. This follows the precedent Linear already set
  (teams label their bugs, which the `labels` predicate covers).

  Writing that down in a doc was not enough, because the operator meets the gap in the schedule
  modal, which rendered an issue-type box for every source. A dropped predicate is invisible at
  every layer that would otherwise catch it: the query compiles, the vendor answers, and the caller
  gets issues, just a wider set than it asked for — on an unattended schedule whose default is
  `bug`, that is a bugfix pipeline started on a docs chore with nothing to point at. So a provider
  now DECLARES its gaps as `TaskSourceProvider.ignoredIntakePredicates`, `TaskSourceState` carries
  them to the SPA, and both intake forms replace the field with the substitution to use. The
  declaration is kept honest by `intakePredicateSupport.test.ts`, which compiles each source's
  query with and without each predicate and reads the answer off the compiler rather than restating
  it: teaching GitLab to send `issue_type` fails until the declaration drops it, and dropping a
  predicate from a compiler fails until the declaration names it.

- **The GitLab walk pages on GitLab's own next-page answer, not on a short page.** `max_page_size`
  is an INSTANCE setting an administrator can lower below the overscan's `limit + excluded.size`,
  and on such an instance every page is short — so "fewer than I asked for, therefore the last one"
  ends the walk after page 1 and reports a board it never finished as exhausted. The adapter
  already parses `Link: rel="next"` and now carries it out on `ProjectIssuePage.hasMore` rather
  than discarding it. (The GitHub twin keeps the short-page break: GitHub honours `per_page` up to
  100 with no instance knob under it.)
- **The exclusion overscan cannot page on exclusions alone, on either provider.** Both walks size
  the request at `limit + excluded.size`, so a FULL page can hold at most `excluded.size` excluded
  ids and therefore always yields at least `limit` eligible ones. The bounded page walk is reached
  only when the unassigned defence-in-depth filter drops hits the vendor should have filtered, and
  that is what the paging test exercises. Worth knowing before anyone "fixes" the walk against a
  scenario it cannot see.
- **A client that cannot read project issues REFUSES rather than reporting an empty board.**
  `searchProjectIssues` is optional on the port, and both scans throw an `UnavailableError` when
  it is absent, with no `reason`: the status class's generic copy ("this deployment has not
  configured the capability") is the accurate claim, where an outage reason would send an operator
  hunting for a fault in a deployment that simply is not wired for it. An empty list would have
  read as a board with no open bugs, which is the opposite fact.
- **The scope field the modal now renders is `gitlabProject`, not a reuse of `githubRepo`.** A
  GitLab namespace NESTS, so the two are different shapes, and the two providers read different
  legs. `intakeReady` gates on it, so a GitLab intake schedule cannot be saved unscoped.
- **What slice 6 inherits:** `intakeMatch.logic.ts`'s `configuredBoard` now reads the new leg, but
  its `sameBoard` comparison folds case, which is more forgiving than GitLab (whose project paths
  are case-SENSITIVE, the same asymmetry `repoScope` states). It is unreachable until a GitLab
  webhook adapter exists, and the fix belongs with it: thread the comparison off the provider's
  own `repoScope` rules rather than guessing per leg.

When the committed scope completes, convert this tracker into a numbered ADR under
`backend/docs/adr/` and `git rm` this file, per CLAUDE.md.
