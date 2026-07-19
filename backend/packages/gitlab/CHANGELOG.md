# @cat-factory/gitlab

## 0.10.21

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.10.20

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.10.19

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1

## 0.10.18

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.10.17

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2

## 0.10.16

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1

## 0.10.15

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0

## 0.10.14

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1

## 0.10.13

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0

## 0.10.12

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1

## 0.10.11

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.10.10

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0

## 0.10.9

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0

## 0.10.8

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/kernel@0.134.1

## 0.10.7

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0

## 0.10.6

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0

## 0.10.5

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0

## 0.10.4

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0

## 0.10.3

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0

## 0.10.2

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/kernel@0.129.2

## 0.10.1

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.10.0

### Minor Changes

- 995249b: feat(spike): timeboxed research spike tasks — kind, pipeline, findings document, PR + review delivery

  Spike tasks now run as a real timeboxed investigation that produces a findings document
  instead of falling through to a full code-and-PR build:

  - A built-in read-only `spike` agent kind (`container-explore`, structured findings + a prose
    `summary`, opened in the `generic-structured` result view). Its backend post-op renders the
    findings to `docs/research/<slug>.md` (honouring `taskTypeFields.targetPath`) via the
    checkout-free `RepoFiles` port — no harness change.
  - Findings are delivered as a PULL REQUEST by default (`pl_spike`: `requirements-review`(off) →
    `spike` → `conflicts` → `ci` → `human-review` → `merger`): the post-op commits to a work branch
    and opens a PR that the review/merge tail lands, so protected base branches are respected and
    review comments are handled by the existing `human-review` gate + `fixer`. A `pl_spike_direct`
    pipeline keeps the fast, no-PR path (commit straight to base) for unprotected repos. `spike →
pl_spike` is the task-type default, so a spike no longer dispatches a coder.
  - New reusable engine seam: a `RepoOp` may open a pull request and return its ref, which the
    engine records as `block.pullRequest` (the same linkage a container-coding step produces), so a
    deterministic backend-rendered artifact can flow through the normal conflicts/CI/human-review/
    merge tail. `RepoFiles.openPullRequest` (and the underlying `GitHubClient`/`VcsClient` ports)
    now return the PR web `url` (`OpenedPullRequest`), provider-agnostically.
  - A no-PR completion path in the engine: a task run that opened no pull requests now finishes
    `done` (like a frame-level run) instead of stalling at `pr_ready` behind a `pipeline_complete`
    notification whose confirm threw `no_pr_to_merge`. This benefits every PR-less pipeline.
  - Spike creation collects research criteria (research question, success criteria, options to
    compare, target path) alongside the time-box; all are folded into the spike prompt (the
    time-box as a scope-discipline directive). New copy is translated across all locales.

  A repo-less spike (GitHub unwired, or a docs-only spike) settles on `step.custom` — the findings
  render is skipped rather than failing the run; a rejected direct commit is best-effort (the
  findings already live on the step), while a PR-mode open failure is surfaced.

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0

## 0.9.1

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/kernel@0.128.1

## 0.9.0

### Minor Changes

- b414f34: PR deep-review: resolve a parked review by fixing or posting the selected findings.

  The `pr-review` window now offers two terminal resolutions alongside `Finish`, both acting on
  the human's curated finding selection:

  - **Fix** re-dispatches the `pr-reviewer` step as a Fixer (`FIXER_AGENT_KIND`) that clones the
    reviewed PR's head branch, commits fixes addressing the selected findings, and pushes back onto
    it (no new PR).
  - **Post** publishes the selected findings as a single advisory (`COMMENT`) inline PR review — each
    line-anchored finding as an inline comment, the rest folded into the review body.

  Two new optional VCS reads/writes back these resolutions — `getPullRequestHeadRef` and
  `createReview` on the neutral `VcsClient` + `GitHubClient` ports (GitHub-implemented, omitted on
  GitLab), surfaced to the engine through the checkout-free `RepoFiles` seam. All review state stays
  on `step.prReview` (no side table); a cross-runtime conformance assertion covers both resolutions.

  Scoped to a same-repo, non-fork PR (the reviewer's existing limitation); a cross-repo `prUrl` and
  fork PRs remain a tracked follow-up. See `backend/docs/adr/0023-pr-deep-review.md`.

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0

## 0.8.1

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0

## 0.8.0

### Minor Changes

- 55cae97: Add a **Review** task type for deep-reviewing an existing open pull request.

  A `review` task defaults to the new `pl_review` pipeline, which runs a built-in read-only
  `pr-reviewer` agent: it slices the PR's diff into cohesive chunks, reviews each within a
  bounded context (so token usage scales on huge PRs), and returns prioritized findings
  rendered in the generic structured result view. The create-task form gains a Review type
  with a target-PR field and an optional review focus.

  Foundations for the tracked follow-ups (human finding-selection + fix/inline-comment
  resolutions): a new provider-neutral `VcsClient`/`GitHubClient.listChangedFiles` method
  (implemented for GitHub), and a no-PR terminal path so read-only pipelines that open no PR
  finish cleanly as `done` instead of stranding on a confirm-and-merge notification.

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0

## 0.7.71

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0

## 0.7.70

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.7.69

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3

## 0.7.68

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1

## 0.7.67

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.7.66

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.7.65

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0

## 0.7.64

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.7.63

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.7.62

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.7.61

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
  - @cat-factory/contracts@0.127.1
  - @cat-factory/kernel@0.121.5

## 0.7.60

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.7.59

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.7.58

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/kernel@0.121.2

## 0.7.57

### Patch Changes

- 473e849: Classify VCS (GitHub / GitLab) HTTP failures with cause + fix + doc links (error-message coverage
  initiative, items C1/C4/C5/C6). The `fetch`-based clients used to throw the same bare status dump
  for any non-2xx (`GitHub GET <url> → 401: <body>`), so a revoked token, an exhausted rate limit,
  and a missing scope all read identically.

  - Adds a shared kernel helper `describeVcsApiError` (`@cat-factory/kernel` `domain/vcs-errors.ts`)
    that maps `{ provider, status }` to a remedy. It PRESERVES the raw
    `<Provider> <method> <url> → <status>: <body>` first line (detectors still surface it and it stays
    greppable) and APPENDS a cause + remedy sentence: 401 → token revoked/expired (reconnect the App,
    or refresh `GITHUB_PAT` in local mode); 403 + rate-limit headers / 429 → rate limited, wait for
    the reset (App has a higher limit than a PAT); 403 → missing permission/scope + where to grant it;
    404 → repo/installation not visible to the token. GitLab gets the same shapes, GitLab-flavoured
    (`api` scope, Developer/Maintainer role). Kernel sits below the server layer so it keeps its own
    `VCS_DOC_URLS` (per the doc-URL convention) linking `backend/docs/github-integration.md` /
    `github-operations.md` / `vcs-providers.md`.
  - **C1/C6** — `FetchGitHubClient` (REST `request()` + PAT `requestWithToken()`) and
    `FetchGitLabClient.request()` / `provisioning.ts` now build their `*ApiError` message through the
    helper. Error identity still rides the structured `status` field, so classification is unchanged.
  - **C5** — `Installation X not found on any configured App` now explains the App was likely
    uninstalled or the workspace points at a stale installation, and to reconnect GitHub.
  - **C4** — `No connected GitHub repository found for workspace 'X'` (`ContainerAgentExecutor`) is now
    a `ConflictError` carrying the existing `github_not_connected` reason (was a plain `Error` → 500),
    with a UI-first remedy pointing at the GitHub connect / repo-linking flow. The SPA already maps
    that reason to a translated title.
  - **C4 (async run path)** — the durable dispatch previously caught EVERY `startJob` throw and framed
    it as a container `dispatch` failure ("The container failed to start."), so a `github_not_connected`
    precondition reached the board mislabeled and lost its `reason`. `classifyDispatchFailure`
    (`job.logic.ts`) now distinguishes a pre-dispatch domain precondition (any `DomainError`) as a
    `preflight` failure that keeps its own actionable message and propagates its `reason`, so
    `AgentFailureCard` titles it with the same translated "GitHub not connected" string the 409 toast
    uses (no new locale keys) and shows the remedy in the detail.

  No behaviour changes beyond error identity (C4's 409 + `preflight` classification on the async path)
  and message text.

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.7.56

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.7.55

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.7.54

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.7.53

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/kernel@0.118.1

## 0.7.52

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0

## 0.7.51

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6

## 0.7.50

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.7.49

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4

## 0.7.48

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.7.47

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1

## 0.7.46

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.7.45

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.7.44

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.7.43

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.7.42

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0

## 0.7.41

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0

## 0.7.40

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/contracts@0.121.2

## 0.7.39

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.7.38

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.7.37

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/kernel@0.111.1

## 0.7.36

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/contracts@0.121.0

## 0.7.35

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.7.34

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0

## 0.7.33

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.7.32

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0

## 0.7.31

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.7.30

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.7.29

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.7.28

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0
  - @cat-factory/contracts@0.118.0

## 0.7.27

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/kernel@0.104.4

## 0.7.26

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/kernel@0.104.3

## 0.7.25

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2

## 0.7.24

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0
  - @cat-factory/kernel@0.104.1

## 0.7.23

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0

## 0.7.22

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0

## 0.7.21

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0

## 0.7.20

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/kernel@0.101.2

## 0.7.19

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1

## 0.7.18

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0

## 0.7.17

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0

## 0.7.16

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/kernel@0.99.1

## 0.7.15

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/contracts@0.108.0

## 0.7.14

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0
  - @cat-factory/kernel@0.98.0

## 0.7.13

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0

## 0.7.12

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0

## 0.7.11

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0

## 0.7.10

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0

## 0.7.9

### Patch Changes

- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0

## 0.7.8

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/kernel@0.92.0

## 0.7.7

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0

## 0.7.6

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0

## 0.7.5

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/kernel@0.89.1

## 0.7.4

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0

## 0.7.3

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.7.2

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.7.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/kernel@0.86.1

## 0.7.0

### Minor Changes

- 49b498a: Bug-triage pipeline, Phase D — issue-intake foundations (ports + persistence).

  The plumbing the upcoming `bug-intake` step (Phase E) drives: a predicate search across the
  three task-source vendors, the per-schedule intake configuration, the "taken by cat-factory"
  pickup writeback, and the replace-link that keeps a recurring block's issue context from
  accumulating across fires. No engine step yet — this phase is ports, vendor implementations,
  and persistence only.

  - **`TaskSourceProvider.searchIssues` + `IssueIntakeQuery`** (kernel port): open issues on one
    vendor board matching every predicate (title fragment / labels / issue type), oldest-first,
    deduped against the already-worked exclusion list. Predicates are pushed into the vendor
    query wherever expressible — Jira compiles ONE JQL (`statusCategory != Done`, `issuetype`,
    `labels`, `summary ~`, `issuekey NOT IN`, `ORDER BY created ASC`; excluded ids validated
    against the key shape so a malformed id can't inject), GitHub compiles search qualifiers
    (`repo:` `is:open` `type:` `label:` `in:title`, the title fragment quoted as a literal phrase
    so it can't inject a qualifier) with the API's `created-asc` sort (a new `order` param on
    `GitHubClient.searchIssues`, honoured by the GitLab-backed client too) and filters the
    exclusion list case-insensitively from a bounded, paged overscan, Linear compiles a GraphQL
    `IssueFilter` (team, state type not completed/canceled, per-label `labels.some`,
    `title.containsIgnoreCase`) asked for oldest-created-first, also paged so a run of
    already-worked issues at the front can't starve the pickup.
  - **`PipelineSchedule.issueIntake`** (contracts + both runtimes, kept symmetric): the
    schedule-scoped intake config (`source`, per-vendor `board` scope, `predicates`, the GitHub
    `inProgressLabel`) as a new `pipeline_schedules.issue_intake` JSON column — D1 migration
    `0038_schedule_issue_intake.sql` ⇄ Drizzle schema + generated migration — parsed/serialized
    by shared `@cat-factory/server` mapper helpers so the column can't drift, accepted on
    schedule create/update (PATCH is tri-state: omitted = unchanged, null = clear), and pinned
    by a cross-runtime conformance round-trip. Requiring it when the pipeline carries a
    `bug-intake` step is Phase E's schedule validation.
  - **`IssueWritebackProvider.onIssuePickedUp`**: comments "Taken by cat-factory" (+ run link)
    on the block's linked issue(s) and marks them in-progress — Jira transitions into the
    `indeterminate` status category (`pickDoneTransition` generalized into
    `pickTransitionByCategory`), Linear transitions to the team's `started` state (the Linear
    state pickers generalized into `pickStateIdByType`), GitHub applies the schedule's
    `inProgressLabel` (default `in-progress`) via a new `GitHubClient.applyIssueLabel` that
    creates the label — with the required colour — when absent.
    Best-effort per issue like the existing hooks, and deliberately NOT gated on the workspace
    writeback settings — claiming the issue is intake semantics. Wired in both facades.
  - **`TaskLinkService.replaceForBlock`** + `TaskRepository.unlinkAllFromBlock`: detach every
    issue linked to the reused block in ONE batched write (D1 ⇄ Drizzle), then link the newly
    picked issue — so linked context never accumulates across recurring fires.

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0

## 0.6.12

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.6.11

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.6.10

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.6.9

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0

## 0.6.8

### Patch Changes

- 6edcce0: Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

  - **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
    (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
    App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
    (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
  - **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
    is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
    internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
    per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
    and cleared when they remove their PAT — no live GitHub call on the snapshot path.
  - **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
    Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
    optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
    `GitHubAvailableRepo.personal` wire fields.

  **Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
  — the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
  linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
  now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
  `projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
  dropped; repos remain reachable through their `Service`.

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0

## 0.6.7

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0

## 0.6.6

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/kernel@0.79.1

## 0.6.5

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0

## 0.6.4

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0

## 0.6.3

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0

## 0.6.2

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0

## 0.6.1

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0

## 0.6.0

### Minor Changes

- b216fdc: Fragment GitHub-source staleness is now a lightweight commit-version check.

  The full fragment bodies were already cached on our side; the "check for changes"
  probe previously re-listed the whole source directory and hashed every blob sha.
  It now reads only the source directory's current head commit sha and compares it to
  the commit the source was last synced to — a single cheap GitHub/GitLab call, no
  directory listing or file reads.

  Breaking (pre-1.0, no migration): `FragmentSource`/`FragmentSyncResult` now expose
  `lastSyncedCommit` instead of `lastSyncedSha`, and `FragmentSourceStatus` is
  `{ changed, lastSyncedCommit, remoteCommit }` (the per-file `changedCount`/`remoteSha`
  are gone — the resync badge is now a plain "changes available" indicator). A new
  `latestCommitSha` port method is added to `GitHubClient` and `VcsClient`. The physical
  `fragment_sources.last_synced_sha` column is unchanged and reused to store the commit
  sha, so no database migration is required; existing rows re-derive their commit on the
  next sync.

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0

## 0.5.0

### Minor Changes

- 7fd6a19: Import-from-repo picker: find and link accessible repos in realtime instead of enumerating the whole installation and filtering in memory. The old path listed every installation repo (capped at a bounded page count) then substring-filtered client-of-the-cap — so on a wide App install a repo beyond that window returned "no matches" for a repo you actually had access to, and every keystroke re-fetched all pages. Two new `GitHubClient` primitives fix it end to end: `searchInstallationRepos` issues one bounded, account-scoped GitHub search per query, and `getRepoById` point-reads the picked repo by id when linking it (so a repo surfaced by search from beyond the enumeration cap links instead of spuriously 409-ing). Blank-query browse-all is unchanged; PAT (local) and GitLab connections filter their bounded token listing. When an installation has no resolvable account to scope the GitHub search to, the App adapter filters its own bounded listing rather than running an unscoped global search (which would surface arbitrary, unlinkable public repos).

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.4.45

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0

## 0.4.44

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0

## 0.4.43

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2

## 0.4.42

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.4.41

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.4.40

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/kernel@0.69.8

## 0.4.39

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.4.38

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/kernel@0.69.6

## 0.4.37

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/kernel@0.69.5

## 0.4.36

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/kernel@0.69.4

## 0.4.35

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/kernel@0.69.3

## 0.4.34

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/contracts@0.80.1

## 0.4.33

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1

## 0.4.32

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0

## 0.4.31

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1

## 0.4.30

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0

## 0.4.29

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

## 0.4.28

### Patch Changes

- 3135ae8: Make GitLab a first-class auth identity on the hosted (Cloudflare Worker + Node) path.

  **Wire hosted PAT sign-in into the Cloudflare Worker.** The Worker now registers the PAT-login
  identity registry (`vcsIdentity`) like the Node facade — GitHub always, GitLab when a GitLab
  connection is configured (`GITLAB_TOKEN` / `config.gitlab.enabled`) — so a user can sign in by
  pasting their own GitHub **or** GitLab PAT at `/auth/pat`. Previously the Worker wired none,
  leaving it OAuth-only; since GitLab has no OAuth browser flow, a GitLab user had no way to sign
  in to a Worker deployment at all, even though its engine already gated CI and merged on GitLab.
  `/auth/config` now advertises `patLogin.providers` accordingly, so the SPA renders the PAT form.

  **Implement `GitLabIdentityResolver.resolveOrgs`.** A hosted deployment admits a pasted PAT only
  when the account's login, an org/group it belongs to, or its email domain is allowlisted. Only
  `GitHubIdentityResolver` implemented `resolveOrgs`, so `isPatIdentityAllowed`'s org branch was
  skipped for GitLab — a GitLab account could be a primary identity via `AUTH_ALLOWED_LOGINS` or
  `AUTH_ALLOWED_EMAIL_DOMAINS`, but never `AUTH_ALLOWED_ORGS`. The resolver now enumerates the
  user's GitLab **group** memberships (`GET /groups?min_access_level=10`, lowercased full paths, so
  only groups the user actually belongs to admit), bringing group-based admission to parity with
  GitHub org admission.

  **Bound and diagnose PAT-login org/group admission.** Both `resolveOrgs` implementations
  (GitHub `/user/orgs`, GitLab `/groups`) now follow `Link: rel="next"` pagination up to a ~1000-entry
  cap (and `logger.warn` on truncation, wired from each facade — Node included), so a user whose only
  allowlisted org/group sat past the first 100 is no longer wrongly denied. When org enumeration fails
  because a token can authenticate `/user` but lacks the broader org/group-read scope
  (`read:org` / `read_api`), the `/auth/pat` 403 now hints at the missing scope instead of a flat
  "not allowed", and a hosted deployment's missing-token prompt tells the user to paste their PAT
  rather than to set an env var they don't control.

  Comment-only touches to `@cat-factory/server`'s `AuthController`, the kernel `VcsIdentityRegistry`
  doc, and the SPA login screen to correct the now-stale "hosted facades are OAuth-only" notes.

## 0.4.27

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/kernel@0.66.1

## 0.4.26

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0

## 0.4.25

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0

## 0.4.24

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0

## 0.4.23

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/kernel@0.63.4

## 0.4.22

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/kernel@0.63.3

## 0.4.21

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2

## 0.4.20

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/kernel@0.63.1

## 0.4.19

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0

## 0.4.18

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/kernel@0.62.4

## 0.4.17

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/kernel@0.62.3

## 0.4.16

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/kernel@0.62.2

## 0.4.15

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/kernel@0.62.1

## 0.4.14

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0

## 0.4.13

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/kernel@0.61.1

## 0.4.12

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0

## 0.4.11

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0

## 0.4.10

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0

## 0.4.9

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0

## 0.4.8

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.4.7

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0

## 0.4.6

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/kernel@0.56.1

## 0.4.5

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0

## 0.4.4

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.4.3

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1
  - @cat-factory/kernel@0.55.3

## 0.4.2

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/kernel@0.55.2

## 0.4.1

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/kernel@0.55.1

## 0.4.0

### Minor Changes

- d5a0637: Close the GitLab-vs-GitHub provider parity gaps so a GitLab deployment behaves like a GitHub
  one across every runtime facade.

  - **Facade parity (the showstopper):** the engine's CI / mergeability / PR-review gate
    providers, the PR merger, the branch updater and the checkout-free `RepoFiles` resolvers are
    now wired from a GitLab-backed client on the **Node and Cloudflare** facades too — previously
    only local mode bridged GitLab into the gates, so a stock GitLab-only Node/CF deployment did
    not gate on real CI or merge for real. Both facades now build the engine VCS client via the
    shared `buildGitLabEngineClient` (GitHub App wins when both are configured).
  - **Review provider:** `FetchGitLabClient` now implements the human-review reads
    (`getPullRequestBaseRef`, `listRequestedReviewers`, `listPullRequestReviews` +
    `getRequiredApprovingReviewCount` from GitLab approvals, `listReviewThreads` /
    `replyToReviewThread` / `resolveReviewThread` over resolvable MR discussions, plus
    `listIssueComments`).
  - **Branch update:** new optional `VcsClient.rebasePullRequest` / `GitHubClient.rebasePullRequest`
    — GitLab has no server-side merge-branch-into-branch endpoint, so the conflicts / human-testing
    gate's "pull latest base" action advances a GitLab MR branch by rebasing it; `GitHubBranchUpdater`
    prefers rebase when the client exposes it and falls back to `mergeBranch` (GitHub) otherwise.
  - **Conformance:** the cross-provider VCS client suite now asserts GitHub and GitLab normalise the
    human-review gate inputs identically and exposes the correct branch-advancing capability per
    provider; a reusable `FakeVcsClient` drives the real gate / merge / branch-update providers
    through the GitLab-backed adapter.
  - **Rebase verdict robustness:** the GitLab MR-rebase poll now sleeps before each status read (so
    a not-yet-started async rebase is never mistaken for a finished one) and decides the outcome by
    whether the source-branch head actually advanced, ignoring the persisted `merge_error` field
    (shared with merge attempts) unless the branch did not move. Covered by poll-transition,
    stale-`merge_error`, conflict and up-to-date tests.
  - **Accurate required-approval count:** `getRequiredApprovingReviewCount` now reads the effective
    per-MR `approvals_required` (it accounts for the rule on the MR's target branch) when the PR
    number is known, falling back to the project default; the port carries the PR number alongside
    the branch (GitHub still reads branch protection and ignores it).
  - **Node facade wiring:** the GitLab-backed engine client feeds only the gate / merge / RepoFiles
    seams; GitHub-issue-specific consumers (the GitHub Issues task source, issue writeback) stay
    gated on a real GitHub client, so a GitLab-only Node deployment no longer offers a
    non-functional "GitHub Issues" task source (parity with the Worker).

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0

## 0.3.9

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0

## 0.3.8

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/kernel@0.53.1

## 0.3.7

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0

## 0.3.6

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1

## 0.3.5

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0

## 0.3.4

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0

## 0.3.3

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0

## 0.3.2

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0

## 0.3.1

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0
  - @cat-factory/kernel@0.47.2

## 0.3.0

### Minor Changes

- 2961b05: Meaningfully widen GitLab support in local mode — a `GITLAB_PAT` deployment now drives the
  real agent workflow, not just sign-in:

  - **`@cat-factory/gitlab`** adds `asGitHubClient(...)`, a `VcsClient`→`GitHubClient` adapter so
    any provider-neutral VCS client (e.g. `FetchGitLabClient`) satisfies the legacy `GitHubClient`
    port the engine's CI gate, merger and repo-read paths still consume.
  - **`@cat-factory/server`** resolves a run's repo origin (clone URL + provider) through an
    injectable `resolveRepoOrigin` seam and stamps the provider onto the dispatched job, instead
    of hardcoding a `github.com` clone URL. The default stays GitHub, so the Worker/Node facades
    are unchanged; a GitLab deployment supplies a GitLab origin so containers clone the right host
    and open merge requests. Without this the clone URL was always github.com, so a GitLab repo
    could never be cloned by an agent container.
  - **`@cat-factory/node-server`** threads `resolveRepoOrigin` through `NodeContainerOptions` to
    the container executor (default GitHub), so a sibling facade can supply a GitLab origin.
  - **`@cat-factory/local-server`** wires a GitLab PAT symmetrically to the GitHub PAT: the agent
    containers' git clone/push token falls back to `GITLAB_PAT`; the CI gate, mergeability, real
    merge and repo-link flows read through a PAT-backed `FetchGitLabClient` (adapted to
    `GitHubClient`); the agent containers clone the configured GitLab host + open merge requests
    (via `resolveRepoOrigin`); and the GitLab host is added to the harness clone/push allow-list
    (`GITHUB_ALLOWED_HOSTS`) so the container doesn't reject the GitLab clone URL. A GitLab-only
    local deployment is now a first-class source-control backend. Set `GITLAB_API_BASE` for a
    self-managed instance. The boot warning and the cross-provider `vcs-conformance` test cover
    both providers.
  - **`@cat-factory/executor-harness`** opens a GitLab **merge request** (not a GitHub PR) when the
    job's `repo.provider` is `gitlab` (set authoritatively by the server, so a self-managed GitLab
    on an arbitrarily-named host is routed correctly), falling back to host inference from the
    clone URL. The REST base + project path are derived from the host, and an already-open MR is
    reused on a resumed run. The GitHub path is unchanged. (The runner image must be republished
    for this to take effect in a deployed worker.)

## 0.2.2

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/kernel@0.47.1

## 0.2.1

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0

## 0.2.0

### Minor Changes

- 56e6ce6: Local mode: sign in with a source-control PAT (GitHub or GitLab) or email/password.

  Local mode previously ran fully anonymous (dev-open, no user), so per-user features —
  personal subscriptions, your own API keys — failed with 401 ("Sign in to manage …") with
  no way to sign in. Local mode now establishes a real identity:

  - A new provider-agnostic `VcsIdentityResolver` port (kernel) turns a raw PAT into a
    neutral identity (the provider's stable numeric user id — the SAME subject GitHub OAuth
    uses, so a PAT login and an OAuth login resolve to one canonical user). GitHub and GitLab
    resolvers ship in `@cat-factory/server` / `@cat-factory/gitlab`; adding an Nth provider is
    one more resolver entry, no endpoint or UI changes.
  - A new `POST /auth/pat` endpoint (served only where resolvers are wired — local mode)
    mints a session for the account a PAT belongs to. The local login screen offers one-click
    "Continue with GitHub/GitLab" when a `GITHUB_PAT`/`GITLAB_PAT` is configured, an inline
    "paste a PAT" form otherwise, and email/password sign-in (enabled by default in local
    mode, with open signup on the developer's own machine).
  - The SPA now requires sign-in in local mode (anonymous use can't store per-user
    credentials); the session is honored even though the API otherwise runs dev-open.
  - `'gitlab'` is now an identity provider. Identities remain collision-safe via the
    `(provider, subject)` key: a GitHub user and a GitLab user with the same numeric id, and
    a password account (keyed on email), are always distinct.

  Also adds a guard on the per-user credential forms (personal subscriptions, your own API
  keys): when there is genuinely no signed-in user (a non-local deployment running with auth
  disabled), the inputs are blocked with a clear notice instead of accepting data that can't
  be saved.

  BREAKING (local mode only): existing anonymously-created local boards have no owner, so
  after upgrading they become inaccessible once sign-in is required — recreate them under
  your signed-in account. (Pre-1.0, no data migration.)

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0

## 0.1.7

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5

## 0.1.6

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/kernel@0.45.4

## 0.1.5

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.1.4

### Patch Changes

- c11a0cc: Republish with the compiled `dist/` payload. A prior `pnpm publish` ran without a build
  step, so the tarball shipped as an empty shell (only `package.json`, no `dist/`) and the
  package could not be imported. A `prepublishOnly` build hook now guarantees the package is
  compiled before it is packed, regardless of how publish is invoked.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2

## 0.1.3

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.1.2

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0

## 0.1.1

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0

## 0.1.0

### Minor Changes

- bbafec9: Add `@cat-factory/gitlab`: the opt-in GitLab VCS provider, the proof-of-concept
  second backend for the provider-neutral VCS abstraction. It implements the
  neutral `VcsClient` (repo/branch/MR/issue/CI reads + writes over the GitLab REST
  v4 API), a `VcsWebhookVerifier` + `VcsWebhookMapper` (constant-time
  `X-Gitlab-Token` check; `Merge Request`/`Issue`/`Push`/`Pipeline` hooks →
  neutral events), and a `VcsProvisioningClient`, and registers itself via
  `registerGitLab()` → `registerVcsProvider('gitlab')`. Depends only on
  `@cat-factory/kernel` + `@cat-factory/contracts`. Also refines the kernel
  `VcsWebhookMapper` port to take the resolved connection as a parameter.

  The provider is now WIRED into all runtime facades (single-token model, mirroring
  local-mode's PAT): a `GITLAB_TOKEN` (+ optional `GITLAB_API_BASE` /
  `GITLAB_CONNECTION_ID` / `GITLAB_WEBHOOK_SECRET`) enables it, the Worker + Node
  facades call `registerGitLab()` at container build (local inherits Node), and a
  new provider-neutral webhook receiver `POST /vcs/:provider/webhooks`
  (`@cat-factory/server`) verifies the signature against the registered
  `VcsWebhookVerifier`, maps the delivery via the registered `VcsWebhookMapper`, and
  hands the neutral event to the optional `VcsWebhookSink` kernel port. Adds a
  `GitLabConfig` to `AppConfig` and `vcsWebhookSink` to the server container.

  Bug fixes to the GitLab adapter: mergeability now prefers `detailed_merge_status`
  and only maps a genuine `conflict` to the `dirty` state the conflicts gate
  escalates on (a non-conflict block — CI pending, unresolved discussions, behind
  target — no longer spuriously spawns a conflict-resolver); `commitFiles` pins the
  commit parent via `start_sha` when `baseSha` is given; `getFileContent` resolves
  the project default branch instead of an unreliable `HEAD`; listing truncation at
  the page cap is now surfaced via an optional logger; the webhook mapper takes an
  injected `Clock` (deterministic timestamps) and reads the issue author.

  NOT yet migrated: the existing execution consumers (`resolveRepoTarget`, the
  CI/mergeability/merger/repo-files providers, the `github_*` projection
  persistence) still key on the GitHub installation id — projecting a neutral
  webhook event into provider-aware persistence is the remaining strangler step.

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
