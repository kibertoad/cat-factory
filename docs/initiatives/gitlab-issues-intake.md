# Initiative: GitLab Issues as a task source

**Status:** not started (tracker only) · **Owner:** unassigned · **Started:** 2026-08-05

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

| #   | Slice                                                                                            | Status  | PR   |
| --- | ------------------------------------------------------------------------------------------------ | ------- | ---- |
| 0   | This tracker                                                                                     | 🟩 done | this |
| 1   | Contracts: `gitlab` in `BUILTIN_TASK_SOURCE_KINDS`, OpenAPI minor + `pnpm gen:sdk`               | ⬜ todo |      |
| 2   | `gitlab-issues.logic.ts`: descriptor, multi-segment external id, ref parser, URL resolution      | ⬜ todo |      |
| 3   | `GitLabIssuesProvider`: `normalizeConnection` / `parseRef` / `fetchTask` / `search` / `diagnose` | ⬜ todo |      |
| 4   | `searchIssues` (recurring `bug-intake`) + both facades' registry wiring                          | ⬜ todo |      |
| 5   | `listBoards` + `listBugCandidates` (interactive bug hunt), ONE vendor call per scan              | ⬜ todo |      |
| 6   | Webhook adapter: `X-Gitlab-Token` verification on the RAW body, push intake + ticket replies     | ⬜ todo |      |
| 7   | Ticket writeback (`tracker` step + review-question posts) against a GitLab issue                 | ⬜ todo |      |
| 8   | Conformance: the task-source suite parameterised over the new provider on both facades           | ⬜ todo |      |
| 9   | Docs sweep: root README "What it supports", `vcs-providers.md`, `gitlab-parity.md` cross-links   | ⬜ todo |      |

When the committed scope completes, convert this tracker into a numbered ADR under
`backend/docs/adr/` and `git rm` this file, per CLAUDE.md.
